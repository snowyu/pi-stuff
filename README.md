# pi-stuff

Personal [pi](https://pi.dev) customizations packaged as a single [pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## Layout

```
pi-stuff/
├── package.json          # keywords: ["pi-package"]
├── extensions/           # .ts / .js extensions (dir + index.ts for multi-file ones)
│   └── proxy-guard.ts
├── skills/               # skill directories (add when needed)
├── prompts/              # slash-command prompt templates (*.md)
├── themes/               # themes (*.json)
├── scripts/              # patch-pi-test-harness.mjs (postinstall)
└── test/
    ├── fixtures/web-tools.ts
    ├── proxy-guard.unit.test.ts
    └── proxy-guard.session.test.ts
```

No `pi` manifest is needed: pi discovers resources from the conventional directories.
Add a `"pi"` key to `package.json` only when resources live elsewhere or need glob filtering.

Host-provided packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`, `typebox`)
belong in `peerDependencies` with `"*"`, never in `dependencies`. They are installed as
`devDependencies` here so tests can import pi; `dependencies` would ship a second copy next to the
extension and can duplicate pi's classes at runtime.

## Tests

```sh
npm install          # also runs scripts/patch-pi-test-harness.mjs
npm test             # node:test, TypeScript stripped: no LLM calls, no network
npm run test:watch
npm run typecheck    # tsc --noEmit against pi's own types
```

Two tiers per extension:

| File | What it runs | Catches |
|---|---|---|
| `test/*.unit.test.ts` | the extension's exported pure functions only | policy/decision bugs: every mode x override x configured x reachable combination |
| `test/*.session.test.ts` | a real pi session via [`@marcfargas/pi-test-harness`](https://github.com/marcfargas/pi-test-harness) | pi refusing to load the file, hooks not firing, mutated tool args never reaching the tool, commands not registered |

How to write them:

1. Keep the decision logic in a pure, exported function that takes plain data and returns plain
   data (`decideProxyCall()`). No `fs`, no network, no pi types. Everything else is wiring.
2. Unit-test that function with a table of cases; the pi side never needs to start.
3. Session-test the wiring with a playbook: the harness replaces the model with scripted actions
   (`when(...)/calls(...)/says(...)`), so the whole agent loop, tool registry, extension hooks and
   UI run for real in ~15 ms and cost nothing. `test/fixtures/web-tools.ts` registers stub tools
   that echo the arguments they received — that is how the tests assert what proxy-guard injected.
4. Point `PI_CODING_AGENT_DIR` at a throwaway temp dir so tests never read or write `~/.pi`.
5. Never depend on the internet: use `127.0.0.1:1` for "proxy is down" and a local TCP listener for
   "proxy is up".

`npm test` needs no test framework: Node's built-in runner strips TypeScript types
(`node --experimental-strip-types --test 'test/**/*.test.ts'`).

### Known issue: pi-test-harness on pi 1.x

`@marcfargas/pi-test-harness@0.6.1` (last published for pi 0.74/0.75) does not start on pi 1.4.0.
`scripts/patch-pi-test-harness.mjs` (run by `postinstall`) fixes the four spots that break:

1. it imports `getModel` from `@earendil-works/pi-ai`, which pi-ai no longer exports (module will not link);
2. that model is never called, so a literal model object is enough;
3. it patches auth on `session._modelRegistry`, but pi 1.x checks `session._modelRuntime`;
4. it installs the playbook as `agent.streamFn`, but pi 1.x reads `agent.streamFunction`.

Delete the script and the `postinstall` hook once upstream supports pi 1.x (worth an upstream issue).
If the patch ever fails to apply, the dependency-free fallback is pi's own
`discoverAndLoadExtensions()` + `new ExtensionRunner(...).emitToolCall(...)` — same idea, more setup.

## Install

Development / same machine (loaded from this path, no copy — edit then `/reload`):

```sh
pi install ~/my/dev/pi/pi-stuff
```

From git (tag/commit is pinned; plain source follows the default branch):

```sh
pi install git:github.com/riceball/pi-stuff
pi install git:github.com/riceball/pi-stuff@v0.1.0
```

Manage:

```sh
pi list                  # configured packages
pi config                # enable/disable individual resources
pi update --extensions   # reconcile package installs
pi remove <source>
```

Do not keep a loose copy of an extension in `~/.pi/agent/extensions/` while also loading it
through this package — it would load twice.

## Extensions

### proxy-guard

Controls which proxy `pi-web-access` uses, and keeps web tools working when the proxy is down.
Patches `web_search` / `fetch_content` / `source_check` tool arguments before execution.

- Command: `/proxy-guard` (also `/proxy-guard url <addr>`)
- Modes: `auto` (probe, fall back to direct) · `direct` · `proxy`
- State file: `~/.pi/agent/proxy-guard.json` (runtime state, not in this repo)
- Env overrides: `PROXY_GUARD_MODE=auto|direct|proxy`, `PROXY_GUARD_DISABLE=1`, `PROXY_GUARD_DEBUG=/path/to/log`

## License

MIT
