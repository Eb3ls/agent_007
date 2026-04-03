// ============================================================
// src/testing/mock-game-client.ts — Mock GameClient for unit tests
// Simulates server events and action responses without a real socket.
// ============================================================

import type {
  Tile,
  Direction,
  RawSelfSensing,
  RawParcelSensing,
  RawAgentSensing,
  InterAgentMessage,
  GameClient,
} from '../types.js';

// --- Configurable action results ---

export interface MockActionConfig {
  /** If true, move() always returns false (simulating blocked movement). Default: true (success). */
  moveSucceeds: boolean;
  /** Parcels returned by pickup(). Default: []. */
  pickupResult: ReadonlyArray<RawParcelSensing>;
  /** Parcels returned by putdown(). Default: []. */
  putdownResult: ReadonlyArray<RawParcelSensing>;
  /** Simulated action duration in ms. Default: 0 (instant). */
  actionDelayMs: number;
  /** Simulated server capacity (GAME.player.capacity). Default: Infinity (no limit). */
  serverCapacity: number;
}

const DEFAULT_ACTION_CONFIG: MockActionConfig = {
  moveSucceeds: true,
  pickupResult: [],
  putdownResult: [],
  actionDelayMs: 0,
  serverCapacity: Infinity,
};

// --- Callback types (mirrors game-client.ts) ---

type MapCallback = (tiles: ReadonlyArray<Tile>, width: number, height: number) => void;
type YouCallback = (self: RawSelfSensing) => void;
type ParcelsCallback = (parcels: ReadonlyArray<RawParcelSensing>) => void;
type AgentsCallback = (agents: ReadonlyArray<RawAgentSensing>) => void;
type MessageCallback = (from: string, msg: InterAgentMessage) => void;
type VoidCallback = () => void;

export class MockGameClient implements GameClient {
  // Callback registrations
  private mapCallbacks: MapCallback[] = [];
  private youCallbacks: YouCallback[] = [];
  private parcelsCallbacks: ParcelsCallback[] = [];
  private agentsCallbacks: AgentsCallback[] = [];
  private messageCallbacks: MessageCallback[] = [];
  private disconnectCallbacks: VoidCallback[] = [];
  private reconnectCallbacks: VoidCallback[] = [];

  // Action configuration
  private actionConfig: MockActionConfig;

  // Recorded actions for assertions
  readonly moveHistory: Direction[] = [];
  readonly pickupCount = { value: 0 };
  readonly putdownCount = { value: 0 };
  readonly sentMessages: Array<{ toId: string; msg: InterAgentMessage }> = [];
  readonly broadcastedMessages: InterAgentMessage[] = [];
  /** Pending emitAsk calls awaiting test-side resolution. */
  readonly pendingAsks: Array<{
    toId: string;
    msg: InterAgentMessage;
    resolve: (reply: unknown) => void;
  }> = [];
  /** Reply callbacks stored when emitMessageWithReply is used. */
  private readonly pendingReplies = new Map<number, (data: unknown) => void>();

  private connected = false;
  private measuredDuration = 500;

  constructor(config?: Partial<MockActionConfig>) {
    this.actionConfig = { ...DEFAULT_ACTION_CONFIG, ...config };
  }

  // --- GameClient interface: Connection ---

  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    for (const cb of this.disconnectCallbacks) cb();
  }

  // --- GameClient interface: Actions ---

  async move(direction: Direction): Promise<boolean> {
    this.moveHistory.push(direction);
    if (this.actionConfig.actionDelayMs > 0) {
      await delay(this.actionConfig.actionDelayMs);
    }
    return this.actionConfig.moveSucceeds;
  }

  async pickup(): Promise<ReadonlyArray<RawParcelSensing>> {
    this.pickupCount.value++;
    if (this.actionConfig.actionDelayMs > 0) {
      await delay(this.actionConfig.actionDelayMs);
    }
    return this.actionConfig.pickupResult;
  }

  async putdown(): Promise<ReadonlyArray<RawParcelSensing>> {
    this.putdownCount.value++;
    if (this.actionConfig.actionDelayMs > 0) {
      await delay(this.actionConfig.actionDelayMs);
    }
    return this.actionConfig.putdownResult;
  }

  // --- GameClient interface: Messaging ---

  sendMessage(toId: string, msg: InterAgentMessage): void {
    this.sentMessages.push({ toId, msg });
  }

  broadcastMessage(msg: InterAgentMessage): void {
    this.broadcastedMessages.push(msg);
  }

  askMessage(toId: string, msg: InterAgentMessage): Promise<unknown> {
    return new Promise((resolve) => {
      this.pendingAsks.push({ toId, msg, resolve });
    });
  }

  consumeReply(seq: number): ((data: unknown) => void) | undefined {
    const fn = this.pendingReplies.get(seq);
    this.pendingReplies.delete(seq);
    return fn;
  }

  // --- GameClient interface: Event subscriptions ---

  onMap(cb: MapCallback): void {
    this.mapCallbacks.push(cb);
  }

  onYou(cb: YouCallback): void {
    this.youCallbacks.push(cb);
  }

  onParcelsSensing(cb: ParcelsCallback): void {
    this.parcelsCallbacks.push(cb);
  }

  onAgentsSensing(cb: AgentsCallback): void {
    this.agentsCallbacks.push(cb);
  }

  onMessage(cb: MessageCallback): void {
    this.messageCallbacks.push(cb);
  }

  onDisconnect(cb: VoidCallback): void {
    this.disconnectCallbacks.push(cb);
  }

  onReconnect(cb: VoidCallback): void {
    this.reconnectCallbacks.push(cb);
  }

  // --- GameClient interface: Buffer & Metrics ---

  drainPending(): void {
    // No buffering needed in mock — events fire immediately
  }

  getMeasuredActionDurationMs(): number {
    return this.measuredDuration;
  }

  getServerCapacity(): number {
    return this.actionConfig.serverCapacity;
  }

  getParcelsObservationDistance(): number {
    return 0;
  }

  getServerConfig(): { PARCEL_DECADING_INTERVAL?: string; [key: string]: unknown } | null {
    return null;
  }

  // --- Test helpers: Emit events on demand ---

  emitMap(tiles: ReadonlyArray<Tile>, width: number, height: number): void {
    for (const cb of this.mapCallbacks) cb(tiles, width, height);
  }

  emitYou(self: RawSelfSensing): void {
    for (const cb of this.youCallbacks) cb(self);
  }

  emitParcelsSensing(parcels: ReadonlyArray<RawParcelSensing>): void {
    for (const cb of this.parcelsCallbacks) cb(parcels);
  }

  emitAgentsSensing(agents: ReadonlyArray<RawAgentSensing>): void {
    for (const cb of this.agentsCallbacks) cb(agents);
  }

  emitMessage(from: string, msg: InterAgentMessage): void {
    for (const cb of this.messageCallbacks) cb(from, msg);
  }

  /**
   * Simulate an incoming message that arrived via emitAsk (includes a reply callback).
   * The reply fn is stored so that AllyTracker._onParcelClaim can consume it.
   */
  emitMessageWithReply(
    from: string,
    msg: InterAgentMessage,
    reply: (data: unknown) => void,
  ): void {
    if ('seq' in msg) {
      this.pendingReplies.set((msg as { seq: number }).seq, reply);
    }
    for (const cb of this.messageCallbacks) cb(from, msg);
  }

  /**
   * Resolve a pending askMessage call (simulates ally replying to a parcel claim).
   * @param toId  — the ally that was asked
   * @param parcelId — the parcel being claimed
   * @param allyYields — true: ally yields to us (we win); false: ally does not yield (we lose)
   */
  resolveAsk(toId: string, parcelId: string, allyYields: boolean): void {
    const idx = this.pendingAsks.findIndex(
      a => a.toId === toId && (a.msg as { parcelId?: string }).parcelId === parcelId,
    );
    if (idx >= 0) {
      const ask = this.pendingAsks.splice(idx, 1)[0];
      ask.resolve({ type: 'parcel_claim_ack', yield: allyYields, parcelId });
    }
  }

  emitDisconnect(): void {
    for (const cb of this.disconnectCallbacks) cb();
  }

  emitReconnect(): void {
    for (const cb of this.reconnectCallbacks) cb();
  }

  // --- Test helpers: Configuration ---

  setActionConfig(config: Partial<MockActionConfig>): void {
    this.actionConfig = { ...this.actionConfig, ...config };
  }

  setMeasuredActionDurationMs(ms: number): void {
    this.measuredDuration = ms;
  }

  isConnected(): boolean {
    return this.connected;
  }

  reset(): void {
    this.moveHistory.length = 0;
    this.pickupCount.value = 0;
    this.putdownCount.value = 0;
    this.sentMessages.length = 0;
    this.broadcastedMessages.length = 0;
    this.pendingAsks.length = 0;
    this.pendingReplies.clear();
    this.actionConfig = { ...DEFAULT_ACTION_CONFIG };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
