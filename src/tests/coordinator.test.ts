import { describe, expect, it, beforeEach } from "vitest";
import { Coordinator } from "../team/coordinator.js";

describe("Coordinator", () => {
	let coord: Coordinator;

	beforeEach(() => {
		coord = new Coordinator();
	});

	it("exclusionsFor excludes other agents' parcel targets via intentionSummary", () => {
		coord.publish("bdi", {
			pos: { x: 0, y: 0 },
			carry: { count: 0, reward: 0, ids: [] },
			intentionSummary: { kind: "pickup", targetId: "parcel-abc" },
		});
		coord.publish("llm", {
			pos: { x: 1, y: 1 },
			carry: { count: 0, reward: 0, ids: [] },
			intentionSummary: { kind: "idle" },
		});

		const excl = coord.exclusionsFor("llm");
		expect(excl.excludedParcelIds.has("parcel-abc")).toBe(true);
		expect(excl.exploreExcludedSpawnIds.size).toBe(0);
	});

	it("exclusionsFor does not exclude the calling agent's own target", () => {
		coord.publish("bdi", {
			pos: { x: 0, y: 0 },
			carry: { count: 0, reward: 0, ids: [] },
			intentionSummary: { kind: "pickup", targetId: "parcel-xyz" },
		});

		const excl = coord.exclusionsFor("bdi");
		expect(excl.excludedParcelIds.size).toBe(0);
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

	it("exclusionsFor clears exclusion when agent changes intention", () => {
		coord.publish("bdi", {
			pos: { x: 0, y: 0 },
			carry: { count: 0, reward: 0, ids: [] },
			intentionSummary: { kind: "pickup", targetId: "parcel-abc" },
		});
		// Agent publishes a new intention — old target is implicitly released.
		coord.publish("bdi", {
			pos: { x: 0, y: 0 },
			carry: { count: 1, reward: 5, ids: ["parcel-abc"] },
			intentionSummary: { kind: "deliver" },
		});
		const excl = coord.exclusionsFor("llm");
		expect(excl.excludedParcelIds.size).toBe(0);
	});

	it("exclusionsFor excludes other agents' explore spawn targets via intentionSummary", () => {
		coord.publish("bdi", {
			pos: { x: 0, y: 0 },
			carry: { count: 0, reward: 0, ids: [] },
			intentionSummary: { kind: "explore", spawnerIds: [42] },
		});
		const excl = coord.exclusionsFor("llm");
		expect(excl.exploreExcludedSpawnIds.has(42)).toBe(true);
		expect(excl.excludedParcelIds.size).toBe(0);
	});
});
