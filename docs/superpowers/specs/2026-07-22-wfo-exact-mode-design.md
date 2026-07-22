# WFO Exact Selection Mode Design

**Date:** 2026-07-22

**Goal:** Add an exact in-sample selection mode to walk-forward optimization
(WFO), user-selectable, default exact. Today the grid/selection phase uses a
sliced approximation; exact mode evaluates each fold's train window as a real
flat-start backtest, made cheap by a convergence-splice against the full-range
run.

## Background: how WFO evaluates today

WFO has three phases (`wfo_jobs.py`):

1. **Grid (in-sample selection):** every parameter combo runs **once over the
   full date range**; `slice_window_metrics` carves that single continuous run
   into per-train-window metrics used to pick each fold's winner. Cost: **M
   engine runs** for M combos, N folds sliced for free.
2. **Test (out-of-sample):** each fold's selected winner runs **exactly** over
   its test window via `wfo_worker.run_test` (flat start at `test_from`,
   entries gated to the window, candles truncated at `test_to`, warm-up prefix
   keeps indicators warm). OOS is already exact.
3. **Aggregate:** selection tables, stitching, stability, robustness.

The phase-1 slice is an approximation: a fold's window can inherit an open
position across its left boundary, whereas a real per-window run starts flat.
The `evalMode` field already exists in the schema (`"auto" | "sliced" |
"exact"`, default `"auto"`) but is stubbed: both submit handlers 422 on
`"exact"` (`routers/expr.py:201`, `routers/backtest.py:820`) and
`wfo_jobs.py:381` hardcodes `"sliced"`.

## User-facing design

Two modes, replacing the stubbed three:

- **Exact** (default): each fold's train window is evaluated as a real
  flat-start backtest. Accurate, consistent with the exact OOS scoring.
- **Fast**: the current one-run-sliced-N-ways approximation. Quick.

The WFO config panel shows a segmented Exact/Fast control (Exact selected by
default) plus an **estimated engine-run count** next to it, so the user sees the
cost before running (e.g. "Exact: ~4,200 window evaluations; Fast: 200"). No
blocking. Backend normalizes the legacy `"auto"`/`"sliced"` values to Fast.

## Why exact can be cheap: the convergence-splice algorithm

Naive exact = run each combo's train window as its own backtest = **M x W**
runs (W = number of distinct train windows). The algorithm below reduces that to
roughly **fast-mode cost plus a small increment**, and is provably exact for
this engine.

### Engine facts this rests on (verified 2026-07-22)

1. **Fixed position size.** `ExprRuleStrategy` emits every signal with a
   constant `self.quantity` (`strategy/expr/strategy.py:34,54-61`); size is not
   read off running equity.
2. **Additive equity.** `equity = starting_cash + realized`
   (`engine/backtest.py:246`); no compounding.
3. **Force-close at the last candle.** Any position still open at the final
   candle is booked via `_close_all(..., "range end")` at that candle's close,
   producing a real Trade row with an exit commission
   (`engine/backtest.py:267-281`). So `run_test`, which truncates candles at
   `to`, closes an open-at-`to` position at `to`'s close.

Consequences: a trade's identity **and** its PnL depend only on its own entry
and exit prices (fixed qty, additive), never on when in the equity curve it
occurs. Two runs that are **flat at the same bar** are in identical states
(indicators are deterministic from the candles; per-side `entry`/trailing state
resets when flat).

### Correctness precondition (MUST hold; test guards it)

**The set of open positions is the only path-dependent state carried across a
bar.** The direct-slice and the resync both assume two runs flat at the same bar
are identical. This holds for the engine today. It would break silently if
anyone adds entry/exit logic that depends on history beyond the open book:
a cooldown, a bars-since-last-trade counter, an equity-gated or
trade-count-gated entry, a daily-loss stop. If that state is added, the splice
produces wrong backtests feeding wrong selection with no error. The parity test
(below) is the guard: it must include a strategy exercising such state and fail
if the splice diverges from `run_test`.

### The algorithm, per combo

1. **Full-range run once** -> trades `F` + equity. This is exactly fast mode's
   existing grid pass, reused (no extra run).
2. **For each train window `[from, to)`:**
   - **Left-boundary prune (no-straddle):** if no trade in `F` is open at
     `from` (no `F` trade with `entry < from` and `exit` after `from`), the
     full-range run is already flat at `from`, identical to a flat start. Take
     `F` sliced over the window directly. **Zero engine work.**
   - **Convergence-splice (straddle):** if a trade straddles `from`, run a
     flat-start re-sim from `from` (entries gated at `from`, indicators warm)
     and stop at the **convergence point** -- the first bar where the re-sim is
     flat and the full-range run is also flat and both take the same entry.
     From that entry to `to`, the two runs are identical, so splice `F`'s trades
     for the remainder. The re-sim only covers the short divergent prefix.
   - **Right-boundary fixup (both paths):** to match `run_test` semantics, any
     spliced trade still open at `to` (natural exit in `F` is after `to`) is
     force-closed at `to`'s close as a "range end" trade -- recompute its exit
     fill and PnL at `to`, do not copy the later full-range exit.
3. **Score:** feed the window's spliced trade+equity set through the existing
   `slice_window_metrics`, exactly as `run_test` does.

### Pyramiding / scaling

The engine supports multiple concurrent open positions (`long_scaling`,
`short_scaling`). With pyramiding an entry can occur while already holding, so a
**single** matching trade is not sufficient to declare convergence. The general
convergence rule is: **the re-sim and the full-range run hold an identical open
book at the same bar.** The single-trade match is the fast path for the common
one-position-at-a-time case (where any entry implies a flat book just before).
Spec the general open-book match; special-case single-position for speed.

### Cost note (depends on the compile-once hook)

`apply_env_combo` keeps the warm-up head (candles from the range start), so a
naive per-window `period:` run recomputes indicators from the range start every
time; the early stop then saves only the position-loop tail, not the warmup.
The "fast + tiny increment" cost holds **only** if indicators/series are
compiled **once per combo** over the full range and the per-window re-sim
replays the cheap position loop from `from` over the precomputed series with a
flat book. **This compile-once / window-replay engine hook is an explicit
deliverable**, not an incidental. If it proves too invasive, the fallback is
per-window `run_test`-style runs (correct, exact, but M x W cost) with the
no-straddle prune still applied -- ship correctness first, optimize second.

## Correctness gate (do this before the scoring step locks)

The whole point is "exact grid selection == exact OOS scoring." Prove it
empirically: for a sample of combos x windows, run the window through both
`run_test` (truncated-candle flat-start engine run) and the convergence-splice,
and assert the resulting metrics and trade lists match field-by-field. This test
catches the right-boundary straddle (fact 3) and the precondition break
(cooldown/equity-gated state). It is the acceptance criterion for the optimized
path; a divergence means the splice is not exact and selection would be
apples-to-oranges against OOS.

## Backend changes

- **Schema (`schemas.py`):** `WalkForwardDTO.evalMode` -> `Literal["exact",
  "fast"]`, default `"exact"`; normalize legacy `"auto"`/`"sliced"` -> `"fast"`
  on input.
- **Submit handlers (`routers/expr.py`, `routers/backtest.py`):** remove the
  `"exact" -> 422` stub; pass `eval_mode` into `WFO_JOBS.submit`.
- **Worker (`wfo_worker.py`):** add the compile-once / window-replay hook and an
  exact per-window evaluation that runs the convergence-splice against the
  combo's full-range trades. Reuse `slice_window_metrics` for scoring. Keep
  `run_grid_combo` (fast) unchanged.
- **Orchestration (`wfo_jobs.py`):** branch phase 1 on `eval_mode`. Fast: today's
  M `run_grid_combo`. Exact: full-range run per combo (reused) + per-window
  splice, assembled into the same `grid_rows` shape `{combo, folds:[metrics per
  union window], error}` so phases 2-3 are untouched. Update `job.total`
  accounting for the exact path. Set the result's `eval_mode` from the request
  (drop the hardcoded `"sliced"`).

## Frontend changes

- **`WfoConfig.tsx`:** add the Exact/Fast segmented control (Exact default),
  send `evalMode` in the request (today the field is omitted). Show the
  estimated run count: `combos x distinct train windows` for exact, `combos` for
  fast. The fold/window count comes from the same planning the config preview
  already uses.
- **`lib/wfo.ts` + `api.ts`:** thread `evalMode` through the request type and
  builder; surface the result's `eval_mode` where the run is summarized.

## Out of scope (YAGNI)

- Keeping the `"auto"` mode (dropped; normalized to fast).
- Compounding/equity-scaled sizing (engine is additive today; if it changes, the
  precondition test is what flags the break).
- Changing OOS scoring (already exact via `run_test`).
