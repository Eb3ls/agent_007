// ============================================================
// src/communication/ally-tracker.ts — AllyTracker (T17)
// Handles ally discovery, heartbeat, parcel claim negotiation,
// belief sharing, and stale-ally detection.
// ============================================================

import type {
  AgentRole,
  InterAgentMessage,
  HelloMessage,
  BeliefShareMessage,
  ParcelClaimMessage,
} from '../types.js';
import { manhattanDistance } from '../types.js';
import { BeliefStore } from '../beliefs/belief-store.js';
import { MessageHandler } from './message-handler.js';
import {
  makeHello,
  makeBeliefShare,
  makeParcelClaim,
  makeParcelClaimAck,
} from './message-protocol.js';

const HEARTBEAT_INTERVAL_MS   = 5_000;
const BELIEF_SHARE_INTERVAL_MS = 2_000;
const STALE_TIMEOUT_MS        = 10_000;
/** Safety timeout for claim resolution — fires only if an ally never replies (e.g., crashed). */
const CLAIM_WAIT_MS           = 500;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface AllyRecord {
  readonly agentId: string;
  readonly role: AgentRole;
  lastContactAt: number;
  connected: boolean;
}

interface PendingClaim {
  readonly myDistance: number;
  shouldYield: boolean;
  /** Number of ally asks still awaiting a reply. When it hits 0, we win. */
  pendingReplies: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: 'claim' | 'yield') => void;
}

// ---------------------------------------------------------------------------
// AllyTracker
// ---------------------------------------------------------------------------

export class AllyTracker {
  private readonly msgHandler: MessageHandler;
  private readonly beliefs: BeliefStore;
  private readonly agentId: string;
  private readonly role: AgentRole;

  // agentId → AllyRecord
  private readonly allies = new Map<string, AllyRecord>();

  // Anti-replay: last accepted seq per sender
  private readonly lastSeqBySender = new Map<string, number>();

  private static readonly REPLAY_WINDOW_MS = 5_000;

  // parcelId → agentId of ally who has claimed it
  private readonly claimedByOthers = new Map<string, string>();

  // parcelId → pending outgoing claim awaiting acks
  private readonly pendingClaims = new Map<string, PendingClaim>();

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private beliefShareTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    msgHandler: MessageHandler,
    beliefs: BeliefStore,
    agentId: string,
    role: AgentRole,
  ) {
    this.msgHandler = msgHandler;
    this.beliefs = beliefs;
    this.agentId = agentId;
    this.role = role;

    msgHandler.onMessage((from, msg) => this._handleMessage(from, msg));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start heartbeat and belief-share timers, and broadcast initial hello.
   */
  start(): void {
    this._broadcastHello();

    this.heartbeatTimer = setInterval(() => {
      this._broadcastHello();
      this._checkStaleAllies();
    }, HEARTBEAT_INTERVAL_MS);

    this.beliefShareTimer = setInterval(() => {
      this._broadcastBeliefShare();
    }, BELIEF_SHARE_INTERVAL_MS);

    this.heartbeatTimer.unref?.();
    this.beliefShareTimer.unref?.();
  }

  /**
   * Re-broadcast hello after a reconnect so allies can re-register us.
   * Allies may have marked us as stale/disconnected during the outage.
   */
  onReconnect(): void {
    this._broadcastHello();
  }

  /**
   * Stop all timers and resolve any pending claims immediately.
   */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.beliefShareTimer) {
      clearInterval(this.beliefShareTimer);
      this.beliefShareTimer = null;
    }

    for (const pending of this.pendingClaims.values()) {
      clearTimeout(pending.timer);
      pending.resolve('claim');
    }
    this.pendingClaims.clear();
  }

  // ---------------------------------------------------------------------------
  // Parcel claim protocol
  // ---------------------------------------------------------------------------

  /**
   * Send targeted claim asks to all connected allies and resolve as soon as
   * all replies arrive (or the safety timeout elapses).
   *
   * Returns 'claim' if this agent wins, 'yield' if an ally has priority.
   * Priority rule: shorter distance wins; ties broken by lexicographically
   * smaller agentId.
   *
   * Uses emitAsk() so claims are sent only to known allies (not broadcast to
   * opponents) and each ally's reply resolves the ask Promise immediately —
   * no fixed wait time in the happy path.
   */
  async claimParcel(parcelId: string, myDistance: number): Promise<'claim' | 'yield'> {
    const allies = this.getConnectedAllyIds();
    if (allies.length === 0) return 'claim'; // nobody to negotiate with

    const claimMsg = makeParcelClaim(this.agentId, parcelId, myDistance);

    return new Promise<'claim' | 'yield'>((resolve) => {
      const pending: PendingClaim = {
        myDistance,
        shouldYield: false,
        pendingReplies: allies.length,
        timer: setTimeout(() => {
          if (!this.pendingClaims.has(parcelId)) return;
          this.pendingClaims.delete(parcelId);
          resolve(pending.shouldYield ? 'yield' : 'claim');
        }, CLAIM_WAIT_MS),
        // NOTE: do NOT unref this timer — it is awaited by caller code
        resolve,
      };
      this.pendingClaims.set(parcelId, pending);

      for (const allyId of allies) {
        this.msgHandler.askTo(allyId, claimMsg).then((reply) => {
          const p = this.pendingClaims.get(parcelId);
          if (!p) return; // already resolved (timeout or earlier yield)

          const allyYields = reply != null &&
            typeof reply === 'object' &&
            'yield' in (reply as object) &&
            (reply as { yield: boolean }).yield === true;

          if (!allyYields) {
            // Ally does NOT yield → we must yield
            clearTimeout(p.timer);
            this.pendingClaims.delete(parcelId);
            resolve('yield');
            return;
          }

          p.pendingReplies--;
          if (p.pendingReplies <= 0) {
            clearTimeout(p.timer);
            this.pendingClaims.delete(parcelId);
            resolve('claim');
          }
        }).catch(() => {
          // Ask failed (ally unreachable) — treat as ally yielding; we may still win
          const p = this.pendingClaims.get(parcelId);
          if (!p) return;
          p.pendingReplies--;
          if (p.pendingReplies <= 0) {
            clearTimeout(p.timer);
            this.pendingClaims.delete(parcelId);
            resolve('claim');
          }
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Parcel IDs that connected allies have claimed — agent should not target these. */
  getClaimedByOthers(): Set<string> {
    return new Set(this.claimedByOthers.keys());
  }

  /** Number of allies currently considered connected. */
  getAllyCount(): number {
    let n = 0;
    for (const ally of this.allies.values()) {
      if (ally.connected) n++;
    }
    return n;
  }

  /** IDs of all connected allies. */
  getConnectedAllyIds(): string[] {
    const result: string[] = [];
    for (const [id, ally] of this.allies) {
      if (ally.connected) result.push(id);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Internal — message dispatch
  // ---------------------------------------------------------------------------

  private _handleMessage(from: string, msg: InterAgentMessage): void {
    // Reject messages where the payload identity doesn't match the transport sender
    if (msg.agentId !== from) return;

    // Replay protection: drop stale or out-of-order messages
    if (msg.seq <= (this.lastSeqBySender.get(from) ?? -1)) return;
    if (Date.now() - msg.timestamp > AllyTracker.REPLAY_WINDOW_MS) return;
    this.lastSeqBySender.set(from, msg.seq);

    // Refresh contact time for known allies
    const ally = this.allies.get(msg.agentId);
    if (ally) {
      ally.lastContactAt = Date.now();
      if (!ally.connected) ally.connected = true;
    }

    switch (msg.type) {
      case 'hello':
        this._onHello(from, msg as HelloMessage);
        break;
      case 'belief_share':
        this._onBeliefShare(msg as BeliefShareMessage);
        break;
      case 'parcel_claim':
        this._onParcelClaim(from, msg as ParcelClaimMessage);
        break;
      // parcel_claim_ack: handled via emitAsk reply callback, not as a message
      // intention_announce / intention_release: reserved for future use
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — hello
  // ---------------------------------------------------------------------------

  private _onHello(from: string, msg: HelloMessage): void {
    const isNew = !this.allies.has(msg.agentId);

    if (isNew) {
      this.allies.set(msg.agentId, {
        agentId: msg.agentId,
        role: msg.role,
        lastContactAt: Date.now(),
        connected: true,
      });
      this.beliefs.registerAlly(msg.agentId);
      this.msgHandler.addAllowedSender(msg.agentId);

      // Reply with our own hello so the ally can register us immediately
      this.msgHandler.sendTo(from, makeHello(this.agentId, this.role));
    } else {
      // Update role in case it changed
      const existing = this.allies.get(msg.agentId)!;
      existing.lastContactAt = Date.now();
      existing.connected = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — belief sharing
  // ---------------------------------------------------------------------------

  private _onBeliefShare(msg: BeliefShareMessage): void {
    this.beliefs.mergeRemoteBelief(msg.snapshot);
  }

  private _broadcastBeliefShare(): void {
    if (this.getAllyCount() === 0) return;
    const snapshot = this.beliefs.toSnapshot();
    this.msgHandler.broadcast(makeBeliefShare(this.agentId, snapshot));
  }

  // ---------------------------------------------------------------------------
  // Internal — heartbeat
  // ---------------------------------------------------------------------------

  private _broadcastHello(): void {
    this.msgHandler.broadcast(makeHello(this.agentId, this.role));
  }

  // ---------------------------------------------------------------------------
  // Internal — parcel claim handling
  // ---------------------------------------------------------------------------

  private _onParcelClaim(from: string, msg: ParcelClaimMessage): void {
    const { parcelId, distance: allyDistance, agentId: allyId } = msg;

    // Compute our own distance to this parcel
    const parcel = this.beliefs.getParcelBeliefs().find(p => p.id === parcelId);
    const selfPos = this.beliefs.getSelf().position;
    const myDistance = parcel
      ? manhattanDistance(selfPos, parcel.position)
      : Infinity;

    const iWin = this._hasPriority(myDistance, this.agentId, allyDistance, allyId);

    // Build the ack: yield=true means WE yield to the ally; yield=false means ally yields to us
    const ack = makeParcelClaimAck(this.agentId, parcelId, !iWin);

    // Reply immediately via the ask reply callback if available; fall back to sendTo
    const replyFn = this.msgHandler.consumeReply(msg.seq);
    if (replyFn) {
      replyFn(ack);
    } else {
      this.msgHandler.sendTo(from, ack);
    }

    if (iWin) {
      // Remove any prior claim record for this parcel from this ally
      if (this.claimedByOthers.get(parcelId) === allyId) {
        this.claimedByOthers.delete(parcelId);
      }
    } else {
      // We yield — ally has priority
      this.claimedByOthers.set(parcelId, allyId);
    }

    // Resolve any simultaneous outgoing claim for the same parcel immediately
    const pending = this.pendingClaims.get(parcelId);
    if (pending && !iWin) {
      pending.shouldYield = true;
      clearTimeout(pending.timer);
      this.pendingClaims.delete(parcelId);
      pending.resolve('yield');
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — stale detection
  // ---------------------------------------------------------------------------

  private _checkStaleAllies(): void {
    const now = Date.now();
    for (const [id, ally] of this.allies) {
      if (ally.connected && now - ally.lastContactAt > STALE_TIMEOUT_MS) {
        ally.connected = false;
        this.beliefs.unregisterAlly(id);
        // Release any claims held by this ally
        for (const [parcelId, claimerId] of this.claimedByOthers) {
          if (claimerId === id) this.claimedByOthers.delete(parcelId);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — priority comparison
  // ---------------------------------------------------------------------------

  /**
   * Returns true if (distA, idA) has priority over (distB, idB).
   * Shorter distance wins; ties broken by lexicographically smaller agentId.
   */
  private _hasPriority(
    distA: number, idA: string,
    distB: number, idB: string,
  ): boolean {
    if (distA !== distB) return distA < distB;
    return idA < idB;
  }
}
