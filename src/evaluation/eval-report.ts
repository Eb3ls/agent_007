// ============================================================
// src/evaluation/eval-report.ts — Cross-map evaluation report
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { MAPS, EXCLUDED_MAPS } from './map-registry.js';
import type { L2Summary } from './eval-summarizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ----------------------------------------------------------------
// EvaluationReport type
// ----------------------------------------------------------------

export interface EvaluationReport {
  v: 1;
  generatedAt: string;
  config: {
    durMs: number;
    runs: number;
    parallel: 4;
    maps: 18;
    excluded: string[];
  };
  global: {
    gScore: number;
    meanSPM: number;
    medianSPM: number;
    worstMap: { map: string; spm: number };
    bestMap: { map: string; spm: number };
    bestWorstRatio: number;
    overfitDetected: boolean;
    totalEpisodes: number;
    meanDelivPerEp: number;
    meanPenPerEp: number;
  };
  categories: Record<string, {
    maps: string[];
    meanSPM: number;
    cv: number;
    g: number;
  }>;
  perMap: Array<{
    map: string;
    cat: string;
    runs: number;
    meanScore: number;
    sdScore: number;
    meanSPM: number;
    cvSPM: number;
    meanDeliv: number;
    meanPlanFail: number;
    meanPen: number;
    meanStagn: number;
    anomalies: Record<string, number>;
  }>;
  anomalySummary: {
    total: number;
    byType: Record<string, { n: number; maps: string[] }>;
    worstMap: string;
    worstCount: number;
  };
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sd(values: number[], avg?: number): number {
  if (values.length < 2) return 0;
  const m = avg ?? mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function cv(values: number[]): number {
  const m = mean(values);
  if (m === 0) return 0;
  return sd(values, m) / m;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function planFailRate(summary: L2Summary): number {
  let totalN = 0;
  let totalFail = 0;
  for (const stats of Object.values(summary.planning.planners)) {
    totalN += stats.n;
    totalFail += stats.fail;
  }
  return totalN > 0 ? totalFail / totalN : 0;
}

function readL2Files(l2Dir: string): L2Summary[] {
  const summaries: L2Summary[] = [];
  if (!fs.existsSync(l2Dir)) return summaries;

  let files: string[];
  try {
    files = fs.readdirSync(l2Dir).filter(f => f.endsWith('.json'));
  } catch {
    return summaries;
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(l2Dir, file), 'utf8');
      const parsed = JSON.parse(raw) as L2Summary;
      summaries.push(parsed);
    } catch {
      // Skip malformed files
    }
  }

  return summaries;
}

// ----------------------------------------------------------------
// generateReport
// ----------------------------------------------------------------

export function generateReport(logsBaseDir?: string): EvaluationReport {
  const baseDir = logsBaseDir ?? path.join(PROJECT_ROOT, 'logs');
  const l2Root = path.join(baseDir, 'L2');

  // --- Collect data per map ---
  interface MapData {
    name: string;
    cat: string;
    summaries: L2Summary[];
  }

  const allMapData: MapData[] = MAPS.map(entry => ({
    name: entry.name,
    cat: entry.category,
    summaries: readL2Files(path.join(l2Root, entry.name)),
  }));

  // --- Determine config fields from data ---
  let configDurMs = 300000;
  let maxRuns = 0;
  for (const md of allMapData) {
    for (const s of md.summaries) {
      if (s.durMs > 0) configDurMs = s.durMs;
      if (s.run + 1 > maxRuns) maxRuns = s.run + 1;
    }
  }

  // --- Per-map stats ---
  const perMap: EvaluationReport['perMap'] = [];

  for (const md of allMapData) {
    const nonPartial = md.summaries.filter(s => !s.partial);
    const runs = nonPartial.length;

    const scores = nonPartial.map(s => s.finalScore);
    const spms = nonPartial.map(s => s.throughput.spm);
    const delivs = nonPartial.map(s => s.throughput.deliveries);
    const pens = nonPartial.map(s => s.movement.penalties);
    const stagns = nonPartial.map(s => s.health.stagnations);
    const planFails = nonPartial.map(s => planFailRate(s));

    const meanScore = mean(scores);
    const sdScore = sd(scores);
    const meanSPM = mean(spms);
    const cvSPM = cv(spms);
    const meanDeliv = mean(delivs);
    const meanPlanFail = mean(planFails);
    const meanPen = mean(pens);
    const meanStagn = mean(stagns);

    // Anomaly counts per type
    const anomalyMap: Record<string, number> = {};
    for (const s of nonPartial) {
      for (const a of s.anomalies) {
        anomalyMap[a.type] = (anomalyMap[a.type] ?? 0) + 1;
      }
    }
    // Average per run
    const anomaliesPerRun: Record<string, number> = {};
    for (const [type, count] of Object.entries(anomalyMap)) {
      anomaliesPerRun[type] = runs > 0 ? count / runs : 0;
    }

    perMap.push({
      map: md.name,
      cat: md.cat,
      runs,
      meanScore,
      sdScore,
      meanSPM,
      cvSPM,
      meanDeliv,
      meanPlanFail,
      meanPen,
      meanStagn,
      anomalies: anomaliesPerRun,
    });
  }

  // --- Global stats ---
  // Only maps with at least one run contribute to G-score
  const mapsWithData = perMap.filter(m => m.runs > 0);
  const mapMeanSpms = mapsWithData.map(m => m.meanSPM);

  const globalMeanSPM = mean(mapMeanSpms);
  const globalMedianSPM = median(mapMeanSpms);
  const globalCv = cv(mapMeanSpms);
  const gScore = 1 - globalCv;

  const sortedBySpm = [...mapsWithData].sort((a, b) => a.meanSPM - b.meanSPM);
  const worstMapEntry = sortedBySpm[0] ?? { map: '', meanSPM: 0 };
  const bestMapEntry = sortedBySpm[sortedBySpm.length - 1] ?? { map: '', meanSPM: 0 };

  const minSPM = worstMapEntry.meanSPM;
  const maxSPM = bestMapEntry.meanSPM;
  // When minSPM=0, ratio is undefined; treat as infinite (worst possible gap).
  const bestWorstRatio = minSPM > 0 ? maxSPM / minSPM : -1; // -1 means "infinite"
  const overfitDetected = (bestWorstRatio < 0 || bestWorstRatio > 5.0) && minSPM < 15 && gScore < 0.5;

  const totalEpisodes = perMap.reduce((s, m) => s + m.runs, 0);
  const meanDelivPerEp = totalEpisodes > 0
    ? perMap.reduce((s, m) => s + m.meanDeliv * m.runs, 0) / totalEpisodes
    : 0;
  const meanPenPerEp = totalEpisodes > 0
    ? perMap.reduce((s, m) => s + m.meanPen * m.runs, 0) / totalEpisodes
    : 0;

  // --- Category aggregates ---
  const categories: EvaluationReport['categories'] = {};
  const catGroups: Record<string, string[]> = {};

  for (const m of perMap) {
    if (!catGroups[m.cat]) catGroups[m.cat] = [];
    catGroups[m.cat].push(m.map);
  }

  for (const [cat, mapNames] of Object.entries(catGroups)) {
    const catMaps = perMap.filter(m => m.cat === cat && m.runs > 0);
    const catSpms = catMaps.map(m => m.meanSPM);
    const catMeanSPM = mean(catSpms);
    const catCv = cv(catSpms);

    categories[cat] = {
      maps: mapNames,
      meanSPM: catMeanSPM,
      cv: catCv,
      g: 1 - catCv,
    };
  }

  // --- Anomaly summary ---
  const byType: Record<string, { n: number; maps: string[] }> = {};
  const anomalyCountPerMap: Record<string, number> = {};

  for (const s of allMapData) {
    const nonPartial = s.summaries.filter(x => !x.partial);
    let mapTotal = 0;
    for (const run of nonPartial) {
      for (const a of run.anomalies) {
        if (!byType[a.type]) byType[a.type] = { n: 0, maps: [] };
        byType[a.type].n++;
        if (!byType[a.type].maps.includes(s.name)) {
          byType[a.type].maps.push(s.name);
        }
        mapTotal++;
      }
    }
    anomalyCountPerMap[s.name] = mapTotal;
  }

  const totalAnomalies = Object.values(byType).reduce((sum, v) => sum + v.n, 0);
  const worstAnomalyEntry = Object.entries(anomalyCountPerMap)
    .sort((a, b) => b[1] - a[1])[0];

  const anomalySummary: EvaluationReport['anomalySummary'] = {
    total: totalAnomalies,
    byType,
    worstMap: worstAnomalyEntry?.[0] ?? '',
    worstCount: worstAnomalyEntry?.[1] ?? 0,
  };

  // --- Assemble report ---
  const report: EvaluationReport = {
    v: 1,
    generatedAt: new Date().toISOString(),
    config: {
      durMs: configDurMs,
      runs: maxRuns,
      parallel: 4,
      maps: 18,
      excluded: EXCLUDED_MAPS.map(e => e.name),
    },
    global: {
      gScore,
      meanSPM: globalMeanSPM,
      medianSPM: globalMedianSPM,
      worstMap: { map: worstMapEntry.map, spm: minSPM },
      bestMap: { map: bestMapEntry.map, spm: maxSPM },
      bestWorstRatio,
      overfitDetected,
      totalEpisodes,
      meanDelivPerEp,
      meanPenPerEp,
    },
    categories,
    perMap,
    anomalySummary,
  };

  // --- Write output ---
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, 'evaluation-report.json'),
      JSON.stringify(report, null, 2),
      'utf8',
    );
  } catch {
    // Non-fatal: return report even if write fails
  }

  return report;
}
