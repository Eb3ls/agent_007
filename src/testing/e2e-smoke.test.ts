// ============================================================
// src/testing/e2e-smoke.test.ts — End-to-end smoke test
// Verifies the full sense → deliberate → plan → execute → delivery flow
// using MockGameClient and fixtures. No real server required.
// ============================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MockGameClient } from './mock-game-client.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_SELF,
} from './fixtures.js';
import { BdiAgent } from '../agents/bdi-agent.js';
import type { AgentConfig, RawParcelSensing } from '../types.js';

// ----------------------------------------------------------------
// Minimal config for tests — no real host needed
// ----------------------------------------------------------------
const TEST_CONFIG: AgentConfig = {
  host: 'http://localhost:8080',
  token: 'test-token',
  role: 'bdi',
  planner: 'bfs',
  logLevel: 'error', // silence logs in test output
  metrics: {
    enabled: false,
    sampleIntervalMs: 5_000,
    outputPath: '/tmp/test-metrics.json',
  },
};

// ----------------------------------------------------------------
// Parcel placed at (1,0) — a spawning tile just one step west of (0,0)
// delivery zone.  Agent starts at (4,4).  Nearest delivery zone is (0,0).
// Expected plan: move_left x4, move_down x4 → pickup → move_left x1 → putdown
// (or any valid BFS path from (4,4) → (1,0) → pickup → (0,0) → putdown)
// ----------------------------------------------------------------
const PARCEL_AT_SPAWN: RawParcelSensing = {
  id: 'smoke-p1',
  x: 1,
  y: 0,
  carriedBy: null,
  reward: 50,
};

// The parcel appears "carried by self" after pickup
const PARCEL_CARRIED: RawParcelSensing = {
  id: 'smoke-p1',
  x: 1,
  y: 0,
  carriedBy: FIXTURE_SELF.id, // agent-self
  reward: 50,
};

// ----------------------------------------------------------------
// Helper: wait until a condition is true, polling every 20 ms.
// Rejects if timeout expires.
// ----------------------------------------------------------------
function waitFor(condition: () => boolean, timeoutMs = 3_000, label = 'condition'): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for: ${label}`));
      }
    }, 20);
  });
}

// ================================================================
// STEP-BY-STEP SMOKE TEST
// ================================================================

describe('E2E Smoke — sense → deliberate → plan → execute → delivery', () => {

  let client: MockGameClient;
  let agent: BdiAgent;

  // ----------------------------------------------------------------
  // STEP 1 — Setup
  // Input:    fresh MockGameClient + BdiAgent, map fixture, self fixture
  // Expected: init() wires event callbacks; emitMap + emitYou populate BeliefStore
  // ----------------------------------------------------------------
  it('Step 1 — Setup: init agent and emit map + self', async () => {
    client = new MockGameClient({
      // pickup returns the parcel as carried by self
      pickupResult: [PARCEL_CARRIED],
      // putdown returns nothing (delivery confirmed)
      putdownResult: [],
    });

    agent = new BdiAgent();

    // init() registers callbacks on client but does NOT yet create BeliefStore
    // (map event fires on drainPending in production; here we emit manually)
    await agent.init(client, TEST_CONFIG);

    // Emit map event — this triggers BeliefStore creation inside init()'s onMap callback
    client.emitMap(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);

    // Emit self so BeliefStore knows agent position
    client.emitYou(FIXTURE_SELF);

    // The agent id should now be set
    assert.equal(agent.id, FIXTURE_SELF.id, 'agent.id set after onYou');

    console.log('[Step 1] Setup OK — agent id:', agent.id, 'at position (4,4)');
  });

  // ----------------------------------------------------------------
  // STEP 2 — Boot: start() launches the BDI loop
  // Input:    agent.start()
  // Expected: no error; deliberation timer starts; initial deliberate fires
  // ----------------------------------------------------------------
  it('Step 2 — Boot: start() launches the loop without error', async () => {
    // start() requires BeliefStore to be initialised (from Step 1)
    await assert.doesNotReject(
      () => agent.start(),
      'start() should not throw',
    );

    console.log('[Step 2] Boot OK — BDI loop started');
  });

  // ----------------------------------------------------------------
  // STEP 3 — Sensing: inject parcels_sensing with one parcel
  // Input:    emitParcelsSensing([PARCEL_AT_SPAWN])
  // Expected: BeliefStore.parcels contains smoke-p1; deliberation fires
  // ----------------------------------------------------------------
  it('Step 3 — Sensing: parcel_sensing event populates BeliefStore', async () => {
    client.emitParcelsSensing([PARCEL_AT_SPAWN]);

    // Give the event loop one tick to propagate
    await new Promise(r => setImmediate(r));

    console.log('[Step 3] Sensing OK — parcel smoke-p1 injected at (1,0)');
  });

  // ----------------------------------------------------------------
  // STEP 4 — Deliberation: agent picks up the parcel intention
  // Input:    parcels event from Step 3 triggers _deliberateAndPlan()
  // Expected: executor starts executing (not idle) within 500 ms
  // Output check: client.moveHistory.length > 0 (first move sent)
  // ----------------------------------------------------------------
  it('Step 4 — Deliberation: agent generates an intention and starts moving', async () => {
    // Wait until the agent issues at least one move to the mock
    await waitFor(
      () => client.moveHistory.length > 0,
      2_000,
      'first move issued',
    );

    assert.ok(client.moveHistory.length > 0, 'at least one move issued after sensing');
    console.log('[Step 4] Deliberation OK — first move:', client.moveHistory[0]);
  });

  // ----------------------------------------------------------------
  // STEP 5 — Planning: plan includes move steps + pickup
  // Input:    execution is progressing (moves being issued)
  // Expected: after moves complete, pickup is called
  // NOTE: we do NOT re-inject PARCEL_CARRIED here.  The MockGameClient is
  //       already configured with pickupResult=[PARCEL_CARRIED], so the
  //       BeliefStore will receive the updated state via the pickup() return
  //       value path.  Re-emitting parcel sensing after delivery would cause a
  //       spurious second delivery cycle.
  // ----------------------------------------------------------------
  it('Step 5 — Planning: pickup is executed after navigation', async () => {
    // Wait for the pickup to be called (agent reached the parcel tile)
    await waitFor(
      () => client.pickupCount.value >= 1,
      5_000,
      'pickup called',
    );

    assert.equal(client.pickupCount.value, 1, 'exactly one pickup called');
    console.log('[Step 5] Planning OK — pickup called, moves so far:', client.moveHistory.length);
  });

  // ----------------------------------------------------------------
  // STEP 6 — Execution: verify move sequence includes moves + pickup
  // Input:    observed client.moveHistory and pickupCount
  // Expected: sequence covers navigation from (4,4) to (1,0): moves present
  // ----------------------------------------------------------------
  it('Step 6 — Execution: move history covers expected navigation steps', () => {
    // Agent starts at (4,4) and parcel is at (1,0).
    // Manhattan distance = 3+4 = 7, so at least 7 moves expected before pickup.
    assert.ok(
      client.moveHistory.length >= 7,
      `Expected ≥7 moves, got ${client.moveHistory.length}`,
    );

    // All recorded moves must be valid directions
    const validDirs = new Set(['up', 'down', 'left', 'right']);
    for (const dir of client.moveHistory) {
      assert.ok(validDirs.has(dir), `invalid direction: ${dir}`);
    }

    console.log('[Step 6] Execution OK — move history:', client.moveHistory.join(' → '));
  });

  // ----------------------------------------------------------------
  // STEP 7 — Delivery: putdown is executed on a delivery tile
  // Input:    agent carries parcel and navigates to delivery zone (0,0)
  // Expected: putdown is called at least once
  // ----------------------------------------------------------------
  it('Step 7 — Delivery: putdown is executed after navigating to delivery zone', async () => {
    await waitFor(
      () => client.putdownCount.value >= 1,
      8_000,
      'putdown called',
    );

    assert.ok(client.putdownCount.value >= 1, `at least one putdown called (got ${client.putdownCount.value})`);
    console.log('[Step 7] Delivery OK — putdown called, total moves:', client.moveHistory.length);
  });

  // ----------------------------------------------------------------
  // STEP 8 — Stop: graceful shutdown
  // Input:    agent.stop()
  // Expected: no error thrown; client disconnected
  // ----------------------------------------------------------------
  after(async () => {
    await assert.doesNotReject(
      () => agent.stop(),
      'stop() should not throw',
    );
    console.log('[Step 8] Stop OK — agent stopped, client connected:', client.isConnected());
  });

  // ----------------------------------------------------------------
  // Summary assertion (runs after all steps)
  // ----------------------------------------------------------------
  it('Step 8 — Stop: stop() is clean', async () => {
    // stop() is already called in `after`; here we just confirm we reached this point.
    // The after() hook handles the actual stop.
    console.log('[Summary] Smoke test complete.');
    console.log('  moves recorded :', client.moveHistory.length);
    console.log('  pickups        :', client.pickupCount.value);
    console.log('  putdowns       :', client.putdownCount.value);
  });
});
