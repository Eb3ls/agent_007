import type {
	IOAgent,
	IOCrate,
	IOParcel,
	IOSensing,
} from "@unitn-asa/deliveroo-js-sdk";

export type Perception = {
	self: IOAgent | null;
	visibleParcels: Map<string, IOParcel>;
	visibleAgents: Map<string, IOAgent>;
	visibleCrates: Map<string, IOCrate>;
};

export function createPerception(): Perception {
	return {
		self: null,
		visibleParcels: new Map(),
		visibleAgents: new Map(),
		visibleCrates: new Map(),
	};
}

export function setSelf(p: Perception, agent: IOAgent): void {
	p.self = agent;
}

// Replaces all visible snapshots — server sends the full in-view state each time, not a diff.
export function setSensing(p: Perception, sensing: IOSensing): void {
	p.visibleParcels.clear();
	for (const pc of sensing.parcels) p.visibleParcels.set(pc.id, pc);

	p.visibleAgents.clear();
	for (const a of sensing.agents) p.visibleAgents.set(a.id, a);

	p.visibleCrates.clear();
	for (const c of sensing.crates) p.visibleCrates.set(c.id, c);
}
