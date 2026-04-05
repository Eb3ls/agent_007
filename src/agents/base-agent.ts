// ============================================================
// src/agents/base-agent.ts — Shared BDI loop (BaseAgent)
// Extracted from bdi-agent.ts and llm-agent.ts.
// Subclasses override buildPlannerChain() to select their planner.
// ============================================================

import { randomUUID } from 'crypto';
import type {
  AgentConfig,
  AgentRole,
  DelibBranch,
  DelibTrigger,
  EvalCandidate,
  GameClient,
  IAgent,
  Intention,
  L1RecordD,
  ParcelBelief,
  Plan,
  PlanStep,
  Position,
} from '../types.js';
import { manhattanDistance, positionEquals } from '../types.js';
import { EvalLogger } from '../evaluation/eval-logger.js';
import { BeliefStore } from '../beliefs/belief-store.js';
import { BeliefMapImpl } from '../beliefs/belief-map.js';
import { ActionExecutor } from '../execution/action-executor.js';
import { Deliberator } from '../deliberation/deliberator.js';
import { computeDeliveryScore, computePickupScore } from '../deliberation/intention.js';
import { PlanValidator } from '../planning/plan-validator.js';
import type { IPlanner } from '../types.js';
import { buildPlannerChain } from '../planning/planner-factory.js';
import { findPath } from '../pathfinding/pathfinder.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { MetricsCollector } from '../metrics/metrics-collector.js';
import { formatSummary } from '../metrics/metrics-snapshot.js';
import { MessageHandler } from '../communication/message-handler.js';
import { AllyTracker } from '../communication/ally-tracker.js';
import { StagnationMonitor } from '../deliberation/stagnation-monitor.js';

export { buildPlannerChain };

/**
 * Parse a server interval string ("1s", "500ms", "1000") to milliseconds.
 * Used to convert PARCEL_DECADING_INTERVAL to a decay rate.
 */
function parseIntervalMs(s: string): number {
  const t = s.trim();
  if (t.endsWith('ms')) return parseInt(t, 10);
  if (t.endsWith('s')) return parseFloat(t) * 1000;
  return parseInt(t, 10);
}

/** Interval between periodic deliberation checks (milliseconds). */
const DELIBERATION_INTERVAL_MS = 2_000;

export abstract class BaseAgent implements IAgent {
  // IAgent interface
  private _id = "";
  get id(): string {
    return this._id;
  }
  abstract readonly role: AgentRole;

  // Internals
  protected client!: GameClient;
  protected config!: AgentConfig;
  protected beliefs: BeliefStore | null = null;
  private deliberator!: Deliberator;
  private planner!: IPlanner;
  private validator!: PlanValidator;
  protected executor!: ActionExecutor;
  protected log!: Logger;

  // Comms
  private msgHandler: MessageHandler | null = null;
  private allyTracker: AllyTracker | null = null;

  // Metrics
  private metrics: MetricsCollector | null = null;
  private metricsOutputPath = "";

  // Evaluation logging
  private evalLogger: EvalLogger | null = null;

  // State
  private currentIntention: Intention | null = null;
  private lastLoggedScore = -1;
  private running = false;
  private planning = false;
  private deliberateTimer: ReturnType<typeof setInterval> | null = null;
  private lastParcelFingerprint = '';
  private lastRevaluatedPosition: Position = { x: -1, y: -1 };
  private sigintHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;

  // Trigger tracking for deliberation logging
  private _deliberTrigger: DelibTrigger = 'timer';

  // Stagnation
  private stagnationMonitor: StagnationMonitor | null = null;

  // Last tile that caused a step failure — injected as a dynamic obstacle on next replan
  private lastFailedTile: Position | null = null;

  // Delivery zones that recently failed: key="x,y", value=expiry timestamp (2s cooldown).
  // Prevents the agent from retrying the same contested delivery zone immediately.
  private deliveryZoneCooldowns = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // Abstract method — subclasses provide the planner chain
  // ---------------------------------------------------------------------------

  protected abstract buildPlannerChain(): IPlanner;

  /** Called by eval-runner to inject the logger before start(). */
  setEvalLogger(logger: EvalLogger): void {
    this.evalLogger = logger;
    this.executor?.setEvalLogger(logger);
  }

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
    this.log = createLogger(`${config.role}-agent`, config.logLevel);

    this.deliberator = new Deliberator();
    this.validator = new PlanValidator();

    if (config.metrics?.enabled !== false) {
      this.metrics = new MetricsCollector(
        config.role,
        config.metrics?.sampleIntervalMs ?? 5_000,
      );
      this.metricsOutputPath =
        config.metrics?.outputPath ?? `logs/${config.role}-metrics.json`;
    }

    // Map event initializes BeliefStore (fires on drainPending / reconnect).
    // Guard: only create a new BeliefStore on the first fire — the map layout does
    // not change on reconnect and we must not lose accumulated beliefs.
    client.onMap((tiles, width, height) => {
      if (this.beliefs) return; // already initialized — skip on reconnect
      const map = new BeliefMapImpl([...tiles], width, height);
      this.beliefs = new BeliefStore(map);
      this.beliefs.setCapacity(client.getServerCapacity() + 10);
      this.beliefs.setObservationDistance(
        client.getObservationDistance(),
      );
      // Initialize base decay rate from server config so estimateRewardAt is
      // accurate from frame 1 instead of waiting for 2 empirical observations.
      const decayInterval = client.getServerConfig()?.PARCEL_DECADING_INTERVAL;
      if (decayInterval) {
        const intervalMs = parseIntervalMs(decayInterval);
        if (intervalMs > 0) {
          this.beliefs.getParcelTracker().setBaseDecayRate(1 / intervalMs);
        }
      }
      this.executor = new ActionExecutor(client);
      // Build planner chain now that beliefs are available (LlmAgent needs BeliefStore reference)
      this.planner = this.buildPlannerChain();
    });

    client.onYou((self) => {
      if (!this.beliefs) return;
      if (!this._id) {
        this._id = self.id;
        this.metrics?.setAgentId(self.id);

        // Wire up comms once we know our own ID
        if (config.teamId && this.beliefs) {
          this.msgHandler = new MessageHandler(client, self.id);
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
      this.stagnationMonitor?.notifyScore(self.score);
      if (self.score > 0 && self.score !== this.lastLoggedScore) {
        this.lastLoggedScore = self.score;
        this.log.info({ kind: "score_update", score: self.score });
        this.evalLogger?.logE({ ts: Date.now(), kind: 'score_update', data: { score: self.score } });
      }
    });

    client.onParcelsSensing((parcels) => {
      if (!this.beliefs) return;
      this.beliefs.updateParcels(parcels);
      if (this.running) this._scheduleDeliberation(false, 'sensing');
    });

    client.onAgentsSensing((agents) => {
      if (!this.beliefs) return;
      this.beliefs.updateAgents(agents);
    });

    client.onDisconnect(() => {
      this.log.warn({ kind: "connection_lost" });
      // Only log as a real loss when not shutting down gracefully
      if (this.running) {
        this.evalLogger?.logE({ ts: Date.now(), kind: 'connection_lost' });
      }
      // Cancel any in-flight action so it isn't replayed on reconnect
      if (this.executor) this.executor.cancelCurrentPlan();
      this.currentIntention = null;
    });

    client.onReconnect(() => {
      this.log.info({ kind: "connection_restored" });
      // Clear beliefs that may have gone stale during the outage
      this.beliefs?.clearStaleBeliefs();
      // Re-announce presence to allies (they may have timed us out)
      this.allyTracker?.onReconnect();
      // Kick off a fresh deliberation cycle
      if (this.running) this._scheduleDeliberation(false, 'reconnect');
    });
  }

  /**
   * Start the sense-deliberate-plan-execute loop.
   * Requires init() to have been called and drainPending() to have fired the map event.
   */
  async start(): Promise<void> {
    if (!this.beliefs || !this.executor) {
      throw new Error(
        `${this.constructor.name}.start() called before the map event was received. ` +
          "Call init(), then drainPending(), then start().",
      );
    }

    this.running = true;
    this.metrics?.start();

    const stagnationTimeoutMs = this.config.stagnationTimeoutMs ?? 15_000;
    this.stagnationMonitor = new StagnationMonitor({
      timeoutMs: stagnationTimeoutMs,
      onStagnation: (elapsedMs) => {
        if (!this.beliefs) return;
        // Only detect stagnation when pursuing a real goal, not while exploring or idle
        if (!this.currentIntention || this.currentIntention.type === "explore")
          return;
        const secondsSinceLastScore = Math.round(elapsedMs / 1000);
        this.log.warn({ kind: "stagnation_detected", secondsSinceLastScore });
        this.evalLogger?.logE({ ts: Date.now(), kind: 'stagnation_detected', data: { secondsSinceLastScore } });
        this.metrics?.recordStagnation();
        // Abandon the stuck intention — next deliberation will explore or try a different parcel
        this.executor.cancelCurrentPlan();
        this.currentIntention = null;
      },
    });
    this.stagnationMonitor.start();

    // Start ally coordination
    this.allyTracker?.start();

    // Wire executor callbacks
    this.executor.onPutdown((_count) => {
      this.beliefs?.clearDeliveredParcels();
    });

    // During explore plans, check for newly visible parcels after each step.
    // The inFlight guard in _scheduleDeliberation blocks sensing-triggered deliberation
    // while a move is in-flight; this callback fires right after inFlight clears,
    // before the next step starts, so it can interrupt explore if parcels appeared.
    this.executor.onStepComplete((_step, _index) => {
      if (this.currentIntention?.type === 'explore') {
        this._scheduleDeliberation(false, 'sensing');
      }
    });

    this.executor.onPlanComplete((plan) => {
      const hasPickup = plan.steps.some((s) => s.action === "pickup");
      const hasDelivery = plan.steps.some((s) => s.action === "putdown");
      const deliveredReward = hasDelivery ? plan.estimatedReward : 0;
      if (hasPickup) {
        this.evalLogger?.logE({ ts: Date.now(), kind: 'parcel_picked_up' });
      }
      if (deliveredReward > 0) {
        this.metrics?.recordParcelDelivered(deliveredReward);
        this.evalLogger?.logE({ ts: Date.now(), kind: 'parcel_delivered', data: { reward: deliveredReward } });
      }
      this.currentIntention = null;
      this._scheduleDeliberation(false, 'plan_complete');
    });

    this.executor.onStepFailed((step, idx, reason) => {
      const selfPos = this.beliefs?.getSelf().position;
      const detail = `step[${idx}] ${step.action} to (${step.expectedPosition.x},${step.expectedPosition.y}) from (${selfPos?.x},${selfPos?.y})`;
      this.log.warn({
        kind: "plan_failed",
        plannerName: this.planner.name,
        error: `${reason} — ${detail}`,
      });
      // Record the blocked tile so the next replan avoids it even if sensing is stale
      this.lastFailedTile = step.expectedPosition;
      // If the blocked tile is a delivery zone, add a 2s cooldown so the next delivery
      // plan picks a different zone rather than retrying the same contested one.
      if (this.beliefs?.getMap().isDeliveryZone(step.expectedPosition.x, step.expectedPosition.y)) {
        const key = `${step.expectedPosition.x},${step.expectedPosition.y}`;
        this.deliveryZoneCooldowns.set(key, Date.now() + 2000);
      }
      this.currentIntention = null;
      this._scheduleDeliberation(/* planFailed= */ true, 'plan_failed');
    });

    this.executor.onReplanRequired((signal) => {
      this.log.warn({ kind: "replan_triggered", reason: signal.reason });
      this.currentIntention = null;
      this._scheduleDeliberation(/* planFailed= */ true, 'plan_failed');
    });

    // Periodic replan check + stagnation detection
    this.deliberateTimer = setInterval(() => {
      this._scheduleDeliberation();
    }, DELIBERATION_INTERVAL_MS);
    this.deliberateTimer.unref();

    // Signal handlers for graceful shutdown
    const shutdown = async (): Promise<void> => {
      await this.stop();
      process.exit(0);
    };
    this.sigintHandler = () => {
      void shutdown();
    };
    this.sigtermHandler = () => {
      void shutdown();
    };
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigtermHandler);

    // Kick off first deliberation cycle
    this._scheduleDeliberation();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.deliberateTimer) {
      clearInterval(this.deliberateTimer);
      this.deliberateTimer = null;
    }

    this.stagnationMonitor?.stop();
    this.allyTracker?.stop();
    if (this.planner) this.planner.abort();
    if (this.executor) this.executor.cancelCurrentPlan();

    if (this.sigintHandler)
      process.removeListener("SIGINT", this.sigintHandler);
    if (this.sigtermHandler)
      process.removeListener("SIGTERM", this.sigtermHandler);

    if (this.metrics) {
      this.metrics.stop();
      console.log(formatSummary(this.metrics.snapshot()));
      await this.metrics.exportJson(this.metricsOutputPath).catch((err) => {
        console.error("Failed to export metrics:", err);
      });
    }

    this.evalLogger?.flush();
    this.client.disconnect();
  }

  // ---------------------------------------------------------------------------
  // Deliberation
  // ---------------------------------------------------------------------------

  /**
   * Enqueue a deliberation pass (debounced by planning flag).
   * planFailed=true bypasses the shouldReplan threshold check.
   */
  private _scheduleDeliberation(planFailed = false, trigger: DelibTrigger = 'timer'): void {
    this._deliberTrigger = trigger;
    if (!this.running || !this.beliefs || this.planning) return;
    // Don't replan while a move is in-flight — new plan would use stale pre-move position
    if (!planFailed && this.executor?.getInFlightAction() !== null) return;
    if (planFailed) {
      // Brief pause to let dynamic obstacles (NPCs) move away before replanning.
      // 150ms = 3 NPC steps at 50ms/step.
      setTimeout(() => {
        if (this.running) void this._deliberateAndPlan(planFailed);
      }, 150);
    } else {
      void this._deliberateAndPlan(planFailed);
    }
  }

  private _computeParcelFingerprint(): string {
    const parcels = this.beliefs!.getParcelBeliefs();
    return parcels
      .map(p => `${p.id}:${p.carriedBy ?? ''}`)
      .sort()
      .join('|');
  }

  private async _deliberateAndPlan(planFailed = false): Promise<void> {
    if (this.planning) return;
    this.planning = true;

    try {
      if (!this.beliefs || !this.running) return;

      // --- L1 logging: capture state snapshot at deliberation start ---
      const self0 = this.beliefs.getSelf();
      const decayStep0 = this._getDecayPerStep();
      const pos0: [number, number] = [Math.round(self0.position.x), Math.round(self0.position.y)];
      const baseRecord = {
        ts: Date.now(),
        trigger: this._deliberTrigger,
        pos: pos0,
        score: self0.score ?? 0,
        carried: self0.carriedParcels.length,
        carriedR: self0.carriedParcels.reduce((s, p) => s + p.estimatedReward, 0),
        cap: this.beliefs.getCapacity(),
        decayStep: decayStep0,
      };

      const movementDurationMs = this.client.getMeasuredActionDurationMs();
      const tracker = this.beliefs.getParcelTracker();

      // Structural gate: skip full re-evaluation when parcel set and position are
      // unchanged — utility ranking is stable with uniform decay (gap is constant).
      // Bypassed when: planFailed, executor idle, or no active intention.
      if (!planFailed && !this.executor.isIdle() && this.currentIntention !== null) {
        const fingerprint = this._computeParcelFingerprint();
        const currentPos = this.beliefs.getSelf().position;
        const unchanged = fingerprint === this.lastParcelFingerprint
          && positionEquals(currentPos, this.lastRevaluatedPosition);
        this.lastParcelFingerprint = fingerprint;
        this.lastRevaluatedPosition = currentPos;
        if (unchanged) {
          this.evalLogger?.logD({ ...baseRecord, gateSkip: true });
          return;
        }
      }

      // Compute candidates once — passed to shouldReplan to avoid a second evaluate().
      const claimedByOthers =
        this.allyTracker?.getClaimedByOthers() ?? new Set<string>();
      const evalResult = this.deliberator.evaluate(this.beliefs, movementDurationMs, tracker);
      const candidates = evalResult.intentions
        .filter(i => !i.targetParcels.some(id => claimedByOthers.has(id)));

      // Build eval metadata for logging
      const evalMeta = {
        reachable: evalResult.reachable,
        contestaDrop: evalResult.contestaDrop,
        cands: evalResult.candidates as unknown as EvalCandidate[],
      };

      const shouldReplan = this.deliberator.shouldReplan(
        this.currentIntention,
        this.beliefs,
        planFailed,
        movementDurationMs,
        tracker,
        candidates,
      );
      const needsReplan = planFailed || shouldReplan || this.executor.isIdle();

      if (!needsReplan) {
        const replanReason = '';
        this.evalLogger?.logD({
          ...baseRecord,
          gateSkip: false,
          reachable: evalMeta.reachable,
          contestaDrop: evalMeta.contestaDrop,
          cands: evalMeta.cands,
          replan: false,
          replanReason,
          curU: this.currentIntention?.utility ?? undefined,
        });
        return;
      }

      // Track mutable logging state
      let branch: DelibBranch = 'no_action';
      let portfolio: { delivV: number; pickV: number } | null = null;
      let planMeta: { pl: string; ok: boolean; steps: number; ms: number } | null = null;
      let validMeta: boolean | null = null;
      let chosenIdx: number | null = null;
      const claimsMeta: Array<{ p: string; d: number; r: 'won' | 'yield' }> = [];
      const enemiesMeta = this.beliefs.getAgentBeliefs()
        .filter(a => !a.isAlly)
        .map(a => ({ pos: [Math.round(a.position.x), Math.round(a.position.y)] as [number, number], h: a.heading ?? '' }));

      const replanReason = planFailed ? 'plan_failed'
        : shouldReplan ? 'better_option_or_target_gone'
        : this.executor.isIdle() ? 'idle'
        : '';

      // Helper to emit the full D record at any return point
      const emitLog = (): void => {
        this.evalLogger?.logD({
          ...baseRecord,
          gateSkip: false,
          reachable: evalMeta.reachable,
          contestaDrop: evalMeta.contestaDrop,
          cands: evalMeta.cands,
          replan: needsReplan,
          replanReason,
          curU: this.currentIntention?.utility ?? undefined,
          branch,
          portfolio,
          plan: planMeta,
          valid: validMeta,
          chosen: chosenIdx,
          claims: claimsMeta,
          enemies: enemiesMeta,
        } as Omit<L1RecordD, 't' | 'seq'>);
      };

      // Cancel current plan if replan is warranted
      if (this.currentIntention !== null && (planFailed || shouldReplan)) {
        this.executor.cancelCurrentPlan();
        this.log.info({
          kind: "replan_triggered",
          reason: planFailed ? "plan_failed" : "better_option_or_target_gone",
        });
        this.log.info({
          kind: "intention_dropped",
          intentionId: this.currentIntention.id,
          reason: planFailed ? "plan_failed" : "superseded",
        });
        this.currentIntention = null;
      }

      const self = this.beliefs.getSelf();

      // If at capacity, skip deliberation and deliver immediately
      if (self.carriedParcels.length >= this.beliefs.getCapacity()) {
        branch = 'capacity_deliver';
        emitLog();
        await this._planDelivery();
        return;
      }

      // If carrying parcels and no reachable ground parcels → deliver what we have
      if (self.carriedParcels.length > 0) {
        const reachable = this.beliefs.getReachableParcels();
        if (reachable.length === 0) {
          branch = 'no_reachable_deliver';
          emitLog();
          await this._planDelivery();
          return;
        }
      }

      // candidates already computed above — no second evaluate() needed

      if (candidates.length === 0) {
        branch = 'no_action';
        emitLog();
        if (self.carriedParcels.length > 0) await this._planDelivery();
        return;
      }

      const best = candidates[0]!;

      // Handle explore intentions — no parcels to pick up, just move to target
      if (best.type === "explore") {
        // If carrying parcels, delivering is more valuable than exploring (utility > 0.10)
        if (self.carriedParcels.length > 0) {
          branch = 'deliver_vs_pickup';
          emitLog();
          await this._planDelivery();
          return;
        }
        // Skip if already executing an explore plan toward the same tile
        if (
          this.currentIntention?.type === "explore" &&
          positionEquals(
            this.currentIntention.targetPosition,
            best.targetPosition,
          ) &&
          !this.executor.isIdle()
        ) {
          branch = 'explore';
          emitLog();
          return;
        }
        this.currentIntention = best;
        this.log.info({
          kind: "intention_set",
          intentionId: best.id,
          type: best.type,
          utility: best.utility,
        });
        branch = 'explore';
        emitLog();
        await this._planExplore(best.targetPosition);
        return;
      }

      // Don't replan if intention target unchanged and executor is busy
      const sameTarget =
        this.currentIntention?.targetParcels.join(",") ===
        best.targetParcels.join(",");
      if (sameTarget && !this.executor.isIdle()) {
        emitLog();
        return;
      }

      // When carrying parcels, compare delivering now vs best pickup using
      // portfolio-aware scores: both scores normalized by steps for scale-neutral comparison.
      if (self.carriedParcels.length > 0) {
        const deliveryTarget = this.beliefs.getNearestDeliveryZone(self.position);
        if (deliveryTarget) {
          const delivSteps = manhattanDistance(self.position, deliveryTarget);
          const totalCarried = self.carriedParcels.reduce((s, p) => s + p.estimatedReward, 0);
          const numCarried = self.carriedParcels.length;
          const decayPerStep = this._getDecayPerStep();

          const delivScore = computeDeliveryScore(totalCarried, numCarried, delivSteps, decayPerStep);

          // Recover projected parcel reward from utility (utility = projectedReward / steps).
          // stepsToParcel + stepsFromParcelToDelivery (using same delivery zone for consistency).
          const bestParcel = this.beliefs.getParcelBeliefs().find(p => p.id === best.targetParcels[0]);
          const stepsToParcel = bestParcel ? manhattanDistance(self.position, bestParcel.position) : 0;
          const stepsParcelToDelivery = bestParcel ? manhattanDistance(bestParcel.position, deliveryTarget) : 0;
          const bestTotalSteps = stepsToParcel + stepsParcelToDelivery;
          const projectedParcelReward = best.utility * bestTotalSteps;

          const pickScore = computePickupScore(projectedParcelReward, bestTotalSteps, totalCarried, numCarried, decayPerStep);

          // Normalize by steps for step-aware comparison (handles zero-decay case correctly).
          const delivValue = delivSteps > 0 ? delivScore / delivSteps : Infinity;
          const pickValue = bestTotalSteps > 0 ? pickScore / bestTotalSteps : 0;

          portfolio = { delivV: delivValue, pickV: pickValue };

          if (delivValue >= pickValue) {
            branch = 'deliver_vs_pickup';
            emitLog();
            await this._planDelivery();
            return;
          }
        }
      }

      // Iterate candidates: skip any yielded to an ally, use the first we can claim
      for (const candidate of candidates) {
        if (candidate.type === "explore") continue;

        // Parcel claim negotiation with allies
        if (this.allyTracker && candidate.targetParcels.length > 0) {
          const parcelId = candidate.targetParcels[0]!;
          const parcel = this.beliefs
            .getParcelBeliefs()
            .find((p) => p.id === parcelId);
          if (parcel) {
            const dist = manhattanDistance(self.position, parcel.position);
            const result = await this.allyTracker.claimParcel(parcelId, dist);
            claimsMeta.push({ p: parcelId, d: dist, r: result === 'yield' ? 'yield' : 'won' });
            if (result === "yield") {
              this.log.info({
                kind: "intention_dropped",
                intentionId: candidate.id,
                reason: "ally_has_priority",
              });
              continue;
            }
          }
        }

        this.currentIntention = candidate;
        this.log.info({
          kind: "intention_set",
          intentionId: candidate.id,
          type: candidate.type,
          utility: candidate.utility,
        });

        // Resolve target parcel beliefs
        const allParcels = this.beliefs.getParcelBeliefs();
        const targetParcels = candidate.targetParcels
          .map((id) => allParcels.find((p) => p.id === id))
          .filter(
            (p): p is ParcelBelief => p !== undefined && p.carriedBy === null,
          );

        if (targetParcels.length === 0) {
          this.currentIntention = null;
          continue;
        }

        // Plan — pass current agent positions as dynamic obstacles so BFS avoids occupied tiles
        const deliveryZones = Array.from(
          this.beliefs.getMap().getDeliveryZones(),
        );
        const map = this.beliefs.getMap();
        const agentObstacles = this.beliefs
          .getAgentBeliefs()
          .map((a) => a.position);
        // Include the last failed tile as an extra obstacle in case sensing is stale
        if (this.lastFailedTile) agentObstacles.push(this.lastFailedTile);
        // Add 1-step NPC heading prediction: also avoid where each NPC is moving.
        // Only predict for recently-seen agents (heading stale after 500ms = 10 NPC steps).
        const now = Date.now();
        for (const agent of this.beliefs.getAgentBeliefs()) {
          if (!agent.heading || now - agent.lastSeen > 500) continue;
          const p = agent.position;
          let nx = p.x, ny = p.y;
          if (agent.heading === 'up')    ny += 1;
          if (agent.heading === 'down')  ny -= 1;
          if (agent.heading === 'left')  nx -= 1;
          if (agent.heading === 'right') nx += 1;
          if (map.isWalkable(nx, ny) && !agentObstacles.some(o => o.x === nx && o.y === ny)) {
            agentObstacles.push({ x: nx, y: ny });
          }
        }
        const selfPos = {
          x: Math.round(self.position.x),
          y: Math.round(self.position.y),
        };
        const planningRequest = {
          currentPosition: selfPos,
          carriedParcels: self.carriedParcels as ReadonlyArray<ParcelBelief>,
          targetParcels,
          deliveryZones,
          beliefMap: this.beliefs.getMap(),
          constraints:
            agentObstacles.length > 0
              ? { avoidPositions: agentObstacles }
              : undefined,
        };

        const planStart = Date.now();
        const planResult = await this.planner.plan(planningRequest);
        const planMs = Date.now() - planStart;
        this.metrics?.recordPlannerCall(
          this.planner.name,
          planMs,
          planResult.success,
        );
        planMeta = {
          pl: planResult.metadata.plannerName,
          ok: planResult.success,
          steps: planResult.plan?.steps.length ?? 0,
          ms: planMs,
        };

        if (!planResult.success || !planResult.plan) {
          this.log.warn({
            kind: "plan_failed",
            plannerName: planResult.metadata.plannerName,
            error: planResult.error ?? "unknown",
          });
          this.currentIntention = null;
          continue;
        }

        this.log.info({
          kind: "plan_generated",
          plannerName: planResult.metadata.plannerName,
          steps: planResult.plan.steps.length,
          timeMs: planResult.metadata.computeTimeMs,
        });

        // Validate
        const vr = this.validator.validate(planResult.plan, this.beliefs);
        validMeta = vr.valid;
        if (!vr.valid) {
          this.log.warn({
            kind: "plan_failed",
            plannerName: planResult.metadata.plannerName,
            error: vr.reason ?? "validation failed",
          });
          this.currentIntention = null;
          continue;
        }

        // Stamp intention ID and execute
        const plan: Plan = { ...planResult.plan, intentionId: candidate.id };
        this.lastFailedTile = null; // fresh plan started — clear the failed-tile override
        branch = 'pickup';
        chosenIdx = evalMeta.cands.findIndex(c => c.tp[0] === candidate.targetParcels[0]);
        emitLog();
        this.executor.executePlan(plan);
        break; // successfully planned and started execution
      }
    } finally {
      this.planning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Delivery-only plan (agent is already carrying parcels, no new targets)
  // ---------------------------------------------------------------------------

  private async _planDelivery(): Promise<void> {
    if (!this.beliefs) return;
    const self = this.beliefs.getSelf();

    const agentObstacles = this.beliefs
      .getAgentBeliefs()
      .map((a) => a.position);
    if (this.lastFailedTile) agentObstacles.push(this.lastFailedTile);
    const selfPos = {
      x: Math.round(self.position.x),
      y: Math.round(self.position.y),
    };

    // Prefer the nearest delivery zone NOT currently occupied by an agent obstacle
    // and NOT in the 2s cooldown set (recently failed with NPC contest).
    const now = Date.now();
    const allZones = Array.from(this.beliefs.getMap().getDeliveryZones());
    const sortedZones = allZones.sort(
      (a, b) => manhattanDistance(selfPos, a) - manhattanDistance(selfPos, b),
    );
    const unblockedZone = sortedZones.find(z => {
      if (agentObstacles.some(o => o.x === z.x && o.y === z.y)) return false;
      const cooldown = this.deliveryZoneCooldowns.get(`${z.x},${z.y}`);
      return !cooldown || now >= cooldown;
    });
    const delivery = unblockedZone ?? sortedZones[0] ?? null;
    if (!delivery) return;

    let path = findPath(
      selfPos,
      delivery,
      this.beliefs.getMap(),
      agentObstacles.length > 0 ? agentObstacles : undefined,
    );
    // Retry without agent obstacles — agents move, corridor may open
    if (!path) path = findPath(selfPos, delivery, this.beliefs.getMap());
    if (!path) {
      this.log.warn({
        kind: "plan_failed",
        plannerName: "bfs",
        error: `no delivery path from (${self.position.x},${self.position.y}) to (${delivery.x},${delivery.y})`,
      });
      return;
    }

    const steps: PlanStep[] = [];
    for (let i = 1; i < path.length; i++) {
      steps.push({
        action: _posToAction(path[i - 1]!, path[i]!),
        expectedPosition: path[i]!,
      });
    }
    steps.push({ action: "putdown", expectedPosition: delivery });

    const totalCarriedReward = self.carriedParcels.reduce((s, p) => s + p.estimatedReward, 0);
    const stepsToDelivery = manhattanDistance(selfPos, delivery);
    const deliveryIntentionId = randomUUID();
    this.currentIntention = {
      id: deliveryIntentionId,
      type: "go_to_delivery",
      targetParcels: self.carriedParcels.map((p) => p.id),
      targetPosition: delivery,
      utility: stepsToDelivery > 0 ? totalCarriedReward / stepsToDelivery : totalCarriedReward,
      createdAt: Date.now(),
    };

    const plan: Plan = {
      id: randomUUID(),
      intentionId: deliveryIntentionId,
      steps,
      estimatedReward: self.carriedParcels.reduce(
        (s, p) => s + p.estimatedReward,
        0,
      ),
      createdAt: Date.now(),
    };

    this.log.info({
      kind: "plan_generated",
      plannerName: "bfs",
      steps: plan.steps.length,
      timeMs: 0,
    });
    this.lastFailedTile = null;
    this.executor.executePlan(plan);
  }

  // ---------------------------------------------------------------------------
  // Decay helper
  // ---------------------------------------------------------------------------

  /** Returns decayRate (reward/ms) * movementDurationMs (ms/step) = reward lost per step per parcel. */
  private _getDecayPerStep(): number {
    const tracker = this.beliefs?.getParcelTracker();
    const decayRatePerMs = tracker?.getGlobalAverageDecayRate() ?? 0;
    const movDurationMs = this.client.getMeasuredActionDurationMs();
    return decayRatePerMs * movDurationMs;
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
    const agentObstacles = this.beliefs
      .getAgentBeliefs()
      .map((a) => a.position);
    if (this.lastFailedTile) agentObstacles.push(this.lastFailedTile);
    const selfPos = {
      x: Math.round(self.position.x),
      y: Math.round(self.position.y),
    };
    let path = findPath(
      selfPos,
      target,
      this.beliefs.getMap(),
      agentObstacles.length > 0 ? agentObstacles : undefined,
    );
    // Fallback: drop all obstacles — agents move, so explore can proceed
    if (!path) path = findPath(selfPos, target, this.beliefs.getMap());
    if (!path || path.length <= 1) {
      this.currentIntention = null;
      return;
    }
    const steps: PlanStep[] = [];
    for (let i = 1; i < path.length; i++) {
      steps.push({
        action: _posToAction(path[i - 1]!, path[i]!),
        expectedPosition: path[i]!,
      });
    }
    const plan: Plan = {
      id: randomUUID(),
      intentionId: this.currentIntention?.id ?? "",
      steps,
      estimatedReward: 0,
      createdAt: Date.now(),
    };
    this.log.info({
      kind: "plan_generated",
      plannerName: "bfs",
      steps: plan.steps.length,
      timeMs: 0,
    });
    this.lastFailedTile = null;
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
