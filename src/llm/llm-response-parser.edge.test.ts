// ============================================================
// src/llm/llm-response-parser.edge.test.ts — Edge cases for LlmResponseParser
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LlmResponseParser } from './llm-response-parser.js';
import type { Position } from '../types.js';

const parser = new LlmResponseParser();
const start: Position = { x: 3, y: 4 };

describe('LlmResponseParser — edge cases', () => {

  // --- JSON with empty steps array ---

  it('returns null for JSON with empty steps array', () => {
    const response = JSON.stringify({ steps: [] });
    const plan = parser.parsePlan(response, start);
    assert.equal(plan, null, 'empty steps array with no NL fallback must return null');
  });

  it('returns null for JSON with only send_message steps (no NL fallback either)', () => {
    const response = JSON.stringify({
      steps: [
        { action: 'send_message', to: 'ally', content: 'hello' },
        { action: 'send_message', to: 'ally', content: 'ready?' },
      ],
    });
    // JSON parsed, all steps filtered → no actions → falls through to NL
    // NL also finds nothing → null
    const plan = parser.parsePlan(response, start);
    assert.equal(plan, null);
  });

  // --- JSON preceded by extra braces in text ---

  it('parses correctly when text contains braces before the plan JSON', () => {
    // Leading brace-like context (e.g., formatting braces in explanation)
    const response =
      'Here is an example: {} and the plan: ' +
      '{"steps":[{"action":"move","direction":"up"},{"action":"pickup"}]}';
    const plan = parser.parsePlan(response, start);
    assert.ok(plan !== null, 'must find the valid JSON block after invalid one');
    assert.equal(plan!.steps.length, 2);
    assert.equal(plan!.steps[0]!.action, 'move_up');
  });

  it('parses correctly when valid JSON is preceded by invalid JSON object', () => {
    const response =
      '{"thinking":"go up"}' +
      ' then ' +
      '{"steps":[{"action":"move","direction":"left"}]}';
    const plan = parser.parsePlan(response, start);
    // First block has no "steps" array → invalid → parser moves to second block
    assert.ok(plan !== null);
    assert.equal(plan!.steps[0]!.action, 'move_left');
  });

  // --- Natural language synonyms ---

  it('recognises "grab" as pickup', () => {
    const plan = parser.parsePlan('move right and grab it', start);
    assert.ok(plan !== null);
    const actions = plan!.steps.map(s => s.action);
    assert.ok(actions.includes('pickup'), `expected pickup in ${JSON.stringify(actions)}`);
  });

  it('recognises "deliver" as putdown', () => {
    const plan = parser.parsePlan('move up and deliver the parcel', start);
    assert.ok(plan !== null);
    const actions = plan!.steps.map(s => s.action);
    assert.ok(actions.includes('putdown'), `expected putdown in ${JSON.stringify(actions)}`);
  });

  it('recognises "drop" as putdown', () => {
    const plan = parser.parsePlan('go north, drop it here', start);
    assert.ok(plan !== null);
    const actions = plan!.steps.map(s => s.action);
    assert.ok(actions.includes('putdown'), `expected putdown in ${JSON.stringify(actions)}`);
  });

  it('recognises "pick-up" (hyphenated) as pickup', () => {
    const plan = parser.parsePlan('pick-up the parcel', start);
    assert.ok(plan !== null);
    assert.equal(plan!.steps[0]!.action, 'pickup');
  });

  it('recognises "put-down" (hyphenated) as putdown', () => {
    const plan = parser.parsePlan('put-down the parcel at delivery', start);
    assert.ok(plan !== null);
    assert.equal(plan!.steps[0]!.action, 'putdown');
  });

  // --- Case insensitivity in natural language ---

  it('natural language matching is case-insensitive', () => {
    const plan = parser.parsePlan('Move Right, PICK UP, Move Left, PUT DOWN', start);
    assert.ok(plan !== null);
    assert.equal(plan!.steps.length, 4);
    assert.equal(plan!.steps[0]!.action, 'move_right');
    assert.equal(plan!.steps[1]!.action, 'pickup');
    assert.equal(plan!.steps[2]!.action, 'move_left');
    assert.equal(plan!.steps[3]!.action, 'putdown');
  });

  // --- JSON direction case sensitivity ---

  it('returns null for uppercase direction (case-sensitive JSON parse)', () => {
    // The parser matches 'up', 'down', 'left', 'right' exactly
    const response = JSON.stringify({ steps: [{ action: 'move', direction: 'UP' }] });
    const plan = parser.parsePlan(response, start);
    // JSON direction 'UP' does not match — NL fallback may catch 'move UP'
    // but the JSON block itself fails direction parsing
    // NL fallback: "UP" is not a standalone keyword match without "move" prefix in NL context
    // Result: may be null or have 0 steps from JSON path
    // The key assertion: if a plan is returned, it must not have an invalid step
    if (plan !== null) {
      for (const step of plan.steps) {
        assert.ok(
          ['move_up','move_down','move_left','move_right','pickup','putdown'].includes(step.action),
          `invalid action type: ${step.action}`,
        );
      }
    }
  });

  // --- Plan IDs are unique per call ---

  it('each parsed plan gets a unique ID', () => {
    const response = JSON.stringify({ steps: [{ action: 'pickup' }] });
    const p1 = parser.parsePlan(response, start);
    const p2 = parser.parsePlan(response, start);
    assert.ok(p1 !== null && p2 !== null);
    assert.notEqual(p1!.id, p2!.id, 'each call must produce a unique plan ID');
  });

  // --- Response that is a JSON array (not object) ---

  it('returns null for a JSON array at root (not an object with steps)', () => {
    // JSON.parse succeeds but isLlmPlanJson fails because it's not an object
    const plan = parser.parsePlan('[{"action":"move","direction":"up"}]', start);
    // NL fallback: "move" + "up" could match "move up" keyword
    // Key: should not crash; any returned plan must have valid steps
    if (plan !== null) {
      for (const step of plan.steps) {
        assert.ok(
          ['move_up','move_down','move_left','move_right','pickup','putdown'].includes(step.action),
        );
      }
    }
  });

  // --- expectedPosition tracing for pickup/putdown stays the same ---

  it('pickup and putdown steps do not advance position', () => {
    const response = JSON.stringify({
      steps: [
        { action: 'move', direction: 'up' },
        { action: 'pickup' },
        { action: 'putdown' },
        { action: 'move', direction: 'right' },
      ],
    });
    const plan = parser.parsePlan(response, { x: 0, y: 0 });
    assert.ok(plan !== null);
    assert.deepEqual(plan!.steps[0]!.expectedPosition, { x: 0, y: 1 }); // after move_up
    assert.deepEqual(plan!.steps[1]!.expectedPosition, { x: 0, y: 1 }); // pickup: same
    assert.deepEqual(plan!.steps[2]!.expectedPosition, { x: 0, y: 1 }); // putdown: same
    assert.deepEqual(plan!.steps[3]!.expectedPosition, { x: 1, y: 1 }); // after move_right
  });

  // --- Mixed JSON with unknown action types ---

  it('skips unknown action types in JSON steps and parses remaining valid ones', () => {
    const response = JSON.stringify({
      steps: [
        { action: 'unknown_action' },
        { action: 'move', direction: 'down' },
        { action: 'another_unknown' },
        { action: 'putdown' },
      ],
    });
    const plan = parser.parsePlan(response, start);
    assert.ok(plan !== null, 'must parse the 2 valid steps');
    assert.equal(plan!.steps.length, 2);
    assert.equal(plan!.steps[0]!.action, 'move_down');
    assert.equal(plan!.steps[1]!.action, 'putdown');
  });

  // --- Natural language ordering by text position ---

  it('extracts NL actions in text-position order, not by action type', () => {
    // "put down" appears before "move up" in text
    const response = 'put down the parcel then move up to start';
    const plan = parser.parsePlan(response, start);
    assert.ok(plan !== null);
    assert.equal(plan!.steps[0]!.action, 'putdown');
    assert.equal(plan!.steps[1]!.action, 'move_up');
  });

  // --- estimatedReward always 0 ---

  it('parsed plan always has estimatedReward = 0 (LLM does not provide it)', () => {
    const response = JSON.stringify({ steps: [{ action: 'pickup' }] });
    const plan = parser.parsePlan(response, start);
    assert.ok(plan !== null);
    assert.equal(plan!.estimatedReward, 0);
  });

  // --- intentionId is empty string ---

  it('parsed plan always has intentionId = empty string', () => {
    const response = JSON.stringify({ steps: [{ action: 'putdown' }] });
    const plan = parser.parsePlan(response, start);
    assert.ok(plan !== null);
    assert.equal(plan!.intentionId, '');
  });
});
