import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor } from "./action-executor.js";
import { MockGameClient } from "../testing/mock-game-client.js";
import type { Plan } from "../types.js";

function makeMovePlan(): Plan {
  return {
    id: "retry-plan",
    intentionId: "intent-retry",
    steps: [{ action: "move_right", expectedPosition: { x: 1, y: 0 } }],
    estimatedReward: 0,
    createdAt: Date.now(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ActionExecutor — retry behavior", () => {
  it("retries failed move up to max retries then fails", async () => {
    const client = new MockGameClient();
    client.setMeasuredActionDurationMs(5);

    let attempts = 0;
    client.move = async (dir) => {
      client.moveHistory.push(dir);
      attempts++;
      return false;
    };

    const executor = new ActionExecutor(client);
    let failed = false;
    executor.onStepFailed(() => {
      failed = true;
    });

    executor.executePlan(makeMovePlan());
    await sleep(300);

    // initial attempt + 1 retry = 2
    assert.equal(attempts, 2);
    assert.equal(client.moveHistory.length, 2);
    assert.ok(failed);
  });

  it("succeeds when a retry attempt eventually succeeds", async () => {
    const client = new MockGameClient();
    client.setMeasuredActionDurationMs(5);

    let attempts = 0;
    client.move = async (dir) => {
      client.moveHistory.push(dir);
      attempts++;
      return attempts >= 2;
    };

    const executor = new ActionExecutor(client);
    let completed = false;
    executor.onPlanComplete(() => {
      completed = true;
    });

    executor.executePlan(makeMovePlan());
    await sleep(300);

    // succeeds on 2nd attempt (attempts >= 2 is truthy)
    assert.equal(attempts, 2);
    assert.ok(completed);
  });

  it("emits onPutdown with delivered count when putdown returns parcels", async () => {
    const client = new MockGameClient({
      putdownResult: [
        { id: "p1" },
        { id: "p2" },
      ],
    });

    const plan: Plan = {
      id: "putdown-plan",
      intentionId: "intent",
      steps: [{ action: "putdown", expectedPosition: { x: 0, y: 0 } }],
      estimatedReward: 0,
      createdAt: Date.now(),
    };

    const executor = new ActionExecutor(client);
    const deliveredCounts: number[] = [];
    executor.onPutdown((n) => deliveredCounts.push(n));

    executor.executePlan(plan);
    await sleep(120);

    assert.deepEqual(deliveredCounts, [2]);
  });
});
