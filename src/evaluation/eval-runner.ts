// ============================================================
// src/evaluation/eval-runner.ts — Evaluation orchestrator CLI
// Usage: npx tsx src/evaluation/eval-runner.ts [--duration 300] [--runs 5] [--parallel 4]
// ============================================================

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { MAPS } from './map-registry.js';
import type { MapEntry } from './map-registry.js';
import { writeL2Summary } from './eval-summarizer.js';
import { generateReport } from './eval-report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ----------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------

function parseArgs(): { durationSec: number; runs: number; parallel: number } {
  const args = process.argv.slice(2);
  let durationSec = 300;
  let runs = 5;
  let parallel = 4;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--duration' && args[i + 1]) {
      durationSec = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--runs' && args[i + 1]) {
      runs = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--parallel' && args[i + 1]) {
      parallel = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { durationSec, runs, parallel };
}

// ----------------------------------------------------------------
// Process utilities
// ----------------------------------------------------------------

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function pollServerReady(port: number, maxAttempts = 15, intervalMs = 500): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (res.ok || res.status < 500) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Fetch a JWT token from the server's /api/tokens endpoint.
 * The server generates a new token for any provided name.
 */
async function fetchJwt(port: number, agentName: string): Promise<string> {
  const url = `http://localhost:${port}/api/tokens?name=${encodeURIComponent(agentName)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Failed to fetch JWT from port ${port}: HTTP ${res.status}`);
  const body = await res.json() as { token?: string };
  if (!body.token) throw new Error(`No token in response from port ${port}`);
  return body.token;
}

// ----------------------------------------------------------------
// Find the L1 file for a specific runIndex in a directory.
// Filename format: run_${runIndex}_${startTs}.jsonl
// Multiple runs of the same map can execute simultaneously, so we
// must filter by runIndex, not just by mtime.
// ----------------------------------------------------------------

function findL1FileForRun(dir: string, runIndex: number): string | null {
  if (!fs.existsSync(dir)) return null;

  let files: string[];
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.startsWith(`run_${runIndex}_`) && f.endsWith('.jsonl'))
      .map(f => path.join(dir, f));
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  // If multiple files match (unlikely but possible after reruns), pick latest mtime
  if (files.length === 1) return files[0];
  return files.reduce((best, f) =>
    fs.statSync(f).mtimeMs > fs.statSync(best).mtimeMs ? f : best,
  );
}

// ----------------------------------------------------------------
// Episode runner
// ----------------------------------------------------------------

let episodesCompleted = 0;
let totalEpisodes = 0;

async function runEpisode(
  map: MapEntry,
  runIndex: number,
  port: number,
  durationMs: number,
  logsDir: string,
): Promise<void> {
  const configPath = `/tmp/eval-config-${port}.json`;

  let server: ChildProcess | null = null;
  let agent: ChildProcess | null = null;

  try {
    // 1. Spawn server
    server = spawn(
      'node',
      ['Deliveroo.js/backend/index.js', '--port', String(port), '--game', map.gamePath],
      { cwd: PROJECT_ROOT, stdio: 'ignore' },
    );

    // 2. Poll until ready
    const ready = await pollServerReady(port);
    if (!ready) {
      console.log(`[slot ${port}] warning: server on port ${port} not ready after 15 attempts, proceeding anyway`);
    }

    // 3. Fetch a JWT token from the server
    let token: string;
    try {
      token = await fetchJwt(port, `eval-agent-${port}`);
    } catch (err) {
      console.log(`[slot ${port}] warning: could not fetch JWT (${err}), skipping episode`);
      return;
    }

    // 4. Write temp config with the real JWT
    const config = {
      host: `http://localhost:${port}`,
      token,
      role: 'bdi',
      planner: 'bfs',
      logLevel: 'warn',
      stagnationTimeoutMs: 15000,
      recording: {
        enabled: true,
        outputPath: 'logs',
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    // 5. Spawn agent
    agent = spawn(
      'npx',
      ['tsx', 'src/main.ts', '--config', configPath],
      {
        cwd: PROJECT_ROOT,
        stdio: 'ignore',
        env: {
          ...process.env,
          EVAL_MAP_NAME: map.name,
          EVAL_RUN_INDEX: String(runIndex),
          EVAL_LOGS_DIR: logsDir,
        },
      },
    );

    // 6. Wait duration
    await new Promise(r => setTimeout(r, durationMs));

    // 7. Terminate agent
    agent.kill('SIGTERM');
    await waitForExit(agent, 5000);
    agent = null;

    // 8. Terminate server
    server.kill('SIGTERM');
    await waitForExit(server, 5000);
    server = null;

    // 9. Find L1 file for this specific run
    const l1Dir = path.join(logsDir, 'L1', map.name);
    const l1FilePath = findL1FileForRun(l1Dir, runIndex);

    // 10. Generate L2 summary
    if (!l1FilePath) {
      console.log(`[slot ${port}] warning: no L1 file found for ${map.name} run ${runIndex}, skipping L2 generation`);
    } else {
      try {
        await writeL2Summary(l1FilePath, map.name, map.category, runIndex, durationMs, logsDir);
      } catch (err) {
        console.log(`[slot ${port}] error generating L2 summary for ${map.name} run ${runIndex}: ${err}`);
      }
    }

    // 11. Progress log
    episodesCompleted++;
    console.log(`[slot ${port}] done ${map.name} run ${runIndex + 1}/${Math.ceil(totalEpisodes / MAPS.length)} (episode ${episodesCompleted}/${totalEpisodes})`);

  } finally {
    // Ensure processes are killed if something went wrong
    if (agent) {
      agent.kill('SIGKILL');
    }
    if (server) {
      server.kill('SIGKILL');
    }

    // 11. Delete temp config
    try {
      fs.unlinkSync(configPath);
    } catch {
      // Ignore if already deleted
    }
  }
}

// ----------------------------------------------------------------
// Slot runner
// ----------------------------------------------------------------

async function runSlot(
  port: number,
  queue: Array<{ map: MapEntry; runIndex: number }>,
  durationMs: number,
  logsDir: string,
): Promise<void> {
  while (queue.length > 0) {
    const work = queue.shift()!;
    try {
      await runEpisode(work.map, work.runIndex, port, durationMs, logsDir);
    } catch (err) {
      console.log(`[slot ${port}] error in episode ${work.map.name} run ${work.runIndex}: ${err}`);
    }
  }
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

async function main(): Promise<void> {
  const { durationSec, runs, parallel } = parseArgs();
  const durationMs = durationSec * 1000;
  const logsDir = path.join(PROJECT_ROOT, 'logs');

  totalEpisodes = MAPS.length * runs;

  console.log(
    `Starting evaluation: ${MAPS.length} maps × ${runs} runs = ${totalEpisodes} episodes, ${parallel} parallel slots`,
  );

  // Build queue
  const queue: Array<{ map: MapEntry; runIndex: number }> = [];
  for (const map of MAPS) {
    for (let r = 0; r < runs; r++) {
      queue.push({ map, runIndex: r });
    }
  }

  // Build port list
  const ports = Array.from({ length: parallel }, (_, i) => 9000 + i);

  // Run all slots concurrently
  await Promise.all(ports.map(port => runSlot(port, queue, durationMs, logsDir)));

  console.log('All episodes complete. Generating cross-map report...');
  generateReport(logsDir);
  console.log(`Report written to logs/evaluation-report.json`);
}

main().catch(console.error);
