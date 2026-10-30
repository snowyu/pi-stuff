/**
 * Test starter: copy next to your extension as `test/<name>.unit.test.ts` and
 * `test/<name>.session.test.ts`. See docs/testing.md for the three tiers.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decideToolCall } from "../templates/extension.ts";

/* ---------------------------------------------------------------- tier 1 */

describe("decideToolCall", () => {
	const cases: Array<{ name: string; toolName: string; mode: "read-only" | "edit"; block: boolean }> = [
		{ name: "edit mode allows writes", toolName: "edit", mode: "edit", block: false },
		{ name: "read-only blocks edit", toolName: "edit", mode: "read-only", block: true },
		{ name: "read-only blocks write", toolName: "write", mode: "read-only", block: true },
		{ name: "read-only still allows reads", toolName: "read", mode: "read-only", block: false },
		{ name: "read-only still allows bash", toolName: "bash", mode: "read-only", block: false },
	];

	for (const testCase of cases) {
		test(testCase.name, () => {
			const decision = decideToolCall(testCase.toolName, testCase.mode, new Set(["edit", "write"]));
			assert.equal(decision.block, testCase.block);
			if (testCase.block) assert.match(decision.reason ?? "", /read-only/);
		});
	}
});

/* ---------------------------------------------------------------- tier 2 */

/*
import { calls, createTestSession, says, when, type TestSession } from "@marcfargas/pi-test-harness";
import { mkdtempSync, writeFileSync } from "node:fs";

const EXTENSION = new URL("../extensions/<name>.ts", import.meta.url).pathname;

async function session(files: Record<string, unknown> = {}): Promise<TestSession> {
	const agentDir = mkdtempSync("/tmp/pi-stuff-<name>-");           // join(tmpdir(), ...) in real code
	writeFileSync(`${agentDir}/settings.json`, JSON.stringify({ packages: [] }));
	for (const [name, contents] of Object.entries(files)) writeFileSync(`${agentDir}/${name}`, JSON.stringify(contents, null, 2));
	process.env.PI_CODING_AGENT_DIR = agentDir;                        // extensions resolve their state here
	return await createTestSession({ extensions: [EXTENSION] });
}

test("blocks edit while read-only", async () => {
	const session = await session();
	process.env.TEMPLATE_MODE = "read-only";
	try {
		await session.run(when("change the file", [calls("edit", { path: "a.ts", edits: [] }), says("blocked")]));
		const blocked = session.events.blockedCalls();
		assert.equal(blocked.length, 1);
		assert.match(blocked[0].blockReason ?? "", /read-only/);
	} finally {
		session.dispose();
		delete process.env.TEMPLATE_MODE;
	}
});
*/
