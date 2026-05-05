import type { Direction } from "./pathfinder.js";

export type Intention = {
	kind: "deliver" | "pickup" | "explore";
	targetId?: string;
	targetXY: { x: number; y: number };
	committedAt: number;
	moveFailStreak: number;
	plan: Direction[];
};

export function makeIntention(
	kind: Intention["kind"],
	targetXY: { x: number; y: number },
	now: number,
	targetId?: string,
): Intention {
	const base = {
		kind,
		targetXY,
		committedAt: now,
		moveFailStreak: 0,
		plan: [] as Direction[],
	};
	return targetId !== undefined ? { ...base, targetId } : base;
}
