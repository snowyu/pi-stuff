# pi-stuff

[![CI](https://github.com/snowyu/pi-stuff/actions/workflows/ci.yml/badge.svg)](https://github.com/snowyu/pi-stuff/actions/workflows/ci.yml)

My [pi](https://pi.dev) customizations, packaged as one [pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md):
extensions (plus room for skills, prompt templates and themes), each with docs and three tiers of
tests that run offline with zero LLM calls.

```sh
pi install ~/my/dev/pi/pi-stuff            # local, edit then /reload
pi install git:github.com/snowyu/pi-stuff          # or from GitHub
pi install git:github.com/snowyu/pi-stuff@v0.1.0  # pinned tag
pi config                                    # toggle individual resources
```

## What is in here

| Path | |
|---|---|
| [`extensions/proxy-guard.ts`](extensions/proxy-guard.ts) | keep web tools working when the configured proxy is down; switch proxy/direct per run — [docs](docs/proxy-guard.md) |
| [`extensions/persona.ts`](extensions/persona.ts) | swap pi's preamble for a persona file; optional `{{tools}}`/`{{rules}}`/`{{docs}}` borrowed from pi — [docs](docs/persona.md) |
| [`personas/`](personas) | the personas the extension above ships with (`default`, `reviewer`, `pirate`); pi ignores this directory, a project's `.pi/personas` overrides it |
| `skills/` `prompts/` `themes/` | empty for now; pi discovers resources from these directories automatically |
| [`docs/extension-conventions.md`](docs/extension-conventions.md) | how an extension in this package is written, configured, documented and reviewed |
| [`docs/testing.md`](docs/testing.md) | the three test tiers, isolation rules, test-runner choice |
| [`templates/`](templates) | starting points: `extension.ts`, `extension.test.ts` |
| [`scripts/patch-pi-test-harness.mjs`](scripts/patch-pi-test-harness.mjs) | keeps the tier-2 harness working on pi 1.x |

## Layout

```
pi-stuff/
├── package.json              # keywords: ["pi-package"]; pi in peerDependencies, never dependencies
├── extensions/               # auto-discovered: every .ts/.js here becomes an extension
│   ├── proxy-guard.ts
│   └── persona.ts
├── personas/                 # data for persona.ts: <name>.md becomes the system prompt
├── docs/                     # one doc per extension + conventions + testing guide
├── templates/                # copy these when adding an extension
├── test/                     # tier 1 + tier 2, plus test/fixtures/ and test/real/ (tier 3)
├── scripts/
├── skills/  prompts/  themes/
└── tsconfig.json             # strict, erasableSyntaxOnly (Node can strip everything)
```

Nothing goes in `extensions/` except extensions: pi loads every file there. Shared code lives in
`lib/`, test helpers in `test/`, starting points in `templates/`.

## Commands

```sh
npm install          # also patches the tier-2 harness for pi 1.x (see docs/testing.md)
npm test             # tier 1 + 2: 104 tests, ~0.7 s, no child processes
npm run test:real    # tier 3: real pi process per scenario (~0.3 s each)
npm run test:all     # both: 112 tests
npm run test:watch
npm run typecheck    # tsc --noEmit against pi's own types
```

## Adding an extension

1. Copy [`templates/extension.ts`](templates/extension.ts) to `extensions/<name>.ts`.
2. Keep the decision logic in an exported **pure** function; handlers only wire pi events to it.
3. Write `docs/<name>.md` and the test files from [`templates/extension.test.ts`](templates/extension.test.ts).
4. `npm test && npm run typecheck`, then walk the checklist in
   [`docs/extension-conventions.md`](docs/extension-conventions.md#7-checklist-before-committing).

## Notes

- Host-provided packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`,
  `typebox`) are `peerDependencies` with `"*"` and `devDependencies` for tests — never
  `dependencies`, where a physical copy could duplicate pi's classes at runtime.
- Runtime state (for example `~/.pi/agent/proxy-guard.json`, `~/.pi/agent/personas/current`) lives
  outside this repo.
- Do not keep a loose copy of an extension in `~/.pi/agent/extensions/` while also loading it through
  this package: it would load twice.
