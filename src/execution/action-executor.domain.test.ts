// ============================================================
// src/execution/action-executor.domain.test.ts
// Test delle regole di dominio per ActionExecutor
// R07 (onReplanRequired distinto da onStepFailed), R08 (inFlight flag), R09 (direzioni)
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor } from './action-executor.js';
import { MockGameClient } from '../testing/mock-game-client.js';
import { actionToDirection } from './action-types.js';
import type { Plan, PlanStep, ReplanSignal } from '../types.js';

function makePlan(steps: PlanStep[], id = 'plan-domain'): Plan {
  return {
    id,
    intentionId: 'intent-1',
    steps,
    estimatedReward: 10,
    createdAt: Date.now(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// R07 — onReplanRequired distinto da onStepFailed dopo retry esauriti
// ---------------------------------------------------------------------------

describe('ActionExecutor — R07 onReplanRequired vs onStepFailed', () => {
  let client: MockGameClient;
  let executor: ActionExecutor;

  beforeEach(() => {
    client = new MockGameClient();
    client.setMeasuredActionDurationMs(5);
    executor = new ActionExecutor(client);
  });

  it('onStepFailed si attiva quando un movimento fallisce (dopo i retry)', async () => {
    // Tutti i movimenti falliscono → dopo i retry deve attivarsi onStepFailed
    client.setActionConfig({ moveSucceeds: false });

    let stepFailed = false;
    let replanRequired = false;
    executor.onStepFailed(() => { stepFailed = true; });
    executor.onReplanRequired(() => { replanRequired = true; });

    executor.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
    ]));
    await delay(700);

    // Per la semantica del codice: retry esauriti → onStepFailed (non onReplanRequired)
    // onReplanRequired è per collisioni rilevate dal codice esterno
    assert.ok(stepFailed, 'onStepFailed deve attivarsi dopo retry esauriti');
  });

  it('onStepFailed e onReplanRequired sono callback distinte (registrazione separata)', () => {
    // Verifica che il sistema supporti entrambe le callback come API separate
    const stepFailedCbs: string[] = [];
    const replanCbs: string[] = [];

    executor.onStepFailed(() => stepFailedCbs.push('step'));
    executor.onReplanRequired(() => replanCbs.push('replan'));

    // Solo registrazione — verifica che l'API esista
    assert.ok(typeof executor.onStepFailed === 'function');
    assert.ok(typeof executor.onReplanRequired === 'function');
  });

  it('onPlanComplete NON si attiva quando onStepFailed è emesso', async () => {
    client.setActionConfig({ moveSucceeds: false });

    let planComplete = false;
    let stepFailed = false;
    executor.onPlanComplete(() => { planComplete = true; });
    executor.onStepFailed(() => { stepFailed = true; });

    executor.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
    ]));
    await delay(700);

    assert.ok(stepFailed, 'onStepFailed deve attivarsi');
    assert.ok(!planComplete, 'onPlanComplete NON deve attivarsi quando il piano fallisce');
  });

  it('distingue movimento fallito da pickup (pickup non usa retry)', async () => {
    // pickup non fallisce mai anche con moveSucceeds=false (non è un move)
    client.setActionConfig({ moveSucceeds: false });

    let stepFailed = false;
    let planComplete = false;
    executor.onStepFailed(() => { stepFailed = true; });
    executor.onPlanComplete(() => { planComplete = true; });

    executor.executePlan(makePlan([
      { action: 'pickup', expectedPosition: { x: 4, y: 4 } },
    ]));
    await delay(100);

    assert.ok(!stepFailed, 'pickup non deve fallire anche con moveSucceeds=false');
    assert.ok(planComplete, 'piano con solo pickup deve completarsi');
  });
});

// ---------------------------------------------------------------------------
// R08 — inFlight flag: non invia azione successiva prima dell'ack
// ---------------------------------------------------------------------------

describe('ActionExecutor — R08 inFlight flag (azioni sequenziali)', () => {
  it('getInFlightAction() ritorna null quando idle', () => {
    const client = new MockGameClient();
    const executor = new ActionExecutor(client);
    assert.equal(executor.getInFlightAction(), null);
  });

  it('getInFlightAction() ritorna l\'azione in corso durante esecuzione', async () => {
    const client = new MockGameClient();
    client.setActionConfig({ actionDelayMs: 50 });
    const executor = new ActionExecutor(client);

    executor.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
    ]));

    // Durante l'esecuzione: l'azione in volo deve essere visibile
    await delay(10);
    const inFlight = executor.getInFlightAction();
    assert.ok(inFlight, 'deve esserci un\'azione in volo durante l\'esecuzione');
    assert.equal(inFlight!.action, 'move_right');

    await delay(200); // attendi completamento
    assert.equal(executor.getInFlightAction(), null, 'null dopo completamento');
  });

  it('non invia la seconda azione prima del completamento della prima', async () => {
    // Usa un client con delay significativo: verifica che le mosse non si sovrappongano
    const client = new MockGameClient();
    client.setActionConfig({ actionDelayMs: 30 });
    const executor = new ActionExecutor(client);

    const timestamps: number[] = [];
    const origMove = client.move.bind(client);
    client.move = async (dir) => {
      timestamps.push(Date.now());
      return origMove(dir);
    };

    executor.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
      { action: 'move_right', expectedPosition: { x: 6, y: 4 } },
    ]));
    await delay(200);

    assert.equal(timestamps.length, 2, 'deve aver inviato 2 mosse');
    // La seconda mossa deve essere inviata dopo la prima (almeno ~30ms dopo)
    assert.ok(
      timestamps[1]! - timestamps[0]! >= 25,
      `La seconda azione deve essere inviata dopo l'ack della prima. Gap: ${timestamps[1]! - timestamps[0]!}ms`,
    );
  });

  it('getInFlightAction() è null tra un\'azione e l\'altra (solo durante l\'azione)', async () => {
    const client = new MockGameClient();
    // Con delay=0 le azioni sono istantanee; usiamo un piccolo delay
    client.setActionConfig({ actionDelayMs: 5 });
    const executor = new ActionExecutor(client);

    const inFlightStates: (boolean)[] = [];

    // Controlla lo stato prima che il loop parta
    inFlightStates.push(executor.getInFlightAction() !== null);

    executor.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
    ]));

    // Durante l'azione
    await delay(2);
    inFlightStates.push(executor.getInFlightAction() !== null);

    await delay(100);
    // Dopo completamento
    inFlightStates.push(executor.getInFlightAction() !== null);

    assert.equal(inFlightStates[0], false, 'prima dell\'esecuzione: non in volo');
    assert.equal(inFlightStates[1], true,  'durante l\'esecuzione: in volo');
    assert.equal(inFlightStates[2], false, 'dopo completamento: non in volo');
  });
});

// ---------------------------------------------------------------------------
// R09 — Convenzione assi: up=y+1, down=y-1, right=x+1, left=x-1
// ---------------------------------------------------------------------------

describe('ActionExecutor + action-types — R09 convenzione assi', () => {
  it('actionToDirection: move_up → \'up\'', () => {
    assert.equal(actionToDirection('move_up'), 'up');
  });

  it('actionToDirection: move_down → \'down\'', () => {
    assert.equal(actionToDirection('move_down'), 'down');
  });

  it('actionToDirection: move_right → \'right\'', () => {
    assert.equal(actionToDirection('move_right'), 'right');
  });

  it('actionToDirection: move_left → \'left\'', () => {
    assert.equal(actionToDirection('move_left'), 'left');
  });

  it('emitMove(\'up\') corrisponde a y+1 (la direzione \'up\' incrementa y)', async () => {
    // R09: up=y+1. Il client riceve 'up' → il server incrementa y
    // Verifichiamo che ActionExecutor invii 'up' per move_up
    const client = new MockGameClient();
    const executor = new ActionExecutor(client);

    executor.executePlan(makePlan([
      { action: 'move_up', expectedPosition: { x: 4, y: 5 } }, // y+1=5
    ]));
    await delay(50);

    assert.deepEqual(client.moveHistory, ['up'],
      'move_up deve inviare \'up\' al client (R09: up=y+1)');
  });

  it('emitMove(\'down\') corrisponde a y-1', async () => {
    const client = new MockGameClient();
    const executor = new ActionExecutor(client);

    executor.executePlan(makePlan([
      { action: 'move_down', expectedPosition: { x: 4, y: 3 } }, // y-1=3
    ]));
    await delay(50);

    assert.deepEqual(client.moveHistory, ['down'],
      'move_down deve inviare \'down\' al client (R09: down=y-1)');
  });

  it('emitMove(\'right\') corrisponde a x+1', async () => {
    const client = new MockGameClient();
    const executor = new ActionExecutor(client);

    executor.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } }, // x+1=5
    ]));
    await delay(50);

    assert.deepEqual(client.moveHistory, ['right'],
      'move_right deve inviare \'right\' al client (R09: right=x+1)');
  });

  it('emitMove(\'left\') corrisponde a x-1', async () => {
    const client = new MockGameClient();
    const executor = new ActionExecutor(client);

    executor.executePlan(makePlan([
      { action: 'move_left', expectedPosition: { x: 3, y: 4 } }, // x-1=3
    ]));
    await delay(50);

    assert.deepEqual(client.moveHistory, ['left'],
      'move_left deve inviare \'left\' al client (R09: left=x-1)');
  });
});
