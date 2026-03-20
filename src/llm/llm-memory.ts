// ============================================================
// src/llm/llm-memory.ts — Tiered LLM context window manager (T20)
//
// Budget (tokens):  System 600 | Objective 200 | State 800
//                   History 1200 | SharedBeliefs 600 | Scratch 600 (output)
// Total sent:  ≤ 3400 tokens. Scratch reserved for LLM output.
// Token heuristic: ceil(charLength / 3.5) — conservative for JSON-heavy content.
// Progressive tier dropping: sharedBeliefs → actionHistory → truncate state.
// ============================================================

import type {
  BeliefSnapshot,
  IBeliefStore,
  LlmMemoryContext,
  ParcelBelief,
  Position,
} from '../types.js';
import { manhattanDistance } from '../types.js';
import { getLlmContext } from '../logging/logger.js';
import { TOOL_CATALOG_JSON } from './tool-catalog.js';
import { SYSTEM_PROMPT } from './prompt-templates.js';

// ---------------------------------------------------------------------------
// Token budget constants
// ---------------------------------------------------------------------------

const BUDGET = {
  system:        600,   // system prompt + tool catalog
  objective:     200,
  state:         800,
  history:      1200,
  sharedBeliefs: 600,
} as const;

/** Sum of all input tier budgets; used as the default maxTokenBudget. */
export const TOTAL_INPUT_BUDGET_TOKENS =
  BUDGET.system + BUDGET.objective + BUDGET.state + BUDGET.history + BUDGET.sharedBeliefs;
// = 3400

/** Maximum age of shared beliefs before they are dropped. */
const SHARED_BELIEFS_MAX_AGE_MS = 20_000;

/** How many recent log events to request (trimmed to budget below). */
const HISTORY_FETCH_EVENTS = 60;

// ---------------------------------------------------------------------------
// Token counting
// ---------------------------------------------------------------------------

/** Chars-per-token ratio used throughout. 3.5 is more conservative for JSON-heavy content. */
const CHARS_PER_TOKEN = 3.5;

function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Truncate a JSON-array string to fit within budgetTokens. */
function truncateJsonArray(jsonArrayStr: string, budgetTokens: number): string {
  if (countTokens(jsonArrayStr) <= budgetTokens) return jsonArrayStr;
  try {
    const events: unknown[] = JSON.parse(jsonArrayStr);
    while (events.length > 1 && countTokens(JSON.stringify(events)) > budgetTokens) {
      events.shift(); // drop oldest
    }
    return JSON.stringify(events);
  } catch {
    // Fallback: hard-truncate characters
    return jsonArrayStr.slice(0, Math.floor(budgetTokens * CHARS_PER_TOKEN));
  }
}

/** Hard-truncate any string to fit within budgetTokens. */
function truncate(text: string, budgetTokens: number): string {
  const maxChars = Math.floor(budgetTokens * CHARS_PER_TOKEN);
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// State snapshot builder
// ---------------------------------------------------------------------------

const MAX_PARCELS_IN_STATE = 12;
const MAX_AGENTS_IN_STATE  = 8;
const MAX_DELIVERY_IN_STATE = 4;

function buildStateSnapshot(beliefs: IBeliefStore): string {
  const self = beliefs.getSelf();

  // Carried parcels (compact: id + remaining reward)
  const carrying = self.carriedParcels.map((p: ParcelBelief) => ({
    id: p.id.slice(0, 6),
    r: Math.round(p.estimatedReward),
  }));

  // Nearby parcels sorted by Manhattan distance, capped
  const pos: Position = self.position;
  const parcels = beliefs.getParcelBeliefs()
    .filter(p => p.carriedBy === null)
    .map(p => ({
      p,
      dist: manhattanDistance(pos, p.position),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, MAX_PARCELS_IN_STATE)
    .map(({ p, dist }) => ({
      id: p.id.slice(0, 6),
      x: p.position.x,
      y: p.position.y,
      r: Math.round(p.estimatedReward),
      d: dist,
    }));

  // Nearby agents (sorted by distance)
  const agents = beliefs.getAgentBeliefs()
    .map(a => ({
      a,
      dist: manhattanDistance(pos, a.position),
    }))
    .sort((x, y) => x.dist - y.dist)
    .slice(0, MAX_AGENTS_IN_STATE)
    .map(({ a, dist }) => ({
      id: a.id.slice(0, 6),
      x: a.position.x,
      y: a.position.y,
      ally: a.isAlly ? 1 : 0,
      d: dist,
      ...(a.heading ? { h: a.heading[0] } : {}),
    }));

  // Nearest delivery zones
  const delivery = beliefs.getMap().getDeliveryZones()
    .map(dz => ({
      dz,
      dist: manhattanDistance(pos, dz),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, MAX_DELIVERY_IN_STATE)
    .map(({ dz, dist }) => ({ x: dz.x, y: dz.y, d: dist }));

  const snapshot = {
    pos: { x: pos.x, y: pos.y },
    score: self.score,
    carrying,
    parcels,
    agents,
    delivery,
  };

  return JSON.stringify(snapshot);
}

// ---------------------------------------------------------------------------
// Shared beliefs builder
// ---------------------------------------------------------------------------

function buildSharedBeliefs(
  snapshot: BeliefSnapshot | null,
  timestamp: number,
): string {
  if (!snapshot) return '';
  if (Date.now() - timestamp > SHARED_BELIEFS_MAX_AGE_MS) return '';

  const ageS = Math.round((Date.now() - timestamp) / 1000);
  const parcels = snapshot.parcels.slice(0, 10).map(p => ({
    id: p.id.slice(0, 6),
    x: p.position.x,
    y: p.position.y,
    r: Math.round(p.reward),
  }));
  const agents = snapshot.agents.slice(0, 6).map(a => ({
    id: a.id.slice(0, 6),
    x: a.position.x,
    y: a.position.y,
    ...(a.heading ? { h: a.heading[0] } : {}),
  }));

  return JSON.stringify({
    from: snapshot.agentId.slice(0, 6),
    ageS,
    parcels,
    agents,
  });
}

// ---------------------------------------------------------------------------
// LlmMemory
// ---------------------------------------------------------------------------

export class LlmMemory {
  private objective =
    'Pick up parcels and deliver them to delivery zones to maximise score. ' +
    'Prioritise high-reward parcels that are close to a delivery zone.';

  private sharedBeliefSnapshot: BeliefSnapshot | null = null;
  private sharedBeliefTimestamp = 0;

  /**
   * @param maxTokenBudget - Total input token budget. If totalTokenEstimate
   *   exceeds this, optional tiers are progressively dropped.
   *   Defaults to the sum of all BUDGET tiers (3400).
   */
  constructor(private readonly maxTokenBudget = TOTAL_INPUT_BUDGET_TOKENS) {}

  /** Replace the current high-level objective description. */
  setObjective(text: string): void {
    this.objective = text;
  }

  /** Update the shared beliefs from an ally's belief snapshot. */
  updateSharedBeliefs(snapshot: BeliefSnapshot): void {
    this.sharedBeliefSnapshot = snapshot;
    this.sharedBeliefTimestamp = Date.now();
  }

  /**
   * Assemble all tiers into an LlmMemoryContext.
   * Each tier is capped to its token budget. If the total still exceeds
   * maxTokenBudget, optional tiers are dropped in order:
   *   1. sharedBeliefs  2. actionHistory  3. truncate stateSnapshot further
   */
  buildContext(beliefs: IBeliefStore): LlmMemoryContext {
    // --- System (prompt + tools bundled) ---
    const sysBase = truncate(SYSTEM_PROMPT, BUDGET.system);
    const sysTokens = countTokens(sysBase);
    const toolsRemaining = BUDGET.system - sysTokens;
    const toolCatalog = toolsRemaining > 0
      ? truncate(TOOL_CATALOG_JSON, toolsRemaining)
      : '';
    const systemPrompt = sysBase;

    // --- Objective ---
    const objective = truncate(this.objective, BUDGET.objective);

    // --- State snapshot ---
    let stateSnapshot = truncate(buildStateSnapshot(beliefs), BUDGET.state);

    // --- Action history (from ring buffer, oldest trimmed to budget) ---
    const rawHistory = getLlmContext({
      lastNEvents: HISTORY_FETCH_EVENTS,
      summarizeMovement: true,
    });
    let actionHistory = truncateJsonArray(rawHistory, BUDGET.history);

    // --- Shared beliefs ---
    const rawShared = buildSharedBeliefs(
      this.sharedBeliefSnapshot,
      this.sharedBeliefTimestamp,
    );
    let sharedBeliefs = rawShared
      ? truncate(rawShared, BUDGET.sharedBeliefs)
      : '';

    // --- Progressive tier dropping ---
    // Fixed cost: system + tools + objective (non-droppable)
    const coreTokens =
      countTokens(systemPrompt) +
      countTokens(toolCatalog) +
      countTokens(objective);

    const total = () =>
      coreTokens +
      countTokens(stateSnapshot) +
      countTokens(actionHistory) +
      countTokens(sharedBeliefs);

    if (total() > this.maxTokenBudget) {
      sharedBeliefs = '';                     // tier 1: drop shared beliefs
    }
    if (total() > this.maxTokenBudget) {
      actionHistory = '[]';                   // tier 2: drop action history
    }
    if (total() > this.maxTokenBudget) {
      const remaining = Math.max(0, this.maxTokenBudget - coreTokens);
      stateSnapshot = truncate(stateSnapshot, remaining); // tier 3: truncate state
    }

    const totalTokenEstimate = total();

    return {
      systemPrompt,
      objective,
      stateSnapshot,
      actionHistory,
      sharedBeliefs,
      toolCatalog,
      totalTokenEstimate,
    };
  }
}
