// ============================================================
// src/planning/pddl-planner.ts — PDDL Planner via @unitn-asa/pddl-client (T18)
//
// Implements IPlanner using the online PDDL solver (dual-bfws-ffparser).
// Builds a STRIPS domain for the Deliveroo grid world and generates a problem
// from each PlanningRequest. Falls back to { success: false } on solver
// timeout or error so the agent can fall back to BFS.
//
// Solver endpoint: PAAS_HOST / PAAS_PATH env vars (see pddl-client defaults).
// ============================================================

import { randomUUID } from 'crypto';
import { onlineSolver } from '@unitn-asa/pddl-client';
import type {
  ActionType,
  IPlanner,
  Plan,
  PlanStep,
  PlanningRequest,
  PlanningResult,
  Position,
} from '../types.js';

// ---------------------------------------------------------------------------
// Static PDDL domain — Deliveroo grid-world in STRIPS
// ---------------------------------------------------------------------------

const DOMAIN_PDDL = `\
(define (domain deliveroo)
    (:requirements :strips)
    (:predicates
        (at-pos ?t)
        (adj ?t1 ?t2)
        (walkable ?t)
        (parcel-at ?p ?t)
        (delivery ?t)
        (carrying ?p)
        (delivered ?p)
    )
    (:action move
        :parameters (?from ?to)
        :precondition (and (at-pos ?from) (adj ?from ?to) (walkable ?to))
        :effect (and (at-pos ?to) (not (at-pos ?from)))
    )
    (:action pickup
        :parameters (?p ?t)
        :precondition (and (at-pos ?t) (parcel-at ?p ?t))
        :effect (and (carrying ?p) (not (parcel-at ?p ?t)))
    )
    (:action putdown
        :parameters (?p ?t)
        :precondition (and (at-pos ?t) (carrying ?p) (delivery ?t))
        :effect (and (delivered ?p) (not (carrying ?p)))
    )
)`;

// ---------------------------------------------------------------------------
// Name helpers
// ---------------------------------------------------------------------------

/** PDDL identifier for a grid tile: t-X-Y (e.g. t-3-4). */
function tileName(pos: Position): string {
  return `t-${pos.x}-${pos.y}`;
}

/** Parse a tile name back to a Position. */
function parseTile(name: string): Position {
  const parts = name.split('-'); // ['t', 'X', 'Y']
  return { x: parseInt(parts[1]!, 10), y: parseInt(parts[2]!, 10) };
}

/** PDDL identifier for a parcel: p- + sanitized id. */
function parcelName(id: string): string {
  return `p-${id.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

// ---------------------------------------------------------------------------
// Problem builder
// ---------------------------------------------------------------------------

function buildProblem(request: PlanningRequest): string {
  const { currentPosition, carriedParcels, targetParcels, deliveryZones, beliefMap, constraints } =
    request;

  // R05/Pattern-2: build obstacle set from avoidPositions (known agent positions).
  // Tiles occupied by other agents are excluded from the PDDL walkable set so the
  // solver never generates a path through them.
  const obstacleKeys = new Set<string>();
  for (const obs of constraints?.avoidPositions ?? []) {
    obstacleKeys.add(`${obs.x},${obs.y}`);
  }

  // Collect walkable tiles, excluding agent-occupied ones
  const walkable: Position[] = [];
  for (let x = 0; x < beliefMap.width; x++) {
    for (let y = 0; y < beliefMap.height; y++) {
      if (beliefMap.isWalkable(x, y) && !obstacleKeys.has(`${x},${y}`)) {
        walkable.push({ x, y });
      }
    }
  }

  const allParcels = [...targetParcels, ...carriedParcels];

  // PDDL objects: all tile names + all parcel names
  const tileNames   = walkable.map(tileName);
  const parcelNames = allParcels.map(p => parcelName(p.id));
  const objects     = [...tileNames, ...parcelNames].join(' ');

  // Init facts
  const inits: string[] = [];

  inits.push(`(at-pos ${tileName(currentPosition)})`);

  for (const t of walkable) {
    inits.push(`(walkable ${tileName(t)})`);
  }

  // 4-connected adjacency — generate for every walkable tile's walkable neighbours
  const deltas: Position[] = [
    { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  ];
  for (const t of walkable) {
    for (const d of deltas) {
      const nx = t.x + d.x;
      const ny = t.y + d.y;
      if (beliefMap.isWalkable(nx, ny)) {
        inits.push(`(adj ${tileName(t)} ${tileName({ x: nx, y: ny })})`);
      }
    }
  }

  for (const dz of deliveryZones) {
    inits.push(`(delivery ${tileName(dz)})`);
  }

  for (const p of targetParcels) {
    inits.push(`(parcel-at ${parcelName(p.id)} ${tileName(p.position)})`);
  }

  // Parcels already carried by the agent start as (carrying ?)
  for (const p of carriedParcels) {
    inits.push(`(carrying ${parcelName(p.id)})`);
  }

  // Goal: every parcel (target + carried) must be delivered
  const goalFacts = allParcels.map(p => `(delivered ${parcelName(p.id)})`);
  const goalStr =
    goalFacts.length === 1
      ? goalFacts[0]!
      : `(and ${goalFacts.join(' ')})`;

  return `\
(define (problem deliveroo-p)
    (:domain deliveroo)
    (:objects ${objects})
    (:init ${inits.join(' ')})
    (:goal ${goalStr})
)`;
}

// ---------------------------------------------------------------------------
// Plan step parser
// ---------------------------------------------------------------------------

/**
 * Convert a single pddlPlanStep (action name + args array) to a PlanStep.
 * Returns null if the action is unrecognised.
 *
 * move   args: [fromTile, toTile]
 * pickup args: [parcelId, tile]
 * putdown args: [parcelId, tile]
 */
function toPlanStep(action: string, args: string[]): PlanStep | null {
  switch (action) {
    case 'move': {
      const from = parseTile(args[0]!);
      const to   = parseTile(args[1]!);
      const dx   = to.x - from.x;
      const dy   = to.y - from.y;
      let a: ActionType;
      if      (dx ===  1) a = 'move_right';
      else if (dx === -1) a = 'move_left';
      else if (dy ===  1) a = 'move_up';
      else if (dy === -1) a = 'move_down';
      else return null; // diagonal or zero — should never happen
      return { action: a, expectedPosition: to };
    }
    case 'pickup':
      return { action: 'pickup',  expectedPosition: parseTile(args[1]!) };
    case 'putdown':
      return { action: 'putdown', expectedPosition: parseTile(args[1]!) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// PddlPlanner
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

export class PddlPlanner implements IPlanner {
  readonly name = 'pddl';

  private _aborted = false;

  abort(): void {
    this._aborted = true;
  }

  async plan(request: PlanningRequest): Promise<PlanningResult> {
    const startTime = Date.now();

    const fail = (error: string): PlanningResult => {
      this._aborted = false;
      return {
        success: false,
        plan: null,
        metadata: {
          plannerName:    this.name,
          computeTimeMs:  Date.now() - startTime,
          stepsGenerated: 0,
        },
        error,
      };
    };

    if (this._aborted) return fail('Aborted');

    const allParcels = [...request.targetParcels, ...request.carriedParcels];
    if (allParcels.length === 0) return fail('No parcels to deliver');

    const problemStr = buildProblem(request);
    const timeoutMs  = request.constraints?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Race the solver against a hard timeout
    let rawPlan: Array<{ parallel: boolean; action: string; args: string[] }>;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
        timeoutHandle.unref?.();
      });
      rawPlan = await Promise.race([onlineSolver(DOMAIN_PDDL, problemStr), timeoutPromise]);
    } catch (err) {
      return fail(`PDDL solver error: ${(err as Error).message}`);
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }

    if (this._aborted) return fail('Aborted');

    if (!rawPlan || rawPlan.length === 0) return fail('Solver returned empty plan');

    // Convert pddlPlanStep[] → PlanStep[]
    const steps: PlanStep[] = [];
    for (const raw of rawPlan) {
      const step = toPlanStep(raw.action, raw.args);
      if (!step) {
        return fail(`Unrecognised plan step: ${raw.action} ${raw.args.join(' ')}`);
      }
      steps.push(step);
    }

    const maxLen = request.constraints?.maxPlanLength;
    if (maxLen !== undefined && steps.length > maxLen) {
      return fail(`Plan length ${steps.length} exceeds maxPlanLength ${maxLen}`);
    }

    const estimatedReward = allParcels.reduce((sum, p) => sum + p.estimatedReward, 0);

    const plan: Plan = {
      id:              randomUUID(),
      intentionId:     '',
      steps,
      estimatedReward,
      createdAt:       Date.now(),
    };

    this._aborted = false;
    return {
      success: true,
      plan,
      metadata: {
        plannerName:    this.name,
        computeTimeMs:  Date.now() - startTime,
        stepsGenerated: steps.length,
      },
    };
  }
}
