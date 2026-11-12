/**
 * persona — keep a standing persona instead of re-prompting for one.
 *
 * pi's system prompt is one fixed text: SYSTEM.md or --system-prompt replace it wholesale, and
 * AGENTS.md/addendum only append to it. Switching to "reviewer mode" for an hour usually means
 * restarting pi or pasting the same paragraph into every message.
 *
 * This extension swaps pi's preamble for `personas/<name>.md` before every run
 * (`before_agent_start` → `systemPromptOptions.customPrompt`). A template may *optionally* borrow
 * pi's own `<tools>`, `<rules>` and `<docs>` bodies through `{{tools}}`, `{{rules}}`, `{{docs}}` and
 * `{{cwd}}`. Borrowing is best effort and never required; docs/persona.md states exactly when a
 * section is not there to borrow and what happens to a placeholder with no value (it is removed with
 * one warning — placeholder syntax never reaches the model).
 *
 * What setting customPrompt costs, said plainly: pi builds `<tools>`, `<rules>` and `<docs>` only in
 * the branch where no custom prompt exists, so with a persona on those sections are in the prompt
 * only if the template asks for them.
 *
 * Where the persona name comes from, first match wins:
 *   --persona <name>        CLI flag, this process only
 *   PI_PERSONA=<name>       environment, this process only
 *   the session itself      a custom entry written by /persona, so resume restores it
 *   personas/current        last choice, remembered across processes
 *   nothing                 pi builds its own prompt (SYSTEM.md, --system-prompt stay in charge)
 *
 * Where the files live, first match wins (docs/persona.md):
 *   PI_PERSONAS_PATH (colon separated) · <project>/.pi/personas · <agent dir>/personas
 *   · the personas/ directory inside this package
 *
 * CLI  : pi --persona reviewer | pi --persona off
 * TUI  : /persona                    selector
 *        /persona reviewer           next message uses it
 *        /persona reviewer new       switch, then ask pi for a new session
 *        /persona off                hand the native prompt back
 *
 * Documentation: docs/persona.md   ·   conventions: docs/extension-conventions.md
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const NAME = "persona";
/** Custom session entry type: remembers the choice for resume without entering the LLM context. */
const ENTRY = "persona";
/** The explicit "do not intervene" choice. */
const OFF = "off";
/** Placeholders that may borrow a whole section from the prompt pi renders. */
const BORROWED_SECTIONS = ["tools", "rules", "docs"] as const;
/** pi's own section-name grammar. */
const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_-]*)\s*\}\}/g;
/** A tag pair left with nothing but whitespace inside. Same name on both sides, via backreference. */
const EMPTY_SECTION_PAIR = /<([a-z][a-z0-9_-]*)>\s*<\/\1>/g;

/** Directory of this file; the package's personas/ sits next to extensions/. */
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ pure core */

/** A persona name is a file stem: no path separators, no hidden files, no traversal. */
export function isPersonaName(name: string): boolean {
	return /^[^./\\][^/\\]*$/.test(name);
}

export interface PersonaDirInput {
	/** Value of PI_PERSONAS_PATH, if set. */
	envPath?: string;
	cwd: string;
	/** pi's agent config directory (`<agent dir>/personas`). */
	agentDir: string;
	/** Directory containing this extension file; its own and its parent's personas/ are searched. */
	packageDir: string;
}

/** Search order: PI_PERSONAS_PATH entries, project, user, package. */
export function personaSearchDirs(input: PersonaDirInput): string[] {
	const extra = (input.envPath ?? "")
		.split(":")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return [
		...extra,
		join(input.cwd, ".pi", "personas"),
		join(input.agentDir, "personas"),
		join(input.packageDir, "personas"),
		join(input.packageDir, "..", "personas"),
	];
}

export interface PersonaSourceInput {
	flag?: string;
	env?: string;
	remembered?: string;
	state?: string;
}

/**
 * Which persona a session starts with, from the inputs pi offers, in priority order. Every input is
 * optional and may be junk: blank inputs are skipped, and a name that could escape the personas
 * directory (a hand-edited state file, a tampered session entry) is dropped instead of trusted.
 */
export function resolvePersonaName(input: PersonaSourceInput): string | undefined {
	for (const raw of [input.flag, input.env, input.remembered, input.state]) {
		const name = (raw ?? "").trim();
		if (!name) continue;
		if (name.toLowerCase() === OFF) return OFF;
		if (isPersonaName(name)) return name;
	}
	return undefined;
}

/** `/persona [name] [new]` — names are single tokens; extra tokens are ignored. */
export function parsePersonaArgs(args: string): { name?: string; wantNew: boolean } {
	const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const wantNew = tokens.some((token) => token.toLowerCase() === "new");
	const name = tokens.find((token) => token.toLowerCase() !== "new");
	return { name, wantNew };
}

/**
 * Best effort: one tagged section of a rendered system prompt, without its tags.
 *
 * Two limits, both documented in docs/persona.md: the section only exists when pi built one (a
 * non-empty customPrompt suppresses tools/rules/docs), and it reflects the options *at handler time*
 * — pi finalizes the tool loadout (`getActiveToolNames()`, `hiddenTools`, `prepareLoadout`) after
 * the handlers return. This reads pi's output; it does not re-implement pi's prompt builder.
 */
export function borrowPromptSection(prompt: string, section: string): string | undefined {
	if (!SECTION_NAME.test(section)) return undefined;
	return new RegExp(`<${section}>\n([\\s\\S]*?)\n</${section}>`).exec(prompt)?.[1];
}

/**
 * What a template can borrow for this run. `cwd` always has a value; the three sections only when
 * pi had them at handler time. Absent keys stay absent — deciding what a template does without them
 * is `resolvePersonaTemplate()`'s job.
 */
export function borrowableSections(prompt: string, cwd: string): Record<string, string> {
	const values: Record<string, string> = { cwd };
	for (const section of BORROWED_SECTIONS) {
		const text = borrowPromptSection(prompt, section);
		if (text !== undefined) values[section] = text;
	}
	return values;
}

export interface ResolvedTemplate {
	text: string;
	/** Placeholders the template asked for that had no value; deduplicated, sorted. */
	missing: string[];
}

/**
 * Substitute `{{name}}`. A placeholder with no value is removed rather than left literal: template
 * plumbing must never reach the model. If it was the only content of a same-named tag pair, the pair
 * goes too — an empty `<tools></tools>` claims there are no tools, which is the opposite of true.
 */
export function resolvePersonaTemplate(template: string, values: Record<string, string>): ResolvedTemplate {
	const missing = new Set<string>();
	const text = template.replace(PLACEHOLDER, (match: string, key: string) => {
		const value = values[key];
		if (value === undefined) {
			missing.add(key);
			return "";
		}
		return value;
	});
	return { text: missing.size > 0 ? text.replace(EMPTY_SECTION_PAIR, "") : text, missing: [...missing].sort() };
}

/* ---------------------------------------------------------------- thin I/O */

function personaDirs(cwd: string): string[] {
	return personaSearchDirs({ envPath: process.env.PI_PERSONAS_PATH, cwd, agentDir: getAgentDir(), packageDir: SELF_DIR });
}

/** Persona names available from all searched directories, de-duplicated and sorted. */
function listPersonas(cwd: string): string[] {
	const names = new Set<string>();
	for (const dir of personaDirs(cwd)) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) if (file.endsWith(".md")) names.add(basename(file, ".md"));
	}
	return [...names].sort();
}

function readTemplate(cwd: string, name: string): string | undefined {
	if (!isPersonaName(name)) return undefined;
	for (const dir of personaDirs(cwd)) {
		const file = join(dir, `${name}.md`);
		if (existsSync(file)) return readFileSync(file, "utf8");
	}
	return undefined;
}

/** Last choice, remembered for processes that start without a flag or an env var. */
function stateFile(): string {
	return join(getAgentDir(), "personas", "current");
}

function readState(): string {
	try {
		return readFileSync(stateFile(), "utf8").trim();
	} catch {
		return "";
	}
}

function writeState(name: string): void {
	mkdirSync(dirname(stateFile()), { recursive: true });
	writeFileSync(stateFile(), `${name}\n`, "utf8");
}

/* ------------------------------------------------------------------ wiring */

export default function persona(pi: ExtensionAPI) {
	pi.registerFlag("persona", {
		description: "Persona from personas/ (off = pi native prompt)",
		type: "string",
		default: "",
	});

	let current: string | undefined; // undefined = never touch pi's prompt
	const warned = new Set<string>(); // one notify per placeholder per process, not one per run
	const label = (name?: string) => (name && name !== OFF ? `${NAME}: ${name}` : undefined);

	function choose(name: string, ctx: ExtensionContext): void {
		current = name;
		pi.appendEntry(ENTRY, { name }); // session tree, for resume; never in the LLM context
		try {
			writeState(name);
		} catch {
			// Only affects what the next process starts with.
		}
		ctx.ui.setStatus(NAME, label(name));
	}

	pi.on("session_start", (_event, ctx) => {
		// A session store that cannot be read must not stop pi from starting: fall back to pi's own prompt.
		try {
			const entries = ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string; data?: { name?: string } }>;
			const remembered = [...entries]
				.reverse()
				.find((entry) => entry.type === "custom" && entry.customType === ENTRY)?.data?.name;
			current = resolvePersonaName({
				flag: String(pi.getFlag(NAME) ?? ""),
				env: process.env.PI_PERSONA,
				remembered,
				state: readState(),
			});
			ctx.ui.setStatus(NAME, label(current));
		} catch {
			current = undefined; // pi builds its own prompt
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Never throw: pi would log an extension error and the run would carry half-applied options.
		try {
			if (!current || current === OFF) return; // pi, SYSTEM.md and --system-prompt stay in charge
			const cwd = ctx.sessionManager.getCwd();
			const template = readTemplate(cwd, current);
			if (template === undefined) {
				ctx.ui.notify(`${NAME}: '${current}' not found (have: ${listPersonas(cwd).join(", ") || "none"}); using pi's prompt`, "warning");
				return;
			}
			// What pi renders now, as of this handler: borrowPromptSection() documents what it does
			// not know yet, because pi finalizes the tool loadout after the handlers return.
			const resolved = resolvePersonaTemplate(template, borrowableSections(event.systemPrompt, cwd));
			for (const placeholder of resolved.missing) {
				if (warned.has(placeholder)) continue;
				warned.add(placeholder);
				ctx.ui.notify(`${NAME}: nothing to borrow for {{${placeholder}}}; removed from the persona (see docs/persona.md)`, "warning");
			}
			event.systemPromptOptions.customPrompt = resolved.text;
		} catch (error) {
			ctx.ui.notify(`${NAME}: ${(error as Error).message}`, "warning");
		}
	});

	pi.registerCommand(NAME, {
		description: "Switch persona: /persona [name] [new] · off = pi native",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = [OFF, ...listPersonas(process.cwd())]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			// Never throw: pi would report an extension error and the choice would half-apply.
			try {
				const cwd = ctx.sessionManager.getCwd();
				const parsed = parsePersonaArgs(String(args ?? ""));
				let name = parsed.name;

				if (!name) {
					const picked = await ctx.ui.select(`${NAME}:`, [OFF, ...listPersonas(cwd)]);
					if (!picked) return;
					name = picked;
				}

				if (name !== OFF && readTemplate(cwd, name) === undefined) {
					ctx.ui.notify(`${NAME}: no such persona: ${name} (have: ${listPersonas(cwd).join(", ") || "none"})`, "error");
					return;
				}

				choose(name, ctx); // persisted before newSession, so the next session restores it
				ctx.ui.notify(name === OFF ? `${NAME} off (pi native prompt)` : `${NAME}: ${name}`, "info");
				if (parsed.wantNew) await ctx.newSession();
			} catch (error) {
				ctx.ui.notify(`${NAME}: ${(error as Error).message}`, "error");
			}
		},
	});
}
