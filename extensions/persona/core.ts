/**
 * 纯核心：无 fs、无网络、无 pi 依赖。所有 IO 与时钟通过入参注入。
 * 接线层负责把 pi 的 options 映射成 PromptFacts，并原子地应用 PersonaDecision。
 */
import { HFTemplate } from "@isdk/template-engines";

export class PersonaError extends Error {}

export type Mode = "sections" | "bare";
export type OnError = "last" | "native";

export type PersonaMeta = {
	mode?: Mode | "force";
	on_error?: OnError;
	tools?: string[] | string;
	sections?: Record<string, string | null> | null;
	description?: string;
};

export type PromptFacts = {
	cwd: string;
	now: string;
	platform: string;
	toolNames: string[]; // 实时 loadout
	hiddenTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	skillsPrompt: string; // 接线层用 pi 的 formatSkillsForPrompt 渲染
	skills: Array<{ name: string; description?: string; path?: string }>;
	contextFiles: Array<{ path: string; content: string }>;
	appendSystemPrompt: string;
	customPrompt: string; // pi 解析出的 SYSTEM.md / --system-prompt
	docsPaths: { readme: string; docs: string; examples: string };
};

export type PersonaDecision = {
	persona: string;
	mode: Mode;
	selectedTools?: string[];
	customPrompt?: string;
	sections?: Record<string, string>;
	forceSystemPrompt?: string;
	warnings: string[];
};

export type DecideInput = {
	name: string;
	raw: string;
	facts: PromptFacts;
	piPromptText?: string; // event.systemPrompt 原文，仅用于 docs 抽取
	lastRendered?: string;
	readTemplate: (name: string) => string | undefined;
};

/* ---------------- 名字与 front-matter ---------------- */

/** Subcommand words that cannot be persona names — a `golden.md` would be unreachable. */
export const RESERVED = ["off", "dirs", "prompt", "status", "golden"] as const;

export const isReserved = (name: string): boolean => (RESERVED as readonly string[]).includes(name.toLowerCase());

export function normalizeName(raw: unknown): string {
	let n = String(raw ?? "").trim();
	if (n.toLowerCase().endsWith(".md")) n = n.slice(0, -3);
	return n;
}

export const isOff = (name: string): boolean => name.trim().toLowerCase() === "off";

export function assertSafeName(name: string): void {
	if (!name) throw new PersonaError("empty persona name");
	if (name.length > 64) throw new PersonaError(`persona name too long: ${name}`);
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(name)) throw new PersonaError(`control char in name: ${JSON.stringify(name)}`);
	if (name.includes("..")) throw new PersonaError(`path traversal in name: ${name}`);
	if (/[/\\:]/.test(name)) throw new PersonaError(`path separator in name: ${name}`);
	if (name.startsWith(".") || name.endsWith(".")) throw new PersonaError(`dot-edged name: ${name}`);
	if (isReserved(name)) {
		throw new PersonaError(`reserved name: ${name}`);
	}
}

/* ---------------- front-matter：自带 YAML 子集，不依赖 `yaml` 包 ----------------
 *
 * 人设 front-matter 只需要很少的 YAML。自己解析是为了让 core 保持零运行时依赖：
 * `yaml` 是 pi 的传递依赖，包外用户 `pi install git:` 之后不跑 `npm install` 就会
 * 解析不到它，整个扩展加载失败。
 *
 * 支持：注释、裸/单引号/双引号标量（双引号内 `\n` `\t` `\r` `\\` `\"`）、流程数组
 * `[a, b]`、块数组 `- a`、任意层嵌套映射、块标量 `|` / `>`（可带 `-`）。
 * 其它 YAML（锚点、流式映射、多文档、复杂键、`...` 结束标记）**故意不支持**：解析不了
 * 就抛 PersonaError 并带上行号，让人设作者看到明确报错，而不是静默拿到错的 meta。
 * 块标量按行拼接并去掉尾部空行（jinja 渲染本来也会 trim）。
 */

const UNSUPPORTED_START = /[&*!?%@`|>{}]/;

function unquoteScalar(raw: string, where: string): string {
	const q = raw[0];
	if ((q !== '"' && q !== "'") || raw.length < 2 || raw.at(-1) !== q) {
		throw new PersonaError(`front-matter ${where}: unbalanced quotes in ${JSON.stringify(raw)}`);
	}
	const inner = raw.slice(1, -1);
	if (q === "'") return inner.replace(/''/g, "'");
	return inner.replace(/\\(n|t|r|\\|")/g, (_m, c: string) =>
		c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c);
}

function parseScalar(raw: string, where: string): unknown {
	if (raw === "" || raw === "~" || raw === "null" || raw === "Null" || raw === "NULL") return null;
	if (raw === "true" || raw === "True") return true;
	if (raw === "false" || raw === "False") return false;
	if (raw[0] === '"' || raw[0] === "'") return unquoteScalar(raw, where);
	if (raw.startsWith("[")) {
		if (!raw.endsWith("]")) throw new PersonaError(`front-matter ${where}: unterminated flow list`);
		const inner = raw.slice(1, -1).trim();
		if (!inner) return [];
		const parts: string[] = [];
		let depth = 0;
		let q: string | null = null;
		let cur = "";
		for (const c of inner) {
			if (q) { cur += c; if (c === q) q = null; continue; }
			if (c === '"' || c === "'") { q = c; cur += c; continue; }
			if (c === "[") depth++;
			if (c === "]") depth--;
			if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
			cur += c;
		}
		if (q) throw new PersonaError(`front-matter ${where}: unbalanced quotes in flow list`);
		parts.push(cur);
		const items = parts.map((p) => p.trim());
		while (items.length && items.at(-1) === "") items.pop();
		return items.map((p) => parseScalar(p, where));
	}
	if (UNSUPPORTED_START.test(raw)) {
		throw new PersonaError(`front-matter ${where}: unsupported YAML in ${JSON.stringify(raw)}`);
	}
	return raw;
}

/** 去掉行尾注释；引号内的 `#` 不算注释。 */
function stripComment(line: string): string {
	let out = "";
	let q: string | null = null;
	for (let k = 0; k < line.length; k++) {
		const c = line[k]!;
		if (q) { out += c; if (c === q) q = null; continue; }
		if (c === '"' || c === "'") { q = c; out += c; continue; }
		if (c === "#" && (k === 0 || /\s/.test(line[k - 1]!))) break;
		out += c;
	}
	return out.replace(/\s+$/, "");
}

const indentOf = (line: string): number => {
	const ws = /^[ \t]*/.exec(line)![0];
	if (ws.includes("\t")) throw new PersonaError("front-matter uses tabs for indentation");
	return ws.length;
};

/** 行内容：去掉缩进和行尾注释。 */
const content = (line: string): string => stripComment(line).replace(/^ +/, "");

function foldBlock(header: string, body: string[]): string {
	const lines = [...body];
	while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
	while (lines.length && lines[0]!.trim() === "") lines.shift();
	if (header.startsWith(">")) {
		let out = "";
		for (const l of lines) {
			if (l.trim() === "") out += "\n";
			else out += out === "" || out.endsWith("\n") ? l.trim() : ` ${l.trim()}`;
		}
		return out;
	}
	return lines.join("\n");
}

/** 解析 front-matter 正文（不含 `---` 围栏），返回映射。 */
export function parseMeta(src: string): Record<string, unknown> {
	const lines = src.split("\n");
	let i = 0;
	const where = () => `line ${Math.min(i, lines.length) + 1}`;
	const skipBlank = (): number => {
		let k = i;
		while (k < lines.length && (/^\s*$/.test(lines[k]!) || stripComment(lines[k]!) === "")) k++;
		return k;
	};

	const parseNode = (minIndent: number): unknown => {
		const k = skipBlank();
		if (k >= lines.length) { i = lines.length; return null; }
		if (indentOf(lines[k]!) < minIndent) return null;
		return /^-(\s|$)/.test(content(lines[k]!)) ? parseSeq(indentOf(lines[k]!)) : parseMap(indentOf(lines[k]!));
	};

	const readBlockScalar = (header: string, parentIndent: number): string => {
		const raw: string[] = [];
		let k = i;
		while (k < lines.length && (/^\s*$/.test(lines[k]!) || indentOf(lines[k]!) > parentIndent)) {
			raw.push(lines[k]!);
			k++;
		}
		i = k;
		// 块标量的内容缩进 = 首个非空行的缩进（YAML 规则），不是 parentIndent + 1。
		const first = raw.find((l) => l.trim() !== "");
		const base = first === undefined ? 0 : indentOf(first);
		return foldBlock(header, raw.map((l) => (l.trim() === "" ? "" : l.slice(base))));
	};

	const parseSeq = (indent: number): unknown[] => {
		const out: unknown[] = [];
		for (;;) {
			const k = skipBlank();
			if (k >= lines.length || indentOf(lines[k]!) !== indent) break;
			const text = content(lines[k]!);
			if (!/^-(\s|$)/.test(text)) break;
			const rest = text.replace(/^-(\s+|$)/, "").trim();
			if (/^[^:\s]+\s*:(\s|$)/.test(rest)) {
				throw new PersonaError(`front-matter line ${k + 1}: a mapping inside a list is not supported`);
			}
			i = k + 1;
			out.push(rest ? parseScalar(rest, where()) : parseNode(indent + 1));
		}
		return out;
	};

	const parseMap = (indent: number): Record<string, unknown> => {
		const out: Record<string, unknown> = {};
		for (;;) {
			const k = skipBlank();
			if (k >= lines.length || indentOf(lines[k]!) !== indent) break;
			const text = content(lines[k]!);
			if (/^-(\s|$)/.test(text)) break;
			const m = /^("[^"]*"|'[^']*'|[^:\s]+)\s*:(?:\s+([^\s].*)?)?$/.exec(text);
			if (!m) throw new PersonaError(`front-matter line ${k + 1}: cannot parse ${JSON.stringify(text)}`);
			const rawKey = m[1]!;
			const key = rawKey[0] === "\"" || rawKey[0] === "'" ? unquoteScalar(rawKey, where()) : rawKey;
			const rest = (m[2] ?? "").trim();
			i = k + 1;
			if (/^[|>][-+]?[-+]?$/.test(rest)) { out[key] = readBlockScalar(rest, indent); continue; }
			out[key] = rest === "" ? parseNode(indent + 1) : parseScalar(rest, where());
		}
		return out;
	};

	const root = parseNode(0);
	if (root === null) return {};
	if (Array.isArray(root) || typeof root !== "object") {
		throw new PersonaError(`front-matter must be a mapping, got ${Array.isArray(root) ? "a list" : typeof root}`);
	}
	return root as Record<string, unknown>;
}

/** 与 pi 的 parseFrontmatter 边界一致：无 front-matter（含未闭合）时 meta 为 {}、正文原样。 */
export function parsePersona(raw: string): { meta: PersonaMeta; body: string } {
	const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!text.startsWith("---")) return { meta: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { meta: {}, body: text };
	const meta = parseMeta(text.slice(4, end)) as PersonaMeta;
	const body = text.slice(end + 4).trim();
	checkMeta(meta);
	return { meta, body };
}

/**
 * `mode` / `on_error` 只接受有限值。写错（`on_error: abort`、`mode: section`）必须报错，
 * 不能静默当成默认值——静默会让扩展看起来没生效。
 */
function checkMeta(meta: PersonaMeta): void {
	const mode = meta.mode;
	if (mode !== undefined && mode !== "sections" && mode !== "bare" && mode !== "force") {
		throw new PersonaError(`front-matter mode must be sections | bare | force, got ${JSON.stringify(mode)}`);
	}
	const onError = meta.on_error;
	if (onError !== undefined && onError !== "last" && onError !== "native") {
		throw new PersonaError(
			`front-matter on_error must be last | native, got ${JSON.stringify(onError)}`
			+ " (abort is impossible: before_agent_start cannot cancel a run)",
		);
	}
	if (meta.sections !== null && meta.sections !== undefined
		&& (typeof meta.sections !== "object" || Array.isArray(meta.sections))) {
		throw new PersonaError("front-matter sections must be a mapping");
	}
}

/* ---------------- pi 原生段：结构化渲染 ---------------- */

const declared = (f: PromptFacts, names = f.toolNames): string[] =>
	names.filter((n) => !f.hiddenTools.includes(n));

export function renderTools(f: PromptFacts, names = f.toolNames): string {
	const vis = declared(f, names).filter((n) => !!f.toolSnippets[n]);
	const body = vis.length ? vis.map((n) => `- ${n}: ${f.toolSnippets[n]}`).join("\n") : "(none)";
	return `${body}\n\nAdditional tools may be available.`;
}

export function renderRules(f: PromptFacts, names = f.toolNames): string {
	const d = declared(f, names);
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (r: string) => {
		const t = r.trim();
		if (t && !seen.has(t)) { seen.add(t); out.push(t); }
	};
	const bash = d.includes("bash");
	const ps = d.includes("powershell");
	const search = d.includes("grep") || d.includes("find") || d.includes("ls");
	if ((bash || ps) && !search) {
		add(bash && ps
			? "Use bash or PowerShell for file operations like listing, searching, and finding files"
			: ps
				? "Use PowerShell for file operations like listing, searching, and finding files"
				: "Use bash for file operations like ls, rg, find");
	}
	for (const n of d) for (const r of f.toolGuidelines[n] ?? []) add(r);
	for (const r of f.promptGuidelines) add(r);
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");
	return out.map((r) => `- ${r}`).join("\n");
}

/** 手抄兜底；docs 以抽取为准，见 decidePersona。 */
export function renderDocs(p: PromptFacts["docsPaths"]): string {
	return `Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${p.readme}
- Additional docs: ${p.docs}
- Examples: ${p.examples} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.`;
}

export function renderProjectContext(files: PromptFacts["contextFiles"]): string {
	if (!files.length) return "";
	return [
		"Project-specific instructions and guidelines:",
		...files.map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`),
	].join("\n\n");
}

/* ---------------- 导出：逐字内容 + 注释（注释永远不会上线） ---------------- */

/** 一次 run 里真的声明给模型的工具：名字 + 描述 + 参数 schema。 */
export type DeclaredTool = {
	name: string;
	description: string;
	parameters?: unknown;
};

/** JSON Schema 对象的一行摘要：`path*: string, tags: string[]`。抽不出来的时候必须说破。 */
export function summarizeParameters(schema: unknown): string {
	if (schema === undefined || schema === null) return "(no parameters)";
	if (typeof schema !== "object" || Array.isArray(schema)) return "(not an object schema)";
	const s = schema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
	if (s.type !== undefined && s.type !== "object") return "(not an object schema)";
	if (!s.properties || !Object.keys(s.properties).length) return "(no parameters)";
	const required = new Set(s.required ?? []);
	return Object.entries(s.properties)
		.map(([name, prop]) => {
			const p = (typeof prop === "object" && prop !== null ? prop : {}) as
				{ type?: string; enum?: unknown[]; items?: { type?: string } };
			let type = p.type ?? "any";
			if (p.enum?.length) type = p.enum.map((v) => JSON.stringify(v)).join(" | ");
			else if (type === "array") type = `${p.items?.type ?? "any"}[]`;
			return `${name}${required.has(name) ? "*" : ""}: ${type}`;
		})
		.join(", ");
}

/** 从 provider payload 里抽出的 system 文本：抽到哪一段、抽不到为什么。 */
export type ProviderSystem = {
	text: string;
	source?: string;
	note?: string;
	model?: string;
	/** 这份捕获不在 agent run 里（compaction / 摘要走同一个 hook）——写出来不冒充。 */
	caveat?: string;
};

/** Text of a string / block array / `{parts}` / `{content}` shape, blocks joined by a blank line. */
function textOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const parts = value.map(textOf).filter((t): t is string => t !== undefined && t.length > 0);
		return parts.join("\n\n");
	}
	if (value && typeof value === "object") {
		const o = value as { text?: unknown; content?: unknown; parts?: unknown };
		if (typeof o.text === "string") return o.text;
		if (o.parts !== undefined) return textOf(o.parts);
		if (o.content !== undefined) return textOf(o.content);
	}
	return undefined;
}

/**
 * 从 `before_provider_request` 的 payload 里取“模型真的被告知的 system 文本”。
 *
 * 这一段是 provider 侧的，不是 pi 会话侧的：Anthropic 把 system 发成 `system: [{type:"text"}]`（OAuth 下
 * 前面还会硬插一条 Claude Code 身份段），OpenAI chat 发成一条 system/developer 角本消息，
 * Responses/Codex 用 `instructions`，Google 用 `systemInstruction`。抽不到就报告抽不到，不猜。
 */
export function extractProviderSystem(payload: unknown): Omit<ProviderSystem, "model"> {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return { text: "", note: "unrecognized payload shape (not an object)" };
	}
	const p = payload as Record<string, unknown>;
	if (p.system !== undefined) {
		const text = textOf(p.system);
		if (text) return { text, source: Array.isArray(p.system) ? "system blocks" : "system" };
	}
	if (typeof p.instructions === "string" && p.instructions.length) return { text: p.instructions, source: "instructions" };
	if (p.systemInstruction !== undefined) {
		const text = textOf(p.systemInstruction);
		if (text) return { text, source: "systemInstruction" };
	}
	if (Array.isArray(p.messages)) {
		const roles = new Set(["system", "developer", "instruction"]);
		const parts = (p.messages as unknown[])
			.filter((m) => m && typeof m === "object" && roles.has(String((m as { role?: unknown }).role)))
			.map((m) => textOf((m as { content?: unknown }).content))
			.filter((t): t is string => t !== undefined && t.length > 0);
		if (parts.length) return { text: parts.join("\n\n"), source: "system-role messages" };
	}
	return { text: "", note: `unrecognized payload shape (keys: ${Object.keys(p).join(", ")})` };
}

/** 从 payload 里拿到的工具定义：原封不动的数组，或者“拿不到”的说明。 */
export type ProviderTools = { tools?: unknown[]; source?: string; note?: string };

/**
 * 工具声明不做任何加工：payload 里长什么样就出去什么样（Anthropic 是
 * `{name, description, input_schema}`，OpenAI chat 是 `{type:"function", function:{…}}`，
 * Google 是 `{functionDeclarations:[…]}`），因为逐字导出才能说“这就是上线的那份”。
 */
export function extractProviderTools(payload: unknown): ProviderTools {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return { note: "unrecognized payload shape (not an object)" };
	}
	const tools = (payload as Record<string, unknown>).tools;
	if (Array.isArray(tools) && tools.length) return { tools: tools as unknown[], source: "payload tools" };
	return { note: "no tool definitions in the payload" };
}

/**
 * 注释文件：所有“不是上线内容”的东西都住在这里。
 *
 * 导出的逐字内容（system 文本 / 工具定义）另存文件，文件里不夹 banner、不夹说明；
 * 这个文件只说：哪几个文件是逐字的、这次是哪个 run / 人设 / 模式、有没有回退、
 * provider 侧捕获到了什么。工具参数在这里只是摘要（schema 摘要不是 schema），
 * 逐字的定义在 `tools-as-sent.json`。
 */
export function renderPromptNotes(input: {
	at: string;
	persona: string;
	mode: Mode;
	fallback?: string;
	declared: DeclaredTool[];
	undeclared: string[];
	provider: ProviderSystem;
	toolsCapture: ProviderTools;
}): string {
	const lines: string[] = [
		"persona prompt notes: nothing in this file is sent to the model",
		"",
		`written: ${input.at}`,
		`snapshot of: the last agent run of this session (persona: ${input.persona}, mode: ${input.mode})`,
	];
	if (input.fallback) lines.push(`exported text is a FALLBACK: ${input.fallback}`);
	lines.push(
		"",
		"verbatim files, byte-exact (no banners, no commentary inside them):",
		"  system-prompt.txt          the system text pi rendered for that run",
		"  system-prompt-as-sent.txt  the system text the provider was given",
		"  tools-as-sent.json         the tool definitions the provider was given",
		"",
	);
	lines.push(input.provider.text
		? `provider system text: from ${input.provider.source ?? "the payload"}`
			+ (input.provider.model ? ` (${input.provider.model})` : "")
		: `provider system text: ${input.provider.note ?? "not captured"}`);
	if (input.provider.caveat) lines.push(`  caveat: ${input.provider.caveat}`);
	lines.push(input.toolsCapture.tools?.length
		? `tools-as-sent.json: from the ${input.toolsCapture.source ?? "payload"}`
		: `tools-as-sent.json: ${input.toolsCapture.note ?? "not written"}`);
	lines.push("");
	lines.push(input.declared.length
		? `tools declared to the model (${input.declared.length}), parameter summaries only:`
		: "tools declared to the model: (none)");
	for (const t of input.declared) lines.push(`- ${t.name}  parameters: ${summarizeParameters(t.parameters)}`);
	lines.push(input.undeclared.length
		? `registered but not declared: ${input.undeclared.join(", ")}`
		: "registered but not declared: (none)");
	lines.push("");
	return lines.join("\n");
}

/* ---------------- 段抽取（保守：行锚定 + 唯一性） ---------------- */

export function extractSection(text: string | undefined, tag: string): string | undefined {
	if (!text) return undefined;
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const lines = text.split("\n");
	const opens: number[] = [];
	const closes: number[] = [];
	lines.forEach((l, i) => {
		const t = l.trim();
		if (t === open) opens.push(i);
		if (t === close) closes.push(i);
	});
	// 出现多次或顺序不对 → 判为不可信，交给兜底，绝不猜边界
	if (opens.length !== 1 || closes.length !== 1 || closes[0] <= opens[0]) return undefined;
	return lines.slice(opens[0] + 1, closes[0]).join("\n").trim();
}

/* ---------------- 渲染 ---------------- */

const jinja = (tpl: string, data: Record<string, unknown>): string => {
	try {
		return String(new HFTemplate(tpl).render(data)).trim();
	} catch (e) {
		throw new PersonaError(`template error: ${(e as Error).message}`);
	}
};

function makeInclude(
	readTemplate: (n: string) => string | undefined,
	data: Record<string, unknown>,
	stack: string[],
) {
	return (name: string, extra?: Record<string, unknown>): string => {
		const key = normalizeName(name);
		if (isReserved(key)) {
			throw new PersonaError(`include of reserved name: ${key}`);
		}
		assertSafeName(key);
		if (stack.includes(key)) throw new PersonaError(`include cycle: ${[...stack, key].join(" -> ")}`);
		const raw = readTemplate(key);
		if (raw === undefined) throw new PersonaError(`include not found: ${key}`);
		const sub: Record<string, unknown> = { ...data, ...(extra ?? {}) };
		sub.include = makeInclude(readTemplate, sub, [...stack, key]);
		return jinja(parsePersona(raw).body, sub);
	};
}

export const DEFAULT_SECTIONS: Record<string, string> = {
	tools: "{{ tools }}",
	rules: "{{ rules }}",
	addendum: "{{ append_system }}",
	project_context: "{{ project_context }}",
	skills: "{{ skills_prompt }}",
};

export function resolveSections(
	meta: PersonaMeta,
): Record<string, string | null> {
	if (meta.sections === null) return {};
	if (meta.sections === undefined) return { ...DEFAULT_SECTIONS };
	return { ...DEFAULT_SECTIONS, ...meta.sections };
}

export const resolveMode = (meta: PersonaMeta): Mode =>
	meta.mode === "bare" || meta.mode === "force" ? "bare" : "sections";

export function resolveOnError(meta: PersonaMeta): OnError {
	return meta.on_error === "native" ? "native" : "last";
}

export function personaTools(meta: PersonaMeta): string[] | undefined {
	if (!meta.tools) return undefined;
	const list = Array.isArray(meta.tools)
		? meta.tools.map((s) => String(s).trim())
		: String(meta.tools).split(/[,\s]+/);
	const out = list.filter(Boolean);
	return out.length ? out : undefined;
}

export function decidePersona(input: DecideInput): PersonaDecision {
	const { name, raw, facts } = input;
	assertSafeName(name);
	const { meta, body } = parsePersona(raw);
	const warnings: string[] = [];

	const names = personaTools(meta) ?? facts.toolNames;
	// facts.customPrompt 只可能来自 SYSTEM.md / --system-prompt：pi 每轮对 base options 做一份归一化
	// 副本交给 handler，我们对副本的修改不会回流。所以这条只防一种情况：人设正文就是
	// `{{ system_md }}`，渲染结果恰好等于 SYSTEM.md——不防就会每轮把 system_md 变空、来回抖。
	const incoming = facts.customPrompt ?? "";
	const systemMd = incoming && incoming === input.lastRendered ? "" : incoming;

	// docs：抽取优先。pi 只在**没有 customPrompt** 时生成 <docs>（system-prompt.js），所以分三种：
	// 抽到 → 用 pi 的文案；pi 本来会生成但我们抽不到 → 手抄兜底并告警；pi 本来就不生成
	// （SYSTEM.md / --system-prompt 在场）→ 给空串，让 `{% if docs %}` 和"空段自动消失"继续成立，
	// 不要把兜底文案塞进一个 pi 自己都不会写的段。
	const extractedDocs = extractSection(input.piPromptText, "docs");
	const piRendersDocs = !facts.customPrompt;
	if (!extractedDocs && piRendersDocs) {
		warnings.push("docs section not extractable from pi prompt; using built-in fallback text");
	}
	const docs = extractedDocs ?? (piRendersDocs ? renderDocs(facts.docsPaths) : "");

	const data: Record<string, unknown> = {
		persona: name,
		cwd: facts.cwd,
		now: facts.now,
		platform: facts.platform,
		tools: renderTools(facts, names),
		rules: renderRules(facts, names),
		docs,
		// 严格版：抽不到就保留字面量，让问题可见（配合 warnings → notify）
		pi_docs: extractedDocs ?? "{{ pi_docs }}",
		// pi 1.5.2 只填 toolGuidelines，顶层 promptGuidelines 恒为空（fixture 里也是 []）。
		// 照实渲染：将来 pi 填了自动生效，今天别指望它有内容。
		project_context: renderProjectContext(facts.contextFiles),
		skills_prompt: facts.skillsPrompt,
		append_system: facts.appendSystemPrompt,
		system_md: systemMd,
		tool_names: declared(facts, names),
		tool_snippets: { ...facts.toolSnippets },
		tool_guidelines: { ...facts.toolGuidelines },
		prompt_guidelines: [...facts.promptGuidelines],
		agents: facts.contextFiles.map((f) => ({ ...f })),
		skills: facts.skills.map((s) => ({ ...s })),
	};
	if (!extractedDocs) warnings.push("pi_docs unavailable; literal placeholder kept");
	data.include = makeInclude(input.readTemplate, data, [name]);

	const text = jinja(body, data);
	const mode = resolveMode(meta);
	const sections: Record<string, string> = {};
	if (mode === "sections") {
		for (const [tag, tpl] of Object.entries(resolveSections(meta))) {
			if (!/^[a-z][a-z0-9_-]*$/.test(tag) || tag === "preamble") {
				throw new PersonaError(`invalid section name: ${tag}`);
			}
			if (!tpl) continue;
			const out = jinja(String(tpl), data);
			if (out) sections[tag] = out;
		}
	}

	const wanted = personaTools(meta);
	return mode === "bare"
		? { persona: name, mode, selectedTools: wanted, forceSystemPrompt: text, warnings }
		: { persona: name, mode, selectedTools: wanted, customPrompt: text, sections, warnings };
}

/* ---------------- 状态优先级（纯） ---------------- */

export function resolveCurrent(sources: {
	flag?: string;
	env?: string;
	sessionEntry?: string;
	stateFile?: string;
}): string | undefined {
	for (const s of [sources.flag, sources.env, sources.sessionEntry, sources.stateFile]) {
		const v = (s ?? "").trim();
		if (v) return isOff(v) ? "off" : v;
	}
	return undefined;
}
