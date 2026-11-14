/**
 * Tier 1: persona's pure core (`extensions/persona/core.ts`) — names, front-matter, section
 * resolution, structured rendering, extraction and precedence.
 *
 * Deliberately imports nothing from pi: the DTO in `PromptFacts` is ours, so this file runs with
 * zero pi installed. Drift against pi's own rendering is a separate concern — see
 * test/persona.golden.test.ts (recorded capture) and test/real/persona.drift.real.test.ts (live pi).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, test } from "node:test";

import {
	assertSafeName,
	decidePersona,
	extractSection,
	normalizeName,
	parseArgs,
	parseMeta,
	parsePersona,
	renderDocs,
	renderRules,
	renderTools,
	resolveCurrent,
	resolveMode,
	resolveOnError,
	resolveSections,
	isOff,
	isReserved,
	personaTools,
	type PromptFacts,
	extractProviderSystem,
	extractProviderTools,
	renderPromptNotes,
	summarizeParameters,
	parseGate,
	compileGate,
	appendKeys,
	appendLayerKeys,
	agentKeys,
	skillKeys,
	toolKeys,
	sectionKeys,
	type GateSpec,
	type ToolRef,
} from "../extensions/persona/core.ts";

const F: PromptFacts = {
	cwd: "/proj",
	now: "2026-01-01T00:00:00.000Z",
	platform: "linux",
	toolNames: ["read", "bash"],
	hiddenTools: [],
	toolSnippets: { read: "Read files", bash: "Run commands" },
	toolGuidelines: { read: ["Use read instead of cat."] },
	promptGuidelines: ["Custom rule."],
	skills: [],
	renderSkills: () => "",
	contextFiles: [],
	appendSystemPrompt: "",
	appendLayers: {},
	foreignSections: [],
	customPrompt: "",
	docsPaths: { readme: "/R.md", docs: "/docs", examples: "/ex" },
	tools: [
		{ name: "read", source: "builtin", scope: "user", path: "builtin:read" },
		{ name: "bash", source: "builtin", scope: "user", path: "builtin:bash" },
	],
};

const run = (raw: string, over: Partial<Parameters<typeof decidePersona>[0]> = {}) =>
	decidePersona({ name: "p", raw, facts: F, readTemplate: () => undefined, ...over });

describe("names", () => {
	test("normalizes: trims, strips a .md suffix, keeps case", () => {
		assert.equal(normalizeName(" Pirate.md "), "Pirate");
		assert.equal(normalizeName("pirate.md.md"), "pirate.md");
		assert.equal(normalizeName(undefined), "");
	});
	test("rejects traversal, separators, control chars, dots, length, reserved", () => {
		for (const bad of ["../x", "a/b", "a\\b", "C:x", ".hidden", "trailing.", "", "a\u0000b", "x".repeat(65)]) {
			assert.throws(() => assertSafeName(bad), `expected ${JSON.stringify(bad)} to be rejected`);
		}
	});
	test("reserved names are rejected case-insensitively", () => {
		for (const bad of ["off", "OFF", "Dirs", "prompt", "STATUS", "golden", "global", "Global"]) {
			assert.throws(() => assertSafeName(bad), `expected ${bad} to be rejected`);
		}
	});
	test("non-ascii names are allowed", () => {
		assert.doesNotThrow(() => assertSafeName("海盗"));
	});
	test("off is detected regardless of case and padding", () => {
		assert.ok(isOff("  OFF "));
		assert.ok(!isOff("offline"));
	});
});

describe("precedence", () => {
	test("flag > env > entry > project pin > global pin; blank means unset", () => {
		assert.equal(resolveCurrent({ flag: "a", env: "b", sessionEntry: "c", projectState: "d", globalState: "e" }), "a");
		assert.equal(resolveCurrent({ env: "  ", sessionEntry: "c" }), "c");
		assert.equal(resolveCurrent({ env: "OFF" }), "off");
		assert.equal(resolveCurrent({ flag: "", env: "", sessionEntry: "", projectState: "", globalState: "" }), undefined);
	});
	test("the project pin wins over the global pin", () => {
		assert.equal(resolveCurrent({ projectState: "proj", globalState: "glob" }), "proj",
			"/persona writes the project file by default, so it is the one that decides here");
	});
	test("with no project pin, the global pin still applies", () => {
		assert.equal(resolveCurrent({ globalState: "glob" }), "glob", "a remembered global choice is not lost");
	});
	test("a project pin of off really means off", () => {
		assert.equal(resolveCurrent({ projectState: " OFF ", globalState: "glob" }), "off");
	});
});

describe("command arguments: name, new, scope", () => {
	test("the scope defaults to the project — the issue this guards", () => {
		assert.deepEqual(parseArgs(["pirate"]), { name: "pirate", wantNew: false, scope: "project" });
	});
	test("`global` asks for the global pin, in either order", () => {
		assert.deepEqual(parseArgs(["reviewer", "global"]), { name: "reviewer", wantNew: false, scope: "global" });
		assert.deepEqual(parseArgs(["global", "reviewer"]), { name: "reviewer", wantNew: false, scope: "global" });
	});
	test("`new` and `global` are modifiers, not names, and order does not matter", () => {
		assert.deepEqual(parseArgs(["pirate", "new", "global"]), { name: "pirate", wantNew: true, scope: "global" });
		assert.deepEqual(parseArgs(["Global", "PIRATE.md", "New"]), { name: "PIRATE", wantNew: true, scope: "global" });
	});
	test("no name means the selector, and off is project-scoped by default", () => {
		assert.deepEqual(parseArgs([]), { name: undefined, wantNew: false, scope: "project" });
		assert.deepEqual(parseArgs(["off"]), { name: "off", wantNew: false, scope: "project" });
	});
	test("a lone modifier asks the selector and keeps the modifier", () => {
		assert.deepEqual(parseArgs(["global"]), { name: undefined, wantNew: false, scope: "global" });
	});
});

describe("front-matter parsing (own YAML subset, no `yaml` package)", () => {
	test("scalars, quotes and escapes", () => {
		const meta = parseMeta([
			"mode: bare",
			"description: 一句话 # 行尾注释",
			`rules: "{{ rules }}\\n- extra"`,
			"quoted: 'it''s fine'",
			"empty:",
			"tilde: ~",
		].join("\n"));
		assert.equal(meta.mode, "bare");
		assert.equal(meta.description, "一句话");
		assert.equal(meta.rules, "{{ rules }}\n- extra");
		assert.equal(meta.quoted, "it's fine");
		assert.equal(meta.empty, null);
		assert.equal(meta.tilde, null);
	});
	test("flow lists and block lists", () => {
		assert.deepEqual(parseMeta("tools: [read, bash]").tools, ["read", "bash"]);
		assert.deepEqual(parseMeta("tools: [ ]").tools, []);
		assert.deepEqual(parseMeta("tools:\n  - read\n  - bash # only these").tools, ["read", "bash"]);
	});
	test("nested mapping with null values (the sections map)", () => {
		const meta = parseMeta(["sections:", "  rules: \"{{ rules }}\"", "  docs:", "  project_context: null"].join("\n"));
		assert.deepEqual(meta.sections, { rules: "{{ rules }}", docs: null, project_context: null });
	});
	test("block scalars: literal and folded", () => {
		assert.equal(parseMeta("a: |\n  one\n  two\n\n").a, "one\ntwo");
		assert.equal(parseMeta("a: >\n  one\n  two\n").a, "one two");
	});
	test("a mapping inside a list is refused, not stringified", () => {
		assert.throws(() => parseMeta("tools:\n  - read: yes"), /mapping inside a list/);
	});
	test("unsupported YAML and tabs fail loudly instead of silently mis-parsing", () => {
		assert.throws(() => parseMeta("a: &anchor x"), /unsupported YAML/);
		assert.throws(() => parseMeta("a: {x: 1}"), /unsupported YAML/);
		assert.throws(() => parseMeta("a: [x"), /unterminated flow list/);
		assert.throws(() => parseMeta("\tmode: bare"), /tabs/);
		assert.throws(() => parseMeta("just a line"), /cannot parse/);
		assert.throws(() => parseMeta("- a"), /must be a mapping/);
	});
	test("parsePersona boundaries match pi's parseFrontmatter", () => {
		assert.deepEqual(parsePersona("plain body"), { meta: {}, body: "plain body" });
		// Unterminated front-matter: pi treats the whole file as body.
		assert.deepEqual(parsePersona("---\nmode: bare\nbody"), { meta: {}, body: "---\nmode: bare\nbody" });
		// BOM and CRLF normalized.
		assert.equal(parsePersona("\uFEFF---\r\nmode: bare\r\n---\r\nbody\r\n").meta.mode, "bare");
		assert.equal(parsePersona("---\nmode: bare\n---\n  body  ").body, "body");
	});
	test("mode and on_error are validated, not silently defaulted", () => {
		assert.equal(parsePersona("---\nmode: force\n---\nx").meta.mode, "force");
		assert.equal(resolveMode({ mode: "force" }), "bare");
		assert.equal(resolveMode({}), "sections");
		assert.throws(() => parsePersona("---\nmode: section\n---\nx").meta, /mode must be sections \| bare \| force/);
		assert.throws(
			() => parsePersona("---\non_error: abort\n---\nx").meta,
			/on_error must be last \| native.*abort is impossible/,
			"a typo about abort must say why abort is impossible",
		);
		assert.equal(resolveOnError({ on_error: "native" }), "native");
		assert.equal(resolveOnError({}), "last");
		assert.throws(() => parsePersona("---\nsections: [a]\n---\nx").meta, /sections must be a mapping/);
	});
});

describe("sections spec", () => {
	test("defaults, merge, delete, none", () => {
		assert.deepEqual(Object.keys(resolveSections({})), ["tools", "rules", "addendum", "project_context", "skills"]);
		assert.equal(resolveSections({ sections: { docs: null } }).docs, null);
		assert.ok(Object.keys(resolveSections({ sections: { docs: "{{ docs }}" } })).includes("docs"));
		assert.deepEqual(resolveSections({ sections: null }), {});
	});
	test("tools front-matter: list, comma string, blank string", () => {
		assert.deepEqual(personaTools({ tools: ["read", " bash "] }), ["read", "bash"]);
		assert.deepEqual(personaTools({ tools: "read, bash" }), ["read", "bash"]);
		assert.deepEqual(personaTools({ tools: "read bash" }), ["read", "bash"]);
		assert.equal(personaTools({}), undefined);
		assert.equal(personaTools({ tools: "  " }), undefined);
		// 空列表与门控同一个语义：显式全关，不是"当没写"。`"*"` 才是全部（跟随实时 loadout）。
		assert.deepEqual(personaTools({ tools: [] }), []);
		assert.deepEqual(personaTools(parsePersona("---\ntools: []\n---\nx\n").meta), []);
		assert.equal(personaTools({ tools: "*" }), undefined);
		assert.deepEqual(personaTools({ tools: ["", ""] }), []);
	});
});

describe("extractSection", () => {
	test("is conservative: line-anchored, unique, in order", () => {
		assert.equal(extractSection("<docs>\nA\n</docs>", "docs"), "A");
		assert.equal(extractSection("<docs>\nA\n</docs>\n<docs>\nB\n</docs>", "docs"), undefined);
		assert.equal(extractSection("<docs>\nA\n</docs>\n</docs>", "docs"), undefined);
		assert.equal(extractSection("</docs>\n<docs>\nA", "docs"), undefined);
		assert.equal(extractSection(undefined, "docs"), undefined);
		assert.equal(extractSection("  <docs>\nA\n  </docs>", "docs"), "A");
	});
});

describe("renderTools / renderRules are structured, not extracted", () => {
	test("tools: visible ones with a snippet, in loadout order, hidden dropped", () => {
		const f = { ...F, toolNames: ["read", "bash", "grep"], hiddenTools: ["grep"], toolSnippets: { ...F.toolSnippets, bash: "Run commands" } };
		assert.equal(renderTools(f), "- read: Read files\n- bash: Run commands\n\nAdditional tools may be available.");
	});
	test("tools: (none) when nothing is declarable", () => {
		assert.equal(renderTools({ ...F, toolNames: [] }), "(none)\n\nAdditional tools may be available.");
		// A tool without a snippet is not listed — pi's rule, mirrored here.
		assert.equal(renderTools({ ...F, toolNames: ["mystery"] }), "(none)\n\nAdditional tools may be available.");
	});
	test("rules: the shell-file-operations bullet has pi's three branches", () => {
		const none = { ...F, toolNames: ["read"], toolGuidelines: {}, promptGuidelines: [] };
		assert.ok(!renderRules(none).includes("file operations"));
		assert.match(renderRules({ ...none, toolNames: ["read", "bash"] }), /- Use bash for file operations like ls, rg, find/);
		assert.match(
			renderRules({ ...none, toolNames: ["read", "powershell"] }),
			/- Use PowerShell for file operations like listing, searching, and finding files/,
		);
		assert.match(
			renderRules({ ...none, toolNames: ["bash", "powershell"] }),
			/- Use bash or PowerShell for file operations like listing, searching, and finding files/,
		);
		// grep/find/ls present → the bullet is dropped; hidden tools do not count as present.
		assert.ok(!renderRules({ ...none, toolNames: ["bash", "grep"] }).includes("file operations"));
		assert.match(
			renderRules({ ...none, toolNames: ["bash", "grep"], hiddenTools: ["grep"] }),
			/Use bash for file operations/,
		);
	});
	test("rules: tool guidelines in tool order, deduped, pi's two fixed bullets last", () => {
		const out = renderRules({
			...F,
			toolNames: ["bash", "read"],
			toolGuidelines: { read: ["Use read.", "Use read."], bash: ["Use bash."] },
			promptGuidelines: ["Extra."],
		});
		assert.deepEqual(out.split("\n"), [
			"- Use bash for file operations like ls, rg, find",
			"- Use bash.",
			"- Use read.",
			"- Extra.",
			"- Be concise in your responses",
			"- Show file paths clearly when working with files",
		]);
	});
	test("docs fallback carries pi's paths", () => {
		assert.match(renderDocs(F.docsPaths), /Main documentation: \/R\.md/);
	});
});

describe("decidePersona", () => {
	test("sections is the default and clears pi's own sources", () => {
		const d = run("Be nice.");
		assert.equal(d.mode, "sections");
		assert.equal(d.customPrompt, "Be nice.");
		assert.match(d.sections!.tools, /- read: Read files/);
		assert.match(d.sections!.rules, /- Use read instead of cat\./);
	});
	test("bare and force produce a forced prompt and no sections", () => {
		const d = run("---\nmode: bare\ntools: [read]\n---\nHi {{ tools }}");
		assert.equal(d.mode, "bare");
		assert.equal(d.forceSystemPrompt, "Hi - read: Read files\n\nAdditional tools may be available.");
		assert.equal(d.selectedTools?.join(","), "read");
		assert.equal(d.sections, undefined);
	});
	test("docs prefers extraction, falls back with a warning", () => {
		const hit = run("{{ docs }}", { piPromptText: "<docs>\nPI TEXT\n</docs>" });
		assert.equal(hit.customPrompt, "PI TEXT");
		const miss = run("{{ docs }}", { piPromptText: "no sections here" });
		assert.match(miss.customPrompt!, /Pi documentation/);
		assert.match(miss.warnings.join(), /fallback/);
	});
	test("docs stays empty when pi itself renders no docs section", () => {
		// SYSTEM.md / --system-prompt make pi skip <docs>; stuffing the fallback text in there would
		// invent a section pi never had and break `{% if docs %}` / "empty section disappears".
		const d = run("<docs>\n{{ docs }}\n</docs>", {
			facts: { ...F, customPrompt: "pi configured through --system-prompt" },
			piPromptText: "<cwd>/proj</cwd>",
		});
		assert.equal(d.customPrompt, "<docs>\n\n</docs>");
		assert.ok(!d.warnings.some((w) => w.includes("fallback")), "no fallback was needed, so no warning");
	});
	test("pi_docs keeps a visible literal when unavailable", () => {
		assert.equal(run("{{ pi_docs }}").customPrompt, "{{ pi_docs }}");
		assert.match(run("{{ pi_docs }}").warnings.join(), /pi_docs unavailable/);
	});
	test("include: cycles and misses throw, so no partial decision escapes", () => {
		assert.throws(() => run("{{ include('a') }}", { readTemplate: () => "{{ include('a') }}" }), /cycle/);
		assert.throws(() => run("{{ include('nope') }}"), /not found/);
		assert.throws(() => run("{{ include('off') }}"), /reserved name/);
		assert.throws(() => run("{{ include('../x') }}"), /path traversal/);
		assert.equal(run("{{ include('_t') }}", { readTemplate: (n) => (n === "_t" ? "---\ndescription: x\n---\nfrag {{ persona }}" : undefined) }).customPrompt, "frag p");
	});
	test("does not treat its own last output as SYSTEM.md", () => {
		const d = run("{{ system_md }}|x", { facts: { ...F, customPrompt: "OLD" }, lastRendered: "OLD" });
		assert.equal(d.customPrompt, "|x");
	});
	test("section tags are validated with pi's own rule before pi can throw", () => {
		for (const tag of ["Preamble", "9x", "preamble", "工具"]) {
			const raw = `---\nsections:\n  ${tag}: y\n---\nbody`;
			assert.throws(
				() => decidePersona({ name: "p", raw, facts: F, readTemplate: () => undefined }),
				/invalid section name/,
				`${tag} must be rejected`,
			);
		}
		// A quoted key with a space parses, then the tag check rejects it; unquoted is a parse error.
		// Either way nothing reaches pi, which would throw mid-run from buildSystemPromptSections.
		assert.throws(
			() => decidePersona({ name: "p", raw: "---\nsections:\n  \"a b\": y\n---\nbody", facts: F, readTemplate: () => undefined }),
			/invalid section name/,
		);
		assert.throws(
			() => decidePersona({ name: "p", raw: "---\nsections:\n  a b: y\n---\nbody", facts: F, readTemplate: () => undefined }),
			/cannot parse/,
		);
		const ok = decidePersona({
			name: "p",
			raw: "---\nsections:\n  my_note-1: \"note {{ persona }}\"\n---\nbody",
			facts: F,
			readTemplate: () => undefined,
		});
		assert.equal(ok.sections!["my_note-1"], "note p");
	});
	test("empty rendered sections are dropped, not emitted as empty tags", () => {
		const d = run("body", {
			raw: "---\nsections:\n  note: \"{{ append_system }}\"\n---\nbody",
			facts: { ...F, appendSystemPrompt: "" },
		});
		assert.equal(d.sections!.note, undefined);
	});
});

describe("shipped personas (personas/*.md)", () => {
	const dir = new URL("../personas/", import.meta.url).pathname;
	const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	const names = files.filter((f) => !f.startsWith("_")).map((f) => basename(f, ".md")).sort();
	const readTemplate = (n: string): string | undefined => {
		try {
			return readFileSync(join(dir, n.endsWith(".md") ? n : `${n}.md`), "utf8");
		} catch {
			return undefined;
		}
	};

	/**
	 * 出厂人设跑在一份比 F 更真的事实上：多个来源的工具、两层 APPEND_SYSTEM.md、别的扩展
	 * 注入的段、vendor 里的 AGENTS.md。门控范例只有在这种事实上才能被证伪——也才会被
	 * "不能告警"这条钩住：pattern 打错字在 F 里根本看不出来。
	 */
	const SHIP_F: PromptFacts = {
		...F,
		toolNames: ["read", "bash", "ssh_run", "tickets", "deploy"],
		toolSnippets: { ...F.toolSnippets, ssh_run: "Run a command over ssh", tickets: "Read the tracker", deploy: "Deploy the app" },
		tools: [
			...F.tools,
			{ name: "ssh_run", source: "git:github.com/snowyu/pi-stuff", scope: "user", path: "/u/.pi/extensions/ssh.ts" },
			// 同一个包按本地路径安装时 source 是 local/user，不是 git：范例必须两种装法都覆盖。
			{ name: "tickets", source: "local", scope: "user", path: "/u/.pi/packages/pi-stuff/extensions/tickets.ts" },
			{ name: "deploy", source: "local", scope: "project", path: "/proj/.pi/extensions/deploy.ts" },
		],
		skills: [{ name: "pdf", description: "Read PDFs", path: "/u/.pi/skills/pdf/SKILL.md", source: "local", scope: "user" }],
		contextFiles: [
			{ path: "/proj/AGENTS.md", content: "project rules", layer: "project" },
			{ path: "/proj/vendor/deep/AGENTS.md", content: "vendored rules", layer: "project" },
		],
		appendSystemPrompt: "appended by another extension",
		appendLayers: {
			global: { path: "/u/.pi/agent/APPEND_SYSTEM.md", content: "global layer rules" },
			project: { path: "/proj/.pi/APPEND_SYSTEM.md", content: "project layer rules" },
		},
		foreignSections: ["proxy_guard"],
	};

	test("the directory is self-consistent and keeps the promises the docs make", () => {
		// 故意不枚举人设名字：出厂集合会长，新增人设不该要求改这个文件。这里钉的是契约，不是名单。
		assert.ok(names.length > 0, "personas/ holds no persona at all");
		for (const name of names) {
			assertSafeName(name);
			assert.equal(isReserved(name), false, `${name} collides with a subcommand word`);
		}
		// docs/persona.md 点名了这些片段（`_docs.md` 那段告警）和 `/persona default`。
		for (const fragment of ["_tools.md", "_rules.md", "_docs.md"]) {
			assert.ok(files.includes(fragment), `docs/persona.md references ${fragment}, but personas/ has no such file`);
		}
		const docs = readFileSync(new URL("../docs/persona.md", import.meta.url).pathname, "utf8");
		assert.ok(names.includes("default"), "docs/persona.md offers /persona default, but personas/default.md is missing");
		assert.match(docs, /\/persona default/, "personas/default.md exists but the quick list no longer offers it");
	});

	test("every fragment parses and renders standalone", () => {
		for (const file of files.filter((f) => f.startsWith("_"))) {
			const d = decidePersona({
				name: "ship",
				raw: readFileSync(join(dir, file), "utf8"),
				facts: SHIP_F,
				piPromptText: "<docs>\npi docs\n</docs>",
				readTemplate,
			});
			const text = d.forceSystemPrompt ?? [d.customPrompt, ...Object.values(d.sections ?? {})].join("\n");
			assert.ok(text.trim().length > 0, `${file} rendered nothing`);
			assert.ok(!text.includes("{{"), `${file} left a placeholder unresolved`);
		}
	});

	test("every persona renders against the same facts the wiring layer supplies", () => {
		for (const name of names) {
			const d = decidePersona({
				name,
				raw: readFileSync(join(dir, `${name}.md`), "utf8"),
				facts: SHIP_F,
				piPromptText: "<preamble>You are a coding assistant running inside pi</preamble>\n<docs>\npi's own docs section\n</docs>",
				readTemplate,
			});
			const text = d.mode === "bare" ? d.forceSystemPrompt! : [d.customPrompt ?? "", ...Object.values(d.sections ?? {})].join("\n");
			assert.ok(text.trim().length > 0, `${name} rendered nothing`);
			assert.ok(!text.includes("{{"), `${name} left a placeholder unresolved`);
			assert.deepEqual(d.warnings, [], `${name} produced warnings: ${d.warnings.join("; ")}`);
		}
	});

	test("the set really differs the way the docs say it does", () => {
		const decide = (name: string) => decidePersona({
			name,
			raw: readFileSync(join(dir, `${name}.md`), "utf8"),
			facts: F,
			piPromptText: "<docs>\npi's own docs section\n</docs>",
			readTemplate,
		});
		const bare = decide("pirate");
		assert.equal(bare.mode, "bare");
		assert.deepEqual(bare.selectedTools, ["read", "bash", "edit", "write"], "front-matter tools narrows the loadout");
		const bareText = bare.forceSystemPrompt!;
		assert.ok(!bareText.includes("- read:"), "bare `pirate` is meant to be absolutely clean");
		assert.ok(!bareText.includes("<cwd>"), "…not even cwd: the body is the whole prompt");
		const plus = decide("pirate-plus").forceSystemPrompt!;
		assert.match(plus, /<tools>/, "the same voice re-assembles its tool list from a fragment");
		assert.match(plus, /<cwd>/);
		const reviewer = decide("reviewer");
		assert.match(reviewer.sections!.rules, /Read the whole file and its callers/, "front-matter appends to pi's rules");
		assert.match(reviewer.sections!.rules, /Be concise in your responses/, "…instead of replacing them");
		assert.match(reviewer.customPrompt!, /Always answer in Chinese/, "the body pulls in a tone fragment");
		assert.match(decide("default").sections!.docs, /pi's own docs section/, "default borrows pi's docs text");
	});

	test("出厂的门控范例只门它 description 里说的那几件事", () => {
		const decideShip = (name: string) => decidePersona({
			name,
			raw: readFileSync(join(dir, `${name}.md`), "utf8"),
			facts: SHIP_F,
			piPromptText: "<docs>\npi's own docs section\n</docs>",
			readTemplate,
		});
		const audited = decideShip("audited");
		assert.deepEqual(audited.selectedTools, ["read", "bash", "ssh_run", "tickets"], "用户级的包（git 装或路径装）留下，项目本地扩展的工具出局");
		assert.match(audited.sections!.tools, /- ssh_run:/);
		assert.ok(!audited.sections!.tools.includes("deploy"), "prompt 里的说明书与请求里的声明取同一个集合");

		const quiet = decideShip("quiet");
		assert.deepEqual(quiet.filter!.dropSections, ["proxy_guard"], "别的扩展注入的段被挡掉");
		assert.deepEqual(quiet.filter!.agents, ["/proj/AGENTS.md"], "vendor 里的 AGENTS.md 进不来");
		assert.ok(!quiet.sections!.project_context.includes("vendored rules"), "正文里也不能漏");
		assert.match(quiet.sections!.addendum, /global layer rules/, "两层 APPEND_SYSTEM.md 是人设自己点名的：pi 只送一层");
		assert.match(quiet.sections!.addendum, /project layer rules/);
		assert.ok(!quiet.sections!.addendum.includes("appended by another extension"), "append:other 挡的是别的扩展/CLI 追加的文本");
	});

	test("the persona set does not collide with the subcommand words", () => {
		for (const name of names) assert.equal(isReserved(name), false, `${name} is a reserved subcommand word`);
	});
});

describe("the request view: the whole system role, not only its text", () => {
	test("summarizeParameters names each property, marks required, keeps enums", () => {
		assert.equal(
			summarizeParameters({
				type: "object",
				properties: { path: { type: "string" }, offset: { type: "number" } },
				required: ["path"],
			}),
			"path*: string, offset: number",
		);
		assert.equal(
			summarizeParameters({ type: "object", properties: { mode: { type: "string", enum: ["a", "b"] } } }),
			'mode: "a" | "b"',
		);
		assert.equal(
			summarizeParameters({ type: "object", properties: { tags: { type: "array", items: { type: "string" } } } }),
			"tags: string[]",
		);
	});

	test("summarizeParameters says so when there is nothing to summarize", () => {
		assert.equal(summarizeParameters(undefined), "(no parameters)");
		assert.equal(summarizeParameters({ type: "object" }), "(no parameters)");
		assert.equal(summarizeParameters({ type: "string" }), "(not an object schema)");
	});

	test("the notes file says up front that none of it is sent to the model", () => {
		const notes = renderPromptNotes({
			at: "2026-01-01T00:00:00.000Z", persona: "pirate", mode: "bare",
			declared: [{ name: "read", description: "Read files.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
			undeclared: ["bash"],
			provider: { text: "sent", source: "system blocks", model: "claude-opus-5" },
			toolsCapture: { tools: [{ name: "read", input_schema: {} }], source: "payload tools" },
		});
		assert.match(notes, /^persona prompt notes: nothing in this file is sent to the model/);
		assert.match(notes, /^- read  parameters: path\*: string$/m);
		assert.match(notes, /^registered but not declared: bash$/m);
		assert.match(notes, /^provider system text: from system blocks \(claude-opus-5\)$/m);
		assert.match(notes, /^tools-as-sent.json: from the payload tools$/m);
	});

	test("the notes file names the verbatim files and what was not captured", () => {
		const notes = renderPromptNotes({
			at: "x", persona: "(none)", mode: "sections", declared: [], undeclared: [],
			provider: { text: "", note: "no provider request seen in this session" },
			toolsCapture: { note: "not written: no payload captured" },
		});
		assert.match(notes, /no provider request seen in this session/);
		assert.match(notes, /tools-as-sent\.json: not written: no payload captured/);
		assert.match(notes, /verbatim/, "the notes must say which files hold verbatim content");
	});

	test("a fallback render is flagged in the notes, not hidden in the text", () => {
		const notes = renderPromptNotes({
			at: "x", persona: "doomed", mode: "sections",
			fallback: "persona 'doomed' failed: {{ include not found: x }} - using pi native prompt",
			declared: [], undeclared: [],
			provider: { text: "t", source: "system blocks" },
			toolsCapture: { tools: [{ name: "read" }], source: "payload tools" },
		});
		assert.match(notes, /^exported text is a FALLBACK: persona 'doomed' failed/m);
	});

	test("provider tool definitions come out of the payload untouched", () => {
		const anthropic = extractProviderTools({ tools: [{ name: "read", description: "d", input_schema: { type: "object" } }] });
		assert.deepEqual(anthropic.tools, [{ name: "read", description: "d", input_schema: { type: "object" } }]);
		assert.equal(anthropic.source, "payload tools");
		const openai = extractProviderTools({ tools: [{ type: "function", function: { name: "read", parameters: {} } }] });
		assert.equal(openai.source, "payload tools");
		const google = extractProviderTools({ tools: [{ functionDeclarations: [{ name: "read" }] }] });
		assert.equal(google.source, "payload tools");
	});

	test("missing tool definitions are reported, never invented", () => {
		assert.equal(extractProviderTools({ system: "x" }).note, "no tool definitions in the payload");
		assert.equal(extractProviderTools({ tools: [] }).note, "no tool definitions in the payload");
	});

	test("an unrecognized payload shape is reported in the notes", () => {
		const notes = renderPromptNotes({
			at: "x", persona: "(none)", mode: "sections", declared: [], undeclared: [],
			provider: { text: "", note: "unrecognized payload shape (keys: foo)" },
			toolsCapture: { note: "not written: unrecognized payload shape" },
		});
		assert.match(notes, /provider system text: unrecognized payload shape \(keys: foo\)/);
	});
});

describe("front-matter gates: extensions: (whose tools) and context: (what gets appended)", () => {
	/* pi 的归属信息（SourceInfo）在人设里被压成三类键，见 core.ts 的 *Keys()。 */
	// pi 本轮真的渲染过 <docs>，这样 warning 里只剩门控自己的话，断言才只数门控。
		// sections 只在 sections 模式下存在；门控测试全都跑 sections 模式，所以统一走 sec()。
	const sec = (d: ReturnType<typeof gateRun>): Record<string, string> => d.sections ?? {};
const gateRun = (raw: string, over: Partial<Parameters<typeof decidePersona>[0]> = {}) =>
		run(raw, { piPromptText: "<docs>\nPi documentation…\n</docs>", ...over });
	const MANY: ToolRef[] = [
		{ name: "read", source: "builtin", scope: "user", path: "builtin:read" },
		{ name: "bash", source: "builtin", scope: "user", path: "builtin:bash" },
		{ name: "web_search", source: "git:github.com/snowyu/pi-stuff", scope: "user", path: "/inst/extensions/persona/index.ts" },
		{ name: "ssh_run", source: "local", scope: "project", path: "/proj/.pi/extensions/ssh.ts" },
	];
	const factsWith = (over: Partial<PromptFacts>): PromptFacts => ({ ...F, ...over });
	const many = (over: Partial<PromptFacts> = {}) =>
		factsWith({ tools: MANY, toolNames: MANY.map((t) => t.name), toolSnippets: Object.fromEntries(MANY.map((t) => [t.name, `does ${t.name}`])), ...over });

	test("parseGate: omitted, \"*\" and [\"*\"] all mean no filtering", () => {
		assert.equal(parseGate(undefined), undefined);
		assert.equal(parseGate("*"), undefined);
		assert.equal(parseGate(["*"]), undefined);
		assert.equal(parseGate("  *  "), undefined, "front-matter padding may not turn off the filter");
	});
	test("parseGate splits ! negations out of the allow list", () => {
		const g = parseGate(["builtin", "!local:project"]) as GateSpec;
		assert.deepEqual(g.allow, ["builtin"]);
		assert.deepEqual(g.deny, ["local:project"]);
		const onlyDeny = parseGate(["!git:github.com/snowyu/*"]) as GateSpec;
		assert.deepEqual(onlyDeny.allow, [], "an all-negation list means everything else");
		assert.deepEqual(onlyDeny.deny, ["git:github.com/snowyu/*"]);
	});
	test("parseGate: [] is kept as an empty gate, not folded into \"no filter\"", () => {
		const g = parseGate([]) as GateSpec;
		assert.deepEqual(g.allow, []);
		assert.deepEqual(g.deny, []);
		assert.equal(g.empty, true);
	});
	test("front-matter: a bare `*` is refused by the YAML subset, so the quoted form is the only one", () => {
		assert.throws(() => parsePersona("---\nextensions: *\n---\nx\n"), /unsupported YAML/);
		assert.throws(() => parsePersona("---\ncontext: [\"*\", !append:pi]\n---\nx\n"), /bare ! is a YAML tag/);
		assert.deepEqual(parsePersona('---\nextensions: "*"\n---\nx\n').meta.extensions, "*");
		assert.deepEqual(parsePersona('---\ncontext:\n  - "!append:global"\n---\nx\n').meta.context, ["!append:global"]);
	});
	test("块数组里裸写 `!` 仍报错（YAML 里那是 tag），但得说破怎么修", () => {
		assert.throws(
			() => parsePersona('---\ncontext:\n  - "*"\n  - !append:global\n---\nhi\n'),
			/bare ! is a YAML tag: quote it as "!append:global"/,
		);
	});

	test("front-matter 里的陌生键报错：`deny:` 已被 `!` 取代，静默忽略会让人以为门控生效了", () => {
		assert.throws(() => parsePersona("---\ndeny: [\"local:project\"]\n---\nx\n"), /unknown front-matter key "deny"/);
		assert.throws(() => parsePersona("---\ndeny: [\"local:project\"]\n---\nx\n"), /write the exclusion in the same list with "!"/);
		assert.throws(() => parsePersona("---\nextentions: [\"builtin\"]\n---\nx\n"), /unknown front-matter key "extentions"/);
	});

	test("front-matter: gates reject wrong types instead of ignoring them", () => {
		assert.throws(() => parsePersona("---\nextensions: true\n---\nx\n"), /extensions: must be "\*" or a list of glob patterns/);
		assert.throws(() => parsePersona("---\ncontext:\n  a: b\n---\nx\n"), /context: must be "\*" or a list of glob patterns/);
	});

	test("toolKeys / agentKeys / skillKeys / sectionKeys: the candidate keys a pattern may match", () => {
		assert.deepEqual(toolKeys(MANY[2]), ["git:github.com/snowyu/pi-stuff", "git:github.com/snowyu/pi-stuff:user", "/inst/extensions/persona/index.ts"]);
		assert.deepEqual(agentKeys({ path: "/home/u/.pi/AGENTS.md", content: "", layer: "global" }), ["agents:/home/u/.pi/AGENTS.md", "/home/u/.pi/AGENTS.md", "agents:global"]);
		assert.deepEqual(skillKeys({ name: "pdf", source: "local", scope: "project", path: "/proj/.pi/skills/pdf/SKILL.md" }),
			["skill:local", "skill:local:project", "skill:pdf", "/proj/.pi/skills/pdf/SKILL.md"]);
		assert.deepEqual(sectionKeys("proxy_guard"), ["section:proxy_guard", "proxy_guard"]);
	});
	test("appendKeys labels where pi's single addendum text came from; appendLayerKeys the two files", () => {
		const layers = { project: { path: "/proj/.pi/APPEND_SYSTEM.md", content: "project rules" }, global: { path: "/u/.pi/agent/APPEND_SYSTEM.md", content: "global rules" } };
		assert.deepEqual(appendKeys("project rules", layers), ["append:pi", "append:project"]);
		assert.deepEqual(appendKeys("global rules", layers), ["append:pi", "append:global"]);
		assert.deepEqual(appendKeys("flag text", layers), ["append:pi", "append:other"], "an unattributable layer must say so, not guess");
		assert.deepEqual(appendKeys("", layers), ["append:pi", "append:empty"]);
		assert.deepEqual(appendLayerKeys("global", layers.global?.path), ["append:global", "/u/.pi/agent/APPEND_SYSTEM.md"]);
	});
	test("compileGate: a bare `*` pattern means everything, not one path segment", () => {
		const m = compileGate(parseGate(["*", "!section:evil"]) as GateSpec, "linux");
		assert.equal(m(sectionKeys("notes")).ok, true);
		assert.equal(m(sectionKeys("evil")).ok, false);
		assert.equal(compileGate(parseGate(["*", "!nothing:here"]) as GateSpec, "linux")(toolKeys(MANY[2])).ok, true);
	});
	test("a gate pattern that is nothing but `!` is refused, not treated as a deny-all", () => {
		assert.throws(() => parsePersona('---\ncontext: ["!"]\n---\nx\n'), /gate pattern is empty/);
	});

	test("extensions: [\"builtin\"] keeps pi's own tools and drops the ones other extensions registered", () => {
		const d = gateRun('---\nextensions: ["builtin"]\n---\nhi\n', { facts: many() });
		assert.deepEqual(d.selectedTools, ["read", "bash"]);
		assert.match(d.customPrompt ?? "", /^hi$/, "the body is only the preamble");
		assert.doesNotMatch(sec(d).tools ?? "", /web_search|ssh_run/);
		assert.deepEqual(d.warnings, []);
	});
	test("extensions: [\"!local:project\"] is the whole loadout minus that one source", () => {
		const d = gateRun('---\nextensions: ["!local:project"]\n---\nhi\n', { facts: many() });
		assert.deepEqual(d.selectedTools, ["read", "bash", "web_search"]);
	});
	test("extensions: matches a package source glob and a path glob equally", () => {
		const pkg = gateRun('---\nextensions: ["git:github.com/snowyu/*"]\n---\nhi\n', { facts: many() });
		assert.deepEqual(pkg.selectedTools, ["web_search"]);
		const byPath = gateRun('---\nextensions: ["**/fixtures/*", "builtin"]\n---\nhi\n', {
			facts: many({ tools: [...MANY, { name: "probe", source: "cli", scope: "temporary", path: "/t/test/fixtures/tool-extra.ts" }], toolNames: [...MANY.map((t) => t.name), "probe"], toolSnippets: { ...Object.fromEntries(MANY.map((t) => [t.name, "s"])), probe: "s" } }),
		});
		assert.ok((byPath.selectedTools ?? []).includes("probe"));
	});
	test("tools: [] 是显式全关：不声明任何工具，prompt 里是 pi 自己的 (none)", () => {
		const d = gateRun("---\ntools: []\n---\nhi\n", { facts: many() });
		assert.deepEqual(d.selectedTools, []);
		assert.equal(sec(d).tools, "(none)\n\nAdditional tools may be available.", "与 pi 同：没工具就是 (none)，不是空段");
		assert.ok(!sec(d).rules.includes("Use bash for file operations"), "没声明 bash 就不该有 bash 那条 guideline");
		assert.deepEqual(d.warnings, [], "tools: [] 是明确意图，不告警");
	});
	test("tools: [] 与 extensions: 同时在场所见即所得：还是全关", () => {
		const d = gateRun('---\ntools: []\nextensions: ["builtin"]\n---\nhi\n', { facts: many() });
		assert.deepEqual(d.selectedTools, []);
		assert.equal(sec(d).tools, "(none)\n\nAdditional tools may be available.");
	});
	test("tools: \"*\" 就是全部（跟随实时 loadout），而不是一个叫 `*` 的工具", () => {
		const d = gateRun('---\ntools: "*"\n---\nhi\n', { facts: many() });
		assert.equal(d.selectedTools, undefined, "不写 selectedTools，pi 用实时 loadout");
		assert.match(sec(d).tools, /- read: /);
	});
	test("skills 清单的 reader 措辞按**生效**工具集，不按实时 loadout：tools: [] 时不许点名 read", () => {
		const facts = factsWith({
			skills: [{ name: "pdf", description: "d", path: "/s/pdf/SKILL.md", source: "local", scope: "user" }],
			renderSkills: (_s, names) => (names?.includes("read") ? "read the file with read" : "no reader is named"),
		});
		assert.equal(sec(gateRun('---\nsections:\n  skills: "{{ skills_prompt }}"\n---\nhi\n', { facts })).skills, "read the file with read");
		assert.equal(sec(gateRun('---\ntools: []\nsections:\n  skills: "{{ skills_prompt }}"\n---\nhi\n', { facts })).skills, "no reader is named");
		assert.equal(sec(gateRun('---\ntools: [bash]\nsections:\n  skills: "{{ skills_prompt }}"\n---\nhi\n', { facts })).skills, "no reader is named");
	});

	test("tools: and extensions: intersect, and a name the gate dropped is reported", () => {
		const d = gateRun('---\ntools: [read, ssh_run]\nextensions: ["builtin"]\n---\nhi\n', { facts: many() });
		assert.deepEqual(d.selectedTools, ["read"]);
		assert.equal(d.warnings.length, 1);
		assert.match(d.warnings[0], /tools: ssh_run is not allowed by extensions:/);
	});
	test("a gate pattern that matched nothing warns, so a typo is visible", () => {
		const d = gateRun('---\nextensions: ["builtin", "git:github.com/typo/*", "!local:nowhere"]\n---\nhi\n', { facts: many() });
		// 有 allow 就是白名单：没命中的工具出局，打错的那条 pattern 得自己招了。
		assert.deepEqual(d.selectedTools, ["read", "bash"]);
		assert.equal(d.warnings.length, 2);
		assert.match(d.warnings[0], /extensions: pattern matched nothing: "git:github.com\/typo\/\*"/);
		assert.match(d.warnings[1], /extensions: pattern matched nothing: "!local:nowhere"/);
	});
	test("an empty gate list warns and drops everything it gates", () => {
		const d = gateRun('---\nextensions: []\n---\nhi\n', { facts: many() });
		assert.deepEqual(d.selectedTools, []);
		assert.match(d.warnings.join("\n"), /extensions: gate is an empty pattern list/);
	});
	test("一个只写了空串的列表也是“全关”，不是“不过滤”", () => {
		assert.deepEqual(parseGate([""]), { allow: [], deny: [], patterns: [], empty: true });
		const d = gateRun('---\ncontext: [""]\n---\nhi\n', { facts: factsWith({ foreignSections: ["evil"] }) });
		assert.deepEqual(d.filter.agents, []);
		assert.deepEqual(d.filter.skills, []);
		assert.equal(d.filter.append, false);
		assert.match(d.warnings.join("\n"), /context: gate is an empty pattern list/);
	});

	test("context: unset keeps every contribution pi gave us, exactly as before", () => {
		const facts = factsWith({
			contextFiles: [{ path: "/proj/AGENTS.md", content: "A", layer: "project" }],
			appendSystemPrompt: "ADD",
			skills: [{ name: "pdf", source: "local", scope: "user", path: "/u/.pi/skills/pdf/SKILL.md" }],
			renderSkills: (s) => s.map((x) => `- ${x.name}`).join("\n"),
			foreignSections: ["proxy_guard"],
		});
		const d = run("---\nhi\n", { facts });
		assert.equal(d.filter.append, true);
		assert.equal(d.filter.agents, null);
		assert.equal(d.filter.skills, null);
		assert.deepEqual(d.filter.dropSections, []);
		assert.equal(sec(d).addendum, "ADD");
		assert.equal(sec(d).skills, "- pdf");
		assert.match(sec(d).project_context ?? "", /A/);
	});
	test("context: [\"!append:*\"] silences the addendum, and the empty section disappears", () => {
		const d = gateRun('---\ncontext: ["!append:*", "*", "section:*"]\n---\nhi\n', {
			facts: factsWith({ appendSystemPrompt: "ADD" }),
		});
		assert.equal(d.filter.append, false);
		assert.equal(sec(d).addendum, undefined, "an empty section may not reach the model");
	});
	test("context: gates AGENTS.md by layer and by path glob", () => {
		const facts = factsWith({
			contextFiles: [
				{ path: "/proj/AGENTS.md", content: "P", layer: "project" },
				{ path: "/home/u/AGENTS.md", content: "G", layer: "global" },
				{ path: "/proj/vendor/AGENTS.md", content: "V", layer: "ancestor" },
			],
		});
		const byLayer = gateRun('---\ncontext: ["agents:project"]\n---\nhi\n', { facts });
		assert.deepEqual(byLayer.filter.agents, ["/proj/AGENTS.md"]);
		assert.match(sec(byLayer).project_context ?? "", /\nP\n/);
		assert.doesNotMatch(sec(byLayer).project_context ?? "", /\nG\n|\nV\n/);
		const byPath = gateRun('---\ncontext: ["*", "!**/vendor/**"]\n---\nhi\n', { facts });
		assert.deepEqual(byPath.filter.agents, ["/proj/AGENTS.md", "/home/u/AGENTS.md"]);
	});
	test("context: gates skills, and the skills list is re-rendered from what survived", () => {
		const facts = factsWith({
			skills: [
				{ name: "pdf", source: "local", scope: "user", path: "/u/.pi/skills/pdf/SKILL.md" },
				{ name: "ssh", source: "git:github.com/untrusted/pkg", scope: "user", path: "/x/skills/ssh/SKILL.md" },
			],
			renderSkills: (s) => s.map((x) => `- ${x.name}`).join("\n"),
		});
		const d = gateRun('---\ncontext: ["skill:local:user"]\n---\nhi\n', { facts });
		assert.deepEqual(d.filter.skills, ["pdf"]);
		assert.equal(sec(d).skills, "- pdf");
	});
	test("context: [\"!section:evil\"] deletes only that foreign section", () => {
		const d = gateRun('---\ncontext: ["*", "!section:evil"]\n---\nhi\n', {
			facts: factsWith({ foreignSections: ["proxy_guard", "evil"] }),
		});
		assert.deepEqual(d.filter.dropSections, ["evil"]);
	});
	test("append:project / append:global are the two APPEND_SYSTEM.md layers, and each can be silenced", () => {
		const facts = factsWith({
			appendSystemPrompt: "GLOBAL",
			appendLayers: { global: { path: "/u/.pi/agent/APPEND_SYSTEM.md", content: "GLOBAL" } },
		});
		const both = gateRun('---\nsections:\n  addendum: "{{ append_global }}|{{ append_project }}"\n---\nhi\n', { facts });
		assert.equal(sec(both).addendum, "GLOBAL|", "the project layer is empty, so nothing is invented");
		const off = gateRun('---\nsections:\n  addendum: "{{ append_global }}|{{ append_project }}"\ncontext: ["*", "!append:global"]\n---\nhi\n', { facts });
		assert.equal(sec(off).addendum, "|", "the gate silences the layer it names");
	});
	test("prompt notes 记下生效的门控：门控改了上线内容，notes 不写就没法排查", () => {
		const base = {
			at: "x", mode: "sections" as const, declared: [], undeclared: [],
			provider: { text: "t", source: "system blocks" },
			toolsCapture: { tools: [{ name: "read" }], source: "payload tools" },
		};
		const on = gateRun('---\nextensions: ["builtin"]\ncontext: ["*", "!append:other"]\n---\nhi\n');
		assert.match(
			renderPromptNotes({ ...base, persona: "gated", gates: on.gates }),
			/^gates: extensions=\["builtin"\] context=\["\*","!append:other"\] \(unlisted = allowed\)$/m,
		);
		const off = gateRun("---\nmode: sections\n---\nhi\n");
		assert.doesNotMatch(renderPromptNotes({ ...base, persona: "plain", gates: off.gates }), /gates:/, "没设门控就不写这一行");
	});
});
