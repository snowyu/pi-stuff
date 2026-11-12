/**
 * Starting point for a new extension. Copy to `extensions/<name>.ts`, then write
 * `docs/<name>.md` and the two test files. Rules: docs/extension-conventions.md.
 *
 * The sample implements a read-only gate: a `tool_call` handler that blocks writes while a mode is
 * set to "read-only", with the mode in `<agent dir>/template.json` and `/template [read-only|edit|status]`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; // the types are all this sample needs from pi
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAME = "template";
const MUTATING_TOOLS = new Set(["edit", "write"]);
const MODES = ["read-only", "edit"] as const;
type Mode = (typeof MODES)[number];

interface State {
	mode?: Mode;
}

/* ------------------------------------------------------------------ pure core */

/** The whole policy: plain data in, plain data out. Test this directly. */
export function decideToolCall(toolName: string, mode: Mode, mutating: ReadonlySet<string>): { block: boolean; reason?: string } {
	if (mode !== "read-only") return { block: false };
	if (!mutating.has(toolName)) return { block: false };
	return { block: true, reason: `${NAME}: ${toolName} is blocked while the mode is read-only (/template edit to allow)` };
}

/* --------------------------------------------------------------- thin I/O */

/** Where this extension keeps its own state. To read pi's own directories, import pi's
 * `getAgentDir()` instead of restating this rule (docs/extension-conventions.md §4). */
function agentDir(): string {
	const explicit = process.env.PI_CODING_AGENT_DIR;
	if (explicit) return explicit;
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg) return join(xdg, "pi");
	return join(homedir(), ".pi", "agent");
}

function stateFile(): string {
	return join(agentDir(), `${NAME}.json`);
}

/** Never throws: a corrupt or missing state file means defaults. */
function loadState(): State {
	try {
		const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as unknown;
		const mode = (raw as State)?.mode;
		return MODES.includes(mode as Mode) ? { mode: mode as Mode } : {};
	} catch {
		return {};
	}
}

function saveState(patch: State): void {
	const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
	mkdirSync(agentDir(), { recursive: true });
	writeFileSync(stateFile(), `${JSON.stringify(next, null, 2)}\n`);
}

function currentMode(): Mode {
	const env = process.env.TEMPLATE_MODE?.trim().toLowerCase();
	if (MODES.includes(env as Mode)) return env as Mode;
	return loadState().mode ?? "edit";
}

/* ------------------------------------------------------------------ wiring */

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		// A tool_call handler that throws blocks the tool as a fail-safe: never throw here.
		try {
			if (process.env.TEMPLATE_DISABLE === "1") return;
			const decision = decideToolCall(event.toolName, currentMode(), MUTATING_TOOLS);
			return decision.block ? { block: true, reason: decision.reason } : undefined;
		} catch {
			return undefined;
		}
	});

	pi.registerCommand(NAME, {
		description: "Read-only gate: /template [read-only|edit|status]",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim().toLowerCase();
			try {
				if (MODES.includes(arg as Mode)) saveState({ mode: arg as Mode });
				else if (arg !== "" && arg !== "status") {
					ctx.ui.notify(`/${NAME}: usage /${NAME} [read-only|edit|status]`, "warning");
					return;
				}
				ctx.ui.notify(`${NAME}: mode=${currentMode()}`, "info");
			} catch (error) {
				ctx.ui.notify(`${NAME}: ${(error as Error).message}`, "error");
			}
		},
	});
}
