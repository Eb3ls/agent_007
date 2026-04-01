// ============================================================
// src/planning/plan-validator.ts — Plan Validator (T14)
// Checks a Plan against current beliefs before execution.
// ============================================================

import type { ActionType, IBeliefStore, Plan, PlanStep, Position } from '../types.js';

export interface ValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Validates a Plan against the current belief state.
 *
 * Checks (in order):
 *   1. All pickup positions have a non-carried parcel in beliefs.
 *   2. The first move step originates from the agent's current position.
 *   3. Every move step lands on a walkable tile.
 *   4. Every pickup step is at the agent's current position.
 *   5. Every putdown step is at a delivery zone.
 */
export class PlanValidator {
  validate(plan: Plan, beliefs: IBeliefStore): ValidationResult {
    const self    = beliefs.getSelf();
    const map     = beliefs.getMap();

    // Delivery-zone lookup: "x,y" → true
    const deliveryKeys = new Set(map.getDeliveryZones().map(z => key(z)));

    // Parcel lookup by position (non-carried parcels only)
    const parcelAtPos = new Map<string, string>(); // "x,y" → parcel id
    for (const p of beliefs.getParcelBeliefs()) {
      if (p.carriedBy === null) parcelAtPos.set(key(p.position), p.id);
    }

    // --- Pre-check (1): every pickup position has a live parcel ---
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      if (step.action !== 'pickup') continue;
      const k = key(step.expectedPosition);
      if (!parcelAtPos.has(k)) {
        return {
          valid: false,
          reason: `target parcel at (${step.expectedPosition.x},${step.expectedPosition.y}) no longer exists`,
        };
      }
    }

    // --- Sequential step checks ---
    let pos: Position = self.position;

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!;
      const dest = step.expectedPosition;

      if (isMoveStep(step)) {
        // Check (2)/(3): exact starting position (Bug 4 fix) + walkable destination.
        // Infer the expected "from" position from the action direction so we catch the
        // case where the agent moved to an adjacent-but-wrong tile since plan generation.
        const expectedFrom = impliedFrom(step.action as ActionType, dest);
        if (expectedFrom === null || expectedFrom.x !== pos.x || expectedFrom.y !== pos.y) {
          const reason = i === 0
            ? 'plan starts from wrong position'
            : `step ${i} starts from wrong position`;
          return { valid: false, reason };
        }
        if (!map.isWalkable(dest.x, dest.y)) {
          return { valid: false, reason: `step ${i} moves to non-walkable tile (${dest.x},${dest.y})` };
        }
        pos = dest;

      } else if (step.action === 'pickup') {
        // Check (4): agent must be at the parcel
        if (pos.x !== dest.x || pos.y !== dest.y) {
          return { valid: false, reason: `step ${i}: pickup at wrong position` };
        }
        // (parcel existence already verified in pre-check)

      } else if (step.action === 'putdown') {
        // Check (4′): agent must be at dest  (5): must be a delivery zone
        if (pos.x !== dest.x || pos.y !== dest.y) {
          return { valid: false, reason: `step ${i}: putdown at wrong position` };
        }
        if (!deliveryKeys.has(key(dest))) {
          return { valid: false, reason: `step ${i}: putdown at non-delivery-zone (${dest.x},${dest.y})` };
        }
      }
    }

    return { valid: true };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function key(pos: Position): string {
  return `${pos.x},${pos.y}`;
}

function isMoveStep(step: PlanStep): boolean {
  return (
    step.action === 'move_up' ||
    step.action === 'move_down' ||
    step.action === 'move_left' ||
    step.action === 'move_right'
  );
}

/**
 * Given a move action and its destination, return the position the agent
 * must be at BEFORE executing the action (R09 axis convention).
 * Returns null for non-move actions (should not happen if called on a move step).
 */
function impliedFrom(action: ActionType, dest: Position): Position | null {
  switch (action) {
    case 'move_up':    return { x: dest.x, y: dest.y - 1 }; // R09: up = y+1 → from y-1
    case 'move_down':  return { x: dest.x, y: dest.y + 1 }; // R09: down = y-1 → from y+1
    case 'move_left':  return { x: dest.x + 1, y: dest.y }; // R09: left = x-1 → from x+1
    case 'move_right': return { x: dest.x - 1, y: dest.y }; // R09: right = x+1 → from x-1
    default:           return null;
  }
}
