// ============================================================
// src/agents/llm-agent.ts — LLM Agent (T23)
// Subclass of BaseAgent; selects LLM → PDDL → BFS planner chain.
// ============================================================

import type { AgentRole, IPlanner } from '../types.js';
import { BaseAgent, buildPlannerChain } from './base-agent.js';

export class LlmAgent extends BaseAgent {
  readonly role: AgentRole = 'llm';

  protected buildPlannerChain(): IPlanner {
    // beliefs is guaranteed non-null here: BaseAgent calls buildPlannerChain()
    // inside the onMap callback, after this.beliefs has been assigned.
    return buildPlannerChain({
      chainType: 'llm',
      llmConfig: this.config.llm,
      beliefs:   this.beliefs ?? undefined,
    });
  }
}
