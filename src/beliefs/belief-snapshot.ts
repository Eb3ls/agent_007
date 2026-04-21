// ============================================================
// src/beliefs/belief-snapshot.ts — Immutable BeliefSnapshot builder
// Produces a deep-frozen point-in-time copy of the belief state.
// All planners receive a snapshot, never the live BeliefStore (Arch Decision #2).
// ============================================================

import type { BeliefSnapshot, IBeliefStore } from '../types.js';

/**
 * Builds a deep-frozen snapshot of the current belief state.
 * Safe to pass to long-running planners (e.g. PDDL, LLM) that may take
 * several seconds: the snapshot is decoupled from the live BeliefStore.
 */
export function buildSnapshot(store: IBeliefStore): Readonly<BeliefSnapshot> {
  const s = store.toSnapshot();

  const frozenParcels = Object.freeze(
    s.parcels.map(p =>
      Object.freeze({ ...p, position: Object.freeze({ ...p.position }) }),
    ),
  );

  const frozenAgents = Object.freeze(
    s.agents.map(a =>
      Object.freeze({ ...a, position: Object.freeze({ ...a.position }) }),
    ),
  );

  return Object.freeze({
    agentId: s.agentId,
    timestamp: s.timestamp,
    selfPosition: Object.freeze({ ...s.selfPosition }),
    parcels: frozenParcels,
    agents: frozenAgents,
  });
}
