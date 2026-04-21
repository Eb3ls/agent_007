import { fileURLToPath } from 'url';
import path from 'path';

export type MapCategory = 'open' | 'corridor' | 'maze' | 'directional' | 'path_width' | 'themed' | 'obstacles';

export interface MapEntry {
  readonly name: string;
  readonly category: MapCategory;
  readonly gamePath: string;
}

export interface ExcludedMap {
  readonly name: string;
  readonly reason: string;
}

// Compute base path from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const gameBasePath = path.join(
  projectRoot,
  'Deliveroo.js/packages/@unitn-asa/deliveroo-js-assets/assets/games'
);

// Helper to create map entries
function createMap(name: string, category: MapCategory): MapEntry {
  return {
    name,
    category,
    gamePath: path.join(gameBasePath, `${name}.json`),
  };
}

// 18 eligible maps grouped by category
const mapsByCategory: Record<MapCategory, MapEntry[]> = {
  open: [createMap('empty_10', 'open'), createMap('empty_30', 'open')],
  corridor: [createMap('hallway', 'corridor')],
  maze: [
    createMap('chaotic_maze', 'maze'),
    createMap('25c1_8', 'maze'),
    createMap('25c2_4', 'maze'),
  ],
  directional: [
    createMap('circuit', 'directional'),
    createMap('circuit_directional', 'directional'),
  ],
  path_width: [
    createMap('wide_paths', 'path_width'),
    createMap('small_paths', 'path_width'),
    createMap('small_two_wide', 'path_width'),
    createMap('long_hallways', 'path_width'),
    createMap('hallways_interconnected', 'path_width'),
  ],
  themed: [
    createMap('crossroads', 'themed'),
    createMap('vortex', 'themed'),
    createMap('tree', 'themed'),
    createMap('atom', 'themed'),
  ],
  obstacles: [createMap('two_obstacles', 'obstacles')],
};

export const MAPS: ReadonlyArray<MapEntry> = Object.values(mapsByCategory).flat();

export const EXCLUDED_MAPS: ReadonlyArray<ExcludedMap> = [
  {
    name: 'crates_maze',
    reason:
      'crate tiles (type 5/5!) parsed as one-way-down in game-client.ts; no crate logic in agent',
  },
  {
    name: 'crates_one_way',
    reason:
      'crate tiles (type 5/5!) parsed as one-way-down in game-client.ts; no crate logic in agent',
  },
  {
    name: 'decoration',
    reason:
      'degenerate layout: decorative concentric rings with single-tile passages; observation_distance=5 makes agent nearly blind',
  },
];

/**
 * Get all maps in a specific category
 */
export function getMapsByCategory(cat: MapCategory): ReadonlyArray<MapEntry> {
  return mapsByCategory[cat];
}

/**
 * Get a specific map by name, or undefined if not found
 */
export function getMapByName(name: string): MapEntry | undefined {
  return MAPS.find((m) => m.name === name);
}
