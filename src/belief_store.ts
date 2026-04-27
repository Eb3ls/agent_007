import type {
	IOAgent,
	IOCrate,
	IOParcel,
	IOSensing,
} from "@unitn-asa/deliveroo-js-sdk";

export type ParcelBelief = IOParcel & {
	firstSeenAt: number;
	lastSeenAt: number;
	inView: boolean;
};
export type AgentBelief = IOAgent & {
	firstSeenAt: number;
	lastSeenAt: number;
	inView: boolean;
};
export type CrateBelief = IOCrate & { lastSeenAt: number; inView: boolean };

export type BeliefStore = {
	parcels: Map<string, ParcelBelief>;
	agents: Map<string, AgentBelief>;
	crates: Map<string, CrateBelief>;
	disconnected: Set<string>;
};

export function createBeliefStore(): BeliefStore {
	return {
		parcels: new Map(),
		agents: new Map(),
		crates: new Map(),
		disconnected: new Set(),
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
			inView: true,
		});
	}
	markAbsentOutOfView(b.parcels, sensing.parcels);

	for (const a of sensing.agents) {
		b.agents.set(a.id, {
			...a,
			firstSeenAt: b.agents.get(a.id)?.firstSeenAt ?? now,
			lastSeenAt: now,
			inView: true,
		});
	}
	markAbsentOutOfView(b.agents, sensing.agents);

	for (const c of sensing.crates) {
		b.crates.set(c.id, { ...c, lastSeenAt: now, inView: true });
	}
	markAbsentOutOfView(b.crates, sensing.crates);
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
		}
	}
}

// Removes dropped/delivered parcels from beliefs immediately (before next sensing).
export function applyPutdownResult(
	b: BeliefStore,
	droppedIds: { id: string }[],
): void {
	for (const { id } of droppedIds) {
		b.parcels.delete(id);
	}
}

export function markAgentDisconnected(b: BeliefStore, agentId: string): void {
	b.disconnected.add(agentId);
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
