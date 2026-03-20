// ============================================================
// src/communication/message-protocol.ts
// Serialization, deserialization, validation, and sequence
// numbering for InterAgentMessage.
// ============================================================

import type {
  InterAgentMessage,
  HelloMessage,
  BeliefShareMessage,
  IntentionAnnounceMessage,
  IntentionReleaseMessage,
  ParcelClaimMessage,
  ParcelClaimAckMessage,
  AgentRole,
  IntentionType,
} from '../types.js';

// --- Sequence counter (per-process, monotonically increasing) ---

let _seq = 0;

export function nextSeq(): number {
  return ++_seq;
}

// --- Type guard ---

export function isInterAgentMessage(raw: unknown): raw is InterAgentMessage {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;

  if (typeof obj['type'] !== 'string') return false;
  if (typeof obj['agentId'] !== 'string') return false;
  if (typeof obj['seq'] !== 'number') return false;
  if (typeof obj['timestamp'] !== 'number') return false;

  switch (obj['type']) {
    case 'hello':
      return typeof obj['role'] === 'string';

    case 'belief_share':
      return typeof obj['snapshot'] === 'object' && obj['snapshot'] !== null;

    case 'intention_announce':
      return (
        typeof obj['intentionId'] === 'string' &&
        Array.isArray(obj['targetParcelIds']) &&
        typeof obj['intentionType'] === 'string'
      );

    case 'intention_release':
      return typeof obj['intentionId'] === 'string';

    case 'parcel_claim':
      return (
        typeof obj['parcelId'] === 'string' &&
        typeof obj['distance'] === 'number'
      );

    case 'parcel_claim_ack':
      return (
        typeof obj['parcelId'] === 'string' &&
        typeof obj['yield'] === 'boolean'
      );

    default:
      return false;
  }
}

// --- Deserialize from an unknown value (already-parsed object or JSON string) ---

export function deserializeMessage(raw: unknown): InterAgentMessage | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return isInterAgentMessage(obj) ? obj : null;
}

// --- Serialize to JSON string ---

export function serializeMessage(msg: InterAgentMessage): string {
  return JSON.stringify(msg);
}

// --- Message factory helpers (stamp seq + timestamp automatically) ---

export function makeHello(agentId: string, role: AgentRole): HelloMessage {
  return { type: 'hello', agentId, role, seq: nextSeq(), timestamp: Date.now() };
}

export function makeBeliefShare(
  agentId: string,
  snapshot: BeliefShareMessage['snapshot'],
): BeliefShareMessage {
  return { type: 'belief_share', agentId, snapshot, seq: nextSeq(), timestamp: Date.now() };
}

export function makeIntentionAnnounce(
  agentId: string,
  intentionId: string,
  targetParcelIds: ReadonlyArray<string>,
  intentionType: IntentionType,
): IntentionAnnounceMessage {
  return {
    type: 'intention_announce',
    agentId,
    intentionId,
    targetParcelIds,
    intentionType,
    seq: nextSeq(),
    timestamp: Date.now(),
  };
}

export function makeIntentionRelease(
  agentId: string,
  intentionId: string,
): IntentionReleaseMessage {
  return { type: 'intention_release', agentId, intentionId, seq: nextSeq(), timestamp: Date.now() };
}

export function makeParcelClaim(
  agentId: string,
  parcelId: string,
  distance: number,
): ParcelClaimMessage {
  return { type: 'parcel_claim', agentId, parcelId, distance, seq: nextSeq(), timestamp: Date.now() };
}

export function makeParcelClaimAck(
  agentId: string,
  parcelId: string,
  yieldToOther: boolean,
): ParcelClaimAckMessage {
  return {
    type: 'parcel_claim_ack',
    agentId,
    parcelId,
    yield: yieldToOther,
    seq: nextSeq(),
    timestamp: Date.now(),
  };
}
