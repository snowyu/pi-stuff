# Extension conventions

How a new extension is written, placed, configured, documented and tested in this package.
Start from [`templates/extension.ts`](../templates/extension.ts) and
[`templates/extension.test.ts`](../templates/extension.test.ts).

## 1. Placement and naming

```
extensions/<name>.ts                 # single file, the common case
extensions/<name>/index.ts           # multi-file: helpers, sub-tools
docs/<name>.md                       # required: what it does, commands, config, failure mode
test/<name>.unit.test.ts             # required: the pure decision core
test/<name>.session.test.ts          # required: in-process pi session
test/real/<name>.real.test.ts        # when pi-level behaviour matters (CLI, tools, TUI)
```

- One extension per file; kebab-case name; the file name is what `pi config` and `/reload` show.
- A file dropped in `extensions/` is auto-discovered, so **never** put helpers, fixtures, templates or
  scratch files in there: they get loaded as extensions. Shared code lives in `lib/`, test helpers in
  `test/`, starting points in `templates/`.
- Slash commands are namespaced by the extension name: `/proxy-guard`, never `/status`.

## 2. Module shape

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; // type-only, always
import { Type } from "typebox";                                      // tool parameters only

// 1. constants (tool names, limits, defaults)
// 2. pure logic: exported, no pi types, no fs, no network
// 3. thin I/O helpers: config read/write, probes, logging
// 4. export default function (pi: ExtensionAPI) { ...wiring only... }
```

Rules that make an extension testable and safe:

- **Type-only where the types are all you need; never copy pi instead.** `import type` lets a test load
  the file with Node's TypeScript stripping and no pi runtime (~400 ms of import cost, per file). That
  speed is a bonus, not a rule worth breaking: when you need pi at runtime, import its exported helper
  (`getAgentDir()`, `SessionManager`, …). A hand-rolled copy of pi's logic is a bug waiting for the next
  pi release.
- **Pure core.** The interesting decision takes plain data and returns plain data
  (`decideProxyCall({ mode, override, configured, reachable }) → { inject?, note, notify? }`).
  Handlers then only translate events → core call → mutation/notify.
- **No top-level side effects.** No file reads, timers, sockets or `process.env` parsing at module
  load: extensions load before the session is ready and reload often. Resolve config lazily.
- **Own all your timers and listeners.** Unsubscribe/`clearInterval` in `session_shutdown` when you
  register anything at `session_start`.
- **Cache expensive probes** with a short TTL and a cache key that includes the input
  (proxy-guard keys on the proxy URL, 10 s TTL).
- Return an unsubscribe function where pi asks for one, and never assume two extensions share a
  dependency instance.

## 3. Event handling rules

| Situation | Rule |
|---|---|
| `tool_call` handler | **Must never throw**: a handler failure blocks the tool as a fail-safe ([pi docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#error-handling)). Wrap the whole body in `try/catch` and degrade to "do nothing". |
| Change tool arguments | Mutate `event.input` in place. Return values are only for `block`/`reason`. |
| Block a tool | Return `{ block: true, reason }`, and make the reason actionable enough for the model to recover. |
| Long work in a handler | Handlers are awaited in stream order — a slow handler delays the whole stream. Probe with a timeout; keep budgets explicit. |
| User-visible message | `ctx.ui.notify(message, "info"\|"warning"\|"error")`, once per event, and only when the user can act on it. |
| Match tool names, not extensions | `event.toolName` is the seam; that is what lets tests use stand-in tools. |
| Explicit model choice wins | If the model already set a value, leave it alone unless the mode says otherwise. |

## 4. Configuration and state

| Kind | Where | Notes |
|---|---|---|
| Per-user config/state | `<agent dir>/<name>.json` | `<agent dir>` = `PI_CODING_AGENT_DIR`, else `$XDG_CONFIG_HOME/pi`, else `~/.pi/agent`. Resolve it the same way pi itself does, at call time. |
| One-shot overrides | `PI_STUFF_<NAME>_*` env vars | `_<MODE>`, `_DISABLE=1`, `_DEBUG=<file>` |
| Data the extension ships | `<plural>/` next to `extensions/` (for example `personas/`) | pi discovers nothing there, it is yours; find it from `dirname(fileURLToPath(import.meta.url))` and document every search path |
| Anything else | nowhere | no secrets, no caches, no logs inside the repo |

Conventions:

- Missing, empty or corrupt state file ⇒ defaults, never an exception.
- For pi's own directories, call pi's helper (`getAgentDir()`), do not restate its rule. Copy a rule
  only when you are matching somebody else's config resolution — the four lines below exist because
  proxy-guard has to find the directory *pi-web-access* reads, which is not the same question.
- A single string or boolean does not need a JSON file: a plain file beside the data it belongs to is
  fine, as long as the docs say where it lives.
- Write atomically-enough: read-modify-write the whole object, add `updatedAt`, and `JSON.stringify(…, null, 2)`.
- Before rewriting a file you do not own: copy it to `<file>.bak`, keep unrelated keys, refuse to
  rewrite something that is not a JSON object.
- Document every key in `docs/<name>.md`; state files are never committed.

```ts
export const NAME = "proxy-guard";

function agentDir(): string {
	const explicit = process.env.PI_CODING_AGENT_DIR;
	if (explicit) return explicit;
	const xdg = process.env.XDG_CONFIG_HOME;
	return xdg ? join(xdg, "pi") : join(homedir(), ".pi", "agent");
}
```

## 5. Dependencies

- Host-provided packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`,
  `typebox`) go in `peerDependencies` with `"*"`. **Never** in `dependencies`: a physical copy next to
  the extension can bypass pi's module mapping and duplicate classes and registries.
- Third-party runtime libraries go in `dependencies` and must be referenced through `node_modules`
  paths. Ask first whether the extension really needs one.
- Test-only needs (`typescript`, `@types/node`, harnesses) go in `devDependencies`.

## 6. Docs required per extension

`docs/<name>.md` must cover: the problem it solves, how it hooks in (which event, what it changes),
every command and argument, config/state files and keys, env overrides, timing/caching behaviour,
what happens on failure, and how to verify it is active. Link the source and the test files at the top.

## 7. Checklist before committing

```
[ ] default export is the factory; the pi import is `import type`
[ ] decision core is exported, pure, and covered by a table of cases
[ ] every handler is fail-safe (no throw); tool_call body wrapped in try/catch
[ ] no top-level I/O; config resolved lazily from PI_CODING_AGENT_DIR
[ ] state file: defaults on missing/corrupt, updatedAt written, keys documented
[ ] command name is namespaced; usage printed on unknown subcommand
[ ] docs/<name>.md exists and covers commands, config, env, failure mode
[ ] unit + session tests pass:  npm test
[ ] real-process test if pi-level behaviour matters:  npm run test:real
[ ] npm run typecheck is clean
```
