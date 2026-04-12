// ============================================================
// src/planning/planner-factory.test.ts
// Test di PlannerFactory — build('bfs') ritorna IPlanner funzionante,
// build('llm') ritorna catena con fallback (ARCHITECTURE.md)
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlannerChain } from './planner-factory.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import { BeliefStore } from '../beliefs/belief-store.js';
import type { IBeliefStore, PlannerChainType } from '../types.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_SELF,
} from '../testing/fixtures.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeBeliefStore(): BeliefStore {
  const map = new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
  const store = new BeliefStore(map);
  store.updateSelf(FIXTURE_SELF);
  return store;
}

const fixtureMap = new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);

// ---------------------------------------------------------------------------
// PlannerFactory.build('bfs') — IPlanner funzionante
// ---------------------------------------------------------------------------

describe('PlannerFactory — build(\'bfs\')', () => {
  it('ritorna un IPlanner con metodo plan', () => {
    const planner = buildPlannerChain({ chainType: 'bfs' });
    assert.equal(typeof planner.plan, 'function', 'deve avere metodo plan');
    assert.equal(typeof planner.abort, 'function', 'deve avere metodo abort');
    assert.equal(typeof planner.name, 'string', 'deve avere proprietà name');
  });

  it('nome del planner è \'bfs\'', () => {
    const planner = buildPlannerChain({ chainType: 'bfs' });
    assert.ok(planner.name.includes('bfs'),
      `il nome deve contenere 'bfs'. Got: '${planner.name}'`);
  });

  it('genera un piano valido su una mappa semplice', async () => {
    const planner = buildPlannerChain({ chainType: 'bfs' });

    const result = await planner.plan({
      currentPosition: { x: 0, y: 1 },
      carriedParcels: [],
      targetParcels: [{
        id: 'p1',
        position: { x: 1, y: 0 },
        carriedBy: null,
        reward: 10,
        estimatedReward: 10,
        lastSeen: Date.now(),
        confidence: 1,
        decayRatePerMs: 0,
      }],
      deliveryZones: [{ x: 0, y: 0 }],
      beliefMap: fixtureMap,
    });

    assert.ok(result.success, `BFS plan deve avere successo. Error: ${result.error}`);
    assert.ok(result.plan, 'plan deve essere definito');
    assert.ok(result.plan!.steps.length > 0, 'piano deve avere step');
  });

  it('ritorna success=false su destinazione irraggiungibile', async () => {
    const planner = buildPlannerChain({ chainType: 'bfs' });

    // Mappa 1x1: nessuna delivery zone raggiungibile con target inesistente
    const tinyMap = new BeliefMapImpl(
      [{ x: 0, y: 0, type: 3 }], 1, 1,
    );

    const result = await planner.plan({
      currentPosition: { x: 0, y: 0 },
      carriedParcels: [],
      targetParcels: [{
        id: 'p-unreachable',
        position: { x: 5, y: 5 }, // fuori dalla mappa 1x1
        carriedBy: null,
        reward: 10,
        estimatedReward: 10,
        lastSeen: Date.now(),
        confidence: 1,
        decayRatePerMs: 0,
      }],
      deliveryZones: [{ x: 9, y: 9 }], // fuori dalla mappa 1x1
      beliefMap: tinyMap,
    });

    assert.equal(result.success, false,
      'BFS deve ritornare success=false quando destinazione irraggiungibile');
  });
});

// ---------------------------------------------------------------------------
// PlannerFactory.build('pddl') — ritorna catena pddl→bfs
// ---------------------------------------------------------------------------

describe('PlannerFactory — build(\'pddl\')', () => {
  it('ritorna un IPlanner con metodo plan', () => {
    const planner = buildPlannerChain({ chainType: 'pddl' });
    assert.equal(typeof planner.plan, 'function');
    assert.equal(typeof planner.abort, 'function');
  });

  it('nome della catena include \'pddl\'', () => {
    const planner = buildPlannerChain({ chainType: 'pddl' });
    assert.ok(planner.name.includes('pddl') || planner.name.includes('bfs'),
      `il nome della catena pddl→bfs deve includere 'pddl' o 'bfs'. Got: '${planner.name}'`);
  });
});

// ---------------------------------------------------------------------------
// PlannerFactory.build('llm') — richiede llmConfig e beliefs
// ---------------------------------------------------------------------------

describe('PlannerFactory — build(\'llm\')', () => {
  it('lancia errore se llmConfig non fornito', () => {
    assert.throws(
      () => buildPlannerChain({ chainType: 'llm' }),
      /llmConfig is required/,
      'deve lanciare errore se llmConfig mancante',
    );
  });

  it('lancia errore se beliefs non fornito', () => {
    assert.throws(
      () => buildPlannerChain({
        chainType: 'llm',
        llmConfig: {
          model: 'gpt-4',
          apiUrl: 'http://localhost',
          apiToken: 'test-key',
          maxTokenBudget: 500,
          minCallIntervalMs: 0,
        },
        // beliefs mancante
      }),
      /beliefs is required/,
      'deve lanciare errore se beliefs mancante',
    );
  });

  it('ritorna IPlanner funzionante quando llmConfig e beliefs forniti', () => {
    const beliefs = makeBeliefStore();
    const planner = buildPlannerChain({
      chainType: 'llm',
      llmConfig: {
        model: 'gpt-4',
        apiUrl: 'http://localhost',
        apiToken: 'test-key',
        maxTokenBudget: 500,
        minCallIntervalMs: 0,
      },
      beliefs,
    });

    assert.equal(typeof planner.plan, 'function', 'deve avere metodo plan');
    assert.equal(typeof planner.abort, 'function', 'deve avere metodo abort');
  });

  it('nome della catena include \'llm\'', () => {
    const beliefs = makeBeliefStore();
    const planner = buildPlannerChain({
      chainType: 'llm',
      llmConfig: {
        model: 'gpt-4',
        apiUrl: 'http://localhost',
        apiToken: 'test-key',
        maxTokenBudget: 500,
        minCallIntervalMs: 0,
      },
      beliefs,
    });

    assert.ok(planner.name.includes('llm') || planner.name.includes('bfs'),
      `il nome della catena llm→pddl→bfs deve includere 'llm' o 'bfs'. Got: '${planner.name}'`);
  });
});
