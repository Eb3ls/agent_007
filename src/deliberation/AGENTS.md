# AGENTS.md — src/deliberation/

## Responsabilità
Generare, scorare e gestire le intenzioni candidate; decidere quando replanare; rilevare stagnazione del punteggio.

## File chiave

| File | Descrizione |
|------|-------------|
| `deliberator.ts` | `evaluate(beliefs, ...)`: genera intenzioni ordinate per utilità; `shouldReplan(current, beliefs, ...)`: decide se abbandonare il piano corrente |
| `intention.ts` | Costruttori di intenzioni (`createSingleIntention`, `createClusterIntention`, `createExploreIntention`); `computeUtility(reward, steps)` |
| `intention-queue.ts` | Priority queue ordinata per utilità discendente con `revise(beliefs)` per invalidare intenzioni stantie |
| `stagnation-monitor.ts` | Rilevatore standalone: emette callback `onStagnation` se il punteggio non cresce per `timeoutMs` ms |

## Dipendenze da altri moduli interni
- `types.ts` — `Intention`, `IntentionType`, `IBeliefStore`, `ParcelBelief`, `Position`
- `beliefs/parcel-tracker.ts` — `estimateRewardAt(parcelId, futureMs)` per proiettare il reward al momento della consegna

## Dipendenze esterne
- Nessuna

## Vincoli DOMAIN_RULES rilevanti
- **R14 / RI08** — `deliberator.evaluate()` NON usa `parcel.reward` direttamente. Usa `parcelTracker.estimateRewardAt(id, now + distance × movementDurationMs)` come stima del reward effettivo alla consegna.
- **R15** — Prima di generare intenzioni, filtra le parcelle con `reward <= 0`: non generare mai un'intenzione per una parcella scaduta.
- **R18** — Quando `remaining capacity <= 0` (portate >= capacità), `evaluate()` ritorna array vuoto: nessuna nuova intenzione di pickup viene generata.
- **R19** — `createExploreIntention()` usa `belief-store.getExploreTarget()` che punta alle spawning tile (tipo 1) non ancora visitate.
- **R22** — `StagnationMonitor` rileva quando il punteggio non aumenta per `stagnationTimeoutMs`: trigger per un replan preventivo prima che le penalità da stallo si accumulino.
- **RI06** — La strategia di esplorazione è reattiva (frequentare tile tipo 1), non basata su un calendario di spawn deterministico.

## Cosa NON fare
- Non usare `parcel.reward` direttamente come stima del guadagno: proiettare sempre con `parcelTracker.estimateRewardAt()` (RI08).
- Non rimuovere dal belief set le parcelle con `reward = 0`: filtrarle solo qui, per il deliberation (R15).
- Non generare intenzioni di pickup quando `remaining capacity <= 0` (R18).
- Non chiamare `evaluate()` più volte per frame senza aspettare la risposta di sensing: il deliberator è event-driven (R13).
