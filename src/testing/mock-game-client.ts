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
}

const DEFAULT_ACTION_CONFIG: MockActionConfig = {
  moveSucceeds: true,
  pickupResult: [],
  putdownResult: [],
  actionDelayMs: 0,
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
    this.actionConfig = { ...DEFAULT_ACTION_CONFIG };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
