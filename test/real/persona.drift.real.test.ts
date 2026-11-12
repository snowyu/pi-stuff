/**
 * Tier 3: pi's own `<tools>` / `<rules>` composition against persona's re-assembly of the same
 * structured facts, across several tool loadouts, inside a real pi process.
 *
 * This is the branch-covering counterpart to test/persona.golden.test.ts (one recorded snapshot).
 * It fails when pi changes how it composes those sections — i.e. exactly on a pi upgrade, which is
 * when the hand-copied assembly in extensions/persona/core.ts needs a matching change.
 *
 * Requires the real `pi` binary on PATH, like every test under test/real/.
 */
import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const DRIFT = new URL("../fixtures/drift-check.ts", import.meta.url).pathname;

type DriftResult = {
	label: string;
	toolsOK: boolean;
	rulesOK: boolean;
	piTools?: string;
	ourTools?: string;
	piRules?: string;
	ourRules?: string;
	note?: string;
};

function agentDirWithoutPackages(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stuff-drift-agent-"));
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ packages: [] }, null, 2)}\n`);
	return dir;
}

describe("persona's rendering vs a live pi", () => {
	test("every tool-loadout branch composes the same text pi composes", async () => {
		const out = join(mkdtempSync(join(tmpdir(), "pi-stuff-drift-out-")), "drift.json");

		const run = await new PiIntegrationTest({
			testName: "drift-branches",
			artifactsDir: testArtifactsDir(import.meta.filename),
			transport: "rpc",
			cwd: mkdtempSync(join(tmpdir(), "pi-stuff-drift-ws-")),
			extensions: [DRIFT],
			conversation: [assistantMessage([text("done")])],
			environment: { PI_CODING_AGENT_DIR: agentDirWithoutPackages(), PI_STUFF_DRIFT_OUT: out },
		}).run("say hi");
		assert.ok(existsSync(out), `the drift fixture wrote nothing; run artifacts in ${run.artifacts.directory}`);

		const results = JSON.parse(readFileSync(out, "utf8")) as DriftResult[];
		assert.ok(results.length >= 7, `expected every branch to be exercised, got ${results.map((r) => r.label).join(", ")}`);

		for (const r of results) {
			// A missing section means pi did not render one at all (customPrompt in play) — the fixture
			// runs without one, so absence is drift, not a pass.
			assert.ok(r.piTools, `${r.label}: pi rendered no <tools> section`);
			assert.ok(r.piRules, `${r.label}: pi rendered no <rules> section`);
			assert.ok(
				r.toolsOK,
				`${r.label}: <tools> drift\n--- pi ---\n${r.piTools}\n--- persona ---\n${r.ourTools}`,
			);
			assert.ok(
				r.rulesOK,
				`${r.label}: <rules> drift\n--- pi ---\n${r.piRules}\n--- persona ---\n${r.ourRules}`,
			);
		}
	});
});
