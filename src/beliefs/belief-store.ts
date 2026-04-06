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
  CrateBelief,
  Direction,
  IBeliefStore,
  ParcelBelief,
  Position,
  RawAgentSensing,
  RawCrateSensing,
  RawParcelSensing,
  RawSelfSensing,
  SelfBelief,
} from '../types.js';
import { manhattanDistance, positionEquals } from '../types.js';
import { findPath } from '../pathfinding/pathfinder.js';
import { ParcelTracker } from './parcel-tracker.js';

/** Parcels not seen for longer than this are marked stale (confidence drops). */
const STALE_THRESHOLD_MS = 5_000;

/** Agent confidence decays to 0 over this duration after last seen. */
const AGENT_CONFIDENCE_DECAY_MS = 10_000;

/** Crates not seen for longer than this are removed (ghost crate prevention). */
const CRATE_STALE_TTL_MS = 30_000;

export class BeliefStore implements IBeliefStore {
  private map: BeliefMap;
  private self: SelfBelief;
  private parcels = new Map<string, ParcelBelief>();
  private agents = new Map<string, AgentBelief>();
  private crates = new Map<string, CrateBelief>();
  private allyIds = new Set<string>();
  private callbacks: Array<(changeType: BeliefChangeType) => void> = [];
  private capacity = Infinity;
  /** Set of "x,y" keys for spawning tiles the agent has stood on. */
  private visitedSpawningTiles = new Set<string>();
  private parcelTracker = new ParcelTracker();
  /** Server's unified observation_distance (0 = unknown, use heuristic). */
  private observationDistance = 0;

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

    // Server sends float coordinates during movement animation.
    // Only update position when the agent is on a stable integer tile;
    // otherwise keep the last known integer position to avoid planning from mid-air.
    const stablePosition = (Number.isInteger(raw.x) && Number.isInteger(raw.y))
      ? { x: raw.x, y: raw.y }
      : this.self.position;

    this.self = {
      id: raw.id,
      name: raw.name,
      position: stablePosition,
      score: raw.score,
      penalty: raw.penalty ?? this.self.penalty,
      carriedParcels: carried,
    };

    // Track visited spawning tiles for exploration
    if (this.map.isSpawningTile(stablePosition.x, stablePosition.y)) {
      this.visitedSpawningTiles.add(`${stablePosition.x},${stablePosition.y}`);
    }

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
      this.parcelTracker.observe(raw.id, raw.reward, now);
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
        position: { x: Math.round(raw.x), y: Math.round(raw.y) }, // R06: round fractional coords
        carriedBy: raw.carriedBy,
        reward: raw.reward,
        estimatedReward: raw.reward,
        lastSeen: now,
        confidence: 1.0,
        decayRatePerMs: decayRate,
      });
    }

    // Belief revision: remove parcels that should be visible but aren't sensed.
    // Use observation_distance when known; otherwise fall back to a
    // heuristic based on the farthest sensed parcel distance.
    const selfPos = this.self.position;
    let effectiveRange: number;
    if (this.observationDistance > 0) {
      effectiveRange = this.observationDistance;
    } else {
      let maxSensedDist = 0;
      for (const raw of parcels) {
        const d = manhattanDistance(selfPos, { x: raw.x, y: raw.y });
        if (d > maxSensedDist) maxSensedDist = d;
      }
      effectiveRange = parcels.length > 0 ? maxSensedDist : 1;
    }

    for (const [id, belief] of this.parcels) {
      if (sensedIds.has(id)) continue;
      if (belief.carriedBy !== null) continue; // carried parcels don't appear in sensing

      const dist = manhattanDistance(selfPos, belief.position);
      // R10: when observationDistance is configured by the server, the boundary
      // is exclusive (dist < observationDistance). When using the heuristic
      // (effectiveRange = maxSensedDist), the boundary is inclusive.
      const inRange =
        this.observationDistance > 0
          ? dist < this.observationDistance
          : dist <= effectiveRange;
      if (inRange) {
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

      // Estimate heading from raw float delta for accuracy (avoids false equality
      // when comparing integer belief position against a new fractional raw position).
      const prevRaw = this.prevAgentPositions.get(raw.id);
      let heading: Direction | null = null;
      if (prevRaw && (prevRaw.x !== raw.x || prevRaw.y !== raw.y)) {
        const dx = raw.x - prevRaw.x;
        const dy = raw.y - prevRaw.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          heading = dx > 0 ? 'right' : 'left';
        } else {
          heading = dy > 0 ? 'up' : 'down';
        }
      } else if (existing) {
        heading = existing.heading;
      }

      // Store raw float position for heading computation on the next update.
      this.prevAgentPositions.set(raw.id, { x: raw.x, y: raw.y });

      // Use stable integer position — skip fractional mid-move coordinates to avoid
      // placing the agent on a tile they're actually leaving (Math.round can snap
      // to the destination tile while the agent is still on the source tile).
      const stablePosition = (Number.isInteger(raw.x) && Number.isInteger(raw.y))
        ? { x: raw.x, y: raw.y }
        : existing?.position ?? { x: Math.round(raw.x), y: Math.round(raw.y) };

      this.agents.set(raw.id, {
        id: raw.id,
        name: raw.name,
        position: stablePosition,
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

  updateCrates(crates: ReadonlyArray<RawCrateSensing>): void {
    const now = Date.now();
    const sensedIds = new Set<string>();
    const selfPos = this.self.position;

    for (const raw of crates) {
      sensedIds.add(raw.id);
      this.crates.set(raw.id, {
        id: raw.id,
        position: { x: Math.round(raw.x), y: Math.round(raw.y) },
        lastSeen: now,
      });
    }

    // Belief revision: remove crates confirmed absent within observation range.
    // Crates outside range may still be present — keep them until re-observed.
    const effectiveRange = this.observationDistance > 0 ? this.observationDistance : 5;
    for (const [id, belief] of this.crates) {
      if (sensedIds.has(id)) continue;
      const dist = manhattanDistance(selfPos, belief.position);
      const inRange = this.observationDistance > 0
        ? dist < this.observationDistance
        : dist <= effectiveRange;
      if (inRange) {
        this.crates.delete(id);
      }
    }

    // Remove stale crates not seen within TTL (prevents ghost crates).
    // Must use Array.from() to avoid mutation during iteration.
    for (const [id, belief] of Array.from(this.crates.entries())) {
      if (now - belief.lastSeen > CRATE_STALE_TTL_MS) {
        this.crates.delete(id);
      }
    }

    this.emit('crates_changed');
  }

  removeParcel(id: string): void {
    this.parcels.delete(id);
    this.parcelTracker.forget(id);
    this.emit('parcels_changed');
  }

  /** Remove all parcels believed to be carried by self (called after a successful delivery). */
  clearDeliveredParcels(): void {
    for (const [id, belief] of this.parcels) {
      if (belief.carriedBy === this.self.id) {
        this.parcels.delete(id);
      }
    }
    this.emit('parcels_changed');
  }

  /**
   * Clear stale beliefs after a disconnect.
   * Agent positions are unknown after disconnect, so all agent beliefs are removed.
   * Crate positions may have changed during disconnect, so all crate beliefs are removed.
   * On-ground parcel beliefs are marked low-confidence so fresh sensing overrides them;
   * carried-parcel beliefs are left intact (they are still valid).
   */
  clearStaleBeliefs(): void {
    this.agents.clear();
    this.crates.clear();
    this.prevAgentPositions.clear();
    for (const [id, belief] of this.parcels) {
      if (belief.carriedBy !== null) continue;
      this.parcels.set(id, { ...belief, confidence: 0.3 });
    }
    this.emit('agents_changed');
    this.emit('crates_changed');
    this.emit('parcels_changed');
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

  getCapacity(): number {
    return this.capacity;
  }

  /** Exposes the ParcelTracker for decay-aware reward projection in deliberation. */
  getParcelTracker(): ParcelTracker {
    return this.parcelTracker;
  }

  /** @deprecated use getCratePositionSet */
  getCrateObstacles(): ReadonlyArray<Position> {
    return Array.from(this.crates.values()).map(c => c.position);
  }

  getCrateBeliefs(): ReadonlyMap<string, CrateBelief> {
    return this.crates;
  }

  getCratePositionSet(mapWidth: number): ReadonlySet<number> {
    const set = new Set<number>();
    for (const c of this.crates.values()) {
      set.add(c.position.y * mapWidth + c.position.x);
    }
    return set;
  }

  getExploreTarget(from: Position): Position | null {
    const spawning = this.map.getSpawningTiles();
    if (spawning.length === 0) return null;

    // Always exclude current position — picking it causes an instant no-op loop
    const notCurrent = spawning.filter(t => !(t.x === from.x && t.y === from.y));
    if (notCurrent.length === 0) return null; // only one tile and we're on it

    // Prefer nearest unvisited tile; fall back to all non-current tiles if everything visited.
    // When all visited, reset the set so the next sweep starts fresh (prevents oscillation).
    const unvisited = notCurrent.filter(t => !this.visitedSpawningTiles.has(`${t.x},${t.y}`));
    if (unvisited.length === 0) this.visitedSpawningTiles.clear();
    const candidates = unvisited.length > 0 ? unvisited : notCurrent;

    // Prefer targets at least observation_distance away to maximise new area scanned per visit.
    // On a map with obs_dist=5, adjacent tiles share ~90% of their visible area;
    // spacing by obs_dist ensures mostly-fresh coverage each hop.
    // Fallback to all candidates if none are far enough (e.g. small maps).
    const minDist = this.observationDistance > 0 ? this.observationDistance : 5;
    const spaced = candidates.filter(t => manhattanDistance(from, t) >= minDist);
    const pool = spaced.length > 0 ? spaced : candidates;

    // Sort by Manhattan distance, then verify reachability via pathfinding.
    // On complex maps (mazes, narrow corridors) the nearest tile by Manhattan
    // may be unreachable, causing infinite plan-fail loops.
    const sorted = [...pool].sort(
      (a, b) => manhattanDistance(from, a) - manhattanDistance(from, b),
    );
    for (const t of sorted) {
      if (findPath(from, t, this.map) !== null) return t;
    }
    // Fallback: return nearest by Manhattan if none are reachable yet (map not fully built)
    return sorted[0] ?? null;
  }

  setCapacity(n: number): void {
    this.capacity = n > 0 ? n : Infinity;
  }

  setObservationDistance(n: number): void {
    this.observationDistance = n > 0 ? n : 0;
  }

  getReachableParcels(): ReadonlyArray<ParcelBelief> {
    const selfPos = this.self.position;
    const agentObstacles = Array.from(this.agents.values())
      .filter(a => a.confidence > 0.5 && !(a.position.x === selfPos.x && a.position.y === selfPos.y))
      .map(a => a.position);
    const cratePositions = this.getCratePositionSet(this.map.width);
    return Array.from(this.parcels.values()).filter(p => {
      if (p.carriedBy !== null) return false;
      if (p.confidence <= 0) return false;
      // Exclude the parcel's own tile from agent obstacles: an agent standing on a parcel
      // tile should not make the parcel appear unreachable (they will move away).
      const obstaclesForParcel = agentObstacles.filter(
        o => !(o.x === p.position.x && o.y === p.position.y),
      );
      const path = findPath(
        selfPos,
        p.position,
        this.map,
        obstaclesForParcel.length > 0 ? obstaclesForParcel : undefined,
        cratePositions,
      );
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
