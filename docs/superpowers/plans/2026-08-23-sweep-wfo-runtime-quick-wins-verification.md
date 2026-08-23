# Verification of docs/superpowers/plans/2026-08-23-sweep-wfo-runtime-quick-wins.md

Measured 2026-08-23 on synthetic 2y hourly data (17,520 bars). Scripts in
scratchpad: bench_slice.py, bench_share.py, bench_mask.py, bench_mask2.py,
bench_expr.py.

## Task 1 — premise CONFIRMED, payoff matches the plan's own estimate

Function-level (isolated):

- `.timestamp()` vs float compare over 17,520 pts: 3.33ms vs 0.18ms = **18.7x**
  (plan claimed ~10x; it understated).
- `slice_window_metrics` on one late 3-month window:
  old 6.22ms -> new 0.73ms with shared arrays = **8.56x**, output dict equal to
  the old path. With arrays rebuilt per call it is only **1.59x** — threading
  them through the callers, not building them inside, is what carries the win.
- Call sites verified at the exact lines cited: wfo_worker.py 40, 102, 137, 229.

Share of a real grid combo (this is what decides the payoff):

- Combo cost with a REAL `ExprRuleStrategy` (EMA(9)/EMA(21) both legs, compile
  + engine run): **183ms**. A toy signal-generator strategy costs 37.5ms, so
  measuring against one inflates slicing's share roughly 2x — do not trust
  benchmarks that skip expression evaluation.
- Slicing's share depends on the WFO schedule:
  - 21 windows x 90d: slicing 104ms = **36%** of a 288ms combo -> Task 1 saves **32%**
  -  6 windows x 90d: slicing  30ms = **14%** of a 213ms combo -> Task 1 saves **12%**

So the plan's "tens of percent on the grid phase, not order-of-magnitude" is
accurate. Task 1 is worth doing; it is schedule-dependent, best on dense
rolling schedules with many train windows.

## Task 1 — framing correction

The plan calls this "the dominant quick win for exact-mode WFO grids". Measured
share above is for SLICED mode. In exact mode `_exact_window_metrics`
(wfo_worker.py:100-107) runs `session.run_window` per boundary window, so extra
engine runs dilute slicing further. Payoff there is LOWER than sliced mode, not
higher, depending on the clean/boundary mix. Not measured.

## Task 2 — first bullet is wrong as written; overall low value

- `is_active` is called EXACTLY ONCE per bar already (backtest.py:197). A
  once-per-run `active_flags` precompute performs the same number of
  evaluations: it relocates the work, it does not remove it. The plan's stated
  rationale ("removes per-bar astimezone + ZoneInfo lookup") does not hold —
  `astimezone` still runs once per bar either way.
- Achievable saving is the hoisted `ZoneInfo` + inlined predicate only:
  9.4ms -> 7.3ms = **22%**, of which `astimezone` alone is a 4.8ms irreducible
  floor. That is ~2ms against a 183ms combo: **~1%**.
  Precomputing would genuinely pay only if flags were cached by candle-list
  identity ACROSS the repeated `run_window` calls in exact mode — which the
  plan does not propose.
- Engine profile: the `sum(p.qty ...)` genexprs at :290-291 are ~10% of a toy
  run and proportionally less of a real one. Other bullets are smaller still.
- `max_drawdown` local-accumulation assumption VERIFIED: written only at
  backtest.py:286, read at backtest.py:95 (to_dict, post-run) and
  sweep_apply.py:551. `Context` (strategy/base.py:17) carries no `result`.
- `ctx.last_exit_*` is already guarded by `if result.trades:` (:299-303); the
  proposed len-change guard is a smaller delta than implied.

Verdict: ~1-3% for the riskiest edits in the plan, all inside the
parity-critical loop. Poor risk/reward.

## Task 3 — unmeasured, but its STRETCH item may outrank all of Task 2

The stretch goal (thread epochs into `ExprRuleStrategy` so the per-bar gate at
`strategy/expr/strategy.py:96` stops calling `.timestamp()`) sits in the per-bar
hot path that the expr measurement above shows is where engine time actually
goes, and `.timestamp()` measured 18.7x a float compare. Also note
`_entry_index` (strategy.py:84-90) runs a `bisect` with a lambda key per bar
while in position — same hot path, not mentioned in the plan.
Measure both before deciding on Task 3.

## Recommendation

1. Do Task 1 — real, verified, 12-32% per combo depending on schedule.
2. Drop or demote Task 2 — ~1-3% for parity-critical loop edits.
3. Measure Task 3's stretch item (and `_entry_index`) before committing; it may
   beat Task 2 outright.

## Outcome (implemented 2026-08-23)

- Task 1 shipped: 8.9x on the slicing step with shared arrays, matching the
  prototype; even the no-array fallback is 1.7x the old scan thanks to the
  bisect equity path. Equivalence pinned by tests/test_metrics_slicing_perf.py.
- Task 3 stretch measured then shipped: the gate `.timestamp()` was 1.7% of a
  real combo run and `_entry_index`'s lambda bisect up to ~5% (9.26ms vs
  1.87ms as a float bisect). Epoch arrays threaded into ExprRuleStrategy at
  the three full-run build sites: 4.1% off a combo engine run, trades
  identical. Live single-bar sites keep the legacy path (array build would
  cost more than one bar saves).
- Task 2 dropped per the analysis above (~1% for parity-critical edits).
- Task 3's main items (epochs in sweep_worker._State, apply_env_combo bisect
  truncation) NOT done: ~2% per combo for a much wider touch surface; revisit
  only if combo throughput matters again.
