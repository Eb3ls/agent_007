import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmMemory, TOTAL_INPUT_BUDGET_TOKENS } from "./llm-memory.js";
import { BeliefStore } from "../beliefs/belief-store.js";
import { BeliefMapImpl } from "../beliefs/belief-map.js";
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_SELF,
} from "../testing/fixtures.js";
import type {
  BeliefSnapshot,
  RawAgentSensing,
  RawParcelSensing,
} from "../types.js";

function makeStore(): BeliefStore {
  const map = new BeliefMapImpl(
    FIXTURE_MAP_TILES,
    FIXTURE_MAP_WIDTH,
    FIXTURE_MAP_HEIGHT,
  );
  const store = new BeliefStore(map);
  store.updateSelf(FIXTURE_SELF);
  return store;
}

function makeParcels(n: number): RawParcelSensing[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p-${i}`,
    x: i % 10,
    y: Math.floor(i / 10),
    carriedBy: null,
    reward: 10 + i,
  }));
}

function makeAgents(n: number): RawAgentSensing[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a-${i}`,
    name: `agent-${i}`,
    x: i % 10,
    y: Math.floor(i / 10),
    score: i,
  }));
}

describe("LlmMemory", () => {
  it("buildContext returns all sections and non-zero token estimate", () => {
    const store = makeStore();
    store.updateParcels(makeParcels(6));
    store.updateAgents(makeAgents(3));

    const memory = new LlmMemory();
    const ctx = memory.buildContext(store);

    assert.ok(ctx.systemPrompt.length > 0);
    assert.ok(ctx.objective.length > 0);
    assert.ok(ctx.stateSnapshot.length > 0);
    assert.ok(ctx.actionHistory.length >= 0);
    assert.ok(ctx.totalTokenEstimate > 0);
  });

  it("caps state snapshot entities to configured limits", () => {
    const store = makeStore();
    store.updateParcels(makeParcels(40));
    store.updateAgents(makeAgents(20));

    const memory = new LlmMemory();
    const ctx = memory.buildContext(store);
    const state = JSON.parse(ctx.stateSnapshot) as {
      parcels: unknown[];
      agents: unknown[];
      delivery: unknown[];
    };

    assert.ok(
      state.parcels.length <= 12,
      `expected <=12 parcels, got ${state.parcels.length}`,
    );
    assert.ok(
      state.agents.length <= 8,
      `expected <=8 agents, got ${state.agents.length}`,
    );
    assert.ok(
      state.delivery.length <= 4,
      `expected <=4 delivery zones, got ${state.delivery.length}`,
    );
  });

  it("includes shared beliefs when fresh", () => {
    const store = makeStore();
    const memory = new LlmMemory();

    const snapshot: BeliefSnapshot = {
      agentId: "ally-1",
      timestamp: Date.now(),
      selfPosition: { x: 1, y: 1 },
      parcels: [
        { id: "sp-1", position: { x: 2, y: 2 }, reward: 20, carriedBy: null },
      ],
      agents: [{ id: "ally-2", position: { x: 3, y: 3 }, heading: "up" }],
    };

    memory.updateSharedBeliefs(snapshot);
    const ctx = memory.buildContext(store);

    assert.ok(
      ctx.sharedBeliefs.length > 0,
      "fresh shared beliefs should be present",
    );
    const parsed = JSON.parse(ctx.sharedBeliefs) as {
      parcels: Array<{ id: string }>;
    };
    assert.equal(parsed.parcels[0]?.id, "sp-1");
  });

  it("drops shared beliefs when stale", () => {
    const store = makeStore();
    const memory = new LlmMemory();

    const snapshot: BeliefSnapshot = {
      agentId: "ally-1",
      timestamp: Date.now(),
      selfPosition: { x: 1, y: 1 },
      parcels: [
        { id: "sp-1", position: { x: 2, y: 2 }, reward: 20, carriedBy: null },
      ],
      agents: [],
    };

    memory.updateSharedBeliefs(snapshot);

    const realNow = Date.now;
    Date.now = () => realNow() + 25_000;
    try {
      const ctx = memory.buildContext(store);
      assert.equal(ctx.sharedBeliefs, "");
    } finally {
      Date.now = realNow;
    }
  });

  it("allows overriding objective text", () => {
    const store = makeStore();
    const memory = new LlmMemory();

    memory.setObjective("Test objective: prefer delivery-first strategy.");
    const ctx = memory.buildContext(store);

    assert.ok(ctx.objective.includes("delivery-first"));
  });

  it("totalTokenEstimate stays under budget with 100 parcels and 50 agents", () => {
    const store = makeStore();
    store.updateParcels(makeParcels(100));
    store.updateAgents(makeAgents(50));

    const memory = new LlmMemory();
    const ctx = memory.buildContext(store);

    assert.ok(
      ctx.totalTokenEstimate <= TOTAL_INPUT_BUDGET_TOKENS,
      `expected totalTokenEstimate <= ${TOTAL_INPUT_BUDGET_TOKENS}, got ${ctx.totalTokenEstimate}`,
    );
  });

  it("drops sharedBeliefs and actionHistory when maxTokenBudget is tight", () => {
    const store = makeStore();
    // Very tight budget: only enough for system + objective + minimal state
    const memory = new LlmMemory(200);

    const snapshot: BeliefSnapshot = {
      agentId: "ally-1",
      timestamp: Date.now(),
      selfPosition: { x: 1, y: 1 },
      parcels: [
        { id: "sp-1", position: { x: 2, y: 2 }, reward: 20, carriedBy: null },
      ],
      agents: [],
    };
    memory.updateSharedBeliefs(snapshot);
    const ctx = memory.buildContext(store);

    assert.equal(ctx.sharedBeliefs, "", "sharedBeliefs should be dropped");
    assert.equal(ctx.actionHistory, "[]", "actionHistory should be dropped");
    // Core tiers (system + tools + objective) alone exceed 200 tokens, so
    // totalTokenEstimate can't reach 200.  Just verify optional tiers were
    // removed: estimate must be less than the default full-budget context.
    assert.ok(
      ctx.totalTokenEstimate < TOTAL_INPUT_BUDGET_TOKENS,
      `expected totalTokenEstimate < ${TOTAL_INPUT_BUDGET_TOKENS}, got ${ctx.totalTokenEstimate}`,
    );
  });
});
