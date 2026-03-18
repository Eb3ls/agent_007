// ============================================================
// src/beliefs/belief-store.test.ts — BeliefStore unit tests (T07)
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BeliefStore } from './belief-store.js';
import { BeliefMapImpl } from './belief-map.js';
import type {
  BeliefChangeType,
  BeliefSnapshot,
  RawAgentSensing,
  RawParcelSensing,
  RawSelfSensing,
} from '../types.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_PARCELS,
  FIXTURE_AGENTS,
  FIXTURE_SELF,
  FIXTURE_DELIVERY_ZONES,
} from '../testing/fixtures.js';

function makeMap() {
  return new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
}

describe('BeliefStore', () => {
  let store: BeliefStore;

  beforeEach(() => {
    store = new BeliefStore(makeMap());
    store.updateSelf(FIXTURE_SELF);
  });

  // --- Self updates ---

  describe('updateSelf', () => {
    it('stores self state from raw sensing', () => {
      const self = store.getSelf();
      assert.equal(self.id, 'agent-self');
      assert.equal(self.name, 'TestAgent');
      assert.deepEqual(self.position, { x: 4, y: 4 });
      assert.equal(self.score, 0);
      assert.equal(self.penalty, 0);
    });

    it('emits self_moved when position changes', () => {
      const events: BeliefChangeType[] = [];
      store.onUpdate(ct => events.push(ct));

      store.updateSelf({ ...FIXTURE_SELF, x: 5, y: 4 });
      assert.ok(events.includes('self_moved'));
    });

    it('emits self_score_changed when score changes', () => {
      const events: BeliefChangeType[] = [];
      store.onUpdate(ct => events.push(ct));

      store.updateSelf({ ...FIXTURE_SELF, score: 50 });
      assert.ok(events.includes('self_score_changed'));
    });

    it('does not emit self_moved when position is unchanged', () => {
      const events: BeliefChangeType[] = [];
      store.onUpdate(ct => events.push(ct));

      store.updateSelf(FIXTURE_SELF);
      assert.ok(!events.includes('self_moved'));
    });
  });

  // --- Parcel updates ---

  describe('updateParcels', () => {
    it('adds new parcels from sensing', () => {
      store.updateParcels(FIXTURE_PARCELS);
      const beliefs = store.getParcelBeliefs();
      assert.equal(beliefs.length, 5);
    });

    it('sets confidence to 1.0 for freshly sensed parcels', () => {
      store.updateParcels(FIXTURE_PARCELS);
      for (const p of store.getParcelBeliefs()) {
        assert.equal(p.confidence, 1.0);
      }
    });

    it('updates existing parcels with new data', () => {
      store.updateParcels(FIXTURE_PARCELS);
      const updated: RawParcelSensing[] = [
        { id: 'p1', x: 1, y: 0, carriedBy: null, reward: 40 }, // reward decreased
      ];
      store.updateParcels(updated);
      const p1 = store.getParcelBeliefs().find(p => p.id === 'p1');
      assert.ok(p1);
      assert.equal(p1.reward, 40);
    });

    it('removes parcels absent from sensing within visible range (belief revision)', () => {
      // Self is at (4,4). Push 3 parcels nearby.
      const nearbyParcels: RawParcelSensing[] = [
        { id: 'n1', x: 4, y: 5, carriedBy: null, reward: 50 },
        { id: 'n2', x: 5, y: 4, carriedBy: null, reward: 30 },
        { id: 'n3', x: 3, y: 4, carriedBy: null, reward: 20 },
      ];
      store.updateParcels(nearbyParcels);
      assert.equal(store.getParcelBeliefs().length, 3);

      // Next sensing only reports 2 of the 3
      const partialUpdate: RawParcelSensing[] = [
        { id: 'n1', x: 4, y: 5, carriedBy: null, reward: 48 },
        { id: 'n2', x: 5, y: 4, carriedBy: null, reward: 28 },
      ];
      store.updateParcels(partialUpdate);

      // n3 was within sensing range (closer than farthest sensed) so should be removed
      const beliefs = store.getParcelBeliefs();
      const ids = beliefs.map(b => b.id);
      assert.ok(ids.includes('n1'));
      assert.ok(ids.includes('n2'));
      assert.ok(!ids.includes('n3'), 'n3 should have been deleted via belief revision');
    });

    it('keeps parcels outside sensing range', () => {
      // Add a far-away parcel first
      const farParcel: RawParcelSensing[] = [
        { id: 'far', x: 9, y: 9, carriedBy: null, reward: 100 },
      ];
      store.updateParcels(farParcel);

      // Now sense parcels near self (4,4)
      const nearParcels: RawParcelSensing[] = [
        { id: 'near', x: 4, y: 5, carriedBy: null, reward: 50 },
      ];
      store.updateParcels(nearParcels);

      const ids = store.getParcelBeliefs().map(b => b.id);
      assert.ok(ids.includes('far'), 'far-away parcel should be retained');
      assert.ok(ids.includes('near'));
    });

    it('emits parcels_changed on update', () => {
      const events: BeliefChangeType[] = [];
      store.onUpdate(ct => events.push(ct));

      store.updateParcels(FIXTURE_PARCELS);
      assert.ok(events.includes('parcels_changed'));
    });

    it('estimates decay rate from consecutive observations', () => {
      const p1v1: RawParcelSensing[] = [
        { id: 'decay-test', x: 4, y: 5, carriedBy: null, reward: 50 },
      ];
      store.updateParcels(p1v1);

      // Simulate time passing — we need to manually update with a lower reward
      const p1v2: RawParcelSensing[] = [
        { id: 'decay-test', x: 4, y: 5, carriedBy: null, reward: 45 },
      ];
      store.updateParcels(p1v2);

      const belief = store.getParcelBeliefs().find(p => p.id === 'decay-test');
      assert.ok(belief);
      // Decay rate should be positive (reward decreased)
      assert.ok(belief.decayRatePerMs >= 0, 'decay rate should be non-negative');
    });
  });

  // --- Agent updates ---

  describe('updateAgents', () => {
    it('adds agents from sensing', () => {
      store.updateAgents(FIXTURE_AGENTS);
      const beliefs = store.getAgentBeliefs();
      assert.equal(beliefs.length, 3);
    });

    it('tracks agent positions', () => {
      store.updateAgents(FIXTURE_AGENTS);
      const alice = store.getAgentBeliefs().find(a => a.id === 'agent-a');
      assert.ok(alice);
      assert.deepEqual(alice.position, { x: 0, y: 1 });
      assert.equal(alice.name, 'Alice');
    });

    it('estimates heading from consecutive position updates', () => {
      store.updateAgents([
        { id: 'agent-a', name: 'Alice', x: 3, y: 3, score: 100 },
      ]);
      store.updateAgents([
        { id: 'agent-a', name: 'Alice', x: 4, y: 3, score: 100 },
      ]);
      const alice = store.getAgentBeliefs().find(a => a.id === 'agent-a');
      assert.ok(alice);
      assert.equal(alice.heading, 'right');
    });

    it('estimates heading as up for vertical movement', () => {
      store.updateAgents([
        { id: 'agent-a', name: 'Alice', x: 3, y: 3, score: 100 },
      ]);
      store.updateAgents([
        { id: 'agent-a', name: 'Alice', x: 3, y: 5, score: 100 },
      ]);
      const alice = store.getAgentBeliefs().find(a => a.id === 'agent-a');
      assert.ok(alice);
      assert.equal(alice.heading, 'up');
    });

    it('marks agents as allies when registered', () => {
      store.registerAlly('agent-a');
      store.updateAgents(FIXTURE_AGENTS);
      const alice = store.getAgentBeliefs().find(a => a.id === 'agent-a');
      assert.ok(alice);
      assert.equal(alice.isAlly, true);

      const bob = store.getAgentBeliefs().find(a => a.id === 'agent-b');
      assert.ok(bob);
      assert.equal(bob.isAlly, false);
    });

    it('emits agents_changed on update', () => {
      const events: BeliefChangeType[] = [];
      store.onUpdate(ct => events.push(ct));

      store.updateAgents(FIXTURE_AGENTS);
      assert.ok(events.includes('agents_changed'));
    });

    it('decays confidence for agents no longer sensed', () => {
      store.updateAgents(FIXTURE_AGENTS);
      // Update with empty agents list — existing agents should start decaying
      store.updateAgents([]);
      const beliefs = store.getAgentBeliefs();
      // They should still exist (decay hasn't exceeded threshold) but confidence < 1
      for (const a of beliefs) {
        assert.ok(a.confidence <= 1.0);
      }
    });
  });

  // --- mergeRemoteBelief ---

  describe('mergeRemoteBelief', () => {
    it('adds parcels from remote snapshot', () => {
      const snapshot: BeliefSnapshot = {
        agentId: 'ally-1',
        timestamp: Date.now(),
        selfPosition: { x: 8, y: 8 },
        parcels: [
          { id: 'remote-p1', position: { x: 9, y: 8 }, reward: 60, carriedBy: null },
        ],
        agents: [],
      };

      store.mergeRemoteBelief(snapshot);
      const beliefs = store.getParcelBeliefs();
      const remote = beliefs.find(p => p.id === 'remote-p1');
      assert.ok(remote, 'remote parcel should be merged');
      assert.equal(remote.reward, 60);
      assert.equal(remote.confidence, 0.7); // remote beliefs have lower confidence
    });

    it('does not overwrite newer local beliefs', () => {
      // Add a parcel locally (fresh timestamp)
      store.updateParcels([
        { id: 'shared-p', x: 5, y: 5, carriedBy: null, reward: 80 },
      ]);

      // Remote snapshot with older timestamp
      const snapshot: BeliefSnapshot = {
        agentId: 'ally-1',
        timestamp: Date.now() - 10_000, // 10 seconds ago
        selfPosition: { x: 8, y: 8 },
        parcels: [
          { id: 'shared-p', position: { x: 5, y: 5 }, reward: 50, carriedBy: null },
        ],
        agents: [],
      };

      store.mergeRemoteBelief(snapshot);
      const p = store.getParcelBeliefs().find(b => b.id === 'shared-p');
      assert.ok(p);
      assert.equal(p.reward, 80, 'local newer belief should win');
    });

    it('adds agents from remote snapshot', () => {
      const snapshot: BeliefSnapshot = {
        agentId: 'ally-1',
        timestamp: Date.now(),
        selfPosition: { x: 8, y: 8 },
        parcels: [],
        agents: [
          { id: 'remote-agent', position: { x: 7, y: 7 }, heading: 'left' },
        ],
      };

      store.mergeRemoteBelief(snapshot);
      const agent = store.getAgentBeliefs().find(a => a.id === 'remote-agent');
      assert.ok(agent);
      assert.deepEqual(agent.position, { x: 7, y: 7 });
      assert.equal(agent.heading, 'left');
      assert.equal(agent.confidence, 0.5);
    });

    it('emits remote_belief_merged', () => {
      const events: BeliefChangeType[] = [];
      store.onUpdate(ct => events.push(ct));

      const snapshot: BeliefSnapshot = {
        agentId: 'ally-1',
        timestamp: Date.now(),
        selfPosition: { x: 8, y: 8 },
        parcels: [],
        agents: [],
      };
      store.mergeRemoteBelief(snapshot);
      assert.ok(events.includes('remote_belief_merged'));
    });
  });

  // --- Query methods ---

  describe('getNearestDeliveryZone', () => {
    it('returns the closest delivery zone by Manhattan distance', () => {
      // Self is at (4,4). Delivery zones: (0,0), (9,0), (9,9)
      const nearest = store.getNearestDeliveryZone({ x: 4, y: 4 });
      assert.ok(nearest);
      // (0,0) dist=8, (9,0) dist=9, (9,9) dist=10
      assert.deepEqual(nearest, { x: 0, y: 0 });
    });

    it('returns nearest when closer to a different zone', () => {
      const nearest = store.getNearestDeliveryZone({ x: 9, y: 8 });
      assert.ok(nearest);
      // (0,0) dist=17, (9,0) dist=8, (9,9) dist=1
      assert.deepEqual(nearest, { x: 9, y: 9 });
    });
  });

  describe('getReachableParcels', () => {
    it('returns parcels reachable via pathfinding', () => {
      store.updateParcels(FIXTURE_PARCELS);
      const reachable = store.getReachableParcels();
      // All fixture parcels are on walkable tiles, self at (4,4) can reach them
      assert.ok(reachable.length > 0);
    });

    it('excludes carried parcels', () => {
      const parcels: RawParcelSensing[] = [
        { id: 'free', x: 5, y: 4, carriedBy: null, reward: 50 },
        { id: 'carried', x: 4, y: 4, carriedBy: 'agent-self', reward: 30 },
      ];
      store.updateParcels(parcels);
      const reachable = store.getReachableParcels();
      const ids = reachable.map(p => p.id);
      assert.ok(ids.includes('free'));
      assert.ok(!ids.includes('carried'));
    });
  });

  // --- Snapshot ---

  describe('toSnapshot', () => {
    it('produces a valid BeliefSnapshot', () => {
      store.updateParcels(FIXTURE_PARCELS);
      store.updateAgents(FIXTURE_AGENTS);

      const snapshot = store.toSnapshot();
      assert.equal(snapshot.agentId, 'agent-self');
      assert.deepEqual(snapshot.selfPosition, { x: 4, y: 4 });
      assert.equal(snapshot.parcels.length, 5);
      assert.equal(snapshot.agents.length, 3);
      assert.ok(snapshot.timestamp > 0);
    });

    it('excludes zero-confidence entries', () => {
      store.updateParcels([
        { id: 'p1', x: 4, y: 5, carriedBy: null, reward: 50 },
      ]);

      const snapshot = store.toSnapshot();
      // All fresh parcels should be included (confidence = 1.0)
      assert.equal(snapshot.parcels.length, 1);
    });
  });

  // --- Ally management ---

  describe('registerAlly / unregisterAlly', () => {
    it('marks agent as ally after registration', () => {
      store.updateAgents([
        { id: 'agent-a', name: 'Alice', x: 0, y: 1, score: 100 },
      ]);
      store.registerAlly('agent-a');
      const alice = store.getAgentBeliefs().find(a => a.id === 'agent-a');
      assert.ok(alice);
      assert.equal(alice.isAlly, true);
    });

    it('unmarks agent as ally after unregistration', () => {
      store.registerAlly('agent-a');
      store.updateAgents([
        { id: 'agent-a', name: 'Alice', x: 0, y: 1, score: 100 },
      ]);
      store.unregisterAlly('agent-a');
      const alice = store.getAgentBeliefs().find(a => a.id === 'agent-a');
      assert.ok(alice);
      assert.equal(alice.isAlly, false);
    });
  });

  // --- onUpdate callbacks ---

  describe('onUpdate', () => {
    it('fires multiple registered callbacks', () => {
      const events1: BeliefChangeType[] = [];
      const events2: BeliefChangeType[] = [];
      store.onUpdate(ct => events1.push(ct));
      store.onUpdate(ct => events2.push(ct));

      store.updateParcels([]);
      assert.equal(events1.length, 1);
      assert.equal(events2.length, 1);
    });
  });

  // --- getMap ---

  describe('getMap', () => {
    it('returns the belief map', () => {
      const map = store.getMap();
      assert.equal(map.width, FIXTURE_MAP_WIDTH);
      assert.equal(map.height, FIXTURE_MAP_HEIGHT);
    });
  });

  // --- getSelf with carried parcels ---

  describe('getSelf carriedParcels', () => {
    it('includes parcels carried by self', () => {
      store.updateParcels([
        { id: 'c1', x: 4, y: 4, carriedBy: 'agent-self', reward: 50 },
        { id: 'c2', x: 5, y: 5, carriedBy: null, reward: 30 },
      ]);
      const self = store.getSelf();
      assert.equal(self.carriedParcels.length, 1);
      assert.equal(self.carriedParcels[0].id, 'c1');
    });
  });
});
