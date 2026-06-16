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
	crates: { enabled: boolean; cooldown_ms: number };
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

export const cfg = loadConfig();

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

/** Returns decay interval in ms; 0 if decaying_event is outside the valid set (d=0 guard). */
export function parseDecayInterval(rawInterval: string | undefined): number {
	if (!rawInterval || !VALID_DECAY_EVENTS.has(rawInterval)) {
		if (rawInterval !== undefined) {
			console.warn(
				`[config] decaying_event="${rawInterval}" not in {frame,1s,2s,5s,10s,1m,1h} — d=0 (no decay)`,
			);
		}
		return 0;
	}
	return DECAY_INTERVAL_MS[rawInterval]!;
}
