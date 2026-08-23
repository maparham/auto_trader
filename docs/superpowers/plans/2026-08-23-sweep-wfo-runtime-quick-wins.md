# Sweep / WFO Runtime Quick Wins Implementation Plan

**Goal:** Cut constant-factor runtime overhead in the sweep and walk-forward job paths without changing any result: bisect-based window-metrics slicing, engine inner-loop micro-optimizations, and int-epoch arrays replacing repeated `datetime.timestamp()` conversions.

**Architecture:** Three contained work packages on existing code paths. Task 1 threads precomputed epoch-float arrays through `slice_window_metrics` and its WFO callers. Task 2 hoists hot-loop state into locals inside `BacktestEngine.run` and precomputes session-mask activity flags once per run. Task 3 gives pool workers an int-epoch array per candle-list identity so env-combo truncation, gate lookups, and window end-index computation become O(log n) bisects.

**Tech Stack:** Python 3.12 / pydantic v2 (backend only; no frontend changes).

## Global Constraints

- Byte-identical results: every change must reproduce pre-change metrics row-for-row on the same inputs. No arithmetic reordering anywhere (the IEEE-754 TS-parity mandate in `backend/auto_trader/indicators/core.py:12` stays intact).
- No new dependencies; no protocol/schema changes; no frontend changes.
- Backward-compatible signatures where practical (`slice_window_metrics` keeps working when called without the new optional args).
- Trades are ordered by exit time, not entry time: never bisect the trades list by entry timestamp; equity points ARE chronological and may be bisected.
- Backend tests: `cd backend && uv run pytest tests/ -q`.
- Capture a baseline before starting: run one real sweep and one exact-mode WFO through the API on an existing fixture range and store the JSON output for row-for-row comparison at the end.
- Work on a worktree branch; commit per task.

---

### Task 1: Window-metrics slicing via precomputed timestamps

The dominant quick win for exact-mode WFO grids: today every `slice_window_metrics` call iterates ALL trades and ALL equity points, calling `.timestamp()` per element (~10x the cost of a float compare). The grid phase calls it once per train window per combo.

**Files:**
- Modify: `backend/auto_trader/engine/metrics.py`
- Modify: `backend/auto_trader/api/wfo_worker.py`
- Test: `backend/tests/test_metrics_slicing_perf.py` (create)

- [ ] Extend `slice_window_metrics(trades, equity, from_ts, to_ts, starting_cash, res_seconds, *, trade_ts=None, eq_ts=None)` in `engine/metrics.py`. When the arrays are absent, build them locally (backward compatible).
- [ ] Equity path: `eq_lo = bisect_left(eq_ts, from_ts)`, `eq_hi = bisect_left(eq_ts, to_ts)`; derive `e0` from index `eq_lo - 1` instead of the scan-from-zero loop (metrics.py:224-228). Slice `equity[eq_lo:eq_hi]` for `w_equity`.
- [ ] Trades path: keep an O(T) pass but over floats — `w_trades = [t for t, e in zip(trades, trade_ts) if from_ts <= e < to_ts]` (no per-item `.timestamp()`).
- [ ] In `wfo_worker.py`, build `trade_ts = [t.entry_time.timestamp() for t in result.trades]` and `eq_ts = [...]` once per combo run and thread them through all four sites: `run_grid_combo` (:40), `_exact_window_metrics` (:102), `run_test` (:137), `run_baseline` (:229).
- [ ] Reuse the same arrays for `run_grid_combo_exact`'s per-combo `times` list (:89) and `run_test`'s manual equity rebase/filter loops (:141-155).
- [ ] Equivalence test: old-style filter vs new path on synthetic data covering boundary equality (`from <= t < to`), straddling trades, entry-unordered trade lists (short exits interleaved with long entries), empty windows.

### Task 2: Engine inner-loop micro-optimizations

**File:** `backend/auto_trader/engine/backtest.py` (`run()` :134-330), `engine/schedule.py`.

- [ ] Mask activity precompute: when `self.mask` is enabled AND has any filter (days/months/timeWindow; otherwise all-active shortcut), build `active_flags: list[bool]` once per run in a tight comprehension with `ZoneInfo(mask.tz)` bound locally; the loop reads `active_flags[i]` instead of calling `is_active()` per bar (removes per-bar `astimezone` + ZoneInfo lookup, schedule.py:51).
- [ ] Flat-path guards: replace unconditional `sum(p.qty for p in longs)` / shorts (:290-291) with emptiness-guarded equivalents.
- [ ] Local bindings: hoist hot attributes into locals (`realized`, `peak_equity`, bound `result.equity.append`, commission/half-spread/financing constants); accumulate `max_drawdown` in a local and write `result.max_drawdown` once after the loop (strategies never see `result`; nothing reads it mid-run).
- [ ] Stale-context guard: refresh `ctx.last_exit_*` (:299-303) only when `len(result.trades)` changed since the previous bar.
- [ ] Stretch: cache `_wilder_atr14` (:167, :334) by candle-list identity via an optional constructor param populated from the worker's job-scoped cache. Only pays when `slippage_atr_mult > 0`.
- [ ] Gate: existing engine regression tests must pass unchanged (byte-identical results).

### Task 3: Epoch arrays + bisect truncation

**Files:** `backend/auto_trader/api/sweep_worker.py`, `api/sweep_apply.py`, `api/wfo_worker.py`.

- [ ] `_State` gains `epochs: list[int]` built next to candles in `worker_init` (sweep_worker.py:71), plus a shared helper mirroring `indicator_cache_key` so env-truncated prefixes carry `epochs[:cut]` (truncated lists never share arrays with full ones, same identity rule as `_IND_CACHES`).
- [ ] `apply_env_combo` (sweep_apply.py:489): accept/return the matching epoch array; period truncation becomes `bisect_right(epochs, to_s)` + list slice instead of the O(n) timestamp comprehension (:535). Update all callers: `execute_combo` (:99), `build_combo_session` (:139), `_run_baseline_req` (wfo_worker.py:205), plus any router dry-validation site found by grep.
- [ ] `start_at` (sweep_worker.py:81) and `_end_index` (wfo_worker.py:70): switch to plain bisect over the epoch array (signatures preserved; lambda-per-comparison gone).
- [ ] Stretch: thread epochs into `ExprRuleStrategy` (constructor arg, `None` = legacy fallback) so the per-bar gate check at `strategy/expr/strategy.py:96` stops calling `.timestamp()`; all construction sites (`build_expr_engine`, `run_coded_sync` panel wrapper) have candles in hand.

### Verification

1. New unit tests per task (equivalence-focused, above).
2. Targeted suites first, then full backend suite:
   `cd backend && uv run pytest tests/test_metrics* tests/test_wfo* tests/test_sweep* tests/test_engine* tests/test_backtest* -q`
   then `cd backend && uv run pytest tests/ -q`.
3. Manual sanity: re-run the captured baseline sweep + exact-mode WFO through the API; confirm row-for-row identical metrics vs the stored pre-change output.

**Expected payoff:** largest on exact-mode WFO grids with many train windows (Task 1) and long histories generally (Tasks 2-3); honest estimate is tens of percent on the grid phase, not order-of-magnitude. Out of scope (deliberate): warm process pool across jobs, per-session compile hoisting, numba/vectorization (violates parity doctrine), early stopping (rejected in docs/backtest-optimization-proposals.md O3).
