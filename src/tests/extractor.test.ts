/**
 * Integration tests for the Extractor + LLM pipeline.
 * Requires LLM_API_URL, LLM_API_TOKEN, LLM_MODEL to be set in .env.
 * Skipped automatically when RUN_LLM_TESTS is unset (CI, npm run check, git push).
 *
 * Run with: npm run test:extract   (reads .env — set a non-thinking model)
 */
import { createLlmClient } from "../mission/llm_client.js";
import { Extractor } from "../mission/extractor.js";
import { createStaticMap } from "../static_map.js";
import { describe, expect, it, vi } from "vitest";
import "dotenv/config";

// Non-thinking model finishes in seconds; 30s is ample.
vi.setConfig({ testTimeout: 30_000 });

const hasLlm =
	process.env.RUN_LLM_TESTS === "1" &&
	!!process.env.LLM_API_URL &&
	!!process.env.LLM_MODEL;
const maybeDescribe = hasLlm ? describe : describe.skip;

function makeExtractor(): Extractor {
	return new Extractor(
		createLlmClient({
			apiUrl: process.env.LLM_API_URL!,
			apiToken: process.env.LLM_API_TOKEN ?? "",
			model: process.env.LLM_MODEL!,
		}),
		createStaticMap(),
	);
}

maybeDescribe("Extractor — live LLM", () => {
	// A1-baseline: clean tail with JSON coords
	it("simple goto with JSON tail", async () => {
		const r = await makeExtractor().extract(
			'Move to (4,7) to receive a bonus. Bonus is 10pts. Coordinates are [{"x":4,"y":7}]',
		);
		expect(r).not.toBeNull();
		expect(r!.opType).toBe("MODIFIER");
		expect(r!.selector.on).toBe("goto");
		expect(r!.bonus).toBe(10);
		expect(r!.selector.coords).toEqual([{ x: 4, y: 7 }]);
	});

	// A1-negative: bonus is a penalty (trap)
	it("goto with negative bonus", async () => {
		const r = await makeExtractor().extract(
			'Move to (9,9). Bonus is -10pts. Coordinates are [{"x":9,"y":9}]',
		);
		expect(r).not.toBeNull();
		expect(r!.opType).toBe("MODIFIER");
		expect(r!.selector.on).toBe("goto");
		expect(r!.bonus).toBe(-10);
	});

	// A3: arithmetic coords, worded bonus
	it("arithmetic coords + worded bonus", async () => {
		const r = await makeExtractor().extract(
			"Move to x=4*2 y=(1+3)*3 and you'll get ten points.",
		);
		expect(r).not.toBeNull();
		expect(r!.opType).toBe("MODIFIER");
		expect(r!.selector.on).toBe("goto");
		expect(r!.bonus).toBe(10);
		const coords = r!.selector.coords ?? [];
		expect(coords.length).toBeGreaterThan(0);
		expect(coords[0]).toEqual({ x: 8, y: 12 });
	});

	// C19: cross penalty with JSON tail
	it("forbidden tiles cross penalty", async () => {
		const r = await makeExtractor().extract(
			'Do not go through tiles (13,15) (14,15) (15,15) (16,15) or you will be penalized. Bonus is -1000pts. Coordinates are [{"x":13,"y":15},{"x":14,"y":15},{"x":15,"y":15},{"x":16,"y":15}]',
		);
		expect(r).not.toBeNull();
		expect(r!.opType).toBe("MODIFIER");
		expect(r!.selector.on).toBe("cross");
		expect(r!.bonus).toBe(-1000);
		expect(r!.lifetime).toBe("persistent");
		expect((r!.selector.tiles ?? []).length).toBe(4);
	});

	// E30: parcel count condition
	it("deliver with carryCountEquals condition", async () => {
		const r = await makeExtractor().extract(
			"Deliver exactly three packages at a time. Bonus is 100pts. Required parcels: 3",
		);
		expect(r).not.toBeNull();
		expect(r!.selector.on).toBe("deliver");
		expect(r!.condition?.carryCountEquals).toBe(3);
		expect(r!.bonus).toBe(100);
	});

	// E32: carryCountAtLeast
	it("deliver with carryCountAtLeast condition", async () => {
		const r = await makeExtractor().extract(
			"Carry at least 4 before any delivery, otherwise it doesn't count.",
		);
		expect(r).not.toBeNull();
		expect(r!.selector.on).toBe("deliver");
		expect(r!.condition?.carryCountAtLeast).toBe(4);
	});

	// F36: deliver-parcel score cap
	it("score cap — deliver-parcel", async () => {
		const r = await makeExtractor().extract(
			"Do not deliver any parcel whose current score is above 10. Wait for it to decay first. Bonus is 0 on violation.",
		);
		expect(r).not.toBeNull();
		expect(r!.selector.on).toBe("deliver-parcel");
		expect(r!.selector.rewardOver).toBe(10);
	});

	// G41: PAUSE
	it("PAUSE directive", async () => {
		const r = await makeExtractor().extract(
			"Stop moving and hold your position until I tell you to go.",
		);
		expect(r).not.toBeNull();
		expect(r!.opType).toBe("PAUSE");
	});

	// G42: RESUME
	it("RESUME directive", async () => {
		const r = await makeExtractor().extract("Ok, you can move again.");
		expect(r).not.toBeNull();
		expect(r!.opType).toBe("RESUME");
	});

	// B14: knowledge Q&A
	it("knowledge Q&A — capital of Italy", async () => {
		const r = await makeExtractor().extract(
			"What is the capital of Italy? Answer me for 50 points.",
		);
		expect(r).not.toBeNull();
		expect(r!.opType).toBe("qa");
		expect(r!.answer?.toLowerCase()).toContain("rome");
		expect(r!.bonus).toBe(50);
	});

	// B13: arithmetic Q&A — (5*(5+3)/2)+2 = 22
	it("arithmetic Q&A", async () => {
		const r = await makeExtractor().extract(
			"Calculate (5*(5+3)/2)+2 to get a bonus una tantum. Bonus is 1000pts.",
		);
		expect(r).not.toBeNull();
		expect(r!.opType).toBe("qa");
		expect(r!.answer).toContain("22");
		expect(r!.bonus).toBe(1000);
		expect(r!.lifetime).toBe("one-shot");
	});

	// D25: multiplier delivery
	it("delivery zone multiplier", async () => {
		const r = await makeExtractor().extract(
			"From now on only deliveries made at (3,8) or (12,4) count — they pay five times normal.",
		);
		expect(r).not.toBeNull();
		expect(r!.selector.on).toBe("deliver");
		expect(r!.effect?.mult).toBe(5);
	});

	// K59: slang/typos
	it("slang and typos", async () => {
		const r = await makeExtractor().extract(
			"móve too (4,7) fr fr, u get 10 pts no cap",
		);
		expect(r).not.toBeNull();
		expect(r!.opType).toBe("MODIFIER");
		expect(r!.selector.on).toBe("goto");
		expect(r!.bonus).toBe(10);
	});
});
