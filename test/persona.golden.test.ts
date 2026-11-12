/**
 * Tier 1.5: the recorded pi prompt (test/fixtures/pi-sections.json) against persona's own
 * structured rendering of `<tools>` and `<rules>`.
 *
 * The fixture is captured from a **real pi run** with `/persona golden`, so this is a drift alarm:
 * after a pi upgrade, `npm test` goes red if pi changes how it composes those two sections. It does
 * not run pi, and it does not care whether pi is installed.
 *
 * Only `tools` and `rules` are compared. They are hand-written mechanical assembly of data pi hands
 * extensions (`toolSnippets` / `toolGuidelines` / `promptGuidelines` + the live loadout), so pi
 * changing them is a bug we want told about. `docs` is extraction-first with a hand-copied fallback
 * and tolerates wording drift by design — see docs/persona.md.
 *
 * The fixture records the pi version it came from; that must match the pi in devDependencies, or the
 * baseline silently describes a different pi than everything else in the repo.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { renderRules, renderTools, type PromptFacts } from "../extensions/persona/core.ts";

const fixtureUrl = new URL("./fixtures/pi-sections.json", import.meta.url);
const fixturePath = fixtureUrl.pathname;

type Fixture = {
	piVersion: string;
	capturedAt: string;
	facts: Pick<PromptFacts, "toolNames" | "hiddenTools" | "toolSnippets" | "toolGuidelines" | "promptGuidelines">;
	sections: { tools: string; rules: string };
};

describe("golden vs pi", () => {
	test("the fixture is committed: a missing baseline must fail, not skip", () => {
		assert.ok(existsSync(fixturePath), `missing ${fixturePath} — capture it with /persona golden in a real pi run and commit it`);
	});

	const fixture = existsSync(fixturePath) ? (JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture) : undefined;

	test("the fixture was captured with the pi this repo pins", () => {
		assert.ok(fixture, "no fixture to check");
		const pinned = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			devDependencies: Record<string, string>;
		}).devDependencies["@earendil-works/pi-coding-agent"];
		// Only the exact pins describe a specific release: "1.5.2" yes, "^1.5.2" no.
		if (/^\d/.test(pinned ?? "")) {
			assert.equal(
				fixture!.piVersion,
				pinned,
				`the baseline came from pi ${fixture!.piVersion} but the repo pins ${pinned}; re-run /persona golden with the pinned pi and commit the new fixture`,
			);
		}
	});

	test("<tools> matches pi's own rendering of the same facts", () => {
		assert.ok(fixture, "no fixture");
		assert.equal(renderTools(fixture!.facts as PromptFacts), fixture!.sections.tools);
	});

	test("<rules> matches pi's own rendering of the same facts", () => {
		assert.ok(fixture, "no fixture");
		assert.equal(renderRules(fixture!.facts as PromptFacts), fixture!.sections.rules);
	});

	test("the fixture is self-consistent (not truncated or hand-edited)", () => {
		assert.ok(fixture, "no fixture");
		const { toolNames, hiddenTools, toolSnippets } = fixture!.facts;
		const listed = fixture!.sections.tools
			.split("\n")
			.filter((l) => l.startsWith("- "))
			.map((l) => l.slice(2).split(":")[0]);
		const expected = toolNames.filter((n) => !hiddenTools.includes(n) && toolSnippets[n]);
		assert.deepEqual(listed, expected, "pi's <tools> must list exactly the visible tools that have a snippet");
	});
});
