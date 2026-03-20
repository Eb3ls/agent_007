// ============================================================
// src/communication/ally-tracker.test.ts — AllyTracker unit tests (T17)
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AllyTracker } from './ally-tracker.js';
import { MessageHandler } from './message-handler.js';
import { makeHello, makeBeliefShare, makeParcelClaim } from './message-protocol.js';
import { MockGameClient } from '../testing/mock-game-client.js';
import { BeliefStore } from '../beliefs/belief-store.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_SELF,
} from '../testing/fixtures.js';
import type { InterAgentMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SELF_ID  = 'agent-self';
const ALLY_ID  = 'agent-ally';
const SELF_ROLE = 'bdi' as const;

function makeBeliefStore(): BeliefStore {
  const map = new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
  const store = new BeliefStore(map);
  store.updateSelf(FIXTURE_SELF);
  return store;
}

function makeSetup() {
  const client  = new MockGameClient();
  const handler = new MessageHandler(client, SELF_ID);
  const beliefs = makeBeliefStore();
  const tracker = new AllyTracker(handler, beliefs, SELF_ID, SELF_ROLE);
  return { client, handler, beliefs, tracker };
}

/** Simulate an incoming message from the network. */
function deliver(client: MockGameClient, from: string, msg: InterAgentMessage) {
  client.emitMessage(from, msg);
}

// ---------------------------------------------------------------------------
// Ally discovery
// ---------------------------------------------------------------------------

describe('AllyTracker — ally discovery', () => {
  it('registers a new ally on HelloMessage', () => {
    const { client, beliefs, tracker } = makeSetup();
    tracker.start();

    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    assert.equal(tracker.getAllyCount(), 1);
    tracker.stop();
  });

  it('marks ally as isAlly in BeliefStore after discovery', () => {
    const { client, beliefs, tracker } = makeSetup();
    tracker.start();

    // Seed an agent belief for ALLY_ID first
    beliefs.updateAgents([{ id: ALLY_ID, name: 'ally', x: 3, y: 3, score: 0 }]);
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    const agentBelief = beliefs.getAgentBeliefs().find(a => a.id === ALLY_ID);
    assert.ok(agentBelief?.isAlly, 'ally should be marked isAlly in BeliefStore');
    tracker.stop();
  });

  it('sends hello reply to newly discovered ally', () => {
    const { client, tracker } = makeSetup();
    tracker.start();

    const broadcastsBefore = client.broadcastedMessages.length;
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    // Should have sent a direct hello back
    const directHello = client.sentMessages.find(
      m => m.toId === ALLY_ID && m.msg.type === 'hello',
    );
    assert.ok(directHello, 'should send direct hello reply');
    tracker.stop();
  });

  it('does not duplicate-register the same ally', () => {
    const { client, tracker } = makeSetup();
    tracker.start();

    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    assert.equal(tracker.getAllyCount(), 1);
    tracker.stop();
  });

  it('getConnectedAllyIds returns registered ally ids', () => {
    const { client, tracker } = makeSetup();
    tracker.start();

    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));
    const ids = tracker.getConnectedAllyIds();
    assert.ok(ids.includes(ALLY_ID));
    tracker.stop();
  });
});

// ---------------------------------------------------------------------------
// Belief sharing
// ---------------------------------------------------------------------------

describe('AllyTracker — belief sharing', () => {
  it('merges remote belief snapshot on belief_share message', () => {
    const { client, beliefs, tracker } = makeSetup();
    tracker.start();

    // Register ally first (so message passes filter)
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    // Send a belief_share with a parcel not in our beliefs
    const snapshot = {
      agentId: ALLY_ID,
      timestamp: Date.now(),
      selfPosition: { x: 5, y: 5 },
      parcels: [{ id: 'remote-parcel', position: { x: 7, y: 7 }, reward: 20, carriedBy: null }],
      agents: [],
    };
    deliver(client, ALLY_ID, makeBeliefShare(ALLY_ID, snapshot));

    const parcels = beliefs.getParcelBeliefs();
    const remote = parcels.find(p => p.id === 'remote-parcel');
    assert.ok(remote, 'remote parcel should be merged into BeliefStore');
    tracker.stop();
  });
});

// ---------------------------------------------------------------------------
// Stale-ally detection
// ---------------------------------------------------------------------------

describe('AllyTracker — stale detection', () => {
  it('marks ally as disconnected and unregisters after 10s silence', async () => {
    const { client, beliefs, tracker } = makeSetup();
    tracker.start();

    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));
    assert.equal(tracker.getAllyCount(), 1);

    // Manually backdate last contact
    const ally = (tracker as any).allies.get(ALLY_ID);
    ally.lastContactAt = Date.now() - 11_000;

    // Trigger stale check directly
    (tracker as any)._checkStaleAllies();

    assert.equal(tracker.getAllyCount(), 0, 'ally should be marked disconnected');

    // BeliefStore should have unregistered the ally
    const agentBelief = beliefs.getAgentBeliefs().find(a => a.id === ALLY_ID);
    // (may or may not have a belief — just check it's not isAlly)
    if (agentBelief) {
      assert.ok(!agentBelief.isAlly, 'ally should be unregistered from BeliefStore');
    }

    tracker.stop();
  });

  it('releases claimed parcels when ally goes stale', () => {
    const { client, tracker } = makeSetup();
    tracker.start();

    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    // Manually inject a claim by the ally
    (tracker as any).claimedByOthers.set('p-stale', ALLY_ID);
    assert.equal(tracker.getClaimedByOthers().has('p-stale'), true);

    // Backdate and trigger stale check
    (tracker as any).allies.get(ALLY_ID).lastContactAt = Date.now() - 11_000;
    (tracker as any)._checkStaleAllies();

    assert.equal(tracker.getClaimedByOthers().has('p-stale'), false);
    tracker.stop();
  });
});

// ---------------------------------------------------------------------------
// Parcel claim protocol
// ---------------------------------------------------------------------------

describe('AllyTracker — parcel claim (no allies)', () => {
  it('returns claim immediately when no allies are connected', async () => {
    const { tracker } = makeSetup();
    tracker.start();
    const result = await tracker.claimParcel('p-1', 3);
    assert.equal(result, 'claim');
    tracker.stop();
  });
});

describe('AllyTracker — parcel claim protocol', () => {
  it('wins claim when ally yields (reply yield=true)', async () => {
    const { client, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    // Start claim — sends ask to ally via emitAsk
    const claimPromise = tracker.claimParcel('p-1', 2);

    // Ally replies: yield=true means ally yields to us → we win
    client.resolveAsk(ALLY_ID, 'p-1', true);

    const result = await claimPromise;
    assert.equal(result, 'claim', 'should win when ally yields');
    tracker.stop();
  });

  it('yields when ally does not yield (reply yield=false)', async () => {
    const { client, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    const claimPromise = tracker.claimParcel('p-1', 5);

    // Ally replies: yield=false means ally does NOT yield → we must yield
    client.resolveAsk(ALLY_ID, 'p-1', false);

    const result = await claimPromise;
    assert.equal(result, 'yield', 'should yield when ally has priority');
    tracker.stop();
  });

  it('wins claim when timeout elapses with no ack received', async () => {
    const { client, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    const claimPromise = tracker.claimParcel('p-timeout', 3);
    // No ack sent — just wait for timeout
    const result = await claimPromise;
    assert.equal(result, 'claim', 'should win when no acks arrive before timeout');
    tracker.stop();
  });

  it('responds to incoming parcel_claim with ack yield=false when closer', () => {
    const { client, beliefs, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    // Add parcel to beliefs at (1,0) — self is at (5,5) = distance 9, ally claims distance 20
    beliefs.updateParcels([{ id: 'p-near', x: 1, y: 0, carriedBy: null, reward: 10 }]);
    // Self position from FIXTURE_SELF is (5,5)
    // distance self→(1,0) = |5-1|+|5-0| = 4+5 = 9; ally claims distance 20 → we are closer

    deliver(client, ALLY_ID, makeParcelClaim(ALLY_ID, 'p-near', 20));

    const ack = client.sentMessages.find(
      m => m.toId === ALLY_ID && m.msg.type === 'parcel_claim_ack',
    );
    assert.ok(ack, 'should send parcel_claim_ack');
    assert.equal((ack!.msg as any).yield, false, 'should not yield when we are closer');
    tracker.stop();
  });

  it('responds to incoming parcel_claim with ack yield=true when farther', () => {
    const { client, beliefs, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    // Parcel at (1,0); self at (5,5) = distance 9; ally claims distance 2 → ally is closer
    beliefs.updateParcels([{ id: 'p-far', x: 1, y: 0, carriedBy: null, reward: 10 }]);

    deliver(client, ALLY_ID, makeParcelClaim(ALLY_ID, 'p-far', 2));

    const ack = client.sentMessages.find(
      m => m.toId === ALLY_ID && m.msg.type === 'parcel_claim_ack',
    );
    assert.ok(ack, 'should send parcel_claim_ack');
    assert.equal((ack!.msg as any).yield, true, 'should yield when ally is closer');
    // Parcel should be recorded as claimed by ally
    assert.ok(tracker.getClaimedByOthers().has('p-far'), 'ally claim should be recorded');
    tracker.stop();
  });

  it('tie-breaks by agentId when distances are equal', () => {
    const { client, beliefs, tracker } = makeSetup();
    // SELF_ID = 'agent-self', ALLY_ID = 'agent-ally' → 'agent-ally' < 'agent-self'
    // so ally wins ties
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    beliefs.updateParcels([{ id: 'p-tie', x: 5, y: 5, carriedBy: null, reward: 10 }]);
    // Self at (5,5) → distance 0 to (5,5). Ally also claims distance 0.
    deliver(client, ALLY_ID, makeParcelClaim(ALLY_ID, 'p-tie', 0));

    const ack = client.sentMessages.find(
      m => m.toId === ALLY_ID && m.msg.type === 'parcel_claim_ack',
    );
    assert.ok(ack);
    // 'agent-ally' < 'agent-self' so ally wins tie → we yield
    assert.equal((ack!.msg as any).yield, true, 'should yield on tie to lexicographically smaller id');
    tracker.stop();
  });

  it('getClaimedByOthers excludes parcels won by self', () => {
    const { client, beliefs, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    beliefs.updateParcels([{ id: 'p-mine', x: 1, y: 0, carriedBy: null, reward: 10 }]);
    // We are closer (dist 9) than ally (dist 20)
    deliver(client, ALLY_ID, makeParcelClaim(ALLY_ID, 'p-mine', 20));

    assert.ok(!tracker.getClaimedByOthers().has('p-mine'), 'parcel we win should not be in claimedByOthers');
    tracker.stop();
  });
});

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

describe('AllyTracker — lifecycle', () => {
  it('broadcasts hello on start()', () => {
    const { client, tracker } = makeSetup();
    tracker.start();
    const hello = client.broadcastedMessages.find(m => m.type === 'hello');
    assert.ok(hello, 'should broadcast hello on start');
    tracker.stop();
  });

  it('stop() resolves pending claims immediately as claim', async () => {
    const { client, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    const claimPromise = tracker.claimParcel('p-stop', 3);
    tracker.stop(); // should resolve immediately

    const result = await claimPromise;
    assert.equal(result, 'claim');
  });
});
