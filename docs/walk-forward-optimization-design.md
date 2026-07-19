# Walk-forward optimization: design

Date: 2026-07-19. Status: design only, nothing implemented. Expands proposal F2 in
`docs/backtest-optimization-proposals.md` into a buildable architecture.

Grounded in the current code: the sweep job pipeline
(`api/sweep_jobs.py`, `api/sweep_worker.py`, `api/sweep_apply.py`,
`api/routers/backtest.py`), the engine and metrics (`engine/backtest.py`,
`engine/metrics.py`), the parameter model (`strategy/params.py`), persistence
(`core/sweep_store.py`, `core/run_store.py`), and the frontend sweep stack
(`lib/sweep.ts`, `SweepResults.tsx`, `lib/sweepPlateau.ts`, `lib/holdout.ts`).

---

## 1. Goal and non-goals

**Goal.** Optimize strategies for out-of-sample (OOS) performance and robustness, not
in-sample (IS) profit. Walk-forward simulates the only decision process available live:
pick parameters using data you had at the time, trade them forward, repeat. The stitched
OOS record is the product; the IS results are scaffolding.

**Non-goals for v1** (but the architecture must leave room): Bayesian/TPE search (O2),
Monte Carlo perturbation (F5), deflated Sharpe (F6), live readiness integration (L1).
Section 10 defines the extension seams for each.

## 2. Concepts and vocabulary

- **Fold**: one train/test pair. `train = [t_a, t_b)`, `test = [t_b, t_c)`. The strategy
  never sees test data during selection for that fold.
- **Schedule**: how folds tile the full range. *Rolling*: train window slides forward by
  `step`, fixed length. *Anchored*: train always starts at range start and grows.
- **Step / retraining frequency**: distance between consecutive test starts. Default
  `step = testSpan` (contiguous, non-overlapping test segments that tile the range).
  `step < testSpan` (overlapping tests) is allowed for stability analysis but the
  stitched curve always uses contiguous segments.
- **Objective**: the scalar used to rank combos inside a fold's train window.
- **Selection rule**: how the winner is picked from ranked combos (raw best vs
  plateau center).
- **Scheme**: one (trainSpan, testSpan, step) triple. **Matrix mode** runs several
  schemes at once (multiple train lengths).
- **WFE (walk-forward efficiency)**: OOS performance of the chosen params divided by
  their IS performance, aggregated across folds (section 6.2).

## 3. Architecture overview

Walk-forward is a **meta-job composed from existing pieces**, not a new execution path.
One WFO job = an orchestration layer that internally does what N sweeps + N single runs
do today, on the same process pool, with the same streaming/cancel/ETA semantics and the
same optional EC2 forwarding.

```
POST /api/backtest/walkforward/jobs
        │
        ▼
WalkForwardJobManager (new, api/wfo_jobs.py; sibling of SweepJobManager)
        │  shares: FIFO gate, ProcessPoolExecutor sizing, cancel/reap, ETA
        ▼
Orchestrator thread
  1. Plan       build fold schedule(s) from config + candle range
  2. Precompute candles + HTF fetched once; rule series assembled once;
                combo list validated once (dry-run, as sweeps do today)
  3. Evaluate   dispatch work units to the pool (section 7 decides the unit)
  4. Select     per fold: rank combos on train objective, apply selection rule
  5. Test       per fold: exact engine run of the winner on the test window
  6. Stitch     concatenate OOS segments into one equity curve + trade list
  7. Aggregate  robustness metrics, parameter stability, per-fold heatmap data
  8. Persist    write WfoResult to the new store on completion
```

Everything below the orchestrator reuses `sweep_apply` cores (`apply_combo`,
`apply_rule_combo`, `apply_env_combo`, `run_rule_sync`, `run_coded_sync`) unchanged
except for the additions in section 7. The worker stays zero-network and spawn-safe.

### New backend modules

| Module | Role |
|---|---|
| `api/wfo_jobs.py` | `WalkForwardJobManager`, `WfoJob` (progress, phases, cancel) |
| `api/wfo_plan.py` | Pure fold-schedule math (heavily unit-tested, no I/O) |
| `api/wfo_select.py` | Objective evaluation + selection rules (incl. plateau) |
| `api/wfo_stitch.py` | OOS segment stitching, WFE, aggregate robustness metrics |
| `engine/stability.py` | Parameter stability / drift scoring across folds |
| `engine/plateau.py` | Neighborhood scoring, ported from `lib/sweepPlateau.ts` so backend selection and frontend display share one definition (frontend keeps its copy for sweep mode until it can call the backend) |
| `core/wfo_store.py` | Persistence (`backtest_wfo.db`), sibling of `SweepStore` |
| `api/routers/backtest.py` | Three new endpoints (section 8), same shapes as sweep jobs |

## 4. Configuration model

`WalkForwardDTO`, carried on the existing backtest request the same way `sweep` is
(`api/schemas.py`). The parameter space reuses the sweep combo grammar verbatim
(`param:`, `risk:`, `op:`, `rule:` targets), so every currently sweepable thing is
walk-forwardable, and the frontend keeps enumerating the grid in `lib/sweep.ts`.

```python
class WfoScheduleDTO(BaseModel):
    mode: Literal["rolling", "anchored"] = "rolling"
    train_span: str            # duration token: "2w" | "1m" | "3m" | "6m" | "90d" | "5000b" (bars)
    test_span: str             # same token grammar
    step: str | None = None    # default: = test_span
    min_train_trades: int = 30 # combos below this in a fold are ineligible (greyed, not hidden)
    min_test_trades: int = 5   # folds below this are flagged low-sample in aggregates

class WfoObjectiveDTO(BaseModel):
    metric: str = "sharpe"           # any sweep-row metric name (sharpe, sqn, net_pnl, return_pct, ...)
    selection: Literal["best", "plateau"] = "plateau"
    composite: dict[str, float] | None = None   # optional weighted blend, e.g. {"sharpe": .6, "max_drawdown_pct": -.4}

class WalkForwardDTO(BaseModel):
    combos: list[dict]               # same shape as SweepDTO.combos
    axes: list[AxisDescriptor]       # axis metadata (target, ordered numeric steps) so the
                                     # backend can do neighborhoods; today only the frontend knows this
    schedule: WfoScheduleDTO
    matrix_train_spans: list[str] = []   # e.g. ["2w","1m","3m","6m"]; empty = single scheme
    objective: WfoObjectiveDTO
    eval_mode: Literal["auto", "sliced", "exact"] = "auto"   # section 7
```

Notes:

- **Duration tokens** resolve against the candle series via `resolution_seconds`. Bar
  counts (`"5000b"`) are exact; calendar tokens snap to the nearest bar boundary.
  `wfo_plan.py` owns this and returns concrete `(from_ts, to_ts)` pairs.
- **`axes` is new information for the backend.** Sweeps today ship only the flat combo
  list; plateau selection and per-axis stability need the grid structure (which target
  varies, its ordered values). The frontend already has this in `SweepAxis`; it just
  serializes it.
- **Warm-up**: each fold's engine input starts `lookback` bars before `from_ts`
  (max indicator length, already computed for HTF prefetch today) with trading gated at
  `from_ts` via the existing `period:from` semantics (`apply_env_combo` tradeFromTime).
  Indicators are warm; positions start flat. This is the honest live analogue.
- **Data feasibility**: the planner validates up front that the requested schemes fit
  the available candles and returns a clear 422 listing which schemes don't (relevant
  for intraday: yfinance caps 1m at 29 days and other intraday at 59 to 729 days, so a
  "6 months of 5m training" scheme is impossible and must fail at submit, not mid-job).

## 5. Fold planning (`wfo_plan.py`)

Pure function: `plan(range_from, range_to, schedule, res_seconds) -> list[Fold]`.

- Anchor folds to the **end** of the range and walk backwards, so the most recent data
  is always fully used and any remainder is dropped at the oldest end (recent regimes
  matter more than 2019's).
- Rolling: `train_i = [end_i - test - train, end_i - test)`, `test_i = [end_i - test, end_i)`,
  `end_i = range_to - i * step`. Anchored: train start pinned at `range_from`.
- Reject plans with fewer than 3 folds (WFE from 1 to 2 folds is noise); warn in the
  response at fewer than 5.
- **Holdout interplay**: if a lockbox holdout is configured (`lib/holdout.ts`), the WFO
  range is the training span only. The stitched OOS curve is *pseudo*-out-of-sample
  (each segment is OOS for its fold, but the user may iterate on the whole WFO result);
  the lockbox remains the final untouched check. UI copy must say this.
- Matrix mode: `plan()` runs once per train span. Test spans and steps are held
  constant across the matrix so stitched curves are comparable (same OOS bars, only the
  training length differs). The fold set for each scheme is stored with the results.

## 6. Algorithms

### 6.1 Per-fold selection (`wfo_select.py`)

For each fold, given per-combo train metrics (from section 7):

1. Drop combos with `n_trades < min_train_trades` or errored evaluation.
2. Score each combo: single metric, or the composite (z-score each component across
   the fold's combos, then weighted sum; z-scoring makes weights unit-free).
3. `selection = "best"`: take the top score.
   `selection = "plateau"` (default): compute neighborhood stats over the grid using
   `axes` (per numeric axis, neighbors are one step away; the neighborhood score is the
   median objective of the cell and its neighbors, tie-broken by worst neighbor). Pick
   the cell with the best neighborhood score. This is `lib/sweepPlateau.ts` semantics,
   ported to `engine/plateau.py`.
4. Record the full ranked table for the fold (this *is* the sensitivity heatmap data,
   section 6.5), plus the chosen combo and its IS metrics.

Choosing plateau selection as the default is deliberate: WFO measures the selection
*process*, so the process being validated should be the robust one we want users to
actually apply.

### 6.2 OOS evaluation, stitching, WFE (`wfo_stitch.py`)

- Each fold's winner runs **exact** on its test window: fresh engine, flat start,
  warm indicators, `starting_cash` = configured base. Position open at test end is
  closed by mark-to-market at the final bar (existing engine behavior); the stitched
  curve stores a `forced_close` flag on such trades.
- **Stitching**: OOS segments are contiguous by construction (`step = testSpan` for the
  stitched view). Concatenate per-bar `EquityPoint`s, rebasing each segment to start at
  the previous segment's ending equity (each fold trades the compounded balance,
  matching live behavior). Also keep a non-compounded variant (each segment rebased to
  `starting_cash`, PnLs summed) because compounding makes early folds dominate visually.
  Store both; UI defaults to compounded.
- **Stitched metrics**: run the existing `compute_metrics` + `risk_metrics` over the
  stitched equity/trades. That immediately yields OOS Sharpe, Sortino, Calmar, CAGR,
  max drawdown %, profit factor, SQN with zero new metric code.
- **WFE**: per fold, `wfe_i = oos_rate_i / is_rate_i` where `rate` is annualized
  return_pct of the *chosen* combo (annualized so different train/test lengths are
  comparable). Guard: `is_rate <= 0` makes the ratio meaningless, mark the fold's WFE
  null and report coverage. Headline WFE = median of fold WFEs (median, not mean;
  single-fold blowups shouldn't set the headline). Also report aggregate WFE =
  (total annualized OOS) / (total annualized IS) as a secondary number.
- **Robustness block** (the numbers the user ranks by):
  - `wfe_median`, `wfe_aggregate`
  - `pct_folds_profitable` (OOS net > 0)
  - `median_fold_return_pct`, `worst_fold_return_pct`
  - `oos_sharpe`, `oos_max_drawdown_pct`, `oos_profit_factor` (from stitched curve)
  - `param_stability` (section 6.3)
  - `n_folds`, `oos_trades_total`, `low_sample_folds`
  - `robustness_score`: 0 to 100 composite, section 6.6

### 6.3 Parameter stability (`engine/stability.py`)

Inputs: per-fold chosen combo + `axes`.

- **Per-parameter drift series**: the chosen value per fold, in axis-step units.
- **Per-parameter stability**: `1 - (stdev of chosen step-index / stdev of a uniform
  random pick over the axis)`, clamped to [0, 1]. 1.0 = same value every fold, 0 = the
  winner bounces around like noise. Using step-index units normalizes across axes with
  different scales; the uniform-random denominator makes 0 mean "indistinguishable from
  random selection".
- **Adjacency rate**: fraction of consecutive folds where the winner moved at most one
  grid step per axis. Erratic winners are the classic noise-fitting signature and this
  is the single most readable stability number.
- **Overall `param_stability`**: mean of per-parameter stabilities, weighted by each
  axis's objective sensitivity (an axis the objective barely responds to shouldn't
  drag the score; sensitivity = variance of the fold-median objective along that axis).

### 6.4 Matrix mode (multiple training lengths)

One WFO job, `matrix_train_spans = ["2w","1m","3m","6m"]`. Each scheme produces the
full result of sections 6.1 to 6.3. The matrix summary is a small table (scheme x
robustness block) answering "how sensitive is this strategy to the training length?"

- Consistent WFE and stability across schemes = genuine, slowly-varying edge.
- Only long trainings work = slow regime edge; only short = fast-adapting or noise.
- The UI presents the matrix *before* any single scheme's detail, precisely so the user
  doesn't pick the scheme after seeing which one looks best (the matrix is the honest
  view; StrategyQuant's WF matrix is prior art).
- Marginal cost is small in sliced mode (section 7): the expensive per-combo work is
  shared across schemes; only per-scheme winner test runs are added.

### 6.5 Sensitivity heatmaps across folds

Every fold's ranked combo table is retained (it is exactly a sweep result scoped to the
train window). The UI reuses the existing heatmap (`SweepResults.tsx`, `sweepHeat.ts`)
with a fold selector, plus two aggregate views computed backend-side:

- **Median-rank heatmap**: per combo, its objective *rank percentile* within each fold,
  median across folds. Rank-normalizing per fold removes regime-level shifts and shows
  which regions are persistently good. This is the plateau-over-time picture.
- **Win-count overlay**: how many folds each cell won (or was within the top decile).

Storage note: fold tables are the bulky part (folds x combos rows). Persist the full
tables up to a budget (~50k rows per scheme); beyond that, persist per-fold top-N (200)
plus the aggregate heatmaps, and mark the result as truncated. Live jobs stream only
per-fold winners + progress; tables are pulled lazily per fold.

### 6.6 Robustness score and strategy ranking

A single 0 to 100 score so strategies can be ranked by robustness rather than net
profit, computed in `wfo_stitch.py` and stored on the result:

```
score = 100 * clamp01(
    0.30 * ramp(wfe_median;        0.0 → 0.6+)     # 0 at WFE<=0, 1 at >=0.6
  + 0.20 * pct_folds_profitable
  + 0.15 * ramp(oos_sharpe;       0.0 → 1.5+)
  + 0.15 * param_stability
  + 0.10 * ramp(-oos_max_dd_pct; -40% → -10%)
  + 0.10 * plateau_breadth                          # share of grid within 80% of peak, median across folds
) * sample_penalty        # scales down when oos_trades_total < 100 or n_folds < 5
```

Weights and ramps are constants in one table (`engine/stability.py`), visible in an
InfoTip, and intentionally opinionated defaults rather than user knobs in v1. The
ranking surface (section 9.4) sorts archived WFO results by this score, shows the
components as a small bar breakdown, and never presents net PnL as the primary column.

## 7. Efficient execution

The naive cost is `folds x combos` backtests per scheme, times schemes. Three layers
cut this down.

### 7.1 Sliced evaluation of the training grid (the big one)

Key observation: fold train windows overlap heavily (rolling, step << train) or nest
(anchored, and matrix schemes share the same bars). Re-running a combo per fold
recomputes almost identical trade sequences.

Instead, evaluate **each combo once over the full WFO range**, then derive every fold's
train metrics by *slicing* that one run's trades and equity by window. The machinery
exists: `window_metrics` (`engine/metrics.py:162`) already attributes trades to
sub-windows by entry time. It needs one extension: per-window metric enrichment
(win_rate, profit_factor, and a per-window Sharpe from window-local daily equity
deltas) so the fold objective can be any sweep metric, not just PnL.

Cost collapses from `folds x combos` to `combos + folds` engine runs per scheme, and in
matrix mode the `combos` term is shared across all schemes (same full-range runs,
different slicing). A 4-scheme, 12-fold, 400-combo job drops from ~19,200 runs to
~448.

**The approximation and its boundary.** A sliced window differs from a flat-start run
in one way: position state. A trade entered before the window but still open, or a
position cap already consumed at window start, makes the sliced view differ from what a
fresh optimizer would have seen. This is negligible when typical hold time << train
span (the overwhelming case: hours-to-days holds vs weeks-to-months trains) and
material for always-in-market or very-slow strategies.

Policy: `eval_mode = "auto"` uses sliced when `p95(bars_held) * bar_seconds <
5% of train_span`, measured from a single probe run (the sweep pipeline already runs
`combos[0]` in-request as a probe); otherwise exact. The result records which mode ran.
`"exact"` remains available for paranoia and for validating the sliced approximation
(a good integration test: sliced and exact selections should agree on fast strategies).

**What is never sliced**: OOS test evaluation of each fold's winner is always an exact
flat-start engine run (section 6.2). The honest output stays honest; only the internal
ranking scaffold uses the approximation. Per fold that costs `folds x schemes` exact
runs, which is trivial.

### 7.2 Exact-mode memoization

When exact mode does run, work units are `(combo_hash, window)` pairs. A job-scoped
result cache keyed on that pair dedupes: anchored schemes share prefixes, matrix
schemes share windows, and `step < testSpan` overlapping folds hit the cache heavily.
`combo_hash` = stable hash of the canonicalized combo dict.

### 7.3 Shared computation below the engine

- **Candles + HTF**: fetched once per job, shipped to workers via `worker_init`
  (existing behavior, unchanged). Remote jobs ship candles in the request as today.
- **Rule series**: `assemble_rule_series_sync` computes referenced series once per
  worker for the full range; window slicing reuses them as-is (already true today
  because series are combo-invariant unless the combo patches a rule operand).
- **Coded strategies, new win**: `StrategyContext` memoizes indicator series per
  strategy instance, so today every combo recomputes every indicator. Promote the cache
  to a **worker-process-level dict** keyed `(kind, key, tf, back)` (e.g.
  `("ema", 20, "1h", 0)`), valid because candles are fixed for the whole job. Combos
  that don't change an indicator input get all indicators for free. This also speeds up
  ordinary sweeps and is worth landing first as an independent change.
- **Work-unit granularity**: in sliced mode the pool unit is "one combo, full range"
  (identical to today's sweep unit, so `run_combo` needs almost no change: it gains a
  `windows` argument and returns per-window slices, which `sweep_row` already supports
  via `window_metrics`). Orchestration, selection, stitching, and stability run in the
  job thread; they are milliseconds of arithmetic on returned rows.

### 7.4 Progress and ETA

Progress unit = pool work units, exactly like sweeps (`done/total`, pace-based ETA).
Phases surface as a label on the job (`"evaluating grid" -> "testing winners" ->
"aggregating"`), since the grid phase is ~95% of wall clock. Streaming: per-fold
winner rows stream to the UI as folds resolve, so the folds table and drift strip fill
in live, matching the sweep table's streaming feel.

## 8. Job API and persistence

Endpoints mirror sweep jobs one-for-one, including `target=local|remote` EC2
forwarding through `api/routers/compute.py` (which relays verbatim, so remote works on
day one):

```
POST /api/backtest/walkforward/jobs?target=local|remote   submit; validates plan + combos, returns job_id + plan summary
GET  /api/backtest/walkforward/jobs/{id}?cursor=N         poll: phase, progress, ETA, fold rows from cursor
POST /api/backtest/walkforward/jobs/{id}/cancel           cooperative cancel (pool shutdown + reap, as sweeps)
GET  /api/backtest/walkforward/jobs/{id}/fold/{k}         lazy: full ranked table for fold k (live or archived)
```

**Persistence** (`core/wfo_store.py`, `backtest_wfo.db`, cap ~50, WAL, same idioms as
`SweepStore`): unlike sweeps, WFO results **auto-persist on job completion**. These
jobs are expensive (potentially hours on the remote host) and losing one to the
in-memory 1h TTL or a closed tab is unacceptable. Columns: id, created_at, epic,
timeframe, strategy identity, `request_json` (full WalkForwardDTO + base config),
`result_json` (schemes -> folds, winners, robustness block, stitched equity
downsampled to 2000 points via the existing downsampler, aggregate heatmaps),
`fold_tables_json` (budgeted, section 6.5). List/read/delete endpoints under
`/api/backtest/walkforward/archive`, same shape as `/api/backtest/sweeps`.

The stitched OOS result can also be pushed into `RUN_STORE` as a pseudo-run
("WFO OOS: <strategy>") so it participates in the future run-comparison view (C1) for
free.

## 9. UI design

Follows existing patterns: no new page; a mode in the backtest panel, config in the
settings modal, results in the docked results area. All computation backend-side
(browser renders only), per project convention.

### 9.1 Configuration (in `BacktestSettingsModal`)

- `RunBar` `ModeSeg` grows a third mode: **Backtest | Sweep | Walk-forward**.
- Walk-forward mode shows the sweep axes UI unchanged (same `RangeChip` toggles; the
  grid *is* the parameter space) plus a compact scheme block:
  - Train span: segmented quick-picks `2w / 1m / 3m / 6m` + custom, each toggleable
    into the matrix (multi-select = matrix mode).
  - Test span and step (step defaults to test span, collapsed under "advanced").
  - Rolling/anchored toggle. Objective metric picker + Best/Plateau selection seg
    (plateau default). Eval mode under "advanced" (Auto default).
- The existing `WindowTimeline` component gains a fold preview: train/test bands drawn
  for the chosen scheme, updating live as spans change. This one visual prevents most
  misconfiguration. Holdout shading stays on top with its existing lockbox treatment.
- Submit summary line before running: "4 schemes x 11 folds x 384 combos, ~430 engine
  runs (sliced), est. ~6 min local / ~40 s remote", from the plan endpoint's response.

### 9.2 Results panel (new `WfoResults.tsx`, sibling of `SweepResults.tsx`)

Top-down, robustness first:

1. **Scorecard header**: robustness score with component breakdown tooltip, WFE
   (median), % folds profitable, OOS Sharpe, OOS max DD, param stability, OOS trades.
   Tone-colored `pos`/`neg` cards like `BacktestPanel` Overview. Every number gets an
   `InfoTip` that teaches (WFE especially).
2. **Matrix strip** (matrix mode): schemes x key metrics mini-table; click selects the
   scheme driving the views below. Shown above single-scheme detail by design
   (section 6.4).
3. **Stitched OOS equity**: drawn on the main chart via the existing equity indicator
   sub-pane (`lib/backtest.ts` staircase mapping), with fold-boundary vertical shading
   (alternating tint for test segments, using existing period-shading machinery). A
   compounded/summed toggle. IS equity of chosen combos optionally ghosted for the
   WFE-gap visual.
4. **Folds table**: one row per fold: window dates, chosen parameter values, IS
   objective, OOS return, OOS trades, fold WFE; `SortHeader` sorting; low-sample folds
   greyed like errored sweep rows. Clicking a row loads that fold's full ranked table
   (lazy endpoint) into the standard sweep table/heatmap below, and can shade the
   fold's window on the chart.
5. **Parameter drift strip**: per swept axis, a small step-chart of the chosen value
   across folds (y = axis steps, x = folds), with the stability number and adjacency
   rate beside it. Flat lines read as trust; sawtooth reads as noise. This is the
   plateau doctrine made visible over time.
6. **Sensitivity view**: the existing heatmap component fed by the median-rank
   aggregate, with a Fold: [All | 1..N] selector to flip into any single fold's
   heatmap and the win-count overlay toggle.
7. **Apply**: "Apply latest winner" applies the final fold's chosen combo to the
   config (the parameters you would trade tomorrow), never a "best OOS fold" apply,
   which would reintroduce selection bias. Copy says so.

### 9.3 Progress and archive

- Live progress reuses the `sweepStateSignal` pattern: a `wfoStateSignal`, the
  `RunBar` badge showing phase + done/total + ETA, streaming fold rows into the folds
  table as they resolve. Cancel via the same affordance as sweeps. Job resume across
  reload copies `lib/sweepResume.ts`.
- Archive: a "Walk-forwards" tab next to the runs/sweeps archives; reopening restores
  the full results panel from `wfo_store`.

### 9.4 Strategy ranking view

In the archive tab: a ranking table across stored WFO results, grouped by strategy
identity (strategy name + epic + timeframe), showing each strategy's best-by-score WFO
result: robustness score (primary sort, with component mini-bars), WFE, % profitable
folds, OOS Sharpe, OOS max DD, stability, OOS trade count. Net profit appears only in
a de-emphasized trailing column. This is deliberately the *only* cross-strategy
leaderboard in the product, and it ranks by robustness.

## 10. Extensibility seams

Each seam is an interface introduced in v1 with exactly one implementation, so later
features are additive:

1. **Optimizer** (`wfo_select.py`): the per-fold search is behind an ask/tell
   interface: `propose(n) -> combos`, `observe(combo, metrics)`, `done()`. v1 ships
   `GridOptimizer` (proposes the whole grid at once). `RandomSearchOptimizer` (O1) and
   `TPEOptimizer` (O2) drop in per fold without touching orchestration; the job thread
   already feeds the pool in batches, which is exactly the ask/tell loop O2 needs.
2. **Objective**: metric-name lookup on the sweep-row metric dict, plus the composite.
   New objectives (e.g. GT-score, mean-minus-sigma) register in one table.
3. **Robustness analyzers** (`wfo_stitch.py`): post-aggregation hooks with signature
   `analyze(WfoResult) -> dict`, merged into the result. PBO/CSCV (F7) is the first
   obvious drop-in: the folds x combos matrix it needs is exactly the fold tables this
   job already retains. Deflated Sharpe (F6) and Monte Carlo on the stitched OOS trade
   list (F4) are analyzers too.
4. **Schedule**: `plan()` is pure and mode-dispatched; purged/embargoed folds or
   regime-boundary-aligned folds are new modes with no orchestration changes.
5. **Selection rules**: best/plateau behind one function; "top-decile centroid" or
   SPP-style neighborhood distributions slot in.
6. **Readiness report (L1)**: the robustness block is stored in a stable named schema
   precisely so the future pre-arm report can quote it ("WFE 0.71 across 11 folds")
   without recomputation.

## 11. Pitfalls the design must respect

- **Scheme shopping**: running many schemes and reporting the best one is overfitting
  on a new axis. Mitigations: matrix mode presents all schemes together, the archive
  keeps every result, and the robustness score is never maximized-over-schemes in the
  ranking view (a strategy is represented by its chosen-scheme result, and the matrix
  spread is visible).
- **Thin folds**: per-fold stats on <20 OOS trades are noise. `min_test_trades`
  flags them, the sample penalty discounts the score, and greyed styling carries the
  message in every table.
- **Sliced-mode abuse**: the auto guard (7.1) plus a visible "evaluation: sliced"
  stamp on results; exact mode one toggle away.
- **Peeking**: the stitched curve degrades toward in-sample as the user iterates on
  WFO results. The lockbox holdout (F1) stays the final arbiter; the results header
  links to it ("final check: evaluate on holdout, 0 peeks so far").
- **Data ceilings**: intraday history caps (section 4) make some schemes impossible;
  fail at submit with a clear message, never silently shrink folds.
- **Non-stationary costs**: financing/spread models apply uniformly across folds
  today; fine, but the result stamps the cost config so future realism work (R1/R3)
  can invalidate comparisons honestly.

## 12. Build order

1. **Prep (independent, immediately useful)**: worker-level indicator cache (7.3);
   `window_metrics` enrichment (per-window Sharpe/PF/win-rate); port plateau scoring
   to `engine/plateau.py`; ship `axes` metadata with sweep submissions.
2. **Core job**: `wfo_plan` + orchestrator + sliced evaluation + exact OOS testing +
   stitching + WFE, single scheme, `selection="best"`, API + store. Testable end to
   end with a CLI-less integration test (plan is pure; orchestration mockable).
3. **Robustness layer**: plateau selection, stability module, robustness score,
   fold-table retention + lazy endpoint, auto eval-mode guard.
4. **UI**: mode seg + scheme config + fold preview timeline; results panel through the
   folds table and stitched curve; then drift strip, heatmaps, matrix strip.
5. **Matrix mode + ranking view + archive tab.**
6. **First analyzers** (post-v1): PBO on fold tables, Monte Carlo on stitched OOS
   trades, random-search optimizer.

Steps 2 and 3 are backend-only and fully testable without UI; step 1 lands value even
if WFO stalls.
