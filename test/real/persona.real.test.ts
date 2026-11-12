/**
 * Real-process tests for persona: the real `pi` binary, real extension loading, real prompt
 * construction. The model is the harness's scripted provider, so these stay fast and free.
 *
 * What only this tier can see: that pi's own `agent_start` prompt really carries the persona, that
 * the persona files shipped inside the package are found by a pi process that was not started from
 * this repository, and that the `--persona` flag survives pi's own argument parsing.
 *
 * `npm run test:real` (each scenario boots a real pi process).
 */
import { assistantMessage, getSystemPrompt, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

const EXTENSION = new URL("../../extensions/persona", import.meta.url).pathname;

/**
 * A throwaway agent dir: pi and persona both read PI_CODING_AGENT_DIR, and an empty `packages`
 * list keeps the developer's own packages (and their personas) out of the run.
 */
function testAgentDir(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stuff-persona-real-"));
	mkdirSync(join(dir, "sessions"), { recursive: true });
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ packages: [] }, null, 2)}\n`);
	for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
	return dir;
}

async function runPersonaScenario(
	testName: string,
	environment: Record<string, string> = {},
	project: Record<string, string> = {},
	systemPrompt?: string,
) {
	const workspace = mkdtempSync(join(tmpdir(), "pi-stuff-persona-real-ws-"));
	for (const [path, contents] of Object.entries(project)) {
		const file = join(workspace, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents);
	}
	const run = await new PiIntegrationTest({
		testName,
		artifactsDir: testArtifactsDir(import.meta.filename),
		transport: "rpc",
		cwd: workspace,
		extensions: [EXTENSION],
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		conversation: [assistantMessage([text("done")])],
		environment: { PI_CODING_AGENT_DIR: testAgentDir(), ...environment },
	}).run("say hi");
	return { run, workspace };
}

describe("persona against a real pi process", () => {
	test("PI_PERSONA replaces pi's preamble with the persona shipped in the package", async () => {
		// No personas in the agent dir or the project: personas/ inside this package must be found.
		const { run } = await runPersonaScenario("package-persona", { PI_PERSONA: "pirate" });

		const prompt = getSystemPrompt(run);
		assert.match(prompt, /pirate coding matey/);
		assert.ok(!prompt.includes("coding assistant running inside pi"), "the persona preamble replaces pi's own");
		assert.ok(!prompt.includes("{{"), "no placeholder may reach the model");
	});

	test("PI_PERSONAS_PATH adds a directory and its placeholders are filled in", async () => {
		const shared = mkdtempSync(join(tmpdir(), "pi-stuff-persona-real-shared-"));
		writeFileSync(
			join(shared, "captain.md"),
			"You are the ship's captain.\n\nWorkdir: {{cwd}}\nDocs: {{docs}}\n",
		);

		const { run, workspace } = await runPersonaScenario("path-persona", {
			PI_PERSONA: "captain",
			PI_PERSONAS_PATH: shared,
		});

		const prompt = getSystemPrompt(run);
		assert.match(prompt, /ship's captain/);
		assert.ok(prompt.includes(workspace), "{{cwd}} is the session's working directory");
		assert.match(prompt, /Pi documentation/, "{{docs}} is pi's own documentation section");
		assert.ok(!prompt.includes("{{"));
	});

	test("a persona in the project overrides the one shipped in the package", async () => {
		const { run } = await runPersonaScenario("project-persona", { PI_PERSONA: "pirate" }, {
			".pi/personas/pirate.md": "You are the project's pirate.\n\nRules: {{rules}}\n",
		});

		const prompt = getSystemPrompt(run);
		assert.match(prompt, /project's pirate/);
		assert.ok(!prompt.includes("pirate coding matey"), "the project file wins over the package file");
		assert.match(prompt, /Be concise in your responses/, "{{rules}} is borrowed from pi");
		assert.ok(!prompt.includes("{{"));
	});

	test("--persona reaches the extension as a real CLI flag", async () => {
		// The harness has no option for arbitrary pi arguments, so the flag is injected by a shim:
		// this is the only test that proves pi still parses the flag and hands it to the extension.
		const bin = mkdtempSync(join(tmpdir(), "pi-stuff-persona-real-bin-"));
		const shim = join(bin, "pi");
		writeFileSync(shim, '#!/bin/sh\nexec pi --persona pirate "$@"\n', { mode: 0o755 });

		const workspace = mkdtempSync(join(tmpdir(), "pi-stuff-persona-real-ws-"));
		const run = await new PiIntegrationTest({
			testName: "flag-persona",
			artifactsDir: testArtifactsDir(import.meta.filename),
			transport: "rpc",
			piCommand: shim,
			cwd: workspace,
			extensions: [EXTENSION],
			conversation: [assistantMessage([text("done")])],
			environment: { PI_CODING_AGENT_DIR: testAgentDir() },
		}).run("say hi");

		assert.match(getSystemPrompt(run), /pirate coding matey/);
	});

	test("with --system-prompt there is no pi docs to borrow: the guarded wrapper disappears", async () => {
		// pi builds <tools>/<rules>/<docs> only when no custom prompt exists. The extension re-assembles
		// tools and rules from structured facts, but docs is extraction-first and stays empty — so the
		// author guards it, exactly like the shipped fragments do. An unguarded empty wrapper would claim
		// a section pi never had.
		const shared = mkdtempSync(join(tmpdir(), "pi-stuff-persona-real-shared-"));
		writeFileSync(
			join(shared, "bare.md"),
				"You are the bare captain.\n\n{% if docs %}\n<docs>\n{{ docs }}\n</docs>\n{% endif %}\n\nWorkdir: {{ cwd }}\n",
		);

		const { run, workspace } = await runPersonaScenario(
			"custom-prompt-persona",
			{ PI_PERSONA: "bare", PI_PERSONAS_PATH: shared },
			{},
			"pi configured through --system-prompt",
		);

		const prompt = getSystemPrompt(run);
		assert.match(prompt, /bare captain/);
		assert.ok(!prompt.includes("--system-prompt"), "the persona replaces the custom prompt, it does not stack on it");
		assert.ok(!prompt.includes("{{"), "no placeholder syntax may reach the model");
		assert.ok(!prompt.includes("<docs>"), "the guarded wrapper disappears with the empty value");
		assert.match(prompt, /- read:/, "the tool list survives when the persona asks for it: it is re-assembled, not borrowed from pi's text");
		assert.ok(prompt.includes(workspace), "{{cwd}} always has a value: it is not a borrowed section");
	});

	test("with no persona chosen, pi builds its own prompt", async () => {
		const { run } = await runPersonaScenario("no-persona");

		const prompt = getSystemPrompt(run);
		assert.match(prompt, /coding assistant running inside pi/);
		assert.match(prompt, /<tools>/);
		assert.ok(!prompt.includes("pirate coding matey"));
	});
});
