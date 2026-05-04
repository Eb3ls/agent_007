import type { Direction } from "./pathfinder.js";

export type Intention = {
	kind: "deliver" | "pickup" | "explore";
	targetId?: string;
	targetXY: { x: number; y: number };
	expectedUtility: number;
	committedAt: number;
	moveFailStreak: number;
	plan: Direction[];
};

export function makeIntention(
	kind: Intention["kind"],
	targetXY: { x: number; y: number },
	now: number,
	utility: number = 0,
	targetId?: string,
): Intention {
	const base = {
		kind,
		targetXY,
		expectedUtility: utility,
		committedAt: now,
		moveFailStreak: 0,
		plan: [] as Direction[],
	};
	return targetId !== undefined ? { ...base, targetId } : base;
}
