// T04 (partial) — LogRingBuffer tests
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { LogRingBuffer } from './log-ring-buffer.js';
import type { RingBufferEntry } from './log-types.js';

function makeEntry(kind: string, ts: number, module = 'test'): RingBufferEntry {
  return { kind, ts, module };
}

describe('LogRingBuffer', () => {
  it('starts empty', () => {
    const buf = new LogRingBuffer(10);
    assert.equal(buf.size, 0);
    assert.deepEqual(buf.query(), []);
  });

  it('stores and retrieves entries', () => {
    const buf = new LogRingBuffer(10);
    buf.push(makeEntry('score_update', 1000));
    buf.push(makeEntry('action_sent', 2000));
    assert.equal(buf.size, 2);

    const entries = buf.query();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].kind, 'score_update');
    assert.equal(entries[1].kind, 'action_sent');
  });

  it('overwrites oldest entries when capacity is exceeded', () => {
    const buf = new LogRingBuffer(3);
    buf.push(makeEntry('a', 1));
    buf.push(makeEntry('b', 2));
    buf.push(makeEntry('c', 3));
    buf.push(makeEntry('d', 4)); // overwrites 'a'

    assert.equal(buf.size, 3);
    const entries = buf.query();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].kind, 'b');
    assert.equal(entries[1].kind, 'c');
    assert.equal(entries[2].kind, 'd');
  });

  it('filters by lastNEvents', () => {
    const buf = new LogRingBuffer(10);
    for (let i = 0; i < 5; i++) {
      buf.push(makeEntry(`e${i}`, i * 1000));
    }

    const last2 = buf.query({ lastNEvents: 2 });
    assert.equal(last2.length, 2);
    assert.equal(last2[0].kind, 'e3');
    assert.equal(last2[1].kind, 'e4');
  });

  it('filters by kinds', () => {
    const buf = new LogRingBuffer(10);
    buf.push(makeEntry('action_sent', 1000));
    buf.push(makeEntry('score_update', 2000));
    buf.push(makeEntry('action_sent', 3000));
    buf.push(makeEntry('penalty', 4000));

    const actions = buf.query({ kinds: ['action_sent'] });
    assert.equal(actions.length, 2);
    assert.ok(actions.every(e => e.kind === 'action_sent'));
  });

  it('filters by lastNSeconds', () => {
    const now = Date.now();
    const buf = new LogRingBuffer(10);
    buf.push(makeEntry('old', now - 10000)); // 10s ago
    buf.push(makeEntry('recent', now - 500)); // 0.5s ago
    buf.push(makeEntry('very_recent', now - 100)); // 0.1s ago

    const recent = buf.query({ lastNSeconds: 2 });
    assert.equal(recent.length, 2);
    assert.equal(recent[0].kind, 'recent');
    assert.equal(recent[1].kind, 'very_recent');
  });

  it('combines filters: kinds + lastNEvents', () => {
    const buf = new LogRingBuffer(10);
    buf.push(makeEntry('action_sent', 1000));
    buf.push(makeEntry('score_update', 2000));
    buf.push(makeEntry('action_sent', 3000));
    buf.push(makeEntry('action_sent', 4000));

    const result = buf.query({ kinds: ['action_sent'], lastNEvents: 1 });
    assert.equal(result.length, 1);
    assert.equal(result[0].ts, 4000);
  });

  it('returns entries in chronological order after wrap-around', () => {
    const buf = new LogRingBuffer(3);
    buf.push(makeEntry('a', 1));
    buf.push(makeEntry('b', 2));
    buf.push(makeEntry('c', 3));
    buf.push(makeEntry('d', 4));
    buf.push(makeEntry('e', 5));

    const entries = buf.query();
    assert.equal(entries.length, 3);
    // Should be chronological: c, d, e
    assert.equal(entries[0].kind, 'c');
    assert.equal(entries[1].kind, 'd');
    assert.equal(entries[2].kind, 'e');
  });
});
