import { StubGameClient } from "./stubs/stub_game_client.js";
import { StubLlmClient } from "./stubs/stub_llm_client.js";
import type { Directive } from "../team/directives.js";
import { Extractor } from "../mission/extractor.js";
import { Assembler } from "../mission/assembler.js";
import { createStaticMap } from "../static_map.js";
import { Listener } from "../mission/listener.js";
import { AgentBus } from "../team/agent_bus.js";
import { describe, expect, it } from "vitest";

function makePauseJson(token: string | null = null, bonus: number | null = null): string {
	return JSON.stringify({
		level: "L2",
		opType: "PAUSE",
		selector: { on: "deliver" },
		effect: {},
		condition: null,
		lifetime: "one-shot",
		target: "both",
		bonus,
		answer: null,
		token,
	});
}

function makeSetup() {
	const bus = new AgentBus();
	const bdiClient = new StubGameClient("bdi");
	const llm = new StubLlmClient();
	const extractor = new Extractor(llm as never, createStaticMap());
	const listener = new Listener(bus, "God");
	listener.attachClient(bdiClient as never);
	const assembler = new Assembler(bus, bdiClient as never, listener, extractor);
	const bdiDirs: Directive[] = [];
	const llmDirs: Directive[] = [];
	bus.on("directive", (agentId: string, d: Directive) => {
		if (agentId === "bdi") bdiDirs.push(d);
		if (agentId === "llm") llmDirs.push(d);
	});
	return { bus, bdiClient, llm, assembler, bdiDirs, llmDirs };
}

describe("Assembler — PAUSE signal-token resume", () => {
	it("arms extracted token on PAUSE; signal message fires RESUME", async () => {
		const { bdiClient, llm, assembler, bdiDirs, llmDirs } = makeSetup();

		llm.queueResponses(makePauseJson("green", 700));
		bdiClient.triggerMsg("god-id", "God", "stop everything, bonus 700");
		await assembler.processPending();

		expect(bdiDirs.some((d) => d.kind === "OVERRIDE" && d.op === "PAUSE")).toBe(true);

		// "green" intercepted as signal — no LLM call needed.
		bdiClient.triggerMsg("god-id", "God", "green");

		expect(bdiDirs.some((d) => d.kind === "OVERRIDE" && d.op === "RESUME")).toBe(true);
		expect(llmDirs.some((d) => d.kind === "OVERRIDE" && d.op === "RESUME")).toBe(true);
	});

	it("works with non-EN token ('via')", async () => {
		const { bdiClient, llm, assembler, bdiDirs, llmDirs } = makeSetup();

		llm.queueResponses(makePauseJson("via"));
		bdiClient.triggerMsg("god-id", "God", "fermatevi, ripartite al mio via");
		await assembler.processPending();

		bdiClient.triggerMsg("god-id", "God", "via");

		expect(bdiDirs.some((d) => d.kind === "OVERRIDE" && d.op === "RESUME")).toBe(true);
		expect(llmDirs.some((d) => d.kind === "OVERRIDE" && d.op === "RESUME")).toBe(true);
	});

	it("no token → signal message reaches extractor (not consumed as signal)", async () => {
		const { bdiClient, llm, assembler } = makeSetup();

		llm.queueResponses(makePauseJson(null));
		bdiClient.triggerMsg("god-id", "God", "pause");
		await assembler.processPending();

		// Queue a RESUME response for the extractor to handle the next message.
		llm.queueResponses(
			JSON.stringify({
				level: "L2",
				opType: "RESUME",
				selector: { on: "deliver" },
				effect: {},
				condition: null,
				lifetime: "one-shot",
				target: "both",
				bonus: null,
				answer: null,
				token: null,
			}),
		);

		// "resume" must reach the queue (no armed token), extractor classifies it.
		bdiClient.triggerMsg("god-id", "God", "resume");
		// No throw = extractor was called and consumed the queued response.
		await expect(assembler.processPending()).resolves.toBeUndefined();
	});
});
