// ============================================================
// src/beliefs/belief-snapshot.test.ts
// Test delle interazioni tra moduli (ARCHITECTURE.md)
// - BeliefStore.getSnapshot() ritorna snapshot immutabile
// - buildSnapshot() produce oggetto frozen
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BeliefStore } from './belief-store.js';
import { BeliefMapImpl } from './belief-map.js';
import { buildSnapshot } from './belief-snapshot.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_SELF,
  FIXTURE_PARCELS,
  FIXTURE_AGENTS,
} from '../testing/fixtures.js';

function makeStore(): BeliefStore {
  const map = new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
  const store = new BeliefStore(map);
  store.updateSelf(FIXTURE_SELF);
  return store;
}

// ---------------------------------------------------------------------------
// BeliefStore.toSnapshot() — immutabilità
// ---------------------------------------------------------------------------

describe('BeliefStore.toSnapshot() — immutabilità dello snapshot', () => {
  let store: BeliefStore;

  beforeEach(() => {
    store = makeStore();
    store.updateParcels(FIXTURE_PARCELS as any);
    store.updateAgents(FIXTURE_AGENTS as any);
  });

  it('toSnapshot ritorna un oggetto con i dati corretti', () => {
    const snap = store.toSnapshot();
    assert.equal(snap.agentId, 'agent-self');
    assert.deepEqual(snap.selfPosition, { x: 4, y: 4 });
    assert.equal(snap.parcels.length, 5);
    assert.equal(snap.agents.length, 3);
    assert.ok(snap.timestamp > 0);
  });

  it('modificare lo snapshot NON altera lo store (snapshot è una copia)', () => {
    const snap = store.toSnapshot();
    const initialParcelCount = store.getParcelBeliefs().length;

    // Prova a mutare l'array dello snapshot
    // (potrebbero essere frozen o meno, dipende dall'implementazione)
    try {
      (snap.parcels as any).push({ id: 'fake', position: { x: 0, y: 0 } });
    } catch {
      // Se frozen: l'errore è atteso
    }

    // Lo store non deve essere influenzato
    assert.equal(store.getParcelBeliefs().length, initialParcelCount,
      'lo store non deve essere alterato da modifiche allo snapshot');
  });

  it('due chiamate a toSnapshot ritornano oggetti distinti (non lo stesso riferimento)', () => {
    const snap1 = store.toSnapshot();
    const snap2 = store.toSnapshot();

    assert.notEqual(snap1, snap2, 'toSnapshot deve ritornare un nuovo oggetto ad ogni chiamata');
  });

  it('lo snapshot riflette lo stato al momento della chiamata', () => {
    const snap1 = store.toSnapshot();
    const count1 = snap1.parcels.length;

    // Aggiorna le parcelle nello store
    store.updateParcels([
      { id: 'new-p', x: 3, y: 3, carriedBy: null, reward: 10 },
    ]);

    const snap2 = store.toSnapshot();
    // snap1 deve avere i dati al momento della prima chiamata (non aggiornati)
    // snap2 deve avere i dati aggiornati
    // NOTA: snap1 è già stato catturato, non cambia
    assert.equal(snap1.parcels.length, count1, 'snap1 non deve cambiare dopo aggiornamento store');
    // snap2 potrebbe avere un conteggio diverso (dipende dalla belief revision)
    assert.ok(snap2.timestamp >= snap1.timestamp, 'snap2 deve avere timestamp >= snap1');
  });
});

// ---------------------------------------------------------------------------
// buildSnapshot() — deep-frozen
// ---------------------------------------------------------------------------

describe('buildSnapshot() — snapshot profondamente frozen', () => {
  let store: BeliefStore;

  beforeEach(() => {
    store = makeStore();
    store.updateParcels(FIXTURE_PARCELS as any);
  });

  it('buildSnapshot ritorna oggetto frozen', () => {
    const snap = buildSnapshot(store);
    assert.ok(Object.isFrozen(snap), 'lo snapshot deve essere frozen');
  });

  it('buildSnapshot: l\'array parcels è frozen', () => {
    const snap = buildSnapshot(store);
    assert.ok(Object.isFrozen(snap.parcels), 'parcels array deve essere frozen');
  });

  it('buildSnapshot: l\'array agents è frozen', () => {
    store.updateAgents(FIXTURE_AGENTS as any);
    const snap = buildSnapshot(store);
    assert.ok(Object.isFrozen(snap.agents), 'agents array deve essere frozen');
  });

  it('buildSnapshot: selfPosition è frozen', () => {
    const snap = buildSnapshot(store);
    assert.ok(Object.isFrozen(snap.selfPosition), 'selfPosition deve essere frozen');
  });

  it('modificare lo snapshot frozen lancia TypeError (strict mode)', () => {
    const snap = buildSnapshot(store);
    assert.throws(
      () => { (snap as any).agentId = 'hacked'; },
      TypeError,
      'modificare uno snapshot frozen deve lanciare TypeError',
    );
  });

  it('modificare una parcella dello snapshot frozen lancia TypeError', () => {
    store.updateParcels([{ id: 'p1', x: 5, y: 5, carriedBy: null, reward: 10 }]);
    const snap = buildSnapshot(store);
    if (snap.parcels.length > 0) {
      assert.throws(
        () => { (snap.parcels[0] as any).reward = 999; },
        TypeError,
        'modificare una parcella dello snapshot deve lanciare TypeError',
      );
    }
  });

  it('buildSnapshot non altera lo store originale', () => {
    const countBefore = store.getParcelBeliefs().length;
    buildSnapshot(store);
    assert.equal(store.getParcelBeliefs().length, countBefore,
      'buildSnapshot non deve modificare lo store');
  });
});
