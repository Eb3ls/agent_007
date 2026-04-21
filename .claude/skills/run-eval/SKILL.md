---
name: run-eval
description: Use when you want to test the BDI agent across maps. Runs the eval-runner, waits for completion, and prints a summary of G-score, SPM per map, and anomalies.
---

# run-eval

Esegui una valutazione end-to-end dell'agente BDI su tutte le 18 mappe.

## Uso

```
/run-eval [--duration 60] [--runs 1] [--parallel 2]
```

Default: `--duration 30 --runs 1 --parallel 1`

## Procedura

1. Esegui il runner in foreground:
   ```
   npx tsx src/evaluation/eval-runner.ts --duration <D> --runs <R> --parallel <P>
   ```

2. Attendi il completamento (timeout = `parallel × ceil(runs × 18 / parallel) × duration × 1.3` secondi).

3. Leggi `logs/evaluation-report.json` e stampa:
   - G-score (target > 0.70)
   - `overfitDetected`
   - SPM per mappa (tabella ordinata)
   - Anomalie aggregate

4. Verifica questi criteri di successo:
   - Nessuna mappa con `connLosses > 0` nei L2 → se sì, segnala bug nel process kill
   - Nessuna mappa con `steps = 0` → se sì, evalLogger non è stato iniettato correttamente
   - `partial: false` in tutti i L2 → se sì, il flush L1 funziona

5. Se un criterio fallisce, indica il file L1 da ispezionare e il tipo di problema.
