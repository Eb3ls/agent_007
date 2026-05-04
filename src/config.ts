// Server config fallbacks — used before onConfig arrives
export const FALLBACK_MOVEMENT_DURATION_MS = 100;
export const FALLBACK_OBSERVATION_DISTANCE = 5;

// Belief TTL: how many movement_duration units to keep entities after leaving view
export const PARCEL_TTL_MULT = 20;
export const AGENT_TTL_MULT = 10;

// Probabilistic belief: expected number of steps before a competitor picks up
// an out-of-view parcel. P_alive = exp(-age_steps / horizon). ~15 steps ≈ 1.5s.
// PARCEL_TTL_MULT must be >> EXPECTED_STEAL_HORIZON_STEPS to avoid evicting parcels
// before P_alive has decayed to near-zero (~3× is the practical minimum).
export const EXPECTED_STEAL_HORIZON_STEPS = 15;

// Grace window: keep an out-of-view agent's tile hard-blocked for this many steps.
// Replaces SHORT_BLOCK_TTL_MS once commit C lands. ~3 steps @ 100ms/step.
export const AGENT_GRACE_STEPS = 3;

// Multi-parcel detour: capacity fallback and minimum surplus to commit a detour.
// Server does not enforce capacity; set to 100 to disable the cap.
export const FALLBACK_AGENT_CAPACITY = 5;
export const CAPACITY_OVERRIDE = 100;
export const DETOUR_UTILITY_EPSILON = 1;

// Intention layer: thresholds for path commitment and forced replan.
export const INTENTION_UTILITY_EPSILON = 2; // must be > DETOUR_UTILITY_EPSILON to avoid flicker
// Opportunistic reconsider: when empty (kind=pickup/explore), trigger re-deliberation if
// a fresh pickup candidate beats the committed intention's utility by this margin.
export const RECONSIDER_OPPORTUNITY_MARGIN = 5;
export const MAX_MOVE_FAIL_STREAK = 3;
export const INTENTION_MAX_AGE_STEPS = 50; // safety timeout ~5s @ 100ms
export const PARCEL_BELIEF_STALE_STEPS = 4; // steps out-of-view before treating parcel as lost

// Exploration: how many steps to avoid re-visiting a spawn tile after arriving empty.
export const SPAWN_VISITED_TTL_STEPS = 100;

// Competitor heatmap: exponential decay horizon in steps.
// weight(t) = weight(0) * exp(-Δsteps / MEMORY_DECAY_HORIZON_STEPS)
export const MEMORY_DECAY_HORIZON_STEPS = 50; // ~5s @ 100ms/step, calibratable from logs

// Loop timing constants
export const READY_POLL_MS = 50; // waitForReady polling interval
export const NO_STEP_WAIT_MS = 200; // no plan available → retry

/** Parses Deliveroo decaying_event string ("infinite", "0", "500ms", "5s") into ms. */
export function parseDecayInterval(rawInterval: string | undefined): number {
	if (!rawInterval || rawInterval === "infinite" || rawInterval === "0")
		return Infinity;
	const msMatch = rawInterval.match(/^(\d+)ms$/);
	if (msMatch) return parseInt(msMatch[1]!, 10);
	const secMatch = rawInterval.match(/^(\d+)s$/);
	if (secMatch) return parseInt(secMatch[1]!, 10) * 1000;
	return Infinity;
}
