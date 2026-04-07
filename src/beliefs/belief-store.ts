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
  IBeliefStore,
  ParcelBelief,
  Position,
  RawAgentSensing,
  RawParcelSensing,
  RawSelfSensing,
  SelfBelief,
} from '../types.js';
import { manhattanDistance } from '../types.js';
import { findPath } from '../pathfinding/pathfinder.js';
import { ParcelTracker } from './parcel-tracker.js';
import { SelfBeliefUpdater } from './self-belief-updater.js';
import { ParcelBeliefUpdater } from './parcel-belief-updater.js';
import { AgentBeliefUpdater } from './agent-belief-updater.js';

/** Parcels not seen for longer than this are marked stale (confidence drops). */
const STALE_THRESHOLD_MS = 5_000;

export class BeliefStore implements IBeliefStore {
  private map: BeliefMap;
  private self: SelfBelief;
  private parcels = new Map<string, ParcelBelief>();
  private agents = new Map<string, AgentBelief>();
  private allyIds = new Set<string>();
  private callbacks: Array<(changeType: BeliefChangeType) => void> = [];
  private capacity = Infinity;
  /** Set of "x,y" keys for spawning tiles the agent has stood on. */
  private visitedSpawningTiles = new Set<string>();
  private parcelTracker = new ParcelTracker();
  /** Server's PARCELS_OBSERVATION_DISTANCE (0 = unknown, use heuristic). */
  private observationDistance = 0;

  // Track previous agent positions for heading estimation
  private prevAgentPositions = new Map<string, Position>();

  // Belief updaters (separate for extensibility)
  private selfUpdater: SelfBeliefUpdater;
  private parcelUpdater: ParcelBeliefUpdater;
  private agentUpdater: AgentBeliefUpdater;

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

    // Initialize updaters
    this.selfUpdater = new SelfBeliefUpdater(map);
    this.parcelUpdater = new ParcelBeliefUpdater(map, this.parcelTracker);
    this.agentUpdater = new AgentBeliefUpdater();
  }

  // --- Mutation methods ---

  updateSelf(raw: RawSelfSensing): void {
    const result = this.selfUpdater.update(raw, this.self, this.parcels, this.visitedSpawningTiles);
    this.self = result.belief;

    if (result.positionChanged) {
      this.emit('self_moved');
    }
    if (result.scoreChanged) {
      this.emit('self_score_changed');
    }
  }

  updateParcels(parcels: ReadonlyArray<RawParcelSensing>): void {
    const result = this.parcelUpdater.update(
      parcels,
      this.parcels,
      this.self.position,
      this.observationDistance,
    );
    this.parcels = result.parcels;
    this.emit('parcels_changed');
  }

  updateAgents(agents: ReadonlyArray<RawAgentSensing>): void {
    const result = this.agentUpdater.update(
      agents,
      this.agents,
      this.prevAgentPositions,
      this.allyIds,
    );
    this.agents = result.agents;
    this.prevAgentPositions = result.prevPositions;
    this.emit('agents_changed');
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
   * On-ground parcel beliefs are marked low-confidence so fresh sensing overrides them;
   * carried-parcel beliefs are left intact (they are still valid).
   */
  clearStaleBeliefs(): void {
    this.agents.clear();
    this.prevAgentPositions.clear();
    for (const [id, belief] of this.parcels) {
      if (belief.carriedBy !== null) continue;
      this.parcels.set(id, { ...belief, confidence: 0.3 });
    }
    this.emit('agents_changed');
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

  getExploreTarget(from: Position): Position | null {
    const spawning = this.map.getSpawningTiles();
    if (spawning.length === 0) return null;

    // Always exclude current position — picking it causes an instant no-op loop
    const notCurrent = spawning.filter(t => !(t.x === from.x && t.y === from.y));
    if (notCurrent.length === 0) return null; // only one tile and we're on it

    // Prefer nearest unvisited tile; fall back to all non-current tiles if everything visited
    const unvisited = notCurrent.filter(t => !this.visitedSpawningTiles.has(`${t.x},${t.y}`));
    const candidates = unvisited.length > 0 ? unvisited : notCurrent;

    let nearest: Position | null = null;
    let minDist = Infinity;
    for (const t of candidates) {
      const d = manhattanDistance(from, t);
      if (d < minDist) { minDist = d; nearest = t; }
    }
    return nearest;
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
      .filter(a => !(a.position.x === selfPos.x && a.position.y === selfPos.y))
      .map(a => a.position);
    return Array.from(this.parcels.values()).filter(p => {
      if (p.carriedBy !== null) return false;
      if (p.confidence <= 0) return false;
      const path = findPath(selfPos, p.position, this.map, agentObstacles);
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
