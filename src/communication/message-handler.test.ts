// ============================================================
// src/communication/message-handler.test.ts — T16 unit tests
// ============================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInterAgentMessage,
  deserializeMessage,
  serializeMessage,
  nextSeq,
  makeHello,
  makeBeliefShare,
  makeParcelClaim,
  makeParcelClaimAck,
} from './message-protocol.js';
import { MessageHandler } from './message-handler.js';
import { MockGameClient } from '../testing/mock-game-client.js';
import type { InterAgentMessage } from '../types.js';

// ---------------------------------------------------------------------------
// message-protocol.ts tests
// ---------------------------------------------------------------------------

describe('isInterAgentMessage', () => {
  it('accepts a valid HelloMessage', () => {
    const msg: InterAgentMessage = makeHello('agent-1', 'bdi');
    assert.ok(isInterAgentMessage(msg));
  });

  it('accepts a valid BeliefShareMessage', () => {
    const msg: InterAgentMessage = makeBeliefShare('agent-1', {
      agentId: 'agent-1',
      timestamp: Date.now(),
      selfPosition: { x: 0, y: 0 },
      parcels: [],
      agents: [],
    });
    assert.ok(isInterAgentMessage(msg));
  });

  it('accepts a valid ParcelClaimMessage', () => {
    const msg: InterAgentMessage = makeParcelClaim('agent-1', 'p-1', 5);
    assert.ok(isInterAgentMessage(msg));
  });

  it('accepts a valid ParcelClaimAckMessage', () => {
    const msg: InterAgentMessage = makeParcelClaimAck('agent-1', 'p-1', true);
    assert.ok(isInterAgentMessage(msg));
  });

  it('rejects null', () => {
    assert.ok(!isInterAgentMessage(null));
  });

  it('rejects a plain string', () => {
    assert.ok(!isInterAgentMessage('hello'));
  });

  it('rejects an object with unknown type', () => {
    assert.ok(!isInterAgentMessage({ type: 'unknown', agentId: 'a', seq: 1, timestamp: 1 }));
  });

  it('rejects hello without role field', () => {
    assert.ok(!isInterAgentMessage({ type: 'hello', agentId: 'a', seq: 1, timestamp: 1 }));
  });

  it('rejects parcel_claim without distance', () => {
    assert.ok(!isInterAgentMessage({ type: 'parcel_claim', agentId: 'a', parcelId: 'p', seq: 1, timestamp: 1 }));
  });

  it('rejects object missing seq', () => {
    assert.ok(!isInterAgentMessage({ type: 'hello', agentId: 'a', role: 'bdi', timestamp: 1 }));
  });
});

describe('deserializeMessage', () => {
  it('deserializes a valid JSON string', () => {
    const msg = makeHello('agent-1', 'bdi');
    const result = deserializeMessage(serializeMessage(msg));
    assert.ok(result !== null);
    assert.equal(result!.type, 'hello');
    assert.equal(result!.agentId, 'agent-1');
  });

  it('deserializes a plain object', () => {
    const msg = makeParcelClaim('a', 'p1', 3);
    const result = deserializeMessage(msg);
    assert.ok(result !== null);
    assert.equal(result!.type, 'parcel_claim');
  });

  it('returns null for invalid JSON string', () => {
    assert.equal(deserializeMessage('not-json{{{'), null);
  });

  it('returns null for a valid JSON string with wrong shape', () => {
    assert.equal(deserializeMessage('{"type":"hack","agentId":"x","seq":1,"timestamp":1}'), null);
  });

  it('returns null for a number', () => {
    assert.equal(deserializeMessage(42), null);
  });
});

describe('nextSeq', () => {
  it('returns monotonically increasing values', () => {
    const a = nextSeq();
    const b = nextSeq();
    const c = nextSeq();
    assert.ok(b > a);
    assert.ok(c > b);
  });
});

// ---------------------------------------------------------------------------
// MessageHandler tests
// ---------------------------------------------------------------------------

describe('MessageHandler', () => {
  let client: MockGameClient;
  let handler: MessageHandler;
  const AGENT_ID = 'self-agent';
  const ALLY_ID = 'ally-agent';
  const STRANGER_ID = 'stranger-agent';

  beforeEach(() => {
    client = new MockGameClient();
    handler = new MessageHandler(client, AGENT_ID);
  });

  it('sendTo delivers a message via GameClient.sendMessage', () => {
    const msg = makeHello(AGENT_ID, 'bdi');
    handler.sendTo(ALLY_ID, msg);
    assert.equal(client.sentMessages.length, 1);
    assert.equal(client.sentMessages[0].toId, ALLY_ID);
    assert.equal(client.sentMessages[0].msg.type, 'hello');
  });

  it('broadcast sends via GameClient.broadcastMessage', () => {
    const msg = makeHello(AGENT_ID, 'bdi');
    const sent = handler.broadcast(msg);
    assert.ok(sent);
    assert.equal(client.broadcastedMessages.length, 1);
  });

  it('broadcast rate-limits belief_share to 1 per second', () => {
    const makeShare = () => makeBeliefShare(AGENT_ID, {
      agentId: AGENT_ID,
      timestamp: Date.now(),
      selfPosition: { x: 0, y: 0 },
      parcels: [],
      agents: [],
    });

    const first = handler.broadcast(makeShare());
    const second = handler.broadcast(makeShare()); // immediately after — should be blocked
    assert.ok(first, 'first send should succeed');
    assert.ok(!second, 'second send within 1s should be rate-limited');
    assert.equal(client.broadcastedMessages.length, 1);
  });

  it('broadcast does not rate-limit non-belief_share messages', () => {
    const msg = makeHello(AGENT_ID, 'bdi');
    handler.broadcast(msg);
    handler.broadcast(msg);
    assert.equal(client.broadcastedMessages.length, 2);
  });

  it('onMessage delivers HelloMessage from any sender', () => {
    const received: Array<{ from: string; msg: InterAgentMessage }> = [];
    handler.onMessage((from, msg) => received.push({ from, msg }));

    const hello = makeHello(STRANGER_ID, 'bdi');
    client.emitMessage(STRANGER_ID, hello);

    assert.equal(received.length, 1);
    assert.equal(received[0].msg.type, 'hello');
    assert.equal(received[0].from, STRANGER_ID);
  });

  it('onMessage filters non-hello messages from unregistered senders', () => {
    const received: InterAgentMessage[] = [];
    handler.onMessage((_, msg) => received.push(msg));

    const claim = makeParcelClaim(STRANGER_ID, 'p-1', 2);
    client.emitMessage(STRANGER_ID, claim);

    assert.equal(received.length, 0, 'stranger parcel_claim should be filtered');
  });

  it('onMessage delivers non-hello messages from registered senders', () => {
    handler.addAllowedSender(ALLY_ID);
    const received: InterAgentMessage[] = [];
    handler.onMessage((_, msg) => received.push(msg));

    const claim = makeParcelClaim(ALLY_ID, 'p-1', 2);
    client.emitMessage(ALLY_ID, claim);

    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'parcel_claim');
  });

  it('onMessage drops messages with own agentId (echo prevention)', () => {
    handler.addAllowedSender(AGENT_ID);
    const received: InterAgentMessage[] = [];
    handler.onMessage((_, msg) => received.push(msg));

    const selfMsg = makeHello(AGENT_ID, 'bdi');
    client.emitMessage(AGENT_ID, selfMsg);

    assert.equal(received.length, 0, 'own messages should be dropped');
  });

  it('addAllowedSender / removeAllowedSender toggles filtering', () => {
    handler.addAllowedSender(ALLY_ID);
    handler.removeAllowedSender(ALLY_ID);

    const received: InterAgentMessage[] = [];
    handler.onMessage((_, msg) => received.push(msg));

    const claim = makeParcelClaim(ALLY_ID, 'p-1', 2);
    client.emitMessage(ALLY_ID, claim);

    assert.equal(received.length, 0, 'removed sender should be filtered again');
  });

  it('multiple onMessage callbacks all fire', () => {
    const r1: InterAgentMessage[] = [];
    const r2: InterAgentMessage[] = [];
    handler.onMessage((_, msg) => r1.push(msg));
    handler.onMessage((_, msg) => r2.push(msg));

    const hello = makeHello(STRANGER_ID, 'bdi');
    client.emitMessage(STRANGER_ID, hello);

    assert.equal(r1.length, 1);
    assert.equal(r2.length, 1);
  });
});
