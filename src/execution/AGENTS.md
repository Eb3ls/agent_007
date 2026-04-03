# AGENTS.md — src/execution/

## Responsabilità
Eseguire i passi del piano in sequenza su `GameClient`, garantendo l'azione-mutex e distinguendo collisioni (replan) da fallimenti transienti (retry).

## File chiave

| File | Descrizione |
|------|-------------|
| `action-executor.ts` | `ActionExecutor`: esegue `PlanStep[]` uno alla volta con retry, emette `onReplanRequired` dopo `MAX_MOVE_RETRIES` fallimenti consecutivi |
| `action-types.ts` | `actionToDirection(action)`: unica conversione `ActionType ↔ Direction`; `isMoveAction(action)` |

## Dipendenze da altri moduli interni
- `types.ts` — `IActionExecutor`, `Plan`, `PlanStep`, `ReplanSignal`, `ActionType`, `Direction`
- `client/game-client.ts` — `emitMove`, `emitPickup`, `emitPutdown` (async, attendono ack server)

## Dipendenze esterne
- Server Deliveroo.js (indirettamente via `GameClient`)

## Vincoli DOMAIN_RULES rilevanti
- **R07** — Dopo `MAX_MOVE_RETRIES = 3` (4 tentativi totali) di fallimenti consecutivi su una `move`, emette `onReplanRequired` con `reason='collision'`. Il retry cieco accumula penalità (R22): non aumentare questo valore senza considerare l'impatto.
- **R08** — Il flag `inFlight` garantisce che nessuna nuova azione venga inviata prima dell'ack della precedente. Invariante: `inFlight === true` ↔ un'azione è in volo sul server.
- **R09** — `actionToDirection()` in `action-types.ts` è il solo punto di conversione; tutti gli altri moduli usano questo helper (mai delta manuali).
- **R22** — `onReplanRequired` è distinto da `onStepFailed`: il primo segnala "stop retry, replanna subito"; il secondo segnala "fallimento transitorio, riprova ok".

## Cosa NON fare
- Non inviare una seconda azione senza attendere l'ack della prima: viola R08 e genera penalità immediate.
- Non aumentare `MAX_MOVE_RETRIES` senza valutare l'accumulo di penalità (R22).
- Non convertire `Direction ↔ delta` fuori da `action-types.ts`: ogni altro punto di conversione è un potenziale bug di convenzione assi (R09).
- Non ignorare il valore di ritorno di `emitMove/emitPickup/emitPutdown`: `false` significa fallimento con penalità assegnata.
