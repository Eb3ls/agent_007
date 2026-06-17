import {
	intentSig,
	selectBestIntention,
	type IntentionCandidate,
	type IntentionRuleContext,
} from "../core/intention_rules.js";
import { createStaticMap, setMap } from "../static_map.js";
import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";
import { makeIntention } from "../core/intention.js";
import { bfsFromSelf } from "../pathfinder.js";
import { describe, expect, it } from "vitest";

describe("intentSig", () => {
	it("formats kind and target", () => {
		const i = makeIntention("pickup", { x: 17, y: 1 }, 0, "p1");
		expect(intentSig(i)).toBe("pickup:(17,1)");
	});

	it("returns idle for null", () => {
		expect(intentSig(null)).toBe("idle");
	});
});

function ctx() {
	const map = createStaticMap();
	const tiles: IOTile[] = [
		{ x: 0, y: 0, type: "1" as IOTile["type"] },
		{ x: 1, y: 0, type: "1" as IOTile["type"] },
		{ x: 2, y: 0, type: "1" as IOTile["type"] },
		{ x: 3, y: 0, type: "1" as IOTile["type"] },
		{ x: 4, y: 0, type: "1" as IOTile["type"] },
	];
	setMap(map, tiles);
	return { map, bfs: bfsFromSelf(map, 0, 0) } as IntentionRuleContext;
}
function cand(
	source: IntentionCandidate["source"],
	kind: "pickup" | "deliver" | "explore",
	x: number,
	utility: number,
): IntentionCandidate {
	return {
		intention: { kind, targetXY: { x, y: 0 } } as never,
		source,
		utility,
	};
}

describe("selectBestIntention — hysteresis", () => {
	it("8b.1 value alternative within relative margin → keep current (multiplicative)", () => {
		// switch_margin_fraction=0.25 → 110 is within 100*1.25=125 → keep current.
		const c = ctx();
		const current = cand("current", "pickup", 1, 100);
		const alt = cand("pickup", "pickup", 2, 110);
		expect(selectBestIntention(c, [current, alt])).toBe(current);
	});

	it("8b.2 value alternative above relative margin → switch", () => {
		const c = ctx();
		const current = cand("current", "pickup", 1, 100);
		const alt = cand("pickup", "pickup", 2, 130); // > 125
		expect(selectBestIntention(c, [current, alt])).toBe(alt);
	});

	it("8b.3 current explore, best value → switch freely (no relative margin on -distance)", () => {
		const c = ctx();
		const current = cand("current", "explore", 4, 0); // scored as -distance
		const alt = cand("pickup", "pickup", 1, 5);
		expect(selectBestIntention(c, [current, alt])).toBe(alt);
	});

	it("8b.4 no current → pure argmax", () => {
		const c = ctx();
		const a = cand("pickup", "pickup", 1, 10);
		const b = cand("deliver", "deliver", 0, 50);
		expect(selectBestIntention(c, [a, b])).toBe(b);
	});

	it("8b.5 both explore → keep current unless best meaningfully nearer (distance margin)", () => {
		// switch_distance_margin=2. current target x=3 (dist 3 → score -3),
		// alt x=2 (dist 2 → score -2). -2 > -3 + 2? -2 > -1? no → keep current.
		const c = ctx();
		const current = cand("current", "explore", 3, 0);
		const altNear = cand("explore", "explore", 2, 0);
		expect(selectBestIntention(c, [current, altNear])).toBe(current);
		// alt x=0 (dist 0 → score 0). 0 > -3 + 2? 0 > -1? yes → switch.
		const altFar = cand("explore", "explore", 0, 0);
		expect(selectBestIntention(c, [current, altFar])).toBe(altFar);
	});
});
