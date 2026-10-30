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
└── themes/               # themes (*.json)
```

No `pi` manifest is needed: pi discovers resources from the conventional directories.
Add a `"pi"` key to `package.json` only when resources live elsewhere or need glob filtering.

Host-provided packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`, `typebox`)
belong in `peerDependencies` with `"*"`, never in `dependencies`.

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
