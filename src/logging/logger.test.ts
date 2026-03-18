// T04 (partial) — Logger & getLlmContext tests
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLogger, getLlmContext, type Logger } from './logger.js';
import type { LogEvent } from '../types.js';

describe('createLogger', () => {
  it('returns a Logger with info/warn/error/debug methods', () => {
    const logger = createLogger('test-module');
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.warn, 'function');
    assert.equal(typeof logger.error, 'function');
    assert.equal(typeof logger.debug, 'function');
  });

  it('logs events without throwing', () => {
    const logger = createLogger('test-module');
    // These should all run without error
    assert.doesNotThrow(() => {
      logger.info({ kind: 'score_update', score: 42 });
      logger.warn({ kind: 'penalty', cause: 'overlap' });
      logger.error({ kind: 'connection_lost' }, new Error('test'));
      logger.debug({ kind: 'action_sent', action: 'move_up', position: { x: 0, y: 0 } });
    });
  });

  it('accepts a log level override', () => {
    const logger = createLogger('test-module', 'error');
    // Should still work (no throw), even though level is 'error'
    assert.doesNotThrow(() => {
      logger.info({ kind: 'score_update', score: 0 });
    });
  });
});

describe('getLlmContext', () => {
  it('returns a valid JSON string', () => {
    // Push some events first
    const logger = createLogger('ctx-test');
    logger.info({ kind: 'score_update', score: 10 });
    logger.info({ kind: 'score_update', score: 20 });

    const ctx = getLlmContext({ lastNEvents: 5 });
    const parsed = JSON.parse(ctx);
    assert.ok(Array.isArray(parsed));
  });

  it('respects lastNEvents limit', () => {
    const logger = createLogger('ctx-limit');
    for (let i = 0; i < 10; i++) {
      logger.info({ kind: 'score_update', score: i });
    }

    const ctx = getLlmContext({ lastNEvents: 3 });
    const parsed = JSON.parse(ctx);
    assert.ok(parsed.length <= 3);
  });

  it('summarizes consecutive movement events', () => {
    const logger = createLogger('ctx-move');
    // Push 3 consecutive move events
    logger.info({ kind: 'action_sent', action: 'move_right', position: { x: 1, y: 0 } });
    logger.info({ kind: 'action_sent', action: 'move_right', position: { x: 2, y: 0 } });
    logger.info({ kind: 'action_sent', action: 'move_up', position: { x: 2, y: 1 } });

    const ctx = getLlmContext({ lastNEvents: 10, kinds: ['action_sent', 'move_summary'] });
    const parsed = JSON.parse(ctx);

    // Movements should be summarized into a single entry
    const moveSummaries = parsed.filter((e: Record<string, unknown>) => e.k === 'mv' && e.n !== undefined);
    assert.ok(moveSummaries.length >= 1, 'Should have at least one movement summary');
    // The summary should have direction info
    const summary = moveSummaries[moveSummaries.length - 1];
    assert.ok(typeof summary.d === 'string');
    assert.ok(typeof summary.n === 'number');
  });

  it('uses abbreviated keys in compact output', () => {
    const logger = createLogger('ctx-compact');
    logger.info({ kind: 'score_update', score: 99 });

    const ctx = getLlmContext({ lastNEvents: 1, kinds: ['score_update'] });
    const parsed = JSON.parse(ctx);
    if (parsed.length > 0) {
      const last = parsed[parsed.length - 1];
      // score_update should be abbreviated to 'sc'
      assert.equal(last.k, 'sc');
      assert.equal(last.s, 99);
    }
  });

  it('output is under 200 tokens for 5 events', () => {
    const logger = createLogger('ctx-tokens');
    for (let i = 0; i < 5; i++) {
      logger.info({ kind: 'score_update', score: i * 10 });
    }

    const ctx = getLlmContext({ lastNEvents: 5, kinds: ['score_update'] });
    // Rough token estimate: ceil(text.length / 4)
    const estimatedTokens = Math.ceil(ctx.length / 4);
    assert.ok(estimatedTokens < 200, `Expected < 200 tokens, got ${estimatedTokens} (${ctx.length} chars)`);
  });

  it('can disable movement summarization', () => {
    const logger = createLogger('ctx-no-summary');
    logger.info({ kind: 'action_sent', action: 'move_right', position: { x: 1, y: 0 } });
    logger.info({ kind: 'action_sent', action: 'move_right', position: { x: 2, y: 0 } });

    const ctx = getLlmContext({
      lastNEvents: 10,
      kinds: ['action_sent'],
      summarizeMovement: false,
    });
    const parsed = JSON.parse(ctx);
    // Without summarization, individual move events should remain
    const moves = parsed.filter((e: Record<string, unknown>) => e.k === 'mv' && e.n === undefined);
    assert.ok(moves.length >= 2, 'Individual move events should be preserved');
  });
});
