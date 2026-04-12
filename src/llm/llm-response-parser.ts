// ============================================================
// src/llm/llm-response-parser.ts — LLM response → Plan (T22)
//
// parsePlan(response, startPosition): Plan | null
//   Primary:  extract JSON block { steps: [...] }
//   Fallback: regex extraction of action keywords from natural language
// ============================================================

import { randomUUID } from 'crypto';
import type { ActionType, Plan, PlanStep, Position } from '../types.js';
// ---------------------------------------------------------------------------
// LLM step shape (as produced by the system prompt)
// ---------------------------------------------------------------------------

interface LlmStep {
  action: string;
  direction?: string;
  to?: string;
  content?: string;
}

interface LlmPlanJson {
  steps: LlmStep[];
}

// ---------------------------------------------------------------------------
// Position tracing
// ---------------------------------------------------------------------------

function applyAction(pos: Position, action: ActionType): Position {
  switch (action) {
    case 'move_up':    return { x: pos.x,     y: pos.y + 1 };
    case 'move_down':  return { x: pos.x,     y: pos.y - 1 };
    case 'move_right': return { x: pos.x + 1, y: pos.y     };
    case 'move_left':  return { x: pos.x - 1, y: pos.y     };
    case 'pickup':
    case 'putdown':    return pos;
  }
}

// ---------------------------------------------------------------------------
// LlmStep → ActionType
// ---------------------------------------------------------------------------

function stepToActionType(step: LlmStep): ActionType | null {
  switch (step.action) {
    case 'move': {
      switch (step.direction) {
        case 'up':    return 'move_up';
        case 'down':  return 'move_down';
        case 'left':  return 'move_left';
        case 'right': return 'move_right';
        default:      return null;
      }
    }
    case 'pickup':       return 'pickup';
    case 'putdown':      return 'putdown';
    case 'send_message': return null; // not a movement/game action
    default:             return null;
  }
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Try to extract a JSON object that contains a `steps` array from `text`.
 * Looks for the outermost {...} block and validates shape.
 */
function extractJsonPlan(text: string): LlmPlanJson | null {
  // Attempt 1: entire text is JSON
  try {
    const obj = JSON.parse(text) as unknown;
    if (isLlmPlanJson(obj)) return obj;
  } catch {
    // ignore
  }

  // Attempt 2: find the first complete {...} block in the text
  const start = text.indexOf('{');
  if (start === -1) return null;

  // Walk forward tracking brace depth to find the matching close
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const obj = JSON.parse(candidate) as unknown;
          if (isLlmPlanJson(obj)) return obj;
        } catch {
          // not valid JSON — keep scanning
        }
        // try again from next '{'
        const next = text.indexOf('{', i + 1);
        if (next === -1) break;
        // restart outer loop
        return extractJsonPlanFrom(text, next);
      }
    }
  }
  return null;
}

function extractJsonPlanFrom(text: string, startIndex: number): LlmPlanJson | null {
  let depth = 0;
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(startIndex, i + 1);
        try {
          const obj = JSON.parse(candidate) as unknown;
          if (isLlmPlanJson(obj)) return obj;
        } catch {
          // ignore
        }
        break;
      }
    }
  }
  return null;
}

function isLlmPlanJson(obj: unknown): obj is LlmPlanJson {
  if (typeof obj !== 'object' || obj === null) return false;
  const candidate = obj as Record<string, unknown>;
  return Array.isArray(candidate['steps']);
}

// ---------------------------------------------------------------------------
// Natural language keyword extraction (fallback)
// ---------------------------------------------------------------------------

const NL_PATTERNS: Array<[RegExp, ActionType]> = [
  [/\bmove[\s_-]?up\b|\bnorth\b/i,    'move_up'],
  [/\bmove[\s_-]?down\b|\bsouth\b/i,  'move_down'],
  [/\bmove[\s_-]?left\b|\bwest\b/i,   'move_left'],
  [/\bmove[\s_-]?right\b|\beast\b/i,  'move_right'],
  [/\bpick[\s_-]?up\b|\bgrab\b/i,     'pickup'],
  [/\bput[\s_-]?down\b|\bdeliver\b|\bdrop\b/i, 'putdown'],
];

/**
 * Scan `text` left-to-right for action keywords and return them in order.
 * Returns null if no actions are found.
 */
function extractNaturalLanguageActions(text: string): ActionType[] | null {
  // Collect all matches with their position in the text
  const matches: Array<{ pos: number; action: ActionType }> = [];

  for (const [pattern, action] of NL_PATTERNS) {
    // Need global flag to find all occurrences
    const re = new RegExp(pattern.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push({ pos: m.index, action });
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => a.pos - b.pos);
  return matches.map(m => m.action);
}

// ---------------------------------------------------------------------------
// Plan assembly
// ---------------------------------------------------------------------------

function buildPlanFromActions(actions: ActionType[], startPosition: Position): Plan {
  const steps: PlanStep[] = [];
  let pos = startPosition;

  for (const action of actions) {
    const next = applyAction(pos, action);
    steps.push({ action, expectedPosition: next });
    pos = next;
  }

  return {
    id:              randomUUID(),
    intentionId:     '',
    steps,
    estimatedReward: 0,
    createdAt:       Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class LlmResponseParser {
  /**
   * Attempts to extract a Plan from an LLM response string.
   *
   * @param response      Raw text returned by the LLM.
   * @param startPosition Agent's current position (used to compute expectedPosition for each step).
   * @returns A Plan, or null if the response cannot be parsed.
   */
  parsePlan(response: string, startPosition: Position): Plan | null {
    // --- Primary: JSON extraction ---
    const jsonPlan = extractJsonPlan(response);
    if (jsonPlan) {
      const actions: ActionType[] = [];
      for (const step of jsonPlan.steps) {
        const action = stepToActionType(step);
        if (action !== null) {
          actions.push(action);
        }
        // send_message steps are silently skipped (not executable by ActionExecutor)
      }

      if (actions.length > 0) {
        return buildPlanFromActions(actions, startPosition);
      }
    }

    // --- Fallback: natural language regex ---
    const nlActions = extractNaturalLanguageActions(response);
    if (nlActions && nlActions.length > 0) {
      return buildPlanFromActions(nlActions, startPosition);
    }

    return null;
  }
}
