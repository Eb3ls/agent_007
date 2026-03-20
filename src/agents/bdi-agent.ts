// ============================================================
// src/agents/bdi-agent.ts — BDI Agent (T15)
// Sense-Deliberate-Plan-Execute loop using BeliefStore,
// Deliberator, BfsPlanner, PlanValidator, and ActionExecutor.
// ============================================================

import { randomUUID } from 'crypto';
import type {
  AgentConfig,
  AgentRole,
  GameClient,
  IAgent,
  Intention,
  ParcelBelief,
  Plan,
  PlanStep,
  Position,
} from '../types.js';
import { manhattanDistance, positionEquals } from '../types.js';
import { BeliefStore } from '../beliefs/belief-store.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import { ActionExecutor } from '../execution/action-executor.js';
import { Deliberator } from '../deliberation/deliberator.js';
import { BfsPlanner } from '../planning/bfs-planner.js';
import { PddlPlanner } from '../planning/pddl-planner.js';
import { PlanValidator } from '../planning/plan-validator.js';
import type { IPlanner } from '../types.js';
import { findPath } from '../pathfinding/pathfinder.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { MetricsCollector } from '../metrics/metrics-collector.js';
import { formatSummary } from '../metrics/metrics-snapshot.js';
import { MessageHandler } from '../communication/message-handler.js';
import { AllyTracker } from '../communication/ally-tracker.js';

/** Interval between periodic deliberation checks (milliseconds). */
const DELIBERATION_INTERVAL_MS = 2_000;

export class BdiAgent implements IAgent {
  // IAgent interface
  private _id = '';
  get id(): string { return this._id; }
  readonly role: AgentRole = 'bdi';

  // Internals
  private client!: GameClient;
  private config!: AgentConfig;
  private beliefs: BeliefStore | null = null;
  private deliberator!: Deliberator;
  private planner!: IPlanner;
  private bfsFallback: BfsPlanner | null = null;
  private validator!: PlanValidator;
  private executor!: ActionExecutor;
  private log!: Logger;

  // Comms
  private msgHandler: MessageHandler | null = null;
  private allyTracker: AllyTracker | null = null;

  // Metrics
  private metrics: MetricsCollector | null = null;
  private metricsOutputPath = '';

  // State
  private currentIntention: Intention | null = null;
  private lastLoggedScore = -1;
  private running = false;
  private planning = false;
  private deliberateTimer: ReturnType<typeof setInterval> | null = null;
  private sigintHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;

  // Stagnation detection
  private lastKnownScore = 0;
  private lastScoreChangeAt = 0;
  private stagnationTimeoutMs = 15_000;

  // ---------------------------------------------------------------------------
  // IAgent lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Wire GameClient events to BeliefStore.
   * Call this BEFORE drainPending() so buffered events are processed.
   */
  async init(client: GameClient, config: AgentConfig): Promise<void> {
    this.client = client;
    this.config = config;
    this.log = createLogger('bdi-agent', config.logLevel);

    this.deliberator = new Deliberator();
    if (config.planner === 'pddl') {
      this.planner     = new PddlPlanner();
      this.bfsFallback = new BfsPlanner();
    } else {
      this.planner = new BfsPlanner();
    }
    this.validator   = new PlanValidator();

    if (config.metrics?.enabled !== false) {
      this.metrics = new MetricsCollector(
        config.role,
        config.metrics?.sampleIntervalMs ?? 5_000,
      );
      this.metricsOutputPath = config.metrics?.outputPath ?? `logs/${config.role}-metrics.json`;
    }

    // Map event initializes BeliefStore (fires on drainPending / reconnect).
    // Guard: only create a new BeliefStore on the first fire — the map layout does
    // not change on reconnect and we must not lose accumulated beliefs.
    client.onMap((tiles, width, height) => {
      if (this.beliefs) return; // already initialized — skip on reconnect
      const map = new BeliefMapImpl([...tiles], width, height);
      this.beliefs = new BeliefStore(map);
      this.beliefs.setCapacity(client.getServerCapacity());
      this.beliefs.setObservationDistance(client.getParcelsObservationDistance());
      this.executor = new ActionExecutor(client);
    });

    client.onYou(self => {
      if (!this.beliefs) return;
      if (!this._id) {
        this._id = self.id;
        this.metrics?.setAgentId(self.id);

        // Wire up comms once we know our own ID
        if (config.teamId && this.beliefs) {
          this.msgHandler  = new MessageHandler(client, self.id);
          this.allyTracker = new AllyTracker(
            this.msgHandler,
            this.beliefs,
            self.id,
            this.role,
          );
        }
      }
      this.beliefs.updateSelf(self);
      this.metrics?.recordScore(self.score);
      if (self.score !== this.lastKnownScore) {
        this.lastKnownScore = self.score;
        this.lastScoreChangeAt = Date.now();
      }
      if (self.score > 0 && self.score !== this.lastLoggedScore) {
        this.lastLoggedScore = self.score;
        this.log.info({ kind: 'score_update', score: self.score });
      }
    });

    client.onParcelsSensing(parcels => {
      if (!this.beliefs) return;
      this.beliefs.updateParcels(parcels);
      if (this.running) this._scheduleDeliberation();
    });

    client.onAgentsSensing(agents => {
      if (!this.beliefs) return;
      this.beliefs.updateAgents(agents);
    });

    client.onDisconnect(() => {
      this.log.warn({ kind: 'connection_lost' });
      // Cancel any in-flight action so it isn't replayed on reconnect
      if (this.executor) this.executor.cancelCurrentPlan();
      this.currentIntention = null;
    });

    client.onReconnect(() => {
      this.log.info({ kind: 'connection_restored' });
      // Clear beliefs that may have gone stale during the outage
      this.beliefs?.clearStaleBeliefs();
      // Re-announce presence to allies (they may have timed us out)
      this.allyTracker?.onReconnect();
      // Kick off a fresh deliberation cycle
      if (this.running) this._scheduleDeliberation();
    });
  }

  /**
   * Start the sense-deliberate-plan-execute loop.
   * Requires init() to have been called and drainPending() to have fired the map event.
   */
  async start(): Promise<void> {
    if (!this.beliefs || !this.executor) {
      throw new Error(
        'BdiAgent.start() called before the map event was received. ' +
        'Call init(), then drainPending(), then start().',
      );
    }

    this.running = true;
    this.metrics?.start();
    this.stagnationTimeoutMs = this.config.stagnationTimeoutMs ?? 15_000;
    this.lastScoreChangeAt = Date.now();

    // Start ally coordination
    this.allyTracker?.start();

    // Wire executor callbacks
    this.executor.onPutdown(_count => {
      this.beliefs?.clearDeliveredParcels();
    });

    this.executor.onPlanComplete(plan => {
      const deliveredReward = plan.steps.some(s => s.action === 'putdown')
        ? plan.estimatedReward
        : 0;
      if (deliveredReward > 0) this.metrics?.recordParcelDelivered(deliveredReward);
      this.currentIntention = null;
      this._scheduleDeliberation();
    });

    this.executor.onStepComplete((_step, _idx) => {
      // Re-check after each step so replanning uses the up-to-date position.
      this._scheduleDeliberation();
    });

    this.executor.onStepFailed((step, idx, reason) => {
      const selfPos = this.beliefs?.getSelf().position;
      const detail = `step[${idx}] ${step.action} to (${step.expectedPosition.x},${step.expectedPosition.y}) from (${selfPos?.x},${selfPos?.y})`;
      this.log.warn({ kind: 'plan_failed', plannerName: 'bfs', error: `${reason} — ${detail}` });
      this.currentIntention = null;
      this._scheduleDeliberation(/* planFailed= */ true);
    });

    // Periodic replan check + stagnation detection
    this.deliberateTimer = setInterval(() => {
      this._checkStagnation();
      this._scheduleDeliberation();
    }, DELIBERATION_INTERVAL_MS);
    this.deliberateTimer.unref();

    // Signal handlers for graceful shutdown
    const shutdown = async (): Promise<void> => { await this.stop(); process.exit(0); };
    this.sigintHandler  = () => { void shutdown(); };
    this.sigtermHandler = () => { void shutdown(); };
    process.on('SIGINT',  this.sigintHandler);
    process.on('SIGTERM', this.sigtermHandler);

    // Kick off first deliberation cycle
    this._scheduleDeliberation();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.deliberateTimer) {
      clearInterval(this.deliberateTimer);
      this.deliberateTimer = null;
    }

    this.allyTracker?.stop();
    this.planner.abort();
    this.bfsFallback?.abort();
    if (this.executor) this.executor.cancelCurrentPlan();

    if (this.sigintHandler)  process.removeListener('SIGINT',  this.sigintHandler);
    if (this.sigtermHandler) process.removeListener('SIGTERM', this.sigtermHandler);

    if (this.metrics) {
      this.metrics.stop();
      console.log(formatSummary(this.metrics.snapshot()));
      await this.metrics.exportJson(this.metricsOutputPath).catch(err => {
        console.error('Failed to export metrics:', err);
      });
    }

    this.client.disconnect();
  }

  // ---------------------------------------------------------------------------
  // Deliberation
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Stagnation detection
  // ---------------------------------------------------------------------------

  /**
   * Check if the agent has been stuck (score not increasing) for too long.
   * Fires at most once per stagnationTimeoutMs period by resetting the timer after firing.
   * Only triggers when actively pursuing a pickup/cluster intention.
   */
  private _checkStagnation(): void {
    if (!this.running || !this.beliefs) return;
    // Only detect stagnation when pursuing a real goal, not while exploring or idle
    if (!this.currentIntention || this.currentIntention.type === 'explore') return;
    const elapsed = Date.now() - this.lastScoreChangeAt;
    if (elapsed < this.stagnationTimeoutMs) return;

    const secondsSinceLastScore = Math.round(elapsed / 1000);
    this.log.warn({ kind: 'stagnation_detected', secondsSinceLastScore });
    this.metrics?.recordStagnation();

    // Abandon the stuck intention — next deliberation will explore or try a different parcel
    this.executor.cancelCurrentPlan();
    this.currentIntention = null;

    // Reset timer so stagnation doesn't fire again immediately
    this.lastScoreChangeAt = Date.now();
  }

  /**
   * Enqueue a deliberation pass (debounced by planning flag).
   * planFailed=true bypasses the shouldReplan threshold check.
   */
  private _scheduleDeliberation(planFailed = false): void {
    if (!this.running || !this.beliefs || this.planning) return;
    // Don't replan while a move is in-flight — new plan would use stale pre-move position
    if (!planFailed && this.executor?.getInFlightAction() !== null) return;
    if (planFailed) {
      // Brief pause to let dynamic obstacles (NPCs) move away before replanning
      setTimeout(() => { if (this.running) void this._deliberateAndPlan(planFailed); }, 150);
    } else {
      void this._deliberateAndPlan(planFailed);
    }
  }

  private async _deliberateAndPlan(planFailed = false): Promise<void> {
    if (this.planning) return;
    this.planning = true;

    try {
      if (!this.beliefs || !this.running) return;

      const movementDurationMs = this.client.getMeasuredActionDurationMs();
      const tracker = this.beliefs.getParcelTracker();

      const needsReplan =
        planFailed ||
        this.deliberator.shouldReplan(this.currentIntention, this.beliefs, planFailed, movementDurationMs, tracker) ||
        this.executor.isIdle();

      if (!needsReplan) return;

      // Cancel current plan if replan is warranted
      if (this.currentIntention !== null && (planFailed || this.deliberator.shouldReplan(this.currentIntention, this.beliefs, false, movementDurationMs, tracker))) {
        this.executor.cancelCurrentPlan();
        this.log.info({ kind: 'replan_triggered', reason: planFailed ? 'plan_failed' : 'better_option_or_target_gone' });
        this.log.info({ kind: 'intention_dropped', intentionId: this.currentIntention.id, reason: planFailed ? 'plan_failed' : 'superseded' });
        this.currentIntention = null;
      }

      const self = this.beliefs.getSelf();

      // If at capacity, skip deliberation and deliver immediately
      if (self.carriedParcels.length >= this.beliefs.getCapacity()) {
        await this._planDelivery();
        return;
      }

      // If carrying parcels and no reachable ground parcels → deliver what we have
      if (self.carriedParcels.length > 0) {
        const reachable = this.beliefs.getReachableParcels();
        if (reachable.length === 0) {
          await this._planDelivery();
          return;
        }
      }

      // Deliberate: select best intention, excluding parcels claimed by allies
      const claimedByOthers = this.allyTracker?.getClaimedByOthers() ?? new Set<string>();
      const candidates = this.deliberator.evaluate(this.beliefs, movementDurationMs, tracker)
        .filter(intention => !intention.targetParcels.some(id => claimedByOthers.has(id)));

      if (candidates.length === 0) {
        if (self.carriedParcels.length > 0) await this._planDelivery();
        return;
      }

      const best = candidates[0]!;

      // Handle explore intentions — no parcels to pick up, just move to target
      if (best.type === 'explore') {
        // Skip if already executing an explore plan toward the same tile
        if (
          this.currentIntention?.type === 'explore' &&
          positionEquals(this.currentIntention.targetPosition, best.targetPosition) &&
          !this.executor.isIdle()
        ) return;
        this.currentIntention = best;
        this.log.info({ kind: 'intention_set', intentionId: best.id, type: best.type, utility: best.utility });
        await this._planExplore(best.targetPosition);
        return;
      }

      // Don't replan if intention unchanged and executor is busy
      if (this.currentIntention?.id === best.id && !this.executor.isIdle()) return;

      // Parcel claim negotiation with allies
      if (this.allyTracker && best.targetParcels.length > 0) {
        const parcelId = best.targetParcels[0]!;
        const parcel = this.beliefs.getParcelBeliefs().find(p => p.id === parcelId);
        if (parcel) {
          const dist = manhattanDistance(self.position, parcel.position);
          const result = await this.allyTracker.claimParcel(parcelId, dist);
          if (result === 'yield') {
            this.log.info({ kind: 'intention_dropped', intentionId: best.id, reason: 'ally_has_priority' });
            return;
          }
        }
      }

      this.currentIntention = best;
      this.log.info({ kind: 'intention_set', intentionId: best.id, type: best.type, utility: best.utility });

      // Resolve target parcel beliefs
      const allParcels = this.beliefs.getParcelBeliefs();
      const targetParcels = best.targetParcels
        .map(id => allParcels.find(p => p.id === id))
        .filter((p): p is ParcelBelief => p !== undefined && p.carriedBy === null);

      if (targetParcels.length === 0) {
        this.currentIntention = null;
        return;
      }

      // Plan — pass current agent positions as dynamic obstacles so BFS avoids occupied tiles
      const deliveryZones = Array.from(this.beliefs.getMap().getDeliveryZones());
      const agentObstacles = this.beliefs.getAgentBeliefs().map(a => a.position);
      const planningRequest = {
        currentPosition:  self.position,
        carriedParcels:   self.carriedParcels as ReadonlyArray<ParcelBelief>,
        targetParcels,
        deliveryZones,
        beliefMap:        this.beliefs.getMap(),
        constraints:      agentObstacles.length > 0 ? { avoidPositions: agentObstacles } : undefined,
      };

      const planStart = Date.now();
      let planResult = await this.planner.plan(planningRequest);
      this.metrics?.recordPlannerCall(this.planner.name, Date.now() - planStart, planResult.success);

      // Fall back to BFS if primary planner (PDDL) failed
      if (!planResult.success && this.bfsFallback) {
        this.log.warn({ kind: 'llm_fallback', reason: planResult.error ?? 'pddl_failed' });
        const bfsStart = Date.now();
        planResult = await this.bfsFallback.plan(planningRequest);
        this.metrics?.recordPlannerCall('bfs', Date.now() - bfsStart, planResult.success);
      }

      if (!planResult.success || !planResult.plan) {
        this.log.warn({ kind: 'plan_failed', plannerName: planResult.metadata.plannerName, error: planResult.error ?? 'unknown' });
        this.currentIntention = null;
        return;
      }

      this.log.info({
        kind:        'plan_generated',
        plannerName: planResult.metadata.plannerName,
        steps:       planResult.plan.steps.length,
        timeMs:      planResult.metadata.computeTimeMs,
      });

      // Validate
      const vr = this.validator.validate(planResult.plan, this.beliefs);
      if (!vr.valid) {
        this.log.warn({ kind: 'plan_failed', plannerName: 'bfs', error: vr.reason ?? 'validation failed' });
        this.currentIntention = null;
        return;
      }

      // Stamp intention ID and execute
      const plan: Plan = { ...planResult.plan, intentionId: best.id };
      this.executor.executePlan(plan);

    } finally {
      this.planning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Delivery-only plan (agent is already carrying parcels, no new targets)
  // ---------------------------------------------------------------------------

  private async _planDelivery(): Promise<void> {
    if (!this.beliefs) return;
    const self     = this.beliefs.getSelf();
    const delivery = this.beliefs.getNearestDeliveryZone(self.position);
    if (!delivery) return;

    const agentObstacles = this.beliefs.getAgentBeliefs().map(a => a.position);
    const path = findPath(self.position, delivery, this.beliefs.getMap(), agentObstacles.length > 0 ? agentObstacles : undefined);
    if (!path) return;

    const steps: PlanStep[] = [];
    for (let i = 1; i < path.length; i++) {
      steps.push({ action: _posToAction(path[i - 1]!, path[i]!), expectedPosition: path[i]! });
    }
    steps.push({ action: 'putdown', expectedPosition: delivery });

    const plan: Plan = {
      id:              randomUUID(),
      intentionId:     this.currentIntention?.id ?? '',
      steps,
      estimatedReward: self.carriedParcels.reduce((s, p) => s + p.estimatedReward, 0),
      createdAt:       Date.now(),
    };

    this.log.info({ kind: 'plan_generated', plannerName: 'bfs', steps: plan.steps.length, timeMs: 0 });
    this.executor.executePlan(plan);
  }

  // ---------------------------------------------------------------------------
  // Explore plan (agent moves to a spawning tile to discover new parcels)
  // ---------------------------------------------------------------------------

  private async _planExplore(target: Position): Promise<void> {
    if (!this.beliefs) return;
    const self = this.beliefs.getSelf();
    if (positionEquals(self.position, target)) {
      // Already there — clear intention so next cycle picks a new target
      this.currentIntention = null;
      return;
    }
    const agentObstacles = this.beliefs.getAgentBeliefs().map(a => a.position);
    const path = findPath(
      self.position,
      target,
      this.beliefs.getMap(),
      agentObstacles.length > 0 ? agentObstacles : undefined,
    );
    if (!path || path.length <= 1) {
      this.currentIntention = null;
      return;
    }
    const steps: PlanStep[] = [];
    for (let i = 1; i < path.length; i++) {
      steps.push({ action: _posToAction(path[i - 1]!, path[i]!), expectedPosition: path[i]! });
    }
    const plan: Plan = {
      id: randomUUID(),
      intentionId: this.currentIntention?.id ?? '',
      steps,
      estimatedReward: 0,
      createdAt: Date.now(),
    };
    this.log.info({ kind: 'plan_generated', plannerName: 'bfs', steps: plan.steps.length, timeMs: 0 });
    this.executor.executePlan(plan);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _posToAction(from: Position, to: Position): PlanStep['action'] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 1)  return 'move_right';
  if (dx === -1) return 'move_left';
  if (dy === 1)  return 'move_up';
  if (dy === -1) return 'move_down';
  throw new Error(`Non-adjacent positions: (${from.x},${from.y})→(${to.x},${to.y})`);
}

