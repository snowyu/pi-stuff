#!/usr/bin/env node
/**
 * Compatibility patch for @marcfargas/pi-test-harness 0.6.1 against pi >= 1.x.
 *
 * The harness is released against pi 0.74/0.75 and does not run on pi 1.4.0 (verified 2026-10-30):
 *
 *   1. `import { getModel } from "@earendil-works/pi-ai"` — pi-ai no longer exports it, so the
 *      harness module fails to link before a single test runs.
 *   2. `getModel("openai", "gpt-4o")` — that model is never called (the playbook replaces
 *      streamFn), so a literal chat-model object is enough.
 *   3. It patches auth on `session._modelRegistry`, but pi 1.x validates through
 *      `session._modelRuntime.hasConfiguredAuth()/checkAuth()`, so every run() aborts with
 *      "No API key found for <provider>".
 *
 *   4. It installs the playbook as `agent.streamFn`; pi 1.x reads `agent.streamFunction`, so the
 *      real (unreachable) model gets called and the playbook is never consumed.
 *
 * Delete this script and the postinstall hook when upstream supports pi 1.x.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repoRoot, "node_modules", "@marcfargas", "pi-test-harness", "dist", "session.js");

if (!existsSync(target)) process.exit(0); // harness not installed: nothing to do

const PLAYBOOK_MODEL =
	'{ id: "playbook-model", provider: "playbook", api: "openai-completions", baseUrl: "http://127.0.0.1:9", reasoning: false, contextWindow: 8000, maxTokens: 1024 }';

const edits = [
	{
		name: "drop the pi-ai getModel import",
		pattern: /^\s*import \{ getModel \} from "@earendil-works\/pi-ai";\n/m,
		replacement: "",
	},
	{
		name: "replace getModel() with a literal playbook model",
		pattern: /const playbookModel = getModel\("openai", "gpt-4o"\);/,
		replacement: `const playbookModel = ${PLAYBOOK_MODEL}; // never called: the playbook replaces streamFn`,
	},
	{
		name: "install the playbook as agent.streamFunction",
		pattern: /session\.agent\.streamFn = streamFn;/,
		replacement: "session.agent.streamFunction = streamFn; // pi >= 1.x reads streamFunction",
	},
	{
		name: "patch pi 1.x modelRuntime auth checks",
		pattern: /(\n\s*)const origModelRegistry = session\._modelRegistry;/,
		replacement: (_match, indent) =>
			[
				`${indent}// pi >= 1.x validates auth through session._modelRuntime before a run starts.`,
				`${indent}const modelRuntime = session._modelRuntime;`,
				`${indent}if (modelRuntime) {`,
				`${indent}\tmodelRuntime.hasConfiguredAuth = () => true;`,
				`${indent}\tmodelRuntime.checkAuth = async () => ({});`,
				`${indent}\tmodelRuntime.checkAuthFromEnv = async () => ({});`,
				`${indent}\tmodelRuntime.isUsingOAuth = () => false;`,
				`${indent}}`,
				`${indent}const origModelRegistry = session._modelRegistry;`,
			].join("\n"),
	},
];

let source = readFileSync(target, "utf8");
if (source.includes("playbook-model") && source.includes("_modelRuntime")) {
	console.log("pi-test-harness: already patched");
	process.exit(0);
}

for (const edit of edits) {
	if (!edit.pattern.test(source)) {
		console.error(`pi-test-harness: could not find target for "${edit.name}".`);
		console.error("The installed harness differs from 0.6.1 — check whether upstream added pi 1.x support.");
		process.exit(1);
	}
	source = source.replace(edit.pattern, edit.replacement);
}

writeFileSync(target, source);
console.log(`patched ${target}`);
console.log("upstream targets pi 0.74/0.75; remove this patch when it supports pi 1.x");
