import {
	checkReachability,
	computeDeadSquares,
	findBridgeCrateTile,
} from "../mission/crate_planner.js";
import { createStaticMap, setMap, tileId } from "../static_map.js";
import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";
import { describe, expect, it } from "vitest";

// ── helpers ───────────────────────────────────────────────────────────────────

function tile(x: number, y: number, type: IOTile["type"]): IOTile {
	return { x, y, type };
}

function make3x3(): ReturnType<typeof createStaticMap> {
	const map = createStaticMap();
	const tiles: IOTile[] = [];
	for (let x = 0; x < 3; x++)
		for (let y = 0; y < 3; y++) tiles.push(tile(x, y, "5"));
	setMap(map, tiles);
	return map;
}

/**
 * Map for push / reachability tests:
 *
 *   y=2: (1,2)=5
 *   y=1: (1,1)=5
 *   y=0: (0,0)=5  (1,0)=5crate  (2,0)=5  (3,0)=2delivery
 *   y=-1: (0,-1)=5  (1,-1)=5
 *   y=-2: (1,-2)=5
 *
 * Delivery is only reachable via (1,0) after the crate is pushed up to (1,1).
 */
function makePushMap(): ReturnType<typeof createStaticMap> {
	const map = createStaticMap();
	setMap(map, [
		tile(0, 0, "5"),
		tile(1, 0, "5"),
		tile(2, 0, "5"),
		tile(3, 0, "2"),
		tile(1, 1, "5"),
		tile(1, 2, "5"),
		tile(0, -1, "5"),
		tile(1, -1, "5"),
		tile(1, -2, "5"),
	]);
	return map;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("computeDeadSquares", () => {
	it("marks every tile in a 2-tile horizontal strip as dead", () => {
		// Push along H axis requires type-5 on BOTH sides: neither end has a neighbour on
		// the far side, so no push is possible in any direction → both tiles are dead.
		const map = createStaticMap();
		setMap(map, [tile(0, 0, "5"), tile(1, 0, "5")]);
		const dead = computeDeadSquares(map);

		expect(dead.has(tileId(map, 0, 0))).toBe(true);
		expect(dead.has(tileId(map, 1, 0))).toBe(true);
	});

	it("marks an isolated single type-5 tile as dead", () => {
		const map = createStaticMap();
		setMap(map, [tile(0, 0, "5")]);
		const dead = computeDeadSquares(map);

		expect(dead.has(tileId(map, 0, 0))).toBe(true);
		expect(dead.size).toBe(1);
	});

	it("marks corners of a 3x3 type-5 grid as dead, edges/center not dead", () => {
		const map = make3x3();
		const dead = computeDeadSquares(map);

		// Corners: both axes lack a full pair of type-5 neighbours.
		expect(dead.has(tileId(map, 0, 0))).toBe(true);
		expect(dead.has(tileId(map, 2, 0))).toBe(true);
		expect(dead.has(tileId(map, 0, 2))).toBe(true);
		expect(dead.has(tileId(map, 2, 2))).toBe(true);

		// Edge midpoints have a full pair in one axis → not dead.
		expect(dead.has(tileId(map, 1, 0))).toBe(false); // canPushH: left+right both 5
		expect(dead.has(tileId(map, 0, 1))).toBe(false); // canPushV: up+down both 5
		expect(dead.has(tileId(map, 2, 1))).toBe(false);
		expect(dead.has(tileId(map, 1, 2))).toBe(false);

		// Center.
		expect(dead.has(tileId(map, 1, 1))).toBe(false);
	});
});

describe("findBridgeCrateTile", () => {
	it("returns the crate tile that, when removed, restores delivery reachability", () => {
		// Narrow corridor: agent(0,0) — crate(1,0) — delivery(2,0).
		const map = createStaticMap();
		setMap(map, [tile(0, 0, "5"), tile(1, 0, "5"), tile(2, 0, "2")]);

		const agentTile = tileId(map, 0, 0);
		const crateTile = tileId(map, 1, 0);
		const result = findBridgeCrateTile(
			map,
			agentTile,
			[crateTile],
			map.deliveryTileIds,
		);

		expect(result).toBe(crateTile);
	});

	it("returns null when delivery is already reachable", () => {
		const map = createStaticMap();
		setMap(map, [tile(0, 0, "5"), tile(1, 0, "2")]);

		const agentTile = tileId(map, 0, 0);
		const result = findBridgeCrateTile(
			map,
			agentTile,
			[],
			map.deliveryTileIds,
		);

		expect(result).toBeNull();
	});

	it("returns null when two sequential crates both block delivery (no single removal helps)", () => {
		// corridor: agent(0,0) — crate(1,0) — crate(2,0) — delivery(3,0)
		// Removing only crate1: crate2 still blocks.
		// Removing only crate2: crate1 still blocks.
		const map = createStaticMap();
		setMap(map, [
			tile(0, 0, "5"),
			tile(1, 0, "5"),
			tile(2, 0, "5"),
			tile(3, 0, "2"),
		]);
		const agentTile = tileId(map, 0, 0);
		const crate1 = tileId(map, 1, 0);
		const crate2 = tileId(map, 2, 0);

		const result = findBridgeCrateTile(
			map,
			agentTile,
			[crate1, crate2],
			map.deliveryTileIds,
		);

		expect(result).toBeNull();
	});
});

describe("checkReachability", () => {
	it("reports blocked + correct bridge crate when crate obstructs delivery", () => {
		const map = makePushMap();
		const agentTile = tileId(map, 0, 0);
		const crateTile = tileId(map, 1, 0);

		const status = checkReachability(map, agentTile, [crateTile]);

		expect(status.deliveryReachable).toBe(false);
		expect(status.bridgeCrateTile).toBe(crateTile);
	});

	it("reports reachable when no crates block delivery", () => {
		const map = makePushMap();
		const agentTile = tileId(map, 0, 0);

		const status = checkReachability(map, agentTile, []);

		expect(status.deliveryReachable).toBe(true);
		expect(status.bridgeCrateTile).toBeNull();
	});
});

describe("planCrateNavPath", () => {
	it("returns null when called with an unreachable target on an empty map", async () => {
		// Single isolated tile — ENHSP will find no plan (no adjacency to target).
		const map = createStaticMap();
		setMap(map, [tile(0, 0, "5")]);
		const beliefs = {
			crates: new Map(),
			parcels: new Map(),
			agents: new Map(),
		} as unknown as import("../belief_store.js").BeliefStore;

		const { planCrateNavPath } =
			await import("../mission/crate_planner.js");
		const result = await planCrateNavPath(map, beliefs, 0, 0, 99, 99);
		expect(result).toBeNull();
	});
});
