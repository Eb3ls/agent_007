// T02 — Shared Type Definitions tests
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  positionEquals,
  manhattanDistance,
  type Tile,
  type TileType,
  type Position,
  type Direction,
  type RawParcelSensing,
  type RawAgentSensing,
  type RawSelfSensing,
  type ParcelBelief,
  type AgentBelief,
  type SelfBelief,
  type BeliefMap,
  type IBeliefStore,
  type Intention,
  type IntentionType,
  type PlanStep,
  type Plan,
  type ActionType,
  type IPlanner,
  type IActionExecutor,
  type IAgent,
  type AgentConfig,
  type AgentRole,
  type PlannerChoice,
  type LogLevel,
  type LlmConfig,
  type MetricsConfig,
  type InterAgentMessage,
  type HelloMessage,
  type BeliefShareMessage,
  type LogEvent,
  type MetricsSnapshot,
  type SessionEvent,
  type BeliefChangeType,
  type PlanningRequest,
  type PlanningResult,
  type LlmMemoryContext,
  type GameClient,
} from './types.js';

describe('positionEquals', () => {
  it('returns true for equal positions', () => {
    assert.equal(positionEquals({ x: 3, y: 5 }, { x: 3, y: 5 }), true);
  });

  it('returns false for different x', () => {
    assert.equal(positionEquals({ x: 3, y: 5 }, { x: 4, y: 5 }), false);
  });

  it('returns false for different y', () => {
    assert.equal(positionEquals({ x: 3, y: 5 }, { x: 3, y: 6 }), false);
  });

  it('handles zero coordinates', () => {
    assert.equal(positionEquals({ x: 0, y: 0 }, { x: 0, y: 0 }), true);
  });
});

describe('manhattanDistance', () => {
  it('returns 0 for same position', () => {
    assert.equal(manhattanDistance({ x: 3, y: 5 }, { x: 3, y: 5 }), 0);
  });

  it('computes correct distance for horizontal movement', () => {
    assert.equal(manhattanDistance({ x: 0, y: 0 }, { x: 5, y: 0 }), 5);
  });

  it('computes correct distance for vertical movement', () => {
    assert.equal(manhattanDistance({ x: 0, y: 0 }, { x: 0, y: 7 }), 7);
  });

  it('computes correct distance for diagonal movement', () => {
    assert.equal(manhattanDistance({ x: 1, y: 2 }, { x: 4, y: 6 }), 7);
  });

  it('handles negative coordinates (absolute difference)', () => {
    assert.equal(manhattanDistance({ x: 5, y: 3 }, { x: 2, y: 1 }), 5);
  });
});

describe('type exports', () => {
  it('TileType values are valid', () => {
    const types: TileType[] = [0, 1, 2, 3];
    assert.equal(types.length, 4);
  });

  it('Direction values are valid', () => {
    const dirs: Direction[] = ['up', 'down', 'left', 'right'];
    assert.equal(dirs.length, 4);
  });

  it('ActionType values are valid', () => {
    const actions: ActionType[] = ['move_up', 'move_down', 'move_left', 'move_right', 'pickup', 'putdown'];
    assert.equal(actions.length, 6);
  });

  it('AgentRole values are valid', () => {
    const roles: AgentRole[] = ['bdi', 'llm', 'hybrid'];
    assert.equal(roles.length, 3);
  });

  it('PlannerChoice values are valid', () => {
    const planners: PlannerChoice[] = ['bfs', 'pddl', 'llm'];
    assert.equal(planners.length, 3);
  });

  it('LogLevel values are valid', () => {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    assert.equal(levels.length, 4);
  });

  it('IntentionType values are valid', () => {
    const types: IntentionType[] = ['pickup_and_deliver', 'explore', 'go_to_delivery', 'wait'];
    assert.equal(types.length, 4);
  });

  it('BeliefChangeType values are valid', () => {
    const types: BeliefChangeType[] = [
      'parcels_changed', 'agents_changed', 'self_moved', 'self_score_changed', 'remote_belief_merged',
    ];
    assert.equal(types.length, 5);
  });

  it('LogEvent kinds cover all expected variants', () => {
    // Verify the discriminated union compiles correctly with a sample
    const event: LogEvent = { kind: 'action_sent', action: 'move_up', position: { x: 0, y: 0 } };
    assert.equal(event.kind, 'action_sent');
  });

  it('InterAgentMessage discriminated union works', () => {
    const hello: InterAgentMessage = {
      type: 'hello',
      agentId: 'a1',
      role: 'bdi',
      seq: 1,
      timestamp: Date.now(),
    };
    assert.equal(hello.type, 'hello');
  });

  it('Tile interface satisfies expected shape', () => {
    const tile: Tile = { x: 0, y: 0, type: 1 };
    assert.equal(tile.type, 1);
  });

  it('RawParcelSensing satisfies expected shape', () => {
    const p: RawParcelSensing = { id: 'p1', x: 3, y: 5, carriedBy: null, reward: 50 };
    assert.equal(p.reward, 50);
  });

  it('RawAgentSensing satisfies expected shape', () => {
    const a: RawAgentSensing = { id: 'a1', name: 'Agent1', x: 1, y: 2, score: 100 };
    assert.equal(a.name, 'Agent1');
  });

  it('RawSelfSensing satisfies expected shape (with optional penalty)', () => {
    const s: RawSelfSensing = { id: 'me', name: 'MyAgent', x: 0, y: 0, score: 0 };
    assert.equal(s.penalty, undefined);
    const s2: RawSelfSensing = { id: 'me', name: 'MyAgent', x: 0, y: 0, score: 0, penalty: 5 };
    assert.equal(s2.penalty, 5);
  });

  it('AgentConfig satisfies expected shape', () => {
    const c: AgentConfig = {
      host: 'http://localhost:8080',
      token: 'tok',
      role: 'bdi',
      planner: 'bfs',
      logLevel: 'info',
    };
    assert.equal(c.host, 'http://localhost:8080');
    assert.equal(c.teamId, undefined); // optional
  });
});
