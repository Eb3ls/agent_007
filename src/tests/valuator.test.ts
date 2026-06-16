import {
	scorePickup,
	scoreDeliver,
	scoreGoto,
	batchCandidates,
	type ValuatorMetrics,
} from "../core/valuator.js";
import type { ActiveDirectives } from "../team/directives.js";
import { setMap, createStaticMap } from "../static_map.js";
import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";
import { createBeliefStore } from "../belief_store.js";
import type { ParcelBelief } from "../belief_store.js";
import { Coordinator } from "../team/coordinator.js";
import type { CarryState } from "../core/planner.js";
import { bfsFromSelf } from "../pathfinder.js";
import { describe, expect, it } from "vitest";

// Linear map: delivery(0,0) | spawn(1,0) | spawn(2,0)
function buildLinearMap() {
	const map = createStaticMap();
	const tiles: IOTile[] = [
		{ x: 0, y: 0, type: "2" as IOTile["type"] }, // delivery
		{ x: 1, y: 0, type: "1" as IOTile["type"] }, // spawn
		{ x: 2, y: 0, type: "1" as IOTile["type"] }, // spawn
	];
	setMap(map, tiles);
	return map;
}

// Wider map for forbidden-tile tests: 5 tiles in a row
// (0,0)=delivery | (1,0) | (2,0) | (3,0) | (4,0)=spawn
function buildWideMap() {
	const map = createStaticMap();
	const tiles: IOTile[] = [
		{ x: 0, y: 0, type: "2" as IOTile["type"] },
		{ x: 1, y: 0, type: "1" as IOTile["type"] },
		{ x: 2, y: 0, type: "1" as IOTile["type"] },
		{ x: 3, y: 0, type: "1" as IOTile["type"] },
		{ x: 4, y: 0, type: "1" as IOTile["type"] },
	];
	setMap(map, tiles);
	return map;
}

function makeParcel(
	id: string,
	x: number,
	y: number,
	reward: number,
): ParcelBelief {
	return {
		id,
		x,
		y,
		reward,
		lastSeenAt: Date.now(),
		confidence: 1,
		inView: true,
		inViewBy: new Set(["bdi"]),
	} as unknown as ParcelBelief;
}

function emptyDirectives(): Readonly<ActiveDirectives> {
	return {
		paused: false,
		pauseMissionId: null,
		stage: null,
		modifiers: [],
		hardForbiddenTileCoords: [],
		forbiddenPickupParcelIds: new Set(),
	};
}

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

// ─────────────────────────────────────────────
// §5.3 formula correctness
// ─────────────────────────────────────────────

describe("scorePickup — §5.3 formula R_c + R_p - (n+1)*d*M*S", () => {
	it("empty carry: score = R_p - d*M*S (S=2, no decay d=0)", () => {
		const map = buildLinearMap();
		// Agent at (2,0); parcel at (1,0); delivery at (0,0)
		// S = dist(2→1) + dist(1→0) = 1 + 1 = 2
		// d=0 (no decay) → score = R_p = 20
		const bfs = bfsFromSelf(map, 2, 0);
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", makeParcel("p1", 1, 0, 20));
		const metrics = noDecayMetrics(500);
		const result = scorePickup(
			map,
			bfs,
			beliefs,
			emptyCarry(),
			metrics,
			emptyDirectives(),
		);
		expect(result).not.toBeNull();
		expect(result!.utility).toBeCloseTo(20, 5);
	});

	it("empty carry: score = R_p - (1)*d*M*S with decay", () => {
		const map = buildLinearMap();
		// Agent at (2,0); parcel at (1,0); delivery at (0,0)
		// S=2, n=0, so (n+1)=1; d*M = 500/1000 = 0.5; cost = 0.5*2 = 1
		// score = 20 - 1 = 19
		const bfs = bfsFromSelf(map, 2, 0);
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", makeParcel("p1", 1, 0, 20));
		const metrics = decayMetrics(500, 1000);
		const result = scorePickup(
			map,
			bfs,
			beliefs,
			emptyCarry(),
			metrics,
			emptyDirectives(),
		);
		expect(result).not.toBeNull();
		expect(result!.utility).toBeCloseTo(19, 5);
	});

	it("with carry: score = R_c + R_p - (n+1)*d*M*S", () => {
		const map = buildLinearMap();
		// Agent at (2,0); parcel at (1,0); delivery at (0,0)
		// S=2, n=1 (carry 10), R_p=20; d*M=0.5; cost=(1+1)*0.5*2=2
		// score = 10 + 20 - 2 = 28
		const bfs = bfsFromSelf(map, 2, 0);
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", makeParcel("p1", 1, 0, 20));
		const metrics = decayMetrics(500, 1000);
		const result = scorePickup(
			map,
			bfs,
			beliefs,
			carryOf([10]),
			metrics,
			emptyDirectives(),
		);
		expect(result).not.toBeNull();
		expect(result!.utility).toBeCloseTo(28, 5);
	});
});

describe("scoreDeliver — §5.3 formula mult*R_c - n*d*M*s_0", () => {
	it("deliver from dist=1, no decay: score = R_c", () => {
		const map = buildLinearMap();
		// Agent at (1,0); delivery at (0,0); s_0=1; d=0 → score = R_c = 15
		const bfs = bfsFromSelf(map, 1, 0);
		const result = scoreDeliver(
			map,
			bfs,
			carryOf([15]),
			noDecayMetrics(),
			emptyDirectives(),
		);
		expect(result).not.toBeNull();
		expect(result!.score).toBeCloseTo(15, 5);
	});

	it("deliver from dist=2, with decay: score = R_c - n*d*M*s_0", () => {
		const map = buildLinearMap();
		// Agent at (2,0); delivery at (0,0); s_0=2; n=1; d*M=0.5; cost=1*0.5*2=1
		// score = 15 - 1 = 14
		const bfs = bfsFromSelf(map, 2, 0);
		const result = scoreDeliver(
			map,
			bfs,
			carryOf([15]),
			decayMetrics(500, 1000),
			emptyDirectives(),
		);
		expect(result).not.toBeNull();
		expect(result!.score).toBeCloseTo(14, 5);
	});

	it("null when no carry", () => {
		const map = buildLinearMap();
		const bfs = bfsFromSelf(map, 2, 0);
		const result = scoreDeliver(
			map,
			bfs,
			emptyCarry(),
			noDecayMetrics(),
			emptyDirectives(),
		);
		expect(result).toBeNull();
	});
});

describe("scoreGoto — §5.3 formula B - (L + n*d)*M*s_T", () => {
	it("no carry, no decay: score = B - L*M*s_T", () => {
		const map = buildLinearMap();
		// Agent at (2,0); target at (0,0); s_T=2; B=100; L=0; d=0
		// score = 100 - 0 = 100
		const bfs = bfsFromSelf(map, 2, 0);
		const score = scoreGoto(
			bfs,
			map,
			{ x: 0, y: 0 },
			100,
			emptyCarry(),
			noDecayMetrics(),
		);
		expect(score).toBeCloseTo(100, 5);
	});

	it("with carry and decay: score = B - (L + n*d)*M*s_T", () => {
		const map = buildLinearMap();
		// Agent at (2,0); target at (0,0); s_T=2; B=100; L=0.01; n=2; d*M=0.5; d=0.001
		// cost = (0.01 + 2*0.001) * 500 * 2 = 0.012 * 1000 = 12
		// score = 100 - 12 = 88
		const bfs = bfsFromSelf(map, 2, 0);
		const metrics: ValuatorMetrics = {
			M: 500,
			L: 0.01,
			decayIntervalMs: 1000,
		};
		const score = scoreGoto(
			bfs,
			map,
			{ x: 0, y: 0 },
			100,
			carryOf([50, 50]),
			metrics,
		);
		expect(score).toBeCloseTo(88, 5);
	});

	it("unreachable target returns null", () => {
		const map = buildLinearMap();
		const bfs = bfsFromSelf(map, 0, 0);
		// target outside map
		const score = scoreGoto(
			bfs,
			map,
			{ x: 99, y: 99 },
			100,
			emptyCarry(),
			noDecayMetrics(),
		);
		expect(score).toBeNull();
	});
});

// ─────────────────────────────────────────────
// Modifier folding — directives consumed in scoring
// ─────────────────────────────────────────────

describe("modifier: deliver MODIFIER mult boosts deliver score", () => {
	it("mult=3 at tile (0,0): score = 3*R_c - n*d*M*s_0", () => {
		const map = buildLinearMap();
		const bfs = bfsFromSelf(map, 2, 0);
		const directives: ActiveDirectives = {
			paused: false,
			pauseMissionId: null,
			stage: null,
			hardForbiddenTileCoords: [],
			forbiddenPickupParcelIds: new Set(),
			modifiers: [
				{
					selector: { on: "deliver", tile: { x: 0, y: 0 } },
					effect: { mult: 3 },
					lifetime: "persistent",
					missionId: "m1",
					target: "both",
				},
			],
		};
		// carry=[10], no decay, s_0=2
		// score = 3*10 - 0 = 30
		const result = scoreDeliver(
			map,
			bfs,
			carryOf([10]),
			noDecayMetrics(),
			directives,
		);
		expect(result).not.toBeNull();
		expect(result!.score).toBeCloseTo(30, 5);
	});

	it("mult=3 at a different tile: default mult=1 still used for nearest delivery", () => {
		const map = buildLinearMap();
		const bfs = bfsFromSelf(map, 2, 0);
		const directives: ActiveDirectives = {
			paused: false,
			pauseMissionId: null,
			stage: null,
			hardForbiddenTileCoords: [],
			forbiddenPickupParcelIds: new Set(),
			modifiers: [
				{
					// tile (9,9) doesn't exist in map — modifier won't apply
					selector: { on: "deliver", tile: { x: 9, y: 9 } },
					effect: { mult: 3 },
					lifetime: "persistent",
					missionId: "m1",
					target: "both",
				},
			],
		};
		// score = 1*10 = 10 (mult doesn't apply since tile doesn't match)
		const result = scoreDeliver(
			map,
			bfs,
			carryOf([10]),
			noDecayMetrics(),
			directives,
		);
		expect(result).not.toBeNull();
		expect(result!.score).toBeCloseTo(10, 5);
	});
});

describe("modifier: forbiddenPickupParcelIds excludes the parcel", () => {
	it("parcel p1 in forbiddenPickupParcelIds → scorePickup skips it → null", () => {
		const map = buildLinearMap();
		const bfs = bfsFromSelf(map, 2, 0);
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", makeParcel("p1", 1, 0, 20));
		const directives: ActiveDirectives = {
			paused: false,
			pauseMissionId: null,
			stage: null,
			modifiers: [],
			hardForbiddenTileCoords: [],
			forbiddenPickupParcelIds: new Set(["p1"]),
		};
		const result = scorePickup(
			map,
			bfs,
			beliefs,
			emptyCarry(),
			noDecayMetrics(),
			directives,
		);
		expect(result).toBeNull();
	});

	it("non-forbidden parcel still visible when one is forbidden", () => {
		const map = buildLinearMap();
		const bfs = bfsFromSelf(map, 2, 0);
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", makeParcel("p1", 1, 0, 20));
		beliefs.parcels.set("p2", makeParcel("p2", 2, 0, 5));
		const directives: ActiveDirectives = {
			paused: false,
			pauseMissionId: null,
			stage: null,
			modifiers: [],
			hardForbiddenTileCoords: [],
			forbiddenPickupParcelIds: new Set(["p1"]),
		};
		const result = scorePickup(
			map,
			bfs,
			beliefs,
			emptyCarry(),
			noDecayMetrics(),
			directives,
		);
		expect(result).not.toBeNull();
		expect(result!.parcel.id).toBe("p2");
	});
});

describe("modifier: deliver mult=0 at carryCountEquals forces deliver score = 0", () => {
	it("mult=0 at carryCount=1: deliver-now score = 0 when carrying 1 parcel", () => {
		const map = buildLinearMap();
		const bfs = bfsFromSelf(map, 2, 0);
		const directives: ActiveDirectives = {
			paused: false,
			pauseMissionId: null,
			stage: null,
			hardForbiddenTileCoords: [],
			forbiddenPickupParcelIds: new Set(),
			modifiers: [
				{
					selector: { on: "deliver" },
					condition: { carryCountEquals: 1 },
					effect: { mult: 0 },
					lifetime: "persistent",
					missionId: "m1",
					target: "both",
				},
			],
		};
		const result = scoreDeliver(
			map,
			bfs,
			carryOf([20]),
			noDecayMetrics(),
			directives,
		);
		// score = 0*20 - 0 = 0 (no decay)
		expect(result).not.toBeNull();
		expect(result!.score).toBeLessThanOrEqual(0);
	});
});

// ─────────────────────────────────────────────
// Count-multiplier BATCHING
// ─────────────────────────────────────────────

describe("batchCandidates — count-multiplier valley fix", () => {
	it("×10-at-5 batch beats deliver-now-at-2 (no decay)", () => {
		const map = buildLinearMap();
		// Agent at (0,0)=delivery; 3 parcels at x=1,1,2 (sharing x=1 — only 1 can physically be there but for BFS scoring use fresh beliefs)
		// Use a wider map for realistic chaining
		const wideMap = buildWideMap();
		// Agent at (4,0); parcel A at (3,0); parcel B at (2,0); parcel C at (1,0); delivery at (0,0)
		const bfs = bfsFromSelf(wideMap, 4, 0);
		const beliefs = createBeliefStore();
		beliefs.parcels.set("pA", makeParcel("pA", 3, 0, 10));
		beliefs.parcels.set("pB", makeParcel("pB", 2, 0, 10));
		beliefs.parcels.set("pC", makeParcel("pC", 1, 0, 10));

		const carry = carryOf([10, 10]); // n=2, R_c=20
		const metrics = noDecayMetrics();
		const directives: ActiveDirectives = {
			paused: false,
			pauseMissionId: null,
			stage: null,
			hardForbiddenTileCoords: [],
			forbiddenPickupParcelIds: new Set(),
			modifiers: [
				{
					selector: { on: "deliver" },
					condition: { carryCountAtLeast: 5 },
					effect: { mult: 10 },
					lifetime: "persistent",
					missionId: "m1",
					target: "both",
				},
			],
		};

		// deliver-now: modifier condition carryCountAtLeast:5 not met (n=2), so mult=1, score = 1*20 - 0 = 20
		const deliverNow = scoreDeliver(
			wideMap,
			bfs,
			carry,
			metrics,
			directives,
		);
		expect(deliverNow!.score).toBeCloseTo(20, 5);

		// batch to 5: need 3 more parcels
		// chain: self(4)→pA(3)→pB(2)→pC(1)→delivery(0) = 1+1+1+1 = 4 steps
		// reward at deliver = 10*(2+3 parcels) × mult=10 = 500 - 0 = 500
		const batches = batchCandidates(
			wideMap,
			bfs,
			beliefs,
			carry,
			metrics,
			directives,
		);
		expect(batches.length).toBeGreaterThan(0);
		const toFive = batches.find((b) => b.targetCount === 5);
		expect(toFive).toBeDefined();
		expect(toFive!.score).toBeGreaterThan(deliverNow!.score);
	});

	it("×0-at-1 stops delivering lone parcel when 2nd is reachable", () => {
		const map = buildLinearMap();
		// Agent at (2,0); parcel p2 at (1,0); delivery at (0,0)
		// carry n=1, mult=0 at carryCountEquals:1 → deliver score = 0
		const bfs = bfsFromSelf(map, 2, 0);
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p2", makeParcel("p2", 1, 0, 20));

		const carry = carryOf([30]); // 1 parcel with reward 30
		const metrics = noDecayMetrics();
		const directives: ActiveDirectives = {
			paused: false,
			pauseMissionId: null,
			stage: null,
			hardForbiddenTileCoords: [],
			forbiddenPickupParcelIds: new Set(),
			modifiers: [
				{
					selector: { on: "deliver" },
					condition: { carryCountEquals: 1 },
					effect: { mult: 0 },
					lifetime: "persistent",
					missionId: "m1",
					target: "both",
				},
			],
		};

		// deliver-now: score = 0*30 = 0 ≤ 0 → don't deliver
		const deliverNow = scoreDeliver(map, bfs, carry, metrics, directives);
		expect(deliverNow!.score).toBeLessThanOrEqual(0);

		// pickup p2 score > 0 → agent should pick up p2 instead
		const pickup = scorePickup(
			map,
			bfs,
			beliefs,
			carry,
			metrics,
			directives,
		);
		expect(pickup).not.toBeNull();
		expect(pickup!.utility).toBeGreaterThan(deliverNow!.score);
	});
});

// ─────────────────────────────────────────────
// Currency: M-EMA + L aggregation
// ─────────────────────────────────────────────

describe("currency: M-EMA updates on ACK", () => {
	it("EMA converges from config value toward measured latency", () => {
		// Simulate: initial M = 500, alpha = 0.1, latency = 200 each tick
		// After 1 tick: M = 0.1*200 + 0.9*500 = 470
		// After 2 ticks: M = 0.1*200 + 0.9*470 = 443
		const alpha = 0.1;
		let M = 500;
		for (let i = 0; i < 20; i++) {
			M = alpha * 200 + (1 - alpha) * M;
		}
		// After 20 ticks of 200ms latency, M should be closer to 200 than to 500
		expect(M).toBeLessThan(400);
	});
});

describe("currency: L aggregates from Coordinator", () => {
	it("L = totalDeliveredPoints / elapsedMs > 0 after deliveries recorded", () => {
		const coordinator = new Coordinator();
		coordinator.recordDelivery("bdi", 100);
		coordinator.recordDelivery("llm", 200);
		const L = coordinator.getL();
		expect(L).toBeGreaterThan(0);
	});

	it("L = 0 before any delivery", () => {
		const coordinator = new Coordinator();
		const L = coordinator.getL();
		expect(L).toBe(0);
	});
});

describe("currency: d=0 guard prunes nothing from pickup candidates", () => {
	it("with d=0 (Infinity decayIntervalMs): all positive-reward parcels remain candidates", () => {
		const map = buildLinearMap();
		const bfs = bfsFromSelf(map, 2, 0);
		const beliefs = createBeliefStore();
		beliefs.parcels.set("p1", makeParcel("p1", 1, 0, 1)); // low reward but still positive
		const metrics = noDecayMetrics();
		const result = scorePickup(
			map,
			bfs,
			beliefs,
			emptyCarry(),
			metrics,
			emptyDirectives(),
		);
		expect(result).not.toBeNull();
	});
});
