# AGENTS.md — src/client/

## Responsabilità
Unico punto di contatto con `@unitn-asa/deliveroo-js-client`: wrappa l'SDK in un'interfaccia tipizzata con buffering degli eventi pre-init.

## File chiave

| File | Descrizione |
|------|-------------|
| `game-client.ts` | Wrapper tipizzato su SDK: connect, azioni async (move/pickup/putdown), subscribe eventi, buffering |
| `event-buffer.ts` | Accoda eventi arrivati prima che i callback siano registrati; `drain()` li riemette in ordine |
| `deliveroo-client.d.ts` | Type stubs per la libreria JS esterna (non modificare senza aggiornare anche `game-client.ts`) |

## Dipendenze da altri moduli interni
- `types.ts` — `RawSelfSensing`, `RawParcelSensing`, `RawAgentSensing`, `InterAgentMessage`, `Direction`, `TileType`, ...

## Dipendenze esterne
- `@unitn-asa/deliveroo-js-client` — SDK WebSocket per Deliveroo.js (solo `game-client.ts` lo importa)
- Server Deliveroo.js su `config.host` (connessione WebSocket a runtime)

## Vincoli DOMAIN_RULES rilevanti
- **R06** — Le coordinate frazionarie vengono inoltrate così come arrivano: `GameClient` NON arrotonda. L'arrotondamento è responsabilità di `belief-store.ts`.
- **R08** — `emitMove/emitPickup/emitPutdown` sono `async` e aspettano l'ack del server: mai inviare una seconda azione senza attendere il risultato della prima.
- **R09** — Il mapping da `↑↓←→` (frecce unicode del server) a `TileType` avviene qui; `up=y+1` è la convenzione.
- **R11** — `getObservationDistance()` (unificata) e `getServerCapacity()` leggono dalla config server ricevuta all'evento `'config'`; nessun valore hardcoded. `getObservationDistance()` legge `GAME.player.observation_distance`.
- **R23** — `onReconnect` è esposto per permettere a `base-agent.ts` di riprendere il loop in caso di riconnessione entro 10s.
- **R25** — `onMessage` consegna messaggi nell'ordine in cui arrivano; l'ordinamento semantico è responsabilità di `message-handler.ts`.

## Cosa NON fare
- Non importare direttamente `@unitn-asa/deliveroo-js-client` in nessun altro modulo.
- Non aggiungere logica di gioco (deliberation, planning) in questo modulo.
- Non arrotondare coordinate frazionarie: appartiene a `belief-store.ts` (R06).
- Non hardcodare valori di sensing distance o capacità: leggerli dall'evento `'config'` (R11).
