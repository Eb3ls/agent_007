// ============================================================
// src/evaluation/eval-summarizer.ts — L1 JSONL → L2 JSON summary
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import type { L1RecordD, L1RecordA, L1RecordE } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/evaluation/ -> src/ -> project root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ----------------------------------------------------------------
// L2 types
// ----------------------------------------------------------------

export interface L2Summary {
  v: 1;
  map: string;
  mapCat: string;
  run: number;
  startTs: number;
  durMs: number;
  partial: boolean;
  finalScore: number;

  throughput: {
    deliveries: number;
    pickups: number;
    pickDelivRatio: number;
    avgCycleMs: number;
    avgRewardPerDeliv: number;
    spm: number;
    expired: number;
    missed: number;
  };

  planning: {
    cycles: number;
    replans: number;
    replanReasons: Record<string, number>;
    planners: Record<string, { n: number; avgMs: number; fail: number }>;
    avgCands: number;
    gateSkipRate: number;
    exploreCycles: number;
  };

  movement: {
    steps: number;
    failedSteps: number;
    failRate: number;
    penalties: number;
    avgStepMs: number;
  };

  decisions: {
    avgChosenU: number;
    uTrend: 'increasing' | 'stable' | 'decreasing';
    delivVsPickup: number;
    delivChosenRate: number;
    contestaRate: number;
    allyYieldRate: number;
  };

  health: {
    stagnations: number;
    maxStagnMs: number;
    connLosses: number;
    timeline5s: number[];
    slope: number;
  };

  anomalies: Array<{
    type: string;
    ts: number;
    detail: string;
    l1Seq: [number, number];
  }>;
}

// ----------------------------------------------------------------
// Internal accumulators
// ----------------------------------------------------------------

interface PlannerStats {
  n: number;
  totalMs: number;
  fail: number;
}

interface Anomaly {
  type: string;
  ts: number;
  detail: string;
  l1Seq: [number, number];
}

// ----------------------------------------------------------------
// Linear regression helper
// ----------------------------------------------------------------
function linearSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += ys[i];
    sumXX += i * i;
    sumXY += i * ys[i];
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

// ----------------------------------------------------------------
// uTrend helper
// ----------------------------------------------------------------
function computeUTrend(slope: number, range: number): 'increasing' | 'stable' | 'decreasing' {
  // Consider stable if slope is less than 1% of range per sample
  const threshold = range * 0.01;
  if (slope > threshold) return 'increasing';
  if (slope < -threshold) return 'decreasing';
  return 'stable';
}

// ----------------------------------------------------------------
// Core parsing & summarization
// ----------------------------------------------------------------

export async function summarizeEpisode(
  l1FilePath: string,
  mapName: string,
  mapCat: string,
  runIndex: number,
  durationMs: number,
): Promise<L2Summary> {

  // ---- Read all valid lines ----
  const dRecords: L1RecordD[] = [];
  const aRecords: L1RecordA[] = [];
  const eRecords: L1RecordE[] = [];
  let partial = false;

  const fileStream = fs.createReadStream(l1FilePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as { t: string };
      if (rec.t === 'D') dRecords.push(rec as unknown as L1RecordD);
      else if (rec.t === 'A') aRecords.push(rec as unknown as L1RecordA);
      else if (rec.t === 'E') eRecords.push(rec as unknown as L1RecordE);
    } catch {
      // Truncated/malformed line — mark as partial
      partial = true;
    }
  }

  // ---- Basic timestamps ----
  const allTs: number[] = [
    ...dRecords.map(r => r.ts),
    ...aRecords.map(r => r.ts),
    ...eRecords.map(r => r.ts),
  ];
  const startTs = allTs.length > 0 ? Math.min(...allTs) : Date.now();

  // ---- Final score ----
  const scoreEvents = eRecords.filter(e => e.kind === 'score_update');
  let finalScore = 0;
  if (scoreEvents.length > 0) {
    const last = scoreEvents[scoreEvents.length - 1];
    finalScore = (last.data?.score as number) ?? 0;
  }

  // ---- Throughput ----
  const deliveryEvents = eRecords.filter(e => e.kind === 'parcel_delivered');
  const pickupEvents = eRecords.filter(e => e.kind === 'parcel_picked_up');
  const expiredEvents = eRecords.filter(e => e.kind === 'parcel_expired');
  const deliveries = deliveryEvents.length;
  const pickups = pickupEvents.length;
  const pickDelivRatio = deliveries > 0 ? pickups / deliveries : 0;

  // avgCycleMs: time between consecutive D records
  let totalCycleMs = 0;
  for (let i = 1; i < dRecords.length; i++) {
    totalCycleMs += dRecords[i].ts - dRecords[i - 1].ts;
  }
  const avgCycleMs = dRecords.length > 1 ? totalCycleMs / (dRecords.length - 1) : 0;

  let totalReward = 0;
  for (const e of deliveryEvents) {
    totalReward += (e.data?.reward as number) ?? 0;
  }
  const avgRewardPerDeliv = deliveries > 0 ? totalReward / deliveries : 0;

  const durMinutes = durationMs / 60000;
  const spm = durMinutes > 0 ? finalScore / durMinutes : 0;
  const missed = expiredEvents.length;

  // ---- Planning ----
  const cycles = dRecords.length;
  let replans = 0;
  const replanReasons: Record<string, number> = {};
  const plannerStats: Record<string, PlannerStats> = {};
  let totalCands = 0;
  let candCount = 0;
  let gateSkips = 0;
  let exploreCycles = 0;

  for (const d of dRecords) {
    if (d.gateSkip) {
      gateSkips++;
      continue;
    }
    if (d.replan) {
      replans++;
      if (d.replanReason) {
        replanReasons[d.replanReason] = (replanReasons[d.replanReason] ?? 0) + 1;
      }
    }
    if (d.cands) {
      totalCands += d.cands.length;
      candCount++;
    }
    if (d.branch === 'explore') exploreCycles++;
    if (d.plan) {
      const pl = d.plan.pl;
      if (!plannerStats[pl]) plannerStats[pl] = { n: 0, totalMs: 0, fail: 0 };
      plannerStats[pl].n++;
      plannerStats[pl].totalMs += d.plan.ms;
      if (!d.plan.ok) plannerStats[pl].fail++;
    }
  }

  const planners: Record<string, { n: number; avgMs: number; fail: number }> = {};
  for (const [name, stats] of Object.entries(plannerStats)) {
    planners[name] = {
      n: stats.n,
      avgMs: stats.n > 0 ? stats.totalMs / stats.n : 0,
      fail: stats.fail,
    };
  }

  const avgCands = candCount > 0 ? totalCands / candCount : 0;
  const gateSkipRate = cycles > 0 ? gateSkips / cycles : 0;

  // ---- Movement ----
  const steps = aRecords.length;
  const failedSteps = aRecords.filter(a => !a.ok).length;
  const failRate = steps > 0 ? failedSteps / steps : 0;
  const penaltyEvents = eRecords.filter(e => e.kind === 'penalty');
  const penalties = penaltyEvents.length;
  const totalStepMs = aRecords.reduce((sum, a) => sum + a.ms, 0);
  const avgStepMs = steps > 0 ? totalStepMs / steps : 0;

  // ---- Decisions ----
  const nonSkipD = dRecords.filter(d => !d.gateSkip);
  let totalChosenU = 0;
  let chosenUCount = 0;
  const chosenUs: number[] = [];
  let delivBranch = 0;
  let pickupBranch = 0;
  let contestaTotal = 0;
  let contestaDropped = 0;
  let allyYieldTotal = 0;
  let allyYieldCount = 0;

  for (const d of nonSkipD) {
    if (d.chosen !== undefined && d.chosen !== null && d.chosen >= 0 && d.cands) {
      const cand = d.cands[d.chosen];
      if (cand) {
        totalChosenU += cand.u;
        chosenUCount++;
        chosenUs.push(cand.u);
      }
    }
    if (d.branch === 'deliver_vs_pickup' || d.branch === 'capacity_deliver' || d.branch === 'no_reachable_deliver') {
      delivBranch++;
    }
    if (d.branch === 'pickup') pickupBranch++;
    if (d.reachable !== undefined) {
      contestaTotal += d.reachable;
    }
    if (d.contestaDrop !== undefined) {
      contestaDropped += d.contestaDrop;
    }
    if (d.claims) {
      for (const claim of d.claims) {
        allyYieldTotal++;
        if (claim.r === 'yield') allyYieldCount++;
      }
    }
  }

  const avgChosenU = chosenUCount > 0 ? totalChosenU / chosenUCount : 0;

  // uTrend via linear regression on chosenUs
  const uSlope = linearSlope(chosenUs);
  const uMin = chosenUs.length > 0 ? Math.min(...chosenUs) : 0;
  const uMax = chosenUs.length > 0 ? Math.max(...chosenUs) : 0;
  const uTrend = computeUTrend(uSlope, uMax - uMin);

  const delivVsPickup = (delivBranch + pickupBranch) > 0
    ? delivBranch / (delivBranch + pickupBranch)
    : 0;
  const delivChosenRate = nonSkipD.length > 0 ? delivBranch / nonSkipD.length : 0;
  const contestaRate = contestaTotal > 0 ? contestaDropped / contestaTotal : 0;
  const allyYieldRate = allyYieldTotal > 0 ? allyYieldCount / allyYieldTotal : 0;

  // ---- Health ----
  const stagnationEvents = eRecords.filter(e => e.kind === 'stagnation_detected');
  const stagnations = stagnationEvents.length;
  let maxStagnMs = 0;
  for (const e of stagnationEvents) {
    const secs = (e.data?.secondsSinceLastScore as number) ?? 0;
    maxStagnMs = Math.max(maxStagnMs, secs * 1000);
  }
  const connLosses = eRecords.filter(e => e.kind === 'connection_lost').length;

  // Build timeline5s
  const timeline5s: number[] = [];
  const windowMs = 5000;
  const totalWindows = Math.ceil(durationMs / windowMs);
  let lastKnownScore = 0;

  // Pre-sort score events by ts
  const sortedScoreEvents = [...scoreEvents].sort((a, b) => a.ts - b.ts);
  let scoreIdx = 0;

  for (let w = 0; w < totalWindows; w++) {
    const windowEnd = startTs + (w + 1) * windowMs;
    // Advance score pointer to consume all events up to windowEnd
    while (scoreIdx < sortedScoreEvents.length && sortedScoreEvents[scoreIdx].ts <= windowEnd) {
      lastKnownScore = (sortedScoreEvents[scoreIdx].data?.score as number) ?? lastKnownScore;
      scoreIdx++;
    }
    timeline5s.push(lastKnownScore);
  }

  const slope = linearSlope(timeline5s);

  // ---- Anomaly detection ----
  const anomalies: Anomaly[] = [];

  // 1. loop — position sequence repeating 4+ times in 10s window
  detectLoopAnomaly(aRecords, anomalies);

  // 2. stagnation_prolonged — score unchanged for >20000ms
  detectStagnationProlonged(eRecords, anomalies);

  // 3. decision_contradiction
  detectDecisionContradiction(dRecords, eRecords, anomalies);

  // 4. high_plan_failure — within any 60s window, failures/total > 0.30
  detectHighPlanFailure(dRecords, anomalies);

  // 5. excessive_decay_loss — at end, pickup rewards vs delivered rewards
  detectExcessiveDecayLoss(eRecords, anomalies);

  // 6. underutilized_capacity
  detectUnderutilizedCapacity(dRecords, anomalies);

  // 7. penalty_accumulation
  if (penalties > 10) {
    const firstPenalty = penaltyEvents[0];
    const lastPenalty = penaltyEvents[penaltyEvents.length - 1];
    anomalies.push({
      type: 'penalty_accumulation',
      ts: firstPenalty.ts,
      detail: `${penalties} penalties accumulated`,
      l1Seq: [firstPenalty.seq, lastPenalty.seq],
    });
  }

  // ---- Assemble result ----
  return {
    v: 1,
    map: mapName,
    mapCat,
    run: runIndex,
    startTs,
    durMs: durationMs,
    partial,
    finalScore,
    throughput: {
      deliveries,
      pickups,
      pickDelivRatio,
      avgCycleMs,
      avgRewardPerDeliv,
      spm,
      expired: missed,
      missed,
    },
    planning: {
      cycles,
      replans,
      replanReasons,
      planners,
      avgCands,
      gateSkipRate,
      exploreCycles,
    },
    movement: {
      steps,
      failedSteps,
      failRate,
      penalties,
      avgStepMs,
    },
    decisions: {
      avgChosenU,
      uTrend,
      delivVsPickup,
      delivChosenRate,
      contestaRate,
      allyYieldRate,
    },
    health: {
      stagnations,
      maxStagnMs,
      connLosses,
      timeline5s,
      slope,
    },
    anomalies,
  };
}

// ----------------------------------------------------------------
// Anomaly detection helpers
// ----------------------------------------------------------------

function detectLoopAnomaly(aRecords: L1RecordA[], anomalies: Anomaly[]): void {
  if (aRecords.length < 3) return;

  const WINDOW_MS = 10000;
  const MIN_SEQ_LEN = 3;
  const MIN_REPEATS = 4;
  const flaggedWindowStarts = new Set<number>();

  for (let i = 0; i < aRecords.length; i++) {
    const windowStart = aRecords[i].ts;
    const windowEnd = windowStart + WINDOW_MS;

    // Collect positions in this window
    const windowRecords: L1RecordA[] = [];
    for (let j = i; j < aRecords.length && aRecords[j].ts <= windowEnd; j++) {
      windowRecords.push(aRecords[j]);
    }

    if (windowRecords.length < MIN_SEQ_LEN * MIN_REPEATS) continue;

    const positions = windowRecords.map(r => `${r.pos[0]},${r.pos[1]}`);

    // Try all subsequences of length MIN_SEQ_LEN..6
    for (let seqLen = MIN_SEQ_LEN; seqLen <= Math.min(6, Math.floor(positions.length / MIN_REPEATS)); seqLen++) {
      for (let start = 0; start <= positions.length - seqLen * MIN_REPEATS; start++) {
        const seq = positions.slice(start, start + seqLen).join('|');
        let count = 1;
        let pos = start + seqLen;
        while (pos + seqLen <= positions.length) {
          const candidate = positions.slice(pos, pos + seqLen).join('|');
          if (candidate === seq) {
            count++;
            pos += seqLen;
          } else {
            break;
          }
        }
        if (count >= MIN_REPEATS) {
          // Check we haven't already flagged a window overlapping this one
          const key = Math.floor(windowStart / WINDOW_MS);
          if (!flaggedWindowStarts.has(key)) {
            flaggedWindowStarts.add(key);
            const startRecord = windowRecords[start];
            const endRecord = windowRecords[Math.min(start + seqLen * count - 1, windowRecords.length - 1)];
            anomalies.push({
              type: 'loop',
              ts: startRecord.ts,
              detail: `Position sequence [${seq.replace(/\|/g, ' → ')}] repeated ${count}x in 10s window`,
              l1Seq: [startRecord.seq, endRecord.seq],
            });
          }
          break;
        }
      }
    }
  }
}

function detectStagnationProlonged(eRecords: L1RecordE[], anomalies: Anomaly[]): void {
  const STAGNATION_MS = 20000;
  const scoreEvents = eRecords
    .filter(e => e.kind === 'score_update')
    .sort((a, b) => a.ts - b.ts);

  if (scoreEvents.length < 2) return;

  let lastScore = (scoreEvents[0].data?.score as number) ?? 0;
  let lastIncreaseTs = scoreEvents[0].ts;
  let lastIncreaseSeq = scoreEvents[0].seq;

  for (const e of scoreEvents) {
    const score = (e.data?.score as number) ?? 0;
    if (score > lastScore) {
      lastScore = score;
      lastIncreaseTs = e.ts;
      lastIncreaseSeq = e.seq;
    } else {
      const stagnDuration = e.ts - lastIncreaseTs;
      if (stagnDuration > STAGNATION_MS) {
        anomalies.push({
          type: 'stagnation_prolonged',
          ts: lastIncreaseTs,
          detail: `Score stagnant for ${stagnDuration}ms (>${STAGNATION_MS}ms threshold)`,
          l1Seq: [lastIncreaseSeq, e.seq],
        });
        // Advance to avoid re-flagging the same stagnation window
        lastIncreaseTs = e.ts;
        lastIncreaseSeq = e.seq;
        lastScore = score;
      }
    }
  }
}

function detectDecisionContradiction(
  dRecords: L1RecordD[],
  eRecords: L1RecordE[],
  anomalies: Anomaly[],
): void {
  const WINDOW_MS = 2000;
  const deliveryEvents = new Set(eRecords.filter(e => e.kind === 'parcel_delivered').map(e => e.ts));

  for (let i = 0; i < dRecords.length; i++) {
    const d = dRecords[i];
    if (d.gateSkip || d.branch !== 'deliver_vs_pickup') continue;

    // Check if chosen is a deliver candidate
    if (d.chosen === undefined || d.chosen === null || d.chosen < 0 || !d.cands) continue;
    const chosen = d.cands[d.chosen];
    if (!chosen || chosen.type !== 'cluster') continue; // cluster = deliver

    // Look for a pickup D record within 2000ms
    for (let j = i + 1; j < dRecords.length; j++) {
      const next = dRecords[j];
      if (next.ts - d.ts > WINDOW_MS) break;
      if (next.gateSkip || next.branch !== 'pickup') continue;

      // Check no delivery happened between d.ts and next.ts
      let deliveryOccurred = false;
      for (const dts of deliveryEvents) {
        if (dts > d.ts && dts < next.ts) {
          deliveryOccurred = true;
          break;
        }
      }
      if (!deliveryOccurred) {
        anomalies.push({
          type: 'decision_contradiction',
          ts: d.ts,
          detail: `Chose deliver at seq ${d.seq}, then pickup at seq ${next.seq} within ${next.ts - d.ts}ms without delivery`,
          l1Seq: [d.seq, next.seq],
        });
        break;
      }
    }
  }
}

function detectHighPlanFailure(dRecords: L1RecordD[], anomalies: Anomaly[]): void {
  const WINDOW_MS = 60000;
  const FAILURE_THRESHOLD = 0.30;
  const flaggedWindows = new Set<number>();

  for (let i = 0; i < dRecords.length; i++) {
    const windowStart = dRecords[i].ts;
    const windowKey = Math.floor(windowStart / WINDOW_MS);
    if (flaggedWindows.has(windowKey)) continue;

    let total = 0;
    let failures = 0;
    let lastSeq = dRecords[i].seq;

    for (let j = i; j < dRecords.length && dRecords[j].ts < windowStart + WINDOW_MS; j++) {
      const d = dRecords[j];
      if (d.gateSkip || !d.plan) continue;
      total++;
      if (!d.plan.ok) failures++;
      lastSeq = d.seq;
    }

    if (total >= 5 && failures / total > FAILURE_THRESHOLD) {
      flaggedWindows.add(windowKey);
      anomalies.push({
        type: 'high_plan_failure',
        ts: windowStart,
        detail: `${failures}/${total} plan failures (${(failures / total * 100).toFixed(1)}%) in 60s window`,
        l1Seq: [dRecords[i].seq, lastSeq],
      });
    }
  }
}

function detectExcessiveDecayLoss(eRecords: L1RecordE[], anomalies: Anomaly[]): void {
  const pickupEvents = eRecords.filter(e => e.kind === 'parcel_picked_up');
  const deliveryEvents = eRecords.filter(e => e.kind === 'parcel_delivered');

  // Map parcel IDs to their reward at pickup time (last known reward)
  let totalPickupReward = 0;
  let totalDeliveryReward = 0;

  for (const e of pickupEvents) {
    totalPickupReward += (e.data?.reward as number) ?? 0;
  }
  for (const e of deliveryEvents) {
    totalDeliveryReward += (e.data?.reward as number) ?? 0;
  }

  if (totalPickupReward > 0 && totalDeliveryReward / totalPickupReward < 0.50) {
    const firstSeq = pickupEvents.length > 0 ? pickupEvents[0].seq : 0;
    const lastDelivery = deliveryEvents[deliveryEvents.length - 1];
    const lastSeq = lastDelivery ? lastDelivery.seq : firstSeq;
    anomalies.push({
      type: 'excessive_decay_loss',
      ts: pickupEvents.length > 0 ? pickupEvents[0].ts : 0,
      detail: `Delivered ${totalDeliveryReward.toFixed(1)} vs picked up ${totalPickupReward.toFixed(1)} (ratio ${(totalDeliveryReward / totalPickupReward).toFixed(2)} < 0.50)`,
      l1Seq: [firstSeq, lastSeq],
    });
  }
}

function detectUnderutilizedCapacity(dRecords: L1RecordD[], anomalies: Anomaly[]): void {
  const relevant = dRecords.filter(
    d => !d.gateSkip && (d.branch === 'pickup' || d.branch === 'capacity_deliver'),
  );

  if (relevant.length < 3) return;

  const avgCarried = relevant.reduce((sum, d) => sum + d.carried, 0) / relevant.length;
  const avgReachable = relevant
    .filter(d => d.reachable !== undefined)
    .reduce((sum, d) => sum + (d.reachable ?? 0), 0)
    / (relevant.filter(d => d.reachable !== undefined).length || 1);

  if (avgCarried < 1.5 && avgReachable > 2) {
    const first = relevant[0];
    const last = relevant[relevant.length - 1];
    anomalies.push({
      type: 'underutilized_capacity',
      ts: first.ts,
      detail: `avg carried=${avgCarried.toFixed(2)} < 1.5 with avg reachable=${avgReachable.toFixed(2)} > 2`,
      l1Seq: [first.seq, last.seq],
    });
  }
}

// ----------------------------------------------------------------
// Write L2 summary
// ----------------------------------------------------------------

export async function writeL2Summary(
  l1FilePath: string,
  mapName: string,
  mapCat: string,
  runIndex: number,
  durationMs: number,
  logsBaseDir?: string,
): Promise<string> {
  const summary = await summarizeEpisode(l1FilePath, mapName, mapCat, runIndex, durationMs);

  const baseDir = logsBaseDir
    ? (path.isAbsolute(logsBaseDir) ? logsBaseDir : path.join(PROJECT_ROOT, logsBaseDir))
    : path.join(PROJECT_ROOT, 'logs');

  const outDir = path.join(baseDir, 'L2', mapName);
  fs.mkdirSync(outDir, { recursive: true });

  const filename = `run_${runIndex}_${summary.startTs}.json`;
  const outPath = path.join(outDir, filename);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');

  return outPath;
}
