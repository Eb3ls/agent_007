import type { BeliefStore } from "../belief_store.js";
import { DIRS, TILE, tileId } from "../static_map.js";
import type { StaticMap } from "../static_map.js";
import type { Direction } from "../pathfinder.js";
import { readFileSync, writeFileSync } from "fs";
import { directionOf } from "../pathfinder.js";
import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";
import { tmpdir } from "os";

type PlanStep = { action: string; parameters: string[] };

interface PlannerResponse {
	status: "solved" | "unsolvable" | "timeout" | "error";
	plan?: PlanStep[] | undefined;
	error?: string | undefined;
	planning_time?: number | undefined;
}

// --- PDDL generation helpers ---

// Single source of truth for PDDL object names.
const loc = (x: number, y: number): string => `loc_${x}_${y}`;

// Tile classification (crate tiles are walkable and can hold/receive a pushed crate).
const isWalkable = (type: string): boolean => type !== TILE.EMPTY;
const isCrateTile = (type: string): boolean =>
	type === TILE.CRATE_SLIDE || type === TILE.CRATE_SLIDE_MOVING;

/**
 * Build the PDDL problem for the current state: one `location` per walkable tile,
 * plus adjacency and straight-line push geometry. Crates are anonymous — each crate
 * tile believed occupied (per `beliefs.crateOccupancy`) emits an `(occupied …)` fact,
 * every other location is `(clear …)`.
 *
 * The goal is the agent reaching the target tile. When `combinedPickup` is given
 * the goal becomes "visit that tile (setting (picked)), then reach the target" —
 * a single collect-then-deliver problem (harder for the solver; see planWithCrates).
 *
 * Crate occupancy comes from `beliefs.crateOccupancy`; pass a belief store with a
 * simulated occupancy set to plan a later leg from a post-push crate state.
 */
function generateProblemPDDL(
	map: StaticMap,
	beliefs: BeliefStore,
	agentX: number,
	agentY: number,
	targetX: number,
	targetY: number,
	combinedPickup?: { x: number; y: number },
): string {
	// A crate tile holds a crate per belief — except the agent's own tile, which it
	// is standing on and so must be clear (guards against a stale occupancy entry).
	const isOccupied = (x: number, y: number): boolean =>
		beliefs.crateOccupancy.has(tileId(map, x, y)) &&
		!(x === agentX && y === agentY);

	// Pass 1: classify every walkable location (crate tiles are walkable too).
	const walkableTiles = new Set<string>();
	const crateTiles = new Set<string>();
	for (const [tileKey, tile] of map.tiles) {
		if (!isWalkable(tile.type)) continue;
		walkableTiles.add(tileKey);
		if (isCrateTile(tile.type)) crateTiles.add(tileKey);
	}

	// Pass 2: adjacency, clear/occupied and crate-tile facts. Needs the full walkable
	// set from pass 1 to test neighbours, so it can't be folded into pass 1.
	const adjacencyFacts: string[] = [];
	const clearFacts: string[] = [];
	const occupiedFacts: string[] = [];
	const crateTileFacts: string[] = [];
	for (const tile of map.tiles.values()) {
		if (!isWalkable(tile.type)) continue;
		const { x, y } = tile;
		for (const [dx, dy] of DIRS) {
			if (walkableTiles.has(`${x + dx},${y + dy}`)) {
				adjacencyFacts.push(
					`(adjacent ${loc(x, y)} ${loc(x + dx, y + dy)})`,
				);
			}
		}
		if (isCrateTile(tile.type)) {
			crateTileFacts.push(`(on-crate-tile ${loc(x, y)})`);
			if (isOccupied(x, y)) occupiedFacts.push(`(occupied ${loc(x, y)})`);
			else clearFacts.push(`(clear ${loc(x, y)})`);
		} else {
			clearFacts.push(`(clear ${loc(x, y)})`); // non-crate tiles never hold crates
		}
	}

	// Straight-line push geometry: a crate on ?via can be pushed to ?to only if the
	// agent stands at ?from with ?from -> ?via -> ?to collinear and consecutive
	// (real box-pushing — no reversals or right-angle turns). ?via and ?to must be
	// crate tiles (crates live on and move between them); ?from must be walkable.
	const pushLineFacts: string[] = [];
	for (const viaKey of crateTiles) {
		const via = map.tiles.get(viaKey)!;
		for (const [dx, dy] of DIRS) {
			const fromKey = `${via.x - dx},${via.y - dy}`;
			const toKey = `${via.x + dx},${via.y + dy}`;
			if (walkableTiles.has(fromKey) && crateTiles.has(toKey)) {
				pushLineFacts.push(
					`(push-line ${loc(via.x - dx, via.y - dy)} ${loc(via.x, via.y)} ${loc(via.x + dx, via.y + dy)})`,
				);
			}
		}
	}

	// Combined collect-then-deliver: mark the parcel tile as the pickup waypoint
	// and require it visited before the delivery goal. Empty when single-target.
	const pickupFact = combinedPickup
		? `(is-pickup ${loc(combinedPickup.x, combinedPickup.y)})`
		: "";
	const goal = combinedPickup
		? `(and (picked) (agent-at agent1 ${loc(targetX, targetY)}))`
		: `(agent-at agent1 ${loc(targetX, targetY)})`;

	// Build the problem PDDL
	const problem = `(define (problem deliveroo-${Date.now()})
  (:domain deliveroo-crates)

  (:objects
    agent1 - agent
${Array.from(walkableTiles)
	.map((key) => {
		const tile = map.tiles.get(key)!;
		return `    ${loc(tile.x, tile.y)} - location`;
	})
	.join("\n")}
  )

  (:init
    ;; Agent position
    (agent-at agent1 ${loc(agentX, agentY)})

    ;; Adjacency facts
${adjacencyFacts.join("\n    ")}

    ;; Clear locations (initially)
${clearFacts.join("\n    ")}

    ;; Occupied crate tiles (anonymous crates)
${occupiedFacts.join("\n    ")}

    ;; Crate tiles
${crateTileFacts.join("\n    ")}

    ;; Straight-line push geometry
${pushLineFacts.join("\n    ")}

    ;; Combined collect-then-deliver waypoint
    ${pickupFact}
  )

  (:goal
    ${goal}
  )
)`;

	return problem;
}

/**
 * Call local ENHSP solver (Java-based PDDL planner).
 * Writes domain and problem to temp files, invokes enhsp.jar, parses output.
 *
 * `searchFlags` selects ENHSP's search strategy + heuristic (e.g. "-s WAStar -h
 * hmrp"); empty uses ENHSP's default (WA* + AIBR), which is fine for single-goal
 * problems. `timeoutMs` bounds the blocking solve — keep it under the game socket's
 * ping timeout so a hard solve can't stall long enough to drop the connection.
 */
function callENHSP(
	problemPDDL: string,
	domainPDDL: string,
	searchFlags = "",
	timeoutMs = 30000,
): PlannerResponse {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const enhspJar = join(__dirname, "../../bin/enhsp.jar");

	let tempDir: string | null = null;
	try {
		// Create temporary directory for domain and problem files
		tempDir = mkdtempSync(join(tmpdir(), "pddl-"));
		const domainFile = join(tempDir, "domain.pddl");
		const problemFile = join(tempDir, "problem.pddl");
		const planFile = join(tempDir, "plan.txt");

		// Write domain and problem to files
		writeFileSync(domainFile, domainPDDL);
		writeFileSync(problemFile, problemPDDL);

		log.debug(
			"pddl_plan",
			`temp dir=${tempDir}, domain size=${domainPDDL.length}, problem size=${problemPDDL.length}`,
		);

		// Execute ENHSP with timeout. Command:
		//   java -jar enhsp.jar -o domain.pddl -f problem.pddl -sp plan.txt [searchFlags]
		const flagSuffix = searchFlags ? ` ${searchFlags}` : "";
		const startTime = Date.now();
		let output = "";
		let errorOutput = "";
		try {
			output = execSync(
				`java -jar "${enhspJar}" -o "${domainFile}" -f "${problemFile}" -sp "${planFile}"${flagSuffix}`,
				{
					encoding: "utf-8",
					maxBuffer: 10 * 1024 * 1024,
					timeout: timeoutMs,
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
		} catch (execErr) {
			const e = execErr as {
				stdout?: { toString(): string };
				stderr?: { toString(): string };
			};
			output = e.stdout ? e.stdout.toString() : "";
			errorOutput = e.stderr ? e.stderr.toString() : "";

			log.debug(
				"pddl_plan",
				`ENHSP exit: stdout=${output.slice(0, 150)} stderr=${errorOutput.slice(0, 150)}`,
			);

			if (
				execErr instanceof Error &&
				execErr.message.includes("ETIMEDOUT")
			) {
				return {
					status: "timeout",
					error: `ENHSP exceeded ${timeoutMs}ms timeout`,
					plan: undefined,
					planning_time: undefined,
				};
			}
		}

		const planningTime = Date.now() - startTime;

		// ENHSP writes the plan to the -sp file on success AND echoes it on stdout
		// under a "Found Plan:" section. Prefer the file, but fall back to stdout:
		// on Windows the plan file is occasionally missing/unflushed even though the
		// solver succeeded, and we must not let that masquerade as a failure (or,
		// worse, a bogus "solved" with an empty plan).
		let plan: PlanStep[] | null = null;
		try {
			plan = parseENHSPPlan(readFileSync(planFile, "utf-8"));
		} catch (readErr) {
			log.debug(
				"pddl_plan",
				`plan file unavailable (${readErr instanceof Error ? readErr.message : "unknown"}); parsing stdout`,
			);
		}
		if (!plan || plan.length === 0) {
			plan = parsePlanFromStdout(output);
		}

		if (plan && plan.length > 0) {
			log.debug(
				"pddl_plan",
				`parsed ${plan.length} actions: ${JSON.stringify(plan)}`,
			);
			return {
				status: "solved",
				plan,
				error: undefined,
				planning_time: planningTime,
			};
		}

		// No plan recoverable from file or stdout. Distinguish a broken setup from a
		// genuinely unsolvable instance.
		if (
			errorOutput.includes("no such file") ||
			errorOutput.includes("JAR") ||
			errorOutput.includes("NoClassDefFound") ||
			errorOutput.includes("ClassNotFound")
		) {
			return {
				status: "error",
				error: "enhsp.jar not found. Run `npm run setup:planner` for setup instructions.",
				plan: undefined,
				planning_time: planningTime,
			};
		}

		log.debug(
			"pddl_plan",
			`no plan recovered; stdout tail=${output.slice(-200)}`,
		);
		return {
			status: "unsolvable",
			error: "ENHSP produced no plan",
			plan: undefined,
			planning_time: planningTime,
		};
	} catch (err) {
		return {
			status: "error",
			error: err instanceof Error ? err.message : "Unknown error",
			plan: undefined,
			planning_time: undefined,
		};
	} finally {
		// Clean up temp directory
		if (tempDir) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

// Parses one plan step from either the -sp file or stdout's timed "0.0: (action ...)" form.
// Returns null for non-action lines (banners/stats contain parens but fail the regex).
function parsePlanStep(line: string): PlanStep | null {
	const m = line
		.trim()
		.match(
			/^(?:\d+(?:\.\d+)?:\s*)?\(?([a-z][a-z0-9-]*)((?:\s+[^\s()]+)*)\)?$/i,
		);
	if (!m || !m[1]) return null;
	return {
		action: m[1],
		parameters: m[2]!.trim().split(/\s+/).filter(Boolean),
	};
}

/** Parse ENHSP's -sp plan file (one step per line). */
function parseENHSPPlan(planContent: string): PlanStep[] | null {
	const plan: PlanStep[] = [];
	for (const line of planContent.split("\n")) {
		if (line.trim().startsWith(";")) continue;
		const step = parsePlanStep(line);
		if (step) plan.push(step);
	}
	return plan.length > 0 ? plan : null;
}

/**
 * Recover a plan from ENHSP's stdout (used when the -sp plan file is missing).
 * ENHSP echoes the plan under a "Found Plan:" header, one timed step per line.
 * We only read lines inside that section, stopping at the first blank/non-step
 * line, so banner/stats lines are never mistaken for actions.
 */
function parsePlanFromStdout(stdout: string): PlanStep[] | null {
	const idx = stdout.indexOf("Found Plan:");
	if (idx === -1) return null;

	const plan: PlanStep[] = [];
	for (const line of stdout.slice(idx).split("\n").slice(1)) {
		if (!line.trim()) {
			if (plan.length > 0) break;
			continue;
		}
		const step = parsePlanStep(line);
		if (!step) break; // first non-step line ends the section
		plan.push(step);
	}
	return plan.length > 0 ? plan : null;
}

// Both move-empty (?a ?from ?to) and push-crate (?a ?from ?via ?to) advance the agent
// from params[1] to params[2], so direction extraction is identical for both actions.
function convertPDDLPlanToPath(plan: PlanStep[]): Direction[] {
	const path: Direction[] = [];

	for (const { action, parameters } of plan) {
		if (action !== "move-empty" && action !== "push-crate") continue;
		const [, from, to] = parameters;
		if (!from || !to) continue;
		const dir = extractDirectionFromLocations(from, to);
		if (dir) path.push(dir);
	}

	return path;
}

/** Parse a "loc_x_y" object name back to coordinates. */
function parseLoc(name: string | undefined): { x: number; y: number } | null {
	const m = name?.match(/loc_(-?\d+)_(-?\d+)/);
	return m && m[1] && m[2]
		? { x: parseInt(m[1], 10), y: parseInt(m[2], 10) }
		: null;
}

function extractDirectionFromLocations(
	fromLoc: string,
	toLoc: string,
): Direction | null {
	const from = parseLoc(fromLoc);
	const to = parseLoc(toLoc);
	return from && to ? directionOf(from.x, from.y, to.x, to.y) : null;
}

/**
 * Load domain PDDL from external file.
 * Falls back to embedded domain if file not found.
 */
function loadDomainPDDLFromFile(): string {
	try {
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);
		const domainPath = join(__dirname, "domain.pddl");
		return readFileSync(domainPath, "utf-8");
	} catch (err) {
		log.warn(
			"pddl_plan",
			`Failed to load domain.pddl from file: ${err instanceof Error ? err.message : String(err)}. Using embedded domain.`,
		);
		return getEmbeddedDomain();
	}
}

/**
 * Embedded fallback domain, used only if src/domain.pddl can't be read.
 * KEEP IN SYNC with src/domain.pddl — they must stay byte-for-byte equivalent.
 */
function getEmbeddedDomain(): string {
	return `(define (domain deliveroo-crates)
  (:requirements :typing)

  (:types
    location - object
    agent - object
  )

  (:predicates
    ;; Navigation
    (adjacent ?from ?to - location)
    (clear ?loc - location)
    (agent-at ?a - agent ?loc - location)

    ;; Crates are anonymous: we only track whether a tile currently holds a
    ;; crate, never which crate. The goal is purely (agent-at ...), so crate
    ;; identity is irrelevant — dropping it removes the ?crate action parameter
    ;; and keeps grounding tractable on dense maps.
    (occupied ?loc - location)
    (on-crate-tile ?loc - location)

    ;; Straight-line push geometry: agent at ?from pushes a crate at ?via
    ;; onto ?to, where ?from -> ?via -> ?to are collinear and consecutive.
    (push-line ?from ?via ?to - location)

    ;; Combined collect-then-deliver. When the problem sets (is-pickup ?loc) and
    ;; goals on (picked), the plan must reach the parcel tile (setting (picked))
    ;; before ending on the delivery tile — one plan whose crate pushes are
    ;; consistent across both legs, so reaching the parcel can't seal off the
    ;; delivery route. With no (is-pickup) fact this is inert and planning reduces
    ;; to the plain (agent-at ...) goal.
    (is-pickup ?loc - location)
    (picked)
  )

  (:action move-empty
    :parameters (?a - agent ?from ?to - location)
    :precondition (and
      (agent-at ?a ?from)
      (adjacent ?from ?to)
      (clear ?to)
    )
    :effect (and
      (not (agent-at ?a ?from))
      (agent-at ?a ?to)
    )
  )

  (:action push-crate
    :parameters (
      ?a - agent
      ?from ?via ?to - location
    )
    :precondition (and
      (agent-at ?a ?from)
      (occupied ?via)
      (push-line ?from ?via ?to)
      (on-crate-tile ?to)
      (clear ?to)
    )
    :effect (and
      (not (agent-at ?a ?from))
      (agent-at ?a ?via)
      (not (occupied ?via))
      (clear ?via)
      (occupied ?to)
      (not (clear ?to))
    )
  )

  (:action pickup-here
    :parameters (?a - agent ?loc - location)
    :precondition (and
      (agent-at ?a ?loc)
      (is-pickup ?loc)
    )
    :effect (picked)
  )
)`;
}

// ENHSP timeouts, both kept under the game socket's ~20s ping window so a blocking
// solve can't stall long enough to drop the connection.
const COMBINED_TIMEOUT_MS = 15000; // collect-then-deliver (WA*+hmrp): ~1.5–6s typical
const SINGLE_TIMEOUT_MS = 6000; // single goal: solves <1s; cap bounds unsat proofs

/**
 * Main entry point: attempt PDDL planning when BFS fails.
 * Returns planned path as Direction array, or null if planning failed.
 */
export async function planWithCrates(
	map: StaticMap,
	beliefs: BeliefStore,
	agentX: number,
	agentY: number,
	targetX: number,
	targetY: number,
	pickup?: { x: number; y: number },
): Promise<Direction[] | null> {
	log.debug(
		"pddl_plan",
		`attempting PDDL planning: agent=(${agentX},${agentY})${pickup ? ` → pickup=(${pickup.x},${pickup.y})` : ""} → target=(${targetX},${targetY})`,
	);

	try {
		const domainPDDL = loadDomainPDDLFromFile();

		if (pickup) {
			// Collect-then-deliver as ONE combined PDDL goal: visit the parcel tile
			// (setting (picked)) AND end on the delivery tile. Planning both legs in
			// a single problem is what stops the route to the parcel from sealing off
			// the delivery — two independent legs can't see each other and routinely
			// self-block. ENHSP's default/greedy configs blow up on this combined
			// goal (30s+), but WA* with the hmrp relaxed-plan heuristic solves it
			// (typically ~1.5–6s). The capped timeout keeps this blocking solve under
			// the game socket's ping window so it can't drop the connection.
			const problemPDDL = generateProblemPDDL(
				map,
				beliefs,
				agentX,
				agentY,
				targetX,
				targetY,
				pickup,
			);
			const result = callENHSP(
				problemPDDL,
				domainPDDL,
				"-s WAStar -h hmrp",
				COMBINED_TIMEOUT_MS,
			);
			if (
				result.status === "solved" &&
				result.plan &&
				result.plan.length > 0
			) {
				const path = convertPDDLPlanToPath(result.plan);
				log.ok(
					"pddl_plan",
					`collect-then-deliver solved in ${result.planning_time ?? "?"}ms, steps=${path.length}`,
				);
				return path;
			}
			log.warn(
				"pddl_plan",
				`collect-then-deliver unsolved: status=${result.status} error=${result.error}`,
			);
			return null;
		}

		// Single goal (e.g. already carrying, push straight to a delivery tile). The
		// short timeout means an unsatisfiable goal (delivery truly sealed) bails
		// quickly instead of freezing on an exhaustive unsat proof.
		const problemPDDL = generateProblemPDDL(
			map,
			beliefs,
			agentX,
			agentY,
			targetX,
			targetY,
		);
		const result = callENHSP(
			problemPDDL,
			domainPDDL,
			"",
			SINGLE_TIMEOUT_MS,
		);

		if (
			result.status === "solved" &&
			result.plan &&
			result.plan.length > 0
		) {
			const path = convertPDDLPlanToPath(result.plan);
			log.ok(
				"pddl_plan",
				`solved in ${result.planning_time ?? "?"}ms, plan length=${path.length}, directions=${path.join(",")}`,
			);
			return path;
		}

		log.warn(
			"pddl_plan",
			`planning failed: status=${result.status} error=${result.error}`,
		);
		return null;
	} catch (err) {
		log.error(
			"pddl_plan",
			`unexpected error: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}
