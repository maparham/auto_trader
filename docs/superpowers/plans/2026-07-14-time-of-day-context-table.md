# Time-of-Day Context Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Time of day" table to the backtest Analysis → Context tab that breaks trades into six 4-hour buckets aligned to the viewer's local midnight, showing the same Trades / Win rate / Expectancy / Net P&L columns as the Session table.

**Architecture:** The backend emits per-UTC-hour sufficient statistics (`hour_stats`) because local-midnight bucket alignment depends on the viewer's timezone. The frontend regroups those additive stats into local-aligned 4-hour windows and renders them through the existing `RowsTable`.

**Tech Stack:** Python (pytest) backend; React + TypeScript (vitest + Testing Library) frontend.

## Global Constraints

- No em dash and no "--" as punctuation anywhere in code, comments, copy, or tests. Rephrase with colon, comma, or period.
- Reuse the shared `RowsTable`; do not build a new table.
- Win-rate / expectancy / low-sample semantics must match the backend `_rows` definitions exactly: a win is `pnl > 0` (plain sign), expectancy is mean pnl, low sample is `n < 5` (`LOW_SAMPLE_N`).
- Buckets are 4 hours wide, six of them, aligned to local midnight, chronological, non-empty only.
- Do not touch the unrelated in-flight files: `frontend/src/BacktestSettingsModal.tsx`, `frontend/src/lib/backtestSchedule.ts`, `frontend/src/lib/backtestSchedule.test.ts`.
- Frontend typecheck via `npx tsc -b`: pre-existing errors only, zero new.

---

### Task 1: Backend `hour_stats` sufficient statistics

**Files:**
- Modify: `backend/auto_trader/engine/analysis.py`
- Test: `backend/tests/test_analysis.py`

**Interfaces:**
- Consumes: trade dicts carrying `pnl` and `context.hour_utc` (already produced by `context_features.enrich_trades`).
- Produces: `_hour_stats(trades: list[dict]) -> list[dict]`, and a new `"hour_stats"` key in the `compute_analysis` return dict. Each element: `{"hour": int, "n": int, "wins": int, "sum_pnl": float}`, sorted by hour ascending. `wins` counts `pnl > 0`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_analysis.py` (the `_t` helper there takes `pnl` and `context=`):

```python
def test_hour_stats_groups_by_hour_utc():
    trades = [
        _t(5.0, context={"hour_utc": 9}),
        _t(-2.0, context={"hour_utc": 9}),
        _t(3.0, context={"hour_utc": 14}),
        _t(-1.0, context=None),          # no context -> excluded
        _t(4.0, context={"trend": "up"}),  # context present but no hour_utc -> excluded
    ]
    a = compute_analysis(trades)
    rows = {r["hour"]: r for r in a["hour_stats"]}
    assert set(rows) == {9, 14}
    assert rows[9] == {"hour": 9, "n": 2, "wins": 1, "sum_pnl": 3.0}
    assert rows[14] == {"hour": 14, "n": 1, "wins": 1, "sum_pnl": 3.0}


def test_hour_stats_sorted_and_empty():
    assert compute_analysis([])["hour_stats"] == []
    trades = [_t(1.0, context={"hour_utc": 20}), _t(1.0, context={"hour_utc": 3})]
    hours = [r["hour"] for r in compute_analysis(trades)["hour_stats"]]
    assert hours == [3, 20]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_analysis.py -k hour_stats -v`
Expected: FAIL with `KeyError: 'hour_stats'`.

- [ ] **Step 3: Implement the helper and wire it in**

In `backend/auto_trader/engine/analysis.py`, add the helper next to `_rows` (after `_rows`, before `compute_analysis`):

```python
def _hour_stats(trades: list[dict]) -> list[dict]:
    """Per-UTC-hour sufficient statistics for the time-of-day breakdown.

    Emits additive counts (n, wins, sum_pnl) rather than finished rows because
    the client regroups them into local-timezone-aligned buckets; win_rate and
    expectancy are derived on the client from these. A win is pnl > 0, matching
    _rows. Trades with no context or no hour_utc are skipped."""
    groups: dict[int, list[float]] = {}
    for t in trades:
        h = (t.get("context") or {}).get("hour_utc")
        if h is None:
            continue
        groups.setdefault(int(h), []).append(t["pnl"])
    return [
        {"hour": h, "n": len(pnls),
         "wins": sum(1 for p in pnls if p > 0),
         "sum_pnl": round(sum(pnls), 5)}
        for h, pnls in sorted(groups.items())
    ]
```

In the `compute_analysis` return dict, add the key (alongside `"context"`):

```python
        "context": {f: _ctx(f) for f in CONTEXT_FEATURES},
        "hour_stats": _hour_stats(trades),
        "whatif": compute_whatif(trades),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_analysis.py -k hour_stats -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the analysis + API-analysis suites to confirm no regression**

Run: `cd /Users/mahmoudparham/auto_trader/backend && .venv/bin/python -m pytest tests/test_analysis.py tests/test_api_backtest_analysis.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/engine/analysis.py backend/tests/test_analysis.py
git commit -m "feat(analysis): per-hour sufficient stats for time-of-day breakdown"
```

---

### Task 2: Frontend Time-of-day table

**Files:**
- Modify: `frontend/src/api.ts` (add `hour_stats` to `BacktestAnalysis`)
- Modify: `frontend/src/BacktestAnalysisPanel.tsx` (`hourBucketRows` helper + Context wiring)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: `analysis.hour_stats` from Task 1.
- Produces: `hourBucketRows(hourStats, offsetHours?)` returning `AnalysisRow[]`; a "Time of day" section in the Context tab.

- [ ] **Step 1: Add the TS type**

In `frontend/src/api.ts`, inside `interface BacktestAnalysis`, add (near `context`):

```ts
  hour_stats?: { hour: number; n: number; wins: number; sum_pnl: number }[];
```

- [ ] **Step 2: Write the failing tests**

In `frontend/src/BacktestAnalysisPanel.test.tsx`, import `hourBucketRows` (it will be exported in Step 4). Change the existing import of the component to also pull the helper, e.g.:

```ts
import BacktestAnalysisPanel, { hourBucketRows } from "./BacktestAnalysisPanel";
```

(If the current import is a default-only import, convert it to `import Default, { hourBucketRows } from "./BacktestAnalysisPanel";` keeping the existing default binding name.)

Add these tests (a new `describe` block at the end of the file):

```ts
describe("hourBucketRows", () => {
  it("buckets UTC-aligned at offset 0 with correct labels and derived stats", () => {
    const rows = hourBucketRows(
      [
        { hour: 1, n: 4, wins: 2, sum_pnl: 10 },
        { hour: 9, n: 6, wins: 3, sum_pnl: -12 },
      ],
      0,
    );
    const byBucket = Object.fromEntries(rows.map((r) => [r.bucket, r]));
    // hour 1 -> bucket 0 (00:00-04:00); hour 9 -> bucket 2 (08:00-12:00)
    expect(byBucket["00:00-04:00"]).toBeTruthy();
    expect(byBucket["08:00-12:00"]).toBeTruthy();
    expect(byBucket["00:00-04:00"].n).toBe(4);
    expect(byBucket["00:00-04:00"].win_rate).toBeCloseTo(0.5);
    expect(byBucket["00:00-04:00"].expectancy).toBeCloseTo(2.5);
    expect(byBucket["00:00-04:00"].net_pnl).toBeCloseTo(10);
    expect(byBucket["00:00-04:00"].low_sample).toBe(true); // n=4 < 5
    expect(byBucket["08:00-12:00"].low_sample).toBe(false); // n=6
    expect(byBucket["08:00-12:00"].net_pnl).toBeCloseTo(-12);
  });

  it("shifts buckets by a positive local offset", () => {
    // hour 1 + 2 = local 3 -> still bucket 0 (00:00-04:00);
    // hour 9 + 2 = local 11 -> bucket 2 (08:00-12:00);
    // hour 3 + 2 = local 5 -> bucket 1 (04:00-08:00)
    const rows = hourBucketRows(
      [
        { hour: 1, n: 1, wins: 1, sum_pnl: 1 },
        { hour: 3, n: 1, wins: 0, sum_pnl: -1 },
        { hour: 9, n: 1, wins: 1, sum_pnl: 2 },
      ],
      2,
    );
    const labels = rows.map((r) => r.bucket);
    expect(labels).toEqual(["00:00-04:00", "04:00-08:00", "08:00-12:00"]);
  });

  it("wraps hours near midnight and returns [] for empty input", () => {
    // hour 23 + 2 = 25 -> local 1 -> bucket 0
    const rows = hourBucketRows([{ hour: 23, n: 2, wins: 1, sum_pnl: 0 }], 2);
    expect(rows.map((r) => r.bucket)).toEqual(["00:00-04:00"]);
    expect(hourBucketRows([], 0)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: FAIL. `hourBucketRows` is not exported (import error / not a function).

- [ ] **Step 4: Implement `hourBucketRows` and export it**

In `frontend/src/BacktestAnalysisPanel.tsx`, add near `dayOfWeekRows` (after it, around line 38):

```ts
// Group per-UTC-hour stats into six local-timezone-aligned 4-hour buckets.
// offsetHours defaults to the viewer's local offset; it is a parameter so the
// bucketing is unit-testable without mocking Date. Bucketing is at hour
// granularity: for a rare half-hour timezone a UTC hour that straddles a local
// 4-hour boundary is assigned whole to one bucket by its start; whole-hour
// offsets are exact.
const HOUR_BUCKET_COUNT = 6;
const HOUR_BUCKET_WIDTH = 4;
const HOUR_LOW_SAMPLE_N = 5; // mirrors backend analysis.LOW_SAMPLE_N
const pad2 = (n: number) => String(n).padStart(2, "0");

export function hourBucketRows(
  hourStats: { hour: number; n: number; wins: number; sum_pnl: number }[],
  offsetHours = -new Date().getTimezoneOffset() / 60,
): AnalysisRow[] {
  const acc = Array.from({ length: HOUR_BUCKET_COUNT }, () => ({
    n: 0,
    wins: 0,
    sum_pnl: 0,
  }));
  for (const s of hourStats) {
    const localHour = (((s.hour + offsetHours) % 24) + 24) % 24;
    const idx = Math.floor(localHour / HOUR_BUCKET_WIDTH) % HOUR_BUCKET_COUNT;
    acc[idx].n += s.n;
    acc[idx].wins += s.wins;
    acc[idx].sum_pnl += s.sum_pnl;
  }
  const rows: AnalysisRow[] = [];
  acc.forEach((b, idx) => {
    if (b.n === 0) return;
    const start = idx * HOUR_BUCKET_WIDTH;
    const end = start + HOUR_BUCKET_WIDTH;
    rows.push({
      bucket: `${pad2(start)}:00-${pad2(end)}:00`,
      n: b.n,
      win_rate: b.wins / b.n,
      expectancy: b.sum_pnl / b.n,
      net_pnl: b.sum_pnl,
      low_sample: b.n < HOUR_LOW_SAMPLE_N,
    });
  });
  return rows;
}
```

Note: the last bucket end renders as `24:00` naturally (`pad2(24)` is `"24"`).

- [ ] **Step 5: Wire the Time-of-day section into the Context tab**

In the context-section list (currently `[["trend",...],["vol_regime",...],["session",...],["candle_pattern",...],["day_of_week",...]]`), insert the new entry right after `session`:

```tsx
          ["session", "Session", "ctx-session"],
          ["hour_bucket", "Time of day", "ctx-hour-bucket"],
          ["candle_pattern", "Entry-bar pattern", "ctx-candle-pattern"],
```

And extend the row-source branch inside the `.map`:

```tsx
          {!collapsed.has(slug) && (
            <RowsTable
              rows={
                key === "day_of_week"
                  ? dayOfWeekRows(analysis.context[key] ?? [])
                  : key === "hour_bucket"
                    ? hourBucketRows(analysis.hour_stats ?? [])
                    : analysis.context[key] ?? []
              }
            />
          )}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: all PASS, including the three new `hourBucketRows` tests and all pre-existing tests.

- [ ] **Step 7: Typecheck**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx tsc -b`
Expected: only pre-existing errors, zero new ones in `api.ts` or `BacktestAnalysisPanel.tsx`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api.ts frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx
git commit -m "feat(analysis): time-of-day context table (local-aligned 4h buckets)"
```

---

## Self-Review Notes

- **Spec coverage:** backend `_hour_stats` + wiring + exclusion of context-less trades + empty `[]` (Task 1); frontend type, `hourBucketRows` with local-offset regrouping, non-empty-chronological rows, mirrored win-rate/expectancy/low-sample, Context-tab wiring after Session (Task 2). All covered.
- **Semantics parity:** `wins = pnl > 0`, `expectancy = sum_pnl/n`, `low_sample = n < 5` match the backend `_rows` and `LOW_SAMPLE_N=5`.
- **Type consistency:** `hour_stats` element shape `{hour, n, wins, sum_pnl}` is identical in `api.ts`, the backend helper, and the test fixtures. `hourBucketRows` returns `AnalysisRow[]`, exactly what `RowsTable` consumes.
- **Testability:** `offsetHours` is an explicit parameter, so the frontend tests never touch `Date` or the ambient timezone.
