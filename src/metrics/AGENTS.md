# AGENTS.md — src/metrics/

## Responsabilità
Raccogliere e serializzare le statistiche di una sessione di gioco (score timeline, consegne, penalità, stats planner).

## File chiave

| File | Descrizione |
|------|-------------|
| `metrics-collector.ts` | Accumula eventi (`recordScore`, `recordParcelDelivered`, `recordPlannerCall`, ecc.) e li esporta come JSON |
| `metrics-snapshot.ts` | `formatSummary(snapshot)`: formatta lo snapshot come stringa multi-linea per la console |

## Dipendenze da altri moduli interni
- `types.ts` — `AgentRole`, `MetricsSnapshot`

## Dipendenze esterne
- `node:fs/promises` — `writeFile`, `mkdir` per export JSON su file
- `node:path` — `dirname` per creare la directory di output se non esiste

## Vincoli DOMAIN_RULES rilevanti
- **R22** — `recordPenalty(cause)` deve tracciare sia il contatore totale che la causa (es. `'collision'`, `'concurrent_action'`): permette di identificare quali comportamenti generano penalità irreversibili.
- **R14** — `scoreTimeline` è una serie temporale campionata ogni `sampleIntervalMs` (default 5s): utile per correlare il decay del reward con l'efficienza del planner.

## Cosa NON fare
- Non accedere a `GameClient` o `BeliefStore` direttamente: le metriche vengono alimentate da `base-agent.ts` tramite le API `record*`.
- Non bloccare il thread principale per l'export: `exportJson()` è `async` e non va `await`-ata nel loop critico.
- Non rimuovere dati storici durante la sessione: il collector è append-only.
