# proxy-guard

Controls which proxy `pi-web-access` uses, and keeps web tools working when that proxy is down.

- Source: [`extensions/proxy-guard.ts`](../extensions/proxy-guard.ts)
- Tests: [`test/proxy-guard.unit.test.ts`](../test/proxy-guard.unit.test.ts) ·
  [`test/proxy-guard.session.test.ts`](../test/proxy-guard.session.test.ts) ·
  [`test/real/proxy-guard.real.test.ts`](../test/real/proxy-guard.real.test.ts)

## The problem

`pi-web-access` reads `proxy` from `<agent dir>/web-search.json` and ignores `HTTP_PROXY` /
`HTTPS_PROXY`. Each provider module caches that config per process, so editing the JSON needs
`/reload`. And when the configured proxy is simply not running — for example pi started inside a
network namespace where `localhost:8088` is unreachable — **every** web tool call fails.

## How it works

It patches tool arguments before execution. `tool_call` input is mutable and is not re-validated, so
assigning `input.proxy` is enough, and it takes effect immediately — no reload, no config edit.

Only these tools are touched: `web_search`, `fetch_content`, `source_check`.

The policy is one pure function, [`decideProxyCall()`](../extensions/proxy-guard.ts), which the tests
exercise directly:

| Mode | Configured proxy | Probe says | Result |
|---|---|---|---|
| `auto` | yes | reachable | arguments untouched |
| `auto` | yes | down | `input.proxy = ""` (documented as "force direct") + one notify |
| `auto` | no | — | untouched |
| `auto`/`direct` | any | any | `direct` always forces `""` |
| `auto` with an override | any | ignored | override value injected as given, no fallback |
| `proxy` | yes | ignored | untouched, errors surface as-is |
| any | — | — | a non-empty `proxy` already chosen by the model is never overwritten |

## Commands

```
/proxy-guard                 status
/proxy-guard status          mode, configured proxy, override, effective setting
/proxy-guard auto|direct|proxy
/proxy-guard url <addr>      override: host:port, http://…, socks5://…, or "none" to clear
/proxy-guard reset           back to auto, drop the override
```

`/proxy-guard url` does two things: saves the override (effective at once, by injection) and writes
the same value into `web-search.json` for pi-web-access's own copy, keeping every other key and
leaving a `.bak` backup. That second copy only matters after a `/reload`.

## Files

| Path | Role |
|---|---|
| `<agent dir>/proxy-guard.json` | state: `mode`, `proxyOverride`, `updatedAt` (created on first command) |
| `<agent dir>/web-search.json` | pi-web-access's config; only `proxy` is touched, and only by `/proxy-guard url` |

`<agent dir>` resolves exactly like pi-web-access does: `PI_CODING_AGENT_DIR`, else
`$XDG_CONFIG_HOME/pi`, else `~/.pi/agent`. Tests point `PI_CODING_AGENT_DIR` at a temp directory, so
they never read or write the real one.

## Environment overrides

| Variable | Effect |
|---|---|
| `PROXY_GUARD_MODE=auto\|direct\|proxy` | beats the saved mode (handy for one-off runs) |
| `PROXY_GUARD_DISABLE=1` | extension does nothing at all |
| `PROXY_GUARD_DEBUG=/path/to/log` | appends one line per decision, with timestamp |

```sh
PROXY_GUARD_DEBUG=/tmp/pg.log pi -p "fetch https://example.com"
tail /tmp/pg.log
# 2026-10-30T06:13:40Z fetch_content: mode=auto, proxy http://localhost:8088 reachable, kept
```

## Probe behaviour worth knowing

- TCP connect only, 500 ms timeout; no HTTP request is sent.
- The result is cached for 10 s per proxy URL, so a burst of tool calls pays one round trip.
- If the URL has no port, the probe assumes **8080**. That default only affects the probe, not the
  value handed to the tool — pi-web-access/undici will use their own default port. Pin the port in
  `web-search.json` if that mismatch matters to you.
- The probe runs only on the branch that reads it (`auto`, no override, proxy configured).

## Failure posture

A `tool_call` handler that throws **blocks the tool**. So the handler wraps everything in
`try/catch` and stays silent: unreadable config, bad state file, probe errors — the tool call simply
proceeds with its original arguments. Debug logging can never break a run either.

## Verify it is active

```sh
PROXY_GUARD_DEBUG=/tmp/pg.log pi -p "Call fetch_content on https://example.com, then reply DONE"
cat /tmp/pg.log          # one line per web tool call, plus the reason
/proxy-guard status      # inside a session
```

If the log stays empty while web tools run, the extension is not loaded: `pi list`, then
`pi config` to check it is enabled.
