# Guida di studio — agent_007-rewrite

> Leggi questa guida dall'alto in basso la prima volta. Poi usala come riferimento rapido.
> File canonici: `ARCHITECTURE.md` (decisioni architetturali), `.claude/context/DOMAIN_RULES.md` (vincoli di dominio).

---

## 1. Cos'è il progetto

Un **agente BDI** (Beliefs-Desires-Intentions) che gioca a Deliveroo.js: raccoglie pacchi sulla griglia, li porta alle zone di consegna, massimizza il punteggio. Supporta due varianti:

- **BDI agent** — pianificazione A*/BFS pura, opzionalmente PDDL
- **LLM agent** — pianificazione delegata a un LLM (con fallback BFS)

Due agenti possono giocare in team, scambiandosi beliefs e negoziando i pacchi via messaggi.

Branch attivo: `rewrite/new-architecture`

---

## 2. Come si lancia

### Variabili d'ambiente richieste (`.env` nella root)

```
AGENT_TOKEN=<jwt-bdi>
AGENT_TOKEN_2=<jwt-llm>       # solo se usi start:llm o start:team
LLM_API_URL=<endpoint>        # solo se usi start:llm
LLM_API_TOKEN=<token>         # solo se usi start:llm
```

### Comandi npm

| Comando | Cosa fa |
|---|---|
| `npm run start:bdi` | Lancia agente BDI con `configs/agent-bdi.json` |
| `npm run start:llm` | Lancia agente LLM con `configs/agent-llm.json` |
| `npm run start:team` | Lancia BDI + LLM in parallelo (2 agenti) |
| `npm run dev` | Lancia BDI in modalità watch (ricompila al salvataggio) |
| `npm run build` | Compila TypeScript in `dist/` |
| `npm test` | Esegue tutti i `*.test.ts` con `tsx --test` |
| `npm run eval` | Eval completa (tutte le 18 mappe, default run) |
| `npm run eval:smoke` | 3 mappe × 1 run × 60s — controllo rapido |
| `npm run eval:quick` | 6 mappe × 2 run × 120s |
| `npm run eval:full` | Tutte le mappe × 5 run × 300s |

### Cosa fa `src/main.ts` (63 righe)

```
1-14   parseArgs() — richiede --config <path>, esce se mancante
16-25  loadConfig(path) — legge JSON, interpola ${ENV}, valida
27     new GameClient(host, token) — connettore verso server
31     new BdiAgent() o new LlmAgent() a seconda di config.role
32     agent.init(client, config) — wiring callback (NON ancora connesso)
37-43  EvalLogger opzionale — creato ORA per timestamp corretto
46-50  client.connect() — connessione WebSocket al server
54     client.drainPending() — replay buffer: map, you, sensing iniziali
56-58  agent.setEvalLogger(evalLog) — iniettato DOPO drainPending
60     agent.start() — avvia il loop BDI
```

---

## 3. Configurazione

### `configs/agent-bdi.json`

```json
{
  "host": "http://localhost:8080",
  "token": "${AGENT_TOKEN}",
  "role": "bdi",
  "planner": "bfs",
  "logLevel": "info",
  "stagnationTimeoutMs": 15000
}
```

### `configs/agent-llm.json`

```json
{
  "host": "http://localhost:8080",
  "token": "${AGENT_TOKEN_2}",
  "role": "llm",
  "planner": "llm",
  "stagnationTimeoutMs": 15000,
  "llm": {
    "apiUrl": "${LLM_API_URL}",
    "apiToken": "${LLM_API_TOKEN}",
    "model": "gpt-4o-mini",
    "maxTokenBudget": 4000,
    "minCallIntervalMs": 1000
  }
}
```

L'interpolazione `${VAR}` è gestita in `src/config/agent-config.ts`. I campi obbligatori (`host`, `token`, `role`) vengono validati lì; se mancano, il processo esce con errore chiaro.

I parametri di gioco (`capacity`, `movementDuration`, `penaltyValue`, `observationDistance`) **non sono nel config JSON** — arrivano dal server via evento `'config'` all'avvio.

Le mappe del server si trovano in:
```
Deliveroo.js/packages/@unitn-asa/deliveroo-js-assets/assets/games/<nome>.json
```

---

## 4. Albero di `src/`

```
src/
├── main.ts                  Entry CLI: wiring, connect, drain, start
├── types.ts                 Tipi condivisi: Direction, TileType, IAgent, ReplanSignal
├── types.test.ts
│
├── client/
│   ├── game-client.ts       Wrapper SDK Deliveroo; emitMove/Pickup/Putdown; eventi tipizzati
│   ├── event-buffer.ts      Buffer eventi pre-drain (map/you/sensing)
│   ├── deliveroo-client.d.ts Dichiarazioni TS per SDK JS esterno
│   └── event-buffer.test.ts
│
├── config/
│   ├── agent-config.ts      loadConfig(): JSON + interpolazione ${ENV} + validazione
│   └── agent-config.test.ts
│
├── logging/
│   ├── logger.ts            Wrapper pino strutturato
│   ├── log-types.ts         Union LogEvent { kind: ... }
│   ├── log-ring-buffer.ts   Ring buffer ultimi N log in memoria
│   └── *.test.ts
│
├── metrics/
│   ├── metrics-collector.ts Score timeline, deliveries, penalità, planner stats
│   ├── metrics-snapshot.ts  Serializza snapshot per file/log
│   └── *.test.ts
│
├── beliefs/
│   ├── belief-map.ts        Topologia statica griglia; canEnterFrom(x,y,dir); getDeliveryTiles(); getSpawningTiles()
│   ├── belief-store.ts      Stato osservato (self, parcels, agents); Math.round su coord
│   ├── parcel-tracker.ts    Stima decay rate; estimateRewardAt(parcel, t)
│   ├── belief-snapshot.ts   Copia deep-frozen per i planner (mitiga staleness)
│   └── *.test.ts
│
├── pathfinding/
│   ├── pathfinder.ts        A* su grafo orientato; esclude tile occupate da agenti
│   ├── grid-utils.ts        Manhattan distance, conversioni coordinata
│   ├── distance-map.ts      BFS multi-source per mappe di distanza
│   └── pathfinder.test.ts
│
├── deliberation/
│   ├── deliberator.ts       Genera candidati, scoring (reward proiettato), filtri capacity/reward≤0
│   ├── intention.ts         Costruzione e scoring singola intenzione
│   ├── intention-queue.ts   Priority queue di intenzioni
│   ├── stagnation-monitor.ts Rileva stagnazione e segnala ReplanSignal
│   └── *.test.ts
│
├── planning/
│   ├── planner.interface.ts IPlanner { plan(snapshot, intention), cancel(), name }
│   ├── planner-factory.ts   Costruisce catena: bfs | pddl→bfs | llm→pddl→bfs
│   ├── bfs-planner.ts       A*/BFS con permutazioni ≤4 pacchi; usa getDeliveryTiles()
│   ├── pddl-planner.ts      Genera problem PDDL da snapshot; chiama solver esterno
│   ├── llm-planner.ts       Chiama LlmClient, parsa risposta in PlanStep[]
│   ├── plan-validator.ts    Valida piano vs snapshot prima dell'esecuzione
│   ├── pddl-client.d.ts     Dichiarazioni @unitn-asa/pddl-client
│   └── *.test.ts
│
├── execution/
│   ├── action-executor.ts   Esecuzione sequenziale; distingue stepFailed da replanRequired
│   ├── action-types.ts      Unico punto di conversione direzione↔delta (R09)
│   └── *.test.ts
│
├── communication/
│   ├── message-protocol.ts  HelloMessage, HeartbeatMessage, BeliefShareMessage, ParcelClaimMessage (tutti con ts)
│   ├── message-handler.ts   Layer tipizzato su say/ask/shout; filtro teamId
│   ├── ally-tracker.ts      Discovery, heartbeat, belief sharing, claim negotiation
│   └── *.test.ts
│
├── llm/
│   ├── llm-client.ts        HTTP client con rate limit (minCallIntervalMs)
│   ├── llm-memory.ts        Rolling window storia ≤20 step
│   ├── llm-response-parser.ts Testo LLM → PlanStep[]
│   ├── prompt-templates.ts  CoT prompt: stato + obiettivo + tool catalog
│   ├── tool-catalog.ts      Descrizione testuale delle azioni per il prompt
│   └── *.test.ts
│
├── agents/
│   ├── agent.interface.ts   IAgent { init, start, stop }
│   ├── base-agent.ts        Loop BDI condiviso: sense→deliberate→plan→execute; lifecycle; wiring
│   ├── bdi-agent.ts         Override buildPlannerChain() → bfs/pddl
│   ├── llm-agent.ts         Override buildPlannerChain() → llm→pddl→bfs
│   └── bdi-agent.test.ts
│
├── evaluation/
│   ├── eval-runner.ts       Orchestratore: spawn server+agent per mappa×run; CLI flags
│   ├── map-registry.ts      18 mappe in 7 categorie; gamePath per ogni mappa
│   ├── eval-logger.ts       Scrive log L1 (per-tick) durante una run
│   ├── eval-summarizer.ts   Aggrega L1 → L2 summary per run
│   └── eval-report.ts       Report finale: G-score, SPM, anomalie
│
└── testing/
    ├── mock-game-client.ts  GameClient simulato con eventi controllabili
    ├── fixtures.ts          Mappe e stati precostituiti per i test
    └── e2e-smoke.test.ts    Smoke E2E senza server reale
```

---

## 5. Moduli BDI in dettaglio

### `client/` — Ponte verso il server Deliveroo

**`src/client/game-client.ts`**
- Unico punto di contatto con l'SDK `@unitn-asa/deliveroo-js-client`.
- Espone callback tipizzati: `onMap`, `onYou`, `onSensing`, `onConfig`, `onMessage`, `onReconnect`.
- Decompone l'evento `'sensing'` unificato in `onParcelsSensing` + `onAgentsSensing` (R12).
- Metodi di azione: `emitMove(dir)`, `emitPickup()`, `emitPutdown()` — ognuno ritorna `Promise<boolean>`.
- `getObservationDistance()`, `getMeasuredActionDurationMs()` — parametri runtime dal server (R11).
- Gestisce reconnect automatico entro 10s (R23).

**`src/client/event-buffer.ts`**
- Accoda tutti gli eventi ricevuti prima che `drainPending()` venga chiamato.
- Garantisce che `onMap`/`onYou`/`onSensing` iniziali siano processati nell'ordine corretto anche se i callback sono registrati dopo la connessione.

---

### `beliefs/` — Modello del mondo

**`src/beliefs/belief-map.ts`** — topologia statica
- Costruita una sola volta sull'evento `'map'` (R03).
- `canEnterFrom(x, y, direction)` — gestisce tile direzionali come archi orientati (R02).
- `isWalkable(x, y)` — restituisce `true` per tipi 1, 2, 3, 4 (non per tipo 0 e con vincoli per tipo 5).
- `getDeliveryTiles()` — tutte le tile tipo 2 (R21).
- `getSpawningTiles()` — tutte le tile tipo 1 (R19).

**`src/beliefs/belief-store.ts`** — stato osservato
- Mantiene: posizione/punteggio self, mappa parcelle `Map<id, Parcel>`, agenti avversari.
- `Math.round` su tutte le coordinate in ingresso (R06 — coord frazionarie durante movimento).
- Sensing usa `<` (strict) per la distanza (R10).
- Non rimuove parcelle con `reward=0` — il deliberator le filtra (R15).
- Tiene `penaltyCount` per monitorare rischio kick (R22).

**`src/beliefs/parcel-tracker.ts`**
- Stima il decay rate di ogni pacco osservando campioni di `reward` nel tempo.
- `estimateRewardAt(parcel, arrivalTime)` — proietta il reward futuro al momento del putdown (R14, RI08).

**`src/beliefs/belief-snapshot.ts`**
- Crea una copia deep-frozen di `BeliefStore` da passare ai planner.
- Previene che il planner legga beliefs che mutano durante la pianificazione (staleness PDDL).

---

### `pathfinding/` — Navigazione sulla griglia

**`src/pathfinding/pathfinder.ts`**
- A* su grafo orientato — usa `canEnterFrom(x, y, dir)` di `BeliefMap` per ogni arco (R02).
- Esclude tile occupate da agenti in movimento (R05).
- Ritorna `Direction[]` (sequenza di mosse) o `null` se il percorso non esiste.

**`src/pathfinding/grid-utils.ts`**
- `manhattanDistance(a, b)` — distanza Manhattan con coordinate intere.
- Conversioni tra coordinate griglia e indici.

**`src/pathfinding/distance-map.ts`**
- BFS multi-source: data una lista di sorgenti, calcola la distanza minima da ogni tile.
- Usato dal deliberator per stimare distanza dalla delivery zone più vicina.

---

### `deliberation/` — Scelta dell'obiettivo

**`src/deliberation/deliberator.ts`**
- Riceve il `BeliefSnapshot` corrente e genera intenzioni candidate.
- Scoring di ogni intenzione: `estimateRewardAt(parcel, tempoArrivo)` × fattori di distanza.
- Filtro hard: esclude intenzioni che superano `capacity` (R18).
- Filtro hard: esclude pacchi con `reward <= 0` (R15).
- Restituisce l'intenzione con punteggio più alto.

**`src/deliberation/intention.ts`**
- Rappresenta una singola intenzione: `{ type: 'pickup' | 'deliver' | 'explore', target, score }`.
- Funzioni di costruzione e scoring.

**`src/deliberation/intention-queue.ts`**
- Priority queue ordinata per score decrescente.

**`src/deliberation/stagnation-monitor.ts`**
- Se l'agente non progredisce (stesso punteggio o stessa posizione) per `stagnationTimeoutMs`, emette un `ReplanSignal`.
- `base-agent.ts` intercetta il segnale e forza una nuova deliberazione.

---

### `planning/` — Costruzione del piano

**`src/planning/planner.interface.ts`**
```typescript
interface IPlanner {
  plan(snapshot: BeliefSnapshot, intention: Intention): Promise<PlanStep[]>;
  cancel(): void;
  name: string;
}
```

**`src/planning/planner-factory.ts`**
- Costruisce la catena di fallback in base a `config.planner`:
  - `'bfs'` → `[BfsPlanner]`
  - `'pddl'` → `[PddlPlanner, BfsPlanner]` (fallback)
  - `'llm'` → `[LlmPlanner, PddlPlanner, BfsPlanner]` (fallback a cascata)

**`src/planning/bfs-planner.ts`**
- Per pick-up: permutazioni di ≤4 pacchi + A* per ognuna, prende la migliore.
- Per delivery: A* verso la delivery tile più vicina (usa `getDeliveryTiles()`).

**`src/planning/pddl-planner.ts`**
- Genera un problema PDDL dal `BeliefSnapshot` e chiama il solver esterno `@unitn-asa/pddl-client`.
- Il piano PDDL viene tradotto in `PlanStep[]`.

**`src/planning/llm-planner.ts`**
- Chiama `LlmClient` con un prompt CoT costruito da `prompt-templates.ts`.
- Parsa la risposta testuale in `PlanStep[]` tramite `llm-response-parser.ts`.

**`src/planning/plan-validator.ts`**
- Prima di eseguire un piano, verifica che ogni step sia ancora valido rispetto allo snapshot corrente.
- Previene esecuzione di piani obsoleti (es. pacco già preso da un altro agente).

---

### `llm/` — Supporto LLM

**`src/llm/llm-client.ts`**
- HTTP client verso OpenRouter o endpoint universitario.
- Rate limiting: attende almeno `minCallIntervalMs` tra una chiamata e l'altra.

**`src/llm/llm-memory.ts`**
- Rolling window della storia conversazionale (max 20 step).
- Garantisce che il contesto non esploda in sessioni lunghe.

**`src/llm/prompt-templates.ts`**
- Costruisce il prompt CoT: stato della griglia, obiettivo corrente, tool catalog, storia recente.
- Il modello LLM è testuale (no function calling) — le azioni sono descritte come stringhe.

**`src/llm/tool-catalog.ts`**
- Descrive le azioni disponibili in testo (move up/down/left/right, pickup, putdown).
- Incluso nel prompt per istruire il modello su cosa può fare.

**`src/llm/llm-response-parser.ts`**
- Parsa la risposta free-text del LLM estraendo la sequenza di azioni.
- Robusto a variazioni di formato (case insensitive, righe extra).

---

### `execution/` — Esecuzione del piano

**`src/execution/action-executor.ts`**
- Esegue `PlanStep[]` in sequenza, aspettando l'ack del server per ogni azione (R08 — ActionMutex).
- Distingue due tipi di fallimento:
  - `onStepFailed` — fallimento transitorio (retry ok)
  - `onReplanRequired` — collisione con agente (R07), serve nuovo piano
- Callback: `onStepComplete`, `onPlanComplete`, `onPutdown`.

**`src/execution/action-types.ts`**
- **Unico punto** di conversione direzione↔delta: `up=y+1, down=y-1, right=x+1, left=x-1` (R09).
- Cambiare la convenzione degli assi? Cambia solo qui.

---

### `communication/` — Team play

**`src/communication/message-protocol.ts`**
- Definisce e valida tutti i tipi di messaggio:
  - `HelloMessage` — scoperta iniziale di un alleato
  - `HeartbeatMessage` — keepalive periodico
  - `BeliefShareMessage` — condivisione parcelle osservate
  - `ParcelClaimMessage` — negoziazione esclusiva su un pacco
- Tutti i messaggi hanno un campo `ts: number` (timestamp) perché l'ordinamento non è garantito (R25).

**`src/communication/message-handler.ts`**
- Layer tipizzato su `say`/`ask`/`shout` dell'SDK.
- Filtra i messaggi per `teamId` (ignora messaggi di agenti nemici).

**`src/communication/ally-tracker.ts`**
- Scopre gli alleati via `HelloMessage` al bootstrap.
- Mantiene heartbeat e rimuove alleati stale.
- Condivide beliefs (parcelle visibili) con gli alleati via `BeliefShareMessage`.
- Negoziazione claim: usa `ask` con timeout 500ms (< limite server di 1000ms, R24).
- Popola `claimedByOthers` nel `BeliefStore` per evitare planning su pacchi già presi (RI05).

---

### `agents/` — Loop BDI

**`src/agents/base-agent.ts`** — **il cuore del sistema**
- Loop continuo: `sense → deliberate → plan → execute`.
- `init(client, config)` — registra tutti i callback (`onMap`, `onSensing`, `onConfig`, ...).
- `start()` — avvia il timer di deliberazione e il monitor di stagnazione.
- Garantisce che solo una azione alla volta sia in volo (R08).
- Gestisce il `ReplanSignal` dello stagnation monitor.
- Traccia `penaltyCount` e logga warning vicino al limite di kick (R22).
- **Non istanziare direttamente** — usa `BdiAgent` o `LlmAgent`.

**`src/agents/bdi-agent.ts`**
- Sottoclasse minimale: override di `buildPlannerChain()` → `PlannerFactory.build('bfs')` o `'pddl'`.

**`src/agents/llm-agent.ts`**
- Sottoclasse minimale: override di `buildPlannerChain()` → `PlannerFactory.build('llm')`.

---

### `metrics/` e `logging/` — Osservabilità (orthogonal)

**`src/metrics/metrics-collector.ts`** — raccoglie durante la run: score timeline, n. deliveries, n. penalità, latenze planner.

**`src/metrics/metrics-snapshot.ts`** — serializza snapshot periodici in `bdi-metrics.json`.

**`src/logging/logger.ts`** — wrapper `pino` con livelli `debug/info/warn/error`.

**`src/logging/log-types.ts`** — union type `LogEvent` con `kind` discriminante (es. `'deliberation'`, `'plan_start'`, `'action_fail'`, ...).

**`src/logging/log-ring-buffer.ts`** — ultimi N eventi in memoria, consultabile senza file system.

---

## 6. Sistema di Eval

### Architettura

```
eval-runner.ts
  └── per ogni mappa × run:
        ├── spawn Deliveroo.js server (porta dedicata)
        ├── pollServerReady()
        ├── spawn agente (child process) con env:
        │     EVAL_MAP_NAME, EVAL_RUN_INDEX, EVAL_LOGS_DIR
        ├── wait(duration)
        ├── kill gruppo
        └── eval-summarizer: L1 → L2
eval-report.ts → logs/evaluation-report.json
```

### CLI flags di `eval-runner.ts`

```
--maps empty_10,circuit   nomi separati da virgola (default: tutte le 18)
--runs 3                  ripetizioni per mappa (default: 5)
--duration 120            secondi per run (default: 300)
--parallel 4              run parallele contemporanee (default: 1)
```

### 18 mappe in 7 categorie

| Categoria | Mappe |
|---|---|
| `open` | `empty_10`, `empty_30` |
| `corridor` | `hallway` |
| `maze` | `chaotic_maze`, `25c1_8`, `25c2_4` |
| `directional` | `circuit`, `circuit_directional` |
| `path_width` | `wide_paths`, `small_paths`, `small_two_wide`, `long_hallways`, `hallways_interconnected` |
| `themed` | `crossroads`, `vortex`, `tree`, `atom` |
| `obstacles` | `two_obstacles` |

Mappe escluse: `crates_maze`, `crates_one_way` (logica crate non implementata), `decoration` (layout degenere).

### Output

```
logs/
├── L1/<mappa>_run<idx>.json    eventi per-tick durante la run
├── L2/<mappa>.json             aggregato per run (score, SPM, anomalie)
├── bdi-metrics.json            metriche planner
└── evaluation-report.json      G-score e ranking finale
```

---

## 7. Domain Rules essenziali

Riferimento completo: `.claude/context/DOMAIN_RULES.md`.

| Codice | Regola (in breve) | Modulo che la implementa |
|---|---|---|
| R01 | Tile: 0=muro, 1=spawn, 2=delivery, 3=normale, 4=base, 5=crate, ↑↓←→=direzionali | `belief-map.ts` |
| R02 | Tile direzionale blocca l'INGRESSO nella direzione della freccia | `belief-map.ts` → `canEnterFrom()`, `pathfinder.ts` |
| R03 | Mappa statica dopo init — no ricalcolo percorsi durante il gioco | `belief-map.ts` (costruita una volta) |
| R04 | Topologia globale nota; entità parzialmente osservabili | `belief-map.ts` vs `belief-store.ts` (separazione) |
| R05 | Durante movimento: tile partenza + arrivo entrambe bloccate | `pathfinder.ts` (esclude tile occupate) |
| R06 | Coordinate frazionarie durante movimento → arrotondare sempre | `belief-store.ts` (Math.round) |
| R07 | Mossa su tile occupata → `false` + penalità; distinguere da fallimento transitorio | `action-executor.ts` |
| R08 | Una sola azione per agente alla volta, aspettare ack | `action-executor.ts`, `base-agent.ts` |
| R09 | Assi: up=y+1, down=y-1, right=x+1, left=x-1 | `action-types.ts` (unico punto) |
| R10 | Sensing: distanza `<` (strict), non `<=` | `belief-store.ts` |
| R11 | `observationDistance` dal server via evento `'config'`, non hardcoded | `game-client.ts` → `belief-store.ts` |
| R12 | Evento `'sensing'` unificato: `{positions, agents, parcels, crates}` | `game-client.ts` (decompone) |
| R13 | Sensing aggiornato ogni ~50ms (un frame) — piccolo lag dopo azioni | `base-agent.ts` (non aspettarsi consistenza immediata) |
| R14 | Reward al delivery = timer rimasto al momento del `putdown` | `parcel-tracker.ts` → `deliberator.ts` |
| R15 | Parcelle `reward=0` restano nel sensing; il deliberator le filtra | `belief-store.ts` (non rimuove), `deliberator.ts` (filtra) |
| R16 | `pickup()` raccoglie TUTTI i pacchi liberi sulla tile | `belief-store.ts`, `action-executor.ts` |
| R17 | `putdown` fuori delivery lascia il pacco al suolo (no punti) | `bfs-planner.ts` (evita putdown sbagliati) |
| R18 | `capacity` non enforced dal server — hard filter solo lato client | `deliberator.ts` |
| R19 | Spawn solo su tile tipo 1 | `belief-map.ts` → `getSpawningTiles()` |
| R20 | Scoring richiede `putdown` esplicito su tile tipo 2 | `action-executor.ts`, `bfs-planner.ts` |
| R21 | Qualsiasi tile tipo 2 raggiungibile è valida per delivery | `belief-map.ts` → `getDeliveryTiles()`, `bfs-planner.ts` |
| R22 | Penalità irreversibili; a −1000 kick | `belief-store.ts` (penaltyCount), `base-agent.ts` (warning) |
| R23 | Disconnessione >10s rimuove agente | `game-client.ts` (reconnect automatico) |
| R24 | `ask` server timeout 1000ms → rispondere entro ~900ms | `ally-tracker.ts` (timeout interno 500ms) |
| R25 | Messaggi senza ordine garantito → campo `ts` in tutti | `message-protocol.ts` |
| R26 | `say` ad agente inesistente è no-op silenzioso (ack `'successful'` comunque) | `ally-tracker.ts` (heartbeat per rilevare stale) |
| RI05 | Un pacco portato da un solo agente; race condition risolta server-side | `ally-tracker.ts` (claim negotiation) |
| RI08 | `reward` nel sensing è il valore ATTUALE (già decaduto) | `parcel-tracker.ts` → `estimateRewardAt()` |

---

## 8. Test

- **Framework**: Node test runner nativo, lanciato con `tsx --test`.
- **Comando**: `npm test` → `tsx --test src/**/*.test.ts`.
- **Convenzione**: test colocati con il modulo (`belief-map.test.ts`, `deliberator.edge.test.ts`, ...).
- **Test E2E**: `src/testing/e2e-smoke.test.ts` — usa `MockGameClient` senza server reale.
- **Fixtures**: `src/testing/fixtures.ts` — mappe precostituite (inclusa mappa con tile direzionali per R02).
- **Mock**: `src/testing/mock-game-client.ts` — simula eventi del server (map, you, sensing) in modo controllabile.

File di test presenti: `belief-map.test.ts`, `belief-store.test.ts`, `belief-store.crates.test.ts`, `belief-store.domain.test.ts`, `parcel-tracker.test.ts`, `parcel-tracker.edge.test.ts`, `belief-snapshot.test.ts`, `belief-map.domain.test.ts`, `pathfinder.test.ts`, `bfs-planner.test.ts`, `plan-validator.test.ts`, `plan-validator.edge.test.ts`, `planner-factory.test.ts`, `llm-planner.test.ts`, `llm-client.test.ts`, `llm-memory.test.ts`, `llm-response-parser.test.ts`, `llm-response-parser.edge.test.ts`, `deliberator.test.ts`, `deliberator.edge.test.ts`, `deliberator.domain.test.ts`, `intention.test.ts`, `action-executor.domain.test.ts`, `action-executor.edge.test.ts`, `action-executor.retry.test.ts`, `message-handler.test.ts`, `message-protocol.domain.test.ts`, `ally-tracker.test.ts`, `ally-tracker.edge.test.ts`, `metrics-collector.test.ts`, `metrics-collector.edge.test.ts`, `log-ring-buffer.test.ts`, `logger.test.ts`, `event-buffer.test.ts`, `agent-config.test.ts`, `bdi-agent.test.ts`, `mock-game-client.test.ts`, `e2e-smoke.test.ts`, `types.test.ts`.

---

## 9. Ordine di lettura consigliato

Segui questo ordine la prima volta. Ogni passo costruisce sul precedente.

| # | File | Perché |
|---|---|---|
| 1 | `README.md` + `ARCHITECTURE.md` | Panoramica e decisioni architetturali |
| 2 | `.claude/context/DOMAIN_RULES.md` | Vincoli del problema — punto di riferimento costante |
| 3 | `src/types.ts` | Vocabolario di base (Direction, TileType, IAgent, ...) |
| 4 | `src/config/agent-config.ts` + `configs/agent-bdi.json` | Come si configura il sistema |
| 5 | `src/main.ts` | Wiring complessivo (63 righe — leggilo tutto) |
| 6 | `src/logging/log-types.ts` + `logger.ts` | Meccanismo di logging |
| 7 | `src/client/event-buffer.ts` → `game-client.ts` | Come arrivano gli eventi dal server |
| 8 | `src/beliefs/belief-map.ts` | Topologia statica (R01–R03, R19, R21) |
| 9 | `src/pathfinding/grid-utils.ts` → `pathfinder.ts` | A* orientato (R02, R05, R09) |
| 10 | `src/beliefs/parcel-tracker.ts` → `belief-store.ts` | Stato osservato (R06, R10, R15, R22) |
| 11 | `src/beliefs/belief-snapshot.ts` | Immutabilità per i planner |
| 12 | `src/deliberation/intention.ts` → `deliberator.ts` | Scelta obiettivo (R14, R15, R18, RI08) |
| 13 | `src/deliberation/stagnation-monitor.ts` | Rilevamento blocco |
| 14 | `src/planning/planner.interface.ts` → `bfs-planner.ts` → `plan-validator.ts` → `planner-factory.ts` | Pianificazione base |
| 15 | `src/planning/pddl-planner.ts` | Pianificazione PDDL |
| 16 | `src/llm/llm-client.ts` → `tool-catalog.ts` → `prompt-templates.ts` → `llm-planner.ts` | Pianificazione LLM |
| 17 | `src/execution/action-types.ts` → `action-executor.ts` | Esecuzione piano (R07, R08) |
| 18 | `src/communication/message-protocol.ts` → `ally-tracker.ts` | Team play (R24, R25, RI05) |
| 19 | `src/agents/base-agent.ts` → `bdi-agent.ts` | Loop BDI completo — tutto si unisce qui |
| 20 | `src/testing/fixtures.ts` → `e2e-smoke.test.ts` | Sistema in moto senza server |
| 21 | `src/evaluation/map-registry.ts` → `eval-runner.ts` | Benchmark multi-mappa |
| 22 | `src/metrics/metrics-collector.ts` | Osservabilità (lettura opzionale) |

---

## 10. Cheatsheet — dove trovo X?

| Domanda | Risposta |
|---|---|
| Dove sta il loop BDI? | `src/agents/base-agent.ts` |
| Dove si decide cosa fare (quale pacco prendere)? | `src/deliberation/deliberator.ts` |
| Dove si calcola il percorso? | `src/pathfinding/pathfinder.ts` |
| Dove sta la logica A*? | `src/pathfinding/pathfinder.ts` |
| Dove si gestisce la mappa (tile, walkable)? | `src/beliefs/belief-map.ts` |
| Dove si aggiornano le beliefs su pacchi e agenti? | `src/beliefs/belief-store.ts` |
| Come si stima il reward futuro di un pacco? | `src/beliefs/parcel-tracker.ts` → `estimateRewardAt()` |
| Come si costruisce una catena di planner? | `src/planning/planner-factory.ts` |
| Dove si converte `up/down/left/right` in delta (x,y)? | `src/execution/action-types.ts` |
| Dove si fanno le azioni (move/pickup/putdown)? | `src/execution/action-executor.ts` |
| Come vengono mandati messaggi agli alleati? | `src/communication/message-handler.ts` |
| Come si negozia il claim su un pacco? | `src/communication/ally-tracker.ts` |
| Come si aggiunge una nuova mappa all'eval? | `src/evaluation/map-registry.ts` → aggiungi in `mapsByCategory` |
| Dove sta la configurazione degli agenti? | `configs/agent-bdi.json`, `configs/agent-llm.json` |
| Dove vengono lette le env var? | `src/config/agent-config.ts` (interpolazione `${VAR}`) |
| Dove viene letta `capacity`? | Dal server via evento `'config'`; mai hardcoded |
| Dove viene letta `observationDistance`? | Dal server via evento `'config'`; `game-client.ts` → `getObservationDistance()` |
| Dove vengono scritti i risultati dell'eval? | `logs/L1/`, `logs/L2/`, `logs/evaluation-report.json` |
| Come si lancia solo una mappa dell'eval? | `tsx src/evaluation/eval-runner.ts --maps empty_10 --runs 1 --duration 60` |
| Come si vede se l'agente è bloccato? | `src/deliberation/stagnation-monitor.ts` + log `warn` in `base-agent.ts` |
| Dove sono le dichiarazioni di tipo dell'SDK Deliveroo? | `src/client/deliveroo-client.d.ts` |
| Dove si può vedere il sistema girare senza server? | `src/testing/e2e-smoke.test.ts` + `src/testing/mock-game-client.ts` |
