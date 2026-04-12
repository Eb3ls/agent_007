# AGENTS.md — src/config/

## Responsabilità
Caricare, interpolate variabili d'ambiente e validare il file JSON di configurazione agente.

## File chiave

| File | Descrizione |
|------|-------------|
| `agent-config.ts` | `loadConfig(path)`: legge JSON, sostituisce `${VAR}` con env vars, valida campi obbligatori |

## Dipendenze da altri moduli interni
- `types.ts` — `AgentConfig`, `AgentRole`, `PlannerChoice`, `LogLevel`, `LlmConfig`

## Dipendenze esterne
- `dotenv` — carica `.env` in `process.env` (idempotente, non sovrascrive variabili già impostate)
- `node:fs` — `readFileSync` per leggere il file JSON
- `node:path` — `resolve` per convertire path relativi in assoluti

## Vincoli DOMAIN_RULES rilevanti
- **R11** — I valori di sensing distance NON vengono configurati qui: vengono letti dall'evento `'config'` del server a runtime. Questo modulo gestisce solo la configurazione lato agente (token, host, role, planner).
- **R24** — `stagnationTimeoutMs` è configurabile nel JSON: permette di calibrare la soglia prima di avvicinarsi ai limiti di penalità (R22).

## Cosa NON fare
- Non hardcodare valori di default per parametri che il server invia a runtime (sensing distance, movement duration).
- Non aggiungere logica di connessione o di gioco: questo modulo è puro parsing/validazione.
- Non accedere a `process.env` direttamente al di fuori di `interpolateEnvVars()`: tutta la risoluzione di variabili deve passare da quella funzione.
- Non loggare il token in chiaro: può apparire nei log di sistema.
