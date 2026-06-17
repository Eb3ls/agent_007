import { createBeliefStore, type ParcelBelief } from "../belief_store.js";
import { checkIntentionViability } from "../core/reconsider.js";
import { createStaticMap, setMap } from "../static_map.js";
import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";
import { makeIntention } from "../core/intention.js";
import { bfsFromSelf } from "../pathfinder.js";
import { describe, expect, it } from "vitest";

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
