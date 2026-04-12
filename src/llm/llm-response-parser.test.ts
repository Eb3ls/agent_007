// ============================================================
// src/llm/llm-response-parser.test.ts — Unit tests for T22
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LlmResponseParser } from './llm-response-parser.js';
import type { Position } from '../types.js';

const parser = new LlmResponseParser();
const start: Position = { x: 3, y: 4 };

describe('LlmResponseParser', () => {
  // -------------------------------------------------------------------------
  // Primary path: JSON extraction
  // -------------------------------------------------------------------------

  describe('parsePlan — JSON format', () => {
    it('parses a clean JSON response', () => {
      const response = JSON.stringify({
        steps: [
          { action: 'move', direction: 'up' },
          { action: 'pickup' },
          { action: 'move', direction: 'down' },
          { action: 'putdown' },
        ],
      });
      const plan = parser.parsePlan(response, start);
      assert.ok(plan !== null);
      assert.equal(plan.steps.length, 4);
      assert.equal(plan.steps[0]!.action, 'move_up');
      assert.equal(plan.steps[1]!.action, 'pickup');
      assert.equal(plan.steps[2]!.action, 'move_down');
      assert.equal(plan.steps[3]!.action, 'putdown');
    });

    it('parses JSON embedded in surrounding text', () => {
      const response =
        'Sure, here is my plan:\n' +
        '{"steps":[{"action":"move","direction":"right"},{"action":"pickup"}]}\n' +
        'Let me know if you want more steps.';
      const plan = parser.parsePlan(response, start);
      assert.ok(plan !== null);
      assert.equal(plan.steps.length, 2);
      assert.equal(plan.steps[0]!.action, 'move_right');
    });

    it('parses all four directions', () => {
      const directions = ['up', 'down', 'left', 'right'] as const;
      const expected = ['move_up', 'move_down', 'move_left', 'move_right'] as const;
      for (const [i, dir] of directions.entries()) {
        const response = JSON.stringify({ steps: [{ action: 'move', direction: dir }] });
        const plan = parser.parsePlan(response, start);
        assert.ok(plan !== null, `direction ${dir} should parse`);
        assert.equal(plan.steps[0]!.action, expected[i]);
      }
    });

    it('skips send_message steps (not an ActionType)', () => {
      const response = JSON.stringify({
        steps: [
          { action: 'send_message', to: 'agent2', content: 'hello' },
          { action: 'move', direction: 'left' },
        ],
      });
      const plan = parser.parsePlan(response, start);
      assert.ok(plan !== null);
      assert.equal(plan.steps.length, 1);
      assert.equal(plan.steps[0]!.action, 'move_left');
    });

    it('returns null for JSON with no valid actions', () => {
      const response = JSON.stringify({
        steps: [
          { action: 'send_message', to: 'ally', content: 'hi' },
        ],
      });
      const plan = parser.parsePlan(response, start);
      assert.equal(plan, null);
    });
  });

  // -------------------------------------------------------------------------
  // Position tracing
  // -------------------------------------------------------------------------

  describe('expectedPosition tracing', () => {
    it('traces move_up correctly (y+1)', () => {
      const response = JSON.stringify({ steps: [{ action: 'move', direction: 'up' }] });
      const plan = parser.parsePlan(response, { x: 2, y: 3 });
      assert.ok(plan !== null);
      assert.deepEqual(plan.steps[0]!.expectedPosition, { x: 2, y: 4 });
    });

    it('traces move_right correctly (x+1)', () => {
      const response = JSON.stringify({ steps: [{ action: 'move', direction: 'right' }] });
      const plan = parser.parsePlan(response, { x: 2, y: 3 });
      assert.ok(plan !== null);
      assert.deepEqual(plan.steps[0]!.expectedPosition, { x: 3, y: 3 });
    });

    it('traces a multi-step plan correctly', () => {
      const response = JSON.stringify({
        steps: [
          { action: 'move', direction: 'right' },
          { action: 'move', direction: 'up' },
          { action: 'pickup' },
        ],
      });
      const plan = parser.parsePlan(response, { x: 0, y: 0 });
      assert.ok(plan !== null);
      assert.deepEqual(plan.steps[0]!.expectedPosition, { x: 1, y: 0 });
      assert.deepEqual(plan.steps[1]!.expectedPosition, { x: 1, y: 1 });
      assert.deepEqual(plan.steps[2]!.expectedPosition, { x: 1, y: 1 }); // pickup stays
    });
  });

  // -------------------------------------------------------------------------
  // Fallback: natural language regex
  // -------------------------------------------------------------------------

  describe('parsePlan — natural language fallback', () => {
    it('extracts actions from natural language', () => {
      const response = 'move right, move right, pick up, move left, put down';
      const plan = parser.parsePlan(response, start);
      assert.ok(plan !== null);
      assert.equal(plan.steps.length, 5);
      assert.equal(plan.steps[0]!.action, 'move_right');
      assert.equal(plan.steps[1]!.action, 'move_right');
      assert.equal(plan.steps[2]!.action, 'pickup');
      assert.equal(plan.steps[3]!.action, 'move_left');
      assert.equal(plan.steps[4]!.action, 'putdown');
    });

    it('recognises "pickup" and "putdown" as one word', () => {
      const response = 'move up, pickup, putdown';
      const plan = parser.parsePlan(response, start);
      assert.ok(plan !== null);
      assert.equal(plan.steps[1]!.action, 'pickup');
      assert.equal(plan.steps[2]!.action, 'putdown');
    });

    it('recognises north/south/east/west synonyms', () => {
      const response = 'go north then east then south then west';
      const plan = parser.parsePlan(response, start);
      assert.ok(plan !== null);
      assert.equal(plan.steps.length, 4);
      assert.equal(plan.steps[0]!.action, 'move_up');
      assert.equal(plan.steps[1]!.action, 'move_right');
      assert.equal(plan.steps[2]!.action, 'move_down');
      assert.equal(plan.steps[3]!.action, 'move_left');
    });
  });

  // -------------------------------------------------------------------------
  // Garbage input
  // -------------------------------------------------------------------------

  describe('parsePlan — garbage input', () => {
    it('returns null for completely unrecognised text', () => {
      const plan = parser.parsePlan('I am unable to determine a plan.', start);
      assert.equal(plan, null);
    });

    it('returns null for empty string', () => {
      const plan = parser.parsePlan('', start);
      assert.equal(plan, null);
    });

    it('returns null for malformed JSON with no steps', () => {
      const plan = parser.parsePlan('{"foo":"bar"}', start);
      assert.equal(plan, null);
    });

    it('returns null for JSON with invalid direction', () => {
      // Only the bad direction step — no valid actions remain
      const response = JSON.stringify({ steps: [{ action: 'move', direction: 'diagonal' }] });
      const plan = parser.parsePlan(response, start);
      assert.equal(plan, null);
    });
  });

  // -------------------------------------------------------------------------
  // Plan metadata
  // -------------------------------------------------------------------------

  describe('plan metadata', () => {
    it('plan has id, intentionId, createdAt', () => {
      const response = JSON.stringify({ steps: [{ action: 'pickup' }] });
      const plan = parser.parsePlan(response, start);
      assert.ok(plan !== null);
      assert.ok(typeof plan.id === 'string' && plan.id.length > 0);
      assert.equal(plan.intentionId, '');
      assert.ok(plan.createdAt > 0);
    });
  });
});
