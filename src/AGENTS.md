# AGENTS.md — src/ (root)

## Responsabilità
Entry point CLI e definizioni di tipo condivise tra tutti i moduli.

## File chiave

| File | Descrizione |
|------|-------------|
| `main.ts` | Legge `--config`, istanzia `GameClient` e l'agente, connette e avvia il loop |
| `types.ts` | Unica sorgente di verità per tutti i tipi condivisi (100+ tipi, nessuna dipendenza interna) |

## Dipendenze da altri moduli interni
- `main.ts` → `config/agent-config.ts`, `client/game-client.ts`, `agents/bdi-agent.ts`, `agents/llm-agent.ts`
- `types.ts` → nessuna (foglia del grafo di dipendenze)

## Dipendenze esterne
- Nessuna dipendenza esterna diretta in `main.ts` o `types.ts`

## Vincoli DOMAIN_RULES rilevanti
- **R08** — `main.ts` chiama `client.drainPending()` dopo `agent.init()` e prima di `agent.start()`: garantisce che gli eventi bufferizzati vengano riemessi nell'ordine corretto prima che l'agente inizi ad agire.
- **R23** — Il connect può fallire se il server non risponde; `main.ts` cattura l'errore e fa `process.exit(1)` invece di rimanere connesso in stato indefinito.

## Cosa NON fare
- Non aggiungere logica di gioco o sensing in `main.ts`: è solo wiring.
- Non aggiungere tipi specifici di un solo modulo in `types.ts`: i tipi locali vanno nel file del modulo che li usa.
- Non importare direttamente `@unitn-asa/deliveroo-js-client` in `main.ts`: passa solo attraverso `GameClient`.
