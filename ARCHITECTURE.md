# ARCHITECTURE.md — Deliveroo.js Agent Rewrite

---

## Struttura

```
src/
  main.ts                      # CLI entry: carica config, istanzia e avvia l'agente
  types.ts                     # Definizioni di tipo condivise tra tutti i moduli

  client/                      # Adattatore SDK → eventi tipizzati e azioni async
    game-client.ts             # Responsabilità: wrappare @unitn-asa/deliveroo-js-client con tipi TS
    event-buffer.ts            # Responsabilità: bufferizzare eventi prima del drain iniziale
    deliveroo-client.d.ts      # Dichiarazioni TS per la libreria JS esterna

  config/                      # Caricamento e validazione della configurazione agente
    agent-config.ts            # Responsabilità: parsing JSON, interpolazione env vars, validazione

  logging/                     # Logging strutturato con ring buffer in memoria
    logger.ts                  # Responsabilità: istanza pino configurata per livello e output
    log-types.ts               # Responsabilità: union type LogEvent con discriminante `kind`
    log-ring-buffer.ts         # Responsabilità: buffer circolare per log recenti (debug/export)

  metrics/                     # Raccolta e export metriche di sessione
    metrics-collector.ts       # Responsabilità: registrare score timeline, delivery, penalità, planner stats
    metrics-snapshot.ts        # Responsabilità: serializzare e formattare snapshot metriche

  beliefs/                     # Modello del mondo; read-only per moduli esterni tramite interfacce
    belief-map.ts              # Responsabilità: topologia griglia, walkability direzionale, tile query
    belief-store.ts            # Responsabilità: stato osservato di parcelle, agenti e self
    parcel-tracker.ts          # Responsabilità: stimare decay rate da osservazioni consecutive
    belief-snapshot.ts         # Responsabilità: produrre snapshot immutabile del belief state

  pathfinding/                 # Calcolo percorsi su BeliefMap
    pathfinder.ts              # Responsabilità: A* con grafo orientato per tile direzionali
    grid-utils.ts              # Responsabilità: utility su coordinate e distanze

  deliberation/                # Selezione, scoring e gestione delle intenzioni
    deliberator.ts             # Responsabilità: valutare intenzioni candidate e triggerare replan
    intention.ts               # Responsabilità: costruire e scorare intenzioni singole e cluster
    intention-queue.ts         # Responsabilità: priority queue delle intenzioni correnti
    stagnation-monitor.ts      # Responsabilità: rilevare stagnazione e emettere segnale di intervento

  planning/                    # Generazione piani da intenzione a lista di passi
    planner.interface.ts       # Responsabilità: contratto IPlanner (plan, cancel, name)
    planner-factory.ts         # Responsabilità: costruire la catena di planner da config
    bfs-planner.ts             # Responsabilità: A*/BFS con permutazioni (≤4 parcelle) o nearest-neighbor
    pddl-planner.ts            # Responsabilità: chiamare solver PDDL esterno, generare problem da snapshot
    llm-planner.ts             # Responsabilità: chiamare LLM via LlmClient, parsare risposta in piano
    plan-validator.ts          # Responsabilità: validare piano contro belief snapshot prima dell'esecuzione

  execution/                   # Esecuzione sequenziale del piano su GameClient
    action-executor.ts         # Responsabilità: eseguire passi in sequenza, distinguere replan da retry
    action-types.ts            # Responsabilità: conversioni direzione ↔ delta, tipi di azione

  communication/               # Protocollo inter-agente sopra GameClient
    message-handler.ts         # Responsabilità: layer tipizzato su say/ask/shout con teamId filtering
    ally-tracker.ts            # Responsabilità: discovery, heartbeat, belief sharing, claim negotiation
    message-protocol.ts        # Responsabilità: costruttori e validatori dei messaggi tipizzati

  llm/                         # Integrazione LLM via API configurabile
    llm-client.ts              # Responsabilità: HTTP client OpenRouter/universitario con rate limit
    llm-memory.ts              # Responsabilità: gestire contesto LLM con rolling window sulla history
    llm-response-parser.ts     # Responsabilità: parsare output testuale LLM in PlanStep[]
    prompt-templates.ts        # Responsabilità: costruire prompt CoT con stato, obiettivo, tool catalog
    tool-catalog.ts            # Responsabilità: descrivere azioni disponibili come testo nel prompt

  agents/                      # Loop BDI e ciclo di vita dell'agente
    agent.interface.ts         # Responsabilità: contratto IAgent (init, start, stop)
    base-agent.ts              # Responsabilità: loop sense→deliberate→plan→execute condiviso
    bdi-agent.ts               # Responsabilità: override chain planner BFS/PDDL in BaseAgent
    llm-agent.ts               # Responsabilità: override chain planner LLM→PDDL→BFS in BaseAgent

  testing/                     # Test doubles e fixture per test senza server reale
    mock-game-client.ts        # Responsabilità: simulare GameClient con eventi controllabili
    fixtures.ts                # Responsabilità: mappe, parcelle e stati precostituiti per i test

configs/
  agent-bdi.json               # Configurazione agente BDI (planner: bfs o pddl)
  agent-llm.json               # Configurazione agente LLM (planner: llm, blocco llm obbligatorio)
```

---

## Regole di dominio applicate

| Regola | Dove e come è gestita |
|--------|----------------------|
| **R01** — Tipi tile (0–5, 5!, ↑↓←→) | `belief-map.ts`: tipo `TileType` con tutti i valori. `isWalkable()`, `isDeliveryZone()`, `isSpawningTile()` esposti come metodi separati. Tile `5` e `5!` trattate come walkable ma marcate per logica crate (fuori scope del rewrite, ignorata). |
| **R02** — Tile direzionale: restrizione di ENTRATA | `belief-map.ts`: metodo `canEnterFrom(x, y, fromDir)` sostituisce `isWalkable(x, y)` per il pathfinder. `pathfinder.ts` costruisce grafo orientato: l'arco (u→v) esiste solo se `canEnterFrom(v.x, v.y, dir_da_u_a_v)` è `true`. |
| **R03** — Mappa statica dopo init | `belief-map.ts` è costruito una volta all'evento `'map'` e mutato solo su evento `'tile'` (raro). Il pathfinder non invalida la cache su ogni frame. |
| **R04** — Entità parzialmente osservabili | Separazione netta: `belief-map.ts` = topologia completa ricevuta a init. `belief-store.ts` = entità nel campo visivo. Nessun modulo mescola i due. |
| **R05** — Tile bloccate durante movimento | `action-executor.ts`: non invia la prossima azione prima di ricevere l'ack del server. `pathfinder.ts` riceve le posizioni degli agenti da `belief-snapshot.ts` ed esclude le tile occupate. |
| **R06** — Coordinate frazionarie durante movimento | `belief-store.ts`: `Math.round()` su `x` e `y` di qualsiasi agente (proprio o altrui) prima di salvare nel belief set. Nessun altro modulo vede coordinate float. |
| **R07** — Movimento su tile occupata → penalità | `action-executor.ts`: distingue `replanRequired` (collisione, replanning immediato) da `stepFailed` (fallimento transitorio, retry). Il segnale `replanRequired` propaga al loop in `base-agent.ts`. |
| **R08** — Azioni sequenziali (ActionMutex server) | `action-executor.ts`: usa flag `inFlight` per garantire che nessuna azione venga inviata prima dell'ack della precedente. Invariante verificata anche in `base-agent.ts` (non chiama plan mentre executor è attivo). |
| **R09** — Convenzione assi (up=y+1, down=y-1) | `action-types.ts`: unico punto di conversione direzione↔delta. Tutti gli altri moduli usano solo questo helper. |
| **R10** — Sensing con `<` (non `<=`) | `belief-store.ts`: tutte le query di visibilità usano `manhattanDistance < sensingDistance`. Nessun valore di default hardcoded — letto da config (vedi R11). |
| **R11** — Sensing distance da config server | `belief-store.ts` e `deliberator.ts`: ricevono `observationDistance` (unificata) da `game-client.getObservationDistance()`, che legge `GAME.player.observation_distance` dalla `config`. Nessun valore hardcoded. |
| **R12** — Sensing unificato (`'sensing'` event) | `game-client.ts`: adatta `onSensing()` SDK ai due callback interni `onParcelsSensing` / `onAgentsSensing`. `belief-store.ts`: la "tile confermata vuota" si ricava dall'assenza di parcella su tile presente in `positions`, ma la logica di rimozione parcelle sparite resta invariata. |
| **R13** — Sensing aggiornato a frame (50ms lag) | `base-agent.ts`: non assume consistenza istantanea dopo un'azione. Il deliberator viene triggerato dall'evento di sensing, non dal callback dell'azione. |
| **R14** — Reward al delivery = timer al momento di putdown | `deliberator.ts`: usa `parcel-tracker.ts` per proiettare `estimateRewardAt(parcel, arrivalTime)`. `arrivalTime` = now + (distanza × movementDurationMs). |
| **R15** — Parcella scaduta rimane con reward=0 | `belief-store.ts`: non rimuove parcelle scadute dal belief set. `deliberator.ts`: filtra `reward <= 0` PRIMA di generare intenzioni. |
| **R16** — `pickup()` raccoglie TUTTE le parcelle libere | `base-agent.ts`: dopo il pickup, aggiorna le credenze con tutte le parcelle raccolte, non solo quella target. Nessuna assunzione su "quale" parcella verrà raccolta. |
| **R17** — `putdown` su tile non-delivery lascia parcella | Trattato come evento tattico opzionale (fuori scope del loop principale). Se mai implementato, il costo (decay + rischio furto) è esplicito nella funzione di utilità. |
| **R18** — Capacity non enforced dal server | `deliberator.ts`: usa `capacity` come soglia per filtro hard (Pattern 4 GitHub): quando `carriedCount >= capacity`, le intenzioni di pickup vengono rimosse completamente dall'evaluation set. Non è un limite di sistema. |
| **R19** — Spawning solo su tile tipo 1 | `belief-map.ts`: espone `getSpawningTiles(): Position[]`. `deliberator.ts` usa questo per la strategia di esplorazione (preferire percorsi vicino a tile tipo 1). |
| **R20** — Putdown esplicito richiesto per scoring | `base-agent.ts`: il piano generato include sempre un passo `putdown` esplicito dopo l'arrivo su delivery tile. Arrivare senza putdown non conta. |
| **R21** — Qualsiasi delivery tile è valida | `belief-map.ts`: espone `getDeliveryTiles(): Position[]`. `bfs-planner.ts` e `pddl-planner.ts` cercano la delivery tile più vicina, non una predefinita. |
| **R22** — Penalità irreversibili, kick a -1000 | `belief-store.ts`: mantiene `penaltyCount` aggiornato dall'evento `'you'`. `base-agent.ts`: logga warning quando `penalty < -500`. `action-executor.ts`: non fa retry aggressivo su collisioni (usa `replanRequired`). |
| **R23** — Disconnessione > 10s rimuove agente | `game-client.ts`: gestisce `onReconnect`; il loop in `base-agent.ts` riprende dallo stato corrente delle credenze (il server mantiene posizione e parcelle portate se reconnessione entro 10s). |
| **R24** — `ask` timeout 1000ms | `ally-tracker.ts`: timeout interno a 500ms su ogni `emitAsk` di negotiation (già corretto). Nessuna logica di negotiation supera i 900ms. |
| **R25** — Messaggi senza ordinamento garantito | `message-protocol.ts`: tutti i messaggi includono campo `ts: number` (timestamp ms). `ally-tracker.ts`: usa `ts` per ordinamento esplicito in caso di messaggi fuori ordine. |
| **RI01/RI02** — Tile tipo 1 e 2 sono walkable | `belief-map.ts`: `isWalkable()` ritorna `true` per tile tipo 1, 2, 3, 4. Solo tipo `0` è non-walkable. |
| **RI03** — Pickup non automatico | Piano esplicito con step `pickup` dopo arrivo sulla tile. `base-agent.ts` non assume raccolta automatica. |
| **RI04** — Coordinate frazionarie = agente in movimento | Risolto da R06: `belief-store.ts` arrotonda sempre prima di salvare. |
| **RI05** — Parcella portata da un solo agente | `ally-tracker.ts`: claim negotiation per prevenire doppio pickup. Race condition residua risolta dal server (primo-arrivato). |
| **RI06** — Spawning stocastico | `deliberator.ts`: esplorazione basata su frequentare tile tipo 1, non su calendario di spawn. |
| **RI07** — Sensing non vede attraverso i muri | L'esplorazione in `deliberator.ts` considera la mappa completa e dispatchta goal di esplorazione verso aree fisicamente non ancora raggiunte (non basta posizione centrale). |
| **RI08** — `reward` nel sensing è il valore CORRENTE | `deliberator.ts`: non usa `parcel.reward` direttamente. Usa sempre `parcel-tracker.estimateRewardAt(parcel, arrivalTime)` come stima del reward effettivo alla consegna. |

**Regole senza punto preciso di gestione:** Nessuna. Tutte le regole DOMAIN_RULES.md hanno un modulo responsabile identificato.

---

## Interfacce tra moduli

### Grafo delle dipendenze

```
main.ts
  └── config/ ──────────────────────────────────────────────────────┐
  └── client/game-client.ts ────────────────────────────────────────┤
        └── types.ts                                                 │
  └── agents/base-agent.ts ◄── bdi-agent.ts / llm-agent.ts         │
        ├── beliefs/belief-store.ts ◄── beliefs/belief-map.ts       │
        │     └── pathfinding/pathfinder.ts                         │
        │           └── beliefs/belief-map.ts                       │
        ├── beliefs/belief-snapshot.ts (snapshot da belief-store)   │
        ├── deliberation/deliberator.ts                              │
        │     ├── beliefs/belief-store.ts                           │
        │     ├── beliefs/belief-map.ts                             │
        │     └── deliberation/stagnation-monitor.ts                │
        ├── planning/planner-factory.ts                              │
        │     ├── planning/bfs-planner.ts                           │
        │     ├── planning/pddl-planner.ts ◄── belief-snapshot.ts  │
        │     └── planning/llm-planner.ts ◄── llm/*                 │
        ├── planning/plan-validator.ts ◄── belief-snapshot.ts       │
        ├── execution/action-executor.ts ◄── client/game-client.ts  │
        └── communication/ally-tracker.ts ◄── communication/       │
              message-handler.ts ◄── client/game-client.ts          │
```

### Cosa si passano i moduli

| Da | A | Cosa |
|----|---|------|
| `game-client.ts` | `base-agent.ts` | Callback tipizzati: `onYou`, `onParcelsSensing`, `onAgentsSensing`, `onMsg`, `onReconnect` (adattati internamente da `onSensing` SDK) |
| `game-client.ts` | `action-executor.ts` | Metodi `emitMove`, `emitPickup`, `emitPutdown`; `getMeasuredActionDurationMs()` |
| `belief-store.ts` | `deliberator.ts` | `BeliefState` snapshot (self, parcels[], otherAgents[]) via `getSnapshot()` |
| `belief-store.ts` | `planner-factory.ts` | `BeliefSnapshot` immutabile (costruito da `belief-snapshot.ts`) |
| `belief-map.ts` | `pathfinder.ts` | `canEnterFrom(x, y, dir)`, `getDeliveryTiles()`, `getSpawningTiles()`, `width`, `height` |
| `deliberator.ts` | `base-agent.ts` | `Intention[]` ordinata per utilità; flag `shouldReplan: boolean` |
| `planner-factory.ts` | `base-agent.ts` | Istanza `IPlanner` (la catena configurata: LLM→PDDL→BFS, PDDL→BFS o solo BFS) |
| `plan-validator.ts` | `base-agent.ts` | `{ valid: boolean, reason?: string }` |
| `action-executor.ts` | `base-agent.ts` | Callback: `onStepComplete`, `onPlanComplete`, `onStepFailed`, `onReplanRequired`, `onPutdown` |
| `ally-tracker.ts` | `base-agent.ts` | Set `claimedByOthers: Set<parcelId>` — parcelle riservate agli alleati |
| `message-handler.ts` | `ally-tracker.ts` | Messaggi tipizzati deserializzati: `HelloMessage`, `HeartbeatMessage`, `BeliefShareMessage`, `ParcelClaimMessage` |

### Integrazione server (GameClient)

`game-client.ts` è l'unico punto di contatto con `@unitn-asa/deliveroo-js-client`. Nessun altro modulo importa direttamente la libreria. Le sue responsabilità sono:

1. **Connessione**: autenticazione via token, emissione eventi `'config'`, `'map'`, `'you'` al boot.
2. **Buffering**: `event-buffer.ts` accoda eventi che arrivano prima che `base-agent.ts` sia pronto; `drainPending()` li riemette nell'ordine corretto.
3. **Azioni**: `emitMove`, `emitPickup`, `emitPutdown` — wrappers async con misura della durata effettiva.
4. **Comunicazione**: `emitSay`, `emitAsk`, `emitShout`, `onMsg` — usati solo da `message-handler.ts`.
5. **Metadati**: `getMeasuredActionDurationMs()` per calibrare i timeout in `action-executor.ts`.

---

## Piano di migrazione ordinato

| # | Modulo | Azione | Regola dominio rilevante | Complessità |
|---|--------|--------|--------------------------|-------------|
| 1 | `types.ts` | **Salvo**, aggiungo: `TileType`, `Direction`, `BeliefSnapshot`, `PlannerChainType`, `ReplanSignal` | R01, R09 | Bassa |
| 2 | `config/agent-config.ts` | **Salvo** integralmente | — | Bassa |
| 3 | `logging/*` | **Salvo** integralmente | — | Bassa |
| 4 | `metrics/*` | **Salvo** integralmente | — | Bassa |
| 5 | `client/game-client.ts` | **Salvo**, verifico gestione coordinate frazionarie nell'event dispatch (R06) | R06, R08, R23 | Bassa |
| 6 | `beliefs/belief-map.ts` | **Riscrivo** `canEnterFrom(x, y, dir)` (R02). Aggiungo `getSpawningTiles()` (R19), `getDeliveryTiles()` (R21). Corretta walkability per tile tipo 1 e 2 (RI01/RI02) | R01, R02, R03, RI01, RI02 | Media |
| 7 | `pathfinding/pathfinder.ts` | **Riscrivo** per usare `canEnterFrom()` invece di `isWalkable()` — grafo orientato. Aggiungo esclusione tile occupate da agenti (Pattern 2 GitHub, R05) | R02, R05 | Media |
| 8 | `pathfinding/grid-utils.ts` | **Salvo**, verifico convenzione assi (R09) | R09 | Bassa |
| 9 | `beliefs/parcel-tracker.ts` | **Salvo** integralmente | RI08 | Bassa |
| 10 | `beliefs/belief-store.ts` | **Salvo** con fix: `Math.round()` su coordinate in input (R06); sensing con `<` (R10); sensed distances da config (R11); non rimuove parcelle reward=0 (R15); aggiunge `penaltyCount` tracking (R22) | R06, R10, R11, R12, R15, R22 | Media |
| 11 | `beliefs/belief-snapshot.ts` | **Nuovo** — snapshot immutabile di `BeliefStore` per planners. Costruisce copia deep-frozen al momento della chiamata | Dependency Chain 2 (CODEBASE) | Bassa |
| 12 | `deliberation/intention.ts` | **Salvo** integralmente | R14, RI08 | Bassa |
| 13 | `deliberation/intention-queue.ts` | **Salvo** integralmente | — | Bassa |
| 14 | `deliberation/stagnation-monitor.ts` | **Nuovo** — componente separato con stato proprio; emette `'stagnation'` event dopo timeout configurabile. Sostituisce logica inline in `bdi-agent.ts` (Problem 6 CODEBASE) | R22 (penalità da stagnazione) | Media |
| 15 | `deliberation/deliberator.ts` | **Salvo** con fix: passa sempre `tracker` e `movementDurationMs` (Bug 1 CODEBASE); filtro hard su capacity (R18, Pattern 4 GitHub); filtro `reward <= 0` (R15) | R14, R15, R18, RI08 | Media |
| 16 | `planning/planner.interface.ts` | **Salvo** integralmente | — | Bassa |
| 17 | `planning/plan-validator.ts` | **Salvo** con fix: check posizione iniziale esatta (Bug 4 CODEBASE) | R06, R07 | Bassa |
| 18 | `planning/bfs-planner.ts` | **Salvo** — usa `getDeliveryTiles()` per delivery più vicina (R21) | R21 | Bassa |
| 19 | `planning/pddl-planner.ts` | **Salvo** con modifica: riceve `BeliefSnapshot` invece di live `BeliefStore`; esclude tile di agenti dal belief set PDDL (Pattern 2 GitHub) | R05, Dependency Chain 2 (CODEBASE) | Media |
| 20 | `planning/llm-planner.ts` | **Salvo** integralmente | — | Bassa |
| 21 | `planning/planner-factory.ts` | **Nuovo** — costruisce la catena `IPlanner` da `config.planner`. Tre chain: `bfs`, `pddl→bfs`, `llm→pddl→bfs`. Sostituisce switch/case in entrambi gli agent files (Problem 2 CODEBASE) | — | Bassa |
| 22 | `execution/action-types.ts` | **Salvo**, verifica convenzione assi (R09) | R09 | Bassa |
| 23 | `execution/action-executor.ts` | **Salvo** con modifica: aggiunge segnale `onReplanRequired` distinto da `onStepFailed` (Pattern 3 GitHub, R07); fix cancellazione nel retry (Bug 2 CODEBASE) | R07, R08, R22 | Media |
| 24 | `communication/message-protocol.ts` | **Salvo** con modifica: aggiunge campo `ts: number` a tutti i messaggi (R25) | R24, R25 | Bassa |
| 25 | `communication/message-handler.ts` | **Salvo** con modifica: usa `ts` per log ordering (R25) | R25 | Bassa |
| 26 | `communication/ally-tracker.ts` | **Salvo** integralmente | R24, R25, RI05 | Bassa |
| 27 | `llm/llm-client.ts` | **Salvo** integralmente | — | Bassa |
| 28 | `llm/llm-memory.ts` | **Salvo** con modifica: rolling window sugli ultimi 20 passi di action history (Dependency Chain 6 CODEBASE) | — | Media |
| 29 | `llm/llm-response-parser.ts` | **Salvo** integralmente | — | Bassa |
| 30 | `llm/prompt-templates.ts` | **Salvo** integralmente | — | Bassa |
| 31 | `llm/tool-catalog.ts` | **Salvo** integralmente | — | Bassa |
| 32 | `agents/base-agent.ts` | **Nuovo** — estrae loop comune: init, start, stop, callback wiring, deliberation timer, stagnation wiring, planner chain invocation, executor start/stop, ally tracker lifecycle. Risolve Problem 1 (CODEBASE). Garantisce R08 (azioni sequenziali) in un solo punto. | R08, R13, R22, R23 | Alta |
| 33 | `agents/bdi-agent.ts` | **Riscrivo** come sottoclasse `BaseAgent`: override solo di `buildPlannerChain()` → `PlannerFactory.build('bfs' | 'pddl')` | — | Alta (ridotta da BaseAgent) |
| 34 | `agents/llm-agent.ts` | **Riscrivo** come sottoclasse `BaseAgent`: override di `buildPlannerChain()` → `PlannerFactory.build('llm')`. Fix Bug 1 (tracker+duration nel deliberator) già garantito da BaseAgent. | — | Alta (ridotta da BaseAgent) |
| 35 | `main.ts` | **Salvo** con piccola modifica per usare `BaseAgent` factory | — | Bassa |
| 36 | `testing/mock-game-client.ts` | **Salvo** integralmente | — | Bassa |
| 37 | `testing/fixtures.ts` | **Salvo**, aggiungo fixture con tile direzionali per testare R02 | R02 | Bassa |

---

## Decisioni architetturali

### 1. `BaseAgent` con loop BDI condiviso — BdiAgent e LlmAgent come sottoclassi

**Scelta:** Estrarre il loop sense→deliberate→plan→execute in `base-agent.ts`. `BdiAgent` e `LlmAgent` ereditano e fanno override solo di `buildPlannerChain()`.

**Motivazione:** Il 95% del codice è duplicato tra le due classi (CODEBASE_ANALYSIS Problem 1). Ogni bug fix deve essere applicato in due posti, come dimostrato dal Bug 1 (tracker mancante solo in LlmAgent).

**Alternativa scartata:** Mantenere le due classi separate, aggiungere un "utility mixin". Scartata perché i mixin in TypeScript non garantiscono coerenza del ciclo di vita (init/start/stop), rendendo il rischio di divergenza nel tempo uguale a quello attuale.

**Influenza DOMAIN_RULES:** R08 (azioni sequenziali mai concorrenti) e R22 (penalità irreversibili) sono garantite una volta sola nel loop di `BaseAgent`, non in ogni sottoclasse.

---

### 2. `BeliefSnapshot` immutabile passato ai planners

**Scelta:** Prima di chiamare qualsiasi planner, `base-agent.ts` costruisce un `BeliefSnapshot` (copia frozen del belief state) tramite `belief-snapshot.ts`. Tutti i planners ricevono lo snapshot, non il live `BeliefStore`.

**Motivazione:** Il PDDL planner può impiegare 10 secondi. Durante quel tempo, `BeliefStore` viene aggiornato da nuovi sensing events. Il piano generato può fare riferimento a parcelle non più esistenti (CODEBASE_ANALYSIS Dependency Chain 2).

**Alternativa scartata:** Lock su `BeliefStore` durante il planning. Scartata perché blocca la belief revision per tutta la durata del PDDL call, rendendo le credenze stantie durante l'esecuzione — esattamente il problema opposto.

**Influenza DOMAIN_RULES:** R03 (mappa statica) rende il snapshot della topologia sicuro. R13 (sensing a frame, 50ms lag) implica che un leggero staleness è già fisiologico nel sistema — uno snapshot aggrava di pochi ms una latenza già esistente.

---

### 3. `canEnterFrom(x, y, fromDir)` in `BeliefMap` — grafo orientato nel pathfinder

**Scelta:** `belief-map.ts` espone `canEnterFrom(x: number, y: number, from: Direction): boolean` invece di `isWalkable(x, y): boolean`. Il pathfinder costruisce un grafo orientato dove l'arco (u→v) esiste solo se `canEnterFrom(v, dir_u_to_v)` ritorna `true`.

**Motivazione:** R02 — i tile direzionali restringono l'entrata dalla direzione opposta. Un semplice `isWalkable()` restituisce `true` per tutti i tile direzionali, rendendo il pathfinder cieco alla restrizione di entrata. I percorsi generati possono includere movimenti invalidi, causando fallimenti con penalità (R07, R22).

**Alternativa scartata:** `isWalkable(x, y, direction?: Direction)` con direction opzionale. Scartata perché un parametro opzionale rende il contratto ambiguo: chi chiama senza direction ottiene un risultato potenzialmente sbagliato per tile direzionali, senza errori a compile time.

---

### 4. `PlannerFactory` centralizzata

**Scelta:** `planner-factory.ts` costruisce la catena `IPlanner` da `config.planner` e la passa a `BaseAgent`. L'agente non istanzia mai direttamente un planner concreto.

**Motivazione:** La logica di selezione del planner è attualmente duplicata in `bdi-agent.ts:91–96` e `llm-agent.ts:115–125` (CODEBASE_ANALYSIS Problem 2). Aggiungere un nuovo planner (es. planner ibrido) richiederebbe modificare entrambe le classi.

**Alternativa scartata:** Planner selection dentro ogni sottoclasse di `BaseAgent`. Scartata perché la logica di fallback (LLM→PDDL→BFS) è indipendente dal tipo di agente — è una proprietà della configurazione, non dell'agente.

**Influenza DOMAIN_RULES:** Nessuna diretta. Abilita lo swap rapido tra planners durante debug di scenari con regole particolari (es. mappe con tile direzionali per testare R02).

---

### 5. Segnale `replanRequired` distinto da `stepFailed` in `ActionExecutor`

**Scelta:** `action-executor.ts` emette `onReplanRequired` (distinto da `onStepFailed`) quando un movimento fallisce due volte consecutive. `onStepFailed` rimane per fallimenti transienti (retry ok). `base-agent.ts` reagisce a `onReplanRequired` avviando immediatamente un nuovo ciclo di deliberazione.

**Motivazione:** R07 — muoversi su una tile occupata restituisce `false` e causa penalità. Il retry cieco accumula penalità (R22). La codebase attuale (Bug 2) non distingue collisione da fallimento transitorio; entrambi vanno in retry. Pattern 3 (GitHub) mostra che il segnale di replanning deve venire dall'executor, non essere inferito dal loop dell'agente.

**Alternativa scartata:** Loop dell'agente che inferisce replanning dal numero di `stepFailed` consecutivi. Scartata perché il loop agente non ha visibilità sul motivo del fallimento (collisione vs. tile bloccata da animazione), replica la stessa logica di classificazione in ogni sottoclasse.

**Influenza DOMAIN_RULES:** R07 e R22 direttamente — minimizza le penalità da retry su collisioni, proteggendo il punteggio.

---

## Rischi

### Rischio 1 — Regressione comportamentale nella migrazione BaseAgent

**Descrizione:** Estrarre 95% del codice di `BdiAgent` in `BaseAgent` modifica una componente che lavora. Errori sottili nel wiring dei callback, nell'ordine di init, o nella gestione del ciclo di vita possono rompere il comportamento senza errori evidenti a compile time (TypeScript non verifica la correttezza del timing).

**Regola di dominio coinvolta:** R08 (azioni sequenziali) e R22 (penalità irreversibili) — se il wiring sbagliato causa azioni doppie, le penalità si accumulano rapidamente.

**Strategia di mitigazione:** Mantenere i test attuali su `MockGameClient` che coprono il loop di base (deliberate→plan→execute) come smoke test. Prima di rimuovere il vecchio codice, far girare entrambe le versioni (old e BaseAgent) su stessa fixture e confrontare i log di azioni emesse. Refactor incrementale: estrarre un componente alla volta (prima lifecycle, poi callbacks, poi loop).

---

### Rischio 2 — Grafo orientato nel pathfinder rompe percorsi esistenti su mappe senza tile direzionali

**Descrizione:** Il cambio da `isWalkable()` a `canEnterFrom()` nel pathfinder modifica il grafo di navigazione. Su mappe senza tile direzionali il comportamento deve essere identico. Un errore nell'implementazione di `canEnterFrom()` potrebbe rendere alcune tile irraggiungibili su mappe normali, causando planning failures silenziosi.

**Regola di dominio coinvolta:** R02 (restrizione di entrata, non uscita) — la direzione di uscita da un tile direzionale è sempre permessa (SERVER_ANALYSIS §3, line "Exit restriction: Always allowed"). Dimenticare questo caso produce percorsi mancanti.

**Strategia di mitigazione:** Aggiungere fixture in `testing/fixtures.ts` con: (a) mappa senza tile direzionali — output nuovo pathfinder deve essere identico al vecchio; (b) mappa con tile `↑` — verificare che entrata da Sud sia bloccata, entrata da Nord/Est/Ovest sia permessa, uscita sia sempre permessa. Eseguire entrambi i test prima di integrare il nuovo pathfinder.

---

### Rischio 3 — BeliefSnapshot stale causa loop di planning failure su sessioni affollate

**Descrizione:** Se molti agenti avversari raccolgono parcelle durante i 10 secondi di un PDDL call, lo snapshot sarà stale: il piano generato fa riferimento a parcelle non più esistenti. `PlanValidator` respinge il piano. Il fallback BFS ripiega su un nuovo piano, ma se anche il BFS opera sullo stesso snapshot stale, potrebbe pianificare su parcelle già prese. Il loop può girare senza trovare piani validi per più cicli, durante i quali il parcel decay continua (R14, RI08).

**Regola di dominio coinvolta:** R14 (reward = timer al putdown) — ogni ciclo di planning fallito è tempo perso in cui le parcelle decadono. Con N parcelle all'inizio e decay rapido, il planning failure loop azzera il reward atteso.

**Strategia di mitigazione:** Il BFS fallback **non** usa lo snapshot — usa il live `BeliefStore` (è veloce, <10ms, non ha il problema di staleness). Solo `PddlPlanner` usa lo snapshot. Se `PlanValidator` respinge il piano PDDL, il BFS viene chiamato immediatamente sul live state. Questo garantisce sempre un piano valido come ultima risorsa, indipendentemente dallo staleness dello snapshot PDDL.
