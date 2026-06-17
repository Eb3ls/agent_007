import type { IntentionCandidate } from "../core/intention_rules.js";
import { makeIntention } from "../core/intention.js";
import { buildWhy } from "../core/deliberation.js";
import { describe, expect, it } from "vitest";

const i = makeIntention("pickup", { x: 1, y: 0 }, 0, "p1");

function cand(
	source: IntentionCandidate["source"],
	utility: number,
	detail?: string,
): IntentionCandidate {
	return { intention: i, source, utility, ...(detail && { detail }) };
}

describe("buildWhy", () => {
	it("puts the selected first with an arrow, rest descending", () => {
		const deliver = cand("deliver", 20);
		const batch = cand("batch", 500, "batch→2×10");
		const pickup = cand("pickup", 35);
		const cands = [deliver, batch, pickup];
		expect(buildWhy(cands, batch)).toBe(
			"→  batch→2×10(500) > pickup(35) > deliver(20)",
		);
	});

	it("caps at topK and notes the remainder", () => {
		const top = cand("deliver", 50);
		const cands = [
			top,
			cand("pickup", 40),
			cand("batch", 30),
			cand("goto", 20),
			cand("explore", 10),
		];
		expect(buildWhy(cands, top, 3)).toBe(
			"→  deliver(50) > pickup(40) > batch(30) (+2)",
		);
	});
});
