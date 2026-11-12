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
| [`extensions/persona/`](extensions/persona) | swap pi's preamble for a persona file; `{{tools}}`/`{{rules}}`/`{{docs}}` are re-assembled from pi's structured facts, not scraped from its text — [docs](docs/persona.md). `index.ts` is the wiring, `core.ts` is a pure core with no pi import |
| [`personas/`](personas) | the personas the extension above ships with (`default`, `reviewer`, `pirate`, `pirate-plus`, plus `_*.md` fragments for `include()`); pi ignores this directory, a project's `.pi/personas` overrides it |
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
│   ├── proxy-guard.ts         # single-file extension
│   └── persona/              # directory extension: index.ts (wiring) + core.ts (pure, no pi import)
│       ├── index.ts
│       └── core.ts
├── personas/                 # data for persona/: <name>.md becomes the system prompt, _*.md fragments
├── docs/                     # one doc per extension + conventions + testing guide
├── templates/                # copy these when adding an extension
├── test/                     # tier 1 + tier 2 (+ a golden fixture), plus test/real/ (tier 3)
├── scripts/
├── skills/  prompts/  themes/
└── tsconfig.json             # strict, erasableSyntaxOnly (Node can strip everything)
```

Nothing goes in `extensions/` except extensions: pi loads every file there, and a directory with an
`index.ts` counts as one extension. That is why `persona/core.ts` and its tests live where they do:
`core.ts` is imported by the extension, and nothing under `extensions/persona/` is auto-loaded except
`index.ts`. Shared code for several extensions goes in `lib/`, test helpers in `test/`, starting
points in `templates/`.

## Commands

```sh
npm install          # also patches the tier-2 harness for pi 1.x (see docs/testing.md)
npm test             # tier 1 + 2: 91 tests, ~1 s, no child processes
npm run test:real    # tier 3: real pi process per scenario (~3 s total)
npm run test:all     # both: 100 tests
npm run test:watch
npm run typecheck    # tsc --noEmit against pi's own types
```

## Adding an extension

1. Copy [`templates/extension.ts`](templates/extension.ts) to `extensions/<name>.ts` — or
   `extensions/<name>/index.ts` if the decision logic is big enough to want a pure, pi-free core.
2. Keep the decision logic in an exported **pure** function (or a `core.ts` that imports no pi types);
   handlers only wire pi events to it.
3. Write `docs/<name>.md` and the test files from [`templates/extension.test.ts`](templates/extension.test.ts).
4. `npm test && npm run typecheck`, then walk the checklist in
   [`docs/extension-conventions.md`](docs/extension-conventions.md#7-checklist-before-committing).

## Notes

- Host-provided packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`,
  `typebox`) are `peerDependencies` with `"*"` and `devDependencies` for tests — never
  `dependencies`, where a physical copy could duplicate pi's classes at runtime.
- Everything else an extension imports must be a **declared** dependency. `persona/core.ts` therefore
  parses its own YAML subset instead of importing `yaml`, which was only reachable through pi's own
  dependency tree — an implicit dependency that breaks the day pi changes it.
- Pi versions are pinned in three places that have to move together: `devDependencies`, the CI
  workflow, and the `piVersion` inside `test/fixtures/pi-sections.json`. The golden test fails if they
  disagree — see [docs/persona.md](docs/persona.md#验证与排错) and [docs/testing.md](docs/testing.md).
- `persona` in one line each: `on_error: last | native` decides what a failed render does (there is no
  `abort` — pi's `before_agent_start` cannot cancel a run); `PI_PERSONA` / `PI_PERSONAS_PATH` are
  process-wide and the env beats a remembered session choice; persona names are plain filenames, so
  `..` `/` `\` `:` and the reserved words `off dirs prompt status golden` are rejected. Details:
  [docs/persona.md](docs/persona.md).
- Runtime state (for example `~/.pi/agent/proxy-guard.json`, `~/.pi/agent/personas/current`,
  `~/.pi/agent/personas/.rendered.txt`) lives outside this repo.
- Do not keep a loose copy of an extension in `~/.pi/agent/extensions/` while also loading it through
  this package: it would load twice.
