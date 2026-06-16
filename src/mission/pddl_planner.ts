import type { BeliefStore } from "../belief_store.js";
import type { StaticMap } from "../static_map.js";
import type { Direction } from "../pathfinder.js";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { TILE } from "../static_map.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";
import { tmpdir } from "os";

interface PlannerResponse {
	status: "solved" | "unsolvable" | "timeout" | "error";
	plan?: { action: string; parameters: string[] }[] | undefined;
	error?: string | undefined;
	planning_time?: number | undefined;
}

const DELTAS = [
	{ dx: 1, dy: 0 },
	{ dx: -1, dy: 0 },
	{ dx: 0, dy: 1 },
	{ dx: 0, dy: -1 },
] as const;

const loc = (x: number, y: number): string => `loc_${x}_${y}`;
const crateName = (id: string): string =>
	`crate_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;

const isWalkable = (type: string): boolean => type !== TILE.EMPTY;
const isCrateTile = (type: string): boolean =>
	type === TILE.CRATE_SLIDE || type === TILE.CRATE_SLIDE_MOVING;

function directionOf(
	fx: number,
	fy: number,
	tx: number,
	ty: number,
): Direction {
	if (ty > fy) return "up";
	if (ty < fy) return "down";
	if (tx < fx) return "left";
	return "right";
}

function generateProblemPDDL(
	map: StaticMap,
	beliefs: BeliefStore,
	agentX: number,
	agentY: number,
	targetX: number,
	targetY: number,
): string {
	const planningRadius = 20;
	const relevantCrates = new Map<string, { x: number; y: number }>();
	for (const [crateId, crateData] of beliefs.crates) {
		const dist =
			Math.abs(crateData.x - agentX) + Math.abs(crateData.y - agentY);
		if (dist > planningRadius) continue;
		const tileType = map.tiles.get(`${crateData.x},${crateData.y}`)?.type;
		if (tileType && isCrateTile(tileType)) {
			relevantCrates.set(crateId, { x: crateData.x, y: crateData.y });
		}
	}
	const occupied = new Set(
		[...relevantCrates.values()].map((p) => `${p.x},${p.y}`),
	);

	const walkableTiles = new Set<string>();
	const crateTiles = new Set<string>();
	for (const [tileKey, tile] of map.tiles) {
		if (!isWalkable(tile.type)) continue;
		walkableTiles.add(tileKey);
		if (isCrateTile(tile.type)) crateTiles.add(tileKey);
	}

	const adjacencyFacts: string[] = [];
	const clearFacts: string[] = [];
	const crateTileFacts: string[] = [];
	for (const tile of map.tiles.values()) {
		if (!isWalkable(tile.type)) continue;
		const { x, y } = tile;
		for (const { dx, dy } of DELTAS) {
			if (walkableTiles.has(`${x + dx},${y + dy}`)) {
				adjacencyFacts.push(
					`(adjacent ${loc(x, y)} ${loc(x + dx, y + dy)})`,
				);
			}
		}
		if (!occupied.has(`${x},${y}`)) clearFacts.push(`(clear ${loc(x, y)})`);
		if (isCrateTile(tile.type))
			crateTileFacts.push(`(on-crate-tile ${loc(x, y)})`);
	}

	const pushLineFacts: string[] = [];
	for (const viaKey of crateTiles) {
		const via = map.tiles.get(viaKey)!;
		for (const { dx, dy } of DELTAS) {
			const fromKey = `${via.x - dx},${via.y - dy}`;
			const toKey = `${via.x + dx},${via.y + dy}`;
			if (walkableTiles.has(fromKey) && crateTiles.has(toKey)) {
				pushLineFacts.push(
					`(push-line ${loc(via.x - dx, via.y - dy)} ${loc(via.x, via.y)} ${loc(via.x + dx, via.y + dy)})`,
				);
			}
		}
	}

	const crateLocFacts: string[] = [];
	for (const [crateId, pos] of relevantCrates) {
		crateLocFacts.push(
			`(crate-at ${crateName(crateId)} ${loc(pos.x, pos.y)})`,
		);
		crateLocFacts.push(`(pushable ${crateName(crateId)})`);
	}

	return `(define (problem deliveroo-planning)
  (:domain deliveroo-crates)

  (:objects
    agent1 - agent
${Array.from(relevantCrates.keys())
	.map((id) => `    ${crateName(id)} - crate`)
	.join("\n")}
${Array.from(walkableTiles)
	.map((key) => {
		const tile = map.tiles.get(key)!;
		return `    ${loc(tile.x, tile.y)} - location`;
	})
	.join("\n")}
  )

  (:init
    (agent-at agent1 ${loc(agentX, agentY)})
${adjacencyFacts.map((f) => `    ${f}`).join("\n")}
${clearFacts.map((f) => `    ${f}`).join("\n")}
${crateLocFacts.map((f) => `    ${f}`).join("\n")}
${crateTileFacts.map((f) => `    ${f}`).join("\n")}
${pushLineFacts.map((f) => `    ${f}`).join("\n")}
  )

  (:goal
    (agent-at agent1 ${loc(targetX, targetY)})
  )
)`;
}

function callENHSP(problemPDDL: string, domainPDDL: string): PlannerResponse {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const enhspJar = join(__dirname, "../../bin/enhsp.jar");

	let tempDir: string | null = null;
	try {
		tempDir = mkdtempSync(join(tmpdir(), "pddl-"));
		const domainFile = join(tempDir, "domain.pddl");
		const problemFile = join(tempDir, "problem.pddl");
		const planFile = join(tempDir, "plan.txt");

		writeFileSync(domainFile, domainPDDL);
		writeFileSync(problemFile, problemPDDL);

		log.debug(
			"pddl_plan",
			`temp dir=${tempDir}, domain size=${domainPDDL.length}, problem size=${problemPDDL.length}`,
		);

		const startTime = Date.now();
		let output = "";
		let errorOutput = "";
		try {
			output = execSync(
				`java -jar "${enhspJar}" -o "${domainFile}" -f "${problemFile}" -sp "${planFile}"`,
				{
					encoding: "utf-8",
					maxBuffer: 10 * 1024 * 1024,
					timeout: 30000,
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
		} catch (execErr: unknown) {
			const e = execErr as {
				stdout?: unknown;
				stderr?: unknown;
				message?: string;
			};
			output = e.stdout ? String(e.stdout) : "";
			errorOutput = e.stderr ? String(e.stderr) : "";
			log.debug(
				"pddl_plan",
				`ENHSP exit: stdout=${output.slice(0, 150)} stderr=${errorOutput.slice(0, 150)}`,
			);
			if (e.message?.includes("ETIMEDOUT")) {
				return {
					status: "timeout",
					error: "ENHSP exceeded 30s timeout",
				};
			}
		}

		const planningTime = Date.now() - startTime;

		try {
			const planContent = readFileSync(planFile, "utf-8");
			const plan = parseENHSPPlan(planContent);
			if (plan && plan.length > 0) {
				log.debug("pddl_plan", `parsed ${plan.length} actions`);
				return { status: "solved", plan, planning_time: planningTime };
			}
			return {
				status: "unsolvable",
				error: "No valid plan found",
				planning_time: planningTime,
			};
		} catch {
			if (
				output.includes("founded") ||
				output.includes("Plan") ||
				output.includes("Action")
			) {
				return {
					status: "solved",
					plan: [],
					error: "Plan found but not parsed",
					planning_time: planningTime,
				};
			}
			let errorReason = "ENHSP failed to generate plan";
			if (
				errorOutput.includes("no such file") ||
				errorOutput.includes("JAR")
			) {
				errorReason = "enhsp.jar not found";
			} else {
				const m = errorOutput.match(/Error[:\s]+(.*?)(?:\n|$)/);
				if (m?.[1]) errorReason = m[1].trim();
			}
			return {
				status: "error",
				error: errorReason,
				planning_time: planningTime,
			};
		}
	} catch (err) {
		return {
			status: "error",
			error: err instanceof Error ? err.message : "Unknown error",
		};
	} finally {
		if (tempDir) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {
				/* ignore */
			}
		}
	}
}

function parseENHSPPlan(
	planContent: string,
): Array<{ action: string; parameters: string[] }> | null {
	const plan: Array<{ action: string; parameters: string[] }> = [];
	for (const line of planContent.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith(";")) continue;
		let match = trimmed.match(/^\(([a-z-]+)\s+(.*)\)$/i);
		if (!match) match = trimmed.match(/^([a-z-]+)\s+(.*)$/i);
		if (match?.[1]) {
			const action = match[1];
			const parameters = (match[2] ?? "")
				.split(/\s+/)
				.filter((p) => p.length > 0);
			plan.push({ action, parameters });
		}
	}
	return plan.length > 0 ? plan : null;
}

function convertPDDLPlanToPath(
	plan: Array<{ action: string; parameters: string[] }>,
): Direction[] {
	const path: Direction[] = [];
	for (const { action, parameters } of plan) {
		if (action === "move-empty" && parameters.length >= 3) {
			const dir = extractDir(parameters[1]!, parameters[2]!);
			if (dir) path.push(dir);
		} else if (action === "push-crate" && parameters.length >= 5) {
			const dir = extractDir(parameters[2]!, parameters[3]!);
			if (dir) path.push(dir);
		}
	}
	return path;
}

function extractDir(fromLoc: string, toLoc: string): Direction | null {
	const fm = fromLoc.match(/loc_(-?\d+)_(-?\d+)/);
	const tm = toLoc.match(/loc_(-?\d+)_(-?\d+)/);
	if (!fm?.[1] || !fm[2] || !tm?.[1] || !tm[2]) return null;
	return directionOf(
		parseInt(fm[1], 10),
		parseInt(fm[2], 10),
		parseInt(tm[1], 10),
		parseInt(tm[2], 10),
	);
}

function loadDomainPDDLFromFile(): string {
	try {
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);
		return readFileSync(join(__dirname, "domain.pddl"), "utf-8");
	} catch (err) {
		log.warn(
			"pddl_plan",
			`domain.pddl not found (${err instanceof Error ? err.message : String(err)}) — using embedded fallback`,
		);
		return getEmbeddedDomain();
	}
}

function getEmbeddedDomain(): string {
	return `(define (domain deliveroo-crates)
  (:requirements :typing)

  (:types
    location - object
    agent - object
    crate - object
  )

  (:predicates
    (adjacent ?from ?to - location)
    (clear ?loc - location)
    (agent-at ?a - agent ?loc - location)
    (crate-at ?c - crate ?loc - location)
    (pushable ?c - crate)
    (on-crate-tile ?loc - location)
    (push-line ?from ?via ?to - location)
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
      ?crate - crate
      ?from ?via ?to - location
    )
    :precondition (and
      (agent-at ?a ?from)
      (crate-at ?crate ?via)
      (push-line ?from ?via ?to)
      (on-crate-tile ?via)
      (on-crate-tile ?to)
      (pushable ?crate)
      (clear ?to)
    )
    :effect (and
      (not (agent-at ?a ?from))
      (agent-at ?a ?via)
      (not (crate-at ?crate ?via))
      (crate-at ?crate ?to)
      (clear ?via)
      (not (clear ?to))
    )
  )
)`;
}

export async function planWithCrates(
	map: StaticMap,
	beliefs: BeliefStore,
	agentX: number,
	agentY: number,
	targetX: number,
	targetY: number,
): Promise<Direction[] | null> {
	log.debug(
		"pddl_plan",
		`attempting PDDL: agent=(${agentX},${agentY}) → target=(${targetX},${targetY})`,
	);
	try {
		const domainPDDL = loadDomainPDDLFromFile();
		const problemPDDL = generateProblemPDDL(
			map,
			beliefs,
			agentX,
			agentY,
			targetX,
			targetY,
		);
		const result = callENHSP(problemPDDL, domainPDDL);
		if (
			result.status === "solved" &&
			result.plan &&
			result.plan.length > 0
		) {
			const path = convertPDDLPlanToPath(result.plan);
			log.ok(
				"pddl_plan",
				`solved in ${result.planning_time ?? "?"}ms, steps=${path.length}`,
			);
			return path;
		}
		log.warn(
			"pddl_plan",
			`failed: status=${result.status} error=${result.error}`,
		);
		return null;
	} catch (err) {
		log.error(
			"pddl_plan",
			`unexpected: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}
