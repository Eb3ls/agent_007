# AGENTS.md — src/llm/

## Responsabilità
Integrazione con l'API LLM (OpenRouter-compatible): client HTTP con rate limit, gestione contesto rolling-window, parsing output testuale in `PlanStep[]` e costruzione prompt CoT.

## File chiave

| File | Descrizione |
|------|-------------|
| `llm-client.ts` | `LlmClient.complete(messages, maxTokens)`: HTTP POST con rate limit, timeout 10s, char budget; ritorna `string \| null` |
| `llm-memory.ts` | Rolling window sugli ultimi N action steps e log events; gestione token budget |
| `llm-response-parser.ts` | Parsing output testuale LLM in `PlanStep[]` tramite pattern matching/regex |
| `prompt-templates.ts` | Costruttori di prompt CoT con stato corrente, goal, tool catalog |
| `tool-catalog.ts` | Descrizione testuale delle azioni disponibili per l'agente (inserita nel prompt) |

## Dipendenze da altri moduli interni
- `types.ts` — `LlmConfig`, `PlanStep`, `ActionType`, `BeliefSnapshot`, `Position`
- `logging/logger.ts` — per loggare latenza e token usage

## Dipendenze esterne
- API LLM configurabile via `config.llm.apiUrl` (OpenRouter o provider universitario) — HTTP/HTTPS
- `fetch()` nativo di Node.js (≥18)

## Vincoli DOMAIN_RULES rilevanti
- **R11** — `tool-catalog.ts` deve elencare le azioni reali del server (`move_up/down/left/right`, `pickup`, `putdown`). Non inventare azioni che il server non supporta.
- **RI08** — Il prompt deve includere il reward attuale delle parcelle e non il reward originale: l'LLM deve ragionare sul valore residuo, non su quello iniziale.
- **R22** — `LlmClient` ritorna `null` in caso di timeout (10s): il `LlmPlanner` deve gestire `null` delegando immediatamente al fallback (PDDL→BFS), non ritentare all'infinito.
- Il provider LLM dell'università è plain (no function calling): le azioni sono descritte in testo e il parser le riconosce tramite pattern.

## Cosa NON fare
- Non usare function calling / tool use nativi dell'API: il provider non li supporta (note progetto).
- Non aumentare il timeout LLM oltre 10s: il server Deliveroo ha un timeout di partita; un piano che arriva tardi non serve.
- Non passare il live `BeliefStore` ai template: usare `BeliefSnapshot` frozen (Arch Decision #2).
- Non loggare `apiToken` in chiaro: la configurazione viene dal `.env` e non deve apparire nei log.
