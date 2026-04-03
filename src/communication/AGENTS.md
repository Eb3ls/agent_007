# AGENTS.md — src/communication/

## Responsabilità
Protocollo inter-agente sopra `GameClient`: serializzazione messaggi tipizzati, filtering per team, discovery alleati, heartbeat e negoziazione claim parcelle.

## File chiave

| File | Descrizione |
|------|-------------|
| `message-protocol.ts` | `serializeMessage/deserializeMessage`: format JSON + validazione; `nextSeq()`: numero sequenza monotonicamente crescente |
| `message-handler.ts` | Layer tipizzato su `say/ask/shout` con whitelist mittenti (`allowedSenders`) e rate limiting belief_share |
| `ally-tracker.ts` | Discovery (hello), heartbeat, condivisione belief (rate-limited 1/s), negoziazione claim parcelle via `ask` con timeout 500ms |

## Dipendenze da altri moduli interni
- `types.ts` — `InterAgentMessage` (union di 6 tipi), `BeliefSnapshot`, `GameClient`
- `client/game-client.ts` — `emitSay`, `emitAsk`, `emitShout`, `onMessage`
- `beliefs/belief-store.ts` — per `mergeRemoteBelief()` e `allyIds`

## Dipendenze esterne
- Server Deliveroo.js (routing messaggi via WebSocket)

## Vincoli DOMAIN_RULES rilevanti
- **R24** — `ally-tracker.ts` usa timeout interno di **500ms** per ogni `ask` di negoziazione: strettamente sotto il limite server di 1000ms. Non aumentare oltre 900ms.
- **R25** — Ogni messaggio include `seq: number` (monotonicamente crescente) e `ts: number` (timestamp ms): `ally-tracker.ts` usa `ts` per ordinamento esplicito quando i messaggi arrivano fuori ordine.
- **R26** — Il successo dell'ack `say` NON significa che l'alleato è vivo. `ally-tracker.ts` usa il meccanismo di heartbeat per rilevare alleati disconnessi; non basarsi sul risultato di `say`.
- **RI05** — La negoziazione claim mitiga la race condition su parcelle, ma il server risolve il caso limite con il "primo-arrivato". `claimedByOthers` esclude le parcelle già reclamate dalle intenzioni del deliberator.

## Cosa NON fare
- Non aumentare il timeout interno di `ask` oltre 900ms (R24).
- Non interpretare il successo di `say` come conferma di ricezione da parte dell'alleato (R26).
- Non dipendere dall'ordine di arrivo dei messaggi rispetto agli eventi di sensing (R25): includere sempre `ts` e ordinare esplicitamente.
- Non inviare `belief_share` ad ogni frame: il rate limit di 1/s in `message-handler.ts` deve essere rispettato.
