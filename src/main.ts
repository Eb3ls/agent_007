import { loadConfig } from './config/agent-config.js';
import { GameClient } from './client/game-client.js';

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
    console.log('Config loaded successfully:');
    console.log(JSON.stringify(config, null, 2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  // Connect to the game server
  const client = new GameClient(config.host, config.token);

  client.onMap((tiles, width, height) => {
    console.log(`Map received: ${width}x${height}, ${tiles.length} tiles`);
    const deliveryZones = tiles.filter(t => t.type === 2).length;
    const spawningTiles = tiles.filter(t => t.type === 1).length;
    const walkable = tiles.filter(t => t.type !== 0).length;
    console.log(`  Delivery zones: ${deliveryZones}, Spawning tiles: ${spawningTiles}, Walkable: ${walkable}`);
  });

  client.onYou((self) => {
    console.log(`You: ${self.name} at (${self.x}, ${self.y}) score=${self.score}`);
  });

  client.onParcelsSensing((parcels) => {
    if (parcels.length > 0) {
      console.log(`Parcels sensed: ${parcels.length}`);
      for (const p of parcels) {
        console.log(`  Parcel ${p.id} at (${p.x}, ${p.y}) reward=${p.reward} carriedBy=${p.carriedBy}`);
      }
    }
  });

  client.onAgentsSensing((agents) => {
    if (agents.length > 0) {
      console.log(`Agents sensed: ${agents.length}`);
      for (const a of agents) {
        console.log(`  Agent ${a.name} at (${a.x}, ${a.y}) score=${a.score}`);
      }
    }
  });

  client.onDisconnect(() => {
    console.log('Disconnected from server');
  });

  client.onReconnect(() => {
    console.log('Reconnected to server');
  });

  try {
    console.log(`\nConnecting to ${config.host}...`);
    await client.connect();
    const serverConfig = client.getServerConfig();
    console.log('Connected! Server config:', JSON.stringify(serverConfig, null, 2));
    console.log(`Measured action duration: ${client.getMeasuredActionDurationMs()}ms`);
  } catch (err) {
    console.error('Failed to connect:', (err as Error).message);
    process.exit(1);
  }

  // Drain any events that arrived during connect
  client.drainPending();

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    client.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
