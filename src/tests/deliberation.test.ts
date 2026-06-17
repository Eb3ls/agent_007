import {
	buildWhy,
	deliberate,
	type DeliberationContext,
} from "../core/deliberation.js";
import { createBeliefStore, type ParcelBelief } from "../belief_store.js";
import type { IntentionCandidate } from "../core/intention_rules.js";
import type { ActiveDirectives } from "../team/directives.js";
import { createStaticMap, setMap } from "../static_map.js";
import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";
import { deliverTileBlocked } from "../core/valuator.js";
import { makeIntention } from "../core/intention.js";
import type { CarryState } from "../core/planner.js";
import { bfsFromSelf } from "../pathfinder.js";
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

// ─────────────────────────────────────────────
// Harness helpers for deliberate() golden tests
// ─────────────────────────────────────────────

// A 1×6 corridor: delivery at x=0, walkable (spawn) elsewhere.
function corridor() {
	const map = createStaticMap();
	const tiles: IOTile[] = [
		{ x: 0, y: 0, type: "2" as IOTile["type"] }, // delivery
		{ x: 1, y: 0, type: "1" as IOTile["type"] },
		{ x: 2, y: 0, type: "1" as IOTile["type"] },
		{ x: 3, y: 0, type: "1" as IOTile["type"] },
		{ x: 4, y: 0, type: "1" as IOTile["type"] },
		{ x: 5, y: 0, type: "1" as IOTile["type"] },
	];
	setMap(map, tiles);
	return map;
}

// Main corridor y=0, x=0..10 (delivery at x=5) plus a short left branch up at x=0.
// Lets selfX changes flip which out-of-view spawn is nearest, exercising explore hysteresis.
function tBranchMap() {
	const map = createStaticMap();
	const tiles: IOTile[] = [];
	for (let x = 0; x <= 10; x++)
		tiles.push({
			x,
			y: 0,
			type: (x === 5 ? "2" : "1") as IOTile["type"],
		});
	tiles.push({ x: 0, y: 1, type: "1" as IOTile["type"] });
	tiles.push({ x: 0, y: 2, type: "1" as IOTile["type"] });
	setMap(map, tiles);
	return map;
}

function emptyCarry(): CarryState {
	return { n: 0, rewards: [], nearestDeliveryDist: 0, ids: [] };
}

function carryOf(rewards: number[]): CarryState {
	return {
		n: rewards.length,
		rewards,
		nearestDeliveryDist: 0,
		ids: rewards.map((_, idx) => `c${idx}`),
	};
}

function parcelAt(id: string, x: number, reward: number): ParcelBelief {
	return {
		id,
		x,
		y: 0,
		reward,
		lastSeenAt: 1000,
		confidence: 1,
		inView: true,
		inViewBy: new Set(["bdi"]),
	} as unknown as ParcelBelief;
}

function emptyDirectives(): Readonly<ActiveDirectives> {
	return {
		paused: false,
		stage: null,
		modifiers: [],
		hardForbiddenTileCoords: [],
		pricedCrossTiles: [],
		forbiddenPickupParcelIds: new Set(),
	};
}

function makeContext(
	o: Partial<DeliberationContext> & {
		selfX: number;
		map: ReturnType<typeof corridor>;
	},
): DeliberationContext {
	const map = o.map;
	const bfs = bfsFromSelf(map, o.selfX, 0);
	return {
		myId: "bdi",
		map,
		beliefs: o.beliefs ?? createBeliefStore(),
		bfs,
		selfX: o.selfX,
		selfY: 0,
		now: 1000,
		movementDurationMs: 500,
		observationDistance: o.observationDistance ?? 5,
		decayIntervalMs: Infinity,
		carry: o.carry ?? emptyCarry(),
		intention: o.intention ?? null,
		directives: o.directives ?? emptyDirectives(),
		metrics: { M: 500, L: 0, decayIntervalMs: Infinity },
		rewardAvg: 10,
	};
}

// ─────────────────────────────────────────────
// deliberate — golden selection (characterization)
// ─────────────────────────────────────────────

describe("deliberate — golden selection (characterization)", () => {
	it("8a.1 empty carry, one reachable parcel → pickup it", () => {
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", parcelAt("p1", 3, 20));
		const r = deliberate(
			makeContext({ map: corridor(), selfX: 5, beliefs }),
		);
		expect(r.intention?.kind).toBe("pickup");
		expect(r.intention?.targetXY).toEqual({ x: 3, y: 0 });
	});

	it("8a.2 carrying, reachable delivery → deliver", () => {
		const r = deliberate(
			makeContext({
				map: corridor(),
				selfX: 5,
				carry: carryOf([30]),
			}),
		);
		expect(r.intention?.kind).toBe("deliver");
		// targetXY may carry an id field from the tile — use objectContaining
		expect(r.intention?.targetXY).toEqual(
			expect.objectContaining({ x: 0, y: 0 }),
		);
	});

	it("8a.3 carrying + higher-reward pickup FARTHER than delivery, dp=0 → pickup preempts deliver", () => {
		// self at x=1; delivery at x=0 (dist 1); parcel at x=5 (dist 4, farther).
		// carry small (R_c=5), parcel large (R_p=100): pickup score (R_c+R_p) beats
		// deliver score (R_c) by far more than the 25% margin. Pins §9.4 (guard dropped).
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", parcelAt("p1", 5, 100));
		const r = deliberate(
			makeContext({
				map: corridor(),
				selfX: 1,
				beliefs,
				carry: carryOf([5]),
			}),
		);
		expect(r.intention?.kind).toBe("pickup");
		expect(r.intention?.targetXY).toEqual({ x: 5, y: 0 });
	});

	it("8a.5 goto modifier with higher bonus than parcel → goto chosen", () => {
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", parcelAt("p1", 3, 5)); // low-reward parcel
		const directives: ActiveDirectives = {
			...emptyDirectives(),
			modifiers: [
				{
					selector: { on: "goto", coords: [{ x: 0, y: 0 }] },
					effect: { add: 500 },
					lifetime: "persistent",
					missionId: "g1",
					target: "both",
				},
			],
		};
		const r = deliberate(
			makeContext({ map: corridor(), selfX: 5, beliefs, directives }),
		);
		expect(r.intention?.kind).toBe("goto");
		expect(r.intention?.targetXY).toEqual({ x: 0, y: 0 });
	});

	it("8a.6 batch count-multiplier beats plain pickup → batch chosen", () => {
		const beliefs = createBeliefStore();
		// Two parcels, each reward=10. A batch modifier requiring 2 parcels with mult=10
		// scores (10+10)*10=200, far above single pickup score ~10.
		beliefs.parcels.set("p1", parcelAt("p1", 2, 10));
		beliefs.parcels.set("p2", parcelAt("p2", 4, 10));
		const directives: ActiveDirectives = {
			...emptyDirectives(),
			modifiers: [
				{
					selector: { on: "deliver" },
					effect: { mult: 10 },
					condition: { carryCountAtLeast: 2 },
					lifetime: "persistent",
					missionId: "batch1",
					target: "both",
				},
			],
		};
		const r = deliberate(
			makeContext({ map: corridor(), selfX: 5, beliefs, directives }),
		);
		expect(r.intention?.kind).toBe("pickup");
		// detail lives on the candidate, not the intention; batch selection is visible in why
		expect(r.why).toMatch(/^→\s+batch→/);
	});

	it("8a.7 no pickup, spawns available → explore", () => {
		// No parcels, empty carry. observationDistance=1 so spawns at x=3+ are out of view.
		// Self at x=0 (delivery tile, no path to self → bfsFromSelf starts there), parcels=none.
		// With small observationDistance, nearestOutOfViewSpawn returns a spawn tile.
		const r = deliberate(
			makeContext({ map: corridor(), selfX: 0, observationDistance: 1 }),
		);
		expect(r.intention?.kind).toBe("explore");
	});

	it("8a.8 teamExclusions hides best parcel → second-best chosen", () => {
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", parcelAt("p1", 2, 100)); // best, excluded
		beliefs.parcels.set("p2", parcelAt("p2", 4, 40)); // second
		const r = deliberate({
			...makeContext({ map: corridor(), selfX: 5, beliefs }),
			teamExclusions: {
				excludedParcelIds: new Set(["p1"]),
				exploreExcludedSpawnIds: new Set(),
				excludedGotoTargets: new Set(),
			},
		});
		expect(r.intention?.kind).toBe("pickup");
		expect(r.intention?.targetXY).toEqual({ x: 4, y: 0 });
	});

	it("8a.9 lone parcel under mult=0@count==1, no other pickup → NOT deliver (hold + explore)", () => {
		// carry n=1, modifier zeroes reward when delivering exactly 1. deliver score = 0.
		// No reachable parcels, so explore (score -distance) is the only other option.
		// Without the score>0 gate, deliver(0) > explore(-dist) and the agent dumps the
		// parcel for 0 reward. The gate must suppress the deliver candidate.
		const directives: ActiveDirectives = {
			...emptyDirectives(),
			modifiers: [
				{
					selector: { on: "deliver" },
					effect: { mult: 0 },
					condition: { carryCountEquals: 1 },
					lifetime: "persistent",
					missionId: "z1",
					target: "both",
				},
			],
		};
		const r = deliberate(
			makeContext({
				map: corridor(),
				selfX: 5,
				carry: carryOf([30]),
				directives,
				observationDistance: 1,
			}),
		);
		expect(r.intention?.kind).not.toBe("deliver");
		expect(r.intention?.kind).toBe("explore");
	});

	it("8a.10 carry n=2 under mult=0@count==1 → condition unmet, full reward → deliver", () => {
		// Contrast with 8a.9: the mult=0 only fires at carryCountEquals:1. With n=2 the
		// condition is unmet, deliver score is positive, so delivery proceeds normally.
		const directives: ActiveDirectives = {
			...emptyDirectives(),
			modifiers: [
				{
					selector: { on: "deliver" },
					effect: { mult: 0 },
					condition: { carryCountEquals: 1 },
					lifetime: "persistent",
					missionId: "z1",
					target: "both",
				},
			],
		};
		const r = deliberate(
			makeContext({
				map: corridor(),
				selfX: 5,
				carry: carryOf([30, 30]),
				directives,
				observationDistance: 1,
			}),
		);
		expect(r.intention?.kind).toBe("deliver");
	});
});

describe("deliberate — stability (post-collapse)", () => {
	it("8a.4 fresh parcel strictly higher but within margin → hysteresis holds current", () => {
		// Tick 1: only A in view → deliberate commits to A (pickup score = reward, dp=0).
		const map = corridor();
		const beliefs1 = createBeliefStore();
		beliefs1.parcels.set("A", parcelAt("A", 3, 20));
		const first = deliberate(
			makeContext({ map, selfX: 5, beliefs: beliefs1 }),
		);
		expect(first.intention?.kind).toBe("pickup");
		expect(first.intention?.targetXY).toEqual({ x: 3, y: 0 });

		// Tick 2 (keep): B now in view scoring 22 — STRICTLY above committed A (20), so
		// fresh-pickup argmax prefers B. But 22 ≤ 20×1.25=25, inside switch_margin_fraction,
		// so hysteresis must hold A. Non-vacuous: drop the margin branch and this flips to B.
		const beliefsKeep = createBeliefStore();
		beliefsKeep.parcels.set("A", parcelAt("A", 3, 20));
		beliefsKeep.parcels.set("B", parcelAt("B", 4, 22));
		const keep = deliberate(
			makeContext({
				map,
				selfX: 5,
				beliefs: beliefsKeep,
				intention: first.intention!,
			}),
		);
		expect(keep.intention?.targetXY).toEqual({ x: 3, y: 0 });
		// B did out-score A this tick — the why line shows current(20) chosen over pickup(22).
		expect(keep.why).toMatch(/current\(20\) > pickup\(22\)/);

		// Tick 2 (switch): B raised to 30 > 20×1.25=25 → margin exceeded → MUST flip to B.
		// This contrasting case proves the keep above is hysteresis, not a stuck argmax.
		const beliefsSwitch = createBeliefStore();
		beliefsSwitch.parcels.set("A", parcelAt("A", 3, 20));
		beliefsSwitch.parcels.set("B", parcelAt("B", 4, 30));
		const flip = deliberate(
			makeContext({
				map,
				selfX: 5,
				beliefs: beliefsSwitch,
				intention: first.intention!,
			}),
		);
		expect(flip.intention?.targetXY).toEqual({ x: 4, y: 0 });
	});

	it("8c.3 current stays selected → plan reused, not rebuilt", () => {
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", parcelAt("p1", 3, 50));
		const first = deliberate(
			makeContext({ map: corridor(), selfX: 5, beliefs }),
		);
		const committed = first.intention!;
		const markedPlan = committed.plan;
		const r = deliberate(
			makeContext({
				map: corridor(),
				selfX: 5,
				beliefs,
				intention: committed,
			}),
		);
		// Same object's plan reused (source==="current" returns context.intention as-is).
		expect(r.intention).toBe(committed);
		expect(r.intention?.plan).toBe(markedPlan);
	});

	it("8c.4 explore target held when a nearer spawn is within the distance margin", () => {
		// Tick 1 at selfX=0 (obsDist=1) commits to the nearest out-of-view spawn x=2.
		const map = tBranchMap();
		const first = deliberate(
			makeContext({ map, selfX: 0, observationDistance: 1 }),
		);
		expect(first.intention?.kind).toBe("explore");
		expect(first.intention?.targetXY).toEqual({ x: 2, y: 0 });

		// Tick 2 (keep): agent moved to selfX=6. Committed x=2 is now dist 4 (score -4);
		// the fresh nearest spawn x=4 is dist 2 (score -2) — STRICTLY nearer. But the gain
		// (2 steps) is not > switch_distance_margin (2), so hysteresis holds x=2.
		// Non-vacuous: without the explore-margin branch, -2 > -4 would flip it to x=4.
		const keep = deliberate(
			makeContext({
				map,
				selfX: 6,
				observationDistance: 1,
				intention: first.intention!,
			}),
		);
		expect(keep.intention?.targetXY).toEqual({ x: 2, y: 0 });

		// Tick 2 (switch): agent at selfX=9. Committed x=2 is dist 7 (score -7); fresh
		// nearest x=6 is dist 3 (score -3). Gain 4 > margin 2 → MUST flip to x=6.
		// Contrasting case: proves the keep above is the margin, not a stuck argmax.
		const flip = deliberate(
			makeContext({
				map,
				selfX: 9,
				observationDistance: 1,
				intention: first.intention!,
			}),
		);
		expect(flip.intention?.targetXY).toEqual({ x: 6, y: 0 });
	});
});

// ─────────────────────────────────────────────
// deliberate — self-excluded parcels (stuck-on-refused-pickup fix)
// ─────────────────────────────────────────────

describe("deliberate — selfExcludedParcelIds", () => {
	// "Penalize over-carrying": delivery pays 0 once carrying >= 2 parcels. The grab
	// reflex (carryValue) refuses a 2nd parcel; scorePickup is blind to the condition
	// and would re-select it, freezing the agent on the tile. Excluding it recovers.
	const overCarry = (): ActiveDirectives => ({
		...emptyDirectives(),
		modifiers: [
			{
				selector: { on: "deliver" },
				effect: { mult: 0 },
				condition: { carryCountAtLeast: 2 },
				lifetime: "persistent",
				missionId: "m1",
				target: "both",
			},
		],
	});

	it("without exclusion: underfoot refused parcel freezes deliberate (null)", () => {
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p2", parcelAt("p2", 3, 10));
		const r = deliberate(
			makeContext({
				map: corridor(),
				selfX: 3,
				beliefs,
				carry: carryOf([10]),
				directives: overCarry(),
			}),
		);
		// pickup wins (dist 0) but its plan-to-self is empty → null; deliver suppressed.
		expect(r.intention).toBeNull();
	});

	it("with exclusion: agent recovers (delivers current carry instead of freezing)", () => {
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p2", parcelAt("p2", 3, 10));
		const r = deliberate({
			...makeContext({
				map: corridor(),
				selfX: 3,
				beliefs,
				carry: carryOf([10]),
				directives: overCarry(),
			}),
			selfExcludedParcelIds: new Set(["p2"]),
		});
		expect(r.intention).not.toBeNull();
		expect(r.intention?.kind).not.toBe("pickup");
	});

	it("regression: no over-carry modifier → parcel still selectable", () => {
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p9", parcelAt("p9", 3, 20));
		const r = deliberate(
			makeContext({ map: corridor(), selfX: 5, beliefs }),
		);
		expect(r.intention?.kind).toBe("pickup");
	});
});

// ─────────────────────────────────────────────
// tile-scoped deliver mult=0 ("deliver in 0,0 you get 0 pts")
// extraction → directive → valuator selection
// ─────────────────────────────────────────────

describe("deliberate — nullified delivery tile (mult=0 at (0,0))", () => {
	// Two delivery tiles: (0,0) and (5,0); walkable between.
	function twoDeliveries() {
		const map = createStaticMap();
		const tiles: IOTile[] = [
			{ x: 0, y: 0, type: "2" as IOTile["type"] },
			{ x: 1, y: 0, type: "1" as IOTile["type"] },
			{ x: 2, y: 0, type: "1" as IOTile["type"] },
			{ x: 3, y: 0, type: "1" as IOTile["type"] },
			{ x: 4, y: 0, type: "1" as IOTile["type"] },
			{ x: 5, y: 0, type: "2" as IOTile["type"] },
		];
		setMap(map, tiles);
		return map;
	}

	const nullifyOrigin = (): ActiveDirectives => ({
		...emptyDirectives(),
		modifiers: [
			{
				selector: { on: "deliver", tile: { x: 0, y: 0 } },
				effect: { mult: 0 },
				lifetime: "persistent",
				missionId: "m1",
				target: "both",
			},
		],
	});

	it("carrying near (0,0): steers delivery to the non-nullified tile (5,0)", () => {
		const map = twoDeliveries();
		// self at x=1 → (0,0) is nearest (dist 1), (5,0) is far (dist 4).
		const withoutMod = deliberate(
			makeContext({ map, selfX: 1, carry: carryOf([30]) }),
		);
		expect(withoutMod.intention?.targetXY).toEqual(
			expect.objectContaining({ x: 0, y: 0 }),
		);

		const withMod = deliberate(
			makeContext({
				map,
				selfX: 1,
				carry: carryOf([30]),
				directives: nullifyOrigin(),
			}),
		);
		expect(withMod.intention?.kind).toBe("deliver");
		expect(withMod.intention?.targetXY).toEqual(
			expect.objectContaining({ x: 5, y: 0 }),
		);
	});

	it("deliverTileBlocked is true at (0,0), false elsewhere", () => {
		const dir = nullifyOrigin();
		expect(deliverTileBlocked(dir, { x: 0, y: 0 })).toBe(true);
		expect(deliverTileBlocked(dir, { x: 5, y: 0 })).toBe(false);
	});
});
