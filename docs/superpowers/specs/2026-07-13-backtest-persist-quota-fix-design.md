# Backtest persistence: bound the render-cache + surface quota failures

**Status:** Approved 2026-07-13. Implementation not started.

## Problem

Backtest trade markers (and the trades panel) disappear after switching the chart
to another timeframe — in **every** direction (coarser, finer, even back to the
run's native TF) — and **stay gone** until the backtest is re-run. Scrolling
older history in does not bring them back.

### Root cause

The per-cell localStorage entry written by `saveBacktestResult`
(`frontend/src/lib/persist/artifacts.ts`) is a **render cache** — enough to
redraw the currently-displayed cell's markers/equity/panel across TF switches and
reloads. But it stores the whole `BacktestResult`, whose `equity` array is the
dominant cost and is **unbounded by trade count**: one native-bar equity point
per traded bar. Measured on a real year-long 5m run (117 trades):

| field   | bytes     |
|---------|-----------|
| equity  | 1,446,657 (37,128 points) |
| markers | 71,905    |
| trades  | 28,769    |
| (rest)  | ~1,300    |
| **total** | **1,548,817** |

localStorage has a hard **~5 MB per-origin quota shared with all app state**
(drawings, indicators, alerts, layouts, …). Several large backtests across tabs
already fill it to ~4 MB (measured: ~1.2 MB free). When a new run's write exceeds
quota, `save()` (`frontend/src/lib/persist/core.ts:243`) **silently swallows the
`QuotaExceededError`** and writes nothing:

```ts
export function save<T>(key: string, value: T): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
  } catch {
    /* quota / serialization issues are non-fatal for persistence */
    return;                // <-- silent drop
  }
  mirrorSet(key, serialized);
}
```

During the session the panel still shows (rendered from the in-memory result),
so the failure is invisible. On a TF switch, `rehydrateBacktest` →
`loadBacktestResult` returns the stale/absent value → markers + panel vanish,
in every direction, and stay gone. Re-running renders from memory again, which
is why re-run "fixes" it.

### Why not IndexedDB / a bigger local store

Long-term, analytical storage of runs is already owned by a **separate, approved
spec** — the backend run store (`backtest_runs.db`, `GET /backtest/runs`; see
`docs/superpowers/specs/2026-07-13-strategy-analysis-design.md`). Moving the
render cache to IndexedDB would be local-only, would not advance that plan, and
would be superseded by it. This fix keeps the render cache in localStorage and
simply **bounds** it, leaving durable/analytical storage to the backend store.

## Fix

Three parts. All frontend; no backend or `equityForBars` changes.

### 1. Downsample the persisted equity curve (primary fix)

New pure helper (co-located with the other equity helpers in
`frontend/src/lib/backtest.ts`, exported for tests):

```ts
export const EQUITY_PERSIST_CAP = 2000;

/** Downsample an ascending equity series to at most `cap` points for
 * persistence. Uniform stride, always keeping the first and last point;
 * values rounded to 2 dp (account-currency precision). Pure. A series already
 * at/under the cap is only value-rounded, not thinned. `equityForBars`
 * carry-forward renders the thinned series as a staircase, which reads smooth
 * over the full range and stays legible when zoomed. */
export function downsampleEquity(
  points: readonly EquityPoint[],
  cap = EQUITY_PERSIST_CAP,
): EquityPoint[];
```

- Round `value` to 2 dp; keep `time` as-is.
- If `points.length <= cap`: return the value-rounded series unchanged (no thinning).
- Else: uniform stride `step = ceil(n / cap)`, always include index 0 and n-1.

Applied in `saveBacktestResult` (the same place `candles` is stripped):

```ts
const stored: StoredBacktestResult = {
  ...result,
  equity: downsampleEquity(result.equity),
  period,
  showEquity,
};
delete (stored as Partial<BacktestResult>).candles;
```

Effect: ~1.45 MB → ~60 KB per result (~20×). Fresh runs already render the
*stored* copy (`runAndRender`, `backtest.ts:980` `loadBacktestResult(...) ?? result`),
so in-session and reloaded equity panes match — the overview pane does not need
per-bar fidelity.

Scope note: only `equity` is unbounded by trade count. `markers`/`trades` scale
with trade count (bounded by the strategy) and are left full-fidelity — markers
carry exact fill placement + trade linkage.

### 2. Surface quota failures (never silently drop a write)

- `save<T>(key, value): boolean` — return `true` on success, `false` when the
  write is dropped (quota/serialization). **Non-breaking**: existing callers
  ignore the return. On failure, `console.warn` the key and serialized length so
  the drop is visible in logs.
- `saveBacktestResult(...): boolean` — propagate `save()`'s result.
- `runAndRender` — when `saveBacktestResult` returns `false`, show a toast
  (`frontend/src/lib/notify.ts` `toast(...)`):
  `"Backtest too large to save — it won't persist across timeframe switches or reloads."`
  The in-session render still works (in-memory result); the user is warned it
  won't survive a switch. Making an unpersistable result survive is the backend
  run store's job, out of scope here.

### 3. Self-heal existing oversized entries

The store is already ~4 MB of pre-fix full-equity results, so the live bug
persists until those are re-run. Enforce the bound on read: in
`loadBacktestResult`, if the loaded result's `equity.length > EQUITY_PERSIST_CAP`,
downsample it in memory **and best-effort re-save** the slim version. Space is
reclaimed as each cell rehydrates — no separate migration script or app-init
pass.

Note: this rewrites existing saved runs' equity to the coarser curve (accepted by
the user, per the no-legacy-code rule that touching old data is flagged first).

## Testing

Unit (vitest):
- `downsampleEquity`: returns ≤ cap; keeps first+last; preserves ascending order;
  no thinning at/under cap; rounds values to 2 dp; empty input → empty.
- `save()` returns `false` when `localStorage.setItem` throws (mock/stub), `true`
  otherwise; still mirrors on success only.
- `saveBacktestResult` round-trip: a >cap-equity result loads back with
  `equity.length <= cap`; other fields intact; `candles` absent.
- `loadBacktestResult` self-heal: an oversized stored entry loads slim AND the
  rewritten localStorage entry is now ≤ cap.
- Existing `equityForBars` tests stay green (no semantic change).

Manual (browser, dev server):
- Reproduce the original bug is now impossible for a fitting result: run a
  backtest, switch TF in each direction, confirm markers + panel survive.
- Force the quota path (near-full store) and confirm the toast fires and the
  console warns, rather than a silent vanish.
- Confirm existing large entries shrink after rehydrate (localStorage size drops).

## Non-goals

- Backend run store (separate approved spec).
- LRU/eviction of old results — unneeded once `equity` is bounded; the toast
  covers the residual edge where the shared quota is still exhausted by other state.
- Changing `equityForBars` semantics or downsampling `markers`/`trades`.
