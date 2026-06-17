import type { Resolver, ResolveResult } from "../mission/resolver.js";
import { StubGameClient } from "./stubs/stub_game_client.js";
import type { MissionRecord } from "../mission/extractor.js";
import type { L3Executor } from "../mission/l3_executor.js";
import { StubLlmClient } from "./stubs/stub_llm_client.js";
import { createStaticMap, setMap } from "../static_map.js";
import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";
import type { Directive } from "../team/directives.js";
import { Extractor } from "../mission/extractor.js";
import { Assembler } from "../mission/assembler.js";
import { Listener } from "../mission/listener.js";
import { AgentBus } from "../team/agent_bus.js";
import { describe, expect, it } from "vitest";

// 3×3 grid (center at (1,1)): delivery tiles at the four corners + one near-center
// delivery at (1,2) + a walkable spawn at (1,1).
function makeTestMap() {
	const m = createStaticMap();
	const tiles: IOTile[] = [
		{ x: 0, y: 0, type: "2" as IOTile["type"] }, // delivery (top-left)
		{ x: 2, y: 0, type: "2" as IOTile["type"] },
		{ x: 0, y: 2, type: "2" as IOTile["type"] },
		{ x: 2, y: 2, type: "2" as IOTile["type"] },
		{ x: 1, y: 2, type: "2" as IOTile["type"] }, // delivery nearest center
		{ x: 1, y: 1, type: "1" as IOTile["type"] }, // spawn / center
	];
	setMap(m, tiles);
	return m;
}

function makePauseJson(
	token: string | null = null,
	bonus: number | null = null,
): string {
	return JSON.stringify({
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

function makeSetup(
	opts: { resolver?: Resolver; l3Executor?: L3Executor } = {},
) {
	const bus = new AgentBus();
	const bdiClient = new StubGameClient("bdi");
	const llm = new StubLlmClient();
	const extractor = new Extractor(llm as never);
	const listener = new Listener(bus, "God");
	listener.attachClient(bdiClient as never);
	const assembler = new Assembler(
		bus,
		bdiClient as never,
		listener,
		extractor,
		makeTestMap(),
		opts.resolver,
		opts.l3Executor,
	);
	const bdiDirs: Directive[] = [];
	const llmDirs: Directive[] = [];
	bus.on("directive", (agentId: string, d: Directive) => {
		if (agentId === "bdi") bdiDirs.push(d);
		if (agentId === "llm") llmDirs.push(d);
	});
	return { bus, bdiClient, llm, assembler, bdiDirs, llmDirs };
}

describe("Assembler — STAGE directive", () => {
	it("STAGE with predicate emits STAGE+PAUSE with predicate target", async () => {
		const { bdiClient, llm, assembler, bdiDirs } = makeSetup();

		llm.queueResponses(
			JSON.stringify({
				opType: "STAGE",
				selector: { on: "deliver" },
				effect: {},
				condition: null,
				lifetime: "one-shot",
				target: "both",
				coords: null,
				bonus: null,
				answer: null,
				token: null,
				predicate: ["odd-row"],
			}),
		);
		bdiClient.triggerMsg(
			"god-id",
			"God",
			"mettetevi su una tile con y dispari",
		);
		await assembler.processPending();

		const stage = bdiDirs.find(
			(d) => d.kind === "OVERRIDE" && d.op === "STAGE",
		) as Extract<Directive, { op: "STAGE" }> | undefined;
		expect(stage).toBeDefined();
		expect(stage!.target).toEqual(["odd-row"]);

		const pause = bdiDirs.find(
			(d) => d.kind === "OVERRIDE" && d.op === "PAUSE",
		);
		expect(pause).toBeDefined();
	});

	it("STAGE with no coords and no predicate logs warning and only emits PAUSE", async () => {
		const { bdiClient, llm, assembler, bdiDirs } = makeSetup();

		llm.queueResponses(
			JSON.stringify({
				opType: "STAGE",
				selector: { on: "deliver" },
				effect: {},
				condition: null,
				lifetime: "one-shot",
				target: "both",
				coords: null,
				bonus: null,
				answer: null,
				token: null,
				predicate: null,
			}),
		);
		bdiClient.triggerMsg("god-id", "God", "wait here");
		await assembler.processPending();

		const stage = bdiDirs.find(
			(d) => d.kind === "OVERRIDE" && d.op === "STAGE",
		);
		expect(stage).toBeUndefined();

		const pause = bdiDirs.find(
			(d) => d.kind === "OVERRIDE" && d.op === "PAUSE",
		);
		expect(pause).toBeDefined();
	});
});

describe("Assembler — buildModifier effect normalisation", () => {
	function modifierJson(
		effect: Record<string, number>,
		bonus: number | null,
	): string {
		return JSON.stringify({
			opType: "MODIFIER",
			selector: { on: "deliver" },
			effect,
			condition: { carryCountEquals: 1 },
			lifetime: "persistent",
			target: "both",
			bonus,
			answer: null,
			token: null,
		});
	}

	function emittedModifier(dirs: Directive[]) {
		return dirs.find((d) => d.kind === "MODIFIER") as
			| Extract<Directive, { kind: "MODIFIER" }>
			| undefined;
	}

	it("mult=0 with a coexisting bonus → keeps mult:0, does NOT overwrite with add", async () => {
		// Latent bug: `!effect.mult` treats 0 as absent, so a bonus would clobber the
		// zero multiplier with an add. The undefined-check guard must preserve mult:0.
		const { bdiClient, llm, assembler, bdiDirs } = makeSetup();

		llm.queueResponses(modifierJson({ mult: 0 }, 50));
		bdiClient.triggerMsg(
			"god-id",
			"God",
			"deliver stacks of exactly 1 to get 0 of the standard reward",
		);
		await assembler.processPending();

		const mod = emittedModifier(bdiDirs);
		expect(mod).toBeDefined();
		expect(mod!.effect.mult).toBe(0);
		expect(mod!.effect.add).toBeUndefined();
	});

	it("empty effect with a bonus → add defaults to bonus (preserved behaviour)", async () => {
		const { bdiClient, llm, assembler, bdiDirs } = makeSetup();

		llm.queueResponses(modifierJson({}, 50));
		bdiClient.triggerMsg("god-id", "God", "bonus 50 for delivering one");
		await assembler.processPending();

		const mod = emittedModifier(bdiDirs);
		expect(mod).toBeDefined();
		expect(mod!.effect.add).toBe(50);
	});
});

describe("Assembler — PAUSE signal-token resume", () => {
	it("arms extracted token on PAUSE; signal message fires RESUME", async () => {
		const { bdiClient, llm, assembler, bdiDirs, llmDirs } = makeSetup();

		llm.queueResponses(makePauseJson("green", 700));
		bdiClient.triggerMsg("god-id", "God", "stop everything, bonus 700");
		await assembler.processPending();

		expect(
			bdiDirs.some((d) => d.kind === "OVERRIDE" && d.op === "PAUSE"),
		).toBe(true);

		// "green" intercepted as signal — no LLM call needed.
		bdiClient.triggerMsg("god-id", "God", "green");

		expect(
			bdiDirs.some((d) => d.kind === "OVERRIDE" && d.op === "RESUME"),
		).toBe(true);
		expect(
			llmDirs.some((d) => d.kind === "OVERRIDE" && d.op === "RESUME"),
		).toBe(true);
	});

	it("works with non-EN token ('via')", async () => {
		const { bdiClient, llm, assembler, bdiDirs, llmDirs } = makeSetup();

		llm.queueResponses(makePauseJson("via"));
		bdiClient.triggerMsg(
			"god-id",
			"God",
			"fermatevi, ripartite al mio via",
		);
		await assembler.processPending();

		bdiClient.triggerMsg("god-id", "God", "via");

		expect(
			bdiDirs.some((d) => d.kind === "OVERRIDE" && d.op === "RESUME"),
		).toBe(true);
		expect(
			llmDirs.some((d) => d.kind === "OVERRIDE" && d.op === "RESUME"),
		).toBe(true);
	});

	it("no token → signal message reaches extractor (not consumed as signal)", async () => {
		const { bdiClient, llm, assembler } = makeSetup();

		llm.queueResponses(makePauseJson(null));
		bdiClient.triggerMsg("god-id", "God", "pause");
		await assembler.processPending();

		// Queue a RESUME response for the extractor to handle the next message.
		llm.queueResponses(
			JSON.stringify({
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

describe("Assembler — deterministic-first resolution", () => {
	function deliverMultJson(
		predicate: string[] | null,
		needsResolve = false,
	): string {
		return JSON.stringify({
			opType: "MODIFIER",
			selector: { on: "deliver", tiles: null },
			effect: { mult: 5 },
			condition: null,
			lifetime: "persistent",
			target: "both",
			coords: null,
			bonus: null,
			answer: null,
			token: null,
			predicate,
			needsResolve,
		});
	}

	function trackingResolver(result: ResolveResult) {
		const calls: MissionRecord[] = [];
		const resolver = {
			run: async (record: MissionRecord) => {
				calls.push(record);
				return result;
			},
		} as unknown as Resolver;
		return { resolver, calls };
	}

	function emittedModifier(dirs: Directive[]) {
		return dirs.find((d) => d.kind === "MODIFIER") as
			| Extract<Directive, { kind: "MODIFIER" }>
			| undefined;
	}

	it("predicate resolves synchronously to the top-left delivery, resolver not called", async () => {
		const { resolver, calls } = trackingResolver({ kind: "failed" });
		const { bdiClient, llm, assembler, bdiDirs } = makeSetup({ resolver });

		llm.queueResponses(
			deliverMultJson(["delivery", "topmost", "leftmost"]),
		);
		bdiClient.triggerMsg("god-id", "God", "top-left pays 5x");
		await assembler.processPending();

		const mod = emittedModifier(bdiDirs);
		expect(mod).toBeDefined();
		expect(mod!.selector.on).toBe("deliver");
		expect(
			(
				mod!.selector as Extract<
					Directive,
					{ kind: "MODIFIER" }
				>["selector"] & {
					on: "deliver";
				}
			).tiles,
		).toEqual([{ x: 0, y: 0 }]);
		expect(mod!.effect.mult).toBe(5);
		expect(calls).toHaveLength(0); // deterministic path, no LLM resolver
	});

	it("falls back to the resolver loop when predicate resolves empty", async () => {
		const { resolver, calls } = trackingResolver({
			kind: "modifier",
			coords: [{ x: 2, y: 2 }],
		});
		const { bdiClient, llm, assembler, bdiDirs } = makeSetup({ resolver });

		// ["delivery","spawn"] matches no tile (no tile is both) → empty → fallback.
		llm.queueResponses(deliverMultJson(["delivery", "spawn"]));
		bdiClient.triggerMsg("god-id", "God", "ambiguous place pays 5x");
		await assembler.processPending();

		expect(calls).toHaveLength(1);
		const mod = emittedModifier(bdiDirs);
		expect(mod).toBeDefined();
		expect(
			(
				mod!.selector as Extract<
					Directive,
					{ kind: "MODIFIER" }
				>["selector"] & {
					on: "deliver";
				}
			).tiles,
		).toEqual([{ x: 2, y: 2 }]);
	});

	it("needsResolve routes to the resolver loop, ignoring any predicate", async () => {
		const { resolver, calls } = trackingResolver({
			kind: "modifier",
			coords: [{ x: 2, y: 0 }],
		});
		const { bdiClient, llm, assembler, bdiDirs } = makeSetup({ resolver });

		llm.queueResponses(
			deliverMultJson(["delivery", "topmost", "leftmost"], true),
		);
		bdiClient.triggerMsg(
			"god-id",
			"God",
			"deliver near the fountain pays 5x",
		);
		await assembler.processPending();

		expect(calls).toHaveLength(1);
		const mod = emittedModifier(bdiDirs);
		expect(
			(
				mod!.selector as Extract<
					Directive,
					{ kind: "MODIFIER" }
				>["selector"] & {
					on: "deliver";
				}
			).tiles,
		).toEqual([{ x: 2, y: 0 }]);
	});

	it("rendezvous with predicate dispatches to L3 with the resolved center coord", async () => {
		const dispatched: MissionRecord[] = [];
		const l3Executor = {
			dispatch: (record: MissionRecord) => {
				dispatched.push(record);
				return true;
			},
		} as unknown as L3Executor;
		const { bdiClient, llm, assembler } = makeSetup({ l3Executor });

		llm.queueResponses(
			JSON.stringify({
				opType: "rendezvous",
				selector: { on: "goto", coords: null },
				effect: { add: 5000 },
				condition: null,
				lifetime: "one-shot",
				target: "both",
				coords: null,
				bonus: 5000,
				answer: null,
				token: null,
				predicate: ["delivery", "center"],
				maxDist: null,
			}),
		);
		bdiClient.triggerMsg(
			"god-id",
			"God",
			"meet at the central delivery zone",
		);
		await assembler.processPending();

		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]!.selector.coords?.[0]).toEqual({ x: 1, y: 2 });
	});
});
