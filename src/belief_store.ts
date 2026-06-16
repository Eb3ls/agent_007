import type {
	IOAgent,
	IOCrate,
	IOParcel,
	IOSensing,
} from "@unitn-asa/deliveroo-js-sdk";
import { TILE, tileId, type StaticMap } from "./static_map.js";
import { MEMORY_DECAY_HORIZON_STEPS } from "./config.js";

export type ParcelBelief = IOParcel & {
	lastSeenAt: number;
	confidence: number;
	inView: boolean;
	inViewBy: Set<string>; // agent ids that currently see this parcel
};
export type AgentBelief = IOAgent & {
	lastSeenAt: number;
	confidence: number;
	inView: boolean;
	inViewBy: Set<string>;
};
export type CrateBelief = IOCrate & {
	lastSeenAt: number;
	confidence: number;
	inView: boolean;
	inViewBy: Set<string>;
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
	// Action-authority pin: parcel ids whose pickup is in-flight (prevents double-pickup).
	pendingPickup: Set<string>;
	// Crate-slide tiles ("5"/"5!") believed to currently hold a crate (tileIds).
	// Seeded from the spawn rule (every "5!" starts occupied) and corrected by
	// observation, so unseen crates aren't optimistically treated as clear.
	crateOccupancy: Set<number>;
};

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
		pendingPickup: new Set(),
		crateOccupancy: new Set(),
	};
}

/**
 * Seed crate occupancy from the map's spawn rule: every "5!" tile starts holding a
 * crate; "5" tiles start empty. Call once when the map is set, before sensing.
 */
export function seedCrateOccupancy(b: BeliefStore, map: StaticMap): void {
	b.crateOccupancy.clear();
	for (const t of map.tiles.values()) {
		if (t.type === TILE.CRATE_SLIDE_MOVING)
			b.crateOccupancy.add(tileId(map, t.x, t.y));
	}
}

/**
 * Correct crate occupancy from the current FOV: a crate tile we can see is occupied
 * iff a crate is sensed on it. Out-of-view tiles keep their last known value (the
 * "5!" seed until first observed). Mirrors updateObservedEmptySpawns.
 */
export function updateCrateOccupancy(
	b: BeliefStore,
	map: StaticMap,
	sensing: IOSensing,
): void {
	for (const pos of sensing.positions) {
		const t = map.tiles.get(`${pos.x},${pos.y}`);
		if (
			t &&
			(t.type === TILE.CRATE_SLIDE || t.type === TILE.CRATE_SLIDE_MOVING)
		)
			b.crateOccupancy.delete(tileId(map, pos.x, pos.y));
	}
	for (const c of sensing.crates) {
		b.crateOccupancy.add(tileId(map, c.x, c.y));
	}
}

function updateFOVForMap<T extends { inView: boolean; inViewBy: Set<string> }>(
	map: Map<string, T>,
	sensed: { id: string }[],
	agentId: string,
): void {
	const inViewIds = new Set(sensed.map((e) => e.id));
	for (const [id, entry] of map) {
		if (inViewIds.has(id)) {
			entry.inViewBy.add(agentId);
			entry.inView = true;
		} else {
			entry.inViewBy.delete(agentId);
			entry.inView = entry.inViewBy.size > 0;
		}
	}
}

// Updates beliefs from a sensing event for the given agent (default "bdi" for single-agent).
// Marks in-view entities as authoritative; adjusts inViewBy / inView for multi-agent FOV union.
export function updateFromSensing(
	b: BeliefStore,
	sensing: IOSensing,
	agentId = "bdi",
): void {
	const now = Date.now();

	for (const p of sensing.parcels) {
		const existing = b.parcels.get(p.id);
		b.parcels.set(p.id, {
			...p,
			lastSeenAt: now,
			confidence: 1,
			inView: true,
			inViewBy: existing ? existing.inViewBy : new Set(),
		});
		b.parcels.get(p.id)!.inViewBy.add(agentId);
	}
	updateFOVForMap(b.parcels, sensing.parcels, agentId);

	for (const a of sensing.agents) {
		const existing = b.agents.get(a.id);
		b.agents.set(a.id, {
			...a,
			lastSeenAt: now,
			confidence: 1,
			inView: true,
			inViewBy: existing ? existing.inViewBy : new Set(),
		});
		b.agents.get(a.id)!.inViewBy.add(agentId);
	}
	updateFOVForMap(b.agents, sensing.agents, agentId);

	for (const c of sensing.crates) {
		const existing = b.crates.get(c.id);
		b.crates.set(c.id, {
			...c,
			lastSeenAt: now,
			confidence: 1,
			inView: true,
			inViewBy: existing ? existing.inViewBy : new Set(),
		});
		b.crates.get(c.id)!.inViewBy.add(agentId);
	}
	updateFOVForMap(b.crates, sensing.crates, agentId);
}

// Removes agentId from all beliefs' inViewBy sets (call when agent disconnects or FOV resets).
export function clearFOV(b: BeliefStore, agentId: string): void {
	for (const p of b.parcels.values()) {
		p.inViewBy.delete(agentId);
		p.inView = p.inViewBy.size > 0;
	}
	for (const a of b.agents.values()) {
		a.inViewBy.delete(agentId);
		a.inView = a.inViewBy.size > 0;
	}
	for (const c of b.crates.values()) {
		c.inViewBy.delete(agentId);
		c.inView = c.inViewBy.size > 0;
	}
}

// Keeps observedEmptySpawns consistent with current sensing.
// sensing.positions = ALL tiles in FOV (BFS Manhattan), regardless of what is on them.
// ADD: every spawn tile in FOV.
// REMOVE: spawn tiles that have a parcel (not carried) or a crate on them.
export function updateObservedEmptySpawns(
	b: BeliefStore,
	map: StaticMap,
	sensing: IOSensing,
	now: number,
): void {
	for (const pos of sensing.positions) {
		const id = tileId(map, pos.x, pos.y);
		if (map.spawnTileIdSet.has(id)) b.observedEmptySpawns.set(id, now);
	}
	for (const p of sensing.parcels) {
		if (p.carriedBy) continue;
		b.observedEmptySpawns.delete(tileId(map, p.x, p.y));
	}
	for (const c of sensing.crates) {
		b.observedEmptySpawns.delete(tileId(map, c.x, c.y));
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

// Clears any uncarried parcel belief at the given tile.
// Call after every pickup attempt to stop retry spam when pickup returns empty.
export function clearUncarriedParcelsAt(
	b: BeliefStore,
	x: number,
	y: number,
): void {
	for (const [id, p] of b.parcels) {
		if (p.carriedBy) continue;
		if (p.x !== x || p.y !== y) continue;
		b.parcels.delete(id);
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
		if (!p.inView && now - p.lastSeenAt > parcelTtlMs) b.parcels.delete(id);
	}
	for (const [id, a] of b.agents) {
		if (!a.inView && now - a.lastSeenAt > agentTtlMs) b.agents.delete(id);
	}
}

// Records in-view competitor positions into the heatmap.
// sensing.agents never includes self. Pass friendlyIds to exclude teammates.
export function recordCompetitorPositions(
	b: BeliefStore,
	agents: IOAgent[],
	now: number,
	movementDurationMs: number,
	friendlyIds: ReadonlySet<string> = new Set(),
): void {
	for (const a of agents) {
		if (friendlyIds.has(a.id)) continue;
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
