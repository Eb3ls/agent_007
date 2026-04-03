# AGENTS.md — src/beliefs/

## Responsabilità
Modello del mondo dell'agente: topologia griglia (statica), stato osservato delle entità (parcelle, agenti, self) e snapshot immutabili per i planner.

## File chiave

| File | Descrizione |
|------|-------------|
| `belief-map.ts` | `BeliefMapImpl`: griglia statica con `isWalkable()`, `canEnterFrom(x,y,dir)`, `getDeliveryZones()`, `getSpawningTiles()` |
| `belief-store.ts` | `BeliefStore`: aggiorna stato parcelle/agenti/self da sensing, espone query per deliberator e planner |
| `belief-snapshot.ts` | `buildSnapshot(store)`: produce copia deep-frozen del belief state da passare ai planner |
| `parcel-tracker.ts` | `ParcelTracker`: stima decay rate per parcella e `estimateRewardAt(id, futureMs)` |

## Dipendenze da altri moduli interni
- `types.ts` — tutti i tipi di belief (15+ interfacce)
- `pathfinding/pathfinder.ts` — usato da `BeliefStore.getReachableParcels()` per filtrare parcelle non raggiungibili

## Dipendenze esterne
- Nessuna

## Vincoli DOMAIN_RULES rilevanti
- **R01** — `BeliefMapImpl` gestisce i tipi tile 0–7 (inclusi direzionali 4–7); `isWalkable()` ritorna `true` per tipi 1–7, `false` solo per tipo 0 e null.
- **R02** — `canEnterFrom(x, y, from)` implementa la restrizione di entrata per tile direzionali (tile 4: blocca da `'down'`; tile 5: da `'up'`; tile 6: da `'right'`; tile 7: da `'left'`). L'uscita è sempre permessa.
- **R03** — `BeliefMapImpl` è costruita una sola volta all'evento `'map'` e non viene mutata durante la partita.
- **R04** — `BeliefMap` contiene la topologia completa; `BeliefStore` contiene solo le entità nel campo visivo. Non mescolare i due.
- **R06** — `BeliefStore.updateSelf()` e `updateAgents()` applicano `Math.round()` su `x` e `y` prima di salvare. Nessun altro modulo riceve coordinate float.
- **R10** — Tutte le query di visibilità usano `manhattanDistance < sensingDistance` (operatore stretto `<`, non `<=`).
- **R11** — `observationDistance` è letto dall'evento `'config'` del server, non hardcoded.
- **R12** — `updateParcels()` distingue "tile confermata vuota" (entry ricevuta senza parcel) da "tile fuori sensing range" (nessun entry): le prime rimuovono la belief, le seconde no.
- **R15** — Parcelle con `reward = 0` non vengono rimosse dal belief set: restano come obstacle/noise. Il filtro `reward <= 0` appartiene al `deliberator.ts`.
- **R22** — `BeliefStore` traccia `penalty` (da `raw.penalty`): permette a `base-agent.ts` di emettere warning prima del kick a -1000.

## Cosa NON fare
- Non filtrare parcelle per `reward <= 0` in questo modulo: è responsabilità del `deliberator.ts` (R15).
- Non usare `<=` per confronti di sensing distance: sempre `<` (R10).
- Non aggiornare `BeliefMap` durante la partita (al di fuori dell'evento `'tile'` admin): la mappa è statica (R03).
- Non passare `BeliefStore` live ai planner lenti (PDDL/LLM): usare `buildSnapshot()` (Arch Decision #2).
- Non arrotondare coordinate in `game-client.ts` o nei planner: l'arrotondamento avviene solo qui (R06).
