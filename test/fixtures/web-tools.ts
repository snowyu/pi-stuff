/**
 * Test fixture: stand-in "web" tools so proxy-guard's `tool_call` hook has something to intercept.
 *
 * proxy-guard matches tool names (web_search, fetch_content, source_check) rather than checking
 * which extension provided them, so registering stub tools with those names exercises the real
 * hook path without loading pi-web-access (which would hit the network).
 *
 * Each stub returns the arguments it actually received, which is exactly the assertion these
 * tests need: the proxy value proxy-guard injected is what the tool sees at execution time.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Parameters = Type.Object({
	url: Type.Optional(Type.String()),
	query: Type.Optional(Type.String()),
	claim: Type.Optional(Type.String()),
	// pi-web-access documents proxy: "<url>", with "" meaning "force a direct connection".
	proxy: Type.Optional(Type.String()),
});

export default function (pi: ExtensionAPI) {
	for (const name of ["web_search", "fetch_content", "source_check"]) {
		pi.registerTool({
			name,
			label: `Fixture ${name}`,
			description: `Fixture stand-in for ${name}; returns the arguments it received`,
			parameters: Parameters,

			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `${name} saw ${JSON.stringify(params)}` }],
					details: { received: params },
				};
			},
		});
	}
}
