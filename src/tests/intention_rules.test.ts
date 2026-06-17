import { intentSig } from "../core/intention_rules.js";
import { makeIntention } from "../core/intention.js";
import { describe, expect, it } from "vitest";

describe("intentSig", () => {
	it("formats kind and target", () => {
		const i = makeIntention("pickup", { x: 17, y: 1 }, 0, "p1");
		expect(intentSig(i)).toBe("pickup:(17,1)");
	});

	it("returns idle for null", () => {
		expect(intentSig(null)).toBe("idle");
	});
});
