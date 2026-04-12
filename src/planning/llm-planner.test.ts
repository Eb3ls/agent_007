import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmPlanner } from "./llm-planner.js";
import { BeliefStore } from "../beliefs/belief-store.js";
import { BeliefMapImpl } from "../beliefs/belief-map.js";
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_SELF,
} from "../testing/fixtures.js";
import type {
  IBeliefStore,
  LlmMemoryContext,
  PlanningRequest,
  Position,
} from "../types.js";

function makeBeliefs(): IBeliefStore {
  const map = new BeliefMapImpl(
    FIXTURE_MAP_TILES,
    FIXTURE_MAP_WIDTH,
    FIXTURE_MAP_HEIGHT,
  );
  const store = new BeliefStore(map);
  store.updateSelf(FIXTURE_SELF);
  return store;
}

function makeRequest(start: Position = { x: 4, y: 4 }): PlanningRequest {
  const map = new BeliefMapImpl(
    FIXTURE_MAP_TILES,
    FIXTURE_MAP_WIDTH,
    FIXTURE_MAP_HEIGHT,
  );
  const parcel = {
    id: "p1",
    position: { x: 4, y: 4 },
    carriedBy: null,
    reward: 10,
    estimatedReward: 10,
    lastSeen: Date.now(),
    confidence: 1,
    decayRatePerMs: 0,
  };

  return {
    currentPosition: start,
    carriedParcels: [],
    targetParcels: [parcel],
    deliveryZones: [{ x: 0, y: 0 }],
    beliefMap: map,
  };
}

function makeMemoryStub(): {
  buildContext: (beliefs: IBeliefStore) => LlmMemoryContext;
} {
  return {
    buildContext: (_beliefs: IBeliefStore) => ({
      systemPrompt: "system",
      objective: "obj",
      stateSnapshot: '{"pos":{"x":4,"y":4}}',
      actionHistory: "[]",
      sharedBeliefs: "",
      toolCatalog: "[]",
      totalTokenEstimate: 42,
    }),
  };
}

describe("LlmPlanner", () => {
  it("returns success with parsed JSON plan from LLM response", async () => {
    const clientStub = {
      complete: async (_messages: unknown[], _maxTokens: number) =>
        '{"steps":[{"action":"move","direction":"up"},{"action":"pickup"}]}',
    };

    const planner = new LlmPlanner(
      clientStub as never,
      makeMemoryStub() as never,
      makeBeliefs(),
    );

    const result = await planner.plan(makeRequest());

    assert.equal(result.success, true);
    assert.ok(result.plan);
    assert.equal(result.metadata.plannerName, "llm");
    assert.equal(result.plan!.steps.length, 2);
    assert.equal(result.plan!.steps[0]!.action, "move_up");
    assert.equal(result.plan!.steps[1]!.action, "pickup");
  });

  it("returns failure when LLM is unavailable (null response)", async () => {
    const clientStub = {
      complete: async (_messages: unknown[], _maxTokens: number) => null,
    };

    const planner = new LlmPlanner(
      clientStub as never,
      makeMemoryStub() as never,
      makeBeliefs(),
    );

    const result = await planner.plan(makeRequest());
    assert.equal(result.success, false);
    assert.equal(result.plan, null);
    assert.ok(result.error?.includes("unavailable"));
  });

  it("returns failure when response cannot be parsed", async () => {
    const clientStub = {
      complete: async (_messages: unknown[], _maxTokens: number) =>
        "nonsense output",
    };

    const planner = new LlmPlanner(
      clientStub as never,
      makeMemoryStub() as never,
      makeBeliefs(),
    );

    const result = await planner.plan(makeRequest());
    assert.equal(result.success, false);
    assert.equal(result.plan, null);
    assert.ok(result.error?.includes("parse"));
  });

  it("returns aborted if abort() called before planning", async () => {
    const clientStub = {
      complete: async (_messages: unknown[], _maxTokens: number) =>
        '{"steps":[{"action":"pickup"}]}',
    };

    const planner = new LlmPlanner(
      clientStub as never,
      makeMemoryStub() as never,
      makeBeliefs(),
    );

    planner.abort();
    const result = await planner.plan(makeRequest());

    assert.equal(result.success, false);
    assert.equal(result.error, "aborted");
  });

  it("returns aborted if abort() happens during in-flight LLM call", async () => {
    let resolveCall: ((value: string) => void) | null = null;

    const clientStub = {
      complete: (_messages: unknown[], _maxTokens: number) =>
        new Promise<string>((resolve) => {
          resolveCall = resolve;
        }),
    };

    const planner = new LlmPlanner(
      clientStub as never,
      makeMemoryStub() as never,
      makeBeliefs(),
    );

    const planPromise = planner.plan(makeRequest());
    planner.abort();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    resolveCall!('{"steps":[{"action":"pickup"}]}');

    const result = await planPromise;
    assert.equal(result.success, false);
    assert.equal(result.error, "aborted");
  });
});
