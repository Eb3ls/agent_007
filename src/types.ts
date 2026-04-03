// ============================================================
// src/types.ts — All shared type definitions
// Transcribed from ARCHITECTURE.md Step 4
// ============================================================

// --- Game Primitives ---

// 0: non-walkable/wall, 1: parcel-spawning, 2: delivery zone, 3: walkable,
// 4: one-way ↑ (can only be entered moving up,    dy=+1),
// 5: one-way ↓ (can only be entered moving down,  dy=-1),
// 6: one-way ← (can only be entered moving left,  dx=-1),
// 7: one-way → (can only be entered moving right, dx=+1)
export type TileType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Tile {
  readonly x: number;
  readonly y: number;
  readonly type: TileType;
}

export interface Position {
  readonly x: number;
  readonly y: number;
}

export function positionEquals(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

export function manhattanDistance(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// --- Sensing Payloads ---

export interface RawParcelSensing {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly carriedBy: string | null;
  readonly reward: number;
}

export interface RawAgentSensing {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

export interface RawSelfSensing {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly score: number;
  readonly penalty?: number;
}

// --- Belief Types ---

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface ParcelBelief {
  readonly id: string;
  readonly position: Position;
  readonly carriedBy: string | null;
  readonly reward: number;
  readonly estimatedReward: number;
  readonly lastSeen: number;
  readonly confidence: number;
  readonly decayRatePerMs: number;
}

export interface AgentBelief {
  readonly id: string;
  readonly name: string;
  readonly position: Position;
  readonly score: number;
  readonly lastSeen: number;
  readonly confidence: number;
  readonly heading: Direction | null;
  readonly isAlly: boolean;
}

export interface SelfBelief {
  readonly id: string;
  readonly name: string;
  readonly position: Position;
  readonly score: number;
  readonly penalty: number;
  readonly carriedParcels: ReadonlyArray<ParcelBelief>;
}

// --- Belief Map ---

export interface BeliefMap {
  readonly width: number;
  readonly height: number;
  getTile(x: number, y: number): TileType | null;
  isWalkable(x: number, y: number): boolean;
  /** R02: returns false if directional tile (4–7) blocks entry from the given direction. */
  canEnterFrom(x: number, y: number, from: Direction): boolean;
  isDeliveryZone(x: number, y: number): boolean;
  isSpawningTile(x: number, y: number): boolean;
  getDeliveryZones(): ReadonlyArray<Position>;
  getSpawningTiles(): ReadonlyArray<Position>;
}

// --- Belief Store ---

export type BeliefChangeType =
  | 'parcels_changed'
  | 'agents_changed'
  | 'self_moved'
  | 'self_score_changed'
  | 'remote_belief_merged';

export interface BeliefSnapshot {
  readonly agentId: string;
  readonly timestamp: number;
  readonly selfPosition: Position;
  readonly parcels: ReadonlyArray<{
    id: string;
    position: Position;
    reward: number;
    carriedBy: string | null;
  }>;
  readonly agents: ReadonlyArray<{
    id: string;
    position: Position;
    heading: Direction | null;
  }>;
}

export interface IBeliefStore {
  updateSelf(self: RawSelfSensing): void;
  updateParcels(parcels: ReadonlyArray<RawParcelSensing>): void;
  updateAgents(agents: ReadonlyArray<RawAgentSensing>): void;
  mergeRemoteBelief(snapshot: BeliefSnapshot): void;
  removeParcel(id: string): void;
  clearDeliveredParcels(): void;

  getSelf(): SelfBelief;
  getParcelBeliefs(): ReadonlyArray<ParcelBelief>;
  getAgentBeliefs(): ReadonlyArray<AgentBelief>;
  getMap(): BeliefMap;
  getNearestDeliveryZone(from: Position): Position | null;
  getReachableParcels(): ReadonlyArray<ParcelBelief>;
  /** Maximum number of parcels the agent can carry simultaneously. Infinity if unconstrained. */
  getCapacity(): number;
  /**
   * Returns the nearest unvisited spawning tile for exploration.
   * Falls back to the nearest spawning tile (any) when all have been visited.
   * Returns null if the map has no spawning tiles.
   */
  getExploreTarget(from: Position): Position | null;

  toSnapshot(): BeliefSnapshot;
  onUpdate(callback: (changeType: BeliefChangeType) => void): void;
}

// --- Intentions ---

export type IntentionType =
  | 'pickup_and_deliver'
  | 'explore'
  | 'go_to_delivery'
  | 'wait';

export interface Intention {
  readonly id: string;
  readonly type: IntentionType;
  readonly targetParcels: ReadonlyArray<string>;
  readonly targetPosition: Position;
  readonly utility: number;
  readonly createdAt: number;
}

export interface IIntentionQueue {
  push(intention: Intention): void;
  pop(): Intention | null;
  peek(): Intention | null;
  revise(beliefs: IBeliefStore): void;
  clear(): void;
  size(): number;
  toArray(): ReadonlyArray<Intention>;
}

// --- Plans ---

export type ActionType =
  | 'move_up'
  | 'move_down'
  | 'move_left'
  | 'move_right'
  | 'pickup'
  | 'putdown';

export interface PlanStep {
  readonly action: ActionType;
  readonly expectedPosition: Position;
  readonly metadata?: Record<string, unknown>;
}

export interface Plan {
  readonly id: string;
  readonly intentionId: string;
  readonly steps: ReadonlyArray<PlanStep>;
  readonly estimatedReward: number;
  readonly createdAt: number;
}

// --- Planner Interface ---

export interface PlanningRequest {
  readonly currentPosition: Position;
  readonly carriedParcels: ReadonlyArray<ParcelBelief>;
  readonly targetParcels: ReadonlyArray<ParcelBelief>;
  readonly deliveryZones: ReadonlyArray<Position>;
  readonly beliefMap: BeliefMap;
  readonly constraints?: PlanningConstraints;
}

export interface PlanningConstraints {
  readonly maxPlanLength?: number;
  readonly timeoutMs?: number;
  readonly avoidPositions?: ReadonlyArray<Position>;
}

export interface PlanningResult {
  readonly success: boolean;
  readonly plan: Plan | null;
  readonly metadata: {
    readonly plannerName: string;
    readonly computeTimeMs: number;
    readonly stepsGenerated: number;
  };
  readonly error?: string;
}

export interface IPlanner {
  readonly name: string;
  plan(request: PlanningRequest): Promise<PlanningResult>;
  abort(): void;
}

// --- Action Executor ---

export interface InFlightAction {
  readonly action: ActionType;
  readonly sentAt: number;
  readonly expectedDurationMs: number;
}

export type ReplanReason = 'collision' | 'consecutive_failures' | 'plan_invalid';

export interface ReplanSignal {
  readonly reason: ReplanReason;
  readonly failedStep: PlanStep;
  readonly failureCount: number;
}

export interface IActionExecutor {
  executePlan(plan: Plan): void;
  cancelCurrentPlan(): void;
  isIdle(): boolean;
  getInFlightAction(): InFlightAction | null;
  getCurrentStepIndex(): number;

  onStepComplete(cb: (step: PlanStep, index: number) => void): void;
  onPlanComplete(cb: (plan: Plan) => void): void;
  onStepFailed(cb: (step: PlanStep, index: number, reason: string) => void): void;
  onReplanRequired(cb: (signal: ReplanSignal) => void): void;
  onPutdown(cb: (count: number) => void): void;
}

// --- Agent Interface ---

export type AgentRole = 'bdi' | 'llm' | 'hybrid';

export interface IAgent {
  readonly id: string;
  readonly role: AgentRole;
  init(client: GameClient, config: AgentConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// --- Agent Configuration ---

export type PlannerChoice = 'bfs' | 'pddl' | 'llm';
/** Identifies which planner chain PlannerFactory should build:
 *  'bfs'  → BFS only
 *  'pddl' → PDDL → BFS fallback
 *  'llm'  → LLM → PDDL → BFS fallback
 */
export type PlannerChainType = 'bfs' | 'pddl' | 'llm';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LlmConfig {
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly model: string;
  readonly maxTokenBudget: number;
  readonly minCallIntervalMs: number;
  readonly toolCatalogUrl?: string;
}

export interface MetricsConfig {
  readonly enabled: boolean;
  readonly sampleIntervalMs: number;
  readonly outputPath: string;
}

export interface RecordingConfig {
  readonly enabled: boolean;
  readonly outputPath: string;
}

export interface AgentConfig {
  readonly host: string;
  readonly token: string;
  readonly role: AgentRole;
  readonly planner: PlannerChoice;
  readonly logLevel: LogLevel;
  readonly teamId?: string;
  readonly llm?: LlmConfig;
  readonly metrics?: MetricsConfig;
  readonly recording?: RecordingConfig;
  /** How many ms without a score increase before stagnation is declared. Default: 15000. */
  readonly stagnationTimeoutMs?: number;
}

// --- LLM Memory ---

export interface LlmMemoryContext {
  readonly systemPrompt: string;
  readonly objective: string;
  readonly stateSnapshot: string;
  readonly actionHistory: string;
  readonly sharedBeliefs: string;
  readonly toolCatalog: string;
  readonly totalTokenEstimate: number;
}

// --- Inter-Agent Communication ---

export type InterAgentMessage =
  | HelloMessage
  | BeliefShareMessage
  | IntentionAnnounceMessage
  | IntentionReleaseMessage
  | ParcelClaimMessage
  | ParcelClaimAckMessage;

export interface HelloMessage {
  readonly type: 'hello';
  readonly agentId: string;
  readonly role: AgentRole;
  readonly seq: number;
  readonly timestamp: number;
}

export interface BeliefShareMessage {
  readonly type: 'belief_share';
  readonly agentId: string;
  readonly snapshot: BeliefSnapshot;
  readonly seq: number;
  readonly timestamp: number;
}

export interface IntentionAnnounceMessage {
  readonly type: 'intention_announce';
  readonly agentId: string;
  readonly intentionId: string;
  readonly targetParcelIds: ReadonlyArray<string>;
  readonly intentionType: IntentionType;
  readonly seq: number;
  readonly timestamp: number;
}

export interface IntentionReleaseMessage {
  readonly type: 'intention_release';
  readonly agentId: string;
  readonly intentionId: string;
  readonly seq: number;
  readonly timestamp: number;
}

export interface ParcelClaimMessage {
  readonly type: 'parcel_claim';
  readonly agentId: string;
  readonly parcelId: string;
  readonly distance: number;
  readonly seq: number;
  readonly timestamp: number;
}

export interface ParcelClaimAckMessage {
  readonly type: 'parcel_claim_ack';
  readonly agentId: string;
  readonly parcelId: string;
  readonly yield: boolean;
  readonly seq: number;
  readonly timestamp: number;
}

// --- Logging ---

export type LogEvent =
  | { kind: 'action_sent';       action: ActionType; position: Position }
  | { kind: 'action_result';     action: ActionType; success: boolean; durationMs: number }
  | { kind: 'parcel_sensed';     parcelId: string; position: Position; reward: number }
  | { kind: 'parcel_picked_up';  parcelId: string }
  | { kind: 'parcel_delivered';  parcelId: string; reward: number }
  | { kind: 'parcel_expired';    parcelId: string }
  | { kind: 'intention_set';     intentionId: string; type: IntentionType; utility: number }
  | { kind: 'intention_dropped'; intentionId: string; reason: string }
  | { kind: 'plan_generated';    plannerName: string; steps: number; timeMs: number }
  | { kind: 'plan_failed';       plannerName: string; error: string }
  | { kind: 'replan_triggered';  reason: string }
  | { kind: 'belief_update';     changeType: BeliefChangeType }
  | { kind: 'message_sent';      msgType: string; to: string;   ts?: number }
  | { kind: 'message_received';  msgType: string; from: string; ts?: number }
  | { kind: 'llm_call';          latencyMs: number; tokensUsed: number }
  | { kind: 'llm_fallback';      reason: string }
  | { kind: 'penalty';           cause: string }
  | { kind: 'score_update';      score: number }
  | { kind: 'connection_lost'; }
  | { kind: 'connection_restored'; }
  | { kind: 'stagnation_detected'; secondsSinceLastScore: number };

// --- Metrics ---

export interface MetricsSnapshot {
  readonly agentId: string;
  readonly role: AgentRole;
  readonly sessionStartedAt: number;
  readonly sessionDurationMs: number;
  readonly finalScore: number;
  readonly scoreTimeline: ReadonlyArray<{ t: number; score: number }>;
  readonly parcelsDelivered: number;
  readonly parcelsMissed: number;
  readonly penaltiesReceived: number;
  readonly penaltyCauses: Record<string, number>;
  readonly plannerCalls: Record<string, {
    count: number;
    avgLatencyMs: number;
    failures: number;
  }>;
  readonly llmCalls?: {
    count: number;
    avgLatencyMs: number;
    totalTokensUsed: number;
    fallbackCount: number;
  };
  readonly stagnationsDetected?: number;
  readonly beliefAccuracy?: {
    predictionsChecked: number;
    predictionsCorrect: number;
  };
}

// --- Session Recording ---

export interface SessionEvent {
  readonly timestamp: number;
  readonly source: 'server' | 'agent';
  readonly eventType: string;
  readonly data: unknown;
}

// --- GameClient (forward declaration) ---
// The actual implementation is in src/client/game-client.ts.
// This interface allows other modules to depend on the GameClient shape
// without importing the concrete class (avoids circular dependencies).

export interface GameClient {
  connect(): Promise<void>;
  disconnect(): void;
  move(direction: Direction): Promise<boolean>;
  pickup(): Promise<ReadonlyArray<RawParcelSensing>>;
  putdown(): Promise<ReadonlyArray<RawParcelSensing>>;
  sendMessage(toId: string, msg: InterAgentMessage): void;
  broadcastMessage(msg: InterAgentMessage): void;
  /** Send a targeted message and await a direct reply from the recipient. */
  askMessage(toId: string, msg: InterAgentMessage): Promise<unknown>;
  /** Consume and return the reply callback stored for a given message seq, if any. */
  consumeReply(seq: number): ((data: unknown) => void) | undefined;
  onMap(cb: (tiles: ReadonlyArray<Tile>, width: number, height: number) => void): void;
  onYou(cb: (self: RawSelfSensing) => void): void;
  onParcelsSensing(cb: (parcels: ReadonlyArray<RawParcelSensing>) => void): void;
  onAgentsSensing(cb: (agents: ReadonlyArray<RawAgentSensing>) => void): void;
  onMessage(cb: (from: string, msg: InterAgentMessage) => void): void;
  onDisconnect(cb: () => void): void;
  onReconnect(cb: () => void): void;
  drainPending(): void;
  getMeasuredActionDurationMs(): number;
  /** Maximum parcels the agent can carry simultaneously, from server config. Infinity if unconstrained. */
  getServerCapacity(): number;
  /** Server's unified observation_distance (for all entities); 5 if not yet received. */
  getObservationDistance(): number;
  /** Full server config object; null if not yet received. */
  getServerConfig(): { PARCEL_DECADING_INTERVAL?: string; [key: string]: unknown } | null;
}
