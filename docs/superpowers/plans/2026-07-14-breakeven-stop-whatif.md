# Move-Stop-to-Breakeven What-if Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Move stop to breakeven" what-if curve that, for each profit trigger, measures the R impact of pulling the stop to entry once a trade got that far into profit and later retraced to entry.

**Architecture:** The scenario is path-dependent, so per-trade arm/fire facts are computed in the candle-replay path (`enrich_trades_whatif`) and stamped on `trade.whatif["breakeven_stop"]`. `compute_whatif` aggregates those stamps into a `breakeven_curve` list (one row per trigger level) using each trade's realized R. The frontend renders one more table + one readout bullet in the existing What-if section.

**Tech Stack:** Python (pytest) backend engine; React + TypeScript (vitest + Testing Library) frontend.

## Global Constraints

- No em dash and no "--" as punctuation anywhere (code, comments, copy, tests). Rephrase with colon, comma, or period.
- Reuse the shared `InfoTip` component (`frontend/src/components/InfoTip.tsx`), never a native `title=`.
- Frontend typecheck must stay green: `npx tsc -b` shows pre-existing errors only, zero new.
- Trigger levels are exactly `BE_TRIGGER_RS = [0.5, 1.0, 1.5, 2.0, 3.0]`, stop always to exact breakeven (0R).
- Do not touch the unrelated uncommitted files: `frontend/src/BacktestSettingsModal.tsx`, `frontend/src/lib/backtestSchedule.ts`, `frontend/src/lib/backtestSchedule.test.ts`.
- All Python money math already uses each trade's `risk = abs(entry_price - stop_initial)`; reuse it, do not invent a new risk basis.

---

### Task 1: Replay helper `_breakeven_stop` + per-trade stamp

**Files:**
- Modify: `backend/auto_trader/engine/whatif.py`
- Test: `backend/tests/test_whatif_enrich.py`

**Interfaces:**
- Consumes: `Candle`, `Trade`, module-level `REPLAY_HORIZON` (unused here), existing `_signed_r`.
- Produces:
  - Module constant `BE_TRIGGER_RS = [0.5, 1.0, 1.5, 2.0, 3.0]`.
  - `_breakeven_stop(trade: Trade, candles: list[Candle], entry_i: int, exit_i: int, risk: float, leg: str) -> list[dict]` returning, per level in `BE_TRIGGER_RS` order, `{"frac": float, "armed": bool, "fired": bool}`.
  - New key `trade.whatif["breakeven_stop"]` set by `enrich_trades_whatif`: the list above when `entry_i` and `exit_i` are both found, else `None`; and `None` in the `risk <= 0` ineligible branch.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_whatif_enrich.py`:

```python
def test_breakeven_never_arms():
    # Long from 100, risk 5 (stop 95). Price never reaches +0.5R (=102.5),
    # so no level arms.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 101, 99, 100),   # 1 entry at open 100
        (100, 101, 99, 100),   # 2
        (100, 101, 99, 100),   # 3 exit
    ])
    t = _trade(1, 3, exit_=100.0, stop_initial=95.0, target=110.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert all(not r["armed"] and not r["fired"] for r in be.values())


def test_breakeven_arms_then_returns_fires():
    # Long from 100, risk 5. Bar2 runs to 108 (mfe +1.6R), bar3 drops back to
    # entry 100 then exits at 99. Every trigger <= 1.5R arms; all armed levels
    # fire because price returns to entry after the peak.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 101, 99, 100),   # 1 entry at 100
        (101, 108, 100, 107),  # 2 peak 108
        (107, 107, 99, 99),    # 3 drops through entry 100, exits 99
    ])
    t = _trade(1, 3, exit_=99.0, stop_initial=95.0, target=110.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert be[0.5]["armed"] and be[0.5]["fired"]
    assert be[1.0]["armed"] and be[1.0]["fired"]
    assert be[1.5]["armed"] and be[1.5]["fired"]
    assert not be[2.0]["armed"]  # peak 108 = +1.6R, below +2R (=110)


def test_breakeven_arms_and_runs_no_fire():
    # Long from 100, risk 5. Monotonic climb to a 110 target, never revisits
    # entry: armed levels do NOT fire.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 103, 100, 102),  # 1 entry at 100
        (102, 106, 102, 105),  # 2 +1R reached (105)
        (105, 111, 105, 110),  # 3 target 110, low never back to 100
    ])
    t = _trade(1, 3, exit_=110.0, stop_initial=95.0, target=110.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert be[0.5]["armed"] and not be[0.5]["fired"]
    assert be[1.0]["armed"] and not be[1.0]["fired"]


def test_breakeven_short_arms_then_returns_fires():
    # Short from 100, risk 4 (stop 104). Bar2 drops to 94 (mfe +1.5R), bar3
    # rallies back through entry 100 and exits 101.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 101, 99, 100),   # 1 short entry at 100
        (99, 100, 94, 95),     # 2 favorable to 94
        (95, 101, 95, 101),    # 3 rallies through entry, exits 101
    ])
    t = _trade(1, 3, exit_=101.0, leg="short", stop_initial=104.0,
               stop_final=104.0, target=90.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert be[0.5]["armed"] and be[0.5]["fired"]
    assert be[1.0]["armed"] and be[1.0]["fired"]
    assert be[1.5]["armed"] and be[1.5]["fired"]


def test_breakeven_per_trigger_divergence():
    # Long from 100, risk 5. Early dip fires the 0.5 level; a later higher peak
    # arms 1.5 AFTER the dip and never returns to entry, so 1.5 does not fire.
    candles = _mk([
        (100, 101, 99, 100),   # 0 signal
        (100, 103, 100, 102),  # 1 entry 100; hits +0.5R (102.5)? high 103 -> arms 0.5
        (102, 102, 100, 100),  # 2 back to entry 100 -> 0.5 fires here
        (100, 109, 100, 108),  # 3 climbs to 108 -> arms 1.5 (>=107.5), low 100 not below entry
        (108, 111, 107, 110),  # 4 exit at target 110, low 107 never back to 100
    ])
    t = _trade(1, 4, exit_=110.0, stop_initial=95.0, target=110.0)
    enrich_trades_whatif([t], candles)
    be = {r["frac"]: r for r in t.whatif["breakeven_stop"]}
    assert be[0.5]["armed"] and be[0.5]["fired"]
    assert be[1.5]["armed"] and not be[1.5]["fired"]


def test_breakeven_ineligible_no_stop_initial():
    candles = _mk([(100, 101, 99, 100), (100, 108, 99, 107)])
    t = _trade(1, 1, exit_=107.0, stop_initial=None, stop_final=None)
    enrich_trades_whatif([t], candles)
    assert t.whatif["breakeven_stop"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_whatif_enrich.py -k breakeven -v`
Expected: FAIL. Either `KeyError: 'breakeven_stop'` (key not stamped) or `TypeError`/`AttributeError` from the missing function.

- [ ] **Step 3: Implement the helper and stamp**

In `backend/auto_trader/engine/whatif.py`, add the constant near the other curve constants (after `TARGET_CURVE_RS`):

```python
BE_TRIGGER_RS = [0.5, 1.0, 1.5, 2.0, 3.0]
```

Add the helper (place it after `_limit_entry`, before `enrich_trades_whatif`):

```python
def _breakeven_stop(trade: Trade, candles, entry_i: int, exit_i: int,
                    risk: float, leg: str) -> list[dict]:
    """Per profit trigger, whether a breakeven-stop overlay would arm (price
    first reaches entry +/- frac*risk within [entry_i, exit_i]) and then fire
    (a LATER bar in that span retraces to the entry price). Bar high/low
    touches; firing strictly after the arming bar avoids same-bar lookahead."""
    entry = trade.entry_price
    end = min(len(candles) - 1, exit_i)
    rows = []
    for frac in BE_TRIGGER_RS:
        trigger = entry + frac * risk if leg == "long" else entry - frac * risk
        arm_i = None
        for i in range(max(entry_i, 0), end + 1):
            bar = candles[i]
            reached = bar.high >= trigger if leg == "long" else bar.low <= trigger
            if reached:
                arm_i = i
                break
        fired = False
        if arm_i is not None:
            for j in range(arm_i + 1, end + 1):
                bar = candles[j]
                back = bar.low <= entry if leg == "long" else bar.high >= entry
                if back:
                    fired = True
                    break
        rows.append({"frac": frac, "armed": arm_i is not None, "fired": fired})
    return rows
```

In the `risk <= 0` ineligible branch of `enrich_trades_whatif`, add the key:

```python
        if risk <= 0:
            trade.whatif = {"rule_exit": None, "no_target": None,
                            "fill_delay_r": None, "limit_entry": None,
                            "breakeven_stop": None}
            continue
```

In the main `trade.whatif = {...}` dict, add:

```python
            "breakeven_stop": (
                _breakeven_stop(trade, candles, entry_i, exit_i, risk, trade.leg)
                if entry_i is not None and exit_i is not None else None),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_whatif_enrich.py -k breakeven -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full enrich file to check nothing regressed**

Run: `cd backend && python -m pytest tests/test_whatif_enrich.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/engine/whatif.py backend/tests/test_whatif_enrich.py
git commit -m "feat(whatif): per-trade breakeven-stop arm/fire replay stamp"
```

---

### Task 2: Aggregate `breakeven_curve` in `compute_whatif`

**Files:**
- Modify: `backend/auto_trader/engine/whatif.py`
- Test: `backend/tests/test_whatif_aggregate.py`

**Interfaces:**
- Consumes: per-trade `whatif["breakeven_stop"]` rows from Task 1; existing `_realized_r`, `_round4`, `BE_TRIGGER_RS`.
- Produces: `compute_whatif(...)` return dict gains key `"breakeven_curve"`, a list (one dict per `BE_TRIGGER_RS` level) or `None`. Each row:
  `{"frac": float, "n_armed": int, "n_fired": int, "losers_rescued": int, "winners_cut": int, "net_delta_r": float}`.
  `net_delta_r = _round4(sum(-realized_r for fired trades at that level))`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_whatif_aggregate.py`:

```python
def _be(frac_flags):
    # frac_flags: {frac: (armed, fired)} -> the stamp list for one trade.
    return [{"frac": f, "armed": a, "fired": fi} for f, (a, fi) in frac_flags.items()]


def test_breakeven_curve_none_when_no_stamps():
    out = compute_whatif([_t(1.0), _t(-1.0)])
    assert out["breakeven_curve"] is None


def test_breakeven_curve_rescues_and_cuts():
    # Loser: realized -1R, fires at 0.5 -> rescued, delta +1.
    loser = _t(-5.0, stop=95.0, whatif={
        "breakeven_stop": _be({0.5: (True, True), 1.0: (False, False),
                               1.5: (False, False), 2.0: (False, False),
                               3.0: (False, False)})})
    # Winner: realized +2R (exit 110), armed+fired at 0.5 -> cut, delta -2.
    winner = _t(10.0, exit_=110.0, stop=95.0, whatif={
        "breakeven_stop": _be({0.5: (True, True), 1.0: (True, False),
                               1.5: (True, False), 2.0: (True, False),
                               3.0: (False, False)})})
    curve = compute_whatif([loser, winner])["breakeven_curve"]
    row = {r["frac"]: r for r in curve}
    assert row[0.5]["n_armed"] == 2 and row[0.5]["n_fired"] == 2
    assert row[0.5]["losers_rescued"] == 1 and row[0.5]["winners_cut"] == 1
    # net = (+1) + (-2) = -1
    assert row[0.5]["net_delta_r"] == -1.0
    # At 1.0 only the winner armed, and it did not fire.
    assert row[1.0]["n_armed"] == 1 and row[1.0]["n_fired"] == 0
    assert row[1.0]["net_delta_r"] == 0.0


def test_breakeven_curve_skips_ineligible_stamp():
    # A trade with breakeven_stop None must not appear in any count.
    good = _t(-5.0, stop=95.0, whatif={
        "breakeven_stop": _be({0.5: (True, True), 1.0: (False, False),
                               1.5: (False, False), 2.0: (False, False),
                               3.0: (False, False)})})
    bad = _t(-5.0, stop=95.0, whatif={"breakeven_stop": None})
    row = {r["frac"]: r for r in compute_whatif([good, bad])["breakeven_curve"]}
    assert row[0.5]["n_armed"] == 1 and row[0.5]["n_fired"] == 1
```

Also extend the existing `test_all_none_when_nothing_enriched` assertion to include the new key:

```python
def test_all_none_when_nothing_enriched():
    out = compute_whatif([_t(1.0), _t(-1.0)])
    assert out == {"rule_exit": None, "no_target": None, "stop_curve": None,
                   "target_curve": None, "fill_delay": None, "limit_entry": None,
                   "breakeven_curve": None}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_whatif_aggregate.py -k breakeven -v`
Expected: FAIL with `KeyError: 'breakeven_curve'` (key absent from the return dict).

- [ ] **Step 3: Implement section G**

In `compute_whatif`, after section F (limit_entry) and before the `return`, add:

```python
    # G: breakeven-stop overlay curve from per-trade arm/fire stamps + realized R.
    be_rows = [(t.get("whatif") or {}).get("breakeven_stop") for t in trades]
    be_pairs = [(rows, _realized_r(t)) for t, rows in zip(trades, be_rows)
                if rows is not None and _realized_r(t) is not None]
    breakeven_curve = None
    if be_pairs:
        breakeven_curve = []
        for k, frac in enumerate(BE_TRIGGER_RS):
            armed = [(rows[k], r) for rows, r in be_pairs if rows[k]["armed"]]
            fired = [(cell, r) for cell, r in armed if cell["fired"]]
            breakeven_curve.append({
                "frac": frac,
                "n_armed": len(armed),
                "n_fired": len(fired),
                "losers_rescued": sum(1 for _, r in fired if r < 0),
                "winners_cut": sum(1 for _, r in fired if r > 0),
                "net_delta_r": _round4(sum(-r for _, r in fired)),
            })
```

Update the return dict:

```python
    return {"rule_exit": rule_exit, "no_target": no_target,
            "stop_curve": stop_curve, "target_curve": target_curve,
            "fill_delay": fill_delay, "limit_entry": limit_entry,
            "breakeven_curve": breakeven_curve}
```

Note: `be_pairs` indexes `rows[k]` by position, which is safe because Task 1 always emits exactly the `BE_TRIGGER_RS` levels in order.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_whatif_aggregate.py -k breakeven -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole whatif backend suite**

Run: `cd backend && python -m pytest tests/test_whatif_aggregate.py tests/test_whatif_enrich.py tests/test_whatif_replay.py tests/test_api_backtest_analysis.py -v`
Expected: all PASS (the amended `test_all_none_when_nothing_enriched` now includes `breakeven_curve`).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/engine/whatif.py backend/tests/test_whatif_aggregate.py
git commit -m "feat(whatif): aggregate breakeven_curve section"
```

---

### Task 3: Frontend type + rendering + readout bullet

**Files:**
- Modify: `frontend/src/api.ts:145-170` (add `breakeven_curve` to `BacktestWhatif`)
- Modify: `frontend/src/BacktestAnalysisPanel.tsx` (`whatifHasContent`, `WhatIfSection` destructures + bullet + table)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: `breakeven_curve` rows from Task 2.
- Produces: table "Move stop to breakeven"; a 1R readout bullet; `breakeven_curve` participates in `whatifHasContent`.

- [ ] **Step 1: Add the TS type**

In `frontend/src/api.ts`, inside `interface BacktestWhatif`, after the `limit_entry: {...} | null;` block, add:

```ts
  breakeven_curve:
    | {
        frac: number;
        n_armed: number;
        n_fired: number;
        losers_rescued: number;
        winners_cut: number;
        net_delta_r: number;
      }[]
    | null;
```

- [ ] **Step 2: Write the failing frontend tests**

In `frontend/src/BacktestAnalysisPanel.test.tsx`, add `breakeven_curve` to the shared `analysis.whatif` fixture (inside the `whatif: { ... }` object, alongside `stop_curve`/`target_curve`):

```ts
    breakeven_curve: [
      { frac: 0.5, n_armed: 40, n_fired: 12, losers_rescued: 9, winners_cut: 3, net_delta_r: 6.2 },
      { frac: 1.0, n_armed: 30, n_fired: 8, losers_rescued: 6, winners_cut: 2, net_delta_r: 4.1 },
      { frac: 1.5, n_armed: 20, n_fired: 4, losers_rescued: 3, winners_cut: 1, net_delta_r: 2.0 },
      { frac: 2.0, n_armed: 10, n_fired: 2, losers_rescued: 1, winners_cut: 1, net_delta_r: 0.5 },
      { frac: 3.0, n_armed: 4, n_fired: 1, losers_rescued: 1, winners_cut: 0, net_delta_r: 0.9 },
    ],
```

Add two tests at the end of the file (before the final closing `});` of the describe block):

```ts
  it("renders the breakeven-stop table and a positive 1R readout bullet", () => {
    render(<BacktestAnalysisPanel analysis={analysis} />);
    showTab("What-if");
    expect(screen.getByText(/Move stop to breakeven/i)).toBeTruthy();
    expect(
      screen.getByText(
        /Moving the stop to breakeven once a trade was 1R in profit would have saved 4\.1R net across 8 trades/i,
      ),
    ).toBeTruthy();
  });

  it("phrases a net-negative breakeven 1R row as a cost", () => {
    const neg: BacktestAnalysis = {
      ...analysis,
      whatif: {
        ...(analysis.whatif as BacktestWhatif),
        breakeven_curve: [
          { frac: 0.5, n_armed: 40, n_fired: 12, losers_rescued: 3, winners_cut: 9, net_delta_r: -6.2 },
          { frac: 1.0, n_armed: 30, n_fired: 8, losers_rescued: 2, winners_cut: 6, net_delta_r: -4.1 },
          { frac: 1.5, n_armed: 20, n_fired: 4, losers_rescued: 1, winners_cut: 3, net_delta_r: -2.0 },
          { frac: 2.0, n_armed: 10, n_fired: 2, losers_rescued: 1, winners_cut: 1, net_delta_r: 0.0 },
          { frac: 3.0, n_armed: 4, n_fired: 0, losers_rescued: 0, winners_cut: 0, net_delta_r: 0.0 },
        ],
      },
    };
    render(<BacktestAnalysisPanel analysis={neg} />);
    showTab("What-if");
    expect(
      screen.getByText(/Moving the stop to breakeven once a trade was 1R in profit would have cost 4\.1R net/i),
    ).toBeTruthy();
  });

  it("omits the breakeven section when the curve is absent (older runs)", () => {
    const noBe: BacktestAnalysis = {
      ...analysis,
      whatif: { ...(analysis.whatif as BacktestWhatif), breakeven_curve: null },
    };
    render(<BacktestAnalysisPanel analysis={noBe} />);
    showTab("What-if");
    expect(screen.queryByText(/Move stop to breakeven/i)).toBeNull();
    // The tab is still visible because other scenarios remain.
    expect(screen.getByText(/What if/i)).toBeTruthy();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: FAIL. The new "Move stop to breakeven" text is not found; the negative-cost bullet is not found.

- [ ] **Step 4: Wire `whatifHasContent`**

In `frontend/src/BacktestAnalysisPanel.tsx`, update both the guard and the two destructures to include `breakeven_curve`:

```ts
function whatifHasContent(whatif: BacktestWhatif | null | undefined): boolean {
  if (!whatif) return false;
  const { rule_exit, no_target, stop_curve, target_curve, fill_delay, limit_entry, breakeven_curve } =
    whatif;
  return Boolean(
    rule_exit || no_target || stop_curve || target_curve || fill_delay || limit_entry || breakeven_curve,
  );
}
```

And in `WhatIfSection`, change the destructure line:

```ts
  const { rule_exit, no_target, stop_curve, target_curve, fill_delay, limit_entry, breakeven_curve } =
    whatif!;
```

- [ ] **Step 5: Add the 1R readout bullet**

In `WhatIfSection`, after the `if (limit_entry) { ... }` block and before `return (`, add:

```ts
  if (breakeven_curve) {
    const oneR = breakeven_curve.find((r) => r.frac === 1.0);
    if (oneR && oneR.n_fired > 0) {
      const verb = oneR.net_delta_r >= 0 ? "saved" : "cost";
      bullets.push(
        `Moving the stop to breakeven once a trade was 1R in profit would have ${verb} ${fmtR(
          Math.abs(oneR.net_delta_r),
        )} net across ${oneR.n_fired} trades that came back to entry.`,
      );
    }
  }
```

- [ ] **Step 6: Add the table**

In `WhatIfSection`, extend the curve-tables gate and add the third table. Change the gate:

```tsx
      {!collapsed && (stop_curve || target_curve || breakeven_curve) && (
```

Then, after the closing `)}` of the `{target_curve && ( ... )}` block and before the `</div>` that closes `bt-analysis-dists`, add:

```tsx
        {breakeven_curve && (
          <div className="bt-analysis-dist">
            <div className="bt-analysis-dist-label">
              Move stop to breakeven
              <InfoTip
                title="Move stop to breakeven"
                text="Outcome if the stop moved to entry once a trade reached each profit trigger: a trade that then retraced to entry exits flat, so a real loser is rescued and a real winner is cut to zero; trades that ran away untouched keep their result. R of the full position, live runs only."
              />
            </div>
            <table className="bt-analysis-table">
              <thead>
                <tr><th>Trigger</th><th>Armed</th><th>Rescued</th><th>Cut</th><th>Net R</th></tr>
              </thead>
              <tbody>
                {breakeven_curve.map((r) => (
                  <tr key={r.frac}>
                    <td>+{r.frac}R</td>
                    <td>{r.n_armed}</td>
                    <td>{r.losers_rescued}</td>
                    <td>{r.winners_cut}</td>
                    <td>{r.net_delta_r.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: all PASS, including the three new tests.

- [ ] **Step 8: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: only pre-existing errors, zero new ones referencing `breakeven_curve`, `BacktestAnalysisPanel.tsx`, or `api.ts`.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/api.ts frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx
git commit -m "feat(whatif): move-stop-to-breakeven table and readout in the What-if tab"
```

---

## Self-Review Notes

- **Spec coverage:** semantics + `BE_TRIGGER_RS` (Task 1), replay arm/fire with strict-after-arming and high/low touches (Task 1 helper), ineligible -> None (Task 1 tests), `breakeven_curve` row shape + None-when-empty + `net_delta_r = sum(-realized_r)` (Task 2), per-trigger divergence (Task 1 test), frontend table + 1R sign-branched bullet + `whatifHasContent` + absent-curve invisibility (Task 3). All covered.
- **Section-letter coordination:** the partial-close spec (unimplemented) plans sections G/H; this plan labels its comment "G" only because those are not yet in the file. If partial-close lands first, relabel this comment to the next free letter at implementation time. The dict key `breakeven_curve` is the real contract and does not collide.
- **Trigger cell renders `+{frac}R`** (e.g. "+2R"), deliberately distinct from the target-placement curve's plain "2R" cell, so the existing test's `within(whatIf).getByText("2R")` uniqueness assertion (line 126) still passes. Do not change it to plain "{frac}R".
- **Type consistency:** backend row keys (`frac`, `n_armed`, `n_fired`, `losers_rescued`, `winners_cut`, `net_delta_r`) match the TS interface and the table/bullet reads exactly. The per-trade stamp keys (`frac`, `armed`, `fired`) are consistent between Task 1's helper and Task 2's aggregation.
