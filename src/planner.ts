import { reconstructPath, type BfsFromSelf, type Direction } from "./pathfinder.js";
import { idToXY, inBounds, tileId, type StaticMap } from "./static_map.js";
import type { BeliefStore, ParcelBelief } from "./belief_store.js";
import type { IOParcel } from "@unitn-asa/deliveroo-js-sdk";
import { SHORT_BLOCK_TTL_MS } from "./config.js";

export function computeBlockedTiles(m: StaticMap, beliefs: BeliefStore): Set<number> {
	const blocked = new Set<number>();
	const now = Date.now();
	for (const a of beliefs.agents.values()) {
		if (!a.inView && now - a.lastSeenAt > SHORT_BLOCK_TTL_MS) continue;
		if (a.x === undefined || a.y === undefined) continue;
		const ax = Math.round(a.x);
		const ay = Math.round(a.y);
		if (!inBounds(m, ax, ay)) continue;
		blocked.add(tileId(m, ax, ay));
	}
	return blocked;
}

export function nearestDeliveryTile(
	m: StaticMap,
	bfs: BfsFromSelf,
): { x: number; y: number } | null {
	let bestId = -1,
		bestDist = Infinity;
	for (const did of m.deliveryTileIds) {
		const d = bfs.dist[did];
		if (d !== undefined && d !== -1 && d < bestDist) {
			bestDist = d;
			bestId = did;
		}
	}
	return bestId === -1 ? null : idToXY(m, bestId);
}

export function nearestOutOfViewSpawn(
	m: StaticMap,
	bfs: BfsFromSelf,
	sx: number,
	sy: number,
	observationDistance: number,
): { x: number; y: number } | null {
	let bestId = -1;
	let bestCost = Infinity;
	for (const sid of m.spawnTileIds) {
		const sp = bfs.dist[sid];
		if (sp === undefined || sp <= 0) continue;
		const sd = m.baseReverseDistToDelivery[sid];
		if (sd === undefined || sd === -1) continue;
		const { x, y } = idToXY(m, sid);
		if (Math.max(Math.abs(x - sx), Math.abs(y - sy)) <= observationDistance) continue;
		const cost = sp + sd;
		if (cost < bestCost) {
			bestCost = cost;
			bestId = sid;
		}
	}
	return bestId === -1 ? null : idToXY(m, bestId);
}

export function shouldDrop(m: StaticMap, selfId: number, carrying: boolean): boolean {
	return carrying && m.baseReverseDistToDelivery[selfId] === 0;
}

export function parcelHere(
	parcels: Map<string, IOParcel>,
	sx: number,
	sy: number,
): IOParcel | undefined {
	for (const p of parcels.values()) {
		if (p.x === sx && p.y === sy && !p.carriedBy) return p;
	}
	return undefined;
}

export function currentReward(p: ParcelBelief, decayIntervalMs: number, now: number): number {
	if (!Number.isFinite(decayIntervalMs)) return p.reward;
	return p.reward - Math.floor((now - p.firstSeenAt) / decayIntervalMs);
}

export function pickBestParcelTarget(
	m: StaticMap,
	bfs: BfsFromSelf,
	beliefs: BeliefStore,
	decayIntervalMs: number,
	movementDurationMs: number,
): IOParcel | null {
	const now = Date.now();
	const decayPerStep = Number.isFinite(decayIntervalMs)
		? movementDurationMs / decayIntervalMs
		: 0;
	let best: ParcelBelief | null = null;
	let bestUtility = -Infinity;
	let bestSp = Infinity;
	for (const p of beliefs.parcels.values()) {
		if (!p.inView) continue;
		if (p.carriedBy) continue;
		const pid = tileId(m, p.x, p.y);
		const sp = bfs.dist[pid];
		if (sp === undefined || sp === -1) continue;
		const sd = m.baseReverseDistToDelivery[pid];
		if (sd === undefined || sd === -1) continue;
		const reward = currentReward(p, decayIntervalMs, now);
		if (reward <= 0) continue;
		const utility = reward - decayPerStep * (sp + sd);
		if (utility <= 0) continue;
		if (utility > bestUtility || (utility === bestUtility && sp < bestSp)) {
			bestUtility = utility;
			bestSp = sp;
			best = p;
		}
	}
	return best;
}

export function planStep(
	m: StaticMap,
	bfs: BfsFromSelf,
	carrying: boolean,
	target: IOParcel | null,
	exploreTarget: { x: number; y: number } | null,
): Direction | null {
	const dest = carrying
		? nearestDeliveryTile(m, bfs)
		: target
			? { x: target.x, y: target.y }
			: exploreTarget;
	if (!dest) return null;
	return reconstructPath(m, bfs, dest.x, dest.y)?.[0] ?? null;
}
