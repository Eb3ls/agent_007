// ============================================================
// src/deliberation/deliberator.domain.test.ts
// Test delle regole di dominio per Deliberator
// R14 (usa estimateRewardAt non parcel.reward), R15 (filtra reward<=0),
// R18 (capacity soft threshold), R19 (explore quando no parcelle)
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IBeliefStore, ParcelBelief, Position, SelfBelief } from '../types.js';
import { Deliberator } from './deliberator.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import { ParcelTracker } from '../beliefs/parcel-tracker.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
} from '../testing/fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParcel(id: string, overrides: Partial<ParcelBelief> = {}): ParcelBelief {
  return {
    position: { x: 5, y: 4 },
    carriedBy: null,
    reward: 20,
    estimatedReward: 20,
    lastSeen: Date.now(),
    confidence: 1,
    decayRatePerMs: 0,
    id,
    ...overrides,
  };
}

function mockStore(
  parcels: ReadonlyArray<ParcelBelief>,
  selfPos: Position = { x: 4, y: 4 },
  capacity = Infinity,
  exploreTarget: Position | null = null,
): IBeliefStore {
  const zones: Position[] = [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }];
  function nearestDelivery(from: Position): Position {
    let best = zones[0]!;
    let bestD = Math.abs(from.x - best.x) + Math.abs(from.y - best.y);
    for (const z of zones.slice(1)) {
      const d = Math.abs(from.x - z.x) + Math.abs(from.y - z.y);
      if (d < bestD) { bestD = d; best = z; }
    }
    return best;
  }
  const selfBelief: SelfBelief = {
    id: 'agent-self',
    name: 'TestAgent',
    position: selfPos,
    score: 0,
    penalty: 0,
    carriedParcels: [],
  };
  return {
    updateSelf: () => {},
    updateParcels: () => {},
    updateAgents: () => {},
    updateCrates: () => {},
    mergeRemoteBelief: () => {},
    getSelf: () => selfBelief,
    getParcelBeliefs: () => parcels,
    getAgentBeliefs: () => [],
    getMap: () => new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT),
    getNearestDeliveryZone: nearestDelivery,
    getReachableParcels: () => parcels.filter(p => p.carriedBy === null && p.confidence > 0),
    getCrateObstacles: () => [],
    getCrateBeliefs: () => new Map(),
    getCratePositionSet: () => new Set(),
    toSnapshot: () => ({
      agentId: 'agent-self', timestamp: Date.now(),
      selfPosition: selfPos, parcels: [], agents: [],
    }),
    getCapacity: () => capacity,
    getExploreTarget: () => exploreTarget,
    removeParcel: () => {},
    clearDeliveredParcels: () => {},
    markParcelCarried: () => {},
    onUpdate: () => {},
  };
}

// ---------------------------------------------------------------------------
// R15 — filtra parcelle con reward <= 0 prima di generare intenzioni
// ---------------------------------------------------------------------------

describe('Deliberator — R15 filtra parcelle con reward <= 0', () => {
  let deliberator: Deliberator;

  beforeEach(() => { deliberator = new Deliberator(); });

  it('non genera intenzioni per parcella con reward=0', () => {
    const p = makeParcel('p-zero', { reward: 0, estimatedReward: 0 });
    const intentions = deliberator.evaluate(mockStore([p])).intentions;
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(!ids.includes('p-zero'),
      'parcella con reward=0 non deve generare intenzioni');
  });

  it('non genera intenzioni per parcella con reward negativo (edge case)', () => {
    const p = makeParcel('p-neg', { reward: -1, estimatedReward: -1 });
    const intentions = deliberator.evaluate(mockStore([p])).intentions;
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(!ids.includes('p-neg'),
      'parcella con reward negativo non deve generare intenzioni');
  });

  it('genera intenzioni per parcella con reward=1 (> 0)', () => {
    const p = makeParcel('p-one', { reward: 1, estimatedReward: 1 });
    const intentions = deliberator.evaluate(mockStore([p])).intentions;
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(ids.includes('p-one'),
      'parcella con reward=1 deve generare intenzioni');
  });

  it('genera intenzioni solo per le parcelle con reward > 0 (mista)', () => {
    const pAlive = makeParcel('p-alive', { reward: 30 });
    const pDead = makeParcel('p-dead', { position: { x: 6, y: 4 }, reward: 0 });
    const intentions = deliberator.evaluate(mockStore([pAlive, pDead])).intentions;
    const ids = intentions.flatMap(i => i.targetParcels);
    assert.ok(ids.includes('p-alive'));
    assert.ok(!ids.includes('p-dead'),
      'p-dead con reward=0 non deve generare intenzioni');
  });
});

// ---------------------------------------------------------------------------
// R14 — usa estimateRewardAt (via tracker) non parcel.reward direttamente
// ---------------------------------------------------------------------------

describe('Deliberator — R14 usa estimateRewardAt via ParcelTracker', () => {
  it('usa il reward proiettato dal tracker per il calcolo dell\'utility', () => {
    // Verifica che il deliberator chiami estimateRewardAt invece di usare parcel.reward direttamente.
    //
    // Setup:
    //   p_close: reward=10, posizione vicina (x=5), decay lento → projected ≈ 10 a consegna
    //   p_far:   reward=100, posizione lontana (x=9), decay RAPIDO → projected ≈ 5 a consegna
    //
    // Senza tracker: utility(p_far)=100/13 ≈ 7.7 > utility(p_close)=10/9 ≈ 1.1 → p_far vince
    // Con tracker:   utility(p_far)=5/13  ≈ 0.4 < utility(p_close)=10/9  ≈ 1.1 → p_close vince

    const now = Date.now();
    const movDuration = 100;

    // Agente a (4,4); p_close a (5,4)=1 step; delivery(0,0)=9 step → totale 10 step
    // p_far a (9,4)=5 step; delivery(9,0)=4 step → totale 9 step (usamo delivery più vicina)

    const tracker = new ParcelTracker();
    // p_close: reward stabile (decay ~0)
    tracker.observe('p_close', 10, now - 2000);
    tracker.observe('p_close', 10, now); // nessun decay

    // p_far: decade da 100 a 80 in 2000ms → decayRate = 20/2000 = 0.01 reward/ms
    // stepsToParcel=5, stepsToDelivery=4, total=9, tempo=9*100=900ms
    // projected = 80 - 0.01*900 = 80-9 = 71 — ancora alto
    // Meglio: decade da 100 a 10 in 2000ms → decayRate = 90/2000 = 0.045
    // projected = 10 - 0.045*900 = 10-40.5 = -30.5 → max(0,-30.5) = 0
    // Ma utility=0 → instabile. Usiamo decay più moderato:
    // decade da 100 a 50 in 2000ms → decayRate = 50/2000 = 0.025
    // projected = 50 - 0.025*900 = 50 - 22.5 = 27.5
    // utility(p_far) = 27.5/9 ≈ 3.06 vs utility(p_close) = 10/10 = 1.0 → p_far ancora vince
    //
    // Usiamo stepsToDelivery molto alti per p_far:
    // agente a (4,4), p_far a (9,9) → stepsToParcel=10, delivery(9,9)=0 → totale 10 step, tempo 1000ms
    // p_far decay: 100→50 in 2000ms → decayRate=0.025; projected=50-0.025*1000=50-25=25
    // utility(p_far) = 25/10 = 2.5
    // p_close a (5,4): stepsToParcel=1, delivery(0,0)=9 → totale 10, projected=10
    // utility(p_close) = 10/10 = 1.0 → p_far vince ancora
    //
    // Strategia: verifichiamo solo che il deliberator chiama estimateRewardAt osservando che
    // l'utility è calcolata sul reward PROIETTATO, non su parcel.reward.
    // Usiamo un caso dove la proiezione è inferiore al reward attuale e verifichiamo l'utility.
    tracker.observe('p_far', 100, now - 2000);
    tracker.observe('p_far', 50, now); // decay: 50/2000 = 0.025 reward/ms

    // p_close: 1 step to parcel + 9 step to delivery = 10 step = 1000ms
    // projected(p_close) = 10 (no decay)
    // utility(p_close) = 10/10 = 1.0
    const pClose = makeParcel('p_close', { position: { x: 5, y: 4 }, reward: 10, estimatedReward: 10 });
    // p_far: 10 step to parcel + 0 step to delivery = 10 step = 1000ms (alla delivery zone (9,9))
    // projected(p_far) = 50 - 0.025*1000 = 50-25 = 25
    // utility(p_far_projected) = 25/10 = 2.5
    // utility(p_far_raw) = 100/10 = 10 (se usasse parcel.reward invece di tracker)
    const pFar = makeParcel('p_far', { position: { x: 9, y: 9 }, reward: 100, estimatedReward: 100 });

    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(
      mockStore([pClose, pFar], { x: 4, y: 4 }),
      movDuration,
      tracker,
    ).intentions;

    const farIntention = intentions.find(i => i.targetParcels[0] === 'p_far');
    assert.ok(farIntention, 'deve esserci un\'intenzione per p_far');
    // Con il tracker: projected=25 → utility=25/10=2.5
    // Se usasse parcel.reward=100 → utility=100/10=10 (molto diverso)
    // Verifichiamo che l'utility NON sia quella del reward raw
    assert.ok(farIntention.utility < 5,
      `utility(p_far) deve essere calcolata sul projected reward (≈2.5), non su raw (≈10). Got: ${farIntention.utility.toFixed(3)}`);
    assert.ok(farIntention.utility > 0,
      'utility deve essere positiva (reward proiettato >0)');
  });

  it('senza tracker usa estimatedReward del belief (backward compatibility)', () => {
    // estimatedReward già decrementato (non il reward corrente)
    const p = makeParcel('p1', { reward: 50, estimatedReward: 10 });
    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(mockStore([p])).intentions; // no tracker
    assert.ok(intentions.length >= 1);
    // utility = estimatedReward / steps: deve essere positivo
    assert.ok(intentions[0]!.utility > 0);
  });
});

// ---------------------------------------------------------------------------
// R18 — capacity soft threshold: non blocca completamente, ma limita le intenzioni
// ---------------------------------------------------------------------------

describe('Deliberator — R18 capacity soft threshold', () => {
  it('capacity=Infinity: genera intenzioni normalmente', () => {
    const p1 = makeParcel('p1', { position: { x: 5, y: 4 } });
    const p2 = makeParcel('p2', { position: { x: 6, y: 4 } });
    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(mockStore([p1, p2], { x: 4, y: 4 }, Infinity)).intentions;
    assert.ok(intentions.length >= 2, 'capacity Infinity non blocca');
  });

  it('capacity=1, carriedParcels=0 (remaining=1): solo intenzioni singole, no cluster', () => {
    const p1 = makeParcel('p1', { position: { x: 5, y: 4 } });
    const p2 = makeParcel('p2', { position: { x: 6, y: 4 } });
    const store: IBeliefStore = {
      ...mockStore([p1, p2], { x: 4, y: 4 }, 1),
      getSelf: () => ({
        id: 'agent-self', name: 'T',
        position: { x: 4, y: 4 }, score: 0, penalty: 0,
        carriedParcels: [], // 0 carried, remaining=1
      }),
    };
    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(store).intentions;
    // Cluster di 2 deve essere cappato a 1 → non cluster da 2 elementi
    const multiParcel = intentions.filter(i => i.targetParcels.length > 1);
    assert.equal(multiParcel.length, 0,
      'con remaining=1 non devono esserci cluster di 2+ parcelle');
  });

  it('capacity raggiunta (carriedParcels=capacity): nessuna intenzione generata', () => {
    const p1 = makeParcel('p1');
    const carried = makeParcel('c1', { carriedBy: 'agent-self' });
    const store: IBeliefStore = {
      ...mockStore([p1], { x: 4, y: 4 }, 2),
      getSelf: () => ({
        id: 'agent-self', name: 'T',
        position: { x: 4, y: 4 }, score: 0, penalty: 0,
        carriedParcels: [carried, carried], // 2 = capacity
      }),
    };
    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(store).intentions;
    assert.equal(intentions.length, 0,
      'capacity raggiunta: nessuna intenzione di pickup');
  });
});

// ---------------------------------------------------------------------------
// R19 — genera explore intention quando non ci sono parcelle disponibili
// ---------------------------------------------------------------------------

describe('Deliberator — R19 explore intention senza parcelle', () => {
  it('ritorna explore intention quando no parcelle ma c\'è un explore target', () => {
    const target: Position = { x: 1, y: 0 };
    const store = mockStore([], { x: 4, y: 4 }, Infinity, target);
    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(store).intentions;

    assert.equal(intentions.length, 1, 'deve esserci esattamente 1 intenzione');
    assert.equal(intentions[0]!.type, 'explore', 'tipo deve essere explore');
    assert.deepEqual(intentions[0]!.targetPosition, target);
  });

  it('ritorna array vuoto quando no parcelle E no explore target', () => {
    const store = mockStore([], { x: 4, y: 4 }, Infinity, null);
    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(store).intentions;
    assert.equal(intentions.length, 0,
      'senza parcelle e senza explore target: array vuoto');
  });

  it('NON genera explore quando ci sono parcelle valide (reward > 0)', () => {
    const p = makeParcel('p1', { reward: 20 });
    const target: Position = { x: 1, y: 0 };
    const store = mockStore([p], { x: 4, y: 4 }, Infinity, target);
    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(store).intentions;

    const explores = intentions.filter(i => i.type === 'explore');
    assert.equal(explores.length, 0,
      'non deve generare explore quando ci sono parcelle valide');
  });

  it('explore intention ha utility bassa (0.1) rispetto a intenzioni di pickup', () => {
    const target: Position = { x: 1, y: 0 };
    const store = mockStore([], { x: 4, y: 4 }, Infinity, target);
    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(store).intentions;

    assert.equal(intentions.length, 1);
    assert.equal(intentions[0]!.utility, 0.1,
      'explore deve avere utility=0.1 (bassa priorità)');
  });

  it('genera explore quando tutte le parcelle visibili hanno reward=0', () => {
    // Tutte scadute → filtrate da R15 → come se non ci fossero → explore
    const p = makeParcel('p-zero', { reward: 0 });
    const target: Position = { x: 3, y: 0 };
    const store = mockStore([p], { x: 4, y: 4 }, Infinity, target);
    const deliberator = new Deliberator();
    const intentions = deliberator.evaluate(store).intentions;

    const explores = intentions.filter(i => i.type === 'explore');
    assert.ok(explores.length >= 1,
      'con solo parcelle reward=0, deve generare explore intention');
  });
});
