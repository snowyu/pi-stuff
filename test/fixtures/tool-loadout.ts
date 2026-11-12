/**
 * Test fixture: changes the active tool set from its own `before_agent_start` handler.
 *
 * pi finalizes the tool loadout *after* the handlers return (`selectedTools = getActiveToolNames()`,
 * then `hiddenTools` and any `prepareLoadout` hook). So an extension that borrows pi's `<tools>`
 * body from a handler sees the pre-change list. Registering this fixture **before** the extension
 * under test pins that one-step lag instead of pretending it does not exist.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", () => {
		// The extension API owns the loadout; ctx does not expose it to event handlers.
		pi.setActiveTools(["read"]);
	});
}
