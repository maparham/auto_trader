# Backend-owned rule series + rule-based parameter sweeping

**Date:** 2026-07-10
**Status:** Design — awaiting review

## Goal

Add parameter sweeping to the rule-based backtest, the way coded strategies
already have it. Deliver it on top of the governing principle that **business-logic
computation belongs on the backend** — the browser should render, not compute rule
series.

Concretely, this spec covers two things as one cohesive change:

1. **Backend recomputes rule series for the single-run backtest.** The browser stops
   sending precomputed native-indicator arrays; the backend rebuilds them from the
   candles it already receives.
2. **Rule-based parameter sweeping**, which rides on step 1: once the backend
   assembles series from a rule config, a sweep is a loop over combos that patches
   the config, recomputes, and collects metrics.

## Why this ordering

Sweeping is *small because* the backend already recomputes. Building the eager
series-assembler (step 1) is the hard part and is independently verifiable — its
single-run results must match today's browser-computed results. The sweep then
reuses the assembler, the existing generic frontend sweep loop, chunking, and
heatmap.

## Non-goals

- **Live-trading migration.** `RuleStrategy` reads a `series` dict regardless of who
  fills it. This spec only changes *who populates it in the router* (backend
  assembler vs. `req.series`). Live keeps populating it browser-side until its own
  later migration. That localization is what makes excluding live coherent rather
  than a loose end. See [[live-trading-engine]].
- **Sweeping exotic indicators.** LR, PREV_HL, pivot bands, RSI-divergence are *not*
  native `indicator` operands — `IndicatorKind = EMA | SMA | AVWAP | RSI | VOL |
  VOLMA` (`backtestConfig.ts:6`). They enter rules only as chart-operand recipes
  (`kind:"series"`), which are frozen snapshots with no exposed parameter — nothing
  to sweep, regardless of where compute lives. Porting them buys nothing here.
- **Recomputing chart-operand / drawing series on the backend.** These depend on live
  chart state (indicator `extendData`, chart timezone, drawing anchors) that only
  exists in the browser. They are rendering-adjacent state, not business logic, so
  they stay browser-supplied — the one legitimate exception to the principle. See
  [[chart-operands-in-rules]], [[backend-owns-business-logic]].
- **A performance win.** `offload-compute-to-node` measured the slowness as cold
  candle backfill, not compute. This is an architecture-cleanliness change; it is not
  expected to make backtests faster.

## The sweepable surface

- **Native indicators** — EMA, SMA, RSI, AVWAP, VOL, VOLMA — over their `length`,
  per-operand `timeframe` (`@tf`), and `slope` window (`~len`). All six already have
  parity-tested Python leaf implementations in `backend/auto_trader/indicators/`.
- **Const operand thresholds** — the number in a comparison (`kind:"const"`).
- **Exit rule counts** — "fire on the Nth occurrence."
- **Risk stop/target values and mults** — already patchable via the existing
  `_apply_combo` risk grammar (`backtest.py:307`).

Chart-operand and drawing series are *not* sweepable; they are shipped once and held
fixed across all combos.

## Architecture

### 1. Backend eager series-assembler (new)

A new module that takes a rule config (the four rule groups + risk specs) plus base
candles and produces the `series` dict `RuleStrategy` consumes — the Python
equivalent of the frontend `buildSeries` (`frontend/src/lib/backtestSeries.ts`).

Responsibilities:

- Walk the four rule groups (+ risk ATR specs); collect every operand with a
  non-null `series_name(op)` (`rule.py:60`).
- **Dedup by `series_name`** — compute each distinct key once (memoize). This is the
  union-map efficiency, now living server-side: a 48-combo EMA×RSI sweep computes ~14
  distinct series, not 48× the full set.
- For base-timeframe operands, compute directly from candles using the existing leaf
  functions (`indicators/core.py`, `mtf.py`).
- For `@tf` operands, fetch higher-timeframe candles and forward-fill via
  `align_htf_to_base` (`mtf.py:13`). Reuse the coded path's HTF-fetch plumbing
  (`NeedTimeframe` + the candle cache, [[candle-cache]]) rather than inventing a new
  fetch path.
- Apply `slope` on native-TF values **before** forward-fill (the frontend ordering;
  `slope_of`, `mtf.py:36`). See [[slope-conditions]] for the slope-before-forward-fill
  trap.
- Respect indicator warmup so early bars match the frontend.

**Reuse vs. new:** the *leaf math* and HTF fetch exist and are reusable. The coded
`ctx` computes them lazily, one value per `on_bar` call, per-instance cached
(`coded.py:198`). The rule path needs an **eager, full-array** assembly walked from a
static config — a different shape. So this assembler is new orchestration code over
reused leaves.

### 2. Validation contract inverts, per operand kind

Today the router asserts every referenced operand's key is **present** in
`req.series` (`backtest.py:137–194`). After step 1 the contract splits by kind:

- **Native indicator / price-slope keys** → must now be **absent** from the request
  (the backend computes them). If the browser still sends one, either ignore it or
  reject — but define it: on a collision between a shipped key and a recomputed key,
  the **recomputed value wins**, so the two can never silently diverge. Whether we
  additionally hard-reject the request on a stale shipped native key, or just ignore
  it, is settled in planning (see Open questions).
- **Chart-operand / drawing (`kind:"series"`) keys** → must still be **present**
  (browser-shipped). Validate presence and length exactly as today.

This per-kind branch is the single most bug-prone spot; it gets explicit tests.

### 3. Sweep endpoint

Generalize the existing coded-only `/api/backtest/sweep`:

- Drop the `if req.codedStrategy is None: raise 422` guard.
- Extract a `_run_rule(...)` helper from the inline single-run logic
  (`backtest.py:155–298`) so both the single-run route and the sweep loop call it.
- Add `_apply_rule_combo(req, combo)` mirroring `_apply_combo`: patch the rule tree /
  risk DTO by target path for each combo, then run the assembler + `_run_rule`.
- Per-combo error isolation and chunking already exist and are strategy-agnostic
  (`backtest.py:335–384`) — reused unchanged.

### 4. Sweep target-path grammar

Coded sweeps target named `params`; rule strategies have no param schema, so targets
are **paths into the rule tree / risk DTO**:

- `long.entry.0.left.length` — first long-entry rule, left operand, indicator length
- `long.entry.0.left.value` — a const operand's threshold
- `long.exit.1.count` — second long-exit rule's Nth-occurrence count
- `long.stop.value`, `short.target.mult` — risk paths (existing grammar)

The backend parses and validates the path; an unresolvable path 422s the chunk (as an
undeclared coded param does today).

### 5. Frontend axis picker (new UI)

Because there is no `params` list to pick from, sweep axes need a discoverable picker
that lets the user point at a specific operand's numeric field and give it a
from/to/step range. This is genuine new frontend work, not covered by the generic
sweep loop. It emits the target-path grammar above into the existing
`SweepAxis`/`enumerateCombos` machinery (`lib/sweep.ts`), which is otherwise unchanged.
Reuse existing shared components for the picker and range inputs ([[reuse-shared-components]]).

**Reused unchanged:** `enumerateCombos`, chunking (`runSweep`), the results table and
2-axis heatmap (`SweepResults.tsx`), backend error isolation, risk-target patching.

## Verification

**The existing indicator parity harness is not sufficient for step 1.**
`test_indicator_parity.py` locks the *leaf math* — individual EMA/RSI/AVWAP/slope/
HTF-aligned series against golden fixtures. Step 1 adds an **orchestration layer**
(collect operands, dedup by key, choose HTF fetch windows, apply warmup) that the
fixture does not exercise. Parity bugs will live in that assembly — a missing key, a
wrong fetch window, an off-by-warmup — not in the leaves.

Acceptance gate for step 1: a **new config-level parity fixture**. Feed a
representative rule config (including an `@tf` operand, a `slope` operand, and a mixed
chart-operand) plus candles; assert the backend assembler's full series map equals the
frontend `buildSeries` output, key-for-key, to the same 1e-12 tolerance. Generate the
golden from the frontend, mirror the assertion in Python — the same TS→Python model
already used for leaves.

Sweep acceptance: a 1-combo sweep must equal the single-run result for the same
config; a small grid must produce the expected number of rows with per-combo error
isolation (mirror `test_api_backtest_sweep.py`).

## Effort & risk

- **Backend assembler (step 1):** the real work. Leaf math reused; orchestration +
  HTF windowing + warmup new. Medium size, medium parity risk concentrated in the
  orchestration.
- **Validation inversion:** small but bug-prone; covered by explicit per-kind tests.
- **Sweep endpoint + `_apply_rule_combo` + `_run_rule` extraction:** small, mirrors
  existing coded code.
- **Frontend axis picker:** the main frontend cost; new UI.
- **New config-level parity fixture:** the gate that makes step 1 trustworthy.

## Open questions

- Exact target-path syntax for nested rule groups (dotted vs. bracketed indices) —
  settle during planning.
- Collision policy wording (reject vs. ignore stale shipped native keys) — pick one
  and make it explicit in the validator.
