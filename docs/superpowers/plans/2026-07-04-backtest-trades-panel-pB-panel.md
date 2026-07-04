# Backtest trades panel — Phase B (panel shell) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A collapsible bottom panel that shows a backtest's results — an Overview metric grid and a sortable Trades list — fed by the run result, with no chart-sync yet (that's Phase C).

**Architecture:** `BacktestButton` publishes its `BacktestResult` on a new `backtestResultSignal`. A pure `backtestPanelData.ts` turns that result into display rows (metrics + formatted trades + sort). `BacktestPanel.tsx` subscribes and renders two tabs. It mounts below the chart in `App.tsx`. The scrollable trades table uses the flex-scroll discipline that fixed the `.bt-body` collapse.

**Tech Stack:** TypeScript, React, Vitest.

## Global Constraints

- **Off/empty is silent:** when `backtestResultSignal` is `null` (no run yet, or cleared), the panel renders nothing — no empty box.
- **Numbers consistent with the chip:** Overview renders the backend `result.summary` (net_pnl, n_trades, win_rate, max_drawdown) and `result.metrics` (the 12 fields from Phase A) — never recomputed in TS.
- **Flex-scroll discipline (learned this session):** the trades table's scroll area gets `flex: 1; overflow-y: auto; min-height: 0`, and every flex ancestor down to it gets `min-height: 0`, so it scrolls instead of squashing neighbours or collapsing.
- **Concurrency:** `App.tsx` and `App.css` are edited by a concurrent session — read them fresh immediately before editing, commit with explicit pathspec, never stage the other session's files.
- Gate: `cd frontend && npx tsc -b` — zero NEW errors in touched files (~20 pre-existing unrelated errors exist; ignore them). Vitest for the pure helper.
- Commit trailers:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_016y32p7zCcaDA1F6c5HkHz5`.

---

## File Structure

- Modify `frontend/src/lib/signals.ts` — add `backtestResultSignal`.
- Modify `frontend/src/BacktestButton.tsx` — publish result on run / null on clear.
- Create `frontend/src/lib/backtestPanelData.ts` — pure: metric rows, trade rows, sort.
- Create `frontend/src/lib/backtestPanelData.test.ts`.
- Create `frontend/src/BacktestPanel.tsx` — the panel component.
- Modify `frontend/src/App.tsx` — mount the panel; `frontend/src/App.css` — panel styles.

---

### Task 1: result signal + publishing

**Files:**
- Modify: `frontend/src/lib/signals.ts`, `frontend/src/BacktestButton.tsx`

**Interfaces:**
- Produces: `export const backtestResultSignal = new Signal<BacktestResult | null>(null)`. `BacktestButton` calls `backtestResultSignal.set(res)` after a successful run and `backtestResultSignal.set(null)` in `clear()` and in the symbol/timeframe-change reset effect.

- [ ] **Step 1: Add the signal**

In `frontend/src/lib/signals.ts`, following the existing `new Signal<T>(default)` pattern (e.g. `tradesSignal`), add (import the type):
```ts
import type { BacktestResult } from "../api";
export const backtestResultSignal = new Signal<BacktestResult | null>(null);
```
(Place the import with the other type imports; if `../api` is already imported, extend that import.)

- [ ] **Step 2: Publish from BacktestButton**

In `frontend/src/BacktestButton.tsx`: import `backtestResultSignal` from `./lib/signals`. After the successful run (right after `setSummary(res.summary)`), add `backtestResultSignal.set(res);`. In `clear()` (right after `setSummary(null)`), add `backtestResultSignal.set(null);`. In the symbol/timeframe reset `useEffect` (the one that calls `setSummary(null)`), also add `backtestResultSignal.set(null);`.

- [ ] **Step 3: Type-check + commit**

Run: `cd frontend && npx tsc -b` → no new errors in signals.ts / BacktestButton.tsx.
```bash
git add frontend/src/lib/signals.ts frontend/src/BacktestButton.tsx
git commit -m "feat(backtest): publish the run result on a signal for the panel"  # + trailers
```

---

### Task 2: pure panel-data helper

**Files:**
- Create: `frontend/src/lib/backtestPanelData.ts`, `frontend/src/lib/backtestPanelData.test.ts`

**Interfaces:**
- Consumes: `BacktestResult` (`api.ts`).
- Produces:
  - `metricRows(res: BacktestResult): { label: string; value: string; tone: "pos"|"neg"|"" }[]` — labelled, formatted Overview rows from `res.summary` + `res.metrics`.
  - `TradeRow` type + `tradeRows(res: BacktestResult, resSeconds: number): TradeRow[]` — one per trade, with derived P&L%, duration bars, formatted times/prices, and the original index (`i`) preserved.
  - `sortTradeRows(rows: TradeRow[], key: keyof TradeRow, dir: "asc"|"desc"): TradeRow[]` — stable sort.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/backtestPanelData.test.ts
import { describe, it, expect } from "vitest";
import { metricRows, tradeRows, sortTradeRows } from "./backtestPanelData";
import type { BacktestResult } from "../api";

function result(over: Partial<BacktestResult> = {}): BacktestResult {
  return {
    epic: "X", resolution: "MINUTE", candles: [], markers: [], equity: [],
    trades: [], summary: { net_pnl: 0, n_trades: 0, win_rate: 0, max_drawdown: 0 },
    metrics: { return_pct: 0, profit_factor: null, expectancy: 0, avg_win: 0, avg_loss: 0,
      avg_win_loss_ratio: null, largest_win: 0, largest_loss: 0, max_drawdown_pct: 0,
      avg_duration_bars: 0, max_consec_wins: 0, max_consec_losses: 0 },
    ...over,
  };
}

describe("metricRows", () => {
  it("labels and tones the summary + metrics; null profit factor shows as dash", () => {
    const rows = metricRows(result({
      summary: { net_pnl: 123.4, n_trades: 4, win_rate: 0.5, max_drawdown: 20 },
      metrics: { ...result().metrics, profit_factor: null, return_pct: 1.234 },
    }));
    const byLabel = Object.fromEntries(rows.map(r => [r.label, r]));
    expect(byLabel["Net P&L"].value).toBe("+123.40");
    expect(byLabel["Net P&L"].tone).toBe("pos");
    expect(byLabel["Win rate"].value).toBe("50%");
    expect(byLabel["Profit factor"].value).toBe("—"); // null -> dash
  });
});

describe("tradeRows + sort", () => {
  const res = result({
    resolution: "MINUTE",
    trades: [
      { side: "buy", quantity: 2, entry_time: 0, entry_price: 100, exit_time: 300, exit_price: 110, pnl: 20, leg: "long", reason: "target" },
      { side: "sell", quantity: 1, entry_time: 60, entry_price: 100, exit_time: 120, exit_price: 105, pnl: -5, leg: "short", reason: "stop" },
    ] as BacktestResult["trades"],
  });
  it("derives pnl%, duration bars, and keeps the original index", () => {
    const rows = tradeRows(res, 60);
    expect(rows[0].i).toBe(0);
    expect(rows[0].pnl).toBe(20);
    expect(rows[0].pnlPct).toBeCloseTo(20 / (100 * 2) * 100, 6); // 10%
    expect(rows[0].durationBars).toBe(5); // 300s / 60s
    expect(rows[0].reason).toBe("target");
  });
  it("sorts by pnl descending, stably", () => {
    const rows = sortTradeRows(tradeRows(res, 60), "pnl", "desc");
    expect(rows.map(r => r.pnl)).toEqual([20, -5]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestPanelData.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the helper**

Create `frontend/src/lib/backtestPanelData.ts` implementing the three exports:
- `metricRows`: build the ordered label/value/tone list. Include, in order: Net P&L (`summary.net_pnl`, tone by sign, `+`/`−` 2dp), Return % (`metrics.return_pct`, 2dp + `%`), Trades (`summary.n_trades`), Win rate (`summary.win_rate*100` rounded, `%`), Profit factor (`metrics.profit_factor` → 2dp or `"—"` when null), Expectancy, Avg win, Avg loss, Avg win/loss (`avg_win_loss_ratio` → 2dp or `"—"`), Largest win, Largest loss, Max drawdown (`summary.max_drawdown`), Max drawdown % (`metrics.max_drawdown_pct`, 2dp+`%`), Avg duration (`metrics.avg_duration_bars`, 1dp + `" bars"`), Max consec wins, Max consec losses. Tone: `"pos"` for positive P&L-like values, `"neg"` for negative, `""` for counts/ratios. Format a signed money value as `(+|−)abs.toFixed(2)`.
- `TradeRow`: `{ i: number; side: string; leg: string; entryTime: number; entryPrice: number; exitTime: number; exitPrice: number; pnl: number; pnlPct: number; durationBars: number; reason: string }`. `tradeRows` maps `res.trades` with `pnlPct = pnl / (entry_price*quantity) * 100` (guard div-by-zero → 0) and `durationBars = (exit_time - entry_time) / resSeconds` (guard resSeconds 0 → 0), preserving array index as `i`.
- `sortTradeRows`: return a stable-sorted copy by the numeric/string key and direction (use index as tiebreaker for stability).

- [ ] **Step 4: Run to verify it passes** — `cd frontend && npx vitest run src/lib/backtestPanelData.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add frontend/src/lib/backtestPanelData.ts frontend/src/lib/backtestPanelData.test.ts
git commit -m "feat(backtest): pure panel data (metric rows, trade rows, sort)"  # + trailers
```

---

### Task 3: the `BacktestPanel` component + styles

**Files:**
- Create: `frontend/src/BacktestPanel.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes: `backtestResultSignal` (Task 1), `metricRows`/`tradeRows`/`sortTradeRows` (Task 2), `RESOLUTION_SECONDS` (`lib/feed`), `highlightTradeSignal` (deferred — Phase C; do NOT add sync here beyond a `data-trade-index` attribute + a hover handler stub is NOT required in B).
- Produces: default-exported `BacktestPanel` React component (no props; subscribes to the signal).

- [ ] **Step 1: Build the component**

Create `frontend/src/BacktestPanel.tsx`. Subscribe to `backtestResultSignal` via `useSyncExternalStore` (match how other components read a `Signal` — check `signals.ts` for a `subscribe`/`get` API, or an existing consumer like the alerts panel). If the value is `null`, render `null`. Otherwise render a bottom panel:
- A header row: two tab buttons **Overview** / **Trades** (local `useState` active tab, default Overview), the trade count, a **collapse** chevron (local `useState`, collapsed hides the body), and a **✕** that calls `backtestResultSignal.set(null)`.
- **Overview** body: render `metricRows(result)` as a wrapped grid of small label/value cards; apply the `tone` as a class (`pos`/`neg`).
- **Trades** body: a table with a sortable header (click a header → set `{key, dir}`, toggling dir; default `i` asc). Rows from `sortTradeRows(tradeRows(result, RESOLUTION_SECONDS[result.resolution] ?? 60), key, dir)`. Columns: #, Side (leg), Entry time, Entry, Exit time, Exit, P&L (toned), P&L %, Reason, Duration. Format times with the app's existing local-time formatter if one is exported (e.g. from `lib/alertUi`/`lib/feed`); otherwise `new Date(t*1000).toLocaleString()`. Put `data-trade-index={row.i}` on each `<tr>` (a hook Phase C will use). Give the scrollable table wrapper the flex-scroll discipline (see CSS).

- [ ] **Step 2: Styles**

In `frontend/src/App.css` add a `.bt-panel` block: the panel is a flex column; the trades-table wrapper is `flex: 1; overflow-y: auto; min-height: 0`; the panel and any inner flex containers get `min-height: 0`. Header/tabs reuse existing `.seg`/button styles where possible. A sensible default height (e.g. `height: 220px` when expanded, `auto`/header-only when collapsed) with `max-height: 40vh`. Match the app's borders/vars (`var(--border)`, `var(--surface)`, etc.), no shadows (house style).

- [ ] **Step 3: Type-check + commit**

Run: `cd frontend && npx tsc -b` → no new errors in the new file. (No dev server.)
```bash
git add frontend/src/BacktestPanel.tsx frontend/src/App.css
git commit -m "feat(backtest): results panel (Overview grid + sortable trades list)"  # + trailers
```

---

### Task 4: mount the panel in App

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Mount it**

Read `App.tsx` fresh. Import `BacktestPanel`. Render `<BacktestPanel />` **below the chart workspace** (after the `<main className="chart">`/`ChartGrid` block, alongside where `PositionsPanel` is used — model the placement on `PositionsPanel`). The panel self-hides when there's no result, so it can always be mounted.

- [ ] **Step 2: Type-check + commit**

Run: `cd frontend && npx tsc -b` → no new errors.
```bash
git add frontend/src/App.tsx
git commit -m "feat(backtest): mount the results panel below the chart"  # + trailers
```

---

## Self-Review

**Spec coverage:** implements Phase B of the spec — result signal + publish, pure panel-data (metrics + trades + sort, tested), the `BacktestPanel` (Overview grid + sortable Trades list, collapsible, self-hiding), mounted in App, with the flex-scroll discipline. Chart↔list sync is Phase C (the `data-trade-index` hook is left for it).

**Placeholder scan:** the component task intentionally references existing patterns (Signal subscribe API, local-time formatter, PositionsPanel placement) rather than transcribing them, because those are established in-repo conventions the implementer must match; every data transformation is fully specified in the tested Task 2 helper.

**Type consistency:** `backtestResultSignal` is `Signal<BacktestResult | null>` in Task 1 and consumed as such in Task 3. `metricRows`/`tradeRows`/`sortTradeRows` signatures match between Task 2 (definition + test) and Task 3 (use). `TradeRow.i` is the sync key Phase C will emit on `highlightTradeSignal`.
