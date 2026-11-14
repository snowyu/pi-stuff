/**
 * 纯核心：无 fs、无网络、无 pi 依赖。所有 IO 与时钟通过入参注入。
 * 接线层负责把 pi 的 options 映射成 PromptFacts，并原子地应用 PersonaDecision。
 */
import { HFTemplate } from "@isdk/template-engines";
import picomatch from "picomatch";

export class PersonaError extends Error {}

export type Mode = "sections" | "bare";
export type OnError = "last" | "native";

export type PersonaMeta = {
	mode?: Mode | "force";
	on_error?: OnError;
	tools?: string[] | string;
	/** 谁的**工具**有资格被声明：glob 匹配 pi 的 SourceInfo（见 toolKeys）。`"*"` = 不过滤。 */
	extensions?: Gate;
	/** 谁**追加的提示词**能进 prompt：glob 匹配带 kind 前缀的键（见 appendKeys / agentKeys / skillKeys / sectionKeys）。 */
	context?: Gate;
	sections?: Record<string, string | null> | null;
	description?: string;
};

/** 一个贡献者的身份，来自 pi 的 SourceInfo；`layer` 是 AGENTS.md 发现出来的层。 */
export type ToolRef = { name: string; source: string; scope: string; path: string };
export type SkillRef = { name: string; description?: string; path?: string; source: string; scope: string };
export type AgentRef = { path: string; content: string; layer?: "global" | "project" | "ancestor" };
/**
 * pi 只把**一层** APPEND_SYSTEM.md 交给扩展（项目 > 全局，另一层被跳过，见 docs/persona.md）。
 * 这两层是人设自己按 pi 的优先级重新发现的，用来让"第二层消失了"这件事可见、可显式要回。
 */
export type AppendLayers = {
	project?: { path: string; content: string };
	global?: { path: string; content: string };
};

export type PromptFacts = {
	cwd: string;
	now: string;
	platform: string;
	toolNames: string[]; // 实时 loadout
	tools: ToolRef[]; // 与 toolNames 同一批工具的归属信息（pi getAllTools() 的 sourceInfo）
	hiddenTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	skills: SkillRef[];
	/** 接线层注入 pi 的 formatSkillsForPrompt：门控砍掉技能后清单由剩下的重渲染；`names` 是**生效**的
	 * 工具集（front-matter `tools:` / `extensions:` 收窄后），reader 措辞必须按它，不能按实时 loadout。 */
	renderSkills: (skills: SkillRef[], names?: string[]) => string;
	contextFiles: AgentRef[];
	appendSystemPrompt: string;
	appendLayers: AppendLayers;
	/** handler 时刻 `options.sections` 里已有的段名——都是别的扩展注入的，人设可以砍。 */
	foreignSections: string[];
	customPrompt: string; // pi 解析出的 SYSTEM.md / --system-prompt
	docsPaths: { readme: string; docs: string; examples: string };
};

/**
 * `context:` 门控的结果，供接线层回放到 pi 的 options 上（两种模式都生效——这一层管的是
 * "别人塞进来的东西"，不是人设自己的正文）。`null` = 没门控，全部保留。
 */
export type ContextFilter = {
	/** 保留 pi 递来的 addendum 文本？ */
	append: boolean;
	/** 保留这些 contextFile 路径；null = 全保留。 */
	agents: string[] | null;
	/** 保留这些技能名；null = 全保留。 */
	skills: string[] | null;
	/** 从 `options.sections` 里删掉这些段名。 */
	dropSections: string[];
};

export type PersonaDecision = {
	persona: string;
	mode: Mode;
	selectedTools?: string[];
	customPrompt?: string;
	sections?: Record<string, string>;
	forceSystemPrompt?: string;
	filter: ContextFilter;
	/** 本次生效的门控（给 /persona status 和 prompt-notes 复述用）；undefined = 没设。 */
	gates?: { extensions?: string[]; context?: string[] };
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

/** Subcommand and modifier words that cannot be persona names — a `golden.md` would be unreachable. */
export const RESERVED = ["off", "dirs", "prompt", "status", "golden", "global"] as const;

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
	if (raw[0] === "!") {
		// 门控的否定项。裸 `!` 在 YAML 里是 tag，不能当字符串抢下来；报错要告诉人加引号。
		throw new PersonaError(`front-matter ${where}: bare ! is a YAML tag: quote it as ${JSON.stringify(raw)}`);
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
/** front-matter 认的全部名字。不在里面的键是打错了字，不是"预留字段"。 */
const META_KEYS = new Set(["mode", "on_error", "tools", "extensions", "context", "sections", "description"]);

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
	for (const key of ["extensions", "context"] as const) {
		const raw = meta[key];
		if (raw === undefined || raw === null) continue;
		try {
			parseGate(raw);
		} catch (e) {
			throw new PersonaError(`front-matter ${key}: ${(e as Error).message.replace(/^front-matter /, "")}`);
		}
	}
	for (const key of Object.keys(meta)) {
		if (META_KEYS.has(key)) continue;
		const hint = key === "deny" || key === "allow"
			? ' - there is no deny:/allow: field; write the exclusion in the same list with "!"'
			: ` (known keys: ${[...META_KEYS].join(", ")})`;
		throw new PersonaError(`unknown front-matter key ${JSON.stringify(key)}${hint}`);
	}
}

/* ---------------- 门控：front-matter 的 extensions: / context: ----------------
 *
 * pi 给每个工具、技能、命令都带了 SourceInfo（`{path, source, scope, origin}`），所以"谁的工
 * 具"是能问出来的；**追加的提示词问不出来**（`options.appendSystemPrompt` 是一个 join 后的字
 * 符串，pi 不记作者），所以 `context:` 只能按可归属的单位门控：addendum 这一层、AGENTS.md 的路径
 * 与层、技能的来源、别的扩展注入的段名。每种贡献都会展开成一组候选键（`*Keys()`），pattern 命中
 * 任意一个即算命中。
 *
 * `!` 前缀是否定。**这个否定是我们实现的，不是 picomatch 的**：picomatch 4 把数组当纯 OR，
 * `!x` 单独编译成"除 x 外的一切"，`["a", "!b"]` 里后面的否定根本不生效（实测）。所以 front-matter
 * 里不需要 deny:，但语义得自己写对：allow 全不中 → 出局；命中任一 deny → 出局；allow 为空（全是
 * 否定）→ 其余都要。
 *
 * 单个 pattern 写 `"*"` 表示**全部**（不是 glob 的单层——source 里带 `/`，真 glob 会匹配不上）。
 * 整个门控写 `"*"` 或 `["*"]` 表示不过滤，跟没写一样。
 */

export type Gate = string | string[];
export type GateSpec = { allow: string[]; deny: string[]; patterns: string[]; empty: boolean };
export type GateHit = { ok: boolean; allow?: string; deny?: string };

export function parseGate(raw: Gate | undefined): GateSpec | undefined {
	if (raw === undefined || raw === null) return undefined;
	const list = (Array.isArray(raw) ? raw : [raw]).map((s) => {
		if (typeof s !== "string") {
			throw new PersonaError(`must be "*" or a list of glob patterns, got ${JSON.stringify(s)}`);
		}
		return s.trim();
	});
	const patterns = list.filter(Boolean);
	// `[]`、`[""]` 都是"显式全关"，不是"没写"：不特判就会落进"全是否定 → 其余都要"那条分支。
	if (patterns.length === 0) return { allow: [], deny: [], patterns: [], empty: true };
	if (patterns.length === 1 && patterns[0] === "*") return undefined;
	const allow: string[] = [];
	const deny: string[] = [];
	for (const p of patterns) {
		if (p[0] !== "!") { allow.push(p); continue; }
		const bare = p.slice(1).trim();
		if (!bare) throw new PersonaError(`gate pattern is empty: ${JSON.stringify(p)}`);
		deny.push(bare);
	}
	return { allow, deny, patterns, empty: false };
}

export function compileGate(spec: GateSpec, platform: string): (cands: string[]) => GateHit {
	const opts = { dot: true, windows: platform === "win32", nocase: platform === "win32" };
	const build = (pats: string[]) => pats.map((p) => {
		try {
			// `*` 是"全部"，不是 glob 的单层：source/scope 串里带 `/`，真 glob 会漏掉整包来源。
			const m: (s: string) => boolean = p === "*" ? () => true : picomatch(p, opts);
			return { p, m };
		} catch (e) {
			throw new PersonaError(`glob error in ${JSON.stringify(p)}: ${(e as Error).message}`);
		}
	});
	const allowPats = build(spec.allow);
	const denyPats = build(spec.deny);
	return (cands) => {
		if (spec.empty) return { ok: false };
		// allow 和 deny 都先算完再定性：只靠 deny 短路的话，被 deny 抢掉的那条 allow 会被当成
		// "没命中过"，白告一个打错字的警。
		let deny: string | undefined;
		for (const { p, m } of denyPats) if (cands.some((c) => m(c))) { deny = p; break; }
		let allow: string | undefined;
		for (const { p, m } of allowPats) if (cands.some((c) => m(c))) { allow = p; break; }
		const ok = deny === undefined && (allowPats.length === 0 || allow !== undefined);
		return { ok, allow, deny };
	};
}

/** 每个 pattern 有没有真的命中过东西——没命中的要报出来，否则打错字就是静默失效。 */
export function unusedPatterns(spec: GateSpec, hits: GateHit[]): string[] {
	const used = new Set<string>();
	for (const h of hits) {
		if (h.allow) used.add(h.allow);
		if (h.deny) used.add(`!${h.deny}`);
	}
	return spec.patterns.filter((p) => !used.has(p));
}

/* 候选键：一个贡献者可以被哪些写法命中。顺序稳定，测试直接断言。 */
export const toolKeys = (t: ToolRef): string[] => [t.source, `${t.source}:${t.scope}`, t.path];
export const agentKeys = (f: AgentRef): string[] => [`agents:${f.path}`, f.path, ...(f.layer ? [`agents:${f.layer}`] : [])];
export const skillKeys = (s: SkillRef): string[] => [`skill:${s.source}`, `skill:${s.source}:${s.scope}`, `skill:${s.name}`, s.path ?? ""];
export const sectionKeys = (tag: string): string[] => [`section:${tag}`, tag];
export const appendLayerKeys = (scope: "project" | "global", path?: string): string[] => [`append:${scope}`, path ?? ""];

/**
 * pi 递来的那一份 addendum 是从哪一层来的：等于人设发现的项目层 / 全局层就点名那层，
 * 都对不上就说 `append:other`（`--append-system-prompt` 或别的扩展改的），不猜。
 */
export function appendKeys(text: string, layers: AppendLayers): string[] {
	if (!text) return ["append:pi", "append:empty"];
	const keys = ["append:pi"];
	if (layers.project && text.includes(layers.project.content)) keys.push("append:project");
	if (layers.global && text.includes(layers.global.content)) keys.push("append:global");
	if (keys.length === 1) keys.push("append:other");
	return keys;
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

export function renderProjectContext(files: AgentRef[]): string {
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
	gates?: { extensions?: string[]; context?: string[] };
}): string {
	const lines: string[] = [
		"persona prompt notes: nothing in this file is sent to the model",
		"",
		`written: ${input.at}`,
		`snapshot of: the last agent run of this session (persona: ${input.persona}, mode: ${input.mode})`,
	];
	if (input.fallback) lines.push(`exported text is a FALLBACK: ${input.fallback}`);
	if (input.gates?.extensions?.length || input.gates?.context?.length) {
		const shown = (v?: string[]) => (v && v.length ? JSON.stringify(v) : "*");
		lines.push(`gates: extensions=${shown(input.gates.extensions)} context=${shown(input.gates.context)} (unlisted = allowed)`);
	}
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
	if (meta.tools === undefined || meta.tools === null) return undefined;
	// YAML 里 `tools:` 后面什么都没有就是 null，已上面的早退当"没写"处理。
	if (typeof meta.tools === "string" && meta.tools.trim() === "") return undefined;
	const list = Array.isArray(meta.tools)
		? meta.tools.map((s) => String(s).trim())
		: String(meta.tools).split(/[,\s]+/);
	const out = list.filter(Boolean);
	// `"*"` = 全部（不写 selectedTools，跟实时 loadout）；`[]` = 显式全关。两边语义与
	// extensions: / context: 一致，否则"忘写"和"不要工具"就分不开。
	if (out.length === 1 && out[0] === "*") return undefined;
	return out;
}

export function decidePersona(input: DecideInput): PersonaDecision {
	const { name, raw, facts } = input;
	assertSafeName(name);
	const { meta, body } = parsePersona(raw);
	const warnings: string[] = [];

	/* ---- front-matter 门控：extensions:（谁的工具有资格）---- */
	const extSpec = parseGate(meta.extensions);
	const ctxSpec = parseGate(meta.context);
	const extHits: GateHit[] = [];
	let allowedNames: string[] | undefined;
	if (extSpec) {
		const match = compileGate(extSpec, facts.platform);
		const attributed = new Map(facts.tools.map((t) => [t.name, t]));
		const kept: string[] = [];
		for (const n of facts.toolNames) {
			const ref = attributed.get(n) ?? { name: n, source: "unknown", scope: "unknown", path: n };
			if (!attributed.has(n)) {
				warnings.push(`no source info for tool ${n}; extensions: treats it as source "unknown"`);
			}
			const hit = match(toolKeys(ref));
			extHits.push(hit);
			if (hit.ok) kept.push(n);
		}
		if (extSpec.empty) warnings.push('extensions: gate is an empty pattern list, so nothing matches; use "*" for no filter');
		for (const p of unusedPatterns(extSpec, extHits)) {
			warnings.push(`extensions: pattern matched nothing: ${JSON.stringify(p)}`);
		}
		allowedNames = kept;
	}

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

	/* ---- front-matter 门控：context:（谁追加的提示词能进来）---- */
	const filter: ContextFilter = { append: true, agents: null, skills: null, dropSections: [] };
	let appendSystem = facts.appendSystemPrompt;
	let appendProject = facts.appendLayers.project?.content ?? "";
	let appendGlobal = facts.appendLayers.global?.content ?? "";
	let agentFiles = facts.contextFiles;
	let skills = facts.skills;
	if (ctxSpec) {
		const match = compileGate(ctxSpec, facts.platform);
		const ctxHits: GateHit[] = [];
		const hit = (cands: string[]): boolean => {
			const h = match(cands);
			ctxHits.push(h);
			return h.ok;
		};
		filter.append = hit(appendKeys(facts.appendSystemPrompt, facts.appendLayers));
		if (!filter.append) appendSystem = "";
		if (!hit(appendLayerKeys("project", facts.appendLayers.project?.path))) appendProject = "";
		if (!hit(appendLayerKeys("global", facts.appendLayers.global?.path))) appendGlobal = "";
		agentFiles = facts.contextFiles.filter((f) => hit(agentKeys(f)));
		filter.agents = agentFiles.map((f) => f.path);
		skills = facts.skills.filter((s) => hit(skillKeys(s)));
		filter.skills = skills.map((s) => s.name);
		filter.dropSections = facts.foreignSections.filter((tag) => !hit(sectionKeys(tag)));
		if (ctxSpec.empty) warnings.push('context: gate is an empty pattern list, so nothing matches; use "*" for no filter');
		for (const p of unusedPatterns(ctxSpec, ctxHits)) {
			warnings.push(`context: pattern matched nothing: ${JSON.stringify(p)}`);
		}
	}

	// tools: 和 extensions: 同时在场就是交集：门控砍掉的名字必须说破，否则人设作者只会看到工具少了。
	const wanted = personaTools(meta);
	let names = wanted ?? allowedNames ?? facts.toolNames;
	if (wanted && allowedNames) {
		const allowedSet = new Set(allowedNames);
		const dropped = wanted.filter((n) => !allowedSet.has(n));
		if (dropped.length) warnings.push(`tools: ${dropped.join(", ")} is not allowed by extensions:`);
		names = wanted.filter((n) => allowedSet.has(n));
	}
	const selectedTools = wanted ? names : allowedNames;

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
		project_context: renderProjectContext(agentFiles),
		skills_prompt: facts.renderSkills(skills, names),
		append_system: appendSystem,
		append_project: appendProject,
		append_global: appendGlobal,
		system_md: systemMd,
		tool_names: declared(facts, names),
		tool_snippets: { ...facts.toolSnippets },
		tool_guidelines: { ...facts.toolGuidelines },
		prompt_guidelines: [...facts.promptGuidelines],
		agents: agentFiles.map((f) => ({ ...f })),
		skills: skills.map((s) => ({ ...s })),
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

	const gates = extSpec || ctxSpec
		? { extensions: extSpec?.patterns, context: ctxSpec?.patterns }
		: undefined;
	return mode === "bare"
		? { persona: name, mode, selectedTools, forceSystemPrompt: text, filter, gates, warnings }
		: { persona: name, mode, selectedTools, customPrompt: text, sections, filter, gates, warnings };
}

/* ---------------- 状态优先级（纯） ---------------- */

/** 记在哪个 `personas/current` 里：项目级（默认）还是全局级（`global` 修饰词）。 */
export type StateScope = "project" | "global";

/**
 * `/persona` 的参数解析：`new` 与 `global` 是**修饰词**，不当人设名。
 *
 * 默认只记录到项目（`<cwd>/.pi/personas/current`）；要写全局得显式写 `global`。
 * 修饰词位置自由（`/persona pirate global new` 与 `/persona new global pirate` 同义）。
 * `global` 同时在 `RESERVED` 里：叫这个名字的人设文件无论如何都选不到，说破比静默难寻好。
 */
export function parseArgs(tokens: readonly string[]): {
	name: string | undefined;
	wantNew: boolean;
	scope: StateScope;
} {
	let wantNew = false;
	let scope: StateScope = "project";
	const rest: string[] = [];
	for (const t of tokens) {
		const low = t.toLowerCase();
		if (low === "new") { wantNew = true; continue; }
		if (low === "global") { scope = "global"; continue; }
		rest.push(t);
	}
	const name = normalizeName(rest[0]);
	return { name: name || undefined, wantNew, scope };
}

export function resolveCurrent(sources: {
	flag?: string;
	env?: string;
	sessionEntry?: string;
	/** `<cwd>/.pi/personas/current` —— `/persona <name>` 默认写这里，所以它压过全局。 */
	projectState?: string;
	/** `~/.pi/agent/personas/current` —— 只有 `/persona <name> global` 写这里。 */
	globalState?: string;
}): string | undefined {
	for (const s of [sources.flag, sources.env, sources.sessionEntry, sources.projectState, sources.globalState]) {
		const v = (s ?? "").trim();
		if (v) return isOff(v) ? "off" : v;
	}
	return undefined;
}
