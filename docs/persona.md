# persona

A standing persona for pi's system prompt: pick one with `--persona reviewer` or `/persona reviewer`,
and every later message runs with it — no re-pasting the same paragraph, no restart.

- Source: [`extensions/persona.ts`](../extensions/persona.ts)
- Tests: [`test/persona.unit.test.ts`](../test/persona.unit.test.ts) ·
  [`test/persona.session.test.ts`](../test/persona.session.test.ts) ·
  [`test/real/persona.real.test.ts`](../test/real/persona.real.test.ts)
- Templates shipped with this package: [`personas/`](../personas) (`default`, `reviewer`, `pirate`)

## The problem

pi has one system prompt, and the knobs for changing it are all-or-nothing: `SYSTEM.md` and
`--system-prompt` replace it completely, `AGENTS.md` and the addendum only append to it. So a
"reviewer mode" or "be a terse senior engineer mode" usually ends up as the same paragraph pasted
into every message, or a restart.

`persona` stores the choice and rebuilds the prompt from a file before each run.

## How it works

Before a run starts, pi exposes the prompt it is about to use as structured options
(`before_agent_start` → `systemPromptOptions`). Setting `systemPromptOptions.customPrompt` replaces
pi's preamble only; pi keeps appending its own `<addendum>`, `<project_context>`, `<skills>` and
`<cwd>` sections, and keeps diffing prompt sections in the transcript, so switching is one delta
rather than a rewritten history.

**What that costs, said up front.** pi generates `<tools>`, `<rules>` and `<docs>` only in the branch
where no custom prompt exists. A persona *is* a custom prompt, so with one on, the model sees a tool
list, guideline bullets and pi's doc paths **only if your template asks for them**. A persona file
with no placeholders is a complete replacement — that is what `personas/pirate.md` does on purpose.

The file `personas/<name>.md` is the preamble. It may optionally borrow what pi did have:

| Placeholder | Becomes | Available |
|---|---|---|
| `{{cwd}}` | the session's working directory | always — it is not a borrowed section |
| `{{tools}}` | the body of pi's `<tools>`: the tools it had selected, with snippets | only when pi built that section |
| `{{rules}}` | the body of pi's `<rules>`: guideline bullets derived from those tools | only when pi built that section |
| `{{docs}}` | the body of pi's `<docs>`: paths to pi's README, docs and examples | only when pi built that section |

Borrowing reads pi's rendered output; nothing in this extension re-implements pi's prompt builder.

### Two honest limits on borrowing

1. **There is nothing to borrow when a custom prompt is already in play.** `SYSTEM.md`,
   `--system-prompt`, or any extension earlier in the chain that sets `customPrompt` or returns
   `systemPrompt`: pi then never builds the three sections. This is a common configuration, not an
   edge case.
2. **A borrowed body is the handler-time view.** pi finalizes the tool loadout *after* the handlers
   return — `selectedTools` is replaced with `getActiveToolNames()`, `hiddenTools` is re-read, and
   `prepareLoadout` hooks can still hide declarations. So if something changes the loadout in the same
   chain, a borrowed `<tools>`/`<rules>` body can name a tool the request no longer declares, or miss
   one that got hidden.

Both are pinned by tests, not prose: `test/persona.session.test.ts` ("with a custom pi prompt there is
nothing to borrow…", "a borrowed `<tools>` body is handler-time state…").

### What a placeholder without a value does

It is **removed**, never left literal — template plumbing must not reach the model. If it was the only
content of a same-named tag pair (a `<tools>` wrapper holding nothing but `{{tools}}`), the pair goes
too: an empty `<tools></tools>` claims there are no tools, which is the opposite of true. One warning
per placeholder per process, then silence. Practical consequence: if your setup has a `SYSTEM.md`, a
`{{tools}}` persona degrades to the persona text — one warning says so, then write the tool list into
the persona yourself, or drop the persona.

`persona` never throws into a run: if the file disappears mid-session, one warning is shown and pi's
own prompt is used.

## Which persona is used

First match wins; nothing matched means the extension does not touch the prompt at all.

| # | Source | Scope |
|---|---|---|
| 1 | `--persona <name>` | this process |
| 2 | `PI_PERSONA=<name>` | this process |
| 3 | the session's own `persona` entry | this session, so resume restores it |
| 4 | `<agent dir>/personas/current` | every later process |
| 5 | nothing | pi native prompt: `SYSTEM.md`, `--system-prompt`, the addendum all behave as usual |

`off` is a value, not a name: it records "do not intervene" and hands the native prompt back. It is
matched case-insensitively (`Off` works); persona names themselves are file stems and stay
case-sensitive. A source whose value is not a usable name — blank, or something like `../../etc/x`
from a hand-edited file — is skipped rather than trusted.

## Where the files live

First directory that contains `<name>.md` wins, so a project can override the package's persona and a
team can share one without touching anyone's home directory.

| # | Directory |
|---|---|
| 1 | every entry of `PI_PERSONAS_PATH`, colon separated |
| 2 | `<project>/.pi/personas` |
| 3 | `<agent dir>/personas` |
| 4 | `personas/` inside this package (next to `extensions/`) |

`<agent dir>` is whatever pi's own `getAgentDir()` returns: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`.
The extension imports that helper rather than duplicating the rule —
[extension conventions](extension-conventions.md#2-module-shape).

`personas/` is not a pi resource directory: pi ignores it, this extension reads it. Nothing needs to be
installed for it.

## Commands and flags

```
pi --persona reviewer        at startup; --persona off disables the extension for this run
/persona                     selector: off, then every available name
/persona <name>              applied from the next message
/persona <name> new          apply, then ask pi for a new session (a clean transcript)
/persona off                 back to pi's native prompt
```

The choice lands immediately: a custom `persona` session entry (for resume) and
`<agent dir>/personas/current` (for the next process). `/persona <name> new` writes both *before*
calling `newSession()`, which is what makes the new session come up with that persona. A switch
applies to the next message, not to a run already in flight.

Argument completion offers `off` plus the names found from the directory pi was started in.

## State and environment

| Path / variable | Role |
|---|---|
| `<agent dir>/personas/current` | last choice: one line of plain text, not JSON — it is one string and it travels with the personas directory |
| `<agent dir>/personas/<name>.md` | the user's own personas |
| `<project>/.pi/personas/<name>.md` | project personas, they win |
| `PI_PERSONA=<name>` | persona for this process; beats the remembered choices |
| `PI_PERSONAS_PATH=a:b` | extra directories, searched first |

Unlike other extensions in this package there is no `<name>.json` state file: see
[extension conventions](extension-conventions.md#4-configuration-and-state) for the usual rule, and
the row above for why this one is a plain file.

## Writing a persona

```md
You are a senior code reviewer working inside pi. Read before you judge; never edit files unless
explicitly asked.

<tools>
{{tools}}
</tools>

<rules>
{{rules}}
- Read the whole file plus its callers before commenting on a diff.
- Report findings as: severity, file:line, why it matters, minimal fix.
</rules>
```

Notes that save time:

- Treat the file as self-sufficient: placeholders are a convenience, and two real situations leave
  nothing to borrow (see the limits above). `{{cwd}}` always works.
- Names are single tokens: `/persona my persona` reads `my.md`. Use `-` or `_` in file names.
- A name may not contain `/` or `\`, and may not start with `.` — the check that keeps `..` out of
  the file lookup.
- Extra tokens after the name are ignored, so `/persona reviewer new extra` still works.
- `{{...}}` is resolved per run, so toggling tools and `/reload` are picked up — with the one-step
  loadout caveat above.

## Failure posture

| Situation | Behaviour |
|---|---|
| persona file missing when the run starts | one warning listing what is available; pi's prompt is used |
| a custom prompt already set (`SYSTEM.md`, `--system-prompt`, another extension) | no sections to borrow: placeholders removed, one warning each |
| a placeholder with no value | removed with its empty tag pair; never literal |
| loadout changed in the same handler chain | borrowed body reflects the pre-change tool set (pi finalizes after handlers) |
| name resolves to something unsafe | that source is skipped, the next one is tried |
| error inside `/persona` | error notify; nothing is chosen, nothing is written |
| session store unreadable at start | treated as "nothing remembered" |
| handler error of any kind | warning, run continues on pi's prompt |
| `personas/current` unreadable or corrupt | treated as "nothing remembered" |
| `/persona <unknown>` | error notify with the available names; nothing changes |

## Verify it is active

- The status bar shows `persona: <name>`; nothing shows when the extension is not intervening.
- `/persona` opens the selector: the names in it are exactly the ones found on disk, and after
  choosing one the notify echoes the choice. A placeholder that could not be filled says so once.
- Model-free end-to-end proof: `npm run test:real` boots a real pi with a scripted provider and
  asserts on `getSystemPrompt(run)` — no LLM call. To check your own session, ask pi a question that
  only the persona would change ("what are you?"), or read the system entry of the session file.

## Tests

| Tier | What it proves |
|---|---|
| unit | name rules, search order, argument parsing, source priority, section borrowing, and that an unfillable placeholder is removed and reported |
| session | the persona reaches a real pi run; `off`; persistence (`personas/current` and the session entry); the two borrowing limits above, as behaviour rather than as a caveat |
| real process | a real pi binary runs with the persona (`--persona`, `PI_PERSONA`, `PI_PERSONAS_PATH`, project override) and `getSystemPrompt(run)` shows it, including the `--system-prompt` degradation |

## Interaction with pi's own prompt controls

| Control | With a persona on |
|---|---|
| `SYSTEM.md` / `--system-prompt` | the persona replaces it (it does not stack); the sections that custom prompt suppressed are also gone, and `{{tools}}`/`{{rules}}`/`{{docs}}` are removed with a warning |
| another extension setting `customPrompt` or returning `systemPrompt` | the persona wins if it runs later in the chain; either way there is nothing to borrow |
| addendum (`<addendum>`), `AGENTS.md`, skills, `<cwd>` | unchanged: pi appends them after the preamble |
| `--no-context-files`, tool toggles, `/reload` | re-read from pi on the next run, with the one-step loadout caveat |
| `/compact`, resume | the `persona` session entry restores the choice |
