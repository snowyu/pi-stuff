/**
 * proxy-guard — control which proxy pi-web-access uses, and survive a dead proxy.
 *
 * Two problems this solves:
 *
 * 1. pi-web-access reads `proxy` from ~/.pi/agent/web-search.json and ignores HTTP_PROXY/HTTPS_PROXY.
 *    Each provider module caches that config per process (see brave.ts `cachedConfig`), so a config
 *    edit needs /reload. And when the proxy is simply not running (for example pi was started through
 *    proxy-ns, where localhost:8088 is unreachable inside the netns), every web tool call fails.
 *
 * 2. Switching proxy/direct by hand means editing JSON and restarting.
 *
 * This extension patches tool arguments before execution (`tool_call` input is mutable and is not
 * re-validated). pi-web-access documents `proxy: "<url>"`, with `""` meaning "force a direct
 * connection". Injected values take effect immediately, without reloading pi-web-access's config.
 *
 * Modes (persisted in ~/.pi/agent/proxy-guard.json, changed with /proxy-guard):
 *   auto    probe the configured proxy; force direct when it is unreachable   (default)
 *   direct  always force direct
 *   proxy   always use the configured proxy, never fall back (errors surface as-is)
 *
 * A proxy override (from /proxy-guard url <addr>) is injected as-is in auto and proxy modes.
 *
 * Overrides: PROXY_GUARD_MODE=auto|direct|proxy beats the saved mode,
 *            PROXY_GUARD_DISABLE=1 turns the extension off,
 *            PROXY_GUARD_DEBUG=/path/to/log records every decision.
 */

import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WEB_TOOLS = new Set(["web_search", "fetch_content", "source_check"]);
const MODES = ["auto", "direct", "proxy"] as const;
type Mode = (typeof MODES)[number];

interface GuardState {
	mode?: Mode;
	/** Proxy to inject into tool calls; "" means force direct. undefined means no override. */
	proxyOverride?: string;
}

const PROBE_TIMEOUT_MS = 500;
const CACHE_TTL_MS = 10_000;

/** Resolve the config directory exactly like pi-web-access's getWebSearchConfigDir(). */
function configDir(): string {
	const explicit = process.env.PI_CODING_AGENT_DIR;
	if (explicit) return explicit;

	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg) {
		if (existsSync(join(xdg, "pi", "web-search.json"))) return join(xdg, "pi");
		if (existsSync(join(homedir(), ".pi", "web-search.json"))) return join(homedir(), ".pi");
		return join(xdg, "pi");
	}
	if (existsSync(join(homedir(), ".pi", "agent", "web-search.json"))) return join(homedir(), ".pi", "agent");
	if (existsSync(join(homedir(), ".pi", "web-search.json"))) return join(homedir(), ".pi");
	return join(homedir(), ".pi", "agent");
}

/** A file in that directory. Presence of web-search.json decides the directory, never the file itself. */
function configFile(name: string): string {
	return join(configDir(), name);
}

/** The proxy URL pi-web-access is configured with, or "" when none is set. */
function configuredProxy(): string {
	try {
		const value = JSON.parse(readFileSync(configFile("web-search.json"), "utf8"))?.proxy;
		return typeof value === "string" ? value.trim() : "";
	} catch {
		return "";
	}
}

function loadState(): GuardState {
	try {
		const raw = JSON.parse(readFileSync(configFile("proxy-guard.json"), "utf8"));
		const state: GuardState = {};
		if (MODES.includes(raw?.mode as Mode)) state.mode = raw.mode as Mode;
		if (typeof raw?.proxyOverride === "string") state.proxyOverride = raw.proxyOverride.trim();
		return state;
	} catch {
		return {};
	}
}

function saveState(patch: GuardState): GuardState {
	const next = { ...loadState(), ...patch };
	const file = configFile("proxy-guard.json");
	writeFileSync(file, `${JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2)}\n`);
	return next;
}

function currentMode(): Mode {
	const env = process.env.PROXY_GUARD_MODE?.trim().toLowerCase();
	if (MODES.includes(env as Mode)) return env as Mode;
	return loadState().mode ?? "auto";
}

/** host/port of a proxy URL. Accepts "http://host:port", "socks5://host:port", "host:port". */
function proxyEndpoint(proxy: string): { host: string; port: number } | undefined {
	let host = "";
	let port = 0;
	try {
		const url = new URL(proxy);
		host = url.hostname;
		port = Number(url.port) || (url.protocol === "https:" ? 443 : 8080);
	} catch {
		const match = /^(?:socks[45]h?|http[s]?)?:\/\/?([^:/]+):(\d+)$/.exec(proxy) || /^([^:/]+):(\d+)$/.exec(proxy);
		if (!match) return undefined;
		host = match[1];
		port = Number(match[2]);
	}
	if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
	return { host, port };
}

/** Normalize what the user typed into a proxy URL pi-web-access will accept. */
function normalizeProxy(value: string): string | undefined {
	const raw = value.trim();
	if (!raw || /^(none|clear|off|direct|false)$/i.test(raw)) return "";
	// Only a real scheme prefix counts as a URL; "localhost:8088" is host:port, not scheme:port.
	const candidate = /^(https?|socks[45]h?):\/\//i.test(raw) ? raw : /^([^:/\s]+):(\d{1,5})$/.test(raw) ? `http://${raw}` : undefined;
	if (!candidate || !proxyEndpoint(candidate)) return undefined;
	return candidate;
}

function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const socket = createConnection({ host, port, timeout: timeoutMs });
		const done = (value: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

/** Set PROXY_GUARD_DEBUG=/path/to/file to record each decision. */
function debug(line: string): void {
	const file = process.env.PROXY_GUARD_DEBUG;
	if (!file) return;
	try {
		appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// Debug output must never affect tool execution.
	}
}

let cache: { proxy: string; up: boolean; at: number } | undefined;

/** Cached probe so repeated tool calls do not each pay a TCP round trip. */
async function proxyIsUp(proxy: string): Promise<boolean> {
	if (cache && cache.proxy === proxy && Date.now() - cache.at < CACHE_TTL_MS) return cache.up;
	const endpoint = proxyEndpoint(proxy);
	const up = endpoint ? await tcpReachable(endpoint.host, endpoint.port, PROBE_TIMEOUT_MS) : false;
	cache = { proxy, up, at: Date.now() };
	return up;
}

/** Write pi-web-access's own proxy setting, keeping every other key intact. */
function writeConfiguredProxy(proxy: string): string {
	const file = configFile("web-search.json");
	let config: Record<string, unknown> = {};
	if (existsSync(file)) {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`refusing to rewrite ${file}: expected a JSON object`);
		}
		copyFileSync(file, `${file}.bak`);
		config = parsed as Record<string, unknown>;
	}
	if (proxy) config.proxy = proxy;
	else delete config.proxy;
	writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
	return file;
}

async function describeState(): Promise<string> {
	const mode = currentMode();
	const override = loadState().proxyOverride;
	const proxy = configuredProxy();
	const parts = [`mode=${mode}`, `config proxy=${proxy || "none"}`, `override=${override === undefined ? "none" : JSON.stringify(override)}`];
	if (mode === "direct") parts.push("effective=direct");
	else if (override !== undefined && mode !== "proxy") parts.push(`effective=${override || "direct"}`);
	else if (!proxy) parts.push("effective=direct");
	else if (mode === "proxy") parts.push(`effective=${proxy} (no fallback)`);
	else parts.push(`effective=${(await proxyIsUp(proxy)) ? proxy : "direct (proxy unreachable)"}`);
	return `${parts.join(", ")}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		// A tool_call handler that throws blocks the tool as a fail-safe, so never throw here.
		try {
			if (process.env.PROXY_GUARD_DISABLE === "1") return;
			if (!WEB_TOOLS.has(event.toolName)) return;

			const input = event.input as Record<string, unknown>;
			// Honour an explicit proxy the model already chose.
			if (typeof input?.proxy === "string" && input.proxy !== "") return;

			const state = loadState();
			const mode = currentMode();
			const proxy = configuredProxy();

			if (mode === "direct") {
				input.proxy = "";
				debug(`${event.toolName}: mode=direct, injected proxy=""`);
				return;
			}

			// A manual /proxy-guard url choice is used as given, with no fallback.
			if (state.proxyOverride !== undefined && mode !== "proxy") {
				input.proxy = state.proxyOverride;
				debug(`${event.toolName}: override proxy=${JSON.stringify(state.proxyOverride)}`);
				return;
			}

			if (!proxy) {
				debug(`${event.toolName}: no proxy configured, left direct`);
				return;
			}
			if (mode === "proxy") {
				debug(`${event.toolName}: mode=proxy, keeping ${proxy}`);
				return;
			}

			if (await proxyIsUp(proxy)) {
				debug(`${event.toolName}: mode=auto, proxy ${proxy} reachable, kept`);
				return;
			}

			input.proxy = ""; // documented as "forces a direct connection"
			debug(`${event.toolName}: mode=auto, proxy ${proxy} unreachable, injected proxy=""`);
			ctx.ui.notify(`proxy-guard: ${proxy} unreachable -> ${event.toolName} direct`, "info");
		} catch {
			// Stay out of the way: let the tool call run with its original arguments.
		}
	});

	pi.registerCommand("proxy-guard", {
		description: "Switch pi-web-access proxy/direct: /proxy-guard [auto|direct|proxy|url <addr>|reset|status]",
		handler: async (args, ctx) => {
			const raw = String(args ?? "").trim();
			const [sub, ...rest] = raw.split(/\s+/);
			const arg = sub.toLowerCase();

			try {
				if (MODES.includes(arg as Mode)) {
					saveState({ mode: arg as Mode });
					cache = undefined;
					ctx.ui.notify(`proxy-guard: ${await describeState()}`, "info");
					return;
				}

				if (arg === "url") {
					const typed = rest.join(" ").trim();
					if (!typed) {
						ctx.ui.notify(`proxy-guard url: current ${await describeState()}`, "info");
						return;
					}
					const proxy = normalizeProxy(typed);
					if (proxy === undefined) {
						ctx.ui.notify(`proxy-guard url: invalid address "${typed}" (use host:port, http://host:port, socks5://host:port, or none)`, "error");
						return;
					}
					// Effective at once, by injecting the value into tool calls.
					saveState({ proxyOverride: proxy });
					// Also persist into pi-web-access's own config (needs /reload for that copy).
					const file = writeConfiguredProxy(proxy);
					cache = undefined;
					const up = proxy ? await proxyIsUp(proxy) : true;
					ctx.ui.notify(
						`proxy-guard: proxy = ${proxy || "direct"} (reachable=${up}); also written to ${file}.bak backup; run /reload to sync pi-web-access's own config copy`,
						"info",
					);
					return;
				}

				if (arg === "reset" || arg === "clear") {
					saveState({ mode: "auto", proxyOverride: undefined });
					cache = undefined;
					ctx.ui.notify(`proxy-guard: reset -> ${await describeState()}`, "info");
					return;
				}

				if (arg === "status" || arg === "") {
					ctx.ui.notify(`proxy-guard: ${await describeState()}`, "info");
					return;
				}

				ctx.ui.notify("proxy-guard: usage /proxy-guard [auto|direct|proxy|url <addr>|reset|status]", "warning");
			} catch (error) {
				ctx.ui.notify(`proxy-guard: ${(error as Error).message}`, "error");
			}
		},
	});
}
