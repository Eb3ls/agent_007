import { DirectiveHandler } from "../team/directives.js";
import { describe, expect, it } from "vitest";

describe("DirectiveHandler — MODIFIER|OVERRIDE pool", () => {
	it("OVERRIDE PAUSE/RESUME toggles paused", () => {
		const h = new DirectiveHandler();
		h.enqueue({ kind: "OVERRIDE", op: "PAUSE" });
		h.apply();
		expect(h.state.paused).toBe(true);
		h.enqueue({ kind: "OVERRIDE", op: "RESUME" });
		h.apply();
		expect(h.state.paused).toBe(false);
	});

	it("OVERRIDE STAGE sets stage; clearStage removes it", () => {
		const h = new DirectiveHandler();
		h.enqueue({
			kind: "OVERRIDE",
			op: "STAGE",
			target: [{ x: 3, y: 4 }],
			thenAct: "pickUp",
		});
		h.apply();
		expect(h.state.stage).not.toBeNull();
		expect(Array.isArray(h.state.stage!.target)).toBe(true);
		expect(h.state.stage!.thenAct).toBe("pickUp");
		h.clearStage();
		expect(h.state.stage).toBeNull();
	});

	it("OVERRIDE STAGE queues; clearStage advances to next", () => {
		const h = new DirectiveHandler();
		h.enqueue({
			kind: "OVERRIDE",
			op: "STAGE",
			target: [{ x: 1, y: 1 }],
			thenAct: "pickUp",
			missionId: "m1",
		});
		h.enqueue({
			kind: "OVERRIDE",
			op: "STAGE",
			target: [{ x: 2, y: 2 }],
			thenAct: "putDown",
			missionId: "m2",
		});
		h.apply();
		expect(
			(h.state.stage!.target as { x: number; y: number }[])[0],
		).toEqual({ x: 1, y: 1 });
		h.clearStage();
		expect(
			(h.state.stage!.target as { x: number; y: number }[])[0],
		).toEqual({ x: 2, y: 2 });
		h.clearStage();
		expect(h.state.stage).toBeNull();
	});

	it("releaseByMissionId removes queued stages for that mission", () => {
		const h = new DirectiveHandler();
		h.enqueue({
			kind: "OVERRIDE",
			op: "STAGE",
			target: [{ x: 1, y: 1 }],
			missionId: "m1",
		});
		h.enqueue({
			kind: "OVERRIDE",
			op: "STAGE",
			target: [{ x: 2, y: 2 }],
			missionId: "m2",
		});
		h.apply();
		h.releaseByMissionId("m1");
		// m1 was the head — should advance to m2
		expect(
			(h.state.stage!.target as { x: number; y: number }[])[0],
		).toEqual({ x: 2, y: 2 });
		h.releaseByMissionId("m2");
		expect(h.state.stage).toBeNull();
	});

	it("MODIFIER added to pool and visible in modifiers", () => {
		const h = new DirectiveHandler();
		h.enqueue({
			kind: "MODIFIER",
			selector: { on: "deliver" },
			effect: { mult: 2 },
			lifetime: "persistent",
			missionId: "m1",
			target: "both",
		});
		h.apply();
		expect(h.state.modifiers).toHaveLength(1);
		expect(h.state.modifiers[0]!.missionId).toBe("m1");
		expect(h.state.modifiers[0]!.effect.mult).toBe(2);
	});

	it("on:cross tiles appear in hardForbiddenTileCoords", () => {
		const h = new DirectiveHandler();
		h.enqueue({
			kind: "MODIFIER",
			selector: {
				on: "cross",
				tiles: [
					{ x: 2, y: 0 },
					{ x: 3, y: 0 },
				],
			},
			effect: { add: -100 },
			lifetime: "persistent",
			missionId: "m1",
			target: "both",
		});
		h.apply();
		expect(h.state.hardForbiddenTileCoords).toHaveLength(2);
		expect(h.state.hardForbiddenTileCoords[0]).toEqual({ x: 2, y: 0 });
	});

	it("on:pickup parcelId appears in forbiddenPickupParcelIds", () => {
		const h = new DirectiveHandler();
		h.enqueue({
			kind: "MODIFIER",
			selector: { on: "pickup", parcelId: "p1" },
			effect: { add: -Infinity },
			lifetime: "persistent",
			missionId: "m1",
			target: "both",
		});
		h.apply();
		expect(h.state.forbiddenPickupParcelIds.has("p1")).toBe(true);
	});

	it("releaseByMissionId drops matching modifiers, keeps others", () => {
		const h = new DirectiveHandler();
		h.enqueue({
			kind: "MODIFIER",
			selector: { on: "deliver" },
			effect: { mult: 2 },
			lifetime: "persistent",
			missionId: "m1",
			target: "both",
		});
		h.enqueue({
			kind: "MODIFIER",
			selector: { on: "deliver" },
			effect: { add: 50 },
			lifetime: "persistent",
			missionId: "m2",
			target: "both",
		});
		h.apply();
		expect(h.state.modifiers).toHaveLength(2);
		h.releaseByMissionId("m1");
		expect(h.state.modifiers).toHaveLength(1);
		expect(h.state.modifiers[0]!.missionId).toBe("m2");
	});

	it("releaseByMissionId clears pause if same missionId", () => {
		const h = new DirectiveHandler();
		h.enqueue({ kind: "OVERRIDE", op: "PAUSE", missionId: "m1" });
		h.apply();
		expect(h.state.paused).toBe(true);
		h.releaseByMissionId("m1");
		expect(h.state.paused).toBe(false);
	});

	it("releaseByMissionId leaves pause from different missionId", () => {
		const h = new DirectiveHandler();
		h.enqueue({ kind: "OVERRIDE", op: "PAUSE", missionId: "m1" });
		h.apply();
		h.releaseByMissionId("m2");
		expect(h.state.paused).toBe(true);
	});

	it("two-mission PAUSE: releasing one does not resume if other still pauses", () => {
		const h = new DirectiveHandler();
		h.enqueue({ kind: "OVERRIDE", op: "PAUSE", missionId: "m1" });
		h.enqueue({ kind: "OVERRIDE", op: "PAUSE", missionId: "m2" });
		h.apply();
		expect(h.state.paused).toBe(true);
		h.releaseByMissionId("m1");
		expect(h.state.paused).toBe(true);
		h.releaseByMissionId("m2");
		expect(h.state.paused).toBe(false);
	});
});
