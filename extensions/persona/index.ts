/** 接线层：fs / pi API / 状态 / UI。所有决策交给 core。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentEndEvent,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	CONFIG_DIR_NAME,
	formatSkillsForPrompt,
	getAgentDir,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
	type TurnEndEvent,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	type AppendLayers,
	type DeclaredTool,
	type Mode,
	type PersonaDecision,
	type ProviderSystem,
	type ProviderTools,
	type PersonaMeta,
	type PromptFacts,
	type SkillRef,
	type ToolRef,
	assertSafeName,
	type Gate,
	decidePersona,
	extractProviderSystem,
	extractProviderTools,
	extractSection,
	isOff,
	isReserved,
	normalizeName,
	parsePersona,
	renderPromptNotes,
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
	join(cwd, CONFIG_DIR_NAME, "personas"),
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

/**
 * `/persona status` 的门控行。front-matter 写了什么就说什么——切了人设还没跑时也要看得见，
 * 否则"为什么工具少了"只能等到跑一轮才知道。没跑过时标出来，不假称已经生效。
 */
function gateLine(meta: PersonaMeta | undefined, applied: PersonaDecision["gates"]): string {
	const shown = (raw: Gate | undefined) => (raw === undefined ? "*" : JSON.stringify(Array.isArray(raw) ? raw : [raw]));
	const line = `gates: extensions=${shown(meta?.extensions)} context=${shown(meta?.context)}`;
	const declared = meta !== undefined && (meta.extensions !== undefined || meta.context !== undefined);
	return line + (declared && !applied ? " (front-matter; no run has applied them yet)" : "");
}
const readState = (): string => {
	try {
		return existsSync(statePath()) ? readFileSync(statePath(), "utf8").trim() : "";
	} catch {
		return "";
	}
};

/* ---------- facts 映射 ---------- */

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** AGENTS.md 在哪一层：agent 目录 = global，cwd 本级 = project，再往上的祖先目录 = ancestor。 */
function agentLayer(path: string, cwd: string, agentDir: string): "global" | "project" | "ancestor" {
	const p = norm(path);
	if (p.startsWith(`${norm(agentDir)}/`)) return "global";
	if (p.slice(0, p.lastIndexOf("/")) === norm(cwd)) return "project";
	return "ancestor";
}

/**
 * 人设自己重新发现两层 APPEND_SYSTEM.md，为的是让"另一层被 pi 跳过了"可见。
 *
 * pi 只交一份（resource-loader.js 的 discoverAppendSystemPromptFile：项目层需 trust，命中就
 * return，全局层直接被跳过）。所以这里两份都读，但它们不等于上线的那一份——`append:pi` 才是，
 * `append:project` / `append:global` 是人设可以自己点名要回的层。
 */
function discoverAppendLayers(cwd: string, trusted: boolean): AppendLayers {
	const read = (p: string): string => readFileSync(p, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
	const out: AppendLayers = {};
	try {
		const project = join(cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (trusted && existsSync(project)) out.project = { path: project, content: read(project) };
		const global = join(getAgentDir(), "APPEND_SYSTEM.md");
		if (existsSync(global)) out.global = { path: global, content: read(global) };
	} catch { /* 发现失败就是没有层：不拿半截内容冒充 */ }
	return out;
}

function facts(
	o: BuildSystemPromptOptions,
	toolNames: string[],
	attrib: Map<string, { path: string; source: string; scope: string }>,
	layers: AppendLayers,
	cwd: string,
): PromptFacts {
	const hidden = o.hiddenTools ?? [];
	const vis = toolNames.filter((n) => !hidden.includes(n));
	const reader = vis.includes("read") ? "read"
		: vis.includes("bash") ? "bash"
		: toolNames.some((n) => n === "read" || n === "bash") ? "indirect" : undefined;
	const skills = o.skills ?? [];
	const refs = (list: typeof skills): SkillRef[] => list.map((s) => ({
		name: s.name,
		description: s.description,
		path: s.filePath,
		source: s.sourceInfo?.source ?? "unknown",
		scope: s.sourceInfo?.scope ?? "unknown",
	}));
	const tools: ToolRef[] = toolNames.map((n) => {
		const s = attrib.get(n);
		return { name: n, source: s?.source ?? "unknown", scope: s?.scope ?? "unknown", path: s?.path ?? n };
	});
	const agentDir = getAgentDir();
	return {
		cwd: o.cwd,
		now: new Date().toISOString(),
		platform: process.platform,
		toolNames,
		tools,
		hiddenTools: hidden,
		toolSnippets: { ...(o.toolSnippets ?? {}) },
		toolGuidelines: { ...(o.toolGuidelines ?? {}) },
		promptGuidelines: [...(o.promptGuidelines ?? [])],
		skills: refs(skills),
		// 门控砍掉技能后清单必须由剩下的技能重渲染，所以注入 pi 的 formatter，而不是预先渲染好的字符串。
		// reader 措辞取**生效**的工具集（core 把 front-matter 收窄后的 names 传回来）：人设写了
		// `tools: []` 或 `tools: [bash]` 还点名 read，就是模型看得见却没得用的指令。
		renderSkills: (kept, names) => {
			const eff = names ?? toolNames;
			const vis = eff.filter((n) => !hidden.includes(n));
			const r = vis.includes("read") ? "read"
				: vis.includes("bash") ? "bash"
				: eff.some((n) => n === "read" || n === "bash") ? "indirect" : undefined;
			const pick = new Set(kept.map((k) => k.path ?? k.name));
			const list = skills.filter((s) => pick.has(s.filePath) || pick.has(s.name));
			return r && list.length ? formatSkillsForPrompt(list as any, r as any).trim() : "";
		},
		contextFiles: (o.contextFiles ?? []).map((f) => ({ path: f.path, content: f.content, layer: agentLayer(f.path, cwd, agentDir) })),
		appendSystemPrompt: o.appendSystemPrompt ?? "",
		appendLayers: layers,
		foreignSections: Object.keys(o.sections ?? {}),
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
	// 空数组也是一种决定（`extensions:` 砍到没工具），不能当"没写"跳过。
	if (!reuse && d.selectedTools) o.selectedTools = d.selectedTools;
	// `context:` 的门控：两种模式都要执行——它管的是别的扩展/别的层塞进来的东西，不是人设正文。
	// 回退时不复用旧决策的门控（同 selectedTools：那是另一轮的对象集，写回去会砍掉本轮新出现的贡献）。
	if (!reuse && d.filter) {
		const f = d.filter;
		if (o.sections) for (const tag of f.dropSections) delete o.sections[tag];
		if (f.skills) o.skills = (o.skills ?? []).filter((s) => f.skills!.includes(s.name));
		if (f.agents) o.contextFiles = (o.contextFiles ?? []).filter((cf) => f.agents!.includes(cf.path));
		if (!f.append) o.appendSystemPrompt = "";
	}
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
	/**
	 * 上一次 run 真正上线的 system 角色快照（文本 + 工具声明）。
	 *
	 * pi 只把 `before_agent_start` 的修改保留在 run 作用域里：`_runSystemPromptOptions`（"Prompt options
	 * after before_agent_start mutations for the active run"）在 run 的 `finally` 里被清成 undefined。
	 * 而 `ctx.getSystemPrompt()` 是现渲染：`buildSystemPrompt(_runSystemPromptOptions ?? _baseSystemPromptOptions)`。
	 * 斜杠命令必在 idle 时跑，所以在命令里拿到的永远是 base options 的渲染 = pi 原生 prompt。
	 * 想报告“当前生效的 prompt”，只能在 run 里抓。
	 */
	let lastRun: {
		systemText: string;
		mode: Mode;
		declared: DeclaredTool[];
		undeclared: string[];
		/** 这份渲染是回退产物（模板环 / 复用上次好的）——逐字文件里不能自己说，只能记在注释里。 */
		fallback?: string;
	} | undefined;
	/** 上一次 run 实际生效的人设模式（回退时是回退后的那份）。 */
	let lastRunMode: Mode = "sections";
	/** provider 侧的 system 原文（`before_provider_request` 的 payload 里抽的）。 */
	let lastProvider: ProviderSystem | undefined;
	/** 上一次 run 生效的门控（`extensions:` / `context:`），只为复述用：status 和 prompt-notes。 */
	let lastGates: PersonaDecision["gates"];
	/** 同一个 payload 里的工具定义，原封不动（不做摘要）。 */
	let lastTools: ProviderTools | undefined;
	/** 该捕获是否来自 agent run；pi 的 compaction / 摘要请求走同一个 hook。 */
	let providerFromRun = false;
	let inAgentRun = false;
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
			// 快照是会话级的：不清就会把上一个会话的 prompt 当成本会话的导出。
			lastRun = undefined;
			lastRunMode = "sections";
			lastGates = undefined;
			lastProvider = undefined;
			lastTools = undefined;
			providerFromRun = false;
			inAgentRun = false;
			lastCapture = undefined;
		} catch (e) {
			current = undefined;
			currentSource = "(error)";
			ctx.ui.notify(`persona: session_start failed: ${(e as Error).message}`, "error");
		}
		status(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const o = event.systemPromptOptions;
		const cwd = ctx.sessionManager.getCwd();
		const attrib = new Map(pi.getAllTools().map((t) => [t.name, {
			path: t.sourceInfo?.path ?? t.name,
			source: t.sourceInfo?.source ?? "unknown",
			scope: t.sourceInfo?.scope ?? "unknown",
		}]));
		const layers = discoverAppendLayers(cwd, ctx.isProjectTrusted());
		const snapshot = () => facts(o, pi.getActiveTools(), attrib, layers, cwd);
		try {
			lastCapture = { facts: snapshot(), piPromptText: event.systemPrompt ?? "" };
		} catch { /* 采集失败不影响主流程 */ }

		if (!current || isOff(current)) {
			lastRunMode = "sections";             // 没人设：pi 自己的结构化段
			lastGates = undefined;
			return;
		}
		let meta: PersonaMeta = {};
		try {
			const raw = readSafe(cwd, current);
			if (raw === undefined) throw new Error(`persona not found: ${current}`);
			meta = parsePersona(raw).meta;
			const d = decidePersona({
				name: current,
				raw,
				facts: snapshot(),
				piPromptText: event.systemPrompt,
				lastRendered,
				readTemplate: (n) => readSafe(cwd, n),
			});
			apply(o, d);                       // 唯一的一次写入
			lastGood = d;
			lastRendered = d.customPrompt ?? d.forceSystemPrompt;
			lastRunMode = d.mode;
			lastGates = d.gates;
			lastError = undefined;
			warn(ctx, d.warnings);
		} catch (e) {
			const message = (e as Error).message;
			lastError = { persona: current, message, at: new Date().toISOString() };
			const policy = resolveOnError(meta);
			if (policy === "last" && lastGood?.persona === current) {
				try {
					apply(o, lastGood, true);           // 只复用 prompt/sections，工具集与门控取实时
					lastRunMode = lastGood.mode;
					lastGates = undefined;
					ctx.ui.notify(`persona '${current}' failed: ${message} — reusing last good prompt`, "error");
				} catch { /* 保底：什么都不改 */ }
			} else {
				lastRunMode = "sections";             // 回退到 pi 自己的结构化段
				lastGates = undefined;
				ctx.ui.notify(`persona '${current}' failed: ${message} — using pi native prompt`, "error");
			}
		}
		status(ctx);
	});

	/* 抢在 pi 把 `_runSystemPromptOptions` 清掉之前拍快照。turn_end / agent_end 都在 run 窗口内；
	 * 选它们而不是 before_agent_start 末尾，因为 pi 在 handler 返回后才定稿 selectedTools / hiddenTools，
	 * 这时候渲染的才是模型真看到的工具集。两个都抓：turn_end 让快照在长 run 里保持新鲜，agent_end
	 * 保证被取消 / 出错的 run 也能拿到。 */
	const snapshotPrompt = (_event: TurnEndEvent | AgentEndEvent, ctx: ExtensionContext) => {
		try {
			const active = new Set(pi.getActiveTools());
			const all = pi.getAllTools();
			lastRun = {
				systemText: ctx.getSystemPrompt(),
				mode: lastRunMode,
				declared: all.filter((t) => active.has(t.name))
					.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
				undeclared: all.filter((t) => !active.has(t.name)).map((t) => t.name),
				fallback: lastError ? `persona '${lastError.persona}' failed: ${lastError.message}` : undefined,
			};
		} catch { /* 快照失败不干预主流程；下轮再抓 */ }
	};
	pi.on("turn_end", snapshotPrompt);
	pi.on("agent_end", snapshotPrompt);

	/* provider 侧的那一份：payload 就是即将 POST 的对象，system 的存放位置每家不同
	 * （Anthropic 是 `system` 块数组、OAuth 下还会硬插身份段；OpenAI chat 是一条 system/developer
	 * 角本消息；Responses/Codex 用 `instructions`；Google 用 `systemInstruction`），抽法在 core。 */
	pi.on("turn_start", () => {
		inAgentRun = true;
	});
	pi.on("agent_end", () => {
		inAgentRun = false;
	});
	pi.on("before_provider_request", (event, ctx) => {
		const got = extractProviderSystem(event.payload);
		const tools = extractProviderTools(event.payload);
		if (!got.text && !got.note && !tools.tools) return;
		// run 内的捕获优先：idle 时看到的（compaction / 摘要 / 下一次请求）不能顶掉它。
		if (providerFromRun && !inAgentRun) return;
		lastProvider = { ...got, model: ctx.model?.id };
		lastTools = tools;
		providerFromRun = inAgentRun;
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
						gateLine(meta, lastGates),
						`last error: ${lastError ? `${lastError.at} ${lastError.persona}: ${lastError.message}` : "(none)"}`,
					].join("\n"), "info");
					return;
				}
				if (head === "prompt") {
					// 只能报告 pi 真的渲染过的那一份。没快照就是没渲染过：宁可拒，也不能现渲一个 pi 原生
					// prompt 写出去——那是错值，还带个成功的 notify。
					if (!lastRun) {
						ctx.ui.notify("persona: 本会话还没有跑过任何 run，现在导出只会是 pi 原生 prompt。先发一条消息再试", "warning");
						return;
					}
					const dir = join(getAgentDir(), "personas");
					mkdirSync(dir, { recursive: true });
					const written: string[] = [];
					// 逐字：pi 为那次 run 渲染的 system 文本。文件里只有内容，没 banner / 没说明。
					writeFileSync(join(dir, "system-prompt.txt"), lastRun.systemText, "utf8");
					written.push("system-prompt.txt");
					// 逐字：provider 收到的 system 文本 / 工具定义。没捕获到 payload 就不写：注册表里的
					// 定义不是上线的那一份（provider 层还会改名 / 加 strict / 换字段名），不能冒充。
					if (lastProvider?.text) {
						writeFileSync(join(dir, "system-prompt-as-sent.txt"), lastProvider.text, "utf8");
						written.push("system-prompt-as-sent.txt");
					}
					if (lastTools?.tools?.length) {
						writeFileSync(join(dir, "tools-as-sent.json"), `${JSON.stringify(lastTools.tools, null, 2)}\n`, "utf8");
						written.push("tools-as-sent.json");
					}
					// 注释：来源 / 回退 / 工具摘要。这个文件里没有一个字会上线。
					writeFileSync(join(dir, "prompt-notes.txt"), renderPromptNotes({
						at: new Date().toISOString(),
						persona: current ?? "(none)",
						mode: lastRun.mode,
						fallback: lastRun.fallback,
						declared: lastRun.declared,
						undeclared: lastRun.undeclared,
						provider: {
							...(lastProvider ?? { text: "", note: "no provider request seen in this session (a scripted or offline provider builds no payload)" }),
							model: lastProvider?.model,
							caveat: lastProvider && !providerFromRun
								? "captured outside an agent run — pi's compaction and summary requests hit the same hook"
								: undefined,
						},
						toolsCapture: lastTools?.tools?.length
							? lastTools
							: { note: "not written: no payload captured in this session" },
						gates: lastGates,
					}), "utf8");
					written.push("prompt-notes.txt");
					// 切了人设但没跑：快照还是上一个 run 的。notify 里说清它来自哪。
					ctx.ui.notify(`Prompt exports written (${written.join(", ")}) in ${dir}`, "info");
					if (lastError) {
						ctx.ui.notify(
							`persona: 上次 run 渲染失败（${lastError.persona}: ${lastError.message}），导出的是回退后的 prompt`,
							"warning",
						);
					}
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
