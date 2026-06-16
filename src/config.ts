import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { parse } from "yaml";

const __dir = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dir, "../config.yaml");

interface RawConfig {
	belief: {
		parcel_ttl_mult: number;
		agent_ttl_mult: number;
		expected_steal_horizon_steps: number;
		agent_grace_steps: number;
		agent_blocking_trust_threshold: number;
		parcel_belief_stale_steps: number;
	};
	intention: {
		start_margin: number;
		abort_margin: number;
		switch_margin: number;
		reconsider_opportunity_margin_fraction: number;
		max_move_fail_streak: number;
		max_age_steps: number;
		ski_rental_fraction: number;
		p_steal_clamp: number;
		opponent_defer_steps: number;
		l_seed_efficiency: number;
		hysteresis_pct: number;
		steal_prob: number;
		staleness_discount: number;
		contest_p_lose: number;
	};
	explore: {
		spawn_observed_ttl_steps: number;
		termination_distance: number;
		competitor_penalty_alpha: number;
		memory_decay_horizon_steps: number;
		ev_promote: boolean;
	};
	mission: { l1_max_steps: number };
	race: { horizon_steps: number };
	loop: { ready_poll_ms: number; no_step_wait_ms: number };
	log: { level: "silent" | "info" | "debug" };
}

function loadConfig(): RawConfig {
	try {
		return parse(readFileSync(configPath, "utf8")) as RawConfig;
	} catch {
		throw new Error(
			`Failed to load config.yaml at ${configPath} — copy config.example.yaml`,
		);
	}
}

const cfg = loadConfig();

export const PARCEL_TTL_MULT = cfg.belief.parcel_ttl_mult;
export const AGENT_TTL_MULT = cfg.belief.agent_ttl_mult;
export const EXPECTED_STEAL_HORIZON_STEPS =
	cfg.belief.expected_steal_horizon_steps;
export const AGENT_GRACE_STEPS = cfg.belief.agent_grace_steps;
export const AGENT_BLOCKING_TRUST_THRESHOLD =
	cfg.belief.agent_blocking_trust_threshold;
export const PARCEL_BELIEF_STALE_STEPS = cfg.belief.parcel_belief_stale_steps;

export const INTENTION_START_MARGIN = cfg.intention.start_margin;
export const INTENTION_ABORT_MARGIN = cfg.intention.abort_margin;
export const INTENTION_SWITCH_MARGIN = cfg.intention.switch_margin;
export const RECONSIDER_OPPORTUNITY_MARGIN_FRACTION =
	cfg.intention.reconsider_opportunity_margin_fraction;
export const MAX_MOVE_FAIL_STREAK = cfg.intention.max_move_fail_streak;
export const INTENTION_MAX_AGE_STEPS = cfg.intention.max_age_steps;
export const SKI_RENTAL_FRACTION = cfg.intention.ski_rental_fraction;
export const P_STEAL_CLAMP = cfg.intention.p_steal_clamp;
export const OPPONENT_DEFER_STEPS = cfg.intention.opponent_defer_steps;
export const L_SEED_EFFICIENCY = cfg.intention.l_seed_efficiency;
export const HYSTERESIS_PCT = cfg.intention.hysteresis_pct;
export const STEAL_PROB = cfg.intention.steal_prob;
export const STALENESS_DISCOUNT = cfg.intention.staleness_discount;
export const CONTEST_P_LOSE = cfg.intention.contest_p_lose;

export const SPAWN_OBSERVED_TTL_STEPS = cfg.explore.spawn_observed_ttl_steps;
export const EXPLORE_TERMINATION_DISTANCE = cfg.explore.termination_distance;
export const EXPLORE_COMPETITOR_PENALTY_ALPHA =
	cfg.explore.competitor_penalty_alpha;
export const MEMORY_DECAY_HORIZON_STEPS =
	cfg.explore.memory_decay_horizon_steps;
export const EXPLORE_EV_PROMOTE = cfg.explore.ev_promote;

export const L1_MAX_STEPS = cfg.mission.l1_max_steps;

export const RACE_HORIZON_STEPS = cfg.race.horizon_steps;

export const READY_POLL_MS = cfg.loop.ready_poll_ms;
export const NO_STEP_WAIT_MS = cfg.loop.no_step_wait_ms;

export const LOG_LEVEL = cfg.log.level;

// The only values the server clock actually emits (Clock.js:107-131).
// Any other decaying_event → decay listener never fires → d=0.
const VALID_DECAY_EVENTS = new Set([
	"frame",
	"1s",
	"2s",
	"5s",
	"10s",
	"1m",
	"1h",
]);

const DECAY_INTERVAL_MS: Record<string, number> = {
	frame: 33,
	"1s": 1000,
	"2s": 2000,
	"5s": 5000,
	"10s": 10000,
	"1m": 60000,
	"1h": 3600000,
};

export let DECAY_GUARD_TRIGGERED = false;

/** Returns decay interval in ms; 0 if decaying_event is outside the valid set (d=0 guard). */
export function parseDecayInterval(rawInterval: string | undefined): number {
	if (!rawInterval || !VALID_DECAY_EVENTS.has(rawInterval)) {
		if (rawInterval !== undefined) {
			console.warn(
				`[config] decaying_event="${rawInterval}" not in {frame,1s,2s,5s,10s,1m,1h} — d=0 (no decay)`,
			);
			DECAY_GUARD_TRIGGERED = true;
		}
		return 0;
	}
	return DECAY_INTERVAL_MS[rawInterval]!;
}

/** Throws if movement_duration + clockOverheadMs >= 1000 (tick would overflow a second). */
export function assertConfigInvariants(
	movementDurationMs: number,
	clockOverheadMs = 50,
): void {
	if (movementDurationMs + clockOverheadMs >= 1000) {
		throw new Error(
			`Config invariant violated: movement_duration(${movementDurationMs}) + clockOverhead(${clockOverheadMs}) >= 1000`,
		);
	}
}
