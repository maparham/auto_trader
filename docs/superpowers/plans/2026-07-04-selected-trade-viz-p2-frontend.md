# Selected-trade viz — Phase 2 (sticky selection + zone overlay) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Clicking a trades row sticky-selects it and draws a windowed, read-only risk/reward-zone overlay (green reward box, red risk box, entry line, faint final stop, R:R + %, entry→exit) on the chart, scrolled into view.

**Architecture:** A new `selectedTradeSignal: Signal<number | null>` (sticky, distinct from the hover `highlightTradeSignal`). The panel sets it on row click and marks the selected row. `lib/backtest.ts` subscribes and draws the zone overlay for that trade from its stop/target levels (Phase 1), reusing the existing overlay create/remove + reset/identity/unmount discipline. A pure `tradeZones.ts` computes risk %, reward %, and R:R.

**Tech Stack:** TypeScript, React, klinecharts, Vitest.

## Global Constraints

- **One selection at a time; nothing persists across runs.** Selecting a new row replaces the overlay; a new run / `clearBacktest` removes it and resets `selectedTradeSignal` to null.
- **Read-only:** every overlay is `lock: true` and non-interactive (backtest artifact).
- **Windowed** to the trade (`entry_time`..`exit_time` + small padding), never full width.
- **Draw only what exists:** no risk zone without `stop_initial`; no reward zone without `target`; R:R only when both. Entry + exit always drawn. Final stop line only when `stop_final != stop_initial`.
- **Multi-cell / leak safe:** mirror the existing sync — gate emit/consume on `backtestResultSignal.value === result`; add the selection subscription to `artifacts.unsub` (released on re-run, clearBacktest, and ChartCore cell unmount).
- Gate: `cd frontend && npx tsc -b` (no new errors) + Vitest for the pure helper. `App.css`/`App.tsx` are concurrently edited — re-read before editing, explicit pathspec.
- Commit trailers: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_016y32p7zCcaDA1F6c5HkHz5`.

---

### Task 1: `selectedTradeSignal` + geometry helper + panel selection

**Files:**
- Modify: `frontend/src/lib/signals.ts`, `frontend/src/BacktestPanel.tsx`, `frontend/src/App.css`
- Create: `frontend/src/lib/tradeZones.ts`, `frontend/src/lib/tradeZones.test.ts`

**Interfaces:**
- Produces: `export const selectedTradeSignal = new Signal<number | null>(null)`. `tradeZones(t: Trade): { hasRisk, hasReward, riskPct, rewardPct, rr, stopMoved }`. The panel sets `selectedTradeSignal` on row click and adds a `selected` class to the selected row.

- [ ] **Step 1: Write the failing helper test**

```ts
// frontend/src/lib/tradeZones.test.ts
import { describe, it, expect } from "vitest";
import { tradeZones } from "./tradeZones";
import type { BacktestResult } from "../api";
type T = BacktestResult["trades"][number];
const base: T = { side: "sell", quantity: 1, entry_time: 0, entry_price: 100,
  exit_time: 60, exit_price: 96, pnl: 4, leg: "short", reason: "target",
  stop_initial: 102, stop_final: 102, target: 96 };

describe("tradeZones", () => {
  it("computes risk %, reward %, R:R (magnitudes, side-agnostic)", () => {
    const z = tradeZones(base);
    expect(z.hasRisk).toBe(true); expect(z.hasReward).toBe(true);
    expect(z.riskPct).toBeCloseTo(2, 6);    // |100-102|/100
    expect(z.rewardPct).toBeCloseTo(4, 6);  // |100-96|/100
    expect(z.rr).toBeCloseTo(2, 6);
    expect(z.stopMoved).toBe(false);
  });
  it("no target -> no reward zone, rr null", () => {
    const z = tradeZones({ ...base, target: null });
    expect(z.hasReward).toBe(false); expect(z.rewardPct).toBeNull(); expect(z.rr).toBeNull();
  });
  it("stopMoved true when final != initial", () => {
    expect(tradeZones({ ...base, stop_final: 100 }).stopMoved).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd frontend && npx vitest run src/lib/tradeZones.test.ts` → FAIL.

- [ ] **Step 3: Implement the helper + signal + panel wiring**

Create `frontend/src/lib/tradeZones.ts`:
```ts
import type { BacktestResult } from "../api";
type Trade = BacktestResult["trades"][number];
export interface TradeZones {
  hasRisk: boolean; hasReward: boolean;
  riskPct: number | null; rewardPct: number | null; rr: number | null; stopMoved: boolean;
}
const pct = (from: number, to: number) => Math.abs(to - from) / from * 100;
export function tradeZones(t: Trade): TradeZones {
  const hasRisk = t.stop_initial != null, hasReward = t.target != null;
  const riskPct = hasRisk ? pct(t.entry_price, t.stop_initial as number) : null;
  const rewardPct = hasReward ? pct(t.entry_price, t.target as number) : null;
  const rr = riskPct && rewardPct && riskPct > 0 ? rewardPct / riskPct : null;
  const stopMoved = t.stop_initial != null && t.stop_final != null && t.stop_final !== t.stop_initial;
  return { hasRisk, hasReward, riskPct, rewardPct, rr, stopMoved };
}
```

Add `export const selectedTradeSignal = new Signal<number | null>(null);` to `signals.ts` (near `highlightTradeSignal`).

In `BacktestPanel.tsx`: import `selectedTradeSignal`, read it via `useSyncExternalStore` into `selected`. Change the row `onClick` to `selectedTradeSignal.set(row.i)` (replacing the Phase-C focus seam — selection now handles scroll in Task 2). Add `selected` to the row's className when `row.i === selected` (keep the existing `highlighted` on hover). In `App.css`, add `.bt-trade-row.selected { background: var(--accent-soft, rgba(41,98,255,.10)); box-shadow: inset 2px 0 0 var(--accent); }` (read the row class name in use).

- [ ] **Step 4: Run the helper test** — PASS. **Step 5: Commit**
```bash
git add frontend/src/lib/tradeZones.ts frontend/src/lib/tradeZones.test.ts frontend/src/lib/signals.ts frontend/src/BacktestPanel.tsx frontend/src/App.css
git commit -m "feat(backtest): sticky trade selection + risk/reward geometry helper"  # + trailers
```

---

### Task 2: the windowed risk/reward zone overlay (chart)

**Files:**
- Modify: `frontend/src/lib/backtest.ts`

**Interfaces:**
- Consumes: `selectedTradeSignal` (Task 1), `tradeZones` (Task 1), `Trade` levels (Phase 1); the existing `artifactsByChart`, overlay create/remove, `scrollChartToTrade`, identity gate, and `unsub`.

- [ ] **Step 1: Extend artifacts + subscribe**

In `lib/backtest.ts`:
- Add `selectionOverlayIds: string[]` to `BacktestArtifacts` (init `[]`), and a helper to remove them all.
- In `runAndRender`, after the highlight/focus subscriptions, subscribe to `selectedTradeSignal` (fold its unsubscribe into `artifacts.unsub`). On `null` → remove all selection overlays. On index `i` (guarded by `backtestResultSignal.value === result`) → remove prior selection overlays, then draw the windowed overlay for `artifacts.trades[i]` and `scrollChartToTrade(chart, entry*1000, exit*1000)`.
- In the reset at the top of `runAndRender` / `clearBacktest`: remove selection overlays and `selectedTradeSignal.set(null)` (so a stale index can't point into new trades). Note: `clearBacktest` runs at the top of `runAndRender` and on cell unmount — resetting there covers all paths.

- [ ] **Step 2: Draw the overlay**

For the selected trade `t` (times in seconds → ×1000 for klinecharts), with `z = tradeZones(t)` and a small time pad (e.g. one bar each side, or a fraction of `exit-entry`):
- **Reward zone** (if `z.hasReward`): a locked `rect` overlay, points `[(entryTs, entry_price), (exitTs+pad, target)]`, translucent green fill, no border handles.
- **Risk zone** (if `z.hasRisk`): a locked `rect`, points `[(entryTs, entry_price), (exitTs+pad, stop_initial)]`, translucent red fill.
- **Entry** line: a locked `segment` from `(entryTs, entry_price)` to `(exitTs+pad, entry_price)`, accent color.
- **Final stop** (if `z.stopMoved`): a faint locked `segment` at `stop_final` across the window, dashed red.
- **Entry→exit segment** + entry/exit dots (reuse the transient-line style, or draw a `segment` + two small overlays).
- **Labels**: an R:R text (e.g. `R:R 1 : ${z.rr.toFixed(2)}`) near the reward zone, and `+${z.rewardPct.toFixed(1)}%` / `-${z.riskPct.toFixed(1)}%` at the TP/SL edges. Use whatever klinecharts text mechanism the codebase already uses for overlay labels (check `positionLines.ts`); if a dedicated text overlay isn't readily available, attach the labels via the zone overlays' `extendData`/`styles.text` or a `simpleAnnotation`. Push every created overlay id into `artifacts.selectionOverlayIds`.

Every overlay: `lock: true`, non-draggable. Colors: reuse `BUY_COLOR`/`SELL_COLOR` (green/red) at low alpha for fills; the accent for entry.

- [ ] **Step 3: Gate + commit**

Run `cd frontend && npx tsc -b` → no new errors. Reason through: click a row → zones appear windowed + chart scrolls; click another → replaces; run/clear → gone; cell unmount → subscription released. If klinecharts lacks a `rect` overlay name in this version, fall back to a `polygon`/four-point overlay or two filled `segment`s — check `node_modules/klinecharts` for the registered overlay names and state which you used.
```bash
git add frontend/src/lib/backtest.ts
git commit -m "feat(backtest): windowed risk/reward zone overlay for the selected trade"  # + trailers
```

---

## Self-Review

**Spec coverage:** Phase 2 — sticky `selectedTradeSignal` + selected-row state + click-to-select-and-scroll; the windowed read-only risk/reward zone overlay (reward/risk boxes, entry line, faint final stop, entry→exit, R:R + %), draw-only-what-exists, with the same reset/identity/unmount discipline as the existing sync. Hover preview (Phase C) is unchanged.

**Placeholder scan:** the overlay task references the codebase's existing overlay-name/label mechanisms (rect/segment/simpleAnnotation, `positionLines.ts` labels) rather than hardcoding a klinecharts API that may vary by version — with an explicit fallback and a requirement to state what was used. Geometry is fully specified and tested in Task 1.

**Type consistency:** `selectedTradeSignal: Signal<number | null>` (Task 1) consumed in Task 2. `tradeZones(Trade)` fields used by the overlay match the helper. `Trade.stop_initial/stop_final/target` come from Phase 1. Selection index === `TradeRow.i` === `artifacts.trades[]` index.
