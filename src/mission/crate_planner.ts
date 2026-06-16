import {
	type BfsFromSelf,
	type Direction,
	reconstructPath,
} from "../pathfinder.js";
import type { BeliefStore } from "../belief_store.js";
import { planWithCrates } from "./pddl_planner.js";
import type { StaticMap } from "../static_map.js";
import { log } from "../logger.js";

export interface CratePlannerContext {
	lastPDDLAttempt: number; // timestamp of last PDDL attempt
	lastPDDLTarget: { x: number; y: number } | null; // avoid repeated attempts for same target
	pddlCooldownMs: number; // don't spam PDDL planning
}

/**
 * Smart planner that tries BFS first, falls back to PDDL if blocked by crates.
 *
 * Returns Direction[] for use in intention.plan (empty when no route exists).
 * Called from AgentCore's soundness gate when plain BFS finds no path.
 */
export async function buildPlanWithCrateHandling(
	map: StaticMap,
	bfs: BfsFromSelf,
	targetX: number,
	targetY: number,
	beliefs: BeliefStore,
	selfX: number,
	selfY: number,
	context: CratePlannerContext,
): Promise<Direction[]> {
	// PDDL only helps when crates can be pushed; nothing to do otherwise.
	if (beliefs.crates.size === 0) return [];

	// Try plain BFS first; fall back to PDDL only when crates block the path.
	const bfsPlan = reconstructPath(map, bfs, targetX, targetY);
	if (bfsPlan && bfsPlan.length > 0) return bfsPlan;

	// BFS failed — throttle repeated PDDL attempts at the same target to avoid spam.
	const now = Date.now();
	const sameTarget =
		context.lastPDDLTarget?.x === targetX &&
		context.lastPDDLTarget?.y === targetY;
	if (sameTarget && now - context.lastPDDLAttempt < context.pddlCooldownMs) {
		log.debug(
			"crate_plan",
			`BFS+PDDL both failed for (${targetX},${targetY}), cooldown active`,
		);
		return [];
	}

	// Attempt PDDL planning
	log.debug(
		"crate_plan",
		`BFS failed for (${targetX},${targetY}) — attempting PDDL`,
	);

	context.lastPDDLAttempt = now;
	context.lastPDDLTarget = { x: targetX, y: targetY };

	try {
		const pddlPlan = await planWithCrates(
			map,
			beliefs,
			selfX,
			selfY,
			targetX,
			targetY,
		);

		if (pddlPlan && pddlPlan.length > 0) {
			log.ok(
				"crate_plan",
				`PDDL succeeded: ${pddlPlan.length} steps to navigate crates`,
			);
			return pddlPlan;
		}

		log.warn("crate_plan", `PDDL planning returned empty plan`);
		return [];
	} catch (err) {
		log.error(
			"crate_plan",
			`PDDL planning crashed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}
}

/**
 * Create a new planner context with safe defaults.
 */
export function createCratePlannerContext(
	cooldownMs = 1000,
): CratePlannerContext {
	return {
		lastPDDLAttempt: 0,
		lastPDDLTarget: null,
		pddlCooldownMs: cooldownMs,
	};
}
