/**
 * Test fixture: records what the prompt looked like when the `before_agent_start` handlers ran.
 *
 * pi hands every `before_agent_start` handler the same mutable `systemPromptOptions` and renders
 * `event.systemPrompt` on demand, so a fixture registered **after** the extension under test sees
 * exactly what that extension's mutation did — no LLM call, no network.
 *
 * It is handler-time state, not the final request: pi replaces `selectedTools` with
 * `getActiveToolNames()` and rewrites `hiddenTools` after the handlers return. The session's own
 * `session.systemPrompt` getter is the post-handler view, which is what `test/real/*` asserts on.
 *
 * pi loads extensions with its own module loader, so a test cannot import this file's state: the
 * two module instances do not share a module cache. Captures therefore live on a `globalThis` key
 * that both instances see.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** globalThis key holding the capture list. */
export const CAPTURES_KEY = "__pi_stuff_prompt_captures";

export interface PromptCapture {
	/** Zero-based run index inside the session. */
	turn: number;
	/** What the extension set on `systemPromptOptions.customPrompt`; undefined = pi native prompt. */
	customPrompt?: string;
	/** The complete prompt text for that run, as pi renders it at handler time. */
	prompt: string;
	/** Tools declared to the model at that moment; pi finalizes the loadout after the handlers. */
	activeTools: string[];
	/** `systemPromptOptions.selectedTools` after every handler ran — what an extension asked for. */
	selectedTools?: string[];
	/** Custom section tags present after every handler ran (gated-away ones must be gone). */
	sections?: string[];
}

function captures(): PromptCapture[] {
	const bag = globalThis as Record<string, unknown>;
	if (!Array.isArray(bag[CAPTURES_KEY])) bag[CAPTURES_KEY] = [];
	return bag[CAPTURES_KEY] as PromptCapture[];
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const list = captures();
		list.push({
			turn: list.length,
			customPrompt: event.systemPromptOptions.customPrompt,
			prompt: event.systemPrompt,
			activeTools: pi.getActiveTools(),
			selectedTools: [...(event.systemPromptOptions.selectedTools ?? [])],
			sections: Object.keys(event.systemPromptOptions.sections ?? {}),
		});
	});
}
