// ============================================================
// src/agents/bdi-agent.ts — BDI Agent (T15)
// Subclass of BaseAgent; selects BFS or PDDL planner chain via config.
// ============================================================

import type { AgentRole, IPlanner } from '../types.js';
import { BaseAgent, buildPlannerChain } from './base-agent.js';

export class BdiAgent extends BaseAgent {
  readonly role: AgentRole = 'bdi';

  protected buildPlannerChain(): IPlanner {
    const chainType = this.config.planner === 'pddl' ? 'pddl' : 'bfs';
    return buildPlannerChain({ chainType });
  }
}
