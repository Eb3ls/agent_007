import type {
	IOAgent,
	IOCrate,
	IOParcel,
	IOSensing,
} from "@unitn-asa/deliveroo-js-sdk";

export type ParcelBelief = IOParcel & {
	firstSeenAt: number;
	lastSeenAt: number;
	confidence: number;
	inView: boolean;
};
export type AgentBelief = IOAgent & {
	firstSeenAt: number;
	lastSeenAt: number;
	confidence: number;
	inView: boolean;
};
export type CrateBelief = IOCrate & {
	lastSeenAt: number;
	confidence: number;
	inView: boolean;
};

export type BeliefStore = {
	parcels: Map<string, ParcelBelief>;
	agents: Map<string, AgentBelief>;
	crates: Map<string, CrateBelief>;
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
	};
}

function markAbsentOutOfView<T extends { inView: boolean }>(
	map: Map<string, T>,
	sensed: { id: string }[],
): void {
	const inViewIds = new Set(sensed.map((e) => e.id));
	for (const [id, entry] of map) {
		if (entry.inView && !inViewIds.has(id)) entry.inView = false;
	}
}

function decayBeliefConfidence<T extends { confidence: number; inView: boolean }>(
	map: Map<string, T>,
	sensed: { id: string }[],
): void {
	const inViewIds = new Set(sensed.map((e) => e.id));
	for (const [id, entry] of map) {
		if (inViewIds.has(id)) continue;
		if (!entry.inView) entry.confidence *= OUT_OF_VIEW_DECAY;
	}
}

// Updates beliefs from a sensing event: marks in-view entities as authoritative,
// marks previously in-view entities now absent as out-of-view.
export function updateFromSensing(b: BeliefStore, sensing: IOSensing): void {
	const now = Date.now();

	for (const p of sensing.parcels) {
		const existing = b.parcels.get(p.id);
		b.parcels.set(p.id, {
			...p,
			firstSeenAt: existing?.firstSeenAt ?? now,
			lastSeenAt: now,
			confidence: 1,
			inView: true,
		});
	}
	markAbsentOutOfView(b.parcels, sensing.parcels);
	decayBeliefConfidence(b.parcels, sensing.parcels);

	for (const a of sensing.agents) {
		b.agents.set(a.id, {
			...a,
			firstSeenAt: b.agents.get(a.id)?.firstSeenAt ?? now,
			lastSeenAt: now,
			confidence: 1,
			inView: true,
		});
	}
	markAbsentOutOfView(b.agents, sensing.agents);
	decayBeliefConfidence(b.agents, sensing.agents);

	for (const c of sensing.crates) {
		b.crates.set(c.id, { ...c, lastSeenAt: now, confidence: 1, inView: true });
	}
	markAbsentOutOfView(b.crates, sensing.crates);
	decayBeliefConfidence(b.crates, sensing.crates);
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
