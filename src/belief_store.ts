import type {
	IOAgent,
	IOCrate,
	IOParcel,
	IOSensing,
} from "@unitn-asa/deliveroo-js-sdk";
import { tileId, type StaticMap } from "./static_map.js";
import { MEMORY_DECAY_HORIZON_STEPS } from "./config.js";

export type ParcelBelief = IOParcel & {
	lastSeenAt: number;
	confidence: number;
	inView: boolean;
};
export type AgentBelief = IOAgent & {
	lastSeenAt: number;
	confidence: number;
	inView: boolean;
};
export type CrateBelief = IOCrate & {
	lastSeenAt: number;
	confidence: number;
	inView: boolean;
};

// Accumulated presence weight for competitor agents, keyed by "x,y".
// Decays exponentially between updates; updated each sensing from in-view agents.
export type CompetitorEntry = { weight: number; lastUpdate: number };

export type BeliefStore = {
	parcels: Map<string, ParcelBelief>;
	agents: Map<string, AgentBelief>;
	crates: Map<string, CrateBelief>;
	competitorHeatmap: Map<string, CompetitorEntry>; // key = "x,y"
	observedEmptySpawns: Map<number, number>; // tileId → lastSeenEmptyAt ms
};

const OUT_OF_VIEW_DECAY = 0.8;
const STALE_CONFIDENCE = 0.1;

export function beliefTrust(
	confidence: number,
	lastSeenAt: number,
	now: number,
	halfLifeMs: number,
	inView: boolean,
): number {
	if (inView) return 1;
	if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return confidence;
	const ageMs = Math.max(0, now - lastSeenAt);
	return Math.max(0, Math.min(1, confidence * Math.exp(-ageMs / halfLifeMs)));
}

export function createBeliefStore(): BeliefStore {
	return {
		parcels: new Map(),
		agents: new Map(),
		crates: new Map(),
		competitorHeatmap: new Map(),
		observedEmptySpawns: new Map(),
	};
}

function updateOutOfView<T extends { confidence: number; inView: boolean }>(
	map: Map<string, T>,
	sensed: { id: string }[],
): void {
	const inViewIds = new Set(sensed.map((e) => e.id));
	for (const [id, entry] of map) {
		if (inViewIds.has(id)) continue;
		entry.inView = false;
		entry.confidence *= OUT_OF_VIEW_DECAY;
	}
}

// Updates beliefs from a sensing event: marks in-view entities as authoritative,
// marks previously in-view entities now absent as out-of-view.
export function updateFromSensing(b: BeliefStore, sensing: IOSensing): void {
	const now = Date.now();

	for (const p of sensing.parcels) {
		b.parcels.set(p.id, {
			...p,
			lastSeenAt: now,
			confidence: 1,
			inView: true,
		});
	}
	updateOutOfView(b.parcels, sensing.parcels);

	for (const a of sensing.agents) {
		b.agents.set(a.id, {
			...a,
			lastSeenAt: now,
			confidence: 1,
			inView: true,
		});
	}
	updateOutOfView(b.agents, sensing.agents);

	for (const c of sensing.crates) {
		b.crates.set(c.id, { ...c, lastSeenAt: now, confidence: 1, inView: true });
	}
	updateOutOfView(b.crates, sensing.crates);
}

// Keeps observedEmptySpawns consistent with current sensing:
// - ADD: positions in FOV that are spawn tiles (no agent/parcel/crate confirmed by server).
// - REMOVE: parcels currently on a spawn tile cancel the empty mark.
export function updateObservedEmptySpawns(
	b: BeliefStore,
	map: StaticMap,
	sensing: IOSensing,
	now: number,
): void {
	const spawnSet = new Set(map.spawnTileIds);
	for (const pos of sensing.positions) {
		const id = tileId(map, pos.x, pos.y);
		if (spawnSet.has(id)) b.observedEmptySpawns.set(id, now);
	}
	for (const p of sensing.parcels) {
		if (p.carriedBy) continue;
		b.observedEmptySpawns.delete(tileId(map, p.x, p.y));
	}
}

// Marks picked-up parcels as carried by myId immediately (before next sensing).
export function applyPickupResult(
	b: BeliefStore,
	pickedIds: { id: string }[],
	myId: string,
): void {
	const now = Date.now();
	for (const { id } of pickedIds) {
		const p = b.parcels.get(id);
		if (p) {
			p.carriedBy = myId;
			p.lastSeenAt = now;
			p.confidence = 1;
		}
	}
}

// Clears all parcels believed carried by myId — call after putdown on delivery tile
// to avoid belief lag when the server returns an empty ack (timing/sensing race).
export function applyDelivery(b: BeliefStore, myId: string): void {
	for (const [id, p] of b.parcels) {
		if (p.carriedBy === myId) b.parcels.delete(id);
	}
}

export function markAgentDisconnected(b: BeliefStore, agentId: string): void {
	b.agents.delete(agentId);
}

// Drops beliefs older than the given TTL in ms.
export function evictStale(
	b: BeliefStore,
	parcelTtlMs: number,
	agentTtlMs: number,
): void {
	const now = Date.now();
	for (const [id, p] of b.parcels) {
		if (!p.inView && (now - p.lastSeenAt > parcelTtlMs || p.confidence <= STALE_CONFIDENCE))
			b.parcels.delete(id);
	}
	for (const [id, a] of b.agents) {
		if (!a.inView && (now - a.lastSeenAt > agentTtlMs || a.confidence <= STALE_CONFIDENCE))
			b.agents.delete(id);
	}
}

// Records in-view competitor positions into the heatmap.
// sensing.agents never includes self — no filter needed.
export function recordCompetitorPositions(
	b: BeliefStore,
	agents: IOAgent[],
	now: number,
	movementDurationMs: number,
): void {
	for (const a of agents) {
		if (a.x === undefined || a.y === undefined) continue;
		const key = `${Math.round(a.x)},${Math.round(a.y)}`;
		const existing = b.competitorHeatmap.get(key);
		if (existing) {
			const ageSteps = (now - existing.lastUpdate) / movementDurationMs;
			existing.weight =
				existing.weight *
					Math.exp(-ageSteps / MEMORY_DECAY_HORIZON_STEPS) +
				1;
			existing.lastUpdate = now;
		} else {
			b.competitorHeatmap.set(key, { weight: 1, lastUpdate: now });
		}
	}
}

// Returns current decayed weight at (x, y). 0 if never seen.
export function competitorWeight(
	b: BeliefStore,
	x: number,
	y: number,
	now: number,
	movementDurationMs: number,
): number {
	const entry = b.competitorHeatmap.get(`${x},${y}`);
	if (!entry) return 0;
	const ageSteps = (now - entry.lastUpdate) / movementDurationMs;
	return entry.weight * Math.exp(-ageSteps / MEMORY_DECAY_HORIZON_STEPS);
}

// Returns top-N tiles sorted by decayed weight descending.
export function topCompetitorTiles(
	b: BeliefStore,
	n: number,
	now: number,
	movementDurationMs: number,
): { x: number; y: number; weight: number }[] {
	const results: { x: number; y: number; weight: number }[] = [];
	for (const [key, entry] of b.competitorHeatmap) {
		const ageSteps = (now - entry.lastUpdate) / movementDurationMs;
		const weight =
			entry.weight * Math.exp(-ageSteps / MEMORY_DECAY_HORIZON_STEPS);
		if (weight < 0.1) continue; // skip effectively-zero entries
		const commaIdx = key.indexOf(",");
		const x = Number(key.slice(0, commaIdx));
		const y = Number(key.slice(commaIdx + 1));
		results.push({ x, y, weight });
	}
	results.sort((a, b) => b.weight - a.weight);
	return results.slice(0, n);
}
