/**
 * Real-process tests: a real `pi` binary, real extension loading, real tool execution, real agent
 * loop. The model is replaced by the harness's deterministic scripted provider, so these stay fast
 * and free, but everything from the provider boundary down is genuine.
 *
 * Use this tier for what in-process tests cannot see: pi's own CLI flags and package loading, tool
 * registration in a live session, tool input validation, session artifacts, and TUI rendering.
 *
 * `npm run test:real` (slower than `npm test`: each run spawns pi).
 */
import {
	assistantMessage,
	getToolExecution,
	getToolResultText,
	getToolCallNames,
	PiIntegrationTest,
	testArtifactsDir,
	text,
	toolCall,
} from "pi-coding-agent-test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const EXTENSION = new URL("../../extensions/proxy-guard.ts", import.meta.url).pathname;
const FIXTURE = new URL("../fixtures/web-tools.ts", import.meta.url).pathname;

/**
 * A throwaway agent dir: pi reads its config from PI_CODING_AGENT_DIR, and so does proxy-guard.
 * An empty `packages` list keeps the developer's own extensions (pi-web-access and friends) out of
 * the run, so the fixture tools are the only ones under test.
 */
function testAgentDir(files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stuff-real-"));
	mkdirSync(join(dir, "sessions"), { recursive: true });
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ packages: [] }, null, 2)}\n`);
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(join(dir, name), `${JSON.stringify(contents, null, 2)}\n`);
	}
	return dir;
}

async function runProxyGuardScenario(name: string, files: Record<string, unknown>, environment: Record<string, string> = {}) {
	const workspace = mkdtempSync(join(tmpdir(), "pi-stuff-real-ws-"));
	return await new PiIntegrationTest({
		testName: name,
		artifactsDir: testArtifactsDir(import.meta.filename),
		transport: "rpc",
		cwd: workspace,
		extensions: [EXTENSION, FIXTURE],
		tools: ["fetch_content"],
		conversation: [
			assistantMessage([toolCall({ id: "call-1", name: "fetch_content", arguments: { url: "https://example.com" } })], { stopReason: "toolUse" }),
			assistantMessage([text("done")]),
		],
		environment: { PI_CODING_AGENT_DIR: testAgentDir(files), ...environment },
	}).run("fetch https://example.com");
}

describe("proxy-guard against a real pi process", () => {
	test("a down proxy never breaks the tool call", async () => {
		const run = await runProxyGuardScenario("proxy-down", {
			"web-search.json": { proxy: "http://127.0.0.1:1" },
			"proxy-guard.json": { mode: "auto" },
		});

		const execution = getToolExecution(run, "call-1");
		assert.equal(execution.isError, false, "pi must still run the tool");
		assert.deepEqual(getToolCallNames(run), ["fetch_content"]);
		// The fixture tool echoes its arguments: proxy "" means proxy-guard forced a direct call.
		assert.match(getToolResultText(run, "call-1"), /"proxy":""/);
	});

	test("an explicit mode=proxy leaves the arguments alone", async () => {
		const run = await runProxyGuardScenario("proxy-mode", {
			"web-search.json": { proxy: "http://127.0.0.1:1" },
			"proxy-guard.json": { mode: "proxy" },
		});

		assert.equal(getToolExecution(run, "call-1").isError, false);
		assert.doesNotMatch(getToolResultText(run, "call-1"), /"proxy"/);
	});
});
