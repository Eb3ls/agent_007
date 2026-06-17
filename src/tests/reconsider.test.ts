import {
	checkIntentionViability,
	computeCurrentIntentionUtility,
} from "../core/reconsider.js";
import {
	scoreGoto,
	scoreDeliver,
	type ValuatorMetrics,
} from "../core/valuator.js";
import { createBeliefStore, type ParcelBelief } from "../belief_store.js";
import type { ActiveDirectives } from "../team/directives.js";
import { createStaticMap, setMap } from "../static_map.js";
import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";
import { makeIntention } from "../core/intention.js";
import type { CarryState } from "../core/planner.js";
import { bfsFromSelf } from "../pathfinder.js";
import { describe, expect, it } from "vitest";

function noDecayMetrics(M = 500): ValuatorMetrics {
	return { M, L: 0, decayIntervalMs: Infinity };
}

function decayMetrics(M = 500, decayIntervalMs = 1000): ValuatorMetrics {
	return { M, L: 0, decayIntervalMs };
}

function emptyCarry(): CarryState {
	return { n: 0, rewards: [], nearestDeliveryDist: 0, ids: [] };
}

function carryOf(rewards: number[]): CarryState {
	return {
		n: rewards.length,
		rewards,
		nearestDeliveryDist: 0,
		ids: rewards.map((_, i) => `c${i}`),
	};
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

function buildMap() {
	const map = createStaticMap();
	const tiles: IOTile[] = [
		{ x: 0, y: 0, type: "2" as IOTile["type"] }, // delivery
		{ x: 1, y: 0, type: "1" as IOTile["type"] }, // pickup target
		{ x: 2, y: 0, type: "1" as IOTile["type"] }, // self
	];
	setMap(map, tiles);
	return map;
}

function parcel(p: Partial<ParcelBelief> & { id: string }): ParcelBelief {
	return {
		x: 1,
		y: 0,
		reward: 20,
		lastSeenAt: 1000,
		confidence: 1,
		inView: true,
		inViewBy: new Set(["bdi"]),
		...p,
	} as unknown as ParcelBelief;
}

describe("checkIntentionViability — granular target_lost detail", () => {
	const map = buildMap();
	const bfs = bfsFromSelf(map, 2, 0); // self at (2,0)
	const intention = makeIntention("pickup", { x: 1, y: 0 }, 1000, "p1");

	function viability(
		beliefs: ReturnType<typeof createBeliefStore>,
		now = 1000,
	) {
		// self (2,0) != target (1,0) so the on-tile branch is skipped
		return checkIntentionViability(
			"bdi",
			intention,
			beliefs,
			map,
			bfs,
			2,
			0,
			now,
			100,
		);
	}

	it("evicted: parcel missing from beliefs", () => {
		const b = createBeliefStore();
		const r = viability(b);
		expect(r).toEqual({
			viable: false,
			reason: "target_lost",
			detail: "evicted",
		});
	});

	it("stolen: carried by another agent", () => {
		const b = createBeliefStore();
		b.parcels.set("p1", parcel({ id: "p1", carriedBy: "enemy" }));
		const r = viability(b);
		expect(r).toEqual({
			viable: false,
			reason: "target_lost",
			detail: "stolen",
		});
	});

	it("moved: in-view at different coords", () => {
		const b = createBeliefStore();
		b.parcels.set("p1", parcel({ id: "p1", x: 0, y: 0, inView: true }));
		const r = viability(b);
		expect(r).toEqual({
			viable: false,
			reason: "target_lost",
			detail: "moved",
		});
	});

	it("stale: out of view, belief older than threshold", () => {
		const b = createBeliefStore();
		b.parcels.set("p1", parcel({ id: "p1", inView: false, lastSeenAt: 0 }));
		// now - 0 = 5000 > 100 * parcel_belief_stale_steps
		const r = viability(b, 5000);
		expect(r).toEqual({
			viable: false,
			reason: "target_lost",
			detail: "stale",
		});
	});

	it("not-on-tile: standing on target but parcel not ours", () => {
		const b = createBeliefStore();
		b.parcels.set("p1", parcel({ id: "p1" }));
		const onTile = makeIntention("pickup", { x: 2, y: 0 }, 1000, "p1");
		const r = checkIntentionViability(
			"bdi",
			onTile,
			b,
			map,
			bfs,
			2,
			0,
			1000,
			100,
		);
		expect(r).toEqual({
			viable: false,
			reason: "target_lost",
			detail: "not-on-tile",
		});
	});

	it("viable: in-view at target, reachable", () => {
		const b = createBeliefStore();
		b.parcels.set("p1", parcel({ id: "p1", inView: true }));
		const r = viability(b);
		expect(r).toEqual({ viable: true });
	});
});

// ─────────────────────────────────────────────
// computeCurrentIntentionUtility — per-kind dispatch
// ─────────────────────────────────────────────

describe("computeCurrentIntentionUtility — per-kind dispatch", () => {
	// map: delivery(0,0) | spawn(1,0) | self(2,0)
	const map = buildMap();
	const bfs = bfsFromSelf(map, 2, 0);

	it("explore → 0", () => {
		const intention = makeIntention("explore", { x: 1, y: 0 }, 1000);
		const result = computeCurrentIntentionUtility(
			intention,
			map,
			bfs,
			createBeliefStore(),
			emptyCarry(),
			noDecayMetrics(),
		);
		expect(result).toBe(0);
	});

	it("pickup: matches scoreOneParcel when parcel is in beliefs", () => {
		const beliefs = createBeliefStore();
		beliefs.parcels.set(
			"p1",
			parcel({ id: "p1", x: 1, y: 0, inView: true }),
		);
		const intention = makeIntention("pickup", { x: 1, y: 0 }, 1000, "p1");
		const metrics = decayMetrics(500, 1000);
		const result = computeCurrentIntentionUtility(
			intention,
			map,
			bfs,
			beliefs,
			emptyCarry(),
			metrics,
		);
		// S=2, d*M=0.5, score = 20 - 0.5*2 = 19
		expect(result).toBeCloseTo(19, 5);
	});

	it("pickup: missing parcel → 0", () => {
		const intention = makeIntention(
			"pickup",
			{ x: 1, y: 0 },
			1000,
			"missing",
		);
		const result = computeCurrentIntentionUtility(
			intention,
			map,
			bfs,
			createBeliefStore(),
			emptyCarry(),
			noDecayMetrics(),
		);
		expect(result).toBe(0);
	});

	it("pickup: parcel under deliver-parcel cap mult=0 → 0", () => {
		const beliefs = createBeliefStore();
		// reward=20, rewardOver=10, mult=0 → hard block
		beliefs.parcels.set(
			"p1",
			parcel({ id: "p1", x: 1, y: 0, reward: 20, inView: true }),
		);
		const intention = makeIntention("pickup", { x: 1, y: 0 }, 1000, "p1");
		const directives: ActiveDirectives = {
			...emptyDirectives(),
			modifiers: [
				{
					selector: { on: "deliver-parcel", rewardOver: 10 },
					effect: {},
					lifetime: "persistent",
					missionId: "cap1",
					target: "both",
				},
			],
		};
		const result = computeCurrentIntentionUtility(
			intention,
			map,
			bfs,
			beliefs,
			emptyCarry(),
			noDecayMetrics(),
			directives,
		);
		expect(result).toBe(0);
	});

	it("deliver: matches scoreDeliver (applies modifiers)", () => {
		const intention = makeIntention("deliver", { x: 0, y: 0 }, 1000);
		const carry = carryOf([10]);
		const metrics = noDecayMetrics();
		// ×5 modifier at delivery tile
		const directives: ActiveDirectives = {
			...emptyDirectives(),
			modifiers: [
				{
					selector: { on: "deliver", tile: { x: 0, y: 0 } },
					effect: { mult: 5 },
					lifetime: "persistent",
					missionId: "m1",
					target: "both",
				},
			],
		};
		const expected = scoreDeliver(map, bfs, carry, metrics, directives);
		const result = computeCurrentIntentionUtility(
			intention,
			map,
			bfs,
			createBeliefStore(),
			carry,
			metrics,
			directives,
		);
		expect(expected).not.toBeNull();
		expect(result).toBeCloseTo(expected!.score, 10);
		// score = 5*10 - 0 = 50 (no decay)
		expect(result).toBeCloseTo(50, 5);
	});

	it("goto: matches scoreGoto when modifier is active", () => {
		const intention = makeIntention(
			"goto",
			{ x: 0, y: 0 },
			1000,
			undefined,
			"g1",
		);
		const metrics = noDecayMetrics();
		const directives: ActiveDirectives = {
			...emptyDirectives(),
			modifiers: [
				{
					selector: { on: "goto", coords: [{ x: 0, y: 0 }] },
					effect: { add: 100 },
					lifetime: "persistent",
					missionId: "g1",
					target: "both",
				},
			],
		};
		const expected = scoreGoto(
			bfs,
			map,
			{ x: 0, y: 0 },
			100,
			emptyCarry(),
			metrics,
		);
		const result = computeCurrentIntentionUtility(
			intention,
			map,
			bfs,
			createBeliefStore(),
			emptyCarry(),
			metrics,
			directives,
		);
		expect(expected).not.toBeNull();
		expect(result).toBeCloseTo(expected!, 10);
	});

	it("goto: retracted modifier (missionId not found) → 0", () => {
		const intention = makeIntention(
			"goto",
			{ x: 0, y: 0 },
			1000,
			undefined,
			"g1",
		);
		// directives has no modifier for "g1"
		const result = computeCurrentIntentionUtility(
			intention,
			map,
			bfs,
			createBeliefStore(),
			emptyCarry(),
			noDecayMetrics(),
			emptyDirectives(),
		);
		expect(result).toBe(0);
	});

	it("goto: no directives → 0", () => {
		const intention = makeIntention(
			"goto",
			{ x: 0, y: 0 },
			1000,
			undefined,
			"g1",
		);
		const result = computeCurrentIntentionUtility(
			intention,
			map,
			bfs,
			createBeliefStore(),
			emptyCarry(),
			noDecayMetrics(),
		);
		expect(result).toBe(0);
	});
});

// ─────────────────────────────────────────────
// checkIntentionViability — directive-retraction checks
// ─────────────────────────────────────────────

describe("checkIntentionViability — directive-retraction checks", () => {
	const map = buildMap();
	const bfs = bfsFromSelf(map, 2, 0); // self at (2,0), not on target

	function viabilityWith(
		intention: ReturnType<typeof makeIntention>,
		dir?: Readonly<ActiveDirectives>,
	) {
		return checkIntentionViability(
			"bdi",
			intention,
			createBeliefStore(),
			map,
			bfs,
			2,
			0,
			1000,
			100,
			dir,
		);
	}

	it("goto-retracted: missionId not in modifiers → target_lost", () => {
		const intention = makeIntention(
			"goto",
			{ x: 0, y: 0 },
			1000,
			undefined,
			"g1",
		);
		const directives: ActiveDirectives = {
			...emptyDirectives(),
			// no modifier for "g1" → retracted
		};
		expect(viabilityWith(intention, directives)).toEqual({
			viable: false,
			reason: "target_lost",
			detail: "goto-retracted",
		});
	});

	it("goto-retracted: no directives → viable (no info to retract on)", () => {
		const intention = makeIntention(
			"goto",
			{ x: 0, y: 0 },
			1000,
			undefined,
			"g1",
		);
		// directives undefined → skip retraction check → still viable (aged/BFS checks pass)
		const result = viabilityWith(intention, undefined);
		expect(result.viable).toBe(true);
	});

	it("goto-retracted: stage-driven goto (no missionId) → viable", () => {
		// missionId undefined → not modifier-backed → skip retraction check
		const intention = makeIntention("goto", { x: 0, y: 0 }, 1000);
		const directives: ActiveDirectives = { ...emptyDirectives() };
		const result = viabilityWith(intention, directives);
		expect(result.viable).toBe(true);
	});

	it("goto active in modifiers → viable", () => {
		const intention = makeIntention(
			"goto",
			{ x: 0, y: 0 },
			1000,
			undefined,
			"g1",
		);
		const directives: ActiveDirectives = {
			...emptyDirectives(),
			modifiers: [
				{
					selector: { on: "goto", coords: [{ x: 0, y: 0 }] },
					effect: { add: 50 },
					lifetime: "persistent",
					missionId: "g1",
					target: "both",
				},
			],
		};
		const result = viabilityWith(intention, directives);
		expect(result.viable).toBe(true);
	});

	it("deliver-denied: deliver tile has unconditional mult=0 → target_lost", () => {
		const intention = makeIntention("deliver", { x: 0, y: 0 }, 1000);
		const directives: ActiveDirectives = {
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
		};
		expect(viabilityWith(intention, directives)).toEqual({
			viable: false,
			reason: "target_lost",
			detail: "deliver-denied",
		});
	});

	it("deliver-denied: conditional mult=0 → viable (deferred to scorer)", () => {
		const intention = makeIntention("deliver", { x: 0, y: 0 }, 1000);
		const directives: ActiveDirectives = {
			...emptyDirectives(),
			modifiers: [
				{
					selector: { on: "deliver", tile: { x: 0, y: 0 } },
					effect: { mult: 0 },
					condition: { carryCountAtLeast: 3 },
					lifetime: "persistent",
					missionId: "m1",
					target: "both",
				},
			],
		};
		// conditional block → deliverTileBlocked returns false → viable
		const result = viabilityWith(intention, directives);
		expect(result.viable).toBe(true);
	});
});
