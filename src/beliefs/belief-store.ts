// ============================================================
// src/beliefs/belief-store.ts — BeliefStore implementation (T07)
// Manages self, parcel, and agent beliefs with staleness,
// belief revision, decay estimation, and reachability filtering.
// ============================================================

import type {
  AgentBelief,
  BeliefChangeType,
  BeliefMap,
  BeliefSnapshot,
  Direction,
  IBeliefStore,
  ParcelBelief,
  Position,
  RawAgentSensing,
  RawParcelSensing,
  RawSelfSensing,
  SelfBelief,
} from '../types.js';
import { manhattanDistance, positionEquals } from '../types.js';
import { findPath } from '../pathfinding/pathfinder.js';

/** Parcels not seen for longer than this are marked stale (confidence drops). */
const STALE_THRESHOLD_MS = 5_000;

/** Agent confidence decays to 0 over this duration after last seen. */
const AGENT_CONFIDENCE_DECAY_MS = 10_000;

export class BeliefStore implements IBeliefStore {
  private map: BeliefMap;
  private self: SelfBelief;
  private parcels = new Map<string, ParcelBelief>();
  private agents = new Map<string, AgentBelief>();
  private allyIds = new Set<string>();
  private callbacks: Array<(changeType: BeliefChangeType) => void> = [];

  // Track previous agent positions for heading estimation
  private prevAgentPositions = new Map<string, Position>();

  constructor(map: BeliefMap) {
    this.map = map;
    this.self = {
      id: '',
      name: '',
      position: { x: 0, y: 0 },
      score: 0,
      penalty: 0,
      carriedParcels: [],
    };
  }

  // --- Mutation methods ---

  updateSelf(raw: RawSelfSensing): void {
    const prevPos = this.self.position;
    const prevScore = this.self.score;

    // Parcels carried by self
    const carried = Array.from(this.parcels.values()).filter(
      p => p.carriedBy === raw.id,
    );

    this.self = {
      id: raw.id,
      name: raw.name,
      position: { x: raw.x, y: raw.y },
      score: raw.score,
      penalty: raw.penalty ?? this.self.penalty,
      carriedParcels: carried,
    };

    if (!positionEquals(prevPos, this.self.position)) {
      this.emit('self_moved');
    }
    if (prevScore !== raw.score) {
      this.emit('self_score_changed');
    }
  }

  updateParcels(parcels: ReadonlyArray<RawParcelSensing>): void {
    const now = Date.now();
    const sensedIds = new Set<string>();

    for (const raw of parcels) {
      sensedIds.add(raw.id);
      const existing = this.parcels.get(raw.id);

      // Estimate decay rate from consecutive observations
      let decayRate = existing?.decayRatePerMs ?? 0;
      if (existing && raw.reward < existing.reward && existing.reward > 0) {
        const dt = now - existing.lastSeen;
        if (dt > 0) {
          decayRate = (existing.reward - raw.reward) / dt;
        }
      }

      this.parcels.set(raw.id, {
        id: raw.id,
        position: { x: raw.x, y: raw.y },
        carriedBy: raw.carriedBy,
        reward: raw.reward,
        estimatedReward: raw.reward,
        lastSeen: now,
        confidence: 1.0,
        decayRatePerMs: decayRate,
      });
    }

    // Belief revision: remove parcels that should be visible but aren't sensed.
    // A parcel is "should be visible" if it was within our sensing range but
    // not reported. We approximate by removing any non-carried parcel whose
    // position is within the convex hull of sensed parcels' range.
    // Simpler heuristic: if we received a sensing update, any previously known
    // non-carried parcel at a position that is NOT in the update is deleted
    // — but only if it was close enough to be observed.
    // We delete parcels that were in the same rough area as the current sensing.
    for (const [id, belief] of this.parcels) {
      if (sensedIds.has(id)) continue;
      if (belief.carriedBy !== null) continue; // carried parcels don't appear in sensing

      // If the parcel was at a position we can currently see (within sensing),
      // it should have appeared. Remove it.
      // Heuristic: if any sensed parcel is within 2 tiles of this parcel,
      // we likely should have seen it.
      const selfPos = this.self.position;
      const dist = manhattanDistance(selfPos, belief.position);

      // Use a conservative threshold: if we're close enough to the parcel
      // that we should see it, delete it. We don't know the exact sensing
      // radius, so use the farthest sensed parcel distance as a proxy.
      let maxSensedDist = 0;
      for (const raw of parcels) {
        const d = manhattanDistance(selfPos, { x: raw.x, y: raw.y });
        if (d > maxSensedDist) maxSensedDist = d;
      }

      // If we received parcels and this one is closer than the farthest
      // sensed parcel, we should have seen it — remove it.
      // Edge case: empty sensing update means we see nothing nearby,
      // so only remove parcels very close to us.
      const threshold = parcels.length > 0 ? maxSensedDist : 1;
      if (dist <= threshold) {
        this.parcels.delete(id);
      } else {
        // Mark stale parcels with decaying confidence
        const age = now - belief.lastSeen;
        if (age > STALE_THRESHOLD_MS) {
          const confidence = Math.max(
            0,
            1 - (age - STALE_THRESHOLD_MS) / STALE_THRESHOLD_MS,
          );
          const estimatedReward = Math.max(
            0,
            belief.reward - belief.decayRatePerMs * age,
          );
          this.parcels.set(id, {
            ...belief,
            confidence,
            estimatedReward,
          });
        }
      }
    }

    this.emit('parcels_changed');
  }

  updateAgents(agents: ReadonlyArray<RawAgentSensing>): void {
    const now = Date.now();
    const sensedIds = new Set<string>();

    for (const raw of agents) {
      sensedIds.add(raw.id);
      const existing = this.agents.get(raw.id);
      const prevPos = existing?.position ?? this.prevAgentPositions.get(raw.id);

      // Estimate heading from position delta
      let heading: Direction | null = null;
      if (prevPos && !positionEquals(prevPos, { x: raw.x, y: raw.y })) {
        const dx = raw.x - prevPos.x;
        const dy = raw.y - prevPos.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          heading = dx > 0 ? 'right' : 'left';
        } else {
          heading = dy > 0 ? 'up' : 'down';
        }
      } else if (existing) {
        heading = existing.heading;
      }

      this.prevAgentPositions.set(raw.id, { x: raw.x, y: raw.y });

      this.agents.set(raw.id, {
        id: raw.id,
        name: raw.name,
        position: { x: raw.x, y: raw.y },
        score: raw.score,
        lastSeen: now,
        confidence: 1.0,
        heading,
        isAlly: this.allyIds.has(raw.id),
      });
    }

    // Decay confidence of agents no longer sensed
    for (const [id, belief] of this.agents) {
      if (sensedIds.has(id)) continue;
      const age = now - belief.lastSeen;
      if (age > AGENT_CONFIDENCE_DECAY_MS) {
        this.agents.delete(id);
      } else {
        const confidence = Math.max(0, 1 - age / AGENT_CONFIDENCE_DECAY_MS);
        this.agents.set(id, { ...belief, confidence });
      }
    }

    this.emit('agents_changed');
  }

  mergeRemoteBelief(snapshot: BeliefSnapshot): void {
    const now = Date.now();

    for (const rp of snapshot.parcels) {
      const existing = this.parcels.get(rp.id);
      // Only merge if we don't have this parcel or our info is older
      if (!existing || existing.lastSeen < snapshot.timestamp) {
        this.parcels.set(rp.id, {
          id: rp.id,
          position: rp.position,
          carriedBy: rp.carriedBy,
          reward: rp.reward,
          estimatedReward: rp.reward,
          lastSeen: snapshot.timestamp,
          confidence: 0.7, // remote beliefs have lower confidence
          decayRatePerMs: existing?.decayRatePerMs ?? 0,
        });
      }
    }

    for (const ra of snapshot.agents) {
      const existing = this.agents.get(ra.id);
      if (!existing || existing.lastSeen < snapshot.timestamp) {
        this.agents.set(ra.id, {
          id: ra.id,
          name: existing?.name ?? ra.id,
          position: ra.position,
          score: existing?.score ?? 0,
          lastSeen: snapshot.timestamp,
          confidence: 0.5,
          heading: ra.heading,
          isAlly: this.allyIds.has(ra.id),
        });
      }
    }

    this.emit('remote_belief_merged');
  }

  // --- Query methods ---

  getSelf(): SelfBelief {
    // Refresh carried parcels list
    const carried = Array.from(this.parcels.values()).filter(
      p => p.carriedBy === this.self.id,
    );
    return { ...this.self, carriedParcels: carried };
  }

  getParcelBeliefs(): ReadonlyArray<ParcelBelief> {
    return Array.from(this.parcels.values());
  }

  getAgentBeliefs(): ReadonlyArray<AgentBelief> {
    return Array.from(this.agents.values());
  }

  getMap(): BeliefMap {
    return this.map;
  }

  getNearestDeliveryZone(from: Position): Position | null {
    const zones = this.map.getDeliveryZones();
    if (zones.length === 0) return null;

    let nearest: Position | null = null;
    let minDist = Infinity;

    for (const zone of zones) {
      const dist = manhattanDistance(from, zone);
      if (dist < minDist) {
        minDist = dist;
        nearest = zone;
      }
    }

    return nearest;
  }

  getReachableParcels(): ReadonlyArray<ParcelBelief> {
    const selfPos = this.self.position;
    return Array.from(this.parcels.values()).filter(p => {
      if (p.carriedBy !== null) return false;
      if (p.confidence <= 0) return false;
      const path = findPath(selfPos, p.position, this.map);
      return path !== null;
    });
  }

  toSnapshot(): BeliefSnapshot {
    return {
      agentId: this.self.id,
      timestamp: Date.now(),
      selfPosition: this.self.position,
      parcels: Array.from(this.parcels.values())
        .filter(p => p.confidence > 0)
        .map(p => ({
          id: p.id,
          position: p.position,
          reward: p.reward,
          carriedBy: p.carriedBy,
        })),
      agents: Array.from(this.agents.values())
        .filter(a => a.confidence > 0)
        .map(a => ({
          id: a.id,
          position: a.position,
          heading: a.heading,
        })),
    };
  }

  onUpdate(callback: (changeType: BeliefChangeType) => void): void {
    this.callbacks.push(callback);
  }

  // --- Ally management (used by AllyTracker) ---

  registerAlly(agentId: string): void {
    this.allyIds.add(agentId);
    // Update existing agent belief if we have one
    const existing = this.agents.get(agentId);
    if (existing) {
      this.agents.set(agentId, { ...existing, isAlly: true });
    }
  }

  unregisterAlly(agentId: string): void {
    this.allyIds.delete(agentId);
    const existing = this.agents.get(agentId);
    if (existing) {
      this.agents.set(agentId, { ...existing, isAlly: false });
    }
  }

  // --- Internal ---

  private emit(changeType: BeliefChangeType): void {
    for (const cb of this.callbacks) {
      cb(changeType);
    }
  }
}
