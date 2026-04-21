// ============================================================
// src/planning/planner-factory.ts — Planner chain factory (Arch Decision #4)
// Centralises planner selection so neither BdiAgent nor LlmAgent instantiates
// planners directly. Replaces switch/case scattered in both agent files.
// ============================================================

import type { IBeliefStore, IPlanner, LlmConfig, PlannerChainType } from '../types.js';
import { BfsPlanner } from './bfs-planner.js';
import { PddlPlanner } from './pddl-planner.js';
import { LlmPlanner } from './llm-planner.js';
import { LlmClient } from '../llm/llm-client.js';
import { LlmMemory } from '../llm/llm-memory.js';

/**
 * A FallbackPlanner tries a primary planner and, on failure, delegates to
 * a secondary planner. This composes the chains:
 *   'pddl' → PddlPlanner → BfsPlanner
 *   'llm'  → LlmPlanner  → PddlPlanner → BfsPlanner
 */
class FallbackPlanner implements IPlanner {
  constructor(
    private readonly primary: IPlanner,
    private readonly secondary: IPlanner,
  ) {}

  get name(): string {
    return `${this.primary.name}→${this.secondary.name}`;
  }

  async plan(request: Parameters<IPlanner['plan']>[0]): ReturnType<IPlanner['plan']> {
    const result = await this.primary.plan(request);
    if (result.success) return result;
    return this.secondary.plan(request);
  }

  abort(): void {
    this.primary.abort();
    this.secondary.abort();
  }
}

export interface PlannerFactoryOptions {
  chainType: PlannerChainType;
  llmConfig?: LlmConfig;
  /** Required when chainType === 'llm' (LlmPlanner uses it for prompt context). */
  beliefs?: IBeliefStore;
}

/**
 * Build the IPlanner chain for the given configuration.
 *
 * - 'bfs':  BfsPlanner only
 * - 'pddl': PddlPlanner → BfsPlanner fallback
 * - 'llm':  LlmPlanner  → PddlPlanner → BfsPlanner fallback
 */
export function buildPlannerChain(opts: PlannerFactoryOptions): IPlanner {
  const bfs = new BfsPlanner();

  if (opts.chainType === 'bfs') {
    return bfs;
  }

  const pddl = new PddlPlanner();
  const pddlWithFallback = new FallbackPlanner(pddl, bfs);

  if (opts.chainType === 'pddl') {
    return pddlWithFallback;
  }

  // 'llm': LLM → PDDL → BFS
  if (!opts.llmConfig) {
    throw new Error('llmConfig is required for planner chain type "llm"');
  }
  if (!opts.beliefs) {
    throw new Error('beliefs is required for planner chain type "llm"');
  }
  const llmClient = new LlmClient(opts.llmConfig);
  const llmMemory = new LlmMemory();
  const llm = new LlmPlanner(llmClient, llmMemory, opts.beliefs);

  return new FallbackPlanner(llm, pddlWithFallback);
}
