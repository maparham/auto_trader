# Backtest Persistence Quota Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop backtest trade markers from vanishing after a timeframe switch by bounding the per-cell localStorage render cache (downsampling its unbounded equity array), and never silently drop a persistence write again.

**Architecture:** The per-cell localStorage entry is a render cache; its `equity` array (~1.45 MB / 37 K points, unbounded by trade count) overflows the shared ~5 MB quota, so `save()` silently swallows `QuotaExceededError` and a later rehydrate loads null. We add a pure `downsampleEquity` helper (own module, to avoid a `backtest → persist → backtest` import cycle), apply it in `saveBacktestResult`, make `save()` report failures (boolean + `console.warn`) with a user toast on backtest-save failure, and self-heal already-oversized entries on load.

**Tech Stack:** TypeScript, React 19, klinecharts, vitest (node env with `installMemStorage` in-memory localStorage).

## Global Constraints

- `EQUITY_PERSIST_CAP = 2000` — the persisted equity point cap (exact value).
- Equity `value` rounded to 2 decimal places on persist (account-currency precision).
- `save<T>()` signature change to return `boolean` MUST be non-breaking: existing callers that ignore the return keep compiling.
- Do NOT change `equityForBars` semantics, and do NOT downsample `markers` or `trades`.
- Tests run in the `node` vitest environment; any test touching `localStorage` must `installMemStorage()` from `./testMemStorage` BEFORE importing the module under test, mirroring `src/lib/persist.test.ts`.
- Run a single test file with: `npx vitest run <path>` (full suite: `npm run test:unit`). Commands below are run from `frontend/`.

---

### Task 1: `downsampleEquity` pure helper + export `EquityPoint`

**Files:**
- Modify: `frontend/src/api.ts:95` (add `export` to `interface EquityPoint`)
- Create: `frontend/src/lib/equityDownsample.ts`
- Test: `frontend/src/lib/equityDownsample.test.ts`

**Interfaces:**
- Consumes: `EquityPoint` (`{ time: number; value: number }`) from `../api`.
- Produces: `EQUITY_PERSIST_CAP: number` and `downsampleEquity(points: readonly EquityPoint[], cap?: number): EquityPoint[]` — used by Task 3 (`persist/artifacts.ts`).

- [ ] **Step 1: Export `EquityPoint`**

In `frontend/src/api.ts`, change line 95 from:

```ts
interface EquityPoint {
  time: number;
  value: number;
}
```

to:

```ts
export interface EquityPoint {
  time: number;
  value: number;
}
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/lib/equityDownsample.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { downsampleEquity, EQUITY_PERSIST_CAP } from "./equityDownsample";
import type { EquityPoint } from "../api";

const series = (n: number): EquityPoint[] =>
  Array.from({ length: n }, (_, i) => ({ time: 1000 + i, value: i + 0.123456 }));

describe("downsampleEquity", () => {
  it("returns empty for empty input", () => {
    expect(downsampleEquity([])).toEqual([]);
  });

  it("at/under the cap: keeps all points but rounds values to 2 dp", () => {
    const out = downsampleEquity(series(5), 10);
    expect(out).toHaveLength(5);
    expect(out[0].value).toBe(0.12);
    expect(out[4].value).toBe(4.12);
    expect(out.map((p) => p.time)).toEqual([1000, 1001, 1002, 1003, 1004]);
  });

  it("over the cap: thins to <= cap+1 and preserves first and last", () => {
    const n = 37128;
    const out = downsampleEquity(series(n), EQUITY_PERSIST_CAP);
    expect(out.length).toBeLessThanOrEqual(EQUITY_PERSIST_CAP + 1);
    expect(out.length).toBeGreaterThan(1000);
    expect(out[0].time).toBe(1000);
    expect(out[out.length - 1].time).toBe(1000 + n - 1); // last point always kept
  });

  it("keeps ascending time order", () => {
    const out = downsampleEquity(series(10000), 500);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].time).toBeGreaterThan(out[i - 1].time);
    }
  });

  it("defaults cap to EQUITY_PERSIST_CAP", () => {
    expect(downsampleEquity(series(50000)).length).toBeLessThanOrEqual(EQUITY_PERSIST_CAP + 1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/equityDownsample.test.ts`
Expected: FAIL — cannot resolve `./equityDownsample`.

- [ ] **Step 4: Write minimal implementation**

Create `frontend/src/lib/equityDownsample.ts`:

```ts
// Bound the persisted backtest equity curve. The per-cell localStorage entry is a
// render cache; equity is its only array unbounded by trade count (one native-bar
// point per traded bar — ~37K over a year of 5m), so it must be thinned before it
// overflows the shared ~5MB quota. Own module (not backtest.ts) so persist/ can
// import it without a backtest -> persist -> backtest cycle.
import type { EquityPoint } from "../api";

// Max persisted equity points. equityForBars carry-forward renders the thinned
// series as a staircase — ~2000 steps read smooth over the full range and stay
// legible when zoomed. Tunable; see the design doc.
export const EQUITY_PERSIST_CAP = 2000;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Downsample an ascending equity series to at most ~cap points for persistence.
 * Uniform stride, always keeping the first and last point; values rounded to 2 dp.
 * A series already at/under the cap is only value-rounded, not thinned. Pure. */
export function downsampleEquity(
  points: readonly EquityPoint[],
  cap: number = EQUITY_PERSIST_CAP,
): EquityPoint[] {
  const n = points.length;
  if (n <= cap) return points.map((p) => ({ time: p.time, value: round2(p.value) }));
  const step = Math.ceil(n / cap);
  const out: EquityPoint[] = [];
  for (let i = 0; i < n; i += step) {
    out.push({ time: points[i].time, value: round2(points[i].value) });
  }
  // The stride may skip the final point; the last realized equity must survive.
  const last = points[n - 1];
  if (out.length === 0 || out[out.length - 1].time !== last.time) {
    out.push({ time: last.time, value: round2(last.value) });
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/equityDownsample.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/lib/equityDownsample.ts src/lib/equityDownsample.test.ts
git commit -m "feat(backtest): downsampleEquity helper + export EquityPoint"
```

---

### Task 2: `save()` reports dropped writes

**Files:**
- Modify: `frontend/src/lib/persist/core.ts:243-253` (`save`)
- Test: `frontend/src/lib/persist/core.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `save<T>(key: string, value: T): boolean` — returns `true` when the localStorage write committed, `false` when it was dropped (quota/serialization). Task 3 relies on this return.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/persist/core.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installMemStorage } from "../testMemStorage";

installMemStorage();
const { save } = await import("./core");

beforeEach(() => localStorage.clear());

describe("save()", () => {
  it("returns true and writes on success", () => {
    expect(save("auto-trader.k", { a: 1 })).toBe(true);
    expect(localStorage.getItem("auto-trader.k")).toBe('{"a":1}');
  });

  it("returns false when setItem throws (quota) and does not throw", () => {
    const orig = localStorage.setItem.bind(localStorage);
    // Simulate a quota-exceeded write.
    localStorage.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    try {
      expect(save("auto-trader.big", { a: 1 })).toBe(false);
    } finally {
      localStorage.setItem = orig;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/persist/core.test.ts`
Expected: FAIL — the success case fails because `save` currently returns `undefined`, not `true`.

- [ ] **Step 3: Change `save` to return boolean and warn on failure**

In `frontend/src/lib/persist/core.ts`, replace the `save` function (lines 243-253):

```ts
export function save<T>(key: string, value: T): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
  } catch {
    /* quota / serialization issues are non-fatal for persistence */
    return;
  }
  mirrorSet(key, serialized); // best-effort backend mirror (fire-and-forget)
}
```

with:

```ts
// Returns true when the localStorage write committed, false when it was dropped
// (quota exceeded or a non-serializable value). A dropped write is non-fatal to
// the running session (the in-memory state still renders) but means the data
// won't survive a reload/switch — callers that care (e.g. large backtest results)
// check the return and surface it. Historically this swallowed the failure
// silently, which hid backtest-too-large data loss behind a later rehydrate.
export function save<T>(key: string, value: T): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
  } catch (err) {
    console.warn(
      `[persist] dropped write for "${key}" (${
        typeof value === "object" ? "quota/serialization" : "serialization"
      })`,
      err,
    );
    return false;
  }
  mirrorSet(key, serialized); // best-effort backend mirror (fire-and-forget)
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/persist/core.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify no existing caller broke (return type is additive)**

Run: `npx vitest run src/lib/persist.test.ts && npx tsc -b --noEmit`
Expected: PASS / no type errors (all existing `save(...)` calls ignore the new return).

- [ ] **Step 6: Commit**

```bash
git add src/lib/persist/core.ts src/lib/persist/core.test.ts
git commit -m "feat(persist): save() returns false + warns on dropped write"
```

---

### Task 3: Downsample on save + self-heal on load

**Files:**
- Modify: `frontend/src/lib/persist/artifacts.ts:58-74` (`loadBacktestResult`, `saveBacktestResult`)
- Test: `frontend/src/lib/persist/artifacts.test.ts` (create)

**Interfaces:**
- Consumes: `downsampleEquity`, `EQUITY_PERSIST_CAP` (Task 1); `save`, `load` (`./core`, Task 2).
- Produces: `saveBacktestResult(...): boolean` (was `void`) — used by Task 4. `loadBacktestResult` unchanged signature but now self-heals oversized entries.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/persist/artifacts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "../testMemStorage";
import { EQUITY_PERSIST_CAP } from "../equityDownsample";

installMemStorage();
const { saveBacktestResult, loadBacktestResult } = await import("./artifacts");
const { save } = await import("./core");

beforeEach(() => localStorage.clear());

// Minimal BacktestResult-shaped object with an oversized equity array + candles.
const bigResult = (nEquity: number) =>
  ({
    epic: "US100",
    resolution: "MINUTE_5",
    candles: Array.from({ length: 10 }, (_, i) => ({ timestamp: i, open: 1, high: 1, low: 1, close: 1, volume: 0 })),
    markers: [],
    trades: [],
    equity: Array.from({ length: nEquity }, (_, i) => ({ time: 1000 + i, value: i + 0.111 })),
    summary: { net_pnl: 0, n_trades: 0, win_rate: 0, max_drawdown: 0 },
    metrics: {} as never,
  }) as unknown as import("../../api").BacktestResult;

const KEY = "auto-trader.tab.A.backtest.US100";

describe("saveBacktestResult / loadBacktestResult", () => {
  it("downsamples equity to <= cap and strips candles on save", () => {
    const ok = saveBacktestResult("tab.A", "US100", bigResult(37128));
    expect(ok).toBe(true);
    const loaded = loadBacktestResult("tab.A", "US100")!;
    expect(loaded.equity.length).toBeLessThanOrEqual(EQUITY_PERSIST_CAP + 1);
    expect((loaded as { candles?: unknown }).candles).toBeUndefined();
    expect(loaded.equity[0].time).toBe(1000);
  });

  it("returns false when the underlying write is dropped", () => {
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    try {
      expect(saveBacktestResult("tab.A", "US100", bigResult(10))).toBe(false);
    } finally {
      localStorage.setItem = orig;
    }
  });

  it("self-heals an already-oversized stored entry on load (downsamples + rewrites)", () => {
    // Write a pre-fix oversized entry DIRECTLY (bypassing saveBacktestResult) to
    // simulate data saved before this fix.
    const oversized = { ...bigResult(37128) };
    delete (oversized as { candles?: unknown }).candles;
    save(KEY, oversized);
    expect(JSON.parse(localStorage.getItem(KEY)!).equity.length).toBe(37128);

    const loaded = loadBacktestResult("tab.A", "US100")!;
    expect(loaded.equity.length).toBeLessThanOrEqual(EQUITY_PERSIST_CAP + 1);
    // The rewrite reclaimed space: the stored entry is now slim too.
    expect(JSON.parse(localStorage.getItem(KEY)!).equity.length).toBeLessThanOrEqual(
      EQUITY_PERSIST_CAP + 1,
    );
  });

  it("leaves an already-slim entry untouched on load", () => {
    saveBacktestResult("tab.A", "US100", bigResult(50));
    const before = localStorage.getItem(KEY);
    loadBacktestResult("tab.A", "US100");
    expect(localStorage.getItem(KEY)).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/persist/artifacts.test.ts`
Expected: FAIL — `saveBacktestResult` returns `undefined` (not `true`) and stored equity length is 37128 (no downsample).

- [ ] **Step 3: Add the import**

In `frontend/src/lib/persist/artifacts.ts`, after the existing `./core` import (line 10), add:

```ts
import { downsampleEquity, EQUITY_PERSIST_CAP } from "../equityDownsample";
```

- [ ] **Step 4: Rewrite `loadBacktestResult` and `saveBacktestResult`**

Replace lines 58-74 (`loadBacktestResult` + `saveBacktestResult`):

```ts
export function loadBacktestResult(scope: string, epic: string): StoredBacktestResult | null {
  return load<StoredBacktestResult | null>(backtestKey(scope, epic), null);
}
export function saveBacktestResult(
  scope: string,
  epic: string,
  result: BacktestResult,
  period?: BacktestPeriod,
  showEquity?: boolean,
): void {
  // Strip the bulky candle array before persisting — redraw doesn't need it
  // (markers/equity/periods attach to whatever bars are loaded by absolute
  // timestamp).
  const stored: StoredBacktestResult = { ...result, period, showEquity };
  delete (stored as Partial<BacktestResult>).candles;
  save(backtestKey(scope, epic), stored);
}
```

with:

```ts
export function loadBacktestResult(scope: string, epic: string): StoredBacktestResult | null {
  const key = backtestKey(scope, epic);
  const stored = load<StoredBacktestResult | null>(key, null);
  // Self-heal entries saved before the equity cap existed: downsample in memory
  // AND best-effort rewrite the slim copy, reclaiming the shared quota as each
  // cell rehydrates (no separate migration pass).
  if (stored && stored.equity && stored.equity.length > EQUITY_PERSIST_CAP) {
    const slim: StoredBacktestResult = { ...stored, equity: downsampleEquity(stored.equity) };
    save(key, slim); // best-effort; also re-mirrors the slimmed value
    return slim;
  }
  return stored;
}
export function saveBacktestResult(
  scope: string,
  epic: string,
  result: BacktestResult,
  period?: BacktestPeriod,
  showEquity?: boolean,
): boolean {
  // Strip the bulky candle array and bound the equity curve before persisting —
  // redraw doesn't need candles (markers/equity/periods attach to whatever bars
  // are loaded by absolute timestamp), and the full per-bar equity array is the
  // one field unbounded by trade count, so it must be capped to fit the shared
  // localStorage quota. Returns false when the write was dropped (quota) so the
  // caller can warn the user it won't survive a switch/reload.
  const stored: StoredBacktestResult = {
    ...result,
    equity: downsampleEquity(result.equity),
    period,
    showEquity,
  };
  delete (stored as Partial<BacktestResult>).candles;
  return save(backtestKey(scope, epic), stored);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/persist/artifacts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify types + existing persist tests**

Run: `npx tsc -b --noEmit && npx vitest run src/lib/persist.test.ts`
Expected: no type errors; existing persist tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/persist/artifacts.ts src/lib/persist/artifacts.test.ts
git commit -m "feat(backtest): cap persisted equity + self-heal oversized entries"
```

---

### Task 4: Surface the failure in the UI (toast)

**Files:**
- Modify: `frontend/src/lib/backtest.ts:971` (consume `saveBacktestResult`'s return in `runAndRender`)
- Modify: `frontend/src/lib/backtest.ts` import block (add `toast`)

**Interfaces:**
- Consumes: `saveBacktestResult(...): boolean` (Task 3); `toast(message: string): void` from `./notify`.
- Produces: nothing downstream.

- [ ] **Step 1: Add the `toast` import**

In `frontend/src/lib/backtest.ts`, add near the other `./` imports (e.g. after the `./backtestInspect` import on line 28):

```ts
import { toast } from "./notify";
```

- [ ] **Step 2: Consume the save result and warn the user**

In `frontend/src/lib/backtest.ts`, replace line 971:

```ts
  saveBacktestResult(scope, req.epic, result, period, showEquity);
```

with:

```ts
  // Persist so markers/equity/trades survive a timeframe switch and a full reload.
  // If the write was dropped (localStorage quota exhausted — several large runs
  // across cells share the ~5MB budget), the in-memory render below still works,
  // but a later rehydrate would find nothing: warn the user rather than let the
  // markers silently vanish on their next TF switch.
  if (!saveBacktestResult(scope, req.epic, result, period, showEquity)) {
    toast("Backtest too large to save — it won't persist across timeframe switches or reloads.");
  }
```

- [ ] **Step 3: Verify types + full unit suite**

Run: `npx tsc -b --noEmit && npm run test:unit`
Expected: no type errors; full suite PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/backtest.ts
git commit -m "feat(backtest): toast when a run is too large to persist"
```

- [ ] **Step 5: Manual browser verification (dev server on :5173)**

Verify the original bug is fixed and the new safeguards work:

1. **Markers survive a switch:** Run a backtest, then switch the chart TF coarser, finer, and back to native. Confirm markers/aggregate pills + the trades panel persist each time (no vanish).
2. **Self-heal reclaims space:** In the console, before/after rehydrating existing cells, compare:
   ```js
   Object.keys(localStorage).filter(k => k.includes('.backtest.'))
     .map(k => ({ k, len: localStorage.getItem(k).length }))
   ```
   Oversized pre-fix entries (e.g. the 1.5 MB `CrudeOIL`) should shrink to tens of KB after their cell loads.
3. **Quota toast fires (not a silent vanish):** Temporarily fill storage near the limit, e.g.:
   ```js
   try { localStorage.setItem('__fill__', 'x'.repeat(4_500_000)); } catch(e) { console.log(e.name); }
   ```
   then run a backtest large enough to exceed the remainder and confirm the toast appears and a `[persist] dropped write` warning is logged. Clean up with `localStorage.removeItem('__fill__')`.

---

## Self-Review

**Spec coverage:**
- Part 1 (downsample persisted equity, cap 2000, applied in `saveBacktestResult`) → Task 1 (helper) + Task 3 (wire-in). ✓
- Part 2 (`save()` reports failure; `runAndRender` toast) → Task 2 (`save` boolean + warn) + Task 4 (toast). ✓
- Part 3 (self-heal oversized entries on load) → Task 3 (`loadBacktestResult`). ✓
- Testing (downsample unit; save() false-on-throw; saveBacktestResult round-trip ≤ cap; self-heal rewrite; equityForBars stay green) → Tasks 1–3 tests + Task 4 full-suite run. ✓
- Non-goals (no backend store, no eviction, no `equityForBars`/marker/trade changes) → respected; `equityForBars` untouched. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `EquityPoint {time,value}` exported (Task 1) and consumed in Tasks 1/3; `downsampleEquity`/`EQUITY_PERSIST_CAP` names identical across Tasks 1/3; `save():boolean` (Task 2) consumed by `saveBacktestResult():boolean` (Task 3) consumed in `runAndRender` (Task 4); `toast(string)` matches `notify.ts`. ✓

**Deviation from spec (intentional):** `downsampleEquity` lives in its own `equityDownsample.ts`, not `backtest.ts`, to avoid a `backtest → persist → backtest` import cycle (persist is a lower layer). Behavior is unchanged.
