import { formatMissionRecord } from "../mission/mission_log.js";
import type { MissionRecord } from "../mission/extractor.js";
import { describe, expect, it } from "vitest";

function rec(over: Partial<MissionRecord>): MissionRecord {
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
		raw: "",
		...over,
	};
}

describe("formatMissionRecord", () => {
	it("deliver modifier shows the tiles (not a coords count)", () => {
		const s = formatMissionRecord(
			rec({
				selector: {
					on: "deliver",
					tiles: [
						{ x: 1, y: 1 },
						{ x: 6, y: 2 },
					],
				},
				effect: { mult: 5 },
			}),
		);
		expect(s).toContain("on=deliver");
		expect(s).toContain("tiles=(1,1),(6,2)");
		expect(s).toContain("mult=5");
		expect(s).not.toContain("coords=");
	});

	it("deliver with no tiles shows tiles=any", () => {
		expect(formatMissionRecord(rec({}))).toContain("tiles=any");
	});

	it("goto modifier shows coords", () => {
		const s = formatMissionRecord(
			rec({
				selector: { on: "goto", coords: [{ x: 4, y: 7 }] },
				effect: { add: 10 },
			}),
		);
		expect(s).toContain("coords=(4,7)");
		expect(s).toContain("add=10");
	});

	it("cross modifier shows tiles", () => {
		const s = formatMissionRecord(
			rec({
				selector: {
					on: "cross",
					tiles: [
						{ x: 1, y: 1 },
						{ x: 2, y: 1 },
					],
				},
				effect: { add: -1000 },
			}),
		);
		expect(s).toContain("tiles=(1,1),(2,1)");
	});

	it("omits null token but shows a real resume token", () => {
		expect(formatMissionRecord(rec({}))).not.toContain("token=");
		expect(
			formatMissionRecord(rec({ opType: "STAGE", token: "green" })),
		).toContain("token=green");
	});

	it("qa shows the answer", () => {
		const s = formatMissionRecord(
			rec({ opType: "qa", answer: "Rome", effect: { add: 50 } }),
		);
		expect(s).toContain("answer=Rome");
	});
});
