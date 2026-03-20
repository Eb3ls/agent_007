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
    await sleep(700);

    // initial attempt + 3 retries = 4
    assert.equal(attempts, 4);
    assert.equal(client.moveHistory.length, 4);
    assert.ok(failed);
  });

  it("succeeds when a retry attempt eventually succeeds", async () => {
    const client = new MockGameClient();
    client.setMeasuredActionDurationMs(5);

    let attempts = 0;
    client.move = async (dir) => {
      client.moveHistory.push(dir);
      attempts++;
      return attempts >= 3;
    };

    const executor = new ActionExecutor(client);
    let completed = false;
    executor.onPlanComplete(() => {
      completed = true;
    });

    executor.executePlan(makeMovePlan());
    await sleep(700);

    assert.equal(attempts, 3);
    assert.ok(completed);
  });

  it("emits onPutdown with delivered count when putdown returns parcels", async () => {
    const client = new MockGameClient({
      putdownResult: [
        { id: "p1", x: 0, y: 0, carriedBy: null, reward: 0 },
        { id: "p2", x: 0, y: 0, carriedBy: null, reward: 0 },
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
