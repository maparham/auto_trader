# Strategy Analysis & Optimization Loop — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorm), pending implementation plan

## Goal

Give the user an evidence-based feedback loop while developing strategies:
deterministic analytics computed by the backend on every backtest run
(measuring), plus Claude reading those results in sessions to propose concrete
tweaks — entry filters, SL/TP sizing, target placement (interpreting). Stats do
the measuring; Claude does the interpreting.

## Decision summary

| Decision | Choice |
|---|---|
| Who analyses | Hybrid: in-app deterministic stats + Claude on top in sessions |
| "Chart pattern analysis" scope | Entry-context features + candlestick patterns now; classic patterns (H&S, flags) deferred; Claude chart-image reads ad hoc |
| UI home | New "Analysis" tab in the backtest dock |
| Claude data access | Backend run store (auto-persist runs + small read API) |

## Phase 1 — Analytics core (backend)

All computation lives in the backend (standing rule: backend owns business
logic; the browser renders).

### 1a. MAE/MFE per trade

While a position is open, the backtest engine tracks:

- **MAE** (max adverse excursion): worst price against the position, from bar
  lows (long) / highs (short), between entry fill and exit.
- **MFE** (max favorable excursion): best price in the position's favor over
  the same span.

Stored on `Trade` (backend/auto_trader/core/models.py) as new fields:

- `mae: float | None`, `mfe: float | None` — raw price distance from entry
  (always ≥ 0).
- `mae_r: float | None`, `mfe_r: float | None` — the same as R-multiples,
  where 1R = |entry_price − stop_initial|. `None` when there is no initial
  stop.

Both hedged legs track independently. Fields flow through `TradeDTO` into
`BacktestResponse` unchanged.

**Why:** answers the core SL/TP questions directly — "how many losers were
stopped by less than X beyond the stop" (stop too tight), "winners' MFE vs
realized R" (target too conservative / money left on the table).

### 1b. Entry-context features per trade

Computed at each trade's **signal bar** (the bar whose rules fired, not the
fill bar), from the chart-timeframe candle array the engine already holds:

| Feature | Definition |
|---|---|
| `trend` | EMA(50) slope sign + strength bucket: `up` / `down` / `flat` (flat = \|slope\| < 0.02 %/bar; constant, not user-tunable in v1) |
| `vol_regime` | ATR(14) percentile within the run's own bars: `low` (<33rd), `mid`, `high` (>67th) |
| `session` | FX session tag from bar UTC hour: `asia` / `london` / `newyork` / `overlap` / `off` |
| `hour_utc`, `day_of_week` | ints, for time-bucket grouping |
| `dist_swing_high`, `dist_swing_low` | distance from the most recent 20-bar swing high/low, as a multiple of ATR(14) |
| `candle_pattern` | pattern at the signal bar: `bull_engulfing`, `bear_engulfing`, `pin_top`, `pin_bottom`, `inside`, `outside`, `doji`, or `none` (first match in that order) |

Stored as a `context: dict` (JSON-safe scalars) on `Trade` / `TradeDTO`.
Warm-up: features whose lookback isn't satisfied at the signal bar are `null`,
never fabricated.

Candlestick pattern definitions (deterministic, body = |close−open|,
range = high−low):

- **engulfing:** body engulfs prior bar's body, opposite colors.
- **pin top/bottom:** wick ≥ 2× body on that side, body in the opposite third
  of the range.
- **inside/outside:** high/low strictly inside (resp. outside) prior bar's.
- **doji:** body ≤ 10% of range.

### 1c. Run store

Every backtest run auto-persists server-side. New SQLite table (own file
`backtest_runs.db` next to the existing DBs — keeps the workspace-state store
untouched):

```
runs(
  id TEXT PRIMARY KEY,          -- uuid
  created_at INTEGER,           -- unix seconds
  epic TEXT, timeframe TEXT,
  range_from INTEGER, range_to INTEGER,
  strategy_kind TEXT,           -- 'rules' | 'coded'
  strategy_name TEXT,           -- coded file name or null
  request_json TEXT,            -- full BacktestRequest (rules/params/risk)
  summary_json TEXT,            -- metrics: net_pnl, n_trades, win_rate,
                                --  max_drawdown, profit_factor, expectancy, …
  trades_json TEXT              -- trades incl. mae/mfe + context
)
```

Not stored: equity curve points, fills, bar traces (bulky; re-runnable on
demand). Pruned to the most recent **200** runs on insert. Sweep child runs
are **not** individually stored (only normal runs); the sweep response itself
is transient as today.

Read API (backtest router):

- `GET /backtest/runs?limit=&epic=` → list of `{id, created_at, epic,
  timeframe, strategy_kind, strategy_name, summary}` (no trades).
- `GET /backtest/runs/{id}` → full record.
- `DELETE /backtest/runs/{id}` → remove one (housekeeping).

The `BacktestResponse` gains `run_id` so the frontend can reference the stored
run.

### 1d. Aggregate analytics

A backend module (`engine/analysis.py`) computes, from a run's trades:

- **SL efficiency:** distribution of losers' MAE beyond stop; share of losers
  with MAE within X of the stop ("near-miss stops"); share of eventual winners
  whose MAE approached the stop.
- **TP efficiency:** winners' MFE vs realized R; median unrealized R left on
  the table; share of rule/session exits that had hit ≥ target-R MFE.
- **Exit-reason breakdown:** count / win rate / expectancy per `reason_out`.
- **R-multiple distribution:** histogram buckets of pnl in R.
- **Context breakdowns:** n / win rate / expectancy / net pnl grouped by each
  context feature (trend, vol_regime, session, candle_pattern, day_of_week).

Returned inline on `BacktestResponse` as `analysis` (and recomputable from a
stored run via `GET /backtest/runs/{id}` which includes it). Groups with
n < 5 trades are flagged `low_sample: true` rather than hidden.

## Phase 2 — "Analysis" tab (frontend)

New tab in the backtest dock beside the existing results/trades views.
Renders `analysis` from the response; no browser-side computation beyond
formatting. Sections:

1. **SL/TP read-outs** — headline sentences with numbers (plain copy, standard
   trading terms), e.g. "9 of 14 losers moved less than 0.3R past your stop
   before reversing." Backed by small MAE/MFE distribution bars.
2. **Exit reasons** — table: reason, n, win rate, expectancy.
3. **R distribution** — compact histogram.
4. **Context tables** — one table per feature: bucket, n, win rate,
   expectancy, net PnL; low-sample rows greyed with an InfoTip. Rows that
   underperform the run average get a subtle highlight — these are candidate
   filters.

Conventions: light theme first, no shadows, content-sized, shared `Tooltip`/
`InfoTip` components, dismiss-on-outside-click where applicable.

## Phase 3 — Claude in sessions (no build)

Working loop, enabled by Phases 1–2:

1. User runs backtests as usual; runs land in the store.
2. Claude curls `GET /backtest/runs` / `/runs/{id}`, compares iterations,
   and proposes concrete tweaks (filters from context tables, SL/TP from
   MAE/MFE, target from MFE).
3. Claude validates proposals **before** recommending, by driving the existing
   sweep endpoint (`SweepDTO` combos over `risk:`/`rule:`/`param:` patches).
4. For individual suspicious trades, Claude can screenshot the chart around
   the trade via browser automation for a qualitative read.

## Phase 4 — deferred: classic pattern detection

Head & shoulders, flags, double tops, triangles — as chart indicator and/or
rule operand. Deliberately deferred: algorithmically subjective, large build,
weak evidence of predictive payoff. Revisit once Phases 1–3 show which context
features actually separate winners from losers. Candlestick patterns are NOT
deferred (they ship in 1b) and can later be promoted to rule operands.

## Error handling

- Run-store writes are best-effort: a failed insert logs a warning and never
  fails the backtest response.
- Analytics on zero-trade runs return an empty-but-valid `analysis` object;
  the tab shows "no trades to analyse".
- Context features degrade to `null` per-feature on insufficient warm-up.

## Testing

- Unit tests for MAE/MFE (long, short, hedged, no-stop → `mae_r = None`,
  gap-through-stop), candle-pattern classifier (fixture bars per pattern),
  and each analysis aggregate on hand-built trade lists.
- Coded-strategy TS-parity fixture untouched (new fields are additive).
- Run store: insert/prune/read round-trip test.
- Frontend: render test for the Analysis tab on a fixture `analysis` payload.

## Out of scope

- LLM calls from inside the app.
- Live-trading analytics (backtest only, for now — live journal already
  exists and can be folded in later).
- Persisting equity curves / bar traces in the run store.
- Any migration/back-compat shims (no legacy data; new table starts empty).
