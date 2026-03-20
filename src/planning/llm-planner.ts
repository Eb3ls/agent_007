// ============================================================
// src/planning/llm-planner.ts — LLM-backed planner (T22)
//
// Implements IPlanner. Builds a prompt from LlmMemory.buildContext(),
// calls LlmClient, parses the response via LlmResponseParser.
// Returns { success: false } on any failure — caller falls back to BFS.
// ============================================================

import { randomUUID } from 'crypto';
import type {
  IBeliefStore,
  IPlanner,
  PlanningRequest,
  PlanningResult,
} from '../types.js';
import { createLogger } from '../logging/logger.js';
import { LlmClient } from '../llm/llm-client.js';
import { LlmMemory } from '../llm/llm-memory.js';
import { LlmResponseParser } from '../llm/llm-response-parser.js';
import { buildCotPrompt } from '../llm/prompt-templates.js';

const logger = createLogger('llm-planner');

export class LlmPlanner implements IPlanner {
  readonly name = 'llm';

  private aborted = false;
  private readonly parser = new LlmResponseParser();

  constructor(
    private readonly client: LlmClient,
    private readonly memory: LlmMemory,
    private readonly beliefs: IBeliefStore,
    private readonly maxTokenBudget: number = 512,
  ) {}

  async plan(request: PlanningRequest): Promise<PlanningResult> {
    const startMs = Date.now();

    if (this.aborted) {
      return this._failure(startMs, 'aborted');
    }

    // Build context from current beliefs
    const context = this.memory.buildContext(this.beliefs);
    const userPrompt = buildCotPrompt({ context });
    const maxTokens = Math.min(this.maxTokenBudget, 4096);

    // Call LLM with system + user messages
    const response = await this.client.complete(
      [
        { role: 'system', content: context.systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      maxTokens,
    );

    if (this.aborted) {
      return this._failure(startMs, 'aborted');
    }

    if (response === null) {
      logger.warn({ kind: 'llm_fallback', reason: 'llm_unavailable' });
      return this._failure(startMs, 'LLM unavailable');
    }

    // Parse response into a Plan
    const plan = this.parser.parsePlan(response, request.currentPosition);

    if (plan === null) {
      logger.warn({ kind: 'llm_fallback', reason: 'parse_failure' });
      return this._failure(startMs, 'parse failure');
    }

    // Stamp the plan with a fresh id (parser produces a random id; keep it)
    const computeTimeMs = Date.now() - startMs;
    logger.info({ kind: 'llm_call', latencyMs: computeTimeMs, tokensUsed: 0 });

    return {
      success:  true,
      plan:     { ...plan, id: randomUUID() },
      metadata: {
        plannerName:    this.name,
        computeTimeMs,
        stepsGenerated: plan.steps.length,
      },
    };
  }

  abort(): void {
    this.aborted = true;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private _failure(startMs: number, error: string): PlanningResult {
    return {
      success:  false,
      plan:     null,
      error,
      metadata: {
        plannerName:    this.name,
        computeTimeMs:  Date.now() - startMs,
        stepsGenerated: 0,
      },
    };
  }
}
