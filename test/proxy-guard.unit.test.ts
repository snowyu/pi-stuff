/**
 * Unit tests: pure decision logic, no pi runtime, no fs, no network.
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decideProxyCall, normalizeProxy, proxyEndpoint } from "../extensions/proxy-guard.ts";

describe("decideProxyCall", () => {
	const cases: Array<{
		name: string;
		input: { toolName?: string; mode: "auto" | "direct" | "proxy"; override?: string; configured: string; reachable: boolean };
		expect: { inject?: string; notify?: boolean; noteIncludes: string };
	}> = [
		{
			name: "auto + proxy reachable -> leave args untouched",
			input: { mode: "auto", configured: "http://p:1", reachable: true },
			expect: { noteIncludes: "reachable, kept" },
		},
		{
			name: "auto + proxy down -> force direct",
			input: { mode: "auto", configured: "http://p:2", reachable: false },
			expect: { inject: "", notify: true, noteIncludes: "unreachable" },
		},
		{
			name: "auto + no proxy configured -> untouched",
			input: { mode: "auto", configured: "", reachable: false },
			expect: { noteIncludes: "no proxy configured" },
		},
		{
			name: "auto + override wins over configured, no fallback",
			input: { mode: "auto", override: "", configured: "http://p:3", reachable: true },
			expect: { inject: "", noteIncludes: "override" },
		},
		{
			name: "auto + override url is injected as given",
			input: { mode: "auto", override: "socks5://other:1080", configured: "http://p:4", reachable: true },
			expect: { inject: "socks5://other:1080", noteIncludes: "override" },
		},
		{
			name: "direct -> always force direct",
			input: { mode: "direct", configured: "http://p:5", reachable: true },
			expect: { inject: "", noteIncludes: "mode=direct" },
		},
		{
			name: "proxy -> keep configured proxy even when the probe says down",
			input: { mode: "proxy", configured: "http://p:6", reachable: false },
			expect: { noteIncludes: "mode=proxy, keeping http://p:6" },
		},
		{
			name: "proxy mode ignores a stale override",
			input: { mode: "proxy", override: "", configured: "http://p:7", reachable: false },
			expect: { noteIncludes: "mode=proxy, keeping http://p:7" },
		},
	];

	for (const testCase of cases) {
		test(testCase.name, () => {
			const decision = decideProxyCall({ toolName: "fetch_content", ...testCase.input });
			// undefined == the tool arguments stay untouched.
			assert.equal(decision.inject, testCase.expect.inject, `${testCase.name}: inject`);
			if (testCase.expect.notify !== undefined) assert.equal(decision.notify, testCase.expect.notify, `${testCase.name}: notify`);
			assert.match(decision.note, new RegExp(testCase.expect.noteIncludes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		});
	}

	test("every decision carries a note for the debug log", () => {
		const decision = decideProxyCall({ toolName: "fetch_content", mode: "auto", configured: "http://p:8", reachable: true });
		assert.ok(decision.note.startsWith("fetch_content: "));
	});
});

describe("normalizeProxy", () => {
	const cases: Array<[string, string | undefined]> = [
		["localhost:8088", "http://localhost:8088"], // host:port, not scheme:port
		["127.0.0.1:8088", "http://127.0.0.1:8088"],
		["http://127.0.0.1:8088", "http://127.0.0.1:8088"],
		["socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"],
		["  localhost:8088  ", "http://localhost:8088"],
		["none", ""],
		["direct", ""],
		["off", ""],
		["", ""],
		["not-a-proxy", undefined],
		// A URL without a port is accepted; the reachability probe assumes 8080 (see proxyEndpoint).
		["http://localhost", "http://localhost"],
		["localhost:99999", undefined], // port out of range
		["scheme://host:1234", undefined],
	];

	for (const [input, expected] of cases) {
		test(`normalizes ${JSON.stringify(input)}`, () => {
			assert.equal(normalizeProxy(input), expected);
		});
	}
});

describe("proxyEndpoint", () => {
	test("reads host and port from a URL", () => {
		assert.deepEqual(proxyEndpoint("http://127.0.0.1:8088"), { host: "127.0.0.1", port: 8088 });
	});

	test("defaults the port by scheme", () => {
		assert.deepEqual(proxyEndpoint("https://proxy.example"), { host: "proxy.example", port: 443 });
		assert.deepEqual(proxyEndpoint("http://proxy.example"), { host: "proxy.example", port: 8080 });
	});

	test("accepts bare host:port", () => {
		assert.deepEqual(proxyEndpoint("10.0.0.1:3128"), { host: "10.0.0.1", port: 3128 });
	});

	test("uses port 8080 as the probe default for http", () => {
		// Only the probe is affected: an omitted or 0 port falls back to the usual local-proxy port.
		assert.deepEqual(proxyEndpoint("http://localhost"), { host: "localhost", port: 8080 });
		assert.deepEqual(proxyEndpoint("socks5://host:0"), { host: "host", port: 8080 });
	});

	test("rejects junk", () => {
		assert.equal(proxyEndpoint(""), undefined);
		assert.equal(proxyEndpoint("localhost"), undefined);
		assert.equal(proxyEndpoint("localhost:0"), undefined);
		assert.equal(proxyEndpoint("localhost:70000"), undefined);
	});
});
