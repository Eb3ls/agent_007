# AGENTS.md — src/planning/

## Responsabilità
Generare piani (lista di `PlanStep`) a partire da un'intenzione e un `BeliefSnapshot`, con fallback automatico tra planner.

## File chiave

| File | Descrizione |
|------|-------------|
| `planner-factory.ts` | `buildPlannerChain(opts)`: costruisce la catena `IPlanner` da config (`bfs`, `pddl→bfs`, `llm→pddl→bfs`) |
| `bfs-planner.ts` | A* + permutazioni (≤4 parcelle) o nearest-neighbor greedy (≥5); fallback always-available |
| `pddl-planner.ts` | Wrapper per solver PDDL esterno; riceve `BeliefSnapshot` immutabile |
| `llm-planner.ts` | Wrapper per LLM via `LlmClient`; riceve `BeliefSnapshot` e usa `prompt-templates.ts` |
| `plan-validator.ts` | `validate(plan, beliefs)`: verifica che ogni step sia ancora valido contro le credenze attuali |
| `planner.interface.ts` | Re-export di `IPlanner`, `PlanningRequest`, `PlanningResult` da `types.ts` |

## Dipendenze da altri moduli interni
- `types.ts` — `IPlanner`, `PlanningRequest/Result`, `BeliefSnapshot`, `LlmConfig`
- `pathfinding/pathfinder.ts` — usato da `BfsPlanner` per A*
- `llm/llm-client.ts`, `llm/llm-memory.ts` — usati da `LlmPlanner`
- `beliefs/` — `BeliefSnapshot` (mai live `BeliefStore` per planner lenti)

## Dipendenze esterne
- Solver PDDL esterno (`@unitn-asa/pddl-client`) — usato da `PddlPlanner`
- API LLM (HTTP, via `LlmClient`) — usata da `LlmPlanner`

## Vincoli DOMAIN_RULES rilevanti
- **R02** — `BfsPlanner` usa `pathfinder.ts` che usa `canEnterFrom()`: i piani generati rispettano le tile direzionali.
- **R05** — `BfsPlanner` passa `avoidPositions` (agenti nemici) al pathfinder per escludere tile bloccate.
- **R20** — Ogni piano include un passo `putdown` esplicito come ultimo step dopo l'arrivo sulla delivery tile.
- **R21** — `BfsPlanner` cerca la delivery tile più vicina tramite `belief-map.getDeliveryZones()`, non una predefinita.
- **Arch Decision #2** — `PddlPlanner` e `LlmPlanner` ricevono sempre `BeliefSnapshot` frozen, mai il live `BeliefStore`. `BfsPlanner` (veloce, <10ms) può usare lo stato live come fallback ultimo.
- **Arch Decision #4** — `planner-factory.ts` è l'unico posto dove viene costruita la catena. `BdiAgent` e `LlmAgent` non istanziano mai un planner direttamente.

## Cosa NON fare
- Non passare il live `BeliefStore` ai planner lenti (PDDL/LLM): usare `BeliefSnapshot` (Arch Decision #2).
- Non istanziare planner concreti fuori da `planner-factory.ts` (Arch Decision #4).
- Non generare piani senza il passo `putdown` finale su delivery tile (R20).
- Non hardcodare la delivery tile di destinazione: sempre la più vicina tra `getDeliveryZones()` (R21).
