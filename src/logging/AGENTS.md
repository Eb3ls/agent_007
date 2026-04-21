# AGENTS.md — src/logging/

## Responsabilità
Logging strutturato a livelli via pino con ring buffer in memoria per il contesto LLM e il debug post-mortem.

## File chiave

| File | Descrizione |
|------|-------------|
| `logger.ts` | `createLogger(module, level)`: istanza pino child con ring buffer integrato; `getLlmContext()`: JSON compatto degli ultimi N log per prompt LLM |
| `log-types.ts` | `RingBufferEntry` e re-export di `LogEvent`/`LogLevel` da `types.ts` |
| `log-ring-buffer.ts` | Buffer circolare a 500 slot con `push()` e `query(lastNSeconds, lastNEvents, kinds)` |

## Dipendenze da altri moduli interni
- `types.ts` — `LogEvent`, `LogLevel`

## Dipendenze esterne
- `pino` — logger strutturato (output JSON su stdout)
- `pino-pretty` — formattazione leggibile in sviluppo (dev dependency)

## Vincoli DOMAIN_RULES rilevanti
- **R22** — I log di penalità (`penalty_received`, `score_update`) devono essere conservati nel ring buffer per permettere a `base-agent.ts` di loggare warning quando `penalty < -500`.
- **R13** — I timestamp nei log usano `Date.now()` (ms), non il frame clock del server: utile per debugging ma non usare per calcoli di timing di gioco.

## Cosa NON fare
- Non usare `console.log` direttamente negli altri moduli: tutti i log devono passare da un'istanza `createLogger()`.
- Non aumentare la dimensione del ring buffer oltre 500 senza valutare l'impatto sulla memoria (sessioni lunghe).
- Non salvare il ring buffer su disco in questo modulo: l'export è responsabilità di `metrics/`.
