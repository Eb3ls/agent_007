// ============================================================
// src/execution/action-executor.test.ts — ActionExecutor tests (T10)
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor } from './action-executor.js';
import { actionToDirection, isMoveAction } from './action-types.js';
import { MockGameClient } from '../testing/mock-game-client.js';
import type { Plan, PlanStep } from '../types.js';

function makePlan(steps: PlanStep[], id = 'plan-1'): Plan {
  return {
    id,
    intentionId: 'intent-1',
    steps,
    estimatedReward: 50,
    createdAt: Date.now(),
  };
}

const FIVE_STEP_PLAN: Plan = makePlan([
  { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
  { action: 'move_right', expectedPosition: { x: 6, y: 4 } },
  { action: 'move_up',    expectedPosition: { x: 6, y: 5 } },
  { action: 'pickup',     expectedPosition: { x: 6, y: 5 } },
  { action: 'putdown',    expectedPosition: { x: 6, y: 5 } },
]);

/** Wait for async plan execution to complete (instant-resolve actions). */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('ActionExecutor', () => {
  let client: MockGameClient;
  let executor: ActionExecutor;

  beforeEach(() => {
    client = new MockGameClient();
    executor = new ActionExecutor(client);
  });

  it('executes all steps in order and fires onPlanComplete', async () => {
    const completed: number[] = [];
    executor.onStepComplete((_step, index) => completed.push(index));

    let planDone = false;
    executor.onPlanComplete(() => { planDone = true; });

    executor.executePlan(FIVE_STEP_PLAN);
    await tick();

    assert.deepEqual(completed, [0, 1, 2, 3, 4]);
    assert.ok(planDone, 'onPlanComplete should fire');
  });

  it('sends correct move directions to client', async () => {
    executor.executePlan(FIVE_STEP_PLAN);
    await tick();

    assert.deepEqual(client.moveHistory, ['right', 'right', 'up']);
    assert.equal(client.pickupCount.value, 1);
    assert.equal(client.putdownCount.value, 1);
  });

  it('returns the completed plan in onPlanComplete', async () => {
    let completedPlan: Plan | null = null;
    executor.onPlanComplete(plan => { completedPlan = plan; });

    executor.executePlan(FIVE_STEP_PLAN);
    await tick();

    assert.ok(completedPlan);
    assert.equal((completedPlan as Plan).id, 'plan-1');
  });

  it('fires onStepFailed when move fails and stops execution', async () => {
    client.setActionConfig({ moveSucceeds: false });

    const failures: Array<{ index: number; reason: string }> = [];
    executor.onStepFailed((_step, index, reason) => {
      failures.push({ index, reason });
    });

    let planDone = false;
    executor.onPlanComplete(() => {
      planDone = true;
    });

    executor.executePlan(FIVE_STEP_PLAN);
    // Move failures trigger retry backoff; allow enough time for all retries
    // and final failure callback.
    await delay(700);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].index, 0);
    // Initial attempt + retries
    assert.ok(client.moveHistory.length >= 1);
    assert.ok(!planDone, "onPlanComplete should NOT fire on failure");
  });

  it('is idle before executing any plan', () => {
    assert.ok(executor.isIdle());
  });

  it('is idle after plan completes', async () => {
    executor.executePlan(FIVE_STEP_PLAN);
    await tick();
    assert.ok(executor.isIdle());
  });

  it('cancels plan after current step completes', async () => {
    client.setActionConfig({ actionDelayMs: 10 });

    const completed: number[] = [];
    executor.onStepComplete((_step, index) => {
      completed.push(index);
      if (index === 1) {
        executor.cancelCurrentPlan();
      }
    });

    let planDone = false;
    executor.onPlanComplete(() => { planDone = true; });

    executor.executePlan(FIVE_STEP_PLAN);
    await delay(500);

    assert.deepEqual(completed, [0, 1]);
    assert.ok(!planDone, 'onPlanComplete should NOT fire on cancellation');
  });

  it('replaces current plan without parallel execution', async () => {
    client.setActionConfig({ actionDelayMs: 10 });

    const plan1 = makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
      { action: 'move_right', expectedPosition: { x: 6, y: 4 } },
      { action: 'move_right', expectedPosition: { x: 7, y: 4 } },
    ], 'plan-1');

    const plan2 = makePlan([
      { action: 'move_up', expectedPosition: { x: 4, y: 5 } },
      { action: 'move_up', expectedPosition: { x: 4, y: 6 } },
    ], 'plan-2');

    let completedPlanId: string | null = null;
    executor.onPlanComplete(plan => { completedPlanId = plan.id; });

    executor.executePlan(plan1);
    executor.executePlan(plan2);
    await delay(500);

    assert.equal(completedPlanId, 'plan-2');
    const upMoves = client.moveHistory.filter(d => d === 'up');
    assert.equal(upMoves.length, 2);
  });

  it('returns null for getInFlightAction when idle', () => {
    assert.equal(executor.getInFlightAction(), null);
  });

  it('returns action info during execution', async () => {
    client.setActionConfig({ actionDelayMs: 50 });

    executor.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
    ]));

    await delay(10);
    const inFlight = executor.getInFlightAction();
    assert.ok(inFlight);
    assert.equal(inFlight!.action, 'move_right');

    await delay(100);
    assert.equal(executor.getInFlightAction(), null);
  });

  it('tracks step index progress', async () => {
    const indices: number[] = [];
    executor.onStepComplete((_step, index) => {
      indices.push(index);
    });

    executor.executePlan(FIVE_STEP_PLAN);
    await tick();

    // onStepComplete provides the index of the completed step
    assert.deepEqual(indices, [0, 1, 2, 3, 4]);
    // After completion, getCurrentStepIndex is past the last step
    assert.equal(executor.getCurrentStepIndex(), 5);
  });

  it('treats timed-out move as replan (not collision), so no dynamic obstacle is recorded', async () => {
    const hangingClient = new MockGameClient();
    hangingClient.move = (_dir) => {
      hangingClient.moveHistory.push(_dir);
      return new Promise(() => {}); // never resolves
    };
    hangingClient.setMeasuredActionDurationMs(10);

    const exec = new ActionExecutor(hangingClient);
    const failures: number[] = [];
    const replans: string[] = [];
    exec.onStepFailed((_step, index) => failures.push(index));
    exec.onReplanRequired((signal) => replans.push(signal.reason));

    exec.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
    ]));

    await delay(250);

    // Timeout must NOT fire onStepFailed (which records a fake dynamic obstacle).
    // Instead it fires onReplanRequired so the agent re-plans from fresh sensing.
    assert.equal(failures.length, 0, 'onStepFailed must not fire on timeout');
    assert.equal(replans.length, 1, 'onReplanRequired must fire on timeout');
    assert.equal(replans[0], 'plan_invalid');
  });
});

describe('action-types helpers', () => {
  it('actionToDirection maps move actions correctly', () => {
    assert.equal(actionToDirection('move_up'), 'up');
    assert.equal(actionToDirection('move_down'), 'down');
    assert.equal(actionToDirection('move_left'), 'left');
    assert.equal(actionToDirection('move_right'), 'right');
    assert.equal(actionToDirection('pickup'), null);
    assert.equal(actionToDirection('putdown'), null);
  });

  it('isMoveAction returns correct boolean', () => {
    assert.equal(isMoveAction('move_up'), true);
    assert.equal(isMoveAction('move_down'), true);
    assert.equal(isMoveAction('pickup'), false);
    assert.equal(isMoveAction('putdown'), false);
  });
});
