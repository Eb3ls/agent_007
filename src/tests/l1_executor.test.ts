import type { LlmClient, ChatMessage } from "../mission/llm_client.js";
import type { MissionRecord } from "../mission/extractor.js";
import { L1Executor } from "../mission/l1_executor.js";
import { createStaticMap } from "../static_map.js";
import type { L1Ctx } from "../mission/tools.js";
import { describe, expect, it } from "vitest";

function makeRecord(overrides: Partial<MissionRecord> = {}): MissionRecord {
	return {
		level: "L1",
		opType: "MODIFIER",
		selector: { on: "deliver" },
		effect: {},
		condition: null,
		lifetime: "persistent",
		target: "both",
		bonus: null,
		answer: null,
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

function makeCtx(): L1Ctx {
	return {
		map: createStaticMap(),
		bdiClient: {
			say: async () => {},
		} as unknown as import("../game_client.js").GameClient,
		senderId: "server-agent",
	};
}

describe("L1Executor", () => {
	it("terminates with kind=failed when LLM returns done(null)", async () => {
		const llm = makeMockLlm([
			'{"thought":"cannot resolve","action":{"tool":"done","args":null}}',
		]);
		const exec = new L1Executor(llm, makeCtx());
		const result = await exec.run(makeRecord());
		expect(result.kind).toBe("failed");
	});

	it("terminates with kind=modifier when LLM returns done({resolvedCoords})", async () => {
		const llm = makeMockLlm([
			'{"thought":"resolved","action":{"tool":"done","args":{"resolvedCoords":[{"x":3,"y":4}]}}}',
		]);
		const exec = new L1Executor(llm, makeCtx());
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
		const exec = new L1Executor(llm, makeCtx());
		const result = await exec.run(makeRecord());
		expect(result.kind).toBe("answered");
	});

	it("detects loop (same action twice) and exits with failed", async () => {
		const sameAction =
			'{"thought":"stuck","action":{"tool":"map_query","args":{"query":"bounds"}}}';
		const llm = makeMockLlm([sameAction, sameAction, sameAction]);
		const exec = new L1Executor(llm, makeCtx());
		const result = await exec.run(makeRecord());
		expect(result.kind).toBe("failed");
	});

	it("calculate tool returns arithmetic result; done(null) after = failed", async () => {
		const llm = makeMockLlm([
			'{"thought":"calc","action":{"tool":"calculate","args":{"expr":"2+3"}}}',
			'{"thought":"done","action":{"tool":"done","args":null}}',
		]);
		const exec = new L1Executor(llm, makeCtx());
		const result = await exec.run(makeRecord());
		// no send_message, done(null) → failed
		expect(result.kind).toBe("failed");
	});
});
