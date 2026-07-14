# Monthly Results Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "By month" table to the backtest Analysis → Context tab that breaks trades down by calendar month, shown only when the run spans two or more distinct months.

**Architecture:** The backend `compute_analysis` gains a `month_stats` helper that groups trades by the UTC calendar month of `entry_time` into `_rows`-shaped rows (chronologically sorted), returning `[]` for single-month runs. The frontend adds one entry to the existing Context section list and renders it through the shared `RowsTable`, hiding the section when fewer than two month rows exist. No schema change and no new UI component.

**Tech Stack:** Python (pytest) backend, React + TypeScript (vitest) frontend.

## Global Constraints

- No em dash and no "--" as punctuation anywhere in code, comments, copy, or tests.
- Reuse the shared `RowsTable`; do not build a new table or a bar chart.
- Win-rate / expectancy / low-sample semantics must match the backend `_rows` definitions exactly (`pnl > 0` win, mean `pnl` expectancy, `n < LOW_SAMPLE_N` low sample; `LOW_SAMPLE_N` is 5).
- Month bucket key is `YYYY-MM` in UTC, derived from each trade's `entry_time` (unix seconds).
- The section is shown only when `month_stats` has two or more rows; otherwise the whole section is omitted (no "No data." placeholder).
- Do not touch the unrelated in-flight files (`BacktestSettingsModal.tsx`, `backtestSchedule*`).
- Frontend typecheck via `npx tsc -b` (pre-existing errors only, zero new).

---

### Task 1: Backend `month_stats`

**Files:**
- Modify: `backend/auto_trader/engine/analysis.py` (add `_month_stats`, wire into `compute_analysis` return dict)
- Modify: `backend/tests/test_analysis.py` (extend the `_t` helper with `entry_time`; add month tests)

**Interfaces:**
- Consumes: existing module constant `LOW_SAMPLE_N` (value 5) in `analysis.py`.
- Produces: `compute_analysis(trades)["month_stats"]` -> `list[dict]`, each dict shaped `{"bucket": str "YYYY-MM", "n": int, "win_rate": float, "expectancy": float, "net_pnl": float, "low_sample": bool}`, sorted by `bucket` ascending; `[]` when trades span fewer than two distinct months or carry no `entry_time`.

- [ ] **Step 1: Extend the `_t` test helper to accept `entry_time`**

In `backend/tests/test_analysis.py`, the shared `_t` helper does not currently set `entry_time`. Add an `entry_time=None` keyword and include it in the returned dict so month tests can stamp a timestamp. Change the signature line and the returned dict:

```python
def _t(pnl, *, entry=100.0, exit_=None, stop=95.0, target=None, leg="long",
       reason="rule", mae_r=None, mfe_r=None, context=None, entry_time=None):
    if exit_ is None:
        exit_ = entry + pnl  # qty 1 price move == pnl for a long
    return {
        "pnl": pnl, "leg": leg, "entry_price": entry, "exit_price": exit_,
        "stop_initial": stop, "target": target, "reason": reason,
        "mae": (mae_r or 0.0) * 5.0, "mfe": (mfe_r or 0.0) * 5.0,
        "mae_r": mae_r, "mfe_r": mfe_r, "context": context,
        "entry_time": entry_time,
    }
```

This is additive: every existing call omits `entry_time`, so they now carry `entry_time: None` (skipped by `_month_stats`, unaffecting all other sections which never read `entry_time`).

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/test_analysis.py`:

```python
from datetime import datetime, timezone


def _ts(year, month, day=15):
    """Unix seconds at noon UTC on the given calendar day."""
    return int(datetime(year, month, day, 12, tzinfo=timezone.utc).timestamp())


def test_month_stats_groups_by_calendar_month():
    trades = [
        _t(10.0, entry_time=_ts(2026, 1)),
        _t(-4.0, entry_time=_ts(2026, 1)),
        _t(6.0, entry_time=_ts(2026, 2)),
        _t(-2.0, entry_time=_ts(2026, 2)),
        _t(3.0, entry_time=_ts(2026, 2)),
    ]
    rows = compute_analysis(trades)["month_stats"]
    # Chronological order.
    assert [r["bucket"] for r in rows] == ["2026-01", "2026-02"]
    jan, feb = rows[0], rows[1]
    assert jan["n"] == 2 and jan["net_pnl"] == 6.0
    assert jan["win_rate"] == 0.5 and jan["expectancy"] == 3.0
    assert feb["n"] == 3 and feb["net_pnl"] == 7.0


def test_month_stats_empty_when_single_month():
    trades = [_t(1.0, entry_time=_ts(2026, 3)), _t(-1.0, entry_time=_ts(2026, 3, 20))]
    assert compute_analysis(trades)["month_stats"] == []


def test_month_stats_skips_missing_entry_time_and_flags_low_sample():
    # Two Jan trades (n=2 -> low_sample), five Feb trades (n=5 -> not low),
    # one trade with no entry_time is skipped entirely.
    trades = (
        [_t(1.0, entry_time=_ts(2026, 1))] * 2
        + [_t(1.0, entry_time=_ts(2026, 2))] * 5
        + [_t(9.0)]  # entry_time None -> skipped
    )
    rows = {r["bucket"]: r for r in compute_analysis(trades)["month_stats"]}
    assert set(rows) == {"2026-01", "2026-02"}
    assert rows["2026-01"]["n"] == 2 and rows["2026-01"]["low_sample"] is True
    assert rows["2026-02"]["n"] == 5 and rows["2026-02"]["low_sample"] is False
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_analysis.py -k month_stats -v`
Expected: FAIL with `KeyError: 'month_stats'` (the key does not exist yet).

- [ ] **Step 4: Implement `_month_stats` and wire it in**

In `backend/auto_trader/engine/analysis.py`, add the import at the top (after the existing `from statistics import median` line):

```python
from datetime import datetime, timezone
```

Add the helper next to `_hour_stats` (after `_hour_stats`, before `compute_analysis`):

```python
def _month_stats(trades: list[dict]) -> list[dict]:
    """Per-calendar-month rows (YYYY-MM, UTC) for the monthly breakdown.

    Same row shape and win/expectancy/low_sample definitions as _rows, but
    sorted chronologically rather than by count. Returns [] when trades span
    fewer than two distinct months, so a single-month run shows no table.
    Trades with no entry_time are skipped. Month is taken in UTC, matching how
    day_of_week is derived; a trade within hours of a month boundary could fall
    in an adjacent month under a distant timezone (accepted imprecision)."""
    groups: dict[str, list[dict]] = {}
    for t in trades:
        ts = t.get("entry_time")
        if ts is None:
            continue
        key = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m")
        groups.setdefault(key, []).append(t)
    if len(groups) < 2:
        return []
    rows = []
    for month, ts_group in sorted(groups.items()):
        pnls = [t["pnl"] for t in ts_group]
        rows.append({
            "bucket": month,
            "n": len(ts_group),
            "win_rate": sum(1 for p in pnls if p > 0) / len(ts_group),
            "expectancy": sum(pnls) / len(ts_group),
            "net_pnl": sum(pnls),
            "low_sample": len(ts_group) < LOW_SAMPLE_N,
        })
    return rows
```

Then add the key to the `compute_analysis` return dict, immediately after the `"hour_stats": _hour_stats(trades),` line:

```python
        "hour_stats": _hour_stats(trades),
        "month_stats": _month_stats(trades),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_analysis.py -v`
Expected: PASS (the three new tests plus all pre-existing analysis tests).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/engine/analysis.py backend/tests/test_analysis.py
git commit -m "feat(analysis): per-month breakdown stats"
```

---

### Task 2: Frontend "By month" section

**Files:**
- Modify: `frontend/src/api.ts` (add `month_stats?: AnalysisRow[]` to `BacktestAnalysis`)
- Modify: `frontend/src/BacktestAnalysisPanel.tsx` (add the `["month", "By month", "ctx-month"]` section entry + row-source branch + hide-when-short guard)
- Test: `frontend/src/BacktestAnalysisPanel.test.tsx`

**Interfaces:**
- Consumes: `compute_analysis(...)["month_stats"]` from Task 1 (rows shaped `{bucket, n, win_rate, expectancy, net_pnl, low_sample}` = the existing `AnalysisRow` type); the shared `RowsTable` component; the existing `collapsed` set / `toggleSection` machinery.
- Produces: no new exported symbol; renders the section inline.

- [ ] **Step 1: Add the `month_stats` field to the `BacktestAnalysis` type**

In `frontend/src/api.ts`, find the `BacktestAnalysis` interface. It already has `hour_stats?: { hour: number; n: number; wins: number; sum_pnl: number }[];`. Add directly below it:

```ts
  month_stats?: AnalysisRow[];
```

`AnalysisRow` is defined in the same file (at line ~127, before `BacktestAnalysis` at line ~182) and is already used for `exit_reasons` and `context`, so no new type is needed.

- [ ] **Step 2: Write the failing test**

The test file (`frontend/src/BacktestAnalysisPanel.test.tsx`) already defines a module-level `analysis: BacktestAnalysis` literal, a `showTab("Context")` helper (`fireEvent.click(screen.getByRole("tab", { name }))`), and uses `.toBeTruthy()` / `screen.queryByText(...)` (there is no `makeAnalysis` factory). Follow that style exactly. Add a `describe` block (or three `it` blocks inside the existing top-level `describe`). `render`, `screen`, `fireEvent`, `showTab`, and `analysis` are already in scope in this file:

```tsx
  describe("By month section", () => {
    const monthRow = (bucket: string, net_pnl: number) => ({
      bucket, n: 6, win_rate: 0.5, expectancy: net_pnl / 6, net_pnl, low_sample: false,
    });

    it("renders when two or more month rows are present", () => {
      render(
        <BacktestAnalysisPanel
          analysis={{ ...analysis, month_stats: [monthRow("2026-01", 120), monthRow("2026-02", -40)] }}
        />,
      );
      showTab("Context");
      expect(screen.getByText("By month")).toBeTruthy();
      expect(screen.getByText("2026-01")).toBeTruthy();
      expect(screen.getByText("2026-02")).toBeTruthy();
    });

    it("is hidden with fewer than two month rows", () => {
      render(
        <BacktestAnalysisPanel analysis={{ ...analysis, month_stats: [monthRow("2026-01", 120)] }} />,
      );
      showTab("Context");
      expect(screen.queryByText("By month")).toBeNull();
    });

    it("is hidden when month_stats is absent", () => {
      render(<BacktestAnalysisPanel analysis={analysis} />); // base literal has no month_stats
      showTab("Context");
      expect(screen.queryByText("By month")).toBeNull();
    });
  });
```

Note: the base `analysis` literal has no `month_stats` key, so the third test relies on the field being optional (Task 2 Step 1). The section lives on the Context sub-tab, hence `showTab("Context")` before every assertion.

- [ ] **Step 2b: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx -t "By month"`
Expected: FAIL (the "By month" label is not rendered yet, so `getByText("By month")` throws).

- [ ] **Step 3: Add the section entry and render logic**

In `frontend/src/BacktestAnalysisPanel.tsx`, the Context sections are produced by mapping over an `as const` tuple array (currently ending with `["day_of_week", "Day of week", "ctx-day-of-week"]`). Insert the month entry immediately after the `["hour_bucket", "Time of day", "ctx-hour-bucket"]` line:

```tsx
          ["hour_bucket", "Time of day", "ctx-hour-bucket"],
          ["month", "By month", "ctx-month"],
```

Then change the `.map` callback so it computes the row source once, hides the month section when short, and passes the rows to `RowsTable`. Replace the current callback body:

```tsx
      ).map(([key, label, slug]) => (
        <section key={key} className="bt-analysis-section">
          <SectionH4 slug={slug} open={!collapsed.has(slug)} onToggle={toggleSection}>
            {label}
          </SectionH4>
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
        </section>
      ))}
```

with:

```tsx
      ).map(([key, label, slug]) => {
        const rows =
          key === "month"
            ? analysis.month_stats ?? []
            : key === "day_of_week"
              ? dayOfWeekRows(analysis.context[key] ?? [])
              : key === "hour_bucket"
                ? hourBucketRows(analysis.hour_stats ?? [])
                : analysis.context[key] ?? [];
        // The monthly table only earns its place on multi-month runs; a
        // single-month run would be a one-row table that says nothing.
        if (key === "month" && rows.length < 2) return null;
        return (
          <section key={key} className="bt-analysis-section">
            <SectionH4 slug={slug} open={!collapsed.has(slug)} onToggle={toggleSection}>
              {label}
            </SectionH4>
            {!collapsed.has(slug) && <RowsTable rows={rows} />}
          </section>
        );
      })}
```

Note: `analysis.context[key]` is indexed by `key`, but `"month"` and `"hour_bucket"` are not keys of `analysis.context`. The branch order guarantees `analysis.context[key]` is only evaluated for the context-feature keys (`trend`, `vol_regime`, `session`, `candle_pattern`, `day_of_week`), so this is safe. If TypeScript narrows `key` such that `analysis.context[key]` errors for the non-context keys, keep the existing `analysis.context[key] ?? []` form as it is already used today for those keys and the new branches short-circuit first.

- [ ] **Step 4: Run the frontend tests to verify they pass**

Run: `cd frontend && npx vitest run src/BacktestAnalysisPanel.test.tsx`
Expected: PASS (the three new "By month" tests plus all pre-existing tests in the file).

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: zero new errors (pre-existing errors, if any, unchanged).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api.ts frontend/src/BacktestAnalysisPanel.tsx frontend/src/BacktestAnalysisPanel.test.tsx
git commit -m "feat(analysis): By month table in the Context tab"
```

---

## Notes for the executor

- The backend recompute path in the run store calls `compute_analysis(rec["trades"])`, so stored runs pick up `month_stats` automatically on their next read; no run-store change is needed. Trades whose stored dicts predate `entry_time` (none expected, `entry_time` is a core TradeDTO field) would simply be skipped.
- After both tasks, the section appears in the Context tab between "Time of day" and "Entry-bar pattern", collapsible and persisted under slug `ctx-month` like every other section.
