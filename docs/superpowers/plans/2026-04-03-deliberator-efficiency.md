# Deliberator Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ridurre il costo computazionale del deliberation loop eliminando `evaluate()` ridondante e saltando re-evaluation quando nulla è strutturalmente cambiato.

**Architecture:** Tre interventi indipendenti: (1) inizializzare `ParcelTracker` con il decay rate del server invece di aspettare la misura empirica; (2) passare i candidates pre-calcolati a `shouldReplan` per eliminare la doppia `evaluate()`; (3) aggiungere un gate in `_deliberateAndPlan` che salta l'intera valutazione quando il set di parcelle e la posizione non sono cambiati.

**Tech Stack:** TypeScript, Node.js test runner (`node:test`), `tsx --test`

---

## File modificati

| File | Cosa cambia |
|------|-------------|
| `src/beliefs/parcel-tracker.ts` | +`setBaseDecayRate(ratePerMs)`, modifica `getGlobalAverageDecayRate()` |
| `src/agents/base-agent.ts` | +`parseIntervalMs`, init base decay in `onMap`, +gate fields, restructure `_deliberateAndPlan` |
| `src/deliberation/deliberator.ts` | +parametro opzionale `precomputedCandidates` a `shouldReplan` |
| `src/beliefs/parcel-tracker.test.ts` | +3 test per `setBaseDecayRate` |
| `src/deliberation/deliberator.edge.test.ts` | +2 test per `shouldReplan` con candidates pre-calcolati |

---

## Task 1 — ParcelTracker: decay rate da config server

**Files:**
- Modify: `src/beliefs/parcel-tracker.ts`
- Modify: `src/agents/base-agent.ts` (solo blocco `client.onMap`)
- Test: `src/beliefs/parcel-tracker.test.ts`

**Contesto:** Attualmente `getGlobalAverageDecayRate()` ritorna `0` finché non ci sono almeno 2 osservazioni empiriche. `PARCEL_DECADING_INTERVAL` è disponibile dal server al connect ma viene ignorato. Ogni tick di decay riduce il reward di 1 unità, quindi `decayRatePerMs = 1 / intervalMs`.

- [ ] **Step 1.1 — Scrivi i test fallenti in `src/beliefs/parcel-tracker.test.ts`**

  Aggiungi alla fine del file, dopo i test esistenti:

  ```ts
  // --- setBaseDecayRate ---

  describe('ParcelTracker — setBaseDecayRate', () => {
    it('getGlobalAverageDecayRate returns base rate when no empirical observations', () => {
      const tracker = new ParcelTracker();
      tracker.setBaseDecayRate(0.005);
      assert.strictEqual(tracker.getGlobalAverageDecayRate(), 0.005);
    });

    it('estimateRewardAt uses base decay rate as fallback for new parcel (single observation)', () => {
      const tracker = new ParcelTracker();
      tracker.setBaseDecayRate(0.01); // 1 reward unit per 100ms
      tracker.observe('p1', 50, 0);
      // 1000ms later: 50 - 0.01*1000 = 40
      assert.strictEqual(tracker.estimateRewardAt('p1', 1000), 40);
    });

    it('empirical rate takes precedence over base rate once measured', () => {
      const tracker = new ParcelTracker();
      tracker.setBaseDecayRate(0.001); // slow base rate
      tracker.observe('p1', 50, 0);
      tracker.observe('p1', 40, 1000); // empirical: (50-40)/1000 = 0.01
      // Global avg now uses empirical, not base
      assert.strictEqual(tracker.getGlobalAverageDecayRate(), 0.01);
      assert.strictEqual(tracker.getDecayRate('p1'), 0.01);
    });
  });
  ```

- [ ] **Step 1.2 — Verifica che i test falliscano**

  ```bash
  cd /home/leo/Documents/agent_007-rewrite
  tsx --test src/beliefs/parcel-tracker.test.ts 2>&1 | tail -20
  ```

  Atteso: `TypeError` o `not a function` su `setBaseDecayRate`.

- [ ] **Step 1.3 — Implementa `setBaseDecayRate` in `src/beliefs/parcel-tracker.ts`**

  Aggiungi il campo privato dopo `private spawns`:

  ```ts
  private baseDecayRatePerMs = 0;
  ```

  Aggiungi il metodo dopo `getDecayRate`:

  ```ts
  /** Override the fallback decay rate used when no empirical data is available. */
  setBaseDecayRate(ratePerMs: number): void {
    this.baseDecayRatePerMs = ratePerMs;
  }
  ```

  Sostituisci `getGlobalAverageDecayRate()` (la riga `if (rates.length === 0) return 0;`):

  ```ts
  if (rates.length === 0) return this.baseDecayRatePerMs;
  ```

- [ ] **Step 1.4 — Verifica che i test passino**

  ```bash
  tsx --test src/beliefs/parcel-tracker.test.ts 2>&1 | tail -10
  ```

  Atteso: tutti i test `pass`.

- [ ] **Step 1.5 — Aggiungi `parseIntervalMs` e inizializzazione in `src/agents/base-agent.ts`**

  Aggiungi la funzione module-level (non esportata) prima della classe `BaseAgent`, dopo gli import:

  ```ts
  /**
   * Parse a server interval string ("1s", "500ms", "1000") to milliseconds.
   * PARCEL_DECADING_INTERVAL is formatted as e.g. "1s" or "500ms".
   */
  function parseIntervalMs(s: string): number {
    const t = s.trim();
    if (t.endsWith('ms')) return parseInt(t, 10);
    if (t.endsWith('s')) return parseFloat(t) * 1000;
    return parseInt(t, 10);
  }
  ```

  Nel blocco `client.onMap`, dopo `this.beliefs.setObservationDistance(...)`:

  ```ts
  // Initialize base decay rate from server config so estimateRewardAt is
  // accurate from frame 1 instead of waiting for 2 empirical observations.
  const decayInterval = client.getServerConfig()?.PARCEL_DECADING_INTERVAL;
  if (decayInterval) {
    const intervalMs = parseIntervalMs(decayInterval);
    if (intervalMs > 0) {
      this.beliefs.getParcelTracker().setBaseDecayRate(1 / intervalMs);
    }
  }
  ```

- [ ] **Step 1.6 — Build TypeScript per verificare nessun errore di tipo**

  ```bash
  npm run build 2>&1 | grep -E "error|Error" | head -20
  ```

  Atteso: nessun output (build pulita).

- [ ] **Step 1.7 — Commit**

  ```bash
  cd /home/leo/Documents/agent_007-rewrite
  git add src/beliefs/parcel-tracker.ts src/agents/base-agent.ts src/beliefs/parcel-tracker.test.ts
  git commit -m "fix(parcel-tracker): initialize base decay rate from PARCEL_DECADING_INTERVAL at startup

  Previously getGlobalAverageDecayRate() returned 0 until at least 2 consecutive
  observations were received, causing estimateRewardAt to underestimate reward decay
  in the first frames. Now uses the server-provided interval as an immediate fallback.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 2 — Elimina il doppio `evaluate()` in `shouldReplan`

**Files:**
- Modify: `src/deliberation/deliberator.ts`
- Test: `src/deliberation/deliberator.edge.test.ts`

**Contesto:** `shouldReplan` chiama `evaluate()` internamente. `_deliberateAndPlan` poi chiama `evaluate()` di nuovo per ottenere i candidates. Aggiungere un parametro opzionale `precomputedCandidates` permette di riusare il risultato.

- [ ] **Step 2.1 — Scrivi il test fallente in `src/deliberation/deliberator.edge.test.ts`**

  Aggiungi alla fine del file, dopo i test esistenti. Usa il `mockStore` già definito lì:

  ```ts
  // ---------------------------------------------------------------------------
  // shouldReplan — precomputedCandidates evita doppio evaluate()
  // ---------------------------------------------------------------------------

  describe('Deliberator — shouldReplan con precomputedCandidates', () => {
    it('con precomputedCandidates dà stesso risultato di senza', () => {
      const deliberator = new Deliberator();
      const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, reward: 20 });
      const store = mockStore([p]);
      const intention = createSingleIntention(p, 1, 9, 20);

      const withoutPre = deliberator.shouldReplan(intention, store, false, 500);
      const candidates = deliberator.evaluate(store, 500);
      const withPre = deliberator.shouldReplan(intention, store, false, 500, undefined, candidates);

      assert.strictEqual(withPre, withoutPre,
        'shouldReplan con precomputedCandidates deve dare stesso risultato');
    });

    it('con precomputedCandidates vuoti: nessun candidato migliore → no replan', () => {
      const deliberator = new Deliberator();
      const p = makeParcel({ id: 'p1', position: { x: 5, y: 4 }, reward: 20 });
      const store = mockStore([p]);
      const intention = createSingleIntention(p, 1, 9, 20);

      // Passare array vuoto = nessun candidato migliore → no replan
      const result = deliberator.shouldReplan(intention, store, false, 500, undefined, []);
      assert.strictEqual(result, false,
        'nessun candidato migliore → shouldReplan deve ritornare false');
    });
  });
  ```

- [ ] **Step 2.2 — Verifica che i test falliscano**

  ```bash
  tsx --test src/deliberation/deliberator.edge.test.ts 2>&1 | tail -20
  ```

  Atteso: errore TypeScript su `precomputedCandidates` (parametro non esistente) o errore runtime.

- [ ] **Step 2.3 — Aggiungi `precomputedCandidates` a `shouldReplan` in `src/deliberation/deliberator.ts`**

  Cambia la firma di `shouldReplan` aggiungendo il parametro opzionale:

  ```ts
  shouldReplan(
    currentIntention: Intention | null,
    beliefs: IBeliefStore,
    planFailed = false,
    movementDurationMs = 500,
    tracker?: ParcelTracker,
    precomputedCandidates?: Intention[],
  ): boolean {
  ```

  Nella riga dove viene chiamata `this.evaluate(...)` (circa riga 130):

  ```ts
  // Prima:
  const candidates = this.evaluate(beliefs, movementDurationMs, tracker);

  // Dopo:
  const candidates = precomputedCandidates ?? this.evaluate(beliefs, movementDurationMs, tracker);
  ```

- [ ] **Step 2.4 — Verifica che i test passino**

  ```bash
  tsx --test src/deliberation/deliberator.edge.test.ts 2>&1 | tail -10
  ```

  Atteso: tutti i test `pass`.

- [ ] **Step 2.5 — Run tutti i test del deliberator per regressioni**

  ```bash
  tsx --test src/deliberation/deliberator.test.ts src/deliberation/deliberator.domain.test.ts src/deliberation/deliberator.edge.test.ts 2>&1 | tail -15
  ```

  Atteso: tutti pass.

- [ ] **Step 2.6 — Commit**

  ```bash
  git add src/deliberation/deliberator.ts src/deliberation/deliberator.edge.test.ts
  git commit -m "feat(deliberator): accept precomputed candidates in shouldReplan to avoid double evaluate()

  Adds optional precomputedCandidates parameter so callers can pass already-computed
  intentions instead of triggering a second evaluate() call inside shouldReplan.
  Backward-compatible: falls back to internal evaluate() when not provided.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 3 — Gate strutturale in `_deliberateAndPlan` + singola `evaluate()`

**Files:**
- Modify: `src/agents/base-agent.ts`

**Contesto:** Attualmente `_scheduleDeliberation()` viene chiamata ad ogni sensing event di parcelle (~50ms). Con il gate, si salta l'intera valutazione quando: (a) non è un piano fallito, (b) l'executor sta eseguendo, (c) c'è un'intenzione attiva, (d) né il set di parcelle né la posizione sono cambiati dall'ultima valutazione.

Allo stesso tempo, si rimuove la seconda `evaluate()` usando i candidates già calcolati.

Il fingerprint di parcelle è una stringa `"id:carriedBy|id:carriedBy|..."` ordinata. Se cambia → qualcosa di strutturale è accaduto (pacco apparso, sparito, rubato).

- [ ] **Step 3.1 — Aggiungi i campi di stato privati alla classe `BaseAgent`**

  Nella sezione `// State` dei campi privati (vicino a `private planning = false`):

  ```ts
  private lastParcelFingerprint = '';
  private lastRevaluatedPosition: Position = { x: -1, y: -1 };
  ```

- [ ] **Step 3.2 — Aggiungi il metodo `_computeParcelFingerprint` alla classe**

  Aggiungi dopo `_scheduleDeliberation`:

  ```ts
  private _computeParcelFingerprint(): string {
    const parcels = this.beliefs!.getParcelBeliefs();
    return parcels
      .map(p => `${p.id}:${p.carriedBy ?? ''}`)
      .sort()
      .join('|');
  }
  ```

- [ ] **Step 3.3 — Sostituisci il blocco critico in `_deliberateAndPlan`**

  Il blocco da sostituire inizia a `const movementDurationMs` e arriva fino alla fine del blocco candidates (riga ~391). Sostituisci questo blocco:

  ```ts
  // PRIMA (righe ~337-391):
  const movementDurationMs = this.client.getMeasuredActionDurationMs();
  const tracker = this.beliefs.getParcelTracker();

  const shouldReplan = this.deliberator.shouldReplan(
    this.currentIntention,
    this.beliefs,
    planFailed,
    movementDurationMs,
    tracker,
  );
  const needsReplan = planFailed || shouldReplan || this.executor.isIdle();

  if (!needsReplan) return;

  // Cancel current plan if replan is warranted
  if (this.currentIntention !== null && (planFailed || shouldReplan)) {
    this.executor.cancelCurrentPlan();
    this.log.info({
      kind: "replan_triggered",
      reason: planFailed ? "plan_failed" : "better_option_or_target_gone",
    });
    this.log.info({
      kind: "intention_dropped",
      intentionId: this.currentIntention.id,
      reason: planFailed ? "plan_failed" : "superseded",
    });
    this.currentIntention = null;
  }

  const self = this.beliefs.getSelf();

  // If at capacity, skip deliberation and deliver immediately
  if (self.carriedParcels.length >= this.beliefs.getCapacity()) {
    await this._planDelivery();
    return;
  }

  // If carrying parcels and no reachable ground parcels → deliver what we have
  if (self.carriedParcels.length > 0) {
    const reachable = this.beliefs.getReachableParcels();
    if (reachable.length === 0) {
      await this._planDelivery();
      return;
    }
  }

  // Deliberate: select best intention, excluding parcels claimed by allies
  const claimedByOthers =
    this.allyTracker?.getClaimedByOthers() ?? new Set<string>();
  const candidates = this.deliberator
    .evaluate(this.beliefs, movementDurationMs, tracker)
    .filter(
      (intention) =>
        !intention.targetParcels.some((id) => claimedByOthers.has(id)),
    );
  ```

  Con questo blocco (DOPO):

  ```ts
  const movementDurationMs = this.client.getMeasuredActionDurationMs();
  const tracker = this.beliefs.getParcelTracker();

  // Structural gate: skip full re-evaluation when parcel set and position are
  // unchanged — utility ranking is stable with uniform decay (gap is constant).
  // Bypassed when: planFailed, executor idle, or no active intention.
  if (!planFailed && !this.executor.isIdle() && this.currentIntention !== null) {
    const fingerprint = this._computeParcelFingerprint();
    const currentPos = this.beliefs.getSelf().position;
    const unchanged = fingerprint === this.lastParcelFingerprint
      && positionEquals(currentPos, this.lastRevaluatedPosition);
    this.lastParcelFingerprint = fingerprint;
    this.lastRevaluatedPosition = currentPos;
    if (unchanged) return;
  }

  // Compute candidates once — passed to shouldReplan to avoid a second evaluate().
  const claimedByOthers =
    this.allyTracker?.getClaimedByOthers() ?? new Set<string>();
  const candidates = this.deliberator
    .evaluate(this.beliefs, movementDurationMs, tracker)
    .filter(i => !i.targetParcels.some(id => claimedByOthers.has(id)));

  const shouldReplan = this.deliberator.shouldReplan(
    this.currentIntention,
    this.beliefs,
    planFailed,
    movementDurationMs,
    tracker,
    candidates,
  );
  const needsReplan = planFailed || shouldReplan || this.executor.isIdle();

  if (!needsReplan) return;

  // Cancel current plan if replan is warranted
  if (this.currentIntention !== null && (planFailed || shouldReplan)) {
    this.executor.cancelCurrentPlan();
    this.log.info({
      kind: "replan_triggered",
      reason: planFailed ? "plan_failed" : "better_option_or_target_gone",
    });
    this.log.info({
      kind: "intention_dropped",
      intentionId: this.currentIntention.id,
      reason: planFailed ? "plan_failed" : "superseded",
    });
    this.currentIntention = null;
  }

  const self = this.beliefs.getSelf();

  // If at capacity, skip deliberation and deliver immediately
  if (self.carriedParcels.length >= this.beliefs.getCapacity()) {
    await this._planDelivery();
    return;
  }

  // If carrying parcels and no reachable ground parcels → deliver what we have
  if (self.carriedParcels.length > 0) {
    const reachable = this.beliefs.getReachableParcels();
    if (reachable.length === 0) {
      await this._planDelivery();
      return;
    }
  }

  // candidates already computed above — no second evaluate() needed
  ```

- [ ] **Step 3.4 — Build TypeScript**

  ```bash
  npm run build 2>&1 | grep -E "error|Error" | head -20
  ```

  Atteso: nessun output.

- [ ] **Step 3.5 — Run tutti i test**

  ```bash
  npm test 2>&1 | tail -30
  ```

  Atteso: tutti i test esistenti passano, zero regressioni.

- [ ] **Step 3.6 — Commit**

  ```bash
  git add src/agents/base-agent.ts
  git commit -m "perf(base-agent): skip evaluate() when parcel set and position unchanged

  Adds a structural gate in _deliberateAndPlan: if the parcel fingerprint
  (IDs + carriedBy) and self position haven't changed since the last evaluation,
  the full deliberation cycle is skipped. With uniform decay the utility ranking
  is stable between moves, so re-evaluating every 50ms sensing frame is redundant.

  Also eliminates the double evaluate() by computing candidates once and passing
  them to shouldReplan via the new precomputedCandidates parameter.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Self-review del piano

**Spec coverage:**
- ✅ Fix tracker decay da config server (Task 1)
- ✅ Eliminare doppio evaluate (Task 2 + Task 3)
- ✅ Gate strutturale per skip re-evaluation (Task 3)
- ✅ Max profitable distance filter — **non incluso**: il filtro è già implicito in `estimateRewardAt` che ritorna 0, producendo utility=0. Il sorting già esclude questi candidati. Aggiunto complessità senza beneficio misurabile.

**Placeholder scan:** nessuno. Tutti gli step hanno codice completo.

**Type consistency:**
- `precomputedCandidates?: Intention[]` — `Intention` è il tipo già usato nel file.
- `lastParcelFingerprint: string`, `lastRevaluatedPosition: Position` — tipi base.
- `_computeParcelFingerprint(): string` — coerente con campo.
- Tutti i metodi chiamati (`getParcelBeliefs`, `getParcelTracker`, `setBaseDecayRate`) definiti nei task precedenti o già esistenti.

**Rischi:**
- Il gate usa `getParcelBeliefs()` che include parcelle stale/con reward=0. Questo è corretto: vogliamo rilevare la sparizione di qualsiasi parcella, non solo quelle attive.
- `lastRevaluatedPosition` inizializzata a `{x:-1, y:-1}`: prima chiamata rileva sempre position change → prima deliberazione sempre eseguita. ✓
