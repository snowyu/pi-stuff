/**
 * Unit tests: persona's pure core — name rules, search order, argument parsing, placeholder
 * extraction and rendering. No pi runtime, no fs, no network. Run with `npm test`.
 *
 * The behavior these lock in is documented in docs/persona.md.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
	borrowPromptSection,
	borrowableSections,
	isPersonaName,
	parsePersonaArgs,
	personaSearchDirs,
	resolvePersonaName,
	resolvePersonaTemplate,
} from "../extensions/persona.ts";

/** pi's own structured prompt, trimmed to the sections the placeholders read (see docs/persona.md). */
const NATIVE_PROMPT = [
	"You are an expert coding assistant operating inside pi, a coding agent harness.",
	"",
	"<tools>",
	"- read: Read the contents of a file",
	"- bash: Execute a bash command",
	"",
	"In addition to the tools above, you may have access to other custom tools depending on the project.",
	"</tools>",
	"",
	"<rules>",
	"- Use bash for file operations like ls, rg, find",
	"- Be concise in your responses",
	"</rules>",
	"",
	"<docs>",
	"Pi documentation (read only when the user asks about pi itself):",
	"- Main documentation: /opt/pi/README.md",
	"</docs>",
	"",
	"<cwd>",
	"/tmp/project",
	"</cwd>",
].join("\n");

/* ------------------------------------------------------------------ names */

describe("isPersonaName", () => {
	const cases: Array<[string, boolean]> = [
		["reviewer", true],
		["my persona", true],
		["pirate.v2", true],
		["off", true],
		["", false],
		[".", false],
		["..", false],
		[".hidden", false],
		["../evil", false],
		["a/b", false],
		["a\\b", false],
		["/abs", false],
	];

	for (const [name, expected] of cases) {
		test(`accepts or rejects ${JSON.stringify(name)}`, () => {
			assert.equal(isPersonaName(name), expected);
		});
	}
});

/* -------------------------------------------------------------- search order */

describe("personaSearchDirs", () => {
	test("PI_PERSONAS_PATH entries come first, in order, split on ':'", () => {
		const dirs = personaSearchDirs({ envPath: "/work/team:/home/me/extra", cwd: "/proj", agentDir: "/agent", packageDir: join("/pkg", "extensions") });
		assert.deepEqual(dirs, [
			"/work/team",
			"/home/me/extra",
			join("/proj", ".pi", "personas"),
			join("/agent", "personas"),
			join("/pkg", "extensions", "personas"),
			join("/pkg", "personas"),
		]);
	});

	test("blank entries and surrounding spaces are dropped", () => {
		const dirs = personaSearchDirs({ envPath: "  /a :  :: ", cwd: "/proj", agentDir: "/agent", packageDir: "/pkg/extensions" });
		assert.equal(dirs[0], "/a");
		assert.equal(dirs[1], join("/proj", ".pi", "personas"));
	});

	test("without the env var the package and user directories still resolve", () => {
		const dirs = personaSearchDirs({ cwd: "/proj", agentDir: "/agent", packageDir: "/pkg/extensions" });
		assert.deepEqual(dirs, [
			join("/proj", ".pi", "personas"),
			join("/agent", "personas"),
			join("/pkg", "extensions", "personas"),
			join("/pkg", "personas"),
		]);
	});
});

/* --------------------------------------------------------- where the name comes from */

describe("resolvePersonaName", () => {
	const cases: Array<{ name: string; input: Parameters<typeof resolvePersonaName>[0]; expect: string | undefined }> = [
		{ name: "--persona beats everything", input: { flag: "reviewer", env: "pirate", remembered: "default", state: "off" }, expect: "reviewer" },
		{ name: "PI_PERSONA beats session and file", input: { env: "pirate", remembered: "default", state: "off" }, expect: "pirate" },
		{ name: "the session's own record beats the cross-session file", input: { remembered: "default", state: "pirate" }, expect: "default" },
		{ name: "the file is the last memory", input: { state: "pirate" }, expect: "pirate" },
		{ name: "nothing remembered -> no intervention at all", input: {}, expect: undefined },
		{ name: "blank inputs are not a choice", input: { flag: "  ", env: "", remembered: "", state: "   " }, expect: undefined },
		{ name: "surrounding spaces are trimmed", input: { flag: "  reviewer " }, expect: "reviewer" },
		{ name: "off is a real choice", input: { state: "off" }, expect: "off" },
		{ name: "OFF means off", input: { state: "Off" }, expect: "off" },
		{ name: "a tampered state file cannot escape its directory", input: { state: "../../etc/passwd" }, expect: undefined },
		{ name: "a tampered session entry is ignored too", input: { remembered: "a/b" }, expect: undefined },
		{ name: "an unsafe flag is still rejected", input: { flag: ".hidden" }, expect: undefined },
	];

	for (const testCase of cases) {
		test(testCase.name, () => {
			assert.equal(resolvePersonaName(testCase.input), testCase.expect);
		});
	}
});

/* ------------------------------------------------------------ /persona arguments */

describe("parsePersonaArgs", () => {
	const cases: Array<{ args: string; name?: string; wantNew: boolean }> = [
		{ args: "", wantNew: false },
		{ args: "   ", wantNew: false },
		{ args: "pirate", name: "pirate", wantNew: false },
		{ args: "pirate new", name: "pirate", wantNew: true },
		{ args: "new pirate", name: "pirate", wantNew: true },
		{ args: "  pirate   NEW  ", name: "pirate", wantNew: true },
		{ args: "new", wantNew: true },
		{ args: "off", name: "off", wantNew: false },
		{ args: "pirate extra", name: "pirate", wantNew: false },
	];

	for (const testCase of cases) {
		test(`parses ${JSON.stringify(testCase.args)}`, () => {
			const parsed = parsePersonaArgs(testCase.args);
			assert.equal(parsed.name, testCase.name, `${testCase.args}: name`);
			assert.equal(parsed.wantNew, testCase.wantNew, `${testCase.args}: wantNew`);
		});
	}
});

/* ------------------------------------- pi's sections, read back out (best effort) */

describe("borrowPromptSection", () => {
	test("returns the body of a tagged section without the tags", () => {
		const tools = borrowPromptSection(NATIVE_PROMPT, "tools");
		assert.ok(tools);
		assert.match(tools, /- read: Read the contents of a file/);
		assert.match(tools, /In addition to the tools above/);
		assert.ok(!tools.includes("<tools>"));
		assert.ok(!tools.includes("<rules>"), "must stop at the end of its own section");
	});

	test("a single-line section is returned as-is", () => {
		assert.equal(borrowPromptSection(NATIVE_PROMPT, "cwd"), "/tmp/project");
	});

	test("a missing section is undefined, not an empty string", () => {
		assert.equal(borrowPromptSection(NATIVE_PROMPT, "nope"), undefined);
	});

	test("an unclosed tag is not a section", () => {
		assert.equal(borrowPromptSection("hello\n<tools>\n- read", "tools"), undefined);
	});

	test("section names are validated, not interpolated into a pattern blindly", () => {
		for (const bad of ["Tools", "TOOLS", "too ls", "", "1tools", "<tools>", "tools/"]) {
			assert.equal(borrowPromptSection(NATIVE_PROMPT, bad), undefined, `${bad}`);
		}
	});

	test("the first matching section wins", () => {
		assert.equal(borrowPromptSection("<cwd>\n/a\n</cwd>\n\n<cwd>\n/b\n</cwd>", "cwd"), "/a");
	});
});

describe("borrowableSections", () => {
	test("only the sections present in pi's prompt become values", () => {
		const values = borrowableSections(NATIVE_PROMPT, "/tmp/project");
		assert.deepEqual(Object.keys(values).sort(), ["cwd", "docs", "rules", "tools"]);
		assert.match(values.tools, /- bash: Execute a bash command/);
	});

	test("a custom pi prompt has no sections to borrow", () => {
		// A custom pi prompt (SYSTEM.md, --system-prompt, an earlier extension) has no sections:
		// tools/rules/docs are simply absent, which is what makes a placeholder "missing".
		const values = borrowableSections("You are a custom assistant.", "/tmp/project");
		assert.deepEqual(Object.keys(values), ["cwd"]);
	});

	test("cwd is the session's working directory, not the <cwd> section", () => {
		const values = borrowableSections(NATIVE_PROMPT, "/other/dir");
		assert.equal(values.cwd, "/other/dir");
	});
});

/* ------------------------------------------------------------- template rendering */

describe("resolvePersonaTemplate", () => {
	test("replaces every occurrence of a known placeholder", () => {
		const out = resolvePersonaTemplate("A {{tools}} B {{ tools }} C {{tools}}", { tools: "- read: x" });
		assert.deepEqual(out, { text: "A - read: x B - read: x C - read: x", missing: [] });
	});

	test("whitespace inside the braces is optional", () => {
		assert.deepEqual(resolvePersonaTemplate("{{cwd}}|{{ cwd }}|{{  cwd  }}", { cwd: "/p" }), { text: "/p|/p|/p", missing: [] });
	});

	test("a placeholder with no value is removed and reported, never left literal", () => {
		const out = resolvePersonaTemplate("A {{tools}} B {{sections}} C", { tools: "- read: x" });
		assert.equal(out.text, "A - read: x B  C", "no {{...}} may reach the model");
		assert.deepEqual(out.missing, ["sections"]);
	});

	test("missing names are reported once even when used repeatedly", () => {
		const out = resolvePersonaTemplate("{{docs}} {{ docs }} {{docs}}", {});
		assert.deepEqual(out.missing, ["docs"]);
	});

	test("a placeholder alone inside a same-named pair takes the empty pair with it", () => {
		// <tools></tools> would tell the model there are no tools.
		const out = resolvePersonaTemplate("hi\n\n<tools>\n{{tools}}\n</tools>\n", {});
		assert.equal(out.text, "hi\n\n\n");
		assert.deepEqual(out.missing, ["tools"]);
	});

	test("a pair that still has content is left alone", () => {
		const out = resolvePersonaTemplate("<rules>\n{{rules}}\n- mine\n</rules>\n{{docs}}", { rules: "- pi's" });
		assert.equal(out.text, "<rules>\n- pi's\n- mine\n</rules>\n");
	});

	test("a template without placeholders is returned unchanged", () => {
		assert.deepEqual(resolvePersonaTemplate("You are a pirate. Arrr!", {}), { text: "You are a pirate. Arrr!", missing: [] });
	});

	test("replacement text containing $ sequences is inserted literally", () => {
		assert.deepEqual(resolvePersonaTemplate("{{tools}}", { tools: "$& and $1 and $`tail" }), { text: "$& and $1 and $`tail", missing: [] });
	});

	test("multi-line values keep their line breaks", () => {
		const out = resolvePersonaTemplate("<tools>\n{{tools}}\n</tools>", { tools: "- read: x\n- bash: y" });
		assert.deepEqual(out, { text: "<tools>\n- read: x\n- bash: y\n</tools>", missing: [] });
	});
});
