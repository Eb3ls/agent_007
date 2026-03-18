// T03 (partial) — EventBuffer tests
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventBuffer, type BufferedEvent } from './event-buffer.js';

describe('EventBuffer', () => {
  it('starts undrained', () => {
    const buf = new EventBuffer();
    assert.equal(buf.isDrained(), false);
    assert.equal(buf.size(), 0);
  });

  it('buffers events before drain', () => {
    const buf = new EventBuffer();
    const event: BufferedEvent = {
      kind: 'you',
      self: { id: 'a1', name: 'Agent1', x: 0, y: 0, score: 0 },
    };
    buf.push(event);
    assert.equal(buf.size(), 1);
  });

  it('drains events in order', () => {
    const buf = new EventBuffer();
    const events: BufferedEvent[] = [
      { kind: 'you', self: { id: 'a1', name: 'A1', x: 0, y: 0, score: 0 } },
      { kind: 'parcels', parcels: [{ id: 'p1', x: 3, y: 5, carriedBy: null, reward: 50 }] },
    ];
    events.forEach(e => buf.push(e));

    const drained: BufferedEvent[] = [];
    buf.drain(e => drained.push(e));

    assert.equal(drained.length, 2);
    assert.equal(drained[0].kind, 'you');
    assert.equal(drained[1].kind, 'parcels');
  });

  it('is marked drained after drain() call', () => {
    const buf = new EventBuffer();
    buf.drain(() => {});
    assert.equal(buf.isDrained(), true);
  });

  it('ignores push() calls after drain', () => {
    const buf = new EventBuffer();
    buf.drain(() => {});
    buf.push({ kind: 'you', self: { id: 'a1', name: 'A1', x: 0, y: 0, score: 0 } });
    assert.equal(buf.size(), 0);
  });

  it('drains map events with width and height', () => {
    const buf = new EventBuffer();
    const mapEvent: BufferedEvent = {
      kind: 'map',
      tiles: [{ x: 0, y: 0, type: 1 }, { x: 1, y: 0, type: 3 }],
      width: 2,
      height: 1,
    };
    buf.push(mapEvent);

    let received: BufferedEvent | null = null;
    buf.drain(e => { received = e; });

    assert.notEqual(received, null);
    const r = received!;
    assert.equal(r.kind, 'map');
    assert.ok(r.kind === 'map');
    assert.equal(r.width, 2);
    assert.equal(r.height, 1);
    assert.equal(r.tiles.length, 2);
  });

  it('drains message events', () => {
    const buf = new EventBuffer();
    const msgEvent: BufferedEvent = {
      kind: 'message',
      from: 'agent-2',
      msg: { type: 'hello', agentId: 'agent-2', role: 'bdi', seq: 1, timestamp: Date.now() },
    };
    buf.push(msgEvent);

    let received: BufferedEvent | null = null;
    buf.drain(e => { received = e; });

    const r = received!;
    assert.equal(r.kind, 'message');
    assert.ok(r.kind === 'message');
    assert.equal(r.from, 'agent-2');
    assert.equal(r.msg.type, 'hello');
  });
});
