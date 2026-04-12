// ============================================================
// src/metrics/metrics-snapshot.ts — MetricsSnapshot re-export + formatter (T19)
// ============================================================

export type { MetricsSnapshot } from '../types.js';

import type { MetricsSnapshot } from '../types.js';

/**
 * Returns a multi-line human-readable summary of a MetricsSnapshot
 * for printing to the terminal at agent shutdown.
 */
export function formatSummary(s: MetricsSnapshot): string {
  const durationSec = Math.round(s.sessionDurationMs / 1000);
  const agentShort  = s.agentId.slice(0, 8);

  const plannerLines = Object.entries(s.plannerCalls)
    .map(([name, p]) =>
      `  ${name}: ${p.count} calls, avg ${Math.round(p.avgLatencyMs)}ms, ${p.failures} failures`,
    )
    .join('\n');

  const llmLine = s.llmCalls
    ? `LLM calls: ${s.llmCalls.count}, avg ${Math.round(s.llmCalls.avgLatencyMs)}ms, ` +
      `${s.llmCalls.totalTokensUsed} tokens, ${s.llmCalls.fallbackCount} fallbacks`
    : null;

  const penaltyCauseStr = Object.entries(s.penaltyCauses)
    .map(([cause, n]) => `${cause}×${n}`)
    .join(', ');

  const lines = [
    `=== Metrics [${s.role}/${agentShort}] ===`,
    `Duration: ${durationSec}s  |  Final score: ${s.finalScore}`,
    `Parcels: ${s.parcelsDelivered} delivered, ${s.parcelsMissed} missed`,
    `Penalties: ${s.penaltiesReceived}${penaltyCauseStr ? ` (${penaltyCauseStr})` : ''}`,
    `Planner calls:\n${plannerLines || '  (none)'}`,
    ...(llmLine ? [llmLine] : []),
    `Score samples: ${s.scoreTimeline.length}`,
  ];

  return lines.join('\n');
}
