# AGENTS.md — src/testing/

## Responsabilità
Test doubles e fixture per testare i moduli senza un server Deliveroo.js reale.

## File chiave

| File | Descrizione |
|------|-------------|
| `mock-game-client.ts` | `MockGameClient`: simula `GameClient` con eventi controllabili da test (map, you, sensing, messaggi) |
| `fixtures.ts` | Mappe, stati parcelle/agenti e configurazioni precostituiti per scenari di test specifici |

## Dipendenze da altri moduli interni
- `types.ts` — tutti i tipi necessari per simulare eventi del server
- `client/game-client.ts` — `MockGameClient` rispetta la stessa interfaccia pubblica di `GameClient`

## Dipendenze esterne
- Nessuna (i test usano `tsx --test`, il runner nativo di Node.js)

## Vincoli DOMAIN_RULES rilevanti
- **R02** — Le fixture devono includere almeno una mappa con tile direzionali per testare che `canEnterFrom()` blocchi l'entrata dalla direzione corretta. Senza questa fixture, le regressioni su tile direzionali sono invisibili.
- **R06** — Le fixture di sensing possono includere coordinate frazionarie per testare che `belief-store.ts` le arrotondi correttamente.
- **R10** — Le fixture devono includere parcelle esattamente al boundary della sensing distance per testare il `<` vs `<=`.

## Cosa NON fare
- Non usare `MockGameClient` fuori dalla cartella `testing/`: i test di integrazione che toccano il server reale vanno in `e2e-smoke.test.ts`.
- Non aggiungere logica di gioco nelle fixture: sono dati statici, non simulazioni.
- Non fare dipendere i moduli di produzione da `testing/`: le dipendenze sono solo da test verso produzione, mai viceversa.
