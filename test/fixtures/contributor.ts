/**
 * Test fixture: contributes exactly the three things persona's `extensions:` / `context:` gates exist
 * to decide about — a registered tool, an appended addendum line, and a custom prompt section.
 *
 * It must be loaded **before** the extension under test: `before_agent_start` handlers run in
 * extension load order over one shared `systemPromptOptions`, so only an earlier contributor is
 * visible in the facts the gated extension reads (a later one is invisible to it by construction).
 *
 * The tool is registered so pi can attribute it: `getAllTools()[].sourceInfo` names the extension
 * that registered it, which is the only way a persona can say "whose tools may I declare".
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The tool name this fixture registers. */
export const PROBE_TOOL = "probe_tool";
/** The custom section this fixture injects. */
export const CONTRIB_SECTION = "contrib_notes";
/** The addendum line this fixture appends. */
export const CONTRIB_APPEND = "contributed by the fixture";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: PROBE_TOOL,
		label: "Probe",
		description: "A tool registered by another extension",
		promptSnippet: "probe the fixture",
		promptGuidelines: ["Probe before concluding."],
		parameters: Type.Object({ where: Type.String({ description: "Where to probe" }) }),
		async execute() {
			return { content: [{ type: "text", text: "probed" }], details: {} };
		},
	});

	pi.on("before_agent_start", (event) => {
		const o = event.systemPromptOptions;
		o.appendSystemPrompt = `${o.appendSystemPrompt ?? ""}\n${CONTRIB_APPEND}`.trim();
		o.sections = { ...(o.sections ?? {}), [CONTRIB_SECTION]: "notes from the fixture" };
	});
}
