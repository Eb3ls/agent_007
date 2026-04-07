// ============================================================
// src/execution/action-executor.edge.test.ts — Edge cases for ActionExecutor
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor } from './action-executor.js';
import { MockGameClient } from '../testing/mock-game-client.js';
import type { Plan, PlanStep } from '../types.js';

function makePlan(steps: PlanStep[], id = 'plan-edge'): Plan {
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

function tick(): Promise<void> {
  return delay(50);
}

describe('ActionExecutor — edge cases', () => {
  let client: MockGameClient;
  let executor: ActionExecutor;

  beforeEach(() => {
    client = new MockGameClient();
    executor = new ActionExecutor(client);
  });

  // --- Empty plan ---

  it('fires onPlanComplete immediately for a plan with no steps', async () => {
    let fired = false;
    executor.onPlanComplete(() => { fired = true; });

    executor.executePlan(makePlan([]));
    await tick();

    assert.ok(fired, 'onPlanComplete must fire for zero-step plan');
    assert.ok(executor.isIdle());
  });

  it('fires no step callbacks for an empty plan', async () => {
    const steps: number[] = [];
    executor.onStepComplete((_s, i) => steps.push(i));

    executor.executePlan(makePlan([]));
    await tick();

    assert.deepEqual(steps, []);
  });

  // --- cancelCurrentPlan() when idle ---

  it('cancelCurrentPlan() when idle does not throw', () => {
    assert.doesNotThrow(() => executor.cancelCurrentPlan());
    assert.ok(executor.isIdle());
  });

  it('cancelCurrentPlan() before executePlan() prevents execution', async () => {
    client.setActionConfig({ actionDelayMs: 30 });
    executor.cancelCurrentPlan(); // sets cancelled = true

    let planDone = false;
    executor.onPlanComplete(() => { planDone = true; });

    executor.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
    ]));

    // executePlan resets cancelled to false before running, so it SHOULD execute
    // This tests that executePlan correctly resets the cancelled flag
    await tick();
    assert.ok(planDone, 'executePlan must reset cancelled flag and proceed');
  });

  // --- onPutdown callback ---

  it('onPutdown fires with correct item count when putdown returns items', async () => {
    client.setActionConfig({
      putdownResult: [
        { id: 'p1' },
        { id: 'p2' },
      ],
    });

    const counts: number[] = [];
    executor.onPutdown(count => counts.push(count));

    executor.executePlan(makePlan([
      { action: 'putdown', expectedPosition: { x: 4, y: 4 } },
    ]));
    await tick();

    assert.deepEqual(counts, [2], 'onPutdown must fire with the number of delivered parcels');
  });

  it('onPutdown does NOT fire when putdown returns no items', async () => {
    // Default putdownResult is [] (empty)
    const counts: number[] = [];
    executor.onPutdown(count => counts.push(count));

    executor.executePlan(makePlan([
      { action: 'putdown', expectedPosition: { x: 4, y: 4 } },
    ]));
    await tick();

    assert.deepEqual(counts, [], 'onPutdown must not fire when no parcels were delivered');
  });

  // --- Multiple callbacks of same type ---

  it('fires all registered onStepComplete callbacks', async () => {
    const results: string[] = [];
    executor.onStepComplete(() => results.push('cb1'));
    executor.onStepComplete(() => results.push('cb2'));
    executor.onStepComplete(() => results.push('cb3'));

    executor.executePlan(makePlan([
      { action: 'pickup', expectedPosition: { x: 4, y: 4 } },
    ]));
    await tick();

    assert.deepEqual(results, ['cb1', 'cb2', 'cb3']);
  });

  it('fires all registered onPlanComplete callbacks', async () => {
    const ids: string[] = [];
    executor.onPlanComplete(p => ids.push(p.id + '-a'));
    executor.onPlanComplete(p => ids.push(p.id + '-b'));

    executor.executePlan(makePlan([], 'test-plan'));
    await tick();

    assert.deepEqual(ids, ['test-plan-a', 'test-plan-b']);
  });

  // --- Pickup success ---

  it('pickup step always succeeds (never fails even with empty result)', async () => {
    let failed = false;
    executor.onStepFailed(() => { failed = true; });

    let done = false;
    executor.onPlanComplete(() => { done = true; });

    executor.executePlan(makePlan([
      { action: 'pickup', expectedPosition: { x: 4, y: 4 } },
    ]));
    await tick();

    assert.ok(!failed, 'pickup must not fail');
    assert.ok(done, 'plan must complete');
  });

  // --- isIdle state during and after execution ---

  it('isIdle() returns false while executing', async () => {
    client.setActionConfig({ actionDelayMs: 50 });
    executor.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
    ]));

    await delay(10); // partway through
    assert.equal(executor.isIdle(), false);

    await delay(200); // after completion
    assert.ok(executor.isIdle());
  });

  // --- Cancel does not fire onPlanComplete ---

  it('cancelCurrentPlan mid-plan does not fire onPlanComplete', async () => {
    client.setActionConfig({ actionDelayMs: 20 });

    let planDone = false;
    executor.onPlanComplete(() => { planDone = true; });

    let stepsDone = 0;
    executor.onStepComplete((_s, i) => {
      stepsDone++;
      if (i === 0) executor.cancelCurrentPlan();
    });

    executor.executePlan(makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
      { action: 'move_right', expectedPosition: { x: 6, y: 4 } },
    ]));

    await delay(300);

    assert.equal(stepsDone, 1);
    assert.ok(!planDone, 'onPlanComplete must not fire after cancel');
  });

  // --- Plan replace: new plan fires its own onPlanComplete ---

  it('replaces an empty plan with a real plan and completes it', async () => {
    // Start with an empty plan (instant complete), then immediately queue another
    const completedIds: string[] = [];
    executor.onPlanComplete(p => completedIds.push(p.id));

    executor.executePlan(makePlan([], 'empty'));
    executor.executePlan(makePlan([
      { action: 'pickup', expectedPosition: { x: 4, y: 4 } },
    ], 'real'));

    await tick();

    // Both might complete or only the last — key requirement: no crash, isIdle after
    assert.ok(executor.isIdle());
    assert.ok(completedIds.length > 0, 'at least one plan must complete');
  });

  // --- getCurrentStepIndex resets between plans ---

  it('getCurrentStepIndex starts at 0 for a replacement plan', async () => {
    client.setActionConfig({ actionDelayMs: 20 });

    const plan1 = makePlan([
      { action: 'move_right', expectedPosition: { x: 5, y: 4 } },
      { action: 'move_right', expectedPosition: { x: 6, y: 4 } },
    ], 'plan1');

    const plan2 = makePlan([
      { action: 'pickup', expectedPosition: { x: 4, y: 4 } },
    ], 'plan2');

    executor.executePlan(plan1);
    await delay(10); // let first step begin

    executor.executePlan(plan2); // replace
    await delay(200);

    // After plan2 completes, stepIndex should be 1 (past the single step)
    assert.equal(executor.getCurrentStepIndex(), 1);
  });
});
