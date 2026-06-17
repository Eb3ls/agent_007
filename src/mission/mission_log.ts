import type { MissionRecord, XY } from "./extractor.js";

// One-line human summary of a MissionRecord for logs. Prints only the fields that
// carry signal for the record's opType/selector — nulls and defaults are omitted.

function fmtXY(coords: readonly XY[]): string {
	return coords.map((c) => `(${c.x},${c.y})`).join(",");
}

function selectorDesc(sel: MissionRecord["selector"]): string {
	switch (sel.on) {
		case "deliver":
			return `tile=${sel.tile ? `(${sel.tile.x},${sel.tile.y})` : "any"}`;
		case "goto":
			return sel.coords?.length
				? `coords=${fmtXY(sel.coords)}`
				: "coords=?";
		case "cross":
			return sel.tiles?.length ? `tiles=${fmtXY(sel.tiles)}` : "tiles=?";
		case "deliver-parcel":
			return sel.rewardOver != null
				? `rewardOver=${sel.rewardOver}`
				: "rewardOver=?";
		case "pickup":
			return sel.parcelId ? `parcelId=${sel.parcelId}` : "parcelId=?";
		default:
			return "";
	}
}

export function formatMissionRecord(r: MissionRecord): string {
	const parts = [`op=${r.opType}`, `on=${r.selector.on}`];

	const sel = selectorDesc(r.selector);
	if (sel) parts.push(sel);

	if (r.effect.mult !== undefined) parts.push(`mult=${r.effect.mult}`);
	if (r.effect.add !== undefined) parts.push(`add=${r.effect.add}`);
	else if (r.bonus !== null) parts.push(`bonus=${r.bonus}`);
	if (r.condition) parts.push(`condition=${JSON.stringify(r.condition)}`);

	parts.push(`lifetime=${r.lifetime}`, `target=${r.target}`);

	if (r.predicate?.length)
		parts.push(`predicate=${JSON.stringify(r.predicate)}`);
	if (r.token) parts.push(`token=${r.token}`);
	if (r.maxDist != null) parts.push(`maxDist=${r.maxDist}`);
	if (r.needsResolve) parts.push("needsResolve");
	if (r.answer) parts.push(`answer=${r.answer.slice(0, 40)}`);

	return parts.join(" ");
}
