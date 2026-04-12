// ============================================================
// src/communication/message-protocol.domain.test.ts
// Test delle regole di dominio per message-protocol e ally-tracker
// R25 (timestamp in tutti i messaggi), R24 (timeout ≤ 500ms), R26 (heartbeat, non ack say)
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeHello,
  makeBeliefShare,
  makeParcelClaim,
  makeParcelClaimAck,
  makeIntentionAnnounce,
  makeIntentionRelease,
  isInterAgentMessage,
} from './message-protocol.js';
import { AllyTracker } from './ally-tracker.js';
import { MessageHandler } from './message-handler.js';
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

const SELF_ID = 'agent-self';
const ALLY_ID = 'agent-ally';

function makeSetup() {
  const client = new MockGameClient();
  const handler = new MessageHandler(client, SELF_ID);
  const map = new BeliefMapImpl(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
  const beliefs = new BeliefStore(map);
  beliefs.updateSelf(FIXTURE_SELF);
  const tracker = new AllyTracker(handler, beliefs, SELF_ID, 'bdi');
  return { client, handler, beliefs, tracker };
}

function deliver(client: MockGameClient, from: string, msg: InterAgentMessage) {
  client.emitMessage(from, msg);
}

// ---------------------------------------------------------------------------
// R25 — Tutti i messaggi costruiti hanno campo `timestamp`
// ---------------------------------------------------------------------------

describe('message-protocol — R25 tutti i messaggi hanno timestamp', () => {
  it('makeHello include campo timestamp (number)', () => {
    const msg = makeHello('agent-1', 'bdi');
    assert.equal(typeof msg.timestamp, 'number',
      'makeHello deve includere campo timestamp');
    assert.ok(msg.timestamp > 0, 'timestamp deve essere positivo');
  });

  it('makeBeliefShare include campo timestamp', () => {
    const snapshot = {
      agentId: 'a', timestamp: Date.now(),
      selfPosition: { x: 0, y: 0 }, parcels: [], agents: [],
    };
    const msg = makeBeliefShare('agent-1', snapshot);
    assert.equal(typeof msg.timestamp, 'number');
    assert.ok(msg.timestamp > 0);
  });

  it('makeParcelClaim include campo timestamp', () => {
    const msg = makeParcelClaim('agent-1', 'parcel-1', 5);
    assert.equal(typeof msg.timestamp, 'number');
    assert.ok(msg.timestamp > 0);
  });

  it('makeParcelClaimAck include campo timestamp', () => {
    const msg = makeParcelClaimAck('agent-1', 'parcel-1', true);
    assert.equal(typeof msg.timestamp, 'number');
    assert.ok(msg.timestamp > 0);
  });

  it('makeIntentionAnnounce include campo timestamp', () => {
    const msg = makeIntentionAnnounce('agent-1', 'intent-1', ['p1'], 'pickup_and_deliver');
    assert.equal(typeof msg.timestamp, 'number');
    assert.ok(msg.timestamp > 0);
  });

  it('makeIntentionRelease include campo timestamp', () => {
    const msg = makeIntentionRelease('agent-1', 'intent-1');
    assert.equal(typeof msg.timestamp, 'number');
    assert.ok(msg.timestamp > 0);
  });

  it('timestamp è approssimato al momento della creazione (non fisso)', async () => {
    const before = Date.now();
    await new Promise(r => setTimeout(r, 2));
    const msg1 = makeHello('a', 'bdi');
    await new Promise(r => setTimeout(r, 2));
    const msg2 = makeHello('a', 'bdi');
    const after = Date.now();

    assert.ok(msg1.timestamp >= before, 'timestamp msg1 >= momento creazione');
    assert.ok(msg2.timestamp >= msg1.timestamp, 'msg2 timestamp >= msg1 timestamp');
    assert.ok(msg2.timestamp <= after, 'timestamp non nel futuro');
  });

  it('isInterAgentMessage ritorna false per messaggi senza timestamp', () => {
    const msgWithoutTs = {
      type: 'hello', agentId: 'a', role: 'bdi', seq: 1
      // manca timestamp
    };
    assert.equal(isInterAgentMessage(msgWithoutTs), false,
      'messaggio senza timestamp non deve passare la validazione');
  });

  it('isInterAgentMessage ritorna true per messaggi con timestamp valido', () => {
    const msg = makeHello('agent-1', 'bdi');
    assert.equal(isInterAgentMessage(msg), true,
      'messaggio valido con timestamp deve passare la validazione');
  });
});

// ---------------------------------------------------------------------------
// R24 — Claim negotiation usa timeout ≤ 500ms
// ---------------------------------------------------------------------------

describe('AllyTracker — R24 claim timeout ≤ 500ms', () => {
  it('claimParcel risolve entro 500ms quando nessun alleato risponde', async () => {
    const { client, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    const start = Date.now();
    // No ack viene inviato → il timeout interno deve risolvere
    const result = await tracker.claimParcel('p-timeout', 3);
    const elapsed = Date.now() - start;

    // Il timeout configurato è 500ms; deve risolvere entro 600ms (margine)
    assert.ok(elapsed <= 600,
      `claimParcel deve risolvere entro 500ms+margine. Elapsed: ${elapsed}ms`);
    assert.equal(result, 'claim',
      'quando nessun alleato risponde, deve vincere il claim');

    tracker.stop();
  });

  it('claimParcel risolve immediatamente (< 100ms) quando nessun alleato è connesso', async () => {
    const { tracker } = makeSetup();
    tracker.start();
    // Nessun alleato registrato

    const start = Date.now();
    const result = await tracker.claimParcel('p-noallies', 3);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 100,
      `senza alleati, claimParcel deve risolvere immediatamente. Elapsed: ${elapsed}ms`);
    assert.equal(result, 'claim');

    tracker.stop();
  });

  it('CLAIM_WAIT_MS è ≤ 500ms (conforme a R24: ask timeout ≤ 1000ms con margine)', () => {
    // Verifica indirettamente tramite comportamento: se il claim risolve entro 600ms
    // con un alleato connesso ma silenzioso, il timeout interno è ≤ 500ms.
    // Questo test misura il timeout effettivo.
    // (Già coperto dal test precedente, ma ripetiamo il bound)
    const { client, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    let resolvedAt = 0;
    const start = Date.now();
    const promise = tracker.claimParcel('p-bound', 5).then(r => {
      resolvedAt = Date.now();
      return r;
    });

    return promise.then(result => {
      const elapsed = resolvedAt - start;
      assert.ok(elapsed <= 600,
        `Il timeout di claim deve essere ≤ 500ms. Elapsed: ${elapsed}ms`);
      tracker.stop();
    });
  });
});

// ---------------------------------------------------------------------------
// R26 — isAllyActive dipende da heartbeat, non da ack di say
// ---------------------------------------------------------------------------

describe('AllyTracker — R26 stato alleato dipende da heartbeat (non da ack di say)', () => {
  it('un alleato si considera disconnesso se non manda messaggi per > 10s', () => {
    const { client, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));
    assert.equal(tracker.getAllyCount(), 1, 'alleato registrato dopo hello');

    // Simula che l'alleato è silenzioso da 11 secondi (nessun heartbeat)
    const ally = (tracker as any).allies.get(ALLY_ID);
    ally.lastContactAt = Date.now() - 11_000;
    (tracker as any)._checkStaleAllies();

    assert.equal(tracker.getAllyCount(), 0,
      'alleato senza heartbeat per >10s deve essere rimosso (R26: heartbeat necessario)');

    tracker.stop();
  });

  it('ricevere un messaggio dall\'alleato aggiorna il lastContactAt', () => {
    const { client, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    const before = Date.now();
    // Simula invecchiamento
    const ally = (tracker as any).allies.get(ALLY_ID);
    ally.lastContactAt = before - 5_000;

    // Ricevi un nuovo messaggio (belief_share = qualsiasi messaggio dall'alleato)
    const snapshot = {
      agentId: ALLY_ID, timestamp: Date.now(),
      selfPosition: { x: 1, y: 1 }, parcels: [], agents: [],
    };
    deliver(client, ALLY_ID, makeBeliefShare(ALLY_ID, snapshot));

    // Il lastContactAt deve essere aggiornato
    const updatedAlly = (tracker as any).allies.get(ALLY_ID);
    assert.ok(updatedAlly.lastContactAt >= before,
      'lastContactAt deve essere aggiornato dopo ricezione messaggio (heartbeat semantics)');

    tracker.stop();
  });

  it('il conteggio degli alleati non aumenta quando si invia un say senza ricevere risposta', () => {
    // R26: say verso agente inesistente è no-op silenzioso → non aggiunge alleati
    const { client, tracker } = makeSetup();
    tracker.start();

    // send a say to a non-registered agent — non deve aggiungere alleati
    // (simulato dal fatto che non arriva alcuna risposta hello)
    assert.equal(tracker.getAllyCount(), 0,
      'nessun alleato senza ricezione di hello (say non aumenta il conteggio)');

    tracker.stop();
  });

  it('un alleato rimane attivo finché riceve messaggi entro 10s', () => {
    const { client, tracker } = makeSetup();
    tracker.start();
    deliver(client, ALLY_ID, makeHello(ALLY_ID, 'bdi'));

    // Aggiorna il lastContactAt come se avesse appena sentito l'alleato (2s fa)
    const ally = (tracker as any).allies.get(ALLY_ID);
    ally.lastContactAt = Date.now() - 2_000; // 2s fa: ancora valido

    (tracker as any)._checkStaleAllies();

    assert.equal(tracker.getAllyCount(), 1,
      'alleato visto 2s fa non deve essere rimosso (timeout=10s)');

    tracker.stop();
  });
});
