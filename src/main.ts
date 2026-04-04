import { loadConfig } from './config/agent-config.js';
import { GameClient } from './client/game-client.js';
import { BdiAgent } from './agents/bdi-agent.js';
import { LlmAgent } from './agents/llm-agent.js';
import type { IAgent } from './types.js';

function parseArgs(args: string[]): { configPath: string } {
  const configIdx = args.indexOf('--config');
  if (configIdx === -1 || configIdx + 1 >= args.length) {
    console.error('Usage: npx tsx src/main.ts --config <path-to-config.json>');
    process.exit(1);
  }
  return { configPath: args[configIdx + 1] };
}

async function main(): Promise<void> {
  const { configPath } = parseArgs(process.argv);

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const client = new GameClient(config.host, config.token);

  // Wire agent before connect so it can register callbacks (drainPending
  // will replay the buffered map/you/sensing events).
  const agent: IAgent = config.role === 'llm' ? new LlmAgent() : new BdiAgent();
  await agent.init(client, config);

  if (config.recording?.enabled && config.recording.outputPath) {
    const mapName = process.env['EVAL_MAP_NAME'] ?? 'unknown';
    const runIndex = parseInt(process.env['EVAL_RUN_INDEX'] ?? '0', 10);
    const logsDir = process.env['EVAL_LOGS_DIR'] ?? 'logs';
    const { EvalLogger } = await import('./evaluation/eval-logger.js');
    const evalLog = new EvalLogger(mapName, runIndex, logsDir);
    (agent as unknown as { setEvalLogger: (l: unknown) => void }).setEvalLogger(evalLog);
  }

  try {
    await client.connect();
  } catch (err) {
    console.error('Failed to connect:', (err as Error).message);
    process.exit(1);
  }

  // Replay buffered events (map, you, initial sensing) into registered callbacks
  client.drainPending();

  await agent.start();
}

main();
