// ============================================================
// src/beliefs/belief-map.domain.test.ts
// Test delle regole di dominio per BeliefMapImpl
// R01, R02, RI01, RI02, R19, R21
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BeliefMapImpl } from './belief-map.js';
import type { Tile, TileType, Direction } from '../types.js';
import {
  FIXTURE_DIRECTIONAL_TILES,
  FIXTURE_DIRECTIONAL_WIDTH,
  FIXTURE_DIRECTIONAL_HEIGHT,
} from '../testing/fixtures.js';

function tile(x: number, y: number, type: TileType): Tile {
  return { x, y, type };
}

// --- Mappa con tutti i tipi di tile (0–7) ---
//
// Layout 5x2:
//   y=1:  type4  type5  type6  type7  type3
//   y=0:  type0  type1  type2  type3  type3
//
function makeAllTypesMap(): BeliefMapImpl {
  const tiles: Tile[] = [
    tile(0, 0, 0), tile(1, 0, 1), tile(2, 0, 2), tile(3, 0, 3), tile(4, 0, 3),
    tile(0, 1, 4), tile(1, 1, 5), tile(2, 1, 6), tile(3, 1, 7), tile(4, 1, 3),
  ];
  return new BeliefMapImpl(tiles, 5, 2);
}

// --- R01: tutti i tipi tile (0–7) sono gestiti da getTileType() ---

describe('BeliefMapImpl — R01 tutti i tipi tile (0–7)', () => {
  const map = makeAllTypesMap();

  it('tipo 0 (muro): getTile ritorna 0', () => {
    assert.equal(map.getTile(0, 0), 0);
  });

  it('tipo 1 (spawning): getTile ritorna 1', () => {
    assert.equal(map.getTile(1, 0), 1);
  });

  it('tipo 2 (delivery): getTile ritorna 2', () => {
    assert.equal(map.getTile(2, 0), 2);
  });

  it('tipo 3 (normale): getTile ritorna 3', () => {
    assert.equal(map.getTile(3, 0), 3);
  });

  it('tipo 4 (↑ direzionale): getTile ritorna 4', () => {
    assert.equal(map.getTile(0, 1), 4);
  });

  it('tipo 5 (↓ direzionale): getTile ritorna 5', () => {
    assert.equal(map.getTile(1, 1), 5);
  });

  it('tipo 6 (← direzionale): getTile ritorna 6', () => {
    assert.equal(map.getTile(2, 1), 6);
  });

  it('tipo 7 (→ direzionale): getTile ritorna 7', () => {
    assert.equal(map.getTile(3, 1), 7);
  });
});

// --- RI01/RI02: tile tipo 1 e 2 sono walkable; solo tipo 0 è non-walkable ---

describe('BeliefMapImpl — RI01/RI02 walkability', () => {
  const map = makeAllTypesMap();

  it('tipo 1 (spawning) è walkable', () => {
    assert.equal(map.isWalkable(1, 0), true);
  });

  it('tipo 2 (delivery) è walkable', () => {
    assert.equal(map.isWalkable(2, 0), true);
  });

  it('tipo 3 (normale) è walkable', () => {
    assert.equal(map.isWalkable(3, 0), true);
  });

  it('tipo 4 (↑) è walkable (senza vincoli di entrata)', () => {
    assert.equal(map.isWalkable(0, 1), true);
  });

  it('tipo 5 (↓) è walkable (senza vincoli di entrata)', () => {
    assert.equal(map.isWalkable(1, 1), true);
  });

  it('tipo 6 (←) è walkable (senza vincoli di entrata)', () => {
    assert.equal(map.isWalkable(2, 1), true);
  });

  it('tipo 7 (→) è walkable (senza vincoli di entrata)', () => {
    assert.equal(map.isWalkable(3, 1), true);
  });

  it('solo tipo 0 è non-walkable', () => {
    assert.equal(map.isWalkable(0, 0), false);
  });
});

// --- R02: canEnterFrom — ogni tipo direzionale blocca solo la direzione opposta ---

describe('BeliefMapImpl — R02 canEnterFrom (tile direzionali)', () => {
  const map = new BeliefMapImpl(FIXTURE_DIRECTIONAL_TILES, FIXTURE_DIRECTIONAL_WIDTH, FIXTURE_DIRECTIONAL_HEIGHT);
  // Fixture: (1,1)=type4(↑), (3,1)=type5(↓)

  // --- Semantica canEnterFrom: from = direzione del movimento (non provenienza geografica) ---
  //
  // 'up'    = ci si muove verso y+1 (da Sud verso Nord)  → si entra in (1,1) da (1,0)
  // 'down'  = ci si muove verso y-1 (da Nord verso Sud)  → si entra in (1,1) da (1,2)
  // 'right' = ci si muove verso x+1 (da Ovest verso Est) → si entra in (1,1) da (0,1)
  // 'left'  = ci si muove verso x-1 (da Est verso Ovest) → si entra in (1,1) da (2,1)
  //
  // Tile ↑ (type 4): freccia punta Nord → blocca l'entrata dall'opposto = da Nord
  //   "entrare da Nord" = muoversi verso Sud = from='down' → BLOCCATO
  //   "entrare da Sud"  = muoversi verso Nord = from='up' → PERMESSO
  // Confermato da pathfinder.test.ts: "type 4 (↑): allows entry moving up (dy=+1), blocks entry from above"

  describe('tipo 4 (↑) a (1,1)', () => {
    it('blocca entrata da Nord (from=down): non si può entrare da (1,2) muovendosi verso il basso', () => {
      // Da (1,2) verso (1,1): ci si muove in direzione down (y decresce)
      // Il tile ↑ (freccia su) blocca chi entra muovendosi verso il basso (from=down)
      assert.equal(map.canEnterFrom(1, 1, 'down'), false,
        'tile ↑ (4): blocca entrata from=down (entrata da Nord, movimento verso il basso)');
    });

    it('permette entrata da Sud (from=up): da (1,0) verso (1,1) muovendosi verso l\'alto', () => {
      assert.equal(map.canEnterFrom(1, 1, 'up'), true,
        'tile ↑ (4): permette entrata from=up (entrata da Sud, movimento verso l\'alto)');
    });

    it('permette entrata da Ovest (from=right): da (0,1) verso (1,1)', () => {
      assert.equal(map.canEnterFrom(1, 1, 'right'), true,
        'tile ↑ (4): permette entrata from=right');
    });

    it('permette entrata da Est (from=left): da (2,1) verso (1,1)', () => {
      assert.equal(map.canEnterFrom(1, 1, 'left'), true,
        'tile ↑ (4): permette entrata from=left');
    });
  });

  // Tile ↓ (type 5): freccia punta Sud → blocca l'entrata dall'opposto = da Sud
  //   "entrare da Sud"  = muoversi verso Nord = from='up' → BLOCCATO
  //   "entrare da Nord" = muoversi verso Sud  = from='down' → PERMESSO

  describe('tipo 5 (↓) a (3,1)', () => {
    it('blocca entrata da Sud (from=up): non si può entrare da (3,0) muovendosi verso l\'alto', () => {
      assert.equal(map.canEnterFrom(3, 1, 'up'), false,
        'tile ↓ (5): blocca entrata from=up (entrata da Sud, movimento verso l\'alto)');
    });

    it('permette entrata da Nord (from=down): da (3,2) verso (3,1) muovendosi verso il basso', () => {
      assert.equal(map.canEnterFrom(3, 1, 'down'), true,
        'tile ↓ (5): permette entrata from=down (entrata da Nord, movimento verso il basso)');
    });

    it('permette entrata da Ovest (from=right)', () => {
      assert.equal(map.canEnterFrom(3, 1, 'right'), true,
        'tile ↓ (5): permette entrata from=right');
    });

    it('permette entrata da Est (from=left)', () => {
      assert.equal(map.canEnterFrom(3, 1, 'left'), true,
        'tile ↓ (5): permette entrata from=left');
    });
  });

  describe('tipo 6 (←) a (2,1)', () => {
    const map6 = makeAllTypesMap();
    // tile (2,1) = type 6 (←)

    it('blocca entrata da Ovest (from=right): non si può entrare da (1,1)', () => {
      assert.equal(map6.canEnterFrom(2, 1, 'right'), false,
        'tile ← (6): blocca entrata from=right (provenienza Ovest)');
    });

    it('permette entrata da Est (from=left): da (3,1) verso (2,1)', () => {
      assert.equal(map6.canEnterFrom(2, 1, 'left'), true,
        'tile ← (6): permette entrata from=left (provenienza Est)');
    });

    it('permette entrata da Sud (from=up)', () => {
      assert.equal(map6.canEnterFrom(2, 1, 'up'), true);
    });

    it('permette entrata da Nord (from=down)', () => {
      assert.equal(map6.canEnterFrom(2, 1, 'down'), true);
    });
  });

  describe('tipo 7 (→) a (3,1)', () => {
    const map7 = makeAllTypesMap();
    // tile (3,1) = type 7 (→)

    it('blocca entrata da Est (from=left): non si può entrare da (4,1)', () => {
      assert.equal(map7.canEnterFrom(3, 1, 'left'), false,
        'tile → (7): blocca entrata from=left (provenienza Est)');
    });

    it('permette entrata da Ovest (from=right): da (2,1) verso (3,1)', () => {
      assert.equal(map7.canEnterFrom(3, 1, 'right'), true,
        'tile → (7): permette entrata from=right (provenienza Ovest)');
    });

    it('permette entrata da Sud (from=up)', () => {
      assert.equal(map7.canEnterFrom(3, 1, 'up'), true);
    });

    it('permette entrata da Nord (from=down)', () => {
      assert.equal(map7.canEnterFrom(3, 1, 'down'), true);
    });
  });

  describe('mappa senza tile direzionali — canEnterFrom equivalente a isWalkable', () => {
    // Mappa 3x3: solo tipo 0, 1, 2, 3
    const plainTiles: Tile[] = [
      tile(0, 0, 0), tile(1, 0, 1), tile(2, 0, 2),
      tile(0, 1, 3), tile(1, 1, 3), tile(2, 1, 3),
      tile(0, 2, 3), tile(1, 2, 3), tile(2, 2, 3),
    ];
    const plainMap = new BeliefMapImpl(plainTiles, 3, 3);
    const dirs: Direction[] = ['up', 'down', 'left', 'right'];

    it('tile walkable (tipo 3): canEnterFrom=true da qualsiasi direzione', () => {
      for (const dir of dirs) {
        assert.equal(plainMap.canEnterFrom(1, 1, dir), true,
          `tipo 3: canEnterFrom should be true from ${dir}`);
      }
    });

    it('tile spawning (tipo 1): canEnterFrom=true da qualsiasi direzione', () => {
      for (const dir of dirs) {
        assert.equal(plainMap.canEnterFrom(1, 0, dir), true,
          `tipo 1: canEnterFrom should be true from ${dir}`);
      }
    });

    it('tile delivery (tipo 2): canEnterFrom=true da qualsiasi direzione', () => {
      for (const dir of dirs) {
        assert.equal(plainMap.canEnterFrom(2, 0, dir), true,
          `tipo 2: canEnterFrom should be true from ${dir}`);
      }
    });

    it('tile muro (tipo 0): canEnterFrom=false da qualsiasi direzione', () => {
      for (const dir of dirs) {
        assert.equal(plainMap.canEnterFrom(0, 0, dir), false,
          `tipo 0: canEnterFrom should be false from ${dir}`);
      }
    });

    it('out-of-bounds: canEnterFrom=false', () => {
      assert.equal(plainMap.canEnterFrom(-1, 0, 'right'), false);
      assert.equal(plainMap.canEnterFrom(3, 0, 'left'), false);
    });
  });

  // R02: l'uscita da un tile direzionale è sempre permessa (non ristretta)
  describe('R02: uscita da tile direzionale sempre permessa (non è restrizione di uscita)', () => {
    it('da tile ↑ (1,1) verso (1,0): isWalkable(1,0) = true (uscita non ristretta)', () => {
      // Il tile ↑ non restringe l'uscita — si esce sempre; la restrizione è sull'entrata
      // Verificato tramite canEnterFrom del tile di destinazione (1,0) che è tipo 3
      assert.equal(map.canEnterFrom(1, 0, 'down'), true,
        'Uscita da tile ↑ verso (1,0): il tile destinazione (tipo 3) permette entrata da qualsiasi dir');
    });

    it('da tile ↓ (3,1) verso (3,0): tile destinazione è walkable', () => {
      assert.equal(map.canEnterFrom(3, 0, 'down'), true);
    });
  });
});

// --- R19: getSpawningTiles() ritorna solo tile tipo 1 ---
// --- R21: getDeliveryZones() ritorna solo tile tipo 2 ---

describe('BeliefMapImpl — R19/R21 getSpawningTiles e getDeliveryZones', () => {
  const map = makeAllTypesMap();

  it('R19: getSpawningTiles ritorna solo tile tipo 1', () => {
    const spawns = map.getSpawningTiles();
    assert.equal(spawns.length, 1, 'solo una tile tipo 1 nella mappa test');
    assert.deepEqual(spawns[0], { x: 1, y: 0 });
    // Verifica che nessun tile direzionale (4-7) sia incluso
    for (const s of spawns) {
      assert.equal(map.getTile(s.x, s.y), 1, `tile (${s.x},${s.y}) deve essere tipo 1`);
    }
  });

  it('R21: getDeliveryZones ritorna solo tile tipo 2', () => {
    const zones = map.getDeliveryZones();
    assert.equal(zones.length, 1, 'solo una tile tipo 2 nella mappa test');
    assert.deepEqual(zones[0], { x: 2, y: 0 });
    // Verifica che nessun tile direzionale sia incluso
    for (const z of zones) {
      assert.equal(map.getTile(z.x, z.y), 2, `tile (${z.x},${z.y}) deve essere tipo 2`);
    }
  });

  it('mappa senza spawning tiles: getSpawningTiles ritorna array vuoto', () => {
    const noSpawnTiles: Tile[] = [
      tile(0, 0, 0), tile(1, 0, 2), tile(2, 0, 3),
    ];
    const m = new BeliefMapImpl(noSpawnTiles, 3, 1);
    assert.equal(m.getSpawningTiles().length, 0);
  });

  it('mappa senza delivery zones: getDeliveryZones ritorna array vuoto', () => {
    const noDeliveryTiles: Tile[] = [
      tile(0, 0, 1), tile(1, 0, 3), tile(2, 0, 3),
    ];
    const m = new BeliefMapImpl(noDeliveryTiles, 3, 1);
    assert.equal(m.getDeliveryZones().length, 0);
  });

  it('tile direzionali (4-7) non compaiono in getSpawningTiles', () => {
    const directionalMap = new BeliefMapImpl(
      FIXTURE_DIRECTIONAL_TILES, FIXTURE_DIRECTIONAL_WIDTH, FIXTURE_DIRECTIONAL_HEIGHT,
    );
    const spawns = directionalMap.getSpawningTiles();
    for (const s of spawns) {
      const type = directionalMap.getTile(s.x, s.y);
      assert.equal(type, 1, 'solo tipo 1 nelle spawning tiles');
    }
  });

  it('tile direzionali (4-7) non compaiono in getDeliveryZones', () => {
    const directionalMap = new BeliefMapImpl(
      FIXTURE_DIRECTIONAL_TILES, FIXTURE_DIRECTIONAL_WIDTH, FIXTURE_DIRECTIONAL_HEIGHT,
    );
    const zones = directionalMap.getDeliveryZones();
    for (const z of zones) {
      const type = directionalMap.getTile(z.x, z.y);
      assert.equal(type, 2, 'solo tipo 2 nelle delivery zones');
    }
  });
});
