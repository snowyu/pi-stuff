/**
 * Session-level tests with @marcfargas/pi-test-harness: a real pi session in process, the real
 * persona extension, and a scripted model instead of an LLM. Zero network, zero model calls.
 *
 * These prove what unit tests cannot: pi loads the extension, `session_start` picks the persona up,
 * `/persona` is registered, and the prompt the run actually starts with is the rendered template —
 * including pi's own `<tools>`, `<rules>` and `<docs>` sections substituted into `{{...}}`.
 *
 * The project directory (`<cwd>/.pi/personas`) is not covered here: the harness builds its session
 * with `SessionManager.inMemory()`, which reports `process.cwd()` rather than the temp cwd, so
 * `ctx.sessionManager.getCwd()` is not the session's project. Test that search order against a real
 * pi process instead (test/real/persona.real.test.ts).
 *
 * Requires scripts/patch-pi-test-harness.mjs (run by `postinstall`) until upstream supports pi 1.x.
 */
import { createTestSession, says, when, type TestSession } from "@marcfargas/pi-test-harness";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";

import { CAPTURES_KEY, type PromptCapture } from "./fixtures/prompt-capture.ts";

const PERSONA = new URL("../extensions/persona.ts", import.meta.url).pathname;
const CAPTURE = new URL("./fixtures/prompt-capture.ts", import.meta.url).pathname;
const LOADOUT = new URL("./fixtures/tool-loadout.ts", import.meta.url).pathname;

/** A persona that borrows pi's tool list and rules and adds one of its own. */
const PIRATE = "You are a pirate coding matey. End every reply with \"Arrr!\".\n\n<tools>\n{{tools}}\n</tools>\n";
const REVIEWER = "You are a senior code reviewer.\n\n<rules>\n{{rules}}\n- Read the whole file before commenting.\n</rules>\n";

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

describe("persona in a real pi session", () => {
	beforeEach(() => {
		(globalThis as Record<string, unknown>)[CAPTURES_KEY] = [];
		delete process.env.PI_PERSONA;
		delete process.env.PI_PERSONAS_PATH;
		// Isolate even the tests that choose no persona: without this, the developer's own
		// <agent dir>/personas/current would decide what pi's prompt is.
		tempAgentDir({});
	});

	test("with no persona chosen, the prompt is pi's own", async () => {
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await session.run(when("hi", [says("ahoy")]));
			const [first] = captures();
			assert.equal(captures().length, 1);
			assert.equal(first.customPrompt, undefined, "nothing may be set on systemPromptOptions");
			assert.match(first.prompt, /expert coding assistant/);
			assert.match(first.prompt, /<tools>/);
			assert.equal(notes(session).length, 0, "an extension that does nothing must stay silent");
		} finally {
			session.dispose();
		}
	});

	test("/persona pirate rewrites the next run's prompt", async () => {
		tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("ahoy")]));

			const [first] = captures();
			assert.match(first.customPrompt ?? "", /pirate coding matey/);
			assert.match(first.prompt, /You are a pirate coding matey/);
			// {{tools}} came out of pi's own <tools> section, placeholder and tags gone.
			assert.ok(!first.prompt.includes("{{tools}}"), "placeholder must be substituted");
			assert.match(first.prompt, /In addition to the tools above/);
			assert.match(lastNote(session), /persona: pirate/);
		} finally {
			session.dispose();
		}
	});

	test("the persona survives later turns in the same session", async () => {
		tempAgentDir({ reviewer: REVIEWER });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "reviewer");
			await session.run(when("first", [says("one")]), when("second", [says("two")]));

			assert.equal(captures().length, 2);
			for (const capture of captures()) {
				assert.match(capture.customPrompt ?? "", /senior code reviewer/);
				assert.ok(!capture.prompt.includes("{{rules}}"));
				assert.match(capture.prompt, /Read the whole file before commenting/);
				// pi's own rules survive the swap because {{rules}} is borrowed, not replaced.
				assert.match(capture.prompt, /Be concise in your responses/);
			}
		} finally {
			session.dispose();
		}
	});

	test("pi still owns the sections the persona does not mention", async () => {
		tempAgentDir({ pirate: "You are a pirate.\n\nRules:\n{{rules}}\n" });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("arr")]));

			const [first] = captures();
			assert.match(first.customPrompt ?? "", /You are a pirate/);
			// pi appends what the template never mentioned: the persona only replaces the preamble.
			assert.match(first.prompt, /<cwd>/);
			assert.ok(!first.customPrompt!.includes("<cwd>"), "<cwd> is pi's own, not borrowed");
			assert.ok(first.prompt.includes(session.cwd), "the <cwd> section carries the session directory");
		} finally {
			session.dispose();
		}
	});

	test("a persona file that disappears mid-session falls back to pi's prompt", async () => {
		// A name only this run's agent dir has, so deleting it really makes it unavailable:
		// the personas shipped in the package are searched too.
		const agentDir = tempAgentDir({ vanishing: "You are the vanishing persona." });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "vanishing");
			rmSync(join(agentDir, "personas", "vanishing.md"));
			await session.run(when("hi", [says("hi")]));

			const [first] = captures();
			assert.equal(first.customPrompt, undefined, "a run must never start half-configured");
			assert.match(first.prompt, /expert coding assistant/);
			assert.match(lastNote(session), /'vanishing' not found/);
		} finally {
			session.dispose();
		}
	});

	test("a corrupt personas/current means nothing was remembered", async () => {
		const agentDir = tempAgentDir({ pirate: PIRATE });
		writeFileSync(stateFile(agentDir), "../../etc/passwd\n");
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await session.run(when("hi", [says("hi")]));
			assert.equal(captures()[0].customPrompt, undefined);
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
			assert.match(second.prompt, /expert coding assistant/);
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

			assert.match(lastNote(session), /no such persona/i);
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

			assert.match(lastNote(session), /no such persona/i);
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
			// The two from this run's agent dir plus the one shipped in the package.
			for (const expected of ["pirate", "reviewer", "default"]) assert.ok(offered.includes(expected), `offered ${expected}`);
			assert.match(captures()[0].customPrompt ?? "", /senior code reviewer/);
		} finally {
			session.dispose();
		}
	});

	test("/persona pirate new switches persona before asking pi for a session", async () => {
		tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate new");
			// The choice is persisted first, so the new session restores it (tier 2's newSession is a no-op).
			assert.equal(readFileSync(stateFile(process.env.PI_CODING_AGENT_DIR ?? ""), "utf8").trim(), "pirate");
			await session.run(when("hi", [says("arr")]));
			assert.match(captures()[0].customPrompt ?? "", /pirate coding matey/);
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
			// And it is in the session tree, so resume can restore it without the file.
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
			const status = session.events.uiCallsFor("setStatus").at(-1);
			assert.deepEqual(status?.args, ["persona", "persona: pirate"]);
		} finally {
			session.dispose();
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

	test("with a custom pi prompt there is nothing to borrow: the placeholder is dropped, not literal", async () => {
		// SYSTEM.md / --system-prompt make pi skip <tools>/<rules>/<docs> entirely, so a template that
		// asks for them must degrade to the persona text alone.
		tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [PERSONA, CAPTURE], systemPrompt: "You are pi configured through --system-prompt." });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("one", [says("arr")]), when("two", [says("arr again")]));

			assert.equal(captures().length, 2);
			for (const capture of captures()) {
				assert.match(capture.customPrompt ?? "", /pirate coding matey/);
				assert.ok(!capture.prompt.includes("{{"), "placeholder syntax must never reach the model");
				assert.ok(!capture.prompt.includes("<tools>"), "an empty <tools></tools> would claim there are no tools");
				assert.match(capture.prompt, /<cwd>/, "pi still appends its own sections after the preamble");
			}
			const warnings = notes(session).filter((note) => note.includes("nothing to borrow"));
			assert.equal(warnings.length, 1, "one warning per placeholder per process, not per run");
			assert.match(warnings[0], /\{\{tools\}\}/);
		} finally {
			session.dispose();
		}
	});

	test("a borrowed <tools> body is handler-time state, not the finalized loadout", async () => {
		// The fixture narrows the loadout in an earlier handler; pi applies that after the chain runs,
		// so a section borrowed during the handler can name a tool the request does not declare.
		tempAgentDir({ pirate: PIRATE });
		const session = await createTestSession({ extensions: [LOADOUT, PERSONA, CAPTURE] });
		try {
			await runCommand(session, "persona", "pirate");
			await session.run(when("hi", [says("arr")]));

			const [first] = captures();
			assert.deepEqual(first.activeTools, ["read"], "the model is told about read only");
			assert.match(first.customPrompt ?? "", /- bash:/, "the borrowed body still lists bash");
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
		} finally {
			session.dispose();
		}
	});
});
