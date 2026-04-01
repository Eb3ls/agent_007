// ============================================================
// src/execution/action-executor.ts — Sequential plan execution (T10)
// Executes PlanSteps one at a time via GameClient, prevents
// action overlap, supports cancellation mid-plan.
// ============================================================

import type {
  GameClient,
  IActionExecutor,
  InFlightAction,
  Plan,
  PlanStep,
  ReplanSignal,
} from '../types.js';
import { actionToDirection } from './action-types.js';

/** Safety margin added to measured action duration for timeout detection. */
const SAFETY_MARGIN_MS = 100;

/**
 * Number of consecutive move failures before emitting onReplanRequired.
 * After MAX_MOVE_RETRIES failed attempts, further retrying only accumulates
 * penalties (R07, R22). Signal replan instead.
 */
const MAX_MOVE_RETRIES = 3; // 3 retries → 4 total attempts before step failure

export class ActionExecutor implements IActionExecutor {
  private client: GameClient;
  private currentPlan: Plan | null = null;
  private stepIndex = 0;
  private inFlight: InFlightAction | null = null;
  private cancelled = false;
  private executing = false;

  // Callbacks
  private stepCompleteCbs: Array<(step: PlanStep, index: number) => void> = [];
  private planCompleteCbs: Array<(plan: Plan) => void> = [];
  private stepFailedCbs: Array<(step: PlanStep, index: number, reason: string) => void> = [];
  private replanRequiredCbs: Array<(signal: ReplanSignal) => void> = [];
  private putdownCbs: Array<(count: number) => void> = [];

  /** Set by executeStep when a replan signal has been emitted; cleared in runLoop. */
  private replanEmitted = false;

  constructor(client: GameClient) {
    this.client = client;
  }

  executePlan(plan: Plan): void {
    // If currently executing, cancel remaining steps of the old plan.
    // The new plan will start after any in-flight action resolves.
    this.cancelled = true;
    this.currentPlan = plan;
    this.stepIndex = 0;
    this.cancelled = false;
    this.replanEmitted = false;

    if (!this.executing) {
      this.runLoop();
    }
    // If executing, the current in-flight action will complete,
    // then the loop will pick up the new plan.
  }

  cancelCurrentPlan(): void {
    this.cancelled = true;
  }

  isIdle(): boolean {
    return this.inFlight === null && !this.executing;
  }

  getInFlightAction(): InFlightAction | null {
    return this.inFlight;
  }

  getCurrentStepIndex(): number {
    return this.stepIndex;
  }

  onStepComplete(cb: (step: PlanStep, index: number) => void): void {
    this.stepCompleteCbs.push(cb);
  }

  onPlanComplete(cb: (plan: Plan) => void): void {
    this.planCompleteCbs.push(cb);
  }

  onStepFailed(cb: (step: PlanStep, index: number, reason: string) => void): void {
    this.stepFailedCbs.push(cb);
  }

  /**
   * R07 / Pattern-3: fires when move fails consecutively (collision likely).
   * Distinct from onStepFailed — caller must replan immediately rather than retry.
   */
  onReplanRequired(cb: (signal: ReplanSignal) => void): void {
    this.replanRequiredCbs.push(cb);
  }

  onPutdown(cb: (count: number) => void): void {
    this.putdownCbs.push(cb);
  }

  // --- Internal execution loop ---

  private async runLoop(): Promise<void> {
    this.executing = true;

    while (this.currentPlan && this.stepIndex < this.currentPlan.steps.length) {
      if (this.cancelled) {
        break;
      }

      const plan = this.currentPlan;
      const step = plan.steps[this.stepIndex]!;
      const index = this.stepIndex;

      this.replanEmitted = false;
      const success = await this.executeStep(step);

      // Check if plan was replaced during execution
      if (this.currentPlan !== plan) {
        // Plan was replaced — start over with the new plan
        continue;
      }

      if (this.cancelled) {
        break;
      }

      if (success) {
        for (const cb of this.stepCompleteCbs) cb(step, index);
        this.stepIndex++;
      } else if (this.replanEmitted) {
        // onReplanRequired already fired inside executeStep — just clear and break.
        // Do NOT also fire onStepFailed: the caller handles replan, not step retry.
        this.currentPlan = null;
        break;
      } else {
        // Transient failure (non-move actions, unexpected errors)
        this.currentPlan = null;
        for (const cb of this.stepFailedCbs) cb(step, index, 'action failed');
        break;
      }
    }

    // Plan completed
    if (
      this.currentPlan &&
      !this.cancelled &&
      this.stepIndex >= this.currentPlan.steps.length
    ) {
      const plan = this.currentPlan;
      this.currentPlan = null;
      for (const cb of this.planCompleteCbs) cb(plan);
    }

    this.executing = false;

    // If a new plan was set during the final callback, start executing it
    if (this.currentPlan && !this.cancelled && this.stepIndex < this.currentPlan.steps.length) {
      this.runLoop();
    }
  }

  private async executeStep(step: PlanStep, attempt = 0): Promise<boolean> {
    const direction = actionToDirection(step.action);
    const expectedDurationMs = this.client.getMeasuredActionDurationMs();

    this.inFlight = {
      action: step.action,
      sentAt: Date.now(),
      expectedDurationMs,
    };

    try {
      if (direction !== null) {
        // Move action
        const result = await this.withTimeout(
          this.client.move(direction),
          expectedDurationMs + SAFETY_MARGIN_MS,
        );

        if (!result) {
          if (attempt < MAX_MOVE_RETRIES && !this.cancelled && this.currentPlan !== null) {
            // One retry: wait briefly for dynamic obstacle to clear (R07 transient case)
            await new Promise(r => setTimeout(r, 100));
            if (this.cancelled || this.currentPlan === null) return false;
            return this.executeStep(step, attempt + 1);
          }
          // Exhausted retries — let runLoop emit onStepFailed for replanning
          return false;
        }
        return true;

      } else if (step.action === 'pickup') {
        await this.client.pickup();
        return true;

      } else if (step.action === 'putdown') {
        const putResult = await this.client.putdown();
        if (putResult.length > 0) {
          for (const cb of this.putdownCbs) cb(putResult.length);
        }
        return true;
      }

      return false;
    } catch {
      return false;
    } finally {
      this.inFlight = null;
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('action timed out'));
      }, timeoutMs);
      timer.unref();

      promise.then(
        value => { clearTimeout(timer); resolve(value); },
        err   => { clearTimeout(timer); reject(err); },
      );
    });
  }
}
