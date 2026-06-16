import { describe, expect, it, beforeEach } from "vitest";
import { Coordinator } from "../team/coordinator.js";

describe("Coordinator", () => {
	let coord: Coordinator;

	beforeEach(() => {
		coord = new Coordinator();
	});

	it("assignFor excludes other agents' parcel targets", () => {
		coord.registerTarget("bdi", "parcel-abc");
		coord.registerTarget("llm", null);

		const advice = coord.assignFor("llm");
		expect(advice.excludedParcelIds.has("parcel-abc")).toBe(true);
		expect(advice.exploreExcludedSpawnIds.size).toBe(0);
	});

	it("assignFor does not exclude the calling agent's own target", () => {
		coord.registerTarget("bdi", "parcel-xyz");

		const advice = coord.assignFor("bdi");
		expect(advice.excludedParcelIds.size).toBe(0);
	});

	it("posOf returns null before publish", () => {
		expect(coord.posOf("bdi")).toBeNull();
	});

	it("publish + posOf round-trip", () => {
		coord.publish("bdi", {
			pos: { x: 3, y: 5 },
			carry: { count: 0, reward: 0, ids: [] },
			intentionSummary: { kind: "idle" },
		});
		expect(coord.posOf("bdi")).toEqual({ x: 3, y: 5 });
	});

	it("releaseTarget clears exclusion", () => {
		coord.registerTarget("bdi", "parcel-abc");
		coord.releaseTarget("bdi");
		const advice = coord.assignFor("llm");
		expect(advice.excludedParcelIds.size).toBe(0);
	});

	it("assignFor excludes other agents' explore spawn targets via intentionSummary", () => {
		coord.publish("bdi", {
			pos: { x: 0, y: 0 },
			carry: { count: 0, reward: 0, ids: [] },
			intentionSummary: { kind: "explore", spawnerIds: [42] },
		});
		const advice = coord.assignFor("llm");
		expect(advice.exploreExcludedSpawnIds.has(42)).toBe(true);
		expect(advice.excludedParcelIds.size).toBe(0);
	});
});
