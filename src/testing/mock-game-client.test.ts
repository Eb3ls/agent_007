import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockGameClient } from './mock-game-client.js';
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_PARCELS,
  FIXTURE_AGENTS,
  FIXTURE_SELF,
  FIXTURE_DELIVERY_ZONES,
  FIXTURE_SPAWNING_TILES,
} from './fixtures.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import type { RawParcelSensing, InterAgentMessage, TileType } from '../types.js';

describe('Fixtures', () => {
  it('fixture map has correct dimensions and tile counts', () => {
    assert.equal(FIXTURE_MAP_TILES.length, FIXTURE_MAP_WIDTH * FIXTURE_MAP_HEIGHT);
  });

  it('fixture map tile types are valid TileType values', () => {
    const validTypes = new Set<TileType>([0, 1, 2, 3]);
    for (const t of FIXTURE_MAP_TILES) {
      assert.ok(validTypes.has(t.type), `Invalid tile type ${t.type} at (${t.x},${t.y})`);
    }
  });

  it('fixture map positions are within bounds', () => {
    for (const t of FIXTURE_MAP_TILES) {
      assert.ok(t.x >= 0 && t.x < FIXTURE_MAP_WIDTH, `x=${t.x} out of bounds`);
      assert.ok(t.y >= 0 && t.y < FIXTURE_MAP_HEIGHT, `y=${t.y} out of bounds`);
    }
  });

  it('fixture delivery zones match map type-2 tiles', () => {
    const map = new BeliefMapImpl([...FIXTURE_MAP_TILES], FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
    const zones = map.getDeliveryZones();
    const sorted = [...zones].sort((a, b) => a.x - b.x || a.y - b.y);
    const expected = [...FIXTURE_DELIVERY_ZONES].sort((a, b) => a.x - b.x || a.y - b.y);
    assert.deepEqual(sorted, expected);
  });

  it('fixture spawning tiles match map type-1 tiles', () => {
    const map = new BeliefMapImpl([...FIXTURE_MAP_TILES], FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
    const spawns = map.getSpawningTiles();
    const sorted = [...spawns].sort((a, b) => a.x - b.x || a.y - b.y);
    const expected = [...FIXTURE_SPAWNING_TILES].sort((a, b) => a.x - b.x || a.y - b.y);
    assert.deepEqual(sorted, expected);
  });

  it('fixture parcels have valid positions within map bounds', () => {
    for (const p of FIXTURE_PARCELS) {
      assert.ok(p.x >= 0 && p.x < FIXTURE_MAP_WIDTH, `Parcel ${p.id} x=${p.x} out of bounds`);
      assert.ok(p.y >= 0 && p.y < FIXTURE_MAP_HEIGHT, `Parcel ${p.id} y=${p.y} out of bounds`);
    }
  });

  it('fixture agents have valid positions within map bounds', () => {
    for (const a of FIXTURE_AGENTS) {
      assert.ok(a.x >= 0 && a.x < FIXTURE_MAP_WIDTH, `Agent ${a.id} x=${a.x} out of bounds`);
      assert.ok(a.y >= 0 && a.y < FIXTURE_MAP_HEIGHT, `Agent ${a.id} y=${a.y} out of bounds`);
    }
  });

  it('fixture self has valid position within map bounds', () => {
    assert.ok(FIXTURE_SELF.x >= 0 && FIXTURE_SELF.x < FIXTURE_MAP_WIDTH);
    assert.ok(FIXTURE_SELF.y >= 0 && FIXTURE_SELF.y < FIXTURE_MAP_HEIGHT);
  });
});

describe('MockGameClient', () => {
  it('connect sets connected state', async () => {
    const client = new MockGameClient();
    assert.equal(client.isConnected(), false);
    await client.connect();
    assert.equal(client.isConnected(), true);
  });

  it('disconnect fires disconnect callback', async () => {
    const client = new MockGameClient();
    await client.connect();
    let disconnected = false;
    client.onDisconnect(() => { disconnected = true; });
    client.disconnect();
    assert.equal(disconnected, true);
    assert.equal(client.isConnected(), false);
  });

  it('emitMap fires onMap callback with correct data', () => {
    const client = new MockGameClient();
    let received = false;
    client.onMap((tiles, w, h) => {
      assert.equal(tiles.length, FIXTURE_MAP_TILES.length);
      assert.equal(w, FIXTURE_MAP_WIDTH);
      assert.equal(h, FIXTURE_MAP_HEIGHT);
      received = true;
    });
    client.emitMap(FIXTURE_MAP_TILES, FIXTURE_MAP_WIDTH, FIXTURE_MAP_HEIGHT);
    assert.equal(received, true);
  });

  it('emitParcelsSensing fires onParcelsSensing with typed data', () => {
    const client = new MockGameClient();
    let receivedParcels: ReadonlyArray<RawParcelSensing> = [];
    client.onParcelsSensing((parcels) => {
      receivedParcels = parcels;
    });
    client.emitParcelsSensing(FIXTURE_PARCELS);
    assert.equal(receivedParcels.length, FIXTURE_PARCELS.length);
    assert.equal(receivedParcels[0].id, FIXTURE_PARCELS[0].id);
    assert.equal(receivedParcels[0].reward, FIXTURE_PARCELS[0].reward);
    assert.equal(receivedParcels[0].carriedBy, null);
  });

  it('emitYou fires onYou callback', () => {
    const client = new MockGameClient();
    let received = false;
    client.onYou((self) => {
      assert.equal(self.id, FIXTURE_SELF.id);
      assert.equal(self.x, FIXTURE_SELF.x);
      assert.equal(self.y, FIXTURE_SELF.y);
      received = true;
    });
    client.emitYou(FIXTURE_SELF);
    assert.equal(received, true);
  });

  it('emitAgentsSensing fires onAgentsSensing callback', () => {
    const client = new MockGameClient();
    let count = 0;
    client.onAgentsSensing((agents) => {
      count = agents.length;
    });
    client.emitAgentsSensing(FIXTURE_AGENTS);
    assert.equal(count, FIXTURE_AGENTS.length);
  });

  it('emitMessage fires onMessage callback', () => {
    const client = new MockGameClient();
    let receivedFrom = '';
    let receivedMsg: InterAgentMessage | null = null;
    client.onMessage((from, msg) => {
      receivedFrom = from;
      receivedMsg = msg;
    });
    const hello: InterAgentMessage = {
      type: 'hello',
      agentId: 'agent-a',
      role: 'bdi',
      seq: 1,
      timestamp: Date.now(),
    };
    client.emitMessage('agent-a', hello);
    assert.equal(receivedFrom, 'agent-a');
    assert.deepEqual(receivedMsg, hello);
  });

  it('move records direction and returns configured result', async () => {
    const client = new MockGameClient();
    const result = await client.move('right');
    assert.equal(result, true);
    assert.deepEqual(client.moveHistory, ['right']);

    client.setActionConfig({ moveSucceeds: false });
    const result2 = await client.move('up');
    assert.equal(result2, false);
    assert.deepEqual(client.moveHistory, ['right', 'up']);
  });

  it('pickup increments counter and returns configured result', async () => {
    const pickupParcels: RawParcelSensing[] = [
      { id: 'p1', x: 1, y: 0, carriedBy: 'agent-self', reward: 50 },
    ];
    const client = new MockGameClient({ pickupResult: pickupParcels });
    const result = await client.pickup();
    assert.equal(client.pickupCount.value, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'p1');
  });

  it('putdown increments counter and returns configured result', async () => {
    const client = new MockGameClient();
    await client.putdown();
    assert.equal(client.putdownCount.value, 1);
  });

  it('sendMessage records sent messages', () => {
    const client = new MockGameClient();
    const msg: InterAgentMessage = {
      type: 'hello',
      agentId: 'self',
      role: 'bdi',
      seq: 1,
      timestamp: Date.now(),
    };
    client.sendMessage('agent-b', msg);
    assert.equal(client.sentMessages.length, 1);
    assert.equal(client.sentMessages[0].toId, 'agent-b');
  });

  it('broadcastMessage records broadcasted messages', () => {
    const client = new MockGameClient();
    const msg: InterAgentMessage = {
      type: 'hello',
      agentId: 'self',
      role: 'bdi',
      seq: 1,
      timestamp: Date.now(),
    };
    client.broadcastMessage(msg);
    assert.equal(client.broadcastedMessages.length, 1);
  });

  it('reset clears all recorded state', async () => {
    const client = new MockGameClient();
    await client.move('left');
    await client.pickup();
    await client.putdown();
    client.sendMessage('x', { type: 'hello', agentId: 'self', role: 'bdi', seq: 1, timestamp: 0 });
    client.broadcastMessage({ type: 'hello', agentId: 'self', role: 'bdi', seq: 1, timestamp: 0 });
    client.reset();
    assert.equal(client.moveHistory.length, 0);
    assert.equal(client.pickupCount.value, 0);
    assert.equal(client.putdownCount.value, 0);
    assert.equal(client.sentMessages.length, 0);
    assert.equal(client.broadcastedMessages.length, 0);
  });

  it('multiple callbacks fire for same event', () => {
    const client = new MockGameClient();
    let count = 0;
    client.onYou(() => { count++; });
    client.onYou(() => { count++; });
    client.emitYou(FIXTURE_SELF);
    assert.equal(count, 2);
  });

  it('getMeasuredActionDurationMs returns configurable value', () => {
    const client = new MockGameClient();
    assert.equal(client.getMeasuredActionDurationMs(), 500);
    client.setMeasuredActionDurationMs(200);
    assert.equal(client.getMeasuredActionDurationMs(), 200);
  });

  it('drainPending is a no-op (no buffering in mock)', () => {
    const client = new MockGameClient();
    // Should not throw
    client.drainPending();
  });
});
