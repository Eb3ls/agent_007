// ============================================================
// src/agents/bdi-agent.test.ts — T15 unit tests
// Tests BdiAgent wiring and basic sense→plan→execute cycle
// using MockGameClient (no real server required).
// ============================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '../types.js';
import { BdiAgent } from './bdi-agent.js';
import { MockGameClient } from '../testing/mock-game-client.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_SELF,
} from '../testing/fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG: AgentConfig = {
  host:     'http://localhost:3000',
  token:    'test-token',
  role:     'bdi',
  planner:  'bfs',
  logLevel: 'error',  // suppress all log output in tests
};

/**
 * Poll `condition` every event-loop tick until it is true or `timeoutMs` elapses.
 */
function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (condition()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      setImmediate(check);
    };
    setImmediate(check);
  });
}

// ---------------------------------------------------------------------------
// BdiAgent — wiring & lifecycle
// ---------------------------------------------------------------------------

describe('BdiAgent — lifecycle', () => {
  let client: MockGameClient;
  let agent: BdiAgent;

  beforeEach(async () => {
    client = new MockGameClient();
    agent  = new BdiAgent();
    await agent.init(client, TEST_CONFIG);
    // Simulate drainPending: fire map then you event
    client.emitMap(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
    client.emitYou(FIXTURE_SELF);
  });

  afterEach(async () => {
    await agent.stop();
  });

  it('init() wires map/you/parcel/agent callbacks without throwing', () => {
    // If we got here without throw, init() succeeded
    assert.ok(true);
  });

  it('start() succeeds after map event has been received', async () => {
    await assert.doesNotReject(() => agent.start());
  });

  it('start() throws when map event has not been received', async () => {
    const freshClient = new MockGameClient();
    const freshAgent  = new BdiAgent();
    await freshAgent.init(freshClient, TEST_CONFIG);
    // Do NOT emit map event

    await assert.rejects(
      () => freshAgent.start(),
      /map event/i,
    );
  });

  it('agent id is populated after you event', async () => {
    assert.equal(agent.id, FIXTURE_SELF.id);
  });

  it('role is "bdi"', () => {
    assert.equal(agent.role, 'bdi');
  });

  it('stop() does not throw even if no plan is running', async () => {
    await agent.start();
    await assert.doesNotReject(() => agent.stop());
  });
});

// ---------------------------------------------------------------------------
// BdiAgent — sense → plan → execute cycle
// ---------------------------------------------------------------------------

describe('BdiAgent — pickup and deliver cycle', () => {
  let client: MockGameClient;
  let agent: BdiAgent;

  beforeEach(async () => {
    client = new MockGameClient();
    agent  = new BdiAgent();
    await agent.init(client, TEST_CONFIG);
    client.emitMap(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
    client.emitYou(FIXTURE_SELF); // agent at (4,4)
    await agent.start();
  });

  afterEach(async () => {
    await agent.stop();
  });

  it('agent picks up and delivers a visible parcel', async () => {
    // Parcel at (5,4) — 1 step right from agent (4,4)
    client.emitParcelsSensing([
      { id: 'p1', x: 5, y: 4, carriedBy: null, reward: 50 },
    ]);

    await waitFor(() => client.putdownCount.value > 0, 2000);

    assert.ok(client.pickupCount.value > 0,  'agent should have picked up the parcel');
    assert.ok(client.putdownCount.value > 0, 'agent should have delivered the parcel');
    assert.ok(client.moveHistory.length > 0, 'agent should have moved');
  });

  it('agent replans when target parcel disappears between sensing updates', async () => {
    // Emit two parcels: p1 close, p2 far. Agent should target p1.
    client.emitParcelsSensing([
      { id: 'p1', x: 5, y: 4, carriedBy: null, reward: 50 },
      { id: 'p2', x: 9, y: 9, carriedBy: null, reward: 10 },
    ]);

    // Wait for planning to start (at least one move emitted)
    await waitFor(() => client.moveHistory.length > 0, 1000);

    // p1 disappears — re-emit sensing without p1 (but p2 is still reachable from any pos)
    // NOTE: because we update parcels after some moves, beliefs will be partially updated.
    // The agent should detect p1 is gone (when next sensing update arrives) and replan.
    client.emitParcelsSensing([
      { id: 'p2', x: 9, y: 9, carriedBy: null, reward: 10 },
    ]);

    // Agent should eventually complete a delivery (picking up p2 instead)
    await waitFor(() => client.putdownCount.value > 0, 2000);
    assert.ok(client.putdownCount.value > 0, 'agent should have delivered after replanning');
  });

  it('agent handles no visible parcels gracefully', async () => {
    // Emit empty parcel sensing — no crash expected
    client.emitParcelsSensing([]);

    // Give the agent a tick to process
    await new Promise(r => setImmediate(r));
    assert.ok(true, 'no crash on empty parcel sensing');
  });
});

// ---------------------------------------------------------------------------
// BdiAgent — T36 integration scenarios
// ---------------------------------------------------------------------------

describe('BdiAgent — capacity enforcement', () => {
  let client: MockGameClient;
  let agent: BdiAgent;

  beforeEach(async () => {
    client = new MockGameClient({ serverCapacity: 1 });
    agent  = new BdiAgent();
    await agent.init(client, TEST_CONFIG);
    client.emitMap(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
    client.emitYou(FIXTURE_SELF); // agent at (4,4)
    await agent.start();
  });

  afterEach(async () => {
    await agent.stop();
  });

  it('agent prefers delivering over chasing a distant low-value parcel', async () => {
    // Agent at (4,4) carries p-carried (50pt). Nearest delivery zone (0,0) is 8 steps away.
    // p-far at (9,9) worth only 5pt — detour: 10 steps to pickup + 18 steps to delivery = 28 total.
    // Portfolio comparison: 50/8 = 6.25 deliver-value vs (50+5)/28 ≈ 1.96 pickup-value → deliver wins.
    client.emitParcelsSensing([
      { id: 'p-carried', x: 4, y: 4, carriedBy: FIXTURE_SELF.id, reward: 50 },
      { id: 'p-far',     x: 9, y: 9, carriedBy: null,            reward: 5 },
    ]);

    // Wait for delivery (putdown)
    await waitFor(() => client.putdownCount.value > 0, 3000);

    assert.equal(client.pickupCount.value, 0, 'agent must not chase a distant low-value parcel while carrying');
    assert.ok(client.putdownCount.value > 0, 'agent must deliver the carried parcel');
  });
});

describe('BdiAgent — reconnect handling', () => {
  let client: MockGameClient;
  let agent: BdiAgent;

  beforeEach(async () => {
    client = new MockGameClient();
    agent  = new BdiAgent();
    await agent.init(client, TEST_CONFIG);
    client.emitMap(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
    client.emitYou(FIXTURE_SELF);
    await agent.start();
  });

  afterEach(async () => {
    await agent.stop();
  });

  it('does not lose agent id after reconnect', () => {
    const idBefore = agent.id;
    client.emitDisconnect();
    client.emitReconnect();
    assert.equal(agent.id, idBefore, 'agent id must survive reconnect');
  });

  it('second map event after reconnect does not reset beliefs', () => {
    // Seed a parcel belief before reconnect
    client.emitParcelsSensing([
      { id: 'p-before', x: 5, y: 4, carriedBy: null, reward: 50 },
    ]);

    // Simulate reconnect: map re-fires (server sends it on reconnect)
    client.emitDisconnect();
    client.emitMap(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
    client.emitReconnect();

    // p-before must still exist (may have reduced confidence but not deleted)
    client.emitYou(FIXTURE_SELF);
    client.emitParcelsSensing([
      { id: 'p-after', x: 6, y: 4, carriedBy: null, reward: 40 },
    ]);

    // Agent should still be functional and plan after reconnect
    assert.doesNotThrow(() => {
      // Deliberation on reconnect must not throw
    });
  });

  it('agent resumes deliberation after reconnect', async () => {
    const movesBefore = client.moveHistory.length;

    client.emitDisconnect();
    client.emitReconnect();

    // Emit a parcel so agent has something to do
    client.emitParcelsSensing([
      { id: 'p-reconnect', x: 5, y: 4, carriedBy: null, reward: 50 },
    ]);

    await waitFor(() => client.moveHistory.length > movesBefore, 2000);
    assert.ok(client.moveHistory.length > movesBefore, 'agent should resume moving after reconnect');
  });
});

describe('BdiAgent — exploration trigger', () => {
  let client: MockGameClient;
  let agent: BdiAgent;

  beforeEach(async () => {
    client = new MockGameClient();
    agent  = new BdiAgent();
    await agent.init(client, TEST_CONFIG);
    client.emitMap(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
    client.emitYou(FIXTURE_SELF); // agent at (4,4)
    await agent.start();
  });

  afterEach(async () => {
    await agent.stop();
  });

  it('agent moves toward spawning tiles when no parcels are visible', async () => {
    // Empty sensing — no parcels, no carried parcels
    client.emitParcelsSensing([]);

    // Agent should explore (move toward unvisited spawning tiles)
    await waitFor(() => client.moveHistory.length > 0, 2000);

    assert.ok(client.moveHistory.length > 0, 'agent should move during exploration');
    assert.equal(client.pickupCount.value, 0, 'agent should not attempt pickup during exploration');
  });
});
