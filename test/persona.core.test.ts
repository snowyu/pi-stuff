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
	renderRequestView,
	summarizeParameters,
} from "../extensions/persona/core.ts";

/** Split a rendered request view into its labeled blocks (banner: `===== label =====`). */
function viewBlocks(text: string): Map<string, string> {
	const marks = [...text.matchAll(/^===== (.+) =====\n/gm)];
	const out = new Map<string, string>();
	marks.forEach((m, i) => {
		const from = m.index + m[0].length;
		const to = marks[i + 1]?.index ?? text.length;
		out.set(m[1]!, text.slice(from, to).replace(/\n\n$/, ""));
	});
	return out;
}

const F: PromptFacts = {
	cwd: "/proj",
	now: "2026-01-01T00:00:00.000Z",
	platform: "linux",
	toolNames: ["read", "bash"],
	hiddenTools: [],
	toolSnippets: { read: "Read files", bash: "Run commands" },
	toolGuidelines: { read: ["Use read instead of cat."] },
	promptGuidelines: ["Custom rule."],
	skillsPrompt: "",
	skills: [],
	contextFiles: [],
	appendSystemPrompt: "",
	customPrompt: "",
	docsPaths: { readme: "/R.md", docs: "/docs", examples: "/ex" },
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
		for (const bad of ["off", "OFF", "Dirs", "prompt", "STATUS", "golden"]) {
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
	test("flag > env > entry > file; blank means unset", () => {
		assert.equal(resolveCurrent({ flag: "a", env: "b", sessionEntry: "c", stateFile: "d" }), "a");
		assert.equal(resolveCurrent({ env: "  ", sessionEntry: "c" }), "c");
		assert.equal(resolveCurrent({ env: "OFF" }), "off");
		assert.equal(resolveCurrent({ flag: "", env: "", sessionEntry: "", stateFile: "" }), undefined);
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
				facts: F,
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
				facts: F,
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

	test("the view keeps the system text verbatim and puts declarations in their own blocks", () => {
		const text = renderRequestView({
			systemText: "You are a pirate.\nTricky  whitespace.  ",
			mode: "bare",
			declared: [{
				name: "read",
				description: "Read files.",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			}],
			undeclared: ["bash", "edit"],
		});
		const blocks = viewBlocks(text);
		assert.deepEqual([...blocks.keys()], [
			"system role content (mode: bare)",
			"tools declared to the model",
			"registered but not declared",
		]);
		assert.equal(blocks.get("system role content (mode: bare)"), "You are a pirate.\nTricky  whitespace.  ");
		assert.match(
			blocks.get("tools declared to the model")!,
			/^- read\n {4}description: Read files\.\n {4}parameters: path\*: string$/,
		);
		assert.equal(blocks.get("registered but not declared"), "- bash\n- edit");
	});

	test("an empty tool set is written out explicitly, not as an empty block", () => {
		const blocks = viewBlocks(renderRequestView({ systemText: "x", mode: "sections", declared: [], undeclared: [] }));
		assert.equal(blocks.get("tools declared to the model"), "(none)");
		assert.equal(blocks.get("registered but not declared"), "(none)");
	});
});
