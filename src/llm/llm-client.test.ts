import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LlmClient } from "./llm-client.js";
import type { LlmConfig } from "../types.js";

interface MockFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const baseCfg: LlmConfig = {
  apiUrl: "https://example.test/v1/chat/completions",
  apiToken: "token-123",
  model: "test-model",
  maxTokenBudget: 1024,
  minCallIntervalMs: 0,
};

describe("LlmClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // reset between tests
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends expected payload and returns response content", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (
      url: string | URL | globalThis.Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(url);
      capturedInit = init;
      const res: MockFetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            { message: { content: '{"steps":[{"action":"pickup"}]}' } },
          ],
          usage: { total_tokens: 42 },
        }),
      };
      return res as unknown as Response;
    }) as typeof fetch;

    const client = new LlmClient(baseCfg);
    const messages = [
      { role: "system" as const, content: "be helpful" },
      { role: "user" as const, content: "hello planner" },
    ];
    const content = await client.complete(messages, 256);

    assert.equal(capturedUrl, baseCfg.apiUrl);
    assert.equal(capturedInit?.method, "POST");
    assert.ok(capturedInit?.headers);

    const headers = capturedInit!.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers.Authorization, `Bearer ${baseCfg.apiToken}`);

    const body = JSON.parse(String(capturedInit!.body));
    assert.equal(body.model, baseCfg.model);
    assert.equal(body.max_tokens, 256);
    assert.deepEqual(body.messages, messages);

    assert.equal(content, '{"steps":[{"action":"pickup"}]}');
  });

  it("returns null on non-2xx status", async () => {
    globalThis.fetch = (async () => {
      const res: MockFetchResponse = {
        ok: false,
        status: 503,
        json: async () => ({}),
      };
      return res as unknown as Response;
    }) as typeof fetch;

    const client = new LlmClient(baseCfg);
    const content = await client.complete([{ role: "user", content: "x" }], 64);
    assert.equal(content, null);
  });

  it("returns null when response has no message content", async () => {
    globalThis.fetch = (async () => {
      const res: MockFetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: null } }] }),
      };
      return res as unknown as Response;
    }) as typeof fetch;

    const client = new LlmClient(baseCfg);
    const content = await client.complete([{ role: "user", content: "x" }], 64);
    assert.equal(content, null);
  });

  it("returns null on fetch exception", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const client = new LlmClient(baseCfg);
    const content = await client.complete([{ role: "user", content: "x" }], 64);
    assert.equal(content, null);
  });

  it("enforces minCallIntervalMs between calls", async () => {
    const callTimes: number[] = [];

    globalThis.fetch = (async () => {
      callTimes.push(Date.now());
      const res: MockFetchResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            { message: { content: '{"steps":[{"action":"pickup"}]}' } },
          ],
          usage: { total_tokens: 1 },
        }),
      };
      return res as unknown as Response;
    }) as typeof fetch;

    const client = new LlmClient({ ...baseCfg, minCallIntervalMs: 60 });
    await client.complete([{ role: "user", content: "a" }], 16);
    await client.complete([{ role: "user", content: "b" }], 16);

    assert.equal(callTimes.length, 2);
    const delta = callTimes[1]! - callTimes[0]!;
    assert.ok(
      delta >= 50,
      `expected second call delayed by ~60ms, got ${delta}ms`,
    );
  });
});
