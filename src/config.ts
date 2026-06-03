import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { parse } from "yaml";

const __dir = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dir, "../config.yaml");

interface RawConfig {
	server: {
		fallback_movement_duration_ms: number;
		fallback_observation_distance: number;
	};
	belief: {
		parcel_ttl_mult: number;
		agent_ttl_mult: number;
		expected_steal_horizon_steps: number;
		agent_grace_steps: number;
		agent_blocking_trust_threshold: number;
		parcel_belief_stale_steps: number;
	};
	intention: {
		switch_margin_fraction: number;
		reconsider_opportunity_margin_fraction: number;
		max_move_fail_streak: number;
		max_age_steps: number;
	};
	explore: {
		spawn_observed_ttl_steps: number;
		termination_distance: number;
		competitor_penalty_alpha: number;
		memory_decay_horizon_steps: number;
	};
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

export const FALLBACK_MOVEMENT_DURATION_MS =
	cfg.server.fallback_movement_duration_ms;
export const FALLBACK_OBSERVATION_DISTANCE =
	cfg.server.fallback_observation_distance;

export const PARCEL_TTL_MULT = cfg.belief.parcel_ttl_mult;
export const AGENT_TTL_MULT = cfg.belief.agent_ttl_mult;
export const EXPECTED_STEAL_HORIZON_STEPS =
	cfg.belief.expected_steal_horizon_steps;
export const AGENT_GRACE_STEPS = cfg.belief.agent_grace_steps;
export const AGENT_BLOCKING_TRUST_THRESHOLD =
	cfg.belief.agent_blocking_trust_threshold;
export const PARCEL_BELIEF_STALE_STEPS = cfg.belief.parcel_belief_stale_steps;

export const INTENTION_SWITCH_MARGIN_FRACTION =
	cfg.intention.switch_margin_fraction;
export const RECONSIDER_OPPORTUNITY_MARGIN_FRACTION =
	cfg.intention.reconsider_opportunity_margin_fraction;
export const MAX_MOVE_FAIL_STREAK = cfg.intention.max_move_fail_streak;
export const INTENTION_MAX_AGE_STEPS = cfg.intention.max_age_steps;

export const SPAWN_OBSERVED_TTL_STEPS = cfg.explore.spawn_observed_ttl_steps;
export const EXPLORE_TERMINATION_DISTANCE = cfg.explore.termination_distance;
export const EXPLORE_COMPETITOR_PENALTY_ALPHA =
	cfg.explore.competitor_penalty_alpha;
export const MEMORY_DECAY_HORIZON_STEPS =
	cfg.explore.memory_decay_horizon_steps;

export const RACE_HORIZON_STEPS = cfg.race.horizon_steps;

export const READY_POLL_MS = cfg.loop.ready_poll_ms;
export const NO_STEP_WAIT_MS = cfg.loop.no_step_wait_ms;

export const LOG_LEVEL = cfg.log.level;

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
