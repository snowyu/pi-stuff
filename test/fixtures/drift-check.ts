/**
 * Tier 3 fixture: asks a **real pi** to render `<tools>` / `<rules>` for several tool loadouts and
 * compares each with persona's own structured rendering of the same facts.
 *
 * Why it is tier 3: the golden fixture is one snapshot of one loadout. The rules pi composes have
 * branches (bash / PowerShell / both shells / grep-find-ls present / hidden tools / no tools at all)
 * that no single capture covers, and `buildSystemPromptSections` is not exported from pi's public
 * entry point — so the only way to get pi's answer for an arbitrary loadout is to be inside pi and
 * mutate the handler's `systemPromptOptions` before reading `event.systemPrompt` (a getter that
 * rebuilds from those options). Each variant is compared, then the options are restored, so the run
 * itself is unaffected.
 *
 * Results are written to the file named by PI_STUFF_DRIFT_OUT: pi loads extensions in its own module
 * graph, so the test cannot import this file's state.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { extractSection, renderRules, renderTools, type PromptFacts } from "../../extensions/persona/core.ts";

export type DriftResult = {
	label: string;
	toolsOK: boolean;
	rulesOK: boolean;
	piTools?: string;
	ourTools?: string;
	piRules?: string;
	ourRules?: string;
	note?: string;
};

type Variant = { label: string; selectedTools: string[]; hiddenTools?: string[] };

/** Branches of pi's `buildRules` / tool listing that a single capture cannot cover. */
const VARIANTS: Variant[] = [
	{ label: "coding-default", selectedTools: ["read", "bash", "edit", "write"] },
	{ label: "with-search-tools", selectedTools: ["read", "bash", "grep", "find", "ls"] },
	{ label: "powershell-shell", selectedTools: ["read", "powershell"] },
	{ label: "both-shells", selectedTools: ["bash", "powershell"] },
	{ label: "no-shell", selectedTools: ["read", "edit"] },
	{ label: "no-tools", selectedTools: [] },
	{ label: "hidden-search-tool", selectedTools: ["read", "bash", "grep"], hiddenTools: ["grep"] },
];

export default function (pi: ExtensionAPI) {
	let done = false;

	pi.on("before_agent_start", (event) => {
		if (done) return;
		done = true;
		const out = process.env.PI_STUFF_DRIFT_OUT;
		if (!out) return;

		const o = event.systemPromptOptions;
		const base = { selectedTools: [...o.selectedTools], hiddenTools: [...o.hiddenTools] };
		const facts: PromptFacts = {
			cwd: o.cwd,
			now: "",
			platform: process.platform,
			toolNames: [...base.selectedTools],
			hiddenTools: [...base.hiddenTools],
			toolSnippets: { ...(o.toolSnippets ?? {}) },
			toolGuidelines: { ...(o.toolGuidelines ?? {}) },
			promptGuidelines: [...(o.promptGuidelines ?? [])],
			skills: [],
			renderSkills: () => "",
			contextFiles: [],
			appendSystemPrompt: o.appendSystemPrompt ?? "",
			appendLayers: {},
			foreignSections: [],
			tools: base.selectedTools.map((n) => ({ name: n, source: "builtin", scope: "user", path: n })),
			customPrompt: o.customPrompt ?? "",
			docsPaths: { readme: "", docs: "", examples: "" },
		};

		const results: DriftResult[] = [];
		for (const v of VARIANTS) {
			o.selectedTools = [...v.selectedTools];
			o.hiddenTools = v.hiddenTools ? [...v.hiddenTools] : [...base.hiddenTools];
			const text = event.systemPrompt;                       // getter: rebuilt from the mutated options
			o.selectedTools = [...base.selectedTools];             // restore before the next variant / the run
			o.hiddenTools = [...base.hiddenTools];

			const declared = v.selectedTools.filter((n) => !(v.hiddenTools ?? []).includes(n));
			const piTools = extractSection(text, "tools");
			const piRules = extractSection(text, "rules");
			const ourTools = renderTools(facts, declared);
			const ourRules = renderRules(facts, declared);
			results.push({
				label: v.label,
				toolsOK: piTools === ourTools,
				rulesOK: piRules === ourRules,
				piTools: piTools ?? "(absent)",
				ourTools,
				piRules: piRules ?? "(absent)",
				ourRules,
				note: piTools === undefined || piRules === undefined ? "pi rendered no such section" : undefined,
			});
		}
		writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`, "utf8");
	});
}
