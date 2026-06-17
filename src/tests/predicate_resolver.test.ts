import {
	resolvePredicateTokens,
	setMap,
	createStaticMap,
} from "../static_map.js";
import type { IOTile } from "@unitn-asa/deliveroo-js-sdk";
import { describe, expect, it } from "vitest";

function makeMap() {
	const m = createStaticMap();
	const tiles: IOTile[] = [
		{ x: 0, y: 0, type: "1" as IOTile["type"] }, // spawn, even-tile (x%2=0,y%2=0)
		{ x: 1, y: 0, type: "1" as IOTile["type"] }, // spawn, even-row (y%2=0), odd-col (x%2=1)
		{ x: 0, y: 1, type: "2" as IOTile["type"] }, // delivery, odd-row (y%2=1), even-col (x%2=0)
		{ x: 1, y: 1, type: "2" as IOTile["type"] }, // delivery, odd-tile (x%2=1,y%2=1)
		{ x: 2, y: 2, type: "0" as IOTile["type"] }, // empty — must be excluded
	];
	setMap(m, tiles);
	return m;
}

describe("resolvePredicateTokens", () => {
	it("odd-row returns tiles where y%2!==0", () => {
		const result = resolvePredicateTokens(["odd-row"], makeMap());
		expect(result).toHaveLength(2);
		expect(result.every((p) => p.y % 2 !== 0)).toBe(true);
	});

	it("even-row returns tiles where y%2===0", () => {
		const result = resolvePredicateTokens(["even-row"], makeMap());
		expect(result).toHaveLength(2);
		expect(result.every((p) => p.y % 2 === 0)).toBe(true);
	});

	it("odd-col returns tiles where x%2!==0", () => {
		const result = resolvePredicateTokens(["odd-col"], makeMap());
		expect(result).toHaveLength(2);
		expect(result.every((p) => p.x % 2 !== 0)).toBe(true);
	});

	it("odd-tile returns tiles where x%2!==0 and y%2!==0", () => {
		const result = resolvePredicateTokens(["odd-tile"], makeMap());
		expect(result).toEqual([{ x: 1, y: 1 }]);
	});

	it("even-tile returns tiles where x%2===0 and y%2===0", () => {
		const result = resolvePredicateTokens(["even-tile"], makeMap());
		expect(result).toEqual([{ x: 0, y: 0 }]);
	});

	it("delivery returns only delivery tiles", () => {
		const result = resolvePredicateTokens(["delivery"], makeMap());
		expect(result).toHaveLength(2);
		expect(
			result.every(
				(p) => (p.x === 0 && p.y === 1) || (p.x === 1 && p.y === 1),
			),
		).toBe(true);
	});

	it("spawn returns only spawn tiles", () => {
		const result = resolvePredicateTokens(["spawn"], makeMap());
		expect(result).toHaveLength(2);
		expect(result.every((p) => p.y === 0)).toBe(true);
	});

	it("delivery+leftmost returns single leftmost delivery tile", () => {
		const result = resolvePredicateTokens(
			["delivery", "leftmost"],
			makeMap(),
		);
		expect(result).toEqual([{ x: 0, y: 1 }]);
	});

	it("odd-row+rightmost returns single rightmost odd-row tile", () => {
		const result = resolvePredicateTokens(
			["odd-row", "rightmost"],
			makeMap(),
		);
		expect(result).toEqual([{ x: 1, y: 1 }]);
	});

	it("center returns a single tile", () => {
		const result = resolvePredicateTokens(["center"], makeMap());
		expect(result).toHaveLength(1);
	});

	it("empty tokens returns all non-empty tiles", () => {
		const result = resolvePredicateTokens([], makeMap());
		expect(result).toHaveLength(4); // 4 non-empty tiles
	});

	it("empty map returns empty array", () => {
		const result = resolvePredicateTokens(["odd-row"], createStaticMap());
		expect(result).toEqual([]);
	});

	// Compound directions compose as cascading sort keys: topmost (min y) then
	// leftmost (min x) → the true top-left corner, not just the leftmost tile.
	it("topmost+leftmost returns the true top-left corner", () => {
		const result = resolvePredicateTokens(
			["topmost", "leftmost"],
			makeMap(),
		);
		expect(result).toEqual([{ x: 0, y: 0 }]);
	});

	it("delivery+topmost+leftmost returns top-left delivery tile", () => {
		const result = resolvePredicateTokens(
			["delivery", "topmost", "leftmost"],
			makeMap(),
		);
		expect(result).toEqual([{ x: 0, y: 1 }]);
	});

	// center composes with type filters: picks the delivery tile nearest the map
	// center, even when the geometric center itself is not a delivery tile.
	it("delivery+center picks the delivery nearest the map center", () => {
		const m = createStaticMap();
		setMap(m, [
			{ x: 0, y: 0, type: "2" as IOTile["type"] }, // delivery, far
			{ x: 2, y: 1, type: "2" as IOTile["type"] }, // delivery, nearest center (2,2)
			{ x: 4, y: 4, type: "2" as IOTile["type"] }, // delivery, far
			{ x: 2, y: 2, type: "0" as IOTile["type"] }, // empty center
		]);
		const result = resolvePredicateTokens(["delivery", "center"], m);
		expect(result).toEqual([{ x: 2, y: 1 }]);
	});
});
