import type { IOAgent, IOCrate, IOParcel, IOSensing } from "@unitn-asa/deliveroo-js-sdk";

export type ParcelBelief = IOParcel & { firstSeenAt: number; lastSeenAt: number; inView: boolean };
export type AgentBelief = IOAgent & { lastSeenAt: number; inView: boolean };
export type CrateBelief = IOCrate & { lastSeenAt: number; inView: boolean };

// TTL policy: how many movement_duration units an entity is kept after going out-of-view.
export const PARCEL_TTL_MULT = 20;
export const AGENT_TTL_MULT = 10;

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
	for (const [id, p] of b.parcels) {
		if (p.inView && !sensing.parcels.some((sp) => sp.id === id)) p.inView = false;
	}

	for (const a of sensing.agents) {
		b.agents.set(a.id, { ...a, lastSeenAt: now, inView: true });
	}
	for (const [id, a] of b.agents) {
		if (a.inView && !sensing.agents.some((sa) => sa.id === id)) a.inView = false;
	}

	for (const c of sensing.crates) {
		b.crates.set(c.id, { ...c, lastSeenAt: now, inView: true });
	}
	for (const [id, c] of b.crates) {
		if (c.inView && !sensing.crates.some((sc) => sc.id === id)) c.inView = false;
	}
}

export function markAgentDisconnected(b: BeliefStore, agentId: string): void {
	b.disconnected.add(agentId);
	b.agents.delete(agentId);
}

// Drops beliefs older than the given TTL in ms.
export function evictStale(b: BeliefStore, parcelTtlMs: number, agentTtlMs: number): void {
	const now = Date.now();
	for (const [id, p] of b.parcels) {
		if (!p.inView && now - p.lastSeenAt > parcelTtlMs) b.parcels.delete(id);
	}
	for (const [id, a] of b.agents) {
		if (!a.inView && now - a.lastSeenAt > agentTtlMs) b.agents.delete(id);
	}
}
