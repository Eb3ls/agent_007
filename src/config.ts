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
export const FALLBACK_AGENT_CAPACITY = 5;
export const DETOUR_UTILITY_EPSILON = 1;

// Loop timing constants
export const READY_POLL_MS = 50; // waitForReady polling interval
export const POST_ACTION_WAIT_MS = 300; // wait for sensing update after pickup/putdown
export const NO_STEP_WAIT_MS = 200; // no plan available → retry

/** Parses Deliveroo decaying_event string ("infinite", "0", "500ms", "5s") into ms. */
export function parseDecayInterval(s: string | undefined): number {
	if (!s || s === "infinite" || s === "0") return Infinity;
	const ms = s.match(/^(\d+)ms$/);
	if (ms) return parseInt(ms[1]!, 10);
	const sec = s.match(/^(\d+)s$/);
	if (sec) return parseInt(sec[1]!, 10) * 1000;
	return Infinity;
}
