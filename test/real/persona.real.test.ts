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
const CONTRIBUTOR = new URL("../fixtures/contributor.ts", import.meta.url).pathname;

/**
 * A throwaway agent dir: pi and persona both read PI_CODING_AGENT_DIR, and an empty `packages`
 * list keeps the developer's own packages (and their personas) out of the run.
 */
function testAgentDir(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stuff-persona-real-"));
	mkdirSync(join(dir, "sessions"), { recursive: true });
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ packages: [] }, null, 2)}\n`);
	for (const [name, contents] of Object.entries(files)) {
		const file = join(dir, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents);
	}
	return dir;
}

async function runPersonaScenario(
	testName: string,
	environment: Record<string, string> = {},
	project: Record<string, string> = {},
	systemPrompt?: string,
	agentFiles: Record<string, string> = {},
	extraExtensions: string[] = [],
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
		extensions: [EXTENSION, ...extraExtensions],
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		conversation: [assistantMessage([text("done")])],
		environment: { PI_CODING_AGENT_DIR: testAgentDir(agentFiles), ...environment },
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

	test("extensions: is answered by pi's own SourceInfo: a real run knows who registered the tool", async () => {
		// Baseline first: the loaded fixture's tool really is declared, so its absence below is the gate.
		const all = await runPersonaScenario("gate-off", { PI_PERSONA: "listing" }, {
			".pi/personas/listing.md": "Listing.\n\n{{ tools }}\n",
		}, undefined, {}, [CONTRIBUTOR]);
		assert.match(getSystemPrompt(all.run), /- probe_tool: probe the fixture/);

		const gated = await runPersonaScenario("gate-builtin", { PI_PERSONA: "builtinonly" }, {
			".pi/personas/builtinonly.md": '---\nextensions: ["builtin"]\n---\nBuiltins only.\n\n{{ tools }}\n',
		}, undefined, {}, [CONTRIBUTOR]);
		const prompt = getSystemPrompt(gated.run);
		assert.match(prompt, /- read:/, "pi's own tools stay");
		assert.ok(!prompt.includes("probe_tool"), "the tool another extension registered is out of the prompt");
	});

	test("tools: [] in a real run declares nothing and leaves pi's (none) in <tools>", async () => {
		const { run } = await runPersonaScenario("no-tools", { PI_PERSONA: "notools" }, {
			".pi/personas/notools.md": "---\ntools: []\n---\nEmpty.\n\n{{ tools }}\n",
		});
		const prompt = getSystemPrompt(run);
		assert.match(prompt, /<tools>\n\(none\)/, "显式全关不是把段弄没，是 pi 自己的 (none)");
		assert.ok(!prompt.includes("- read:"), "一个工具也不声明");
	});

	test("the shipped \"audited\" persona really drops a loaded extension's tool in a real run", async () => {
		// 出厂范例不是文档饰物：contributor 的 tool 由 pi 真加载、真注册，而 `extensions:` 说不要。
		const { run } = await runPersonaScenario("shipped-audited", { PI_PERSONA: "audited" }, {}, undefined, {}, [CONTRIBUTOR]);
		const prompt = getSystemPrompt(run);
		assert.match(prompt, /- read:/, "内置工具留下");
		assert.ok(!prompt.includes("probe_tool"), "另一个扩展注册的工具既不在 prompt 里，也不在声明里");
	});

	test("APPEND_SYSTEM.md: pi ships one layer, and {{ append_global }} is how a persona asks for the other", async () => {
		// Both layers exist. pi loads exactly one (project wins, the agent-dir file is skipped —
		// resource-loader.js discoverAppendSystemPromptFile), so "my global rules disappeared" is a real
		// failure mode. The persona re-discovers both with pi's own precedence and labels them, so an
		// author can ask for the layer pi skipped instead of silently losing it.
		const { run } = await runPersonaScenario(
			"append-layers",
			{ PI_PERSONA: "layers" },
			{ ".pi/personas/layers.md": "Layers.\n\nglobal=[{{ append_global }}] project=[{{ append_project }}] pi=[{{ append_system }}]\n", ".pi/APPEND_SYSTEM.md": "project layer rules\n" },
			undefined,
			{ "APPEND_SYSTEM.md": "global layer rules\n" },
		);
		const prompt = getSystemPrompt(run);
		assert.match(prompt, /pi=\[project layer rules/, "pi really shipped the project layer");
		assert.match(prompt, /project=\[project layer rules\]/, "the layer pi shipped");
		assert.match(prompt, /global=\[global layer rules\]/, "the layer pi skipped is reachable on purpose, not invented");
		assert.ok(!/pi=\[[^\]]*global layer/.test(prompt), "{{ append_system }} 里只有一份：不能假称 pi 追了两层");
	});

	test("the project personas/current pins the persona for that directory", async () => {
		// No flag, no env: only a `current` an earlier `/persona` wrote in this project. Tier 3 is where the
		// session cwd is a real workspace, so this is the real-process proof of the read path.
		const { run } = await runPersonaScenario("project-pin", {}, {
			".pi/personas/captain.md": "You are the project's captain.\n",
			".pi/personas/current": "captain",
		});
		assert.match(getSystemPrompt(run), /project's captain/);
		assert.ok(!getSystemPrompt(run).includes("coding assistant running inside pi"));
	});

	test("a global personas/current applies until this project pins its own", async () => {
		const agent = { "personas/captain.md": "You are the user's captain.\n", "personas/current": "captain" };

		// A directory with no pin of its own keeps the remembered global choice.
		const inherited = await runPersonaScenario("global-pin", {}, {}, undefined, agent);
		assert.match(getSystemPrompt(inherited.run), /user's captain/, "the global personas/current still applies");

		// The same global choice, but this project pins something else: project wins.
		const pinned = await runPersonaScenario("project-beats-global", {}, {
			".pi/personas/navigator.md": "You are the project's navigator.\n",
			".pi/personas/current": "navigator",
		}, undefined, agent);
		const prompt = getSystemPrompt(pinned.run);
		assert.match(prompt, /project's navigator/, "the project pin outranks the global one");
		assert.ok(!prompt.includes("user's captain"));
	});
});
