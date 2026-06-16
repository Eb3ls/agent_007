import {
	assignRoles,
	evalHandoff,
	evalRendezvous,
	findDropTile,
} from "../mission/l3_executor.js";
import { createStaticMap, setMap } from "../static_map.js";
import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";
import { createBeliefStore } from "../belief_store.js";
import type { StaticMap } from "../static_map.js";
import { bfsFromSelf } from "../pathfinder.js";
import { describe, expect, it } from "vitest";

function makeMinimalMap(): StaticMap {
	const m = createStaticMap();
	// 5×5 grid: all tiles walkable type "1", delivery at (4,0)
	const tiles: IOTile[] = [];
	for (let x = 0; x < 5; x++) {
		for (let y = 0; y < 5; y++) {
			const type = x === 4 && y === 0 ? "2" : "1";
			tiles.push({ x, y, type });
		}
	}
	setMap(m, tiles);
	return m;
}

function makeBeliefs() {
	const b = createBeliefStore();
	// Free parcel at (0,0)
	b.parcels.set("p1", {
		id: "p1",
		x: 0,
		y: 0,
		reward: 100,
		lastSeenAt: Date.now(),
		confidence: 1,
		inView: true,
		inViewBy: new Set(),
	});
	return b;
}

describe("l3_executor pure helpers", () => {
	const map = makeMinimalMap();
	const beliefs = makeBeliefs();

	it("assignRoles: agent at (0,0) is carrier (near parcel), agent at (4,0) is receiver", () => {
		const roles = assignRoles(
			map,
			beliefs,
			{ x: 0, y: 0 },
			{ x: 4, y: 0 },
			"bdi",
			"llm",
		);
		expect(roles).not.toBeNull();
		expect(roles!.carrier).toBe("bdi");
		expect(roles!.receiver).toBe("llm");
	});

	it("assignRoles: returns null when no free parcels", () => {
		const emptyBeliefs = createBeliefStore();
		const roles = assignRoles(
			map,
			emptyBeliefs,
			{ x: 0, y: 0 },
			{ x: 4, y: 0 },
			"bdi",
			"llm",
		);
		expect(roles).toBeNull();
	});

	it("findDropTile: finds a tile reachable by both agents that is not delivery", () => {
		const bfsA = bfsFromSelf(map, 0, 0);
		const bfsB = bfsFromSelf(map, 4, 0);
		const drop = findDropTile(map, beliefs, bfsA, bfsB);
		expect(drop).not.toBeNull();
		expect(drop!.x === 4 && drop!.y === 0).toBe(false); // not delivery tile
	});

	it("evalHandoff: returns lower EV with higher decayRate", () => {
		const base = {
			missionBonus: 500,
			relayReward: 200,
			oppRate: 0.001,
			carrierCarryN: 1,
			M: 100,
			setupSteps: 5,
			serialSteps: 1,
			dropTile: { x: 2, y: 2 },
			map,
			beliefs,
			parkedReward: 200,
		};
		const ev0 = evalHandoff({ ...base, decayRate: 0 });
		const ev1 = evalHandoff({ ...base, decayRate: 0.01 });
		expect(ev0).toBeGreaterThan(ev1);
	});

	it("evalRendezvous: positive EV for small setup + zero decay", () => {
		const ev = evalRendezvous({
			missionBonus: 500,
			oppRate: 0,
			carrierCarryN: 0,
			decayRate: 0,
			M: 100,
			setupSteps: 3,
			dropTile: { x: 2, y: 2 },
			map,
			beliefs,
			parkedReward: 0,
		});
		expect(ev).toBeGreaterThan(0);
	});
});
