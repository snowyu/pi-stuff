/** 接线层：fs / pi API / 状态 / UI。所有决策交给 core。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	formatSkillsForPrompt,
	getAgentDir,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	type PersonaDecision,
	type PersonaMeta,
	type PromptFacts,
	assertSafeName,
	decidePersona,
	extractSection,
	isOff,
	isReserved,
	normalizeName,
	parsePersona,
	resolveCurrent,
	resolveMode,
	resolveOnError,
} from "./core.ts";

const ENTRY = "persona";
const OFF = "off";
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

/* ---------- 搜索路径 ---------- */
const dirs = (cwd: string): string[] => [
	...(process.env.PI_PERSONAS_PATH ?? "").split(":").map((s) => s.trim()).filter(Boolean),
	join(cwd, ".pi", "personas"),
	join(getAgentDir(), "personas"),
	join(SELF_DIR, "personas"),
	join(SELF_DIR, "..", "..", "personas"),
];

function list(cwd: string): string[] {
	const out = new Set<string>();
	for (const d of dirs(cwd)) {
		if (!existsSync(d)) continue;
		for (const f of readdirSync(d)) {
			if (!f.endsWith(".md") || f.startsWith("_") || f.startsWith(".")) continue;
			const name = basename(f, ".md");
			// A file named after a subcommand is unreachable: `/golden` runs the subcommand, it does not
			// select `golden.md`. Keep it out of the selector and the completion list too.
			if (!isReserved(name)) out.add(name);
		}
	}
	return [...out].sort();
}

function readSafe(cwd: string, name: string): string | undefined {
	try {
		assertSafeName(name);
	} catch {
		return undefined;
	}
	for (const d of dirs(cwd)) {
		const p = join(d, `${name}.md`);
		if (existsSync(p)) return readFileSync(p, "utf8");
	}
	return undefined;
}

const statePath = () => join(getAgentDir(), "personas", "current");
const readState = (): string => {
	try {
		return existsSync(statePath()) ? readFileSync(statePath(), "utf8").trim() : "";
	} catch {
		return "";
	}
};

/* ---------- facts 映射 ---------- */
function facts(o: BuildSystemPromptOptions, toolNames: string[]): PromptFacts {
	const hidden = o.hiddenTools ?? [];
	const vis = toolNames.filter((n) => !hidden.includes(n));
	const reader = vis.includes("read") ? "read"
		: vis.includes("bash") ? "bash"
		: toolNames.some((n) => n === "read" || n === "bash") ? "indirect" : undefined;
	const skills = o.skills ?? [];
	return {
		cwd: o.cwd,
		now: new Date().toISOString(),
		platform: process.platform,
		toolNames,
		hiddenTools: hidden,
		toolSnippets: { ...(o.toolSnippets ?? {}) },
		toolGuidelines: { ...(o.toolGuidelines ?? {}) },
		promptGuidelines: [...(o.promptGuidelines ?? [])],
		skillsPrompt: reader && skills.length
			? formatSkillsForPrompt(skills as any, reader as any).trim() : "",
		skills: skills.map((s: any) => ({ name: s.name, description: s.description, path: s.filePath })),
		contextFiles: (o.contextFiles ?? []).map((f) => ({ path: f.path, content: f.content })),
		appendSystemPrompt: o.appendSystemPrompt ?? "",
		customPrompt: o.customPrompt ?? "",
		docsPaths: { readme: getReadmePath(), docs: getDocsPath(), examples: getExamplesPath() },
	};
}

/**
 * 原子应用：要么全写，要么一个字不改。
 *
 * `reuse === true` 是渲染失败后的回退路径：**不拿旧决策的 `selectedTools`**。旧决策可能来自
 * 一个不同的工具集，写回去等于把中途新开的工具又关掉；不写则 pi 用实时 loadout
 * （agent-session 只在 handler 改过 selectedTools 时才尊重它）。
 *
 * `sections` 是**合并**而非覆写：其它扩展注入的同名以外的 section 得以保留（pi 自己的
 * tools/rules/docs 不在 options.sections 里，它在 buildSystemPromptSections 内部生成）。
 */
function apply(o: BuildSystemPromptOptions, d: PersonaDecision, reuse = false): void {
	if (!reuse && d.selectedTools?.length) o.selectedTools = d.selectedTools;
	if (d.mode === "bare") {
		o.forceSystemPrompt = d.forceSystemPrompt;
	} else {
		o.customPrompt = d.customPrompt;
		o.appendSystemPrompt = "";
		o.contextFiles = [];
		o.skills = [];
		o.sections = { ...(o.sections ?? {}), ...(d.sections ?? {}) };
	}
}

export default function persona(pi: ExtensionAPI) {
	pi.registerFlag("persona", {
		description: "Persona from personas/ (off = pi native prompt)",
		type: "string",
		default: "",
	});

	let current: string | undefined;
	let currentSource = "(none)";
	let lastCwd = process.cwd();
	let lastRendered: string | undefined;
	let lastGood: PersonaDecision | undefined;
	let lastError: { persona: string; message: string; at: string } | undefined;
	let lastWarnKey = "";
	/** 本进程里是否真的跑过一个 run——没跑过时 ctx.getSystemPrompt() 会给 pi 原生 prompt。 */
	let hasRun = false;
	let lastCapture: { facts: PromptFacts; piPromptText: string } | undefined;

	const status = (ctx: ExtensionContext) => {
		const base = current && !isOff(current) ? `persona: ${current}` : undefined;
		ctx.ui.setStatus("persona", lastError && base ? `${base} (ERROR)` : base);
	};

	const warn = (ctx: ExtensionContext, ws: string[]) => {
		const key = ws.join("|");
		if (key && key !== lastWarnKey) ctx.ui.notify(`persona: ${ws.join("; ")}`, "warning");
		lastWarnKey = key;
	};

	function persist(name: string, ctx: ExtensionContext) {
		current = name;
		currentSource = "command";
		lastError = undefined;
		try {
			pi.appendEntry(ENTRY, { name });
			mkdirSync(dirname(statePath()), { recursive: true });
			writeFileSync(statePath(), name, "utf8");
		} catch (e) {
			ctx.ui.notify(`persona: could not persist state: ${(e as Error).message}`, "warning");
		}
		status(ctx);
	}

	pi.on("session_start", (_e, ctx) => {
		try {
			lastCwd = ctx.sessionManager.getCwd();
			const entries = ctx.sessionManager.getEntries() as Array<any>;
			const sessionEntry = [...entries].reverse()
				.find((e) => e.type === "custom" && e.customType === ENTRY)?.data?.name;
			const picked = resolveCurrent({
				flag: String(pi.getFlag("persona") ?? ""),
				env: process.env.PI_PERSONA ?? "",
				sessionEntry,
				stateFile: readState(),
			});
			current = picked;
			currentSource = picked === undefined ? "(none)"
				: String(pi.getFlag("persona") ?? "").trim() ? "--persona flag"
					: (process.env.PI_PERSONA ?? "").trim() ? "PI_PERSONA env"
						: sessionEntry ? "session entry" : "personas/current";
			lastGood = undefined;
			lastError = undefined;
		} catch (e) {
			current = undefined;
			currentSource = "(error)";
			ctx.ui.notify(`persona: session_start failed: ${(e as Error).message}`, "error");
		}
		status(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		hasRun = true;
		const o = event.systemPromptOptions;
		try {
			lastCapture = { facts: facts(o, pi.getActiveTools()), piPromptText: event.systemPrompt ?? "" };
		} catch { /* 采集失败不影响主流程 */ }

		if (!current || isOff(current)) return;
		const cwd = ctx.sessionManager.getCwd();
		let meta: PersonaMeta = {};
		try {
			const raw = readSafe(cwd, current);
			if (raw === undefined) throw new Error(`persona not found: ${current}`);
			meta = parsePersona(raw).meta;
			const d = decidePersona({
				name: current,
				raw,
				facts: facts(o, pi.getActiveTools()),
				piPromptText: event.systemPrompt,
				lastRendered,
				readTemplate: (n) => readSafe(cwd, n),
			});
			apply(o, d);                       // 唯一的一次写入
			lastGood = d;
			lastRendered = d.customPrompt ?? d.forceSystemPrompt;
			lastError = undefined;
			warn(ctx, d.warnings);
		} catch (e) {
			const message = (e as Error).message;
			lastError = { persona: current, message, at: new Date().toISOString() };
			const policy = resolveOnError(meta);
			if (policy === "last" && lastGood?.persona === current) {
				try {
					apply(o, lastGood, true);           // 只复用 prompt/sections，工具集取实时
					ctx.ui.notify(`persona '${current}' failed: ${message} — reusing last good prompt`, "error");
				} catch { /* 保底：什么都不改 */ }
			} else {
				ctx.ui.notify(`persona '${current}' failed: ${message} — using pi native prompt`, "error");
			}
		}
		status(ctx);
	});

	pi.registerCommand("persona", {
		description: "Switch persona: /persona [name] [new] · off · dirs · prompt · status · golden",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = [OFF, "dirs", "prompt", "status", "golden", ...list(lastCwd)]
				.filter((n) => n.startsWith(prefix)).map((n) => ({ value: n, label: n }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			try {
				const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
				const cwd = ctx.sessionManager.getCwd();
				lastCwd = cwd;
				const head = (tokens[0] ?? "").toLowerCase();

				if (head === "dirs") {
					ctx.ui.notify(dirs(cwd).map((d) => `${existsSync(d) ? "✓" : "✗"} ${d}`).join("\n"), "info");
					return;
				}
				if (head === "status") {
					const raw = current && !isOff(current) ? readSafe(cwd, current) : undefined;
					const meta = raw === undefined ? undefined : parsePersona(raw).meta;
					ctx.ui.notify([
						`current: ${current ?? "(none)"}  (from ${currentSource})`,
						`mode: ${meta ? resolveMode(meta) : "(persona unreadable)"}`,
						`on_error: ${meta ? resolveOnError(meta) : "-"}`,
						`cache: ${lastGood ? `${lastGood.persona} (${lastGood.mode})` : "(empty)"}`,
						`last error: ${lastError ? `${lastError.at} ${lastError.persona}: ${lastError.message}` : "(none)"}`,
					].join("\n"), "info");
					return;
				}
				if (head === "prompt") {
					// ctx.getSystemPrompt() 在没有 run 时会退回 base options 的渲染——那是 pi 原生 prompt，
					// 不是"当前生效的 prompt"，所以先拿本进程的 hasRun 拦一手。
					if (!hasRun) {
						ctx.ui.notify("persona: 本会话还没有跑过任何 run，现在导出的是 pi 原生 prompt。先发一条消息再试", "warning");
						return;
					}
					const text = ctx.getSystemPrompt();
					if (!text) {
						ctx.ui.notify("persona: 当前还没有生效的 prompt，先发一条消息再试", "warning");
						return;
					}
					const out = join(getAgentDir(), "personas", ".rendered.txt");
					mkdirSync(dirname(out), { recursive: true });
					writeFileSync(out, text, "utf8");
					ctx.ui.notify(`Effective prompt written: ${out}`, "info");
					return;
				}

				if (head === "golden") {
					if (!lastCapture) {
						ctx.ui.notify("persona: 先发一条消息，再执行 /persona golden", "warning");
						return;
					}
					const { facts: f, piPromptText } = lastCapture;
					const tools = extractSection(piPromptText, "tools");
					const rules = extractSection(piPromptText, "rules");
					if (!tools || !rules) {
						// 只有 customPrompt 会让 pi 不生成这两段（system-prompt.js）。persona 自己不影响：
						// pi 每轮从 base options 现渲染，我们的写入不会回流到 event.systemPrompt。
						ctx.ui.notify(
							"persona: 抽不到 <tools>/<rules>：pi 只在没有 customPrompt 时生成它们。请去掉 SYSTEM.md / --system-prompt 后重试",
							"error",
						);
						return;
					}
					// 开发目录（有 package.json + test/）里直接写回仓库；否则（已安装的包）写到 agent 目录，
					// 不默默在只读安装目录里造目录。
					const repo = join(SELF_DIR, "..", "..");
					const out = existsSync(join(repo, "package.json")) && existsSync(join(repo, "test"))
						? join(repo, "test", "fixtures", "pi-sections.json")
						: join(getAgentDir(), "personas", "pi-sections.json");
					mkdirSync(dirname(out), { recursive: true });
					writeFileSync(out, `${JSON.stringify({
						piVersion: VERSION,
						capturedAt: new Date().toISOString(),
						facts: {
							toolNames: f.toolNames,
							hiddenTools: f.hiddenTools,
							toolSnippets: f.toolSnippets,
							toolGuidelines: f.toolGuidelines,
							promptGuidelines: f.promptGuidelines,
						},
						sections: { tools, rules },
					}, null, 2)}\n`, "utf8");
					ctx.ui.notify(`golden fixture written: ${out}`, "info");
					return;
				}
				const wantNew = tokens.some((t) => t.toLowerCase() === "new");
				let name = normalizeName(tokens.find((t) => t.toLowerCase() !== "new"));
				if (!name) {
					const picked = await ctx.ui.select("Persona:", [OFF, ...list(cwd)]);
					if (!picked) return;
					name = normalizeName(picked);
				}
				if (isOff(name)) {
					persist(OFF, ctx);
					ctx.ui.notify("Persona off (pi native prompt)", "info");
					if (wantNew) await ctx.newSession();
					return;
				}
				assertSafeName(name);
				const raw = readSafe(cwd, name);
				if (raw === undefined) {
					ctx.ui.notify(
						`No such persona: ${name}\navailable: ${list(cwd).join(", ") || "none"}\nsearched:\n${dirs(cwd).join("\n")}`,
						"error",
					);
					return;
				}
				const desc = parsePersona(raw).meta.description;
				persist(name, ctx);
				ctx.ui.notify(`Persona: ${name}${desc ? ` — ${desc}` : ""}`, "info");
				if (wantNew) await ctx.newSession();
			} catch (e) {
				ctx.ui.notify(`persona command failed: ${(e as Error).message}`, "error");
			}
		},
	});
}
