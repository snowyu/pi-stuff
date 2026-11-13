/**
 * Tier 2: persona inside a real pi session driven by @marcfargas/pi-test-harness — a real extension
 * load, real `session_start`, real `before_agent_start`, and a scripted model instead of an LLM.
 * Zero network, zero model calls.
 *
 * What this tier proves that tier 1 cannot: pi loads `extensions/persona/index.ts`, picks the persona
 * up from `--persona` / `PI_PERSONA` / the session entry / `personas/current`, and the prompt a run
 * really starts with is the rendered template with pi's structured facts substituted in. It also
 * pins the failure posture (`on_error: last` reusing the previous render, `native` falling back)
 * which only exists once real handlers run.
 *
 * The project directory (`<cwd>/.pi/personas`) is not covered here: the harness builds its session
 * with `SessionManager.inMemory()`, which reports `process.cwd()` rather than the temp cwd. Test that
 * search order against a real pi process instead (test/real/persona.real.test.ts).
 *
 * Requires scripts/patch-pi-test-harness.mjs (run by `postinstall`) until upstream supports pi 1.x.
 */
import { createTestSession, says, when, type TestSession } from "@marcfargas/pi-test-harness";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";

import { CONTRIB_APPEND, CONTRIB_SECTION, PROBE_TOOL } from "./fixtures/contributor.ts";
import { CAPTURES_KEY, type PromptCapture } from "./fixtures/prompt-capture.ts";

const PERSONA = new URL("../extensions/persona/index.ts", import.meta.url).pathname;
const CAPTURE = new URL("./fixtures/prompt-capture.ts", import.meta.url).pathname;
const LOADOUT = new URL("./fixtures/tool-loadout.ts", import.meta.url).pathname;
const CONTRIB = new URL("./fixtures/contributor.ts", import.meta.url).pathname;

/** Sections-mode persona: pi wraps the default sections, the body is only the preamble. */
const PIRATE = "You are a pirate coding matey. End every reply with \"Arrr!\"\n";
const REVIEWER = "---\ndescription: reviewer\n---\nYou are a senior code reviewer.\n\n{{ rules }}\n";

/* Persona state and search paths are read from PI_CODING_AGENT_DIR / PI_PERSONAS_PATH / PI_PERSONA,
   all process-global: save and restore exactly like the proxy-guard tests do. */
const savedPiDir = process.env.PI_CODING_AGENT_DIR;
const savedPersona = process.env.PI_PERSONA;
const savedPersonasPath = process.env.PI_PERSONAS_PATH;

after(() => {
	process.env.PI_CODING_AGENT_DIR = savedPiDir;
	process.env.PI_PERSONA = savedPersona;
	process.env.PI_PERSONAS_PATH = savedPersonasPath;
});

function captures(): PromptCapture[] {
	return ((globalThis as Record<string, unknown>)[CAPTURES_KEY] as PromptCapture[] | undefined) ?? [];
}

/** Fresh agent dir whose personas/ holds `personas`; also where `personas/current` is written. */
function tempAgentDir(personas: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stuff-persona-"));
	const personaDir = join(dir, "personas");
	mkdirSync(personaDir, { recursive: true });
	for (const [name, body] of Object.entries(personas)) writeFileSync(join(personaDir, `${name}.md`), body);
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

function stateFile(agentDir: string): string {
	return join(agentDir, "personas", "current");
}

/** Verbatim: the system text pi rendered for the last run. */
function promptFile(agentDir: string): string {
	return join(agentDir, "personas", "system-prompt.txt");
}

/** Verbatim: the system text the provider was given. Only written when a payload was captured. */
function sentFile(agentDir: string): string {
	return join(agentDir, "personas", "system-prompt-as-sent.txt");
}

/** Verbatim JSON: the tool definitions the provider was given. Only when a payload was captured. */
function toolsFile(agentDir: string): string {
	return join(agentDir, "personas", "tools-as-sent.json");
}

/** Commentary: provenance, fallbacks, tool summaries. Nothing in it is sent to the model. */
function notesFile(agentDir: string): string {
	return join(agentDir, "personas", "prompt-notes.txt");
}

/** Run the registered slash command the way pi's TUI would. */
async function runCommand(session: TestSession, command: string, args: string): Promise<void> {
	const runner = session.session.extensionRunner as ExtensionRunner;
	const registered = runner.getCommand(command);
	assert.ok(registered, `expected /${command} to be registered`);
	await registered.handler(args, runner.createCommandContext());
}

function notes(session: TestSession): string[] {
	return session.events.uiCallsFor("notify").map((call) => String(call.args?.[0]));
}

function lastNote(session: TestSession): string {
	return notes(session).at(-1) ?? "";
}

function statusLine(session: TestSession): unknown[] | undefined {
	return session.events.uiCallsFor("setStatus").at(-1)?.args;
}

describe("persona in a real pi session", () => {
	beforeEach(() => {
		(globalThis as Record<string, unknown>)[CAPTURES_KEY] = [];
		delete process.env.PI_PERSONA;
		delete process.env.PI_PERSONAS_PATH;
		// Isolate even the tests that choose no persona: without this, the developer's own
		// <agent dir>/personas/current would decide what pi's prompt is.
		tempAgentDir({});
	});

	test("with no persona chosen, the prompt is pi's own and the extension stays silent", async () => {
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await session.run(when("hi", [says("ahoy")]));
			assert.equal(captures().length, 1);
			assert.equal(captures()[0].customPrompt, undefined, "nothing may be set on systemPromptOptions");
			assert.match(captures()[0].prompt, /coding assistant running inside pi/);
			assert.match(captures()[0].prompt, /<tools>/);
			assert.equal(notes(session).length, 0, "an extension that does nothing must stay silent");
		} finally {
			session.dispose();
		}
	});

	test("/persona pirate rewrites the next run's prompt and keeps pi's tool list", async () => {
		tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("ahoy")]));

			assert.match(captures()[0].prompt, /You are a pirate coding matey/);
			assert.match(captures()[0].prompt, /- read: /, "the persona asks for the tool list and gets it");
			assert.match(captures()[0].prompt, /Additional tools may be available\./);
			assert.ok(!captures()[0].prompt.includes("{{"), "no placeholder may reach the model");
			assert.match(lastNote(session), /Persona: pirate/);
			assert.deepEqual(statusLine(session), ["persona", "persona: pirate"]);
		} finally {
			session.dispose();
		}
	});

	test("the persona survives later turns, and its sections are re-rendered every run", async () => {
		tempAgentDir({ reviewer: REVIEWER });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "reviewer");
			await session.run(when("first", [says("one")]), when("second", [says("two")]));

			assert.equal(captures().length, 2);
			for (const capture of captures()) {
				assert.match(capture.customPrompt ?? "", /senior code reviewer/);
				// pi generates no <rules> of its own once customPrompt is set — the extension re-assembles
				// it from toolGuidelines + the live loadout, so pi's own rules still show up.
				assert.match(capture.prompt, /Be concise in your responses/);
			}
		} finally {
			session.dispose();
		}
	});

	test("pi still owns <cwd>; the persona's sections are injected as structured sections", async () => {
		tempAgentDir({ pirate: "You are a pirate.\n" });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("arr")]));

			assert.match(captures()[0].customPrompt ?? "", /You are a pirate/);
			assert.match(captures()[0].prompt, /<cwd>/, "pi appends its own cwd section unconditionally");
			assert.ok(!captures()[0].customPrompt!.includes("<cwd>"), "<cwd> is pi's own, not borrowed");
			assert.ok(captures()[0].prompt.includes(session.cwd), "the <cwd> section carries the session directory");
		} finally {
			session.dispose();
		}
	});

	test("the borrowed tool list follows the live loadout of that run", async () => {
		// The fixture narrows the active tools in an earlier before_agent_start handler; persona renders
		// its tool list from pi.getActiveTools() at handler time, so it follows the narrowing.
		// What still lags is `hiddenTools` (pi recomputes it after the handlers) — see docs, limit 4.
		tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [LOADOUT, PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("arr")]));

			assert.deepEqual(captures()[0].activeTools, ["read"], "the model is told about read only");
			assert.match(captures()[0].prompt, /- read:/);
			assert.ok(!captures()[0].prompt.includes("- bash:"), "a tool the run does not declare is not listed");
		} finally {
			session.dispose();
		}
	});

	test("a persona file that disappears mid-session falls back to pi's prompt", async () => {
		const agentDir = tempAgentDir({ vanishing: "You are the vanishing persona." });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "vanishing");
			rmSync(join(agentDir, "personas", "vanishing.md"));
			await session.run(when("hi", [says("hi")]));

			assert.equal(captures()[0].customPrompt, undefined, "a run must never start half-configured");
			assert.match(captures()[0].prompt, /coding assistant running inside pi/);
			assert.match(lastNote(session), /persona 'vanishing' failed: persona not found/);
			assert.deepEqual(statusLine(session), ["persona", "persona: vanishing (ERROR)"]);
		} finally {
			session.dispose();
		}
	});

	test("on_error: last (default) reuses the same persona's previous render", async () => {
		const agentDir = tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("one", [says("arr")]));
			// Break the template between runs: the second render throws, the first one is reused.
			writeFileSync(join(agentDir, "personas", "pirate.md"), "{{ include('missing-part') }}");
			await session.run(when("two", [says("arr again")]));

			assert.match(captures()[1].prompt, /pirate coding matey/, "the last good render is reused");
			assert.ok(!captures()[1].prompt.includes("coding assistant running inside pi"), "not silently pi native");
			assert.match(lastNote(session), /reusing last good prompt/);
			assert.match(lastNote(session), /include not found: missing-part/, "the error itself is reported");
			assert.deepEqual(statusLine(session), ["persona", "persona: pirate (ERROR)"]);
		} finally {
			session.dispose();
		}
	});

	test("on_error: native falls back to pi's own prompt instead", async () => {
		const agentDir = tempAgentDir({
			strict: "---\non_error: native\n---\nYou are the strict captain.\n",
		});
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "strict");
			await session.run(when("one", [says("aye")]));
			assert.match(captures()[0].customPrompt ?? "", /strict captain/);

			writeFileSync(join(agentDir, "personas", "strict.md"), "---\non_error: native\n---\n{{ include('missing') }}");
			await session.run(when("two", [says("ok")]));

			assert.equal(captures()[1].customPrompt, undefined);
			assert.match(captures()[1].prompt, /coding assistant running inside pi/);
			assert.match(lastNote(session), /using pi native prompt/);
		} finally {
			session.dispose();
		}
	});

	test("a bad front-matter value is reported, not silently treated as the default", async () => {
		tempAgentDir({ typo: "---\non_error: abort\n---\nYou are the typo persona.\n" });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "typo");
			await session.run(when("hi", [says("hi")]));
			assert.match(lastNote(session), /on_error must be last \| native/);
			assert.match(lastNote(session), /abort is impossible/, "and says why abort is not offered");
			assert.equal(captures()[0].customPrompt, undefined);
		} finally {
			session.dispose();
		}
	});

	test("corrupt state in personas/current cannot escape the personas directory", async () => {
		const agentDir = tempAgentDir({ pirate: PIRATE });
		writeFileSync(stateFile(agentDir), "../../etc/passwd\n");
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await session.run(when("hi", [says("hi")]));
			assert.equal(captures()[0].customPrompt, undefined, "the bad name never becomes a prompt");
			assert.match(captures()[0].prompt, /coding assistant running inside pi/);
			assert.match(lastNote(session), /persona not found: \.\.\/\.\.\/etc\/passwd|path traversal in name/);
		} finally {
			session.dispose();
		}
	});

	test("/persona off hands the native prompt back", async () => {
		tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("one", [says("arr")]));
			await runCommand(session, "persona", "off");
			await session.run(when("two", [says("ok")]));

			const [, second] = captures();
			assert.equal(second.customPrompt, undefined);
			assert.match(second.prompt, /coding assistant running inside pi/);
			assert.ok(!second.prompt.includes("pirate coding matey"));
			assert.match(lastNote(session), /persona off/i);
		} finally {
			session.dispose();
		}
	});

	test("an unknown name is refused, and the prompt stays native", async () => {
		tempAgentDir({ pirate: PIRATE, reviewer: REVIEWER });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "nope");
			await session.run(when("hi", [says("hi")]));

			assert.match(lastNote(session), /No such persona: nope/);
			assert.match(lastNote(session), /pirate/, "the error lists what is available");
			assert.equal(captures()[0].customPrompt, undefined);
		} finally {
			session.dispose();
		}
	});

	test("a name that would leave the personas directory is refused", async () => {
		const agentDir = tempAgentDir({ pirate: PIRATE });
		writeFileSync(join(agentDir, "..secret.md"), "escaped");
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "../..secret");
			await session.run(when("hi", [says("hi")]));

			assert.match(lastNote(session), /persona command failed: path traversal in name/);
			assert.equal(captures()[0].customPrompt, undefined);
		} finally {
			session.dispose();
		}
	});

	test("/persona with no argument asks through the UI and offers off plus every persona", async () => {
		tempAgentDir({ pirate: PIRATE, reviewer: REVIEWER });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE], mockUI: { select: "reviewer" } });
		try {
			await runCommand(session, "persona", "");
			await session.run(when("hi", [says("hi")]));

			const select = session.events.uiCallsFor("select")[0];
			assert.ok(select, "expected the selector to open");
			const offered = select.args?.[1] as string[];
			assert.equal(offered[0], "off", "off comes first, then the names in order");
			assert.deepEqual(offered.slice(1), [...offered.slice(1)].sort());
			// Fragments (underscore-prefixed) and hidden files never show up.
			for (const expected of ["pirate", "reviewer", "default"]) assert.ok(offered.includes(expected), `offered ${expected}`);
			assert.ok(!offered.includes("_tools"), "fragments are not personas");
			assert.match(captures()[0].customPrompt ?? "", /senior code reviewer/);
		} finally {
			session.dispose();
		}
	});

	test("the choice is remembered in personas/current and re-applied by a new session", async () => {
		const agentDir = tempAgentDir({ pirate: PIRATE });
		const first = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(first, "persona", "pirate");
			assert.equal(readFileSync(stateFile(agentDir), "utf8").trim(), "pirate");
			const entries = first.session.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: { name?: string } }>;
			const remembered = entries.filter((entry) => entry.type === "custom" && entry.customType === "persona");
			assert.deepEqual(remembered.map((entry) => entry.data?.name), ["pirate"]);
		} finally {
			first.dispose();
		}

		(globalThis as Record<string, unknown>)[CAPTURES_KEY] = [];
		const second = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await second.run(when("hi", [says("arr")]));
			assert.match(captures()[0].customPrompt ?? "", /pirate coding matey/, "the new session read personas/current");
		} finally {
			second.dispose();
		}
	});

	test("PI_PERSONA picks a persona for the whole process, with no command", async () => {
		tempAgentDir({ pirate: PIRATE });
		process.env.PI_PERSONA = "pirate";
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await session.run(when("hi", [says("arr")]));
			assert.match(captures()[0].customPrompt ?? "", /pirate coding matey/);
			assert.deepEqual(statusLine(session), ["persona", "persona: pirate"]);
		} finally {
			session.dispose();
			delete process.env.PI_PERSONA;
		}
	});

	test("PI_PERSONA beats a persona chosen in an earlier session — the documented quirk", async () => {
		tempAgentDir({ pirate: PIRATE, reviewer: REVIEWER });
		const first = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(first, "persona", "reviewer");
		} finally {
			first.dispose();
		}
		process.env.PI_PERSONA = "pirate";
		const second = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await second.run(when("hi", [says("arr")]));
			assert.match(captures()[0].customPrompt ?? "", /pirate coding matey/, "env wins over the remembered choice");
			await runCommand(second, "persona", "status");
			assert.match(lastNote(second), /from PI_PERSONA env/);
		} finally {
			second.dispose();
			delete process.env.PI_PERSONA;
		}
	});

	test("PI_PERSONAS_PATH is searched before the user directory", async () => {
		tempAgentDir({ pirate: "You are the user's pirate." });
		const shared = mkdtempSync(join(tmpdir(), "pi-stuff-personas-"));
		writeFileSync(join(shared, "pirate.md"), "You are the team's pirate.");
		process.env.PI_PERSONAS_PATH = shared;

		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("arr")]));
			assert.match(captures()[0].customPrompt ?? "", /team's pirate/);
			assert.ok(!captures()[0].prompt.includes("user's pirate"));
		} finally {
			session.dispose();
		}
	});

	test("with a custom pi prompt, tools and rules are still re-assembled and docs disappears", async () => {
		// SYSTEM.md / --system-prompt make pi skip <tools>/<rules>/<docs>. The tool list and rules are
		// rebuilt from structured facts, so they survive; docs is extraction-first and stays empty —
		// inventing pi's docs text there would create a section pi itself never had.
		tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({
			extensions: [PERSONA, CAPTURE],
			systemPrompt: "You are pi configured through --system-prompt.",
		});
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("one", [says("arr")]));

			const [first] = captures();
			assert.match(first.customPrompt ?? first.prompt, /pirate coding matey/);
			assert.ok(!first.prompt.includes("--system-prompt"), "the persona replaces the custom prompt, it does not stack on it");
			assert.ok(!first.prompt.includes("{{"), "no placeholder syntax may reach the model");
			assert.match(first.prompt, /- read:/, "the tool list comes from structured facts, not from pi's text");
			assert.ok(!first.prompt.includes("<docs>"), "an empty <docs> would claim pi documented something it did not");
			assert.match(first.prompt, /<cwd>/, "pi still appends its own sections after the preamble");
		} finally {
			session.dispose();
		}
	});

	test("/persona prompt refuses to export before anything has run", async () => {
		tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			// ctx.getSystemPrompt() falls back to pi's own prompt when no run happened yet; exporting that
			// as "the effective prompt" would be a lie.
			await runCommand(session, "persona", "prompt");
			assert.match(lastNote(session), /还没有跑过任何 run/);
		} finally {
			session.dispose();
		}
	});

	test("/persona prompt exports what the last run really used, not pi's own prompt", async () => {
		// pi only keeps `before_agent_start` mutations for the active run (agent-session.ts:
		// "_runSystemPromptOptions ... for the active run", cleared in the run's finally). Commands run
		// while idle, so ctx.getSystemPrompt() re-renders from base options: pi's own prompt. The export
		// has to come from a snapshot taken inside the run.
		const agentDir = tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("ahoy")]));
			await runCommand(session, "persona", "prompt");

			const exported = readFileSync(promptFile(agentDir), "utf8");
			assert.match(exported, /You are a pirate coding matey/);
			assert.ok(!exported.includes("coding assistant running inside pi"), "the persona prompt must be the export");
			assert.match(exported, /<cwd>/, "the export is pi's full render, not just the preamble we set");
			assert.ok(notes(session).some((n) => /Prompt exports written/.test(n)));
		} finally {
			session.dispose();
		}
	});

	test("with no persona chosen, /persona prompt exports pi's own prompt", async () => {
		const agentDir = tempAgentDir({});
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await session.run(when("hi", [says("ahoy")]));
			await runCommand(session, "persona", "prompt");
			assert.match(readFileSync(promptFile(agentDir), "utf8"), /coding assistant running inside pi/);
		} finally {
			session.dispose();
		}
	});

	test("a new session cannot export the previous session's prompt", async () => {
		const agentDir = tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("ahoy")]));
			await runCommand(session, "persona", "prompt");
			assert.match(readFileSync(promptFile(agentDir), "utf8"), /pirate/);
			rmSync(promptFile(agentDir));

			// What `/new` does to the extension: a fresh session_start with no run behind it yet.
			const runner = session.session.extensionRunner as ExtensionRunner;
			await runner.emit({ type: "session_start", reason: "new" });
			await runCommand(session, "persona", "prompt");

			assert.match(lastNote(session), /还没有跑过任何 run/);
			assert.ok(!existsSync(promptFile(agentDir)), "a snapshot from the old session must not be exported");
		} finally {
			session.dispose();
		}
	});

	test("switching persona without a run exports the previous run's prompt, and says so", async () => {
		// The only prompt we can report is the one pi really rendered. Until a run happens, the new
		// persona has no render to report — the notify must be explicit that this is the last run's.
		const agentDir = tempAgentDir({ pirate: PIRATE, reviewer: REVIEWER });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("ahoy")]));
			await runCommand(session, "persona", "reviewer");
			await runCommand(session, "persona", "prompt");

			const exported = readFileSync(promptFile(agentDir), "utf8");
			assert.match(exported, /pirate coding matey/, "the export is what the last run used");
			assert.ok(!exported.includes("senior code reviewer"), "nothing unrendered may be presented as effective");
			assert.match(
				readFileSync(notesFile(agentDir), "utf8"),
				/^snapshot of: the last agent run of this session/m,
				"the notes name the run the export came from",
			);
		} finally {
			session.dispose();
		}
	});

	test("after a run fell back to pi's prompt, that fallback is what gets exported", async () => {
		// The file must match what the model saw, even when what it saw was not the persona.
		const broken = "---\non_error: native\n---\nYou are the strict captain.\n";
		const agentDir = tempAgentDir({ strict: broken });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "strict");
			await session.run(when("one", [says("aye")]));
			writeFileSync(join(agentDir, "personas", "strict.md"), "---\non_error: native\n---\n{{ include('missing') }}");
			await session.run(when("two", [says("ok")]));
			await runCommand(session, "persona", "prompt");

			const exported = readFileSync(promptFile(agentDir), "utf8");
			assert.ok(!exported.includes("strict captain"), "the last run used pi's own prompt");
			assert.match(exported, /coding assistant running inside pi/);
			assert.ok(
				notes(session).some((n) => /回退|fallback/i.test(n)),
				"exporting a fallback prompt has to be flagged",
			);
		} finally {
			session.dispose();
		}
	});

	test("without a captured payload, the tool declarations stay in the notes file", async () => {
		// bare mode sends no `<tools>` section, but front-matter `tools:` still reaches the model as tool
		// declarations on the system message (`{role:"system", content, toolsAdded:[…]}`), so the text
		// alone is not the whole system role — and a summary of it must not pose as a verbatim export.
		const lean = "---\nmode: bare\ntools: [read]\n---\nYou are a lean pirate.\n";
		const agentDir = tempAgentDir({ lean });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "lean");
			await session.run(when("hi", [says("arr")]));
			await runCommand(session, "persona", "prompt");

			const noteText = readFileSync(notesFile(agentDir), "utf8");
			assert.match(noteText, /^persona prompt notes: nothing in this file is sent to the model/);
			assert.match(noteText, /^- read  parameters: path\*: string/m, "the model sees the parameter schema, so it gets reported");
			assert.ok(!/^- bash  parameters/.test(noteText), "front-matter tools: decides what is declared");
			assert.match(noteText, /^registered but not declared: .*\bbash\b/m, "and what got cut is visible too");
			assert.match(noteText, /tools-as-sent\.json: not written/);

			// The verbatim artifacts hold nothing but content.
			assert.equal(readFileSync(promptFile(agentDir), "utf8"), "You are a lean pirate.");
			assert.ok(!existsSync(sentFile(agentDir)), "no payload, no provider-side file");
			assert.ok(!existsSync(toolsFile(agentDir)), "a registry guess is not a verbatim tool definition");
			assert.ok(notes(session).some((n) => /Prompt exports written/.test(n)), "the notify names the files");
		} finally {
			session.dispose();
		}
	});

	test("a captured payload is exported verbatim, content only", async () => {
		const lean = "---\nmode: bare\ntools: [read]\n---\nYou are a lean pirate.\n";
		const agentDir = tempAgentDir({ lean });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "lean");
			await session.run(when("hi", [says("arr")]));
			const runner = session.session.extensionRunner as ExtensionRunner;
			const blocks = [
				{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
				{ type: "text", text: "You are a lean pirate." },
			];
			const tools = [{ name: "read", description: "Read the contents of a file.", input_schema: { type: "object" } }];
			await runner.emitBeforeProviderRequest({ system: blocks, tools });
			await runCommand(session, "persona", "prompt");

			// Byte-exact: the file is the payload's system text and nothing else — no banner, no note.
			assert.equal(
				readFileSync(sentFile(agentDir), "utf8"),
				"You are Claude Code, Anthropic's official CLI for Claude.\n\nYou are a lean pirate.",
			);
			// Byte-exact JSON: the payload's own tool definitions, unsummarized.
			assert.deepEqual(JSON.parse(readFileSync(toolsFile(agentDir), "utf8")), tools);

			// Everything that explains the export lives in the notes file.
			const notes = readFileSync(notesFile(agentDir), "utf8");
			assert.match(notes, /^provider system text: from system blocks/m);
			assert.match(notes, /^tools-as-sent\.json: from the payload tools$/m);
			assert.match(notes, /caveat: captured outside an agent run/, "a payload seen while idle must not pass itself off as the run's");
		} finally {
			session.dispose();
		}
	});

	test("/persona pirate new persists first, then asks pi for a session", async () => {
		tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate new");
			// The choice is persisted before newSession, so the fresh session restores it; and `new` is a
			// flag, not a persona name.
			assert.equal(readFileSync(stateFile(process.env.PI_CODING_AGENT_DIR ?? ""), "utf8").trim(), "pirate");
			assert.ok(!lastNote(session).includes("No such persona: new"), "`new` must not be read as a name");
			await session.run(when("hi", [says("arr")]));
			assert.match(captures()[0].customPrompt ?? "", /pirate coding matey/);
		} finally {
			session.dispose();
		}
	});

	test("argument completion offers off plus the persona names", async () => {
		tempAgentDir({ pirate: PIRATE, reviewer: REVIEWER });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			const runner = session.session.extensionRunner as ExtensionRunner;
			const completions = await runner.getCommand("persona")?.getArgumentCompletions?.("r");
			assert.ok(completions, "expected completions for 'r'");
			assert.deepEqual(completions.map((item) => item.value), ["reviewer"]);
			const everything = await runner.getCommand("persona")?.getArgumentCompletions?.("");
			assert.ok(everything?.some((item) => item.value === "off"), "off must be completable");
			assert.ok(everything?.some((item) => item.value === "golden"), "golden must be completable");
		} finally {
			session.dispose();
		}
	});

	describe("gates: extensions: (whose tools) and context: (what others appended)", () => {
		// 基线：同一个贡献者、同一个扩展顺位，只是人设没写门控——不然"少了东西"证不了是门控干的。
		test("with no gate, another extension's tool, addendum line and section all reach the prompt", async () => {
			tempAgentDir({ plain: "Matey.\n{{ tools }}\n" });
			const session = await createTestSession({ extensions: [CONTRIB, PERSONA, CAPTURE] });
			try {
				await runCommand(session, "persona", "plain");
				await session.run(when("hi", [says("ahoy")]));
				assert.match(captures()[0].prompt, /- probe_tool: probe the fixture/);
				assert.match(captures()[0].prompt, /<contrib_notes>/);
				assert.match(captures()[0].prompt, /contributed by the fixture/);
			} finally {
				session.dispose();
			}
		});

		test("extensions: [\"builtin\"] drops the tool another extension registered", async () => {
			tempAgentDir({ builtinonly: '---\nextensions: ["builtin"]\n---\nMatey.\n{{ tools }}\n' });
			const session = await createTestSession({ extensions: [CONTRIB, PERSONA, CAPTURE] });
			try {
				await runCommand(session, "persona", "builtinonly");
				await session.run(when("hi", [says("ahoy")]));
				assert.ok(!(captures()[0].selectedTools ?? []).includes(PROBE_TOOL), "the request must lose that tool too, not just the list");
				assert.match(captures()[0].prompt, /- read: /, "pi's own tools stay");
				assert.doesNotMatch(captures()[0].prompt, /probe_tool/);
				assert.deepEqual(notes(session).filter((n) => n.startsWith("persona:")), [], "an exact gate must not warn");
			} finally {
				session.dispose();
			}
		});

		test("the gate is attributed by pi's SourceInfo: the fixture matches its path, not `builtin`", async () => {
			tempAgentDir({ bypath: '---\nextensions: ["**/fixtures/*"]\n---\nMatey.\n{{ tools }}\n' });
			const session = await createTestSession({ extensions: [CONTRIB, PERSONA, CAPTURE] });
			try {
				await runCommand(session, "persona", "bypath");
				await session.run(when("hi", [says("ahoy")]));
				assert.ok((captures()[0].selectedTools ?? []).includes(PROBE_TOOL), "a path glob reaches the loaded extension");
				assert.ok(!(captures()[0].selectedTools ?? []).includes("read"), "and pi's built-ins are out");
			} finally {
				session.dispose();
			}
		});

		test("context: removes another extension's section and its appended addendum line", async () => {
			tempAgentDir({ quiet: '---\ncontext: ["*", "!section:contrib_notes", "!append:*"]\n---\nMatey.\n' });
			const session = await createTestSession({ extensions: [CONTRIB, PERSONA, CAPTURE] });
			try {
				await runCommand(session, "persona", "quiet");
				await session.run(when("hi", [says("ahoy")]));
				assert.doesNotMatch(captures()[0].prompt, /<contrib_notes>/);
				assert.doesNotMatch(captures()[0].prompt, /contributed by the fixture/);
				assert.ok(!(captures()[0].sections ?? []).includes(CONTRIB_SECTION), "the section must be gone from the options, not just unwrapped");
				assert.deepEqual(notes(session).filter((n) => n.startsWith("persona:")), [], "no pattern may be reported as unused here");
			} finally {
				session.dispose();
			}
		});

		test("tools: [] 在真会话里就是真全关：请求里没有工具声明", async () => {
			tempAgentDir({ notools: '---\ntools: []\n---\nMatey.\n{{ tools }}\n' });
			const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
			try {
				await runCommand(session, "persona", "notools");
				await session.run(when("hi", [says("ahoy")]));
				assert.deepEqual(captures()[0].selectedTools, []);
				assert.doesNotMatch(captures()[0].prompt, /- read: |probe_tool/);
				assert.match(captures()[0].prompt, /\(none\)/, "没工具就是 pi 的 (none)，段本身不会消失");
			} finally {
				session.dispose();
			}
		});

		test("/persona status 在第一次 run 之前就报出 front-matter 里的门控，并标出没应用", async () => {
			tempAgentDir({ builtinonly: '---\nextensions: ["builtin"]\n---\nMatey.\n' });
			const session = await createTestSession({ extensions: [CONTRIB, PERSONA, CAPTURE] });
			try {
				await runCommand(session, "persona", "builtinonly");
				await runCommand(session, "persona", "status");
				assert.match(lastNote(session), /gates: extensions=\["builtin"\] context=\* \(front-matter; no run has applied them yet\)/);
				await session.run(when("hi", [says("ahoy")]));
				await runCommand(session, "persona", "status");
				assert.match(lastNote(session), /^gates: extensions=\["builtin"\] context=\*$/m);
			} finally {
				session.dispose();
			}
		});

		test("/persona status repeats the gate that is in force", async () => {
			tempAgentDir({ builtinonly: '---\nextensions: ["builtin"]\n---\nMatey.\n' });
			const session = await createTestSession({ extensions: [CONTRIB, PERSONA, CAPTURE] });
			try {
				await runCommand(session, "persona", "builtinonly");
				await session.run(when("hi", [says("ahoy")]));
				await runCommand(session, "persona", "status");
				assert.match(lastNote(session), /gates: extensions=\["builtin"\] context=\*/);
			} finally {
				session.dispose();
			}
		});
	});

	test("when no provider request happened, the notes say so and nothing is invented", async () => {
		const agentDir = tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("ahoy")]));
			await runCommand(session, "persona", "prompt");
			assert.match(readFileSync(notesFile(agentDir), "utf8"), /no provider request seen in this session/);
			assert.ok(!existsSync(sentFile(agentDir)), "no payload captured, so no provider-side file");
		} finally {
			session.dispose();
		}
	});
});
