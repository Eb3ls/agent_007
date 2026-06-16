import type { Direction } from "../pathfinder.js";

export type Intention = {
	kind: "deliver" | "pickup" | "explore" | "goto" | "push";
	targetId?: string;
	targetXY: { x: number; y: number };
	committedAt: number;
	moveFailStreak: number;
	plan: Direction[];
	/** missionId from MODIFIER goto → emits RELEASE on completion */
	missionId?: string;
	/** scope for RELEASE event (derived from MODIFIER.target: "both"→global, id→per-agent) */
	releaseScope?: "global" | "per-agent";
	/** plan was produced by the PDDL crate solver — exempt from BFS-based viability/soundness aborts */
	usedPDDL?: boolean;
};

export function makeIntention(
	kind: Intention["kind"],
	targetXY: { x: number; y: number },
	now: number,
	targetId?: string,
	missionId?: string,
	releaseScope?: "global" | "per-agent",
): Intention {
	const base: Intention = {
		kind,
		targetXY,
		committedAt: now,
		moveFailStreak: 0,
		plan: [],
	};
	if (targetId !== undefined) base.targetId = targetId;
	if (missionId !== undefined) base.missionId = missionId;
	if (releaseScope !== undefined) base.releaseScope = releaseScope;
	return base;
}
