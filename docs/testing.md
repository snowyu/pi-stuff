# Testing extensions

Three tiers, all offline and with **no LLM calls**. Measured here: 104 fast tests in ~0.8 s
(`npm test`), plus 8 real-process scenarios in ~1.9 s (`npm run test:real`).

```sh
npm test              # tier 1 + tier 2 (fast, no child processes)      → test/*.test.ts
npm run test:real     # tier 3, spawns a real `pi` per scenario          → test/real/*.test.ts
npm run test:all      # both
npm run test:watch    # tier 1 + 2 on change
npm run typecheck     # tsc --noEmit against pi's own .d.ts
```

## The tiers

| Tier | File | What actually runs | Catches | Cost |
|---|---|---|---|---|
| 1 · unit | `test/<name>.unit.test.ts` | the extension's exported pure functions only | policy bugs, every branch of the decision, argument parsing, edge cases | ~1 ms each |
| 2 · session | `test/<name>.session.test.ts` | a real pi session **in-process** ([`@marcfargas/pi-test-harness`](https://github.com/marcfargas/pi-test-harness)) with a scripted model | pi refusing to load the file, hooks not firing, mutated tool arguments never reaching the tool, commands not registered, UI calls | ~15 ms each |
| 3 · real process | `test/real/<name>.real.test.ts` | the real `pi` binary ([`pi-coding-agent-test`](https://github.com/alexshpunt/pi-coding-agent-test)), real tools, real session, real rendering | CLI flags, package/resource loading, tool input validation, artifacts, TUI/RPC behaviour, anything involving pi's own process | ~400 ms each |

Tier 1 is where the logic is proved. Tier 2 proves pi calls it. Tier 3 is only worth it when pi's own
behaviour is part of the contract — do not duplicate tier 2 there.

## Tier 1 — pure functions

Because the pi import in an extension is `import type`, Node's TypeScript stripping can import the
extension file with no pi runtime at all:

```ts
import { decideProxyCall } from "../extensions/proxy-guard.ts";
```

Drive it with a table so adding a branch forces a new case:

```ts
const cases = [
  { name: "auto + proxy reachable -> untouched",
    input: { mode: "auto", configured: "http://p:1", reachable: true },
    expect: { inject: undefined } },
  { name: "auto + proxy down -> force direct",
    input: { mode: "auto", configured: "http://p:2", reachable: false },
    expect: { inject: "", notify: true } },
];
for (const testCase of cases) {
  test(testCase.name, () => assert.deepEqual(decideProxyCall({ toolName: "fetch_content", ...testCase.input }), testCase.expect));
}
```

TypeScript keeps these honest: `erasableSyntaxOnly` in `tsconfig.json` rejects syntax Node cannot
strip (enums, namespaces, parameter properties), so the same file works under `node --test` and `tsc`.

## Tier 2 — in-process pi session

`@marcfargas/pi-test-harness` runs pi for real and replaces only three boundaries: the model (a
playbook), `tool.execute()` for tools you list in `mockTools`, and `ctx.ui.*`.

```ts
const session = await createTestSession({ extensions: [EXTENSION, FIXTURE] });
await session.run(when("look it up", [calls("fetch_content", { url: "https://example.com" }), says("done")]));
```

The trick that makes argument-injection testable: `test/fixtures/web-tools.ts` registers stub tools
named `web_search` / `fetch_content` / `source_check` that **echo the arguments they received**.
Extension hooks match on tool name, so the fixture exercises the real hook, and the assertion is
literally "what the tool saw at execution time":

```ts
assert.equal(proxySeenByTool(session, "fetch_content"), "");          // forced direct
assert.equal(proxySeenByTool(session, "fetch_content"), undefined);   // untouched
```

The same idea works on the prompt. `test/fixtures/prompt-capture.ts` registers a
`before_agent_start` handler and records `systemPromptOptions.customPrompt`, the rendered
`event.systemPrompt` and `pi.getActiveTools()`: pi gives every handler the same mutable options
object, so a fixture listed **after** the extension under test sees exactly what that extension did.
Its captures live on a `globalThis` key, because pi loads extensions with its own loader — the test's
`import` of the fixture is a different module instance and shares nothing with it.

Two things this fixture exists to make visible, both easy to get wrong:

- the capture is the **handler-time** view. pi replaces `selectedTools` with `getActiveToolNames()`,
  re-reads `hiddenTools` and runs `prepareLoadout` after the handlers return; the session's own
  `systemPrompt` getter (and `getSystemPrompt(run)` in tier 3) is the post-handler view.
  `test/fixtures/tool-loadout.ts` narrows the loadout from a handler to pin that one-step lag.
- the tool loadout lives on the extension API (`pi.getActiveTools()` / `pi.setActiveTools()`), not on
  the `ctx` event handlers get: `setActiveTools` on the command context only.

One trap in tier 2: the harness builds its session with `SessionManager.inMemory()`, which reports
`process.cwd()`, not the `cwd` option. Anything the extension resolves from
`ctx.sessionManager.getCwd()` (project config, project personas) is the repository in tier 2 and the
scenario workspace in tier 3 — so test that part against a real process.

**Known issue — the harness needs a patch on pi 1.x.** Version 0.6.1 was released against pi
0.74/0.75. `scripts/patch-pi-test-harness.mjs` (wired to `postinstall`) fixes four breakages:

1. it imports `getModel` from `@earendil-works/pi-ai`, which pi-ai no longer exports — the module
   will not even link;
2. that model is never called, so it is replaced with a literal model object;
3. it patches auth on `session._modelRegistry`, but pi 1.x checks `session._modelRuntime`;
4. it installs the playbook as `agent.streamFn`, but pi 1.x reads `agent.streamFunction`.

The script fails loudly if the installed harness no longer matches. When it does fail: check whether
upstream shipped pi 1.x support (then delete the script and the `postinstall` hook), or fix the four
anchors against the new dist. Upstream is worth an issue.

Fallback with no third-party dependency at all, same idea and about 20 lines:

```ts
const result = await discoverAndLoadExtensions([join(repoRoot, "extensions")], repoRoot, agentDir, createEventBus());
const runner = new ExtensionRunner(result.extensions, createExtensionRuntime(), repoRoot, SessionManager.create(repoRoot, agentDir), undefined as never);
runner.setUIContext({ notify: (m, t) => notes.push({ message: m, type: t }) } as never, "print");
runner.bindCore({}, {});
await runner.emitToolCall({ type: "tool_call", toolCallId: "c1", toolName: "fetch_content", input });
```

## Tier 3 — real pi process

`pi-coding-agent-test` starts the real `pi` executable in a PTY (`transport: "tui"`) or over JSONL
pipes (`transport: "rpc"`), with its own harness extension registering a **deterministic scripted
provider** (`model: scripted/scripted-model`), so the agent loop is genuine and the "model" is a
script. It passes `--no-extensions`, so ambient extensions and packages are not loaded — the ones you
list are the only ones present.

```ts
const run = await new PiIntegrationTest({
  testName: "proxy-down",
  artifactsDir: testArtifactsDir(import.meta.filename),
  transport: "rpc",
  cwd: workspace,
  extensions: [EXTENSION, FIXTURE],
  tools: ["fetch_content"],
  conversation: [
    assistantMessage([toolCall({ id: "call-1", name: "fetch_content", arguments: { url: "https://example.com" } })], { stopReason: "toolUse" }),
    assistantMessage([text("done")]),
  ],
  environment: { PI_CODING_AGENT_DIR: testAgentDir({ "web-search.json": { proxy: "http://127.0.0.1:1" } }) },
}).run("fetch https://example.com");

assert.match(getToolResultText(run, "call-1"), /"proxy":""/);
```

Every run writes artifacts under `.tmp/test-runs/<testName>/` (`run.jsonl`, trace events, stdout/stderr)
and can be re-read without starting pi: `PiRun.open(run.artifacts.directory)`. Assertion helpers cover
the prompt too — `getSystemPrompt(run)` is the effective prompt of the real run, which is how
`test/real/persona.real.test.ts` proves the persona reached a real process. Use `providerMode:
"user"` plus your real model only when you actually want real model output — that is not a test, it is
an evaluation, and it is not reproducible.

Notes: it needs `pi` on `PATH` and Node ≥ 22.19; `node-pty` builds at install; the Chromium/browser
fixtures are optional (`npx playwright install chromium`) and unused here. It works on pi 1.4.0 with no
patch (checked 2026-10-30), unlike tier 2 — driving the CLI instead of pi's JS API makes it far less
fragile.

## Isolation rules (all tiers)

- Point `PI_CODING_AGENT_DIR` at a fresh `mkdtemp` directory. Extensions resolve their own config the
  same way, so tests never read or write `~/.pi`. In tier 3, write a `settings.json` with
  `"packages": []` in that directory so the developer's own packages stay out.
- No network. "Proxy down" is `http://127.0.0.1:1` (instant refusal); "proxy up" is a local
  `net.createServer()` listener on a random port. Never probe a real host.
- Restore `process.env` in `after()`/`finally` — those variables are process-global, and test files run
  in one process.
- Keep module-level caches in mind: state cached per process can leak between tests in the same file
  (proxy-guard caches probes per URL for 10 s, so every test uses a distinct URL).
- Give every test a unique `testName` in tier 3 so artifacts do not overwrite each other.

## Test runner: `node:test` today, vitest if…

Everything here runs on Node's built-in runner with no test-framework dependency:

```
node --experimental-strip-types --disable-warning=ExperimentalWarning --test 'test/*.test.ts'
```

Both harnesses advertise vitest in their examples, but neither needs it: they are plain async APIs.

| You want | node:test | vitest |
|---|---|---|
| zero extra dependencies, one less thing to update | yes | no (≈40 packages) |
| works on any Node ≥ 22.19 without an install step | yes | needs install |
| watch mode with fast filtering, `it.each`, snapshots, in-source tests | weak | yes |
| coverage, reporters, browser/CT contexts | no | yes |
| copy-pasting the harnesses' README examples unchanged | needs an import swap | yes |

Recommendation for this package: **stay on `node:test`.** The suite is small, deterministic, and
sub-second; the maintenance cost of a framework plus a patched dependency already dominates it.
Switch when you start wanting snapshots or coverage, or when the suite grows past the point where
`--test-name-pattern` is enough.

Migration is mechanical, and this file's examples work either way:

```ts
// vitest.config.ts
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 120_000 } });

// per test file: replace the node:test import, expect instead of assert
import { afterEach, describe, expect, test } from "vitest";
```

`npm run test:real` under vitest needs the longer timeout above: each scenario boots a real pi process.
