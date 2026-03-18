// ============================================================
// src/execution/action-types.ts — Action helpers (T10)
// Maps ActionType to GameClient method calls.
// ============================================================

import type { ActionType, Direction } from '../types.js';

/** Maps move action types to their Direction. Returns null for non-move actions. */
export function actionToDirection(action: ActionType): Direction | null {
  switch (action) {
    case 'move_up':    return 'up';
    case 'move_down':  return 'down';
    case 'move_left':  return 'left';
    case 'move_right': return 'right';
    default:           return null;
  }
}

/** Returns true if the action is a move action. */
export function isMoveAction(action: ActionType): boolean {
  return actionToDirection(action) !== null;
}
