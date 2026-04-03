# AGENTS.md — src/pathfinding/

## Responsabilità
Calcolo percorsi ottimali su `BeliefMap` con grafo orientato (tile direzionali) e supporto a ostacoli dinamici.

## File chiave

| File | Descrizione |
|------|-------------|
| `pathfinder.ts` | `findPath(from, to, map, dynamicObstacles?)`: A* con grafo orientato; ritorna `Position[]` o `null` |
| `grid-utils.ts` | `getNeighbors(pos, map, dynamicObstacles?)`: vicini validi rispettando `canEnterFrom()` e ostacoli; `isValidPosition()` |

## Dipendenze da altri moduli interni
- `types.ts` — `BeliefMap`, `Position`, `Direction`
- `beliefs/belief-map.ts` — usato tramite interfaccia `BeliefMap` (mai dipendenza diretta dalla classe concreta)

## Dipendenze esterne
- Nessuna

## Vincoli DOMAIN_RULES rilevanti
- **R02** — Il pathfinder costruisce un grafo orientato: l'arco `u→v` esiste solo se `map.canEnterFrom(v.x, v.y, dir_da_u_a_v)` ritorna `true`. Non usare `isWalkable()` per i neighbor check.
- **R05** — `dynamicObstacles` (posizioni di agenti in movimento) vengono escluse dal grafo durante il calcolo: non pianificare percorsi che attraversano tile bloccate da movimenti in corso.
- **R06** — Il pathfinder riceve e restituisce solo coordinate intere: l'arrotondamento è già stato applicato da `belief-store.ts`.
- **R09** — `getNeighbors()` applica la convenzione `up=y+1, down=y-1, right=x+1, left=x-1`. Nessun altro punto di inversione degli assi.

## Cosa NON fare
- Non usare `isWalkable()` al posto di `canEnterFrom()` per la navigazione: è cieco alle restrizioni direzionali (R02).
- Non passare coordinate float a `findPath()`: deve ricevere interi (R06).
- Non hardcodare la dimensione della griglia: usare `map.width` e `map.height`.
- Non importare direttamente `BeliefMapImpl` (la classe concreta): dipendere solo dall'interfaccia `BeliefMap`.
