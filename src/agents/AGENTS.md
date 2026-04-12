# AGENTS.md — src/agents/

## Responsabilità
Loop BDI condiviso (sense→deliberate→plan→execute) in `BaseAgent`; `BdiAgent` e `LlmAgent` fanno override solo della catena planner.

## File chiave

| File | Descrizione |
|------|-------------|
| `base-agent.ts` | Loop completo: init callback wiring, start/stop lifecycle, deliberation timer, executor callbacks, stagnation, ally tracker |
| `bdi-agent.ts` | `BdiAgent extends BaseAgent`: override `buildPlannerChain()` → `'bfs'` o `'pddl'` |
| `llm-agent.ts` | `LlmAgent extends BaseAgent`: override `buildPlannerChain()` → `'llm'` (catena `llm→pddl→bfs`) |
| `agent.interface.ts` | Re-export di `IAgent` da `types.ts` |

## Dipendenze da altri moduli interni
- Tutti i moduli di `beliefs/`, `deliberation/`, `planning/`, `execution/`, `communication/`, `metrics/`, `logging/`
- `client/game-client.ts`
- `config/agent-config.ts`

## Dipendenze esterne
- Nessuna diretta (tutte mediate dai moduli sopra)

## Vincoli DOMAIN_RULES rilevanti
- **R08** — `base-agent.ts` non chiama `executePlan()` mentre l'executor ha `inFlight === true`: garantisce l'ActionMutex in un solo punto, condiviso da entrambe le sottoclassi.
- **R13** — Il deliberation timer è event-driven (triggered da `'parcels sensing'`), non da `setInterval` fisso: non assumere che le credenze siano consistenti subito dopo un'azione.
- **R16** — Dopo ogni `pickup`, `base-agent.ts` aggiorna le credenze con tutte le parcelle raccolte, non solo quella target.
- **R20** — Il piano include sempre un passo `putdown` esplicito: `base-agent.ts` non assume consegna automatica all'arrivo sulla delivery tile.
- **R22** — `base-agent.ts` logga warning quando `penalty < -500` (letto da `BeliefStore`). `StagnationMonitor` emette callback per replan preventivo prima dello stallo.
- **R23** — `onReconnect` riprende il loop dallo stato corrente delle credenze; il server mantiene posizione e parcelle portate se la riconnessione avviene entro 10s.
- **Arch Decision #1** — `BdiAgent` e `LlmAgent` NON duplicano il loop: l'unico punto di modifica è `buildPlannerChain()`.

## Cosa NON fare
- Non duplicare logica di loop in `BdiAgent` o `LlmAgent`: qualsiasi modifica al lifecycle va in `base-agent.ts`.
- Non istanziare planner concreti in `BdiAgent`/`LlmAgent`: delegare sempre a `planner-factory.ts` (Arch Decision #4).
- Non inviare azioni concorrenti: il flag `inFlight` in `ActionExecutor` è l'unico punto di garanzia (R08).
- Non triggerare la deliberation dal callback di un'azione completata: usare l'evento di sensing (R13).
