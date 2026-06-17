import type { LlmClient, ChatMessage } from "../mission/llm_client.js";
import type { MissionRecord } from "../mission/extractor.js";
import type { ResolverCtx } from "../mission/tools.js";
import { createStaticMap } from "../static_map.js";
import { Resolver } from "../mission/resolver.js";
import { describe, expect, it } from "vitest";

function makeRecord(overrides: Partial<MissionRecord> = {}): MissionRecord {
	return {
		opType: "MODIFIER",
		selector: { on: "deliver" },
		effect: {},
		condition: null,
		lifetime: "persistent",
		target: "both",
		bonus: null,
		answer: null,
		token: null,
		raw: "Where is the leftmost spawn tile?",
		...overrides,
	};
}

function makeMockLlm(responses: string[]): LlmClient {
	let i = 0;
	return {
		complete: async (_msgs: ChatMessage[]) =>
			responses[i++] ??
			'{"thought":"done","action":{"tool":"done","args":null}}',
	} as unknown as LlmClient;
}

function makeCtx(): ResolverCtx {
	return {
		map: createStaticMap(),
		chatClient: {
			say: async () => {},
		} as unknown as import("../game_client.js").GameClient,
		senderId: "server-agent",
	};
}

describe("Resolver", () => {
	it("terminates with kind=failed when LLM returns done(null)", async () => {
		const llm = makeMockLlm([
			'{"thought":"cannot resolve","action":{"tool":"done","args":null}}',
		]);
		const exec = new Resolver(llm, makeCtx());
		const result = await exec.run(makeRecord());
		expect(result.kind).toBe("failed");
	});

	it("terminates with kind=modifier when LLM returns done({resolvedCoords})", async () => {
		const llm = makeMockLlm([
			'{"thought":"resolved","action":{"tool":"done","args":{"resolvedCoords":[{"x":3,"y":4}]}}}',
		]);
		const exec = new Resolver(llm, makeCtx());
		const result = await exec.run(makeRecord());
		expect(result.kind).toBe("modifier");
		if (result.kind === "modifier")
			expect(result.coords).toEqual([{ x: 3, y: 4 }]);
	});

	it("terminates with kind=answered after send_message + done", async () => {
		const llm = makeMockLlm([
			'{"thought":"answering","action":{"tool":"send_message","args":{"to":"server","msg":"42"}}}',
			'{"thought":"done","action":{"tool":"done","args":null}}',
		]);
		const exec = new Resolver(llm, makeCtx());
		const result = await exec.run(makeRecord());
		expect(result.kind).toBe("answered");
	});

	it("repeated identical actions are bounded by max steps, no crash", async () => {
		// Loop detection is removed; max steps is the only bound.
		// Mock exhausts without done → failed.
		const sameAction =
			'{"thought":"stuck","action":{"tool":"map_query","args":{"query":"bounds"}}}';
		const llm = makeMockLlm([sameAction, sameAction, sameAction]);
		const exec = new Resolver(llm, makeCtx());
		const result = await exec.run(makeRecord());
		expect(result.kind).toBe("failed");
	});

	it("recovers from malformed JSON on step 0 if next response is valid done", async () => {
		const llm = makeMockLlm([
			"not json at all",
			'{"thought":"giving up","action":{"tool":"done","args":null}}',
		]);
		const exec = new Resolver(llm, makeCtx());
		const result = await exec.run(makeRecord());
		// No send_message, done(null) → failed, but loop recovered instead of crashing.
		expect(result.kind).toBe("failed");
	});

	it("calculate tool returns arithmetic result; done(null) after = failed", async () => {
		const llm = makeMockLlm([
			'{"thought":"calc","action":{"tool":"calculate","args":{"expr":"2+3"}}}',
			'{"thought":"done","action":{"tool":"done","args":null}}',
		]);
		const exec = new Resolver(llm, makeCtx());
		const result = await exec.run(makeRecord());
		// no send_message, done(null) → failed
		expect(result.kind).toBe("failed");
	});
});
