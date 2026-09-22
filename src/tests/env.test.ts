import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));

describe("environment configuration", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv("DELIVEROO_HOST", "http://localhost:8080");
		vi.stubEnv("DELIVEROO_TOKEN", "test-bdi-token");
		vi.stubEnv("DELIVEROO_TOKEN_LLM", "");
		vi.stubEnv("SERVER_AGENT_NAME", "");
		vi.stubEnv("LLM_TIMEOUT_MS", undefined);
		vi.stubEnv("LLM_API_URL", "https://example.invalid/chat/completions");
		vi.stubEnv("LLM_API_TOKEN", "test-api-token");
		vi.stubEnv("LLM_MODEL", "test-model");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("loads single-agent mode with the blank timeout from .env.example", async () => {
		vi.stubEnv("LLM_TIMEOUT_MS", "");
		const { env } = await import("../env.js");
		expect(env.llm).toBeNull();
	});

	it.each([undefined, "", "   "])(
		"omits an unset or blank timeout in dual-agent mode (%j)",
		async (timeout) => {
			vi.stubEnv("DELIVEROO_TOKEN_LLM", "test-llm-token");
			vi.stubEnv("LLM_TIMEOUT_MS", timeout);
			const { env } = await import("../env.js");
			expect(env.llm).not.toHaveProperty("timeoutMs");
		},
	);

	it("preserves an explicit timeout", async () => {
		vi.stubEnv("DELIVEROO_TOKEN_LLM", "test-llm-token");
		vi.stubEnv("LLM_TIMEOUT_MS", "30000");
		const { env } = await import("../env.js");
		expect(env.llm?.timeoutMs).toBe(30000);
	});

	it.each(["0", "-1", "invalid", "Infinity"])(
		"rejects an invalid timeout (%s)",
		async (timeout) => {
			vi.stubEnv("LLM_TIMEOUT_MS", timeout);
			await expect(import("../env.js")).rejects.toThrow(
				"LLM_TIMEOUT_MS must be a positive integer",
			);
		},
	);
});
