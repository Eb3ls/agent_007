// Server config fallbacks — used before onConfig arrives
export const FALLBACK_MOVEMENT_DURATION_MS = 100;
export const FALLBACK_OBSERVATION_DISTANCE = 5;

// Belief TTL: how many movement_duration units to keep entities after leaving view
export const PARCEL_TTL_MULT = 20;
export const AGENT_TTL_MULT = 10;

// Planner: keep a stationary agent "blocked" for ~3 ticks after leaving view
// (breaks oscillation when an agent sits at the edge of sensing range)
export const SHORT_BLOCK_TTL_MS = 300;

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
