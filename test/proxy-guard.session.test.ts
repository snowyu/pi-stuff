/**
 * Session-level tests with @marcfargas/pi-test-harness: a real pi session, real extension loading,
 * real tool execution, and a scripted model (the playbook) instead of an LLM. Zero network, zero
 * model calls.
 *
 * These prove what unit tests cannot: pi accepts the extension file, the `tool_call` hook runs in
 * the agent loop, the mutated arguments reach the tool, and the notify lands in the UI.
 *
 * Requires scripts/patch-pi-test-harness.mjs (run by `postinstall`) until upstream supports pi 1.x.
 */
import { calls, createTestSession, says, when, type TestSession } from "@marcfargas/pi-test-harness";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";

const EXTENSION = new URL("../extensions/proxy-guard.ts", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/web-tools.ts", import.meta.url).pathname;

/** proxy-guard reads web-search.json / writes proxy-guard.json from PI_CODING_AGENT_DIR. */
const savedPiDir = process.env.PI_CODING_AGENT_DIR;
const savedMode = process.env.PROXY_GUARD_MODE;
const savedDisable = process.env.PROXY_GUARD_DISABLE;

after(() => {
	process.env.PI_CODING_AGENT_DIR = savedPiDir;
	process.env.PROXY_GUARD_MODE = savedMode;
	process.env.PROXY_GUARD_DISABLE = savedDisable;
});

function tempAgentDir(files: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stuff-session-"));
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(join(dir, name), `${JSON.stringify(contents, null, 2)}\n`);
	}
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

/** A listener that stays up until close(); the extension probes with a 500ms connect timeout. */
async function listeningProxy(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((socket) => socket.destroy());
	const port = await new Promise<number>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve(typeof address === "object" && address ? address.port : 0);
		});
	});
	return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** The proxy value the tool actually received: "" means proxy-guard forced a direct connection. */
function proxySeenByTool(session: TestSession, toolName: string): unknown {
	const results = session.events.toolResultsFor(toolName);
	assert.equal(results.length, 1, `expected exactly one ${toolName} result`);
	const received = (results[0].details as { received?: Record<string, unknown> } | undefined)?.received;
	assert.ok(received, `fixture tool did not report its arguments: ${results[0].text}`);
	return received.proxy;
}

async function runOneWebToolCall(proxy: string | undefined, mode: string): Promise<TestSession> {
	tempAgentDir(proxy ? { "web-search.json": { proxy } } : {});
	process.env.PROXY_GUARD_MODE = mode;

	const session = await createTestSession({ extensions: [EXTENSION, FIXTURE] });
	await session.run(
		when("look it up", [calls("fetch_content", { url: "https://example.com" }), says("done")]),
	);
	return session;
}

describe("proxy-guard in a real pi session", () => {
	beforeEach(() => {
		delete process.env.PROXY_GUARD_MODE;
		delete process.env.PROXY_GUARD_DISABLE;
	});

	test("auto + proxy unreachable: the tool is forced direct and the user is told", async () => {
		const session = await runOneWebToolCall("http://127.0.0.1:1", "auto");
		try {
			assert.equal(proxySeenByTool(session, "fetch_content"), "");
			const notified = session.events.uiCallsFor("notify");
			assert.equal(notified.length, 1);
			assert.match(String(notified[0].args?.[0]), /unreachable -> fetch_content direct/);
		} finally {
			session.dispose();
		}
	});

	test("auto + proxy reachable: arguments stay untouched", async () => {
		const proxy = await listeningProxy();
		const session = await runOneWebToolCall(proxy.url, "auto");
		try {
			assert.equal(proxySeenByTool(session, "fetch_content"), undefined);
			assert.equal(session.events.uiCallsFor("notify").length, 0);
		} finally {
			session.dispose();
			await proxy.close();
		}
	});

	test("direct mode: no probe, always direct", async () => {
		const proxy = await listeningProxy();
		const session = await runOneWebToolCall(proxy.url, "direct");
		try {
			assert.equal(proxySeenByTool(session, "fetch_content"), "");
		} finally {
			session.dispose();
			await proxy.close();
		}
	});

	test("PROXY_GUARD_DISABLE=1 keeps pi-web-access's own proxy setting intact", async () => {
		tempAgentDir({ "web-search.json": { proxy: "http://127.0.0.1:1" } });
		process.env.PROXY_GUARD_MODE = "auto";
		process.env.PROXY_GUARD_DISABLE = "1";

		const session = await createTestSession({ extensions: [EXTENSION, FIXTURE] });
		await session.run(when("search", [calls("web_search", { query: "pi" }), says("done")]));
		try {
			assert.equal(proxySeenByTool(session, "web_search"), undefined);
		} finally {
			session.dispose();
		}
	});

	test("a proxy chosen by the model is never overwritten", async () => {
		tempAgentDir({ "web-search.json": { proxy: "http://127.0.0.1:1" } });
		process.env.PROXY_GUARD_MODE = "auto";

		const session = await createTestSession({ extensions: [EXTENSION, FIXTURE] });
		await session.run(
			when("fetch with my proxy", [calls("fetch_content", { url: "https://example.com", proxy: "socks5://127.0.0.1:1080" }), says("done")]),
		);
		try {
			assert.equal(proxySeenByTool(session, "fetch_content"), "socks5://127.0.0.1:1080");
		} finally {
			session.dispose();
		}
	});

	test("/proxy-guard status answers through the registered command", async () => {
		tempAgentDir({ "web-search.json": { proxy: "http://127.0.0.1:1" } });
		process.env.PROXY_GUARD_MODE = "proxy";

		const session = await createTestSession({ extensions: [EXTENSION, FIXTURE] });
		try {
			const runner = session.session.extensionRunner as ExtensionRunner;
			const command = runner.getCommand("proxy-guard");
			assert.ok(command, "expected /proxy-guard to be registered");
			await command.handler("status", runner.createCommandContext());
			assert.match(String(session.events.uiCallsFor("notify").at(-1)?.args?.[0]), /mode=proxy.*no fallback/);
		} finally {
			session.dispose();
		}
	});
});
