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
export const AGENT_GRACE_STEPS = 3;
// Trust threshold below which an out-of-view agent no longer blocks pathfinding.
export const AGENT_BLOCKING_TRUST_THRESHOLD = 0.5;


// Intention layer: fraction by which a new candidate must exceed the current
// intention's utility to trigger a switch (anti-flicker hysteresis).
// e.g. 0.10 → new candidate must be >10% better than current.
// INVARIANT: INTENTION_SWITCH_MARGIN_FRACTION < RECONSIDER_OPPORTUNITY_MARGIN_FRACTION
export const INTENTION_SWITCH_MARGIN_FRACTION = 0.10;
// Opportunistic reconsider: trigger re-deliberation if a fresh candidate beats
// the committed intention's utility by this fraction.
export const RECONSIDER_OPPORTUNITY_MARGIN_FRACTION = 0.25;
export const MAX_MOVE_FAIL_STREAK = 3;
export const INTENTION_MAX_AGE_STEPS = 50; // safety timeout ~5s @ 100ms
export const PARCEL_BELIEF_STALE_STEPS = 4; // steps out-of-view before treating parcel as lost

// Exploration: how many steps a spawn observed empty stays excluded from explore candidates.
export const SPAWN_OBSERVED_TTL_STEPS = 100;
// Explore terminates as succeeded when target is in FOV AND Manhattan distance ≤ this value.
// Lower = more reactive to pickups (stay close), higher = faster coverage (skip sooner).
export const EXPLORE_TERMINATION_DISTANCE = 2;
// Weight applied to competitor heatmap when ranking explore targets.
// cost += EXPLORE_COMPETITOR_PENALTY_ALPHA * competitorWeight(spawn)
// Higher → more strongly avoid zones where competitors are frequently seen.
export const EXPLORE_COMPETITOR_PENALTY_ALPHA = 3;

// Competitor heatmap: exponential decay horizon in steps.
// weight(t) = weight(0) * exp(-Δsteps / MEMORY_DECAY_HORIZON_STEPS)
export const MEMORY_DECAY_HORIZON_STEPS = 50; // ~5s @ 100ms/step, calibratable from logs

// Race-aware utility: steepness of P_steal = 1 - exp(-margin / k).
// margin = distSelf - distCompetitor (steps). k=2 → 1-tile advantage ≈ 0.39, 2-tile ≈ 0.63, 4-tile ≈ 0.86.
export const RACE_HORIZON_STEPS = 2;

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
