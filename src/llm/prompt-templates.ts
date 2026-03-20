// ============================================================
// src/llm/prompt-templates.ts — Prompt templates for the LLM agent (T20)
// Includes: static system prompt, CoT template, Reflexion template.
// ============================================================

import type { LlmMemoryContext } from '../types.js';

// ---------------------------------------------------------------------------
// System prompt (static — never evicted, target ≤600 tokens / ~2400 chars)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `\
You are an autonomous delivery agent in a discrete 2-D grid world (Deliveroo.js).

WORLD RULES:
- The grid contains walkable tiles, parcel-spawning tiles, and delivery zones.
- Parcels appear on spawning tiles and decay in reward over time; deliver them quickly.
- Move one step at a time (up/down/left/right). Diagonal moves are not allowed.
- Use 'pickup' when standing on a parcel tile to collect it.
- Use 'putdown' ONLY on a delivery zone to score points.
- Other agents may compete for the same parcels; prefer high-reward, nearby targets.
- You may share beliefs with ally agents on the same team.

GOAL: Maximise total score. Prioritise parcels with high reward-to-distance ratio.

OUTPUT FORMAT:
Respond with a JSON object containing a 'steps' array. Each step must be one of:
  {"action":"move","direction":"up"|"down"|"left"|"right"}
  {"action":"pickup"}
  {"action":"putdown"}
  {"action":"send_message","to":"<agentId>","content":"<text>"}

Example response:
{"steps":[{"action":"move","direction":"up"},{"action":"pickup"},{"action":"move","direction":"down"},{"action":"putdown"}]}

Keep plans short (≤20 steps). If uncertain, plan only the next 5 steps.
`;

// ---------------------------------------------------------------------------
// Chain-of-Thought (CoT) prompt builder
// ---------------------------------------------------------------------------

export interface CotInput {
  readonly context: LlmMemoryContext;
}

/**
 * Builds the full user-turn message for a CoT planning call.
 * The LLM is expected to reason step-by-step then emit a JSON plan.
 */
export function buildCotPrompt(input: CotInput): string {
  const { context } = input;
  return [
    `## CURRENT OBJECTIVE\n${context.objective}`,
    `## WORLD STATE\n${context.stateSnapshot}`,
    context.sharedBeliefs
      ? `## ALLY BELIEFS\n${context.sharedBeliefs}`
      : '',
    context.actionHistory
      ? `## RECENT HISTORY\n${context.actionHistory}`
      : '',
    `## AVAILABLE TOOLS\n${context.toolCatalog}`,
    '## TASK\n' +
      'Think step-by-step:\n' +
      '1. What parcels are worth collecting? (reward vs distance)\n' +
      '2. What is the shortest path to collect and deliver them?\n' +
      '3. Are any ally agents handling the same parcels?\n' +
      '\nThen emit your JSON plan.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Reflexion prompt builder
// ---------------------------------------------------------------------------

export interface ReflexionInput {
  readonly context: LlmMemoryContext;
  /** Human-readable description of what happened in the last plan. */
  readonly previousOutcome: string;
}

/**
 * Builds the user-turn message for a Reflexion-style replanning call.
 * Used when a plan failed or completed unexpectedly.
 */
export function buildReflexionPrompt(input: ReflexionInput): string {
  const { context, previousOutcome } = input;
  return [
    `## PREVIOUS OUTCOME\n${previousOutcome}`,
    `## CURRENT OBJECTIVE\n${context.objective}`,
    `## WORLD STATE\n${context.stateSnapshot}`,
    context.sharedBeliefs
      ? `## ALLY BELIEFS\n${context.sharedBeliefs}`
      : '',
    context.actionHistory
      ? `## RECENT HISTORY\n${context.actionHistory}`
      : '',
    `## AVAILABLE TOOLS\n${context.toolCatalog}`,
    '## TASK\n' +
      'Reflect on what went wrong, then produce a corrected JSON plan:\n' +
      '1. Why did the previous plan fail or end early?\n' +
      '2. What should you do differently?\n' +
      '3. Emit a new JSON plan.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
