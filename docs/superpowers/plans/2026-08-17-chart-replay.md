# Chart Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TradingView-style bar replay in a single chart cell — jump to a point in the past, play closed bars forward with no knowledge of what comes next, trade it manually, and see a report card on exit.

**Architecture:** Frontend-driven slicing. A per-cell hook (`chart/useReplay.ts`) holds the replay bars locally and paints only the bars closed at or before the cursor through the existing v10 data facade. The `useLiveMarketData` load effect gains one branch: while a cell is replaying it loads replay bars instead of recent history and never opens the live websocket. All correctness lives in pure modules (`lib/replayBars.ts`, `lib/replayLedger.ts`, `lib/replaySession.ts`) that are unit-tested without a chart. No backend changes.

**Tech Stack:** TypeScript, React 19, klinecharts 10, vitest (node env), Playwright.

**Spec:** `docs/superpowers/specs/2026-07-09-chart-replay-design.md`

---

## Global Constraints

These apply to EVERY task. They are corrections and clarifications of the spec — read them before writing any code.

1. **The spec's §6 claim that replay "reuses the existing paper executor" is wrong.** The paper executor is `backend/auto_trader/brokers/paper_exec.py` (Python, reached over `POST /api/orders`, priced from the live tick snapshot). Routing replay fills through it would fill at LIVE prices and pollute the real paper book. Replay trading is a NEW pure frontend module, `lib/replayLedger.ts`. What IS reused: the `TradeView` shape (`lib/trading.ts`), the pure helpers `mergeTradeLevels` / `clampLevelToPrice` / `isBreakeven` / `isBreakevenTarget`, and the whole draggable-line layer (`lib/positionLines.ts`, `chart/TradePills.tsx`).

2. **Intrabar fill convention — copy the backtester verbatim** (`backend/auto_trader/engine/backtest.py::_intrabar_exit`), because strategy reveal puts replay trades and backtest trades on the same chart:
   - Gap-through-target at the open resolves FIRST: long with `open >= target` exits at `target`.
   - Otherwise STOP wins over target when one bar's range spans both: long with `low <= stop` exits at `min(open, stop)` (a gap-down fills at the open — pessimistic).
   - Only then target: long with `high >= target` exits at `target`.
   - Short is the mirror (`open <= target` → target; `high >= stop` → `max(open, stop)`; `low <= target` → target).
   - A position opened on bar N may stop out on bar N (the backtester opens at 1a and exits at 1c within the same bar).
   - Equity marks to `bar.close`.

3. **No cost model in replay v1.** Fills use raw bar prices — no spread, slippage or commission. The chart's `priceSide` already picks bid/mid/ask candles. State this in the report card copy so the P&L is not mistaken for a costed figure.

4. **`cursorMs` means "the market is known through this instant"** — i.e. the CLOSE time of the newest revealed bar, not its timestamp. This is what makes a timeframe switch exact: the cursor carries across unchanged and each resolution re-derives its own visible set from it. The spec's prose ("current replay position") is compatible; this is the precise definition every module uses.

5. **A bar is closed when the NEXT bar's timestamp is ≤ the cursor**, falling back to `timestamp + nominalMs` only when no next bar is loaded. Never use `RESOLUTION_SECONDS` alone for the closed test: its own comment says WEEK_2/MONTH_*/YEAR are approximate ("used only for scroll-back window math, never for bucketing"), so `MONTH = 2592000` (30 days) would close a July bucket on Jul 31 instead of Aug 1. The forward buffer means the next bar is almost always in the store even when it is not on the chart, so the accurate branch is the normal one.

6. **v10 data API only.** Use `facade.setBars(bars, canLoadOlder)` and `facade.pushBar(bar)` (`chart/chartDataFacade.ts`). The spec's `chart.applyNewData` / `chart.updateData` are v9 names that no longer exist. `setBars` calls `chart.resetData()`, which parks the view at the right edge — that is exactly where the replay cursor sits, so the step-back view snap is acceptable BY DESIGN. Do not "fix" it.

7. **Blindness is a hard requirement, not a nicety.** No code path may paint a bar whose close is after the cursor, and no masked session may render an absolute date anywhere in the cell. In particular the live load must be branched BEFORE `fetchRecentWithStatus`, never after: handing off at the tail paints live (future) bars for a frame.

8. **Never call `openLive` while replaying.** Beyond the candles, the live callback publishes `setLivePrice(epic, close)` to the positions dock and drives the price/bid/ask axis tags.

9. **Scope: minute-and-above only.** Gate every entry point on `!period.liveOnly`. Sub-minute is out of the feature's scope permanently (tick-built, in-memory, not backfillable). Synthetic epics ARE supported — `fetchRange` already serves them (`lib/feed.ts` routes to `/api/candles/synthetic`), so no extra gate.

10. **Replay state is device-local and NOT undoable.** Persist with `saveLocal` (`lib/persist/core.ts`), never `save()` (which mirrors to the backend) and never `historyCapture` (replay steps must not enter the Ctrl+Z stack).

11. **Read-only snapshot cells never replay.** Gate entry on `!controller.readOnly.value` / `!snapView`, alongside the `liveOnly` gate.

12. **Follow the per-cell feature pattern already in the codebase:** state + effects in a `chart/use*.ts` hook, presentational chrome in a sibling `*.tsx` component rendered from ChartCore's JSX, styles in `App.css`. `chart/useProximityHeatmap.ts` + `HeatmapControls.tsx` is the reference pair. Do not introduce a React context.

13. **Out of scope — do not build:** masked symbol, drag scrubber/timeline, tab-wide synced replay, feeding the live rule engine, session history archive.

14. **UI copy rule (CLAUDE.md):** no em dashes in end-user-visible strings; use parentheses or colons. Use the shared `Tooltip` / `InfoTip` components, never a native `title=` on new markup. Any popover must close on outside click (document `mousedown` listener + a test).

15. **Tests:** pure logic in `.ts` vitest files (default `node` env). Only `.tsx` tests need `// @vitest-environment jsdom` on line 1. The repo's frontend suite has 5-7 known failures on `main`; do NOT try to fix unrelated failures, and check a failure exists on `main` before blaming your change.

---

## File Structure

**New — pure logic (all unit-tested, no chart, no DOM):**
- `frontend/src/lib/replayBars.ts` — closed-bar rule, cursor slicing, step math, merge-with-paged-history, buffer-window math.
- `frontend/src/lib/replaySession.ts` — the persisted session record, `saveLocal`-backed load/save, random-jump target picking with bounded re-roll.
- `frontend/src/lib/replayLedger.ts` — the per-session order/position book advanced one bar at a time; `TradeView` projection; session summary.

**New — per-cell wiring:**
- `frontend/src/chart/useReplay.ts` — the controller hook: state, bar store + forward buffer, step/play/exit, ledger ownership, persistence.

**New — chrome (presentational):**
- `frontend/src/ReplayStartPanel.tsx` — picking-mode panel (curtain hint, random-jump window + Jump/re-roll, "Hide dates").
- `frontend/src/ReplayPill.tsx` — the floating bottom-center controls pill (step back, play/pause, step forward, speed, new start, Trade, Show strategy, exit).
- `frontend/src/ReplayTicket.tsx` — the compact in-cell ticket that writes to the replay ledger.
- `frontend/src/ReplayReportCard.tsx` — the on-exit modal (trades, win rate, net P&L, date reveal).

**Modified:**
- `frontend/src/lib/timeFormat.ts` — add `makeMaskedFormatDate`.
- `frontend/src/chart/chartHandle.ts` — add `replayRef` (+ the `ReplayHandle` type).
- `frontend/src/chart/useLiveMarketData.ts` — the replay branch (load, positioning, no websocket) + `replayEpoch` dep.
- `frontend/src/chart/useChartPaint.ts` — suppress the live countdown + bid/ask tags while replaying.
- `frontend/src/chart/TradePills.tsx` — optional `actions` prop so replay lines act on the ledger.
- `frontend/src/lib/mtfCoordinator.ts` — HTF cursor clamp registry + filter.
- `frontend/src/ChartCore.tsx` — mount the hook, render the chrome, curtain, sync suppression, replay class on the wrap.
- `frontend/src/App.css` — `.replay-*` styles.
- `docs/BACKLOG.md` — remove the shipped entry (the file's own header makes this part of done).

**Tests:** `src/lib/replayBars.test.ts`, `src/lib/replaySession.test.ts`, `src/lib/replayLedger.test.ts`, `src/lib/timeFormat.test.ts` (new file), `src/lib/mtfCursorClamp.test.ts`, `frontend/e2e/chart-replay.spec.ts`.

---

### Task 1: Replay bar math (pure)

The whole engine's correctness: which bars are visible at a cursor, what the next/previous cursor is, and how a replay slice coexists with scroll-back-paged history.

**Files:**
- Create: `frontend/src/lib/replayBars.ts`
- Test: `frontend/src/lib/replayBars.test.ts`

**Interfaces:**
- Consumes: `KLineData` from `klinecharts` (`{ timestamp, open, high, low, close, volume? }`), `RESOLUTION_SECONDS` from `./feed`.
- Produces:
  - `barCloseMs(bars: readonly KLineData[], i: number, nominalMs: number): number`
  - `revealedCount(bars: readonly KLineData[], cursorMs: number, nominalMs: number): number`
  - `revealedBars(bars: readonly KLineData[], cursorMs: number, nominalMs: number): KLineData[]`
  - `nextCursorMs(bars: readonly KLineData[], cursorMs: number, nominalMs: number): number | null`
  - `prevCursorMs(bars: readonly KLineData[], cursorMs: number, nominalMs: number): number | null`
  - `cursorForStartTs(bars: readonly KLineData[], startTs: number, nominalMs: number): number | null`
  - `mergeOlder(existing: readonly KLineData[], revealed: readonly KLineData[]): KLineData[]`
  - `nominalMsFor(resolution: string): number`
  - `needsBuffer(bars: readonly KLineData[], cursorMs: number, nominalMs: number, margin: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/replayBars.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import {
  barCloseMs,
  revealedCount,
  revealedBars,
  nextCursorMs,
  prevCursorMs,
  cursorForStartTs,
  mergeOlder,
  nominalMsFor,
  needsBuffer,
} from "./replayBars";

const HOUR = 3_600_000;
// Four hourly bars starting 2026-03-02T00:00Z.
const T0 = Date.UTC(2026, 2, 2, 0, 0, 0);
const bar = (ts: number, c: number): KLineData => ({
  timestamp: ts,
  open: c,
  high: c + 1,
  low: c - 1,
  close: c,
});
const hourly: KLineData[] = [0, 1, 2, 3].map((i) => bar(T0 + i * HOUR, 100 + i));

describe("barCloseMs", () => {
  it("uses the NEXT bar's timestamp as the close", () => {
    expect(barCloseMs(hourly, 0, HOUR)).toBe(T0 + HOUR);
    expect(barCloseMs(hourly, 2, HOUR)).toBe(T0 + 3 * HOUR);
  });

  it("falls back to the nominal width for the last loaded bar", () => {
    expect(barCloseMs(hourly, 3, HOUR)).toBe(T0 + 4 * HOUR);
  });

  it("closes a MONTH bucket on the next bucket's start, not 30 days later", () => {
    // The nominal MONTH width (30d) would close July on Jul 31 — wrong.
    const months = [Date.UTC(2026, 5, 1), Date.UTC(2026, 6, 1), Date.UTC(2026, 7, 1)].map((ts) =>
      bar(ts, 1),
    );
    expect(barCloseMs(months, 1, nominalMsFor("MONTH"))).toBe(Date.UTC(2026, 7, 1));
  });
});

describe("revealedCount / revealedBars", () => {
  it("reveals every bar CLOSED at or before the cursor", () => {
    expect(revealedCount(hourly, T0 + 2 * HOUR, HOUR)).toBe(2);
    expect(revealedBars(hourly, T0 + 2 * HOUR, HOUR).map((b) => b.timestamp)).toEqual([
      T0,
      T0 + HOUR,
    ]);
  });

  it("does not reveal a bar that closes one ms after the cursor", () => {
    expect(revealedCount(hourly, T0 + 2 * HOUR - 1, HOUR)).toBe(1);
  });

  it("reveals nothing before the first close", () => {
    expect(revealedCount(hourly, T0, HOUR)).toBe(0);
    expect(revealedBars(hourly, T0, HOUR)).toEqual([]);
  });

  it("hides the forming higher-timeframe bar at a mid-bucket cursor", () => {
    // Cursor known through 14:30; the 14:00 hourly bar has not closed yet.
    const h = [12, 13, 14, 15].map((hr) => bar(Date.UTC(2026, 2, 2, hr), 1));
    const cursor = Date.UTC(2026, 2, 2, 14, 30);
    expect(revealedBars(h, cursor, HOUR).map((b) => b.timestamp)).toEqual([
      Date.UTC(2026, 2, 2, 12),
      Date.UTC(2026, 2, 2, 13),
    ]);
  });
});

describe("nextCursorMs / prevCursorMs", () => {
  it("steps to the close of the first unrevealed bar", () => {
    expect(nextCursorMs(hourly, T0 + HOUR, HOUR)).toBe(T0 + 2 * HOUR);
  });

  it("returns null at the end of the loaded bars", () => {
    expect(nextCursorMs(hourly, T0 + 4 * HOUR, HOUR)).toBe(null);
  });

  it("steps back to the previous bar's close", () => {
    expect(prevCursorMs(hourly, T0 + 3 * HOUR, HOUR)).toBe(T0 + 2 * HOUR);
  });

  it("returns null when only one bar is revealed (cannot go blank)", () => {
    expect(prevCursorMs(hourly, T0 + HOUR, HOUR)).toBe(null);
  });
});

describe("cursorForStartTs", () => {
  it("snaps a picked timestamp to the close of the bar containing it", () => {
    expect(cursorForStartTs(hourly, T0 + HOUR + 900_000, HOUR)).toBe(T0 + 2 * HOUR);
  });

  it("returns null when no bar covers the timestamp", () => {
    expect(cursorForStartTs(hourly, T0 - HOUR, HOUR)).toBe(null);
  });
});

describe("mergeOlder", () => {
  it("keeps scroll-back-paged bars older than the replay slice", () => {
    const paged = [bar(T0 - 2 * HOUR, 90), bar(T0 - HOUR, 91), ...hourly.slice(0, 2)];
    const merged = mergeOlder(paged, hourly.slice(0, 2));
    expect(merged.map((b) => b.timestamp)).toEqual([T0 - 2 * HOUR, T0 - HOUR, T0, T0 + HOUR]);
  });

  it("never lets an existing bar at or after the slice start through", () => {
    const paged = [...hourly]; // includes bars the cursor has not revealed
    const merged = mergeOlder(paged, hourly.slice(0, 2));
    expect(merged.map((b) => b.timestamp)).toEqual([T0, T0 + HOUR]);
  });

  it("returns the slice unchanged when nothing is loaded", () => {
    expect(mergeOlder([], hourly.slice(0, 1))).toEqual(hourly.slice(0, 1));
  });
});

describe("needsBuffer", () => {
  it("asks for more bars when the cursor is within the margin of the end", () => {
    expect(needsBuffer(hourly, T0 + 3 * HOUR, HOUR, 2)).toBe(true);
    expect(needsBuffer(hourly, T0 + HOUR, HOUR, 2)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/replayBars.test.ts`
Expected: FAIL — `Failed to resolve import "./replayBars"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/replayBars.ts`:

```ts
// Pure bar math for chart replay. Everything here is a function of (bars,
// cursor) — no chart, no fetch, no state — so the closed-bar rule that keeps a
// replay session BLIND is unit-testable on its own.
//
// `cursorMs` is "the market is known through this instant": the CLOSE time of
// the newest revealed bar, never a bar's timestamp. That definition is what
// makes a timeframe switch exact — the cursor carries across unchanged and each
// resolution re-derives its own visible set from it.
import type { KLineData } from "klinecharts";
import { RESOLUTION_SECONDS } from "./feed";

/** Nominal bar width in ms. Only ever a FALLBACK for the newest loaded bar (see
 * barCloseMs): RESOLUTION_SECONDS' derived entries (WEEK_2, MONTH_*, YEAR) are
 * approximate by its own documentation, so a real next-bar timestamp always wins. */
export function nominalMsFor(resolution: string): number {
  return (RESOLUTION_SECONDS[resolution] ?? 60) * 1000;
}

/** When bar `i` closes. The next bar's timestamp is the truth (correct for the
 * calendar-bucketed derived timeframes the backend folds, where a nominal width
 * is wrong by days); the nominal width covers the newest loaded bar, which has
 * no successor yet. */
export function barCloseMs(bars: readonly KLineData[], i: number, nominalMs: number): number {
  const next = bars[i + 1];
  return next ? next.timestamp : bars[i].timestamp + nominalMs;
}

/** How many bars are CLOSED at or before the cursor. Bars are ascending, so this
 * is a binary search on a monotone predicate. */
export function revealedCount(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
): number {
  let lo = 0;
  let hi = bars.length; // count of revealed bars, in [0, length]
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (barCloseMs(bars, mid, nominalMs) <= cursorMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The bars a replaying chart may paint at this cursor. */
export function revealedBars(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
): KLineData[] {
  return bars.slice(0, revealedCount(bars, cursorMs, nominalMs));
}

/** Cursor after one step forward, or null when the loaded bars are exhausted
 * (the caller refills the forward buffer or declares the end of history). */
export function nextCursorMs(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
): number | null {
  const n = revealedCount(bars, cursorMs, nominalMs);
  return n < bars.length ? barCloseMs(bars, n, nominalMs) : null;
}

/** Cursor after one step back, or null when a step would leave the chart blank
 * (one revealed bar is the floor). */
export function prevCursorMs(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
): number | null {
  const n = revealedCount(bars, cursorMs, nominalMs);
  return n >= 2 ? barCloseMs(bars, n - 2, nominalMs) : null;
}

/** Cursor for a chosen START timestamp: the close of the bar that CONTAINS it,
 * so a pick anywhere inside a bar reveals that bar and nothing after it. null
 * when no loaded bar covers the timestamp (dead zone — the caller re-rolls). */
export function cursorForStartTs(
  bars: readonly KLineData[],
  startTs: number,
  nominalMs: number,
): number | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].timestamp <= startTs) {
      return barCloseMs(bars, i, nominalMs) > startTs ? barCloseMs(bars, i, nominalMs) : null;
    }
  }
  return null;
}

/** Splice the replay slice onto whatever OLDER history the chart already holds.
 * Scroll-back paging prepends bars through the same facade, and a later slice
 * apply would otherwise drop them; anything at or after the slice's first bar is
 * dropped instead, since the slice is authoritative from there on. */
export function mergeOlder(
  existing: readonly KLineData[],
  revealed: readonly KLineData[],
): KLineData[] {
  if (!revealed.length) return [...revealed];
  const firstTs = revealed[0].timestamp;
  const older: KLineData[] = [];
  for (const b of existing) {
    if (b.timestamp >= firstTs) break;
    older.push(b);
  }
  return [...older, ...revealed];
}

/** True when the cursor is within `margin` bars of the end of the store, so the
 * forward buffer should be refilled before stepping can block on the network. */
export function needsBuffer(
  bars: readonly KLineData[],
  cursorMs: number,
  nominalMs: number,
  margin: number,
): boolean {
  return bars.length - revealedCount(bars, cursorMs, nominalMs) <= margin;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/replayBars.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck and commit**

Run: `cd frontend && npx tsc -b --noEmit 2>&1 | head -20` (expected: no errors mentioning replayBars)

```bash
git add frontend/src/lib/replayBars.ts frontend/src/lib/replayBars.test.ts
git commit -m "feat(replay): pure cursor-slicing + closed-bar math"
```

---

### Task 2: Masked clock formatter

A blind session must never render an absolute date. klinecharts' only lever is `chart.setFormatter({ formatDate })`, so the mask is a drop-in replacement for `makeFormatDate`.

**Files:**
- Modify: `frontend/src/lib/timeFormat.ts` (append; do not change `makeFormatDate`)
- Test: `frontend/src/lib/timeFormat.test.ts` (new file)

**Interfaces:**
- Consumes: `FormatDateParams` from `klinecharts` (`{ dateTimeFormat, timestamp, template, type }`), the existing private `extract()` helper in the same file.
- Produces: `makeMaskedFormatDate(anchorMs: number, clock: Clock): (params: FormatDateParams) => string`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/timeFormat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { FormatDateParams } from "klinecharts";
import { makeMaskedFormatDate, makeFormatDate } from "./timeFormat";

const DAY = 86_400_000;
const ANCHOR = Date.UTC(2026, 2, 2, 9, 30); // Mon 2026-03-02 09:30 UTC
const dtf = new Intl.DateTimeFormat("en", {
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});
const call = (fmt: (p: FormatDateParams) => string, timestamp: number, template: string) =>
  fmt({ dateTimeFormat: dtf, timestamp, template, type: "xAxis" } as FormatDateParams);

describe("makeMaskedFormatDate", () => {
  const fmt = makeMaskedFormatDate(ANCHOR, "24h");

  it("renders the anchor day as Day 1", () => {
    expect(call(fmt, ANCHOR, "YYYY-MM-DD HH:mm")).toBe("Day 1 09:30");
  });

  it("counts whole days from the anchor", () => {
    expect(call(fmt, ANCHOR + 3 * DAY, "YYYY-MM-DD HH:mm")).toBe("Day 4 09:30");
  });

  it("counts backwards for context bars before the start", () => {
    expect(call(fmt, ANCHOR - DAY, "YYYY-MM-DD HH:mm")).toBe("Day 0 09:30");
    expect(call(fmt, ANCHOR - 2 * DAY, "YYYY-MM-DD HH:mm")).toBe("Day -1 09:30");
  });

  it("never leaks a year or month at coarse tick granularities", () => {
    expect(call(fmt, ANCHOR, "YYYY")).toBe("Day 1");
    expect(call(fmt, ANCHOR, "YYYY-MM")).toBe("Day 1");
    expect(call(fmt, ANCHOR, "MM-DD")).toBe("Day 1");
  });

  it("renders a time-only template as a bare clock time", () => {
    expect(call(fmt, ANCHOR, "HH:mm")).toBe("09:30");
  });

  it("honours the 12h clock preference", () => {
    const twelve = makeMaskedFormatDate(ANCHOR, "12h");
    expect(call(twelve, ANCHOR, "YYYY-MM-DD HH:mm")).toBe("Day 1 9:30 AM");
  });

  it("stays a pure function of (timestamp, template) so tick de-duping still works", () => {
    expect(call(fmt, ANCHOR, "YYYY")).toBe(call(fmt, ANCHOR, "YYYY"));
    expect(call(fmt, ANCHOR, "YYYY")).not.toBe(call(fmt, ANCHOR + DAY, "YYYY"));
  });

  it("leaves the unmasked formatter untouched", () => {
    expect(call(makeFormatDate("24h", "ymd"), ANCHOR, "YYYY-MM-DD HH:mm")).toBe("2026-03-02 09:30");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/timeFormat.test.ts`
Expected: FAIL — `makeMaskedFormatDate is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `frontend/src/lib/timeFormat.ts` (after `makeFormatDate`):

```ts
// --- masked clock (chart replay, blind sessions) ------------------------------
//
// A replay session started by a random jump hides WHEN it is: the axis, the
// crosshair label and the OHLC tooltip all read "Day N HH:mm", relative to the
// jump point. Substituted for makeFormatDate on the replaying cell only, and
// swapped back on exit (the report card does the reveal).
//
// Every template klinecharts hands us that carries ANY date part collapses to
// "Day N" — including the coarse 'YYYY' and 'YYYY-MM' tick buckets, which would
// otherwise print the real year outright. Output stays a pure function of
// (timestamp, template), which is what the library's tick-granularity
// de-duplication relies on.

const MASK_DAY_MS = 86_400_000;

export function makeMaskedFormatDate(anchorMs: number, clock: Clock) {
  return ({ dateTimeFormat, timestamp, template }: FormatDateParams): string => {
    const p = extract(dateTimeFormat, timestamp);
    const time = renderTime(p, template, clock);
    const wantsDate = template.includes("YYYY") || template.includes("MM") || template.includes("DD");
    if (!wantsDate) return time;
    // Day 1 is the day the session started; context bars before it count down
    // (Day 0, Day -1, ...). Math.floor over the signed delta keeps that monotone.
    const day = Math.floor((timestamp - anchorMs) / MASK_DAY_MS) + 1;
    const label = `Day ${day}`;
    return time ? `${label} ${time}` : label;
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/timeFormat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/timeFormat.ts frontend/src/lib/timeFormat.test.ts
git commit -m "feat(replay): masked relative-date formatter for blind sessions"
```

---

### Task 3: Session record, persistence, and random-jump picking

The persisted shape and the two pure decisions that start a session: which timestamp a random jump lands on, and how the window widens when it keeps landing in dead zones.

**Files:**
- Create: `frontend/src/lib/replaySession.ts`
- Test: `frontend/src/lib/replaySession.test.ts`

**Interfaces:**
- Consumes: `PREFIX`, `load`, `saveLocal` from `./persist/core` (re-exported by `./persist`); `ReplayLedgerState` from `./replayLedger` is NOT yet defined — declare the field as `ledger: unknown` here and tighten it in Task 11.
- Produces:
  - `type JumpWindowKey = "1W" | "1M" | "3M" | "1Y" | "custom"`
  - `JUMP_WINDOWS: ReadonlyArray<{ key: JumpWindowKey; label: string; ms: number }>` (custom has `ms: 0`)
  - `interface ReplaySessionRecord { epic: string; resolution: string; startMs: number; cursorMs: number; highWaterMs: number; masked: boolean; showStrategy: boolean; ledger: unknown; savedAt: number }`
  - `loadReplaySession(scope: string): ReplaySessionRecord | null`
  - `saveReplaySession(scope: string, rec: ReplaySessionRecord): void`
  - `clearReplaySession(scope: string): void`
  - `pickJumpTarget(args: { nowMs: number; windowMs: number; attempt: number; random: () => number }): { fromMs: number; toMs: number; targetMs: number }`
  - `MAX_JUMP_ATTEMPTS: number` (= 6)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/replaySession.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";

installMemStorage();

const {
  loadReplaySession,
  saveReplaySession,
  clearReplaySession,
  pickJumpTarget,
  JUMP_WINDOWS,
  MAX_JUMP_ATTEMPTS,
} = await import("./replaySession");

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const DAY = 86_400_000;

const rec = (over: Partial<Parameters<typeof saveReplaySession>[1]> = {}) => ({
  epic: "US100",
  resolution: "HOUR",
  startMs: NOW - 30 * DAY,
  cursorMs: NOW - 29 * DAY,
  highWaterMs: NOW - 29 * DAY,
  masked: true,
  showStrategy: false,
  ledger: null,
  savedAt: NOW,
  ...over,
});

describe("replay session persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a session per cell scope", () => {
    saveReplaySession("tab.t1.cell.a", rec());
    expect(loadReplaySession("tab.t1.cell.a")?.cursorMs).toBe(NOW - 29 * DAY);
    expect(loadReplaySession("tab.t1.cell.b")).toBe(null);
  });

  it("keeps cells independent and clears only the named scope", () => {
    saveReplaySession("s1", rec());
    saveReplaySession("s2", rec({ epic: "OIL_CRUDE" }));
    clearReplaySession("s1");
    expect(loadReplaySession("s1")).toBe(null);
    expect(loadReplaySession("s2")?.epic).toBe("OIL_CRUDE");
  });

  it("writes DEVICE-LOCAL only (no backend mirror queue entry)", () => {
    saveReplaySession("s1", rec());
    // saveLocal writes the key without queuing a mirror; the mirror queue key
    // must stay absent for a replay-only write.
    const keys = Object.keys(localStorage).filter((k) => k.includes("replay"));
    expect(keys.length).toBe(1);
  });
});

describe("pickJumpTarget", () => {
  it("picks uniformly inside the requested window, ending one window-tenth before now", () => {
    const r = pickJumpTarget({ nowMs: NOW, windowMs: 30 * DAY, attempt: 0, random: () => 0.5 });
    expect(r.fromMs).toBe(NOW - 30 * DAY);
    expect(r.toMs).toBe(NOW - 3 * DAY); // 10% headroom so the session has bars to play
    expect(r.targetMs).toBe(r.fromMs + (r.toMs - r.fromMs) * 0.5);
  });

  it("widens the window on each re-roll attempt so dead zones cannot trap it", () => {
    const first = pickJumpTarget({ nowMs: NOW, windowMs: 7 * DAY, attempt: 0, random: () => 0 });
    const third = pickJumpTarget({ nowMs: NOW, windowMs: 7 * DAY, attempt: 2, random: () => 0 });
    expect(third.fromMs).toBeLessThan(first.fromMs);
  });

  it("bounds the re-roll budget", () => {
    expect(MAX_JUMP_ATTEMPTS).toBe(6);
  });

  it("offers the spec's window presets plus custom", () => {
    expect(JUMP_WINDOWS.map((w) => w.key)).toEqual(["1W", "1M", "3M", "1Y", "custom"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/replaySession.test.ts`
Expected: FAIL — cannot resolve `./replaySession`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/replaySession.ts`:

```ts
// Chart replay: the persisted session record and the pure decisions that start
// a session. Device-local by design (saveLocal, never save()): another device's
// replay cursor is meaningless, and a replay step must never enter the undo
// stack or the backend mirror.
import { PREFIX, load, saveLocal } from "./persist/core";

export type JumpWindowKey = "1W" | "1M" | "3M" | "1Y" | "custom";

const DAY_MS = 86_400_000;

/** Random-jump window presets. "custom" carries no span — the panel supplies an
 * explicit from/to range instead. */
export const JUMP_WINDOWS: ReadonlyArray<{ key: JumpWindowKey; label: string; ms: number }> = [
  { key: "1W", label: "Past week", ms: 7 * DAY_MS },
  { key: "1M", label: "Past month", ms: 30 * DAY_MS },
  { key: "3M", label: "Past 3 months", ms: 90 * DAY_MS },
  { key: "1Y", label: "Past year", ms: 365 * DAY_MS },
  { key: "custom", label: "Custom range", ms: 0 },
];

/** How many times a jump may re-roll past a dead zone (weekend / holiday /
 * pre-listing gap) before the caller gives up and says so. */
export const MAX_JUMP_ATTEMPTS = 6;

export interface ReplaySessionRecord {
  epic: string;
  resolution: string;
  /** Cursor at session start — the masking anchor and the report card's origin. */
  startMs: number;
  /** "Known through" instant (see replayBars). */
  cursorMs: number;
  /** Furthest cursor ever played to: the trading gate that closes the
   * rewind-and-cheat loophole. */
  highWaterMs: number;
  masked: boolean;
  showStrategy: boolean;
  /** ReplayLedgerState (typed in replayLedger.ts; kept structural here so the
   * persistence layer never depends on the trading layer). */
  ledger: unknown;
  savedAt: number;
}

const REPLAY_KEY = `${PREFIX}.replaySessions`;

export function loadReplaySession(scope: string): ReplaySessionRecord | null {
  return load<Record<string, ReplaySessionRecord>>(REPLAY_KEY, {})[scope] ?? null;
}

export function saveReplaySession(scope: string, rec: ReplaySessionRecord): void {
  const all = load<Record<string, ReplaySessionRecord>>(REPLAY_KEY, {});
  all[scope] = rec;
  saveLocal(REPLAY_KEY, all);
}

export function clearReplaySession(scope: string): void {
  const all = load<Record<string, ReplaySessionRecord>>(REPLAY_KEY, {});
  if (!(scope in all)) return;
  delete all[scope];
  saveLocal(REPLAY_KEY, all);
}

/**
 * Where a random jump lands. Uniform inside [now - window, now - window/10]:
 * the 10% headroom guarantees the session has unseen bars left to play instead
 * of starting at the live edge. Each re-roll `attempt` widens the window by 50%
 * so a run of dead-zone landings (a long holiday closure, an instrument listed
 * mid-window) escapes instead of re-rolling inside the same gap forever.
 */
export function pickJumpTarget(args: {
  nowMs: number;
  windowMs: number;
  attempt: number;
  random: () => number;
}): { fromMs: number; toMs: number; targetMs: number } {
  const widened = args.windowMs * (1 + 0.5 * args.attempt);
  const fromMs = args.nowMs - widened;
  const toMs = args.nowMs - widened / 10;
  return { fromMs, toMs, targetMs: fromMs + (toMs - fromMs) * args.random() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/replaySession.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/replaySession.ts frontend/src/lib/replaySession.test.ts
git commit -m "feat(replay): session record persistence + random-jump targeting"
```

---

### Task 4: The replay controller hook

The per-cell owner: state, bar store with a forward buffer, stepping/playback, and the imperative handle the other hooks read. Follows `chart/useProximityHeatmap.ts` exactly (state in the hook, chrome rendered by ChartCore, no context).

**Files:**
- Create: `frontend/src/chart/useReplay.ts`
- Modify: `frontend/src/chart/chartHandle.ts` (add `ReplayHandle` + `replayRef`)
- Test: `frontend/src/lib/replayBars.test.ts` (extend — the hook's own logic is I/O; its pure parts live in replayBars)

**Interfaces:**
- Consumes: `revealedBars`, `nextCursorMs`, `prevCursorMs`, `cursorForStartTs`, `mergeOlder`, `needsBuffer`, `nominalMsFor` (Task 1); `loadReplaySession`, `saveReplaySession`, `clearReplaySession`, `pickJumpTarget`, `MAX_JUMP_ATTEMPTS`, `JUMP_WINDOWS` (Task 3); `fetchRange`, `RESOLUTION_SECONDS` (`lib/feed`); `ChartHandle` (`chart/chartHandle`).
- Produces:
  - `interface ReplayHandle { isActive(): boolean; masked(): boolean; cursorMs(): number; startMs(): number; barsFor(resolution: string): Promise<KLineData[]> }`
  - `chartHandle.replayRef: React.MutableRefObject<ReplayHandle | null>`
  - `interface ReplayUiState { mode: "off" | "picking" | "active"; startMs: number; cursorMs: number; highWaterMs: number; masked: boolean; playing: boolean; speedMs: number; atEnd: boolean; loading: boolean; error: string | null }`
  - `interface ReplayApi { state: ReplayUiState; enterPicking(): void; cancelPicking(): void; startAt(startTs: number, opts: { masked: boolean }): void; randomJump(windowMs: number, masked: boolean): void; stepForward(): void; stepBack(): void; togglePlay(): void; setSpeed(ms: number): void; exit(): void; replayEpoch: number }`
  - `useReplay(handle: ChartHandle, deps: ReplayDeps): ReplayApi`
  - `REPLAY_SPEEDS: ReadonlyArray<{ label: string; ms: number }>`

- [ ] **Step 1: Extend the bar-math test with the buffer-window helper**

Append to `frontend/src/lib/replayBars.test.ts`:

```ts
import { bufferWindowSec } from "./replayBars";

describe("bufferWindowSec", () => {
  const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);

  it("spans context bars before the start and buffer bars after it", () => {
    const w = bufferWindowSec({ centerMs: NOW - 10 * 3_600_000, resSec: 3600, contextBars: 300, forwardBars: 200, nowMs: NOW });
    expect(w.fromSec).toBe(Math.floor((NOW - 10 * 3_600_000) / 1000) - 300 * 3600);
    expect(w.toSec).toBe(Math.floor(NOW / 1000)); // clamped: replay never crosses now
  });

  it("never asks for bars past now", () => {
    const w = bufferWindowSec({ centerMs: NOW, resSec: 3600, contextBars: 10, forwardBars: 200, nowMs: NOW });
    expect(w.toSec).toBe(Math.floor(NOW / 1000));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/lib/replayBars.test.ts`
Expected: FAIL — `bufferWindowSec is not exported`.

- [ ] **Step 3: Add the helper to `lib/replayBars.ts`**

```ts
/** The [from, to] SECOND window a replay load asks the candles API for: enough
 * history left of the cursor to fill the screen, plus a forward buffer so
 * stepping never blocks on the network. Clamped at `nowMs` — replay never
 * crosses the live edge, which is why the backend cache's no-forward-fetch
 * limitation is irrelevant here. */
export function bufferWindowSec(args: {
  centerMs: number;
  resSec: number;
  contextBars: number;
  forwardBars: number;
  nowMs: number;
}): { fromSec: number; toSec: number } {
  const centerSec = Math.floor(args.centerMs / 1000);
  return {
    fromSec: centerSec - args.contextBars * args.resSec,
    toSec: Math.min(centerSec + args.forwardBars * args.resSec, Math.floor(args.nowMs / 1000)),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/lib/replayBars.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the handle type**

In `frontend/src/chart/chartHandle.ts`, add the import + type + field:

```ts
import type { KLineData } from "klinecharts";

/** What the OTHER hooks need from the replaying cell. The load effect asks for
 * the bars to paint; the MTF coordinator asks for the cursor so a higher-
 * timeframe series cannot look ahead. Null when this cell has never replayed. */
export interface ReplayHandle {
  isActive(): boolean;
  masked(): boolean;
  /** "Known through" instant (see lib/replayBars). 0 when not replaying. */
  cursorMs(): number;
  /** Session start cursor — the masking anchor. 0 when not replaying. */
  startMs(): number;
  /** Bars to paint for `resolution` at the current cursor: fetches the window
   * (context + forward buffer) and returns only the closed ones. */
  barsFor(resolution: string): Promise<KLineData[]>;
}
```

and inside `interface ChartHandle`:

```ts
  // Replay (null until the cell first enters replay; see chart/useReplay.ts).
  // Assigned during RENDER, not in an effect, so useLiveMarketData's load effect
  // — which runs after this hook's — always sees a current handle.
  replayRef: React.MutableRefObject<ReplayHandle | null>;
```

- [ ] **Step 6: Write the hook**

Create `frontend/src/chart/useReplay.ts`:

```ts
// Chart replay for ONE cell: TradingView-style bar replay over locally held
// bars. The hook owns the session (cursor, high-water, masking, playback) and
// the bar store; every pure decision lives in lib/replayBars.ts.
//
// Painting is deliberately split between two places:
//   - a SERIES load (session start, timeframe switch, exit) goes through
//     useLiveMarketData's normal effect, which we re-trigger by bumping
//     `replayEpoch`. That reuses the whole load path (drawings rehydrate,
//     indicator visibility, MTF refresh, template apply) instead of forking it.
//   - a STEP repaints here, directly through the data facade, so play/step feel
//     instant and never re-run the load effect.
//
// Per-cell state pattern: chart/useProximityHeatmap.ts. No React context.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KLineData } from "klinecharts";
import { fetchRange, RESOLUTION_SECONDS } from "../lib/feed";
import type { PriceSide } from "../theme";
import {
  bufferWindowSec,
  cursorForStartTs,
  mergeOlder,
  needsBuffer,
  nextCursorMs,
  nominalMsFor,
  prevCursorMs,
  revealedBars,
} from "../lib/replayBars";
import {
  clearReplaySession,
  loadReplaySession,
  MAX_JUMP_ATTEMPTS,
  pickJumpTarget,
  saveReplaySession,
} from "../lib/replaySession";
import { toast } from "../lib/notify";
import type { ChartHandle, ReplayHandle } from "./chartHandle";

// Bars fetched left of the start (screen context the user can scroll into) and
// right of the cursor (the forward buffer that keeps stepping local).
const CONTEXT_BARS = 300;
const FORWARD_BARS = 200;
// Refill when the cursor comes within this many unrevealed bars of the store's end.
const REFILL_MARGIN = 50;

export const REPLAY_SPEEDS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: "1x", ms: 1000 },
  { label: "2x", ms: 500 },
  { label: "5x", ms: 200 },
  { label: "10x", ms: 100 },
];

export interface ReplayUiState {
  mode: "off" | "picking" | "active";
  startMs: number;
  cursorMs: number;
  highWaterMs: number;
  masked: boolean;
  playing: boolean;
  speedMs: number;
  /** True once playback has reached the last closed bar before now. */
  atEnd: boolean;
  loading: boolean;
  error: string | null;
}

export interface ReplayApi {
  state: ReplayUiState;
  enterPicking(): void;
  cancelPicking(): void;
  startAt(startTs: number, opts: { masked: boolean }): void;
  randomJump(windowMs: number, masked: boolean): void;
  stepForward(): void;
  stepBack(): void;
  togglePlay(): void;
  setSpeed(ms: number): void;
  exit(): void;
  /** Bumped whenever the SERIES must be reloaded (start / exit). Passed into
   * useLiveMarketData's deps so its effect re-runs. */
  replayEpoch: number;
}

export interface ReplayDeps {
  epic: string;
  resolution: string;
  priceSide: PriceSide;
  brokerId: string;
  scope: string;
}

const OFF: ReplayUiState = {
  mode: "off",
  startMs: 0,
  cursorMs: 0,
  highWaterMs: 0,
  masked: false,
  playing: false,
  speedMs: 1000,
  atEnd: false,
  loading: false,
  error: null,
};

export function useReplay(handle: ChartHandle, deps: ReplayDeps): ReplayApi {
  const { epic, resolution, priceSide, brokerId, scope } = deps;

  // Resume a session parked by a reload — but only when it still addresses this
  // cell's instrument (a symbol change ends the session; the bars underneath a
  // cursor belong to one epic).
  const [state, setState] = useState<ReplayUiState>(() => {
    const saved = loadReplaySession(scope);
    if (!saved || saved.epic !== epic) return OFF;
    return {
      ...OFF,
      mode: "active",
      startMs: saved.startMs,
      cursorMs: saved.cursorMs,
      highWaterMs: saved.highWaterMs,
      masked: saved.masked,
    };
  });
  const [replayEpoch, setReplayEpoch] = useState(0);

  // The bar store for the CURRENT resolution (ascending, may extend past the
  // cursor — that's the forward buffer, which the chart never sees).
  const barsRef = useRef<KLineData[]>([]);
  const storeResRef = useRef<string>(resolution);
  // Latest state for imperative callbacks (playback timer, the handle) without
  // stale closures — same idiom as useProximityHeatmap's `latest`.
  const latest = useRef({ state, epic, resolution, priceSide, brokerId, scope });
  latest.current = { state, epic, resolution, priceSide, brokerId, scope };
  const refillingRef = useRef(false);

  const nominalMs = useCallback((res: string) => nominalMsFor(res), []);

  // --- bar store ------------------------------------------------------------

  const fetchWindow = useCallback(
    async (res: string, centerMs: number): Promise<KLineData[]> => {
      const cur = latest.current;
      const { fromSec, toSec } = bufferWindowSec({
        centerMs,
        resSec: RESOLUTION_SECONDS[res] ?? 60,
        contextBars: CONTEXT_BARS,
        forwardBars: FORWARD_BARS,
        nowMs: Date.now(),
      });
      return fetchRange(cur.epic, res, fromSec, toSec, cur.priceSide, cur.brokerId);
    },
    [],
  );

  /** Bars to PAINT for a resolution at the current cursor. Called by the load
   * effect (session start, timeframe switch, resume) through handle.replayRef. */
  const barsFor = useCallback(
    async (res: string): Promise<KLineData[]> => {
      const cursorMs = latest.current.state.cursorMs;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const bars = await fetchWindow(res, cursorMs);
        barsRef.current = bars;
        storeResRef.current = res;
        setState((s) => ({ ...s, loading: false }));
        return revealedBars(bars, cursorMs, nominalMs(res));
      } catch (err) {
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        return [];
      }
    },
    [fetchWindow, nominalMs],
  );

  // Assigned during RENDER (not in an effect) so the load effect below in
  // ChartCore's hook order always reads a current handle — the same reason
  // ensureCoverageAndFitRef is assigned in render.
  const replayHandle = useMemo<ReplayHandle>(
    () => ({
      isActive: () => latest.current.state.mode === "active",
      masked: () => latest.current.state.masked && latest.current.state.mode === "active",
      cursorMs: () => (latest.current.state.mode === "active" ? latest.current.state.cursorMs : 0),
      startMs: () => (latest.current.state.mode === "active" ? latest.current.state.startMs : 0),
      barsFor,
    }),
    [barsFor],
  );
  handle.replayRef.current = replayHandle;

  // --- painting a step ------------------------------------------------------

  const applySlice = useCallback(
    (cursorMs: number, appended: boolean) => {
      const chart = handle.chartRef.current;
      const facade = handle.dataFacadeRef.current;
      if (!chart || !facade) return;
      const res = storeResRef.current;
      const revealed = revealedBars(barsRef.current, cursorMs, nominalMs(res));
      if (!revealed.length) return;
      if (appended) {
        // One new bar at the right edge: push it so the view is untouched (a
        // full setBars would resetData and re-park the view every step).
        facade.pushBar(revealed[revealed.length - 1]);
        return;
      }
      // Step back / jump / reveal-toggle: replace the dataset, keeping whatever
      // older history scroll-back paged in. resetData parks the view at the
      // right edge, which is where the cursor sits — acceptable by design.
      facade.setBars(mergeOlder(chart.getDataList() ?? [], revealed), true);
    },
    [handle, nominalMs],
  );

  // --- forward buffer -------------------------------------------------------

  const refillIfNeeded = useCallback(() => {
    const cur = latest.current;
    if (cur.state.mode !== "active" || refillingRef.current) return;
    const res = storeResRef.current;
    if (!needsBuffer(barsRef.current, cur.state.cursorMs, nominalMs(res), REFILL_MARGIN)) return;
    refillingRef.current = true;
    void fetchWindow(res, cur.state.cursorMs)
      .then((bars) => {
        // A refill can only ever GROW the store forward; keep the longer array.
        if (bars.length > barsRef.current.length) barsRef.current = bars;
        const last = barsRef.current[barsRef.current.length - 1];
        // Nothing new past the cursor and the window already reaches now: this
        // session has replayed up to the live edge.
        if (last && nextCursorMs(barsRef.current, cur.state.cursorMs, nominalMs(res)) == null) {
          setState((s) => ({ ...s, atEnd: true, playing: false }));
        }
      })
      .catch(() => {
        // Transient: keep the loaded bars and let the NEXT step retry (each step
        // calls refillIfNeeded, so the retry is user-paced rather than a timer
        // with backoff — simpler, and it cannot spin while the user is idle).
        // Playback pauses with a notice rather than ending the session.
        setState((s) => ({ ...s, playing: false, error: "Couldn't load more bars. Paused." }));
      })
      .finally(() => {
        refillingRef.current = false;
      });
  }, [fetchWindow, nominalMs]);

  // --- controls -------------------------------------------------------------

  const stepForward = useCallback(() => {
    const cur = latest.current;
    if (cur.state.mode !== "active") return;
    const res = storeResRef.current;
    const next = nextCursorMs(barsRef.current, cur.state.cursorMs, nominalMs(res));
    if (next == null) {
      setState((s) => ({ ...s, playing: false }));
      refillIfNeeded();
      return;
    }
    setState((s) => ({
      ...s,
      cursorMs: next,
      highWaterMs: Math.max(s.highWaterMs, next),
      error: null,
    }));
    applySlice(next, true);
    refillIfNeeded();
  }, [applySlice, nominalMs, refillIfNeeded]);

  const stepBack = useCallback(() => {
    const cur = latest.current;
    if (cur.state.mode !== "active") return;
    const prev = prevCursorMs(barsRef.current, cur.state.cursorMs, nominalMs(storeResRef.current));
    if (prev == null) return;
    // High-water is NEVER lowered: rewind is a view-only move, so trades cannot
    // un-happen and no order may be placed until the cursor returns.
    setState((s) => ({ ...s, cursorMs: prev, playing: false, atEnd: false }));
    applySlice(prev, false);
  }, [applySlice, nominalMs]);

  const togglePlay = useCallback(() => {
    setState((s) => (s.mode === "active" ? { ...s, playing: !s.playing } : s));
  }, []);

  const setSpeed = useCallback((ms: number) => setState((s) => ({ ...s, speedMs: ms })), []);

  const enterPicking = useCallback(() => setState((s) => ({ ...s, mode: "picking" })), []);
  const cancelPicking = useCallback(
    () => setState((s) => (s.mode === "picking" ? { ...OFF, speedMs: s.speedMs } : s)),
    [],
  );

  const startAt = useCallback(
    (startTs: number, opts: { masked: boolean }) => {
      const res = latest.current.resolution;
      setState((s) => ({ ...s, loading: true, error: null }));
      void fetchWindow(res, startTs).then((bars) => {
        const cursor = cursorForStartTs(bars, startTs, nominalMs(res));
        if (cursor == null) {
          setState((s) => ({ ...s, loading: false, error: "No candles at that point. Pick another." }));
          return;
        }
        barsRef.current = bars;
        storeResRef.current = res;
        setState((s) => ({
          ...s,
          mode: "active",
          startMs: cursor,
          cursorMs: cursor,
          highWaterMs: cursor,
          masked: opts.masked,
          playing: false,
          atEnd: false,
          loading: false,
          error: null,
        }));
        // Re-run the load effect: it repaints through barsFor and skips the
        // websocket, and rehydrates drawings/indicators for the new window.
        setReplayEpoch((n) => n + 1);
      });
    },
    [fetchWindow, nominalMs],
  );

  const randomJump = useCallback(
    (windowMs: number, masked: boolean) => {
      const cur = latest.current;
      const res = cur.resolution;
      setState((s) => ({ ...s, loading: true, error: null }));
      void (async () => {
        for (let attempt = 0; attempt < MAX_JUMP_ATTEMPTS; attempt++) {
          const { targetMs } = pickJumpTarget({
            nowMs: Date.now(),
            windowMs,
            attempt,
            random: Math.random,
          });
          const bars = await fetchWindow(res, targetMs).catch(() => [] as KLineData[]);
          const cursor = cursorForStartTs(bars, targetMs, nominalMs(res));
          if (cursor == null) continue; // dead zone (weekend / holiday): re-roll wider
          barsRef.current = bars;
          storeResRef.current = res;
          setState((s) => ({
            ...s,
            mode: "active",
            startMs: cursor,
            cursorMs: cursor,
            highWaterMs: cursor,
            masked,
            playing: false,
            atEnd: false,
            loading: false,
            error: null,
          }));
          setReplayEpoch((n) => n + 1);
          return;
        }
        setState((s) => ({
          ...s,
          loading: false,
          error: "Couldn't find candles in that window. Try a wider one.",
        }));
      })();
    },
    [fetchWindow, nominalMs],
  );

  const exit = useCallback(() => {
    barsRef.current = [];
    clearReplaySession(latest.current.scope);
    setState((s) => ({ ...OFF, speedMs: s.speedMs }));
    setReplayEpoch((n) => n + 1); // load effect restores live data + the stream
  }, []);

  // --- playback timer -------------------------------------------------------

  useEffect(() => {
    if (state.mode !== "active" || !state.playing) return;
    const id = window.setInterval(stepForward, state.speedMs);
    return () => window.clearInterval(id);
  }, [state.mode, state.playing, state.speedMs, stepForward]);

  // --- persistence ----------------------------------------------------------
  //
  // Debounced: play at 10x fires a step every 100ms, and each write serializes
  // the whole record. Device-local (saveReplaySession → saveLocal).
  useEffect(() => {
    if (state.mode !== "active") return;
    const id = window.setTimeout(() => {
      saveReplaySession(scope, {
        epic,
        resolution,
        startMs: state.startMs,
        cursorMs: state.cursorMs,
        highWaterMs: state.highWaterMs,
        masked: state.masked,
        showStrategy: false,
        ledger: null,
        savedAt: Date.now(),
      });
    }, 400);
    return () => window.clearTimeout(id);
  }, [state.mode, state.startMs, state.cursorMs, state.highWaterMs, state.masked, epic, resolution, scope]);

  // A symbol change ends the session: the cursor addresses one instrument's bars.
  const prevEpicRef = useRef(epic);
  useEffect(() => {
    if (prevEpicRef.current === epic) return;
    prevEpicRef.current = epic;
    if (latest.current.state.mode === "off") return;
    toast("Replay ended: the symbol changed.");
    exit();
  }, [epic, exit]);

  return {
    state,
    enterPicking,
    cancelPicking,
    startAt,
    randomJump,
    stepForward,
    stepBack,
    togglePlay,
    setSpeed,
    exit,
    replayEpoch,
  };
}
```

- [ ] **Step 7: Add `replayRef` to ChartCore's handle**

In `frontend/src/ChartCore.tsx`, beside the other handle refs (near `pendingTradeRestoreRef`):

```tsx
  // Replay handle for this cell (assigned during render by useReplay; null
  // until the hook first runs). Read by useLiveMarketData's load branch and the
  // MTF coordinator's no-lookahead clamp.
  const replayRef = useRef<ReplayHandle | null>(null);
```

Add `replayRef` to the `handle` useMemo object and `import type { ReplayHandle } from "./chart/chartHandle";` to the existing chartHandle type import.

- [ ] **Step 8: Typecheck and commit**

Run: `cd frontend && npx tsc -b --noEmit 2>&1 | head -30`
Expected: no errors. (The hook is not called yet — that lands in Task 5/7. An "unused import" lint on ReplayHandle is expected to disappear once the handle field is added; if `npx eslint src/chart/useReplay.ts` flags an unused symbol, fix it now.)

```bash
git add frontend/src/chart/useReplay.ts frontend/src/chart/chartHandle.ts frontend/src/ChartCore.tsx frontend/src/lib/replayBars.ts frontend/src/lib/replayBars.test.ts
git commit -m "feat(replay): per-cell replay controller hook + chart handle"
```

---

### Task 5: Load-effect branch (the risky edit)

The single change that makes a cell replay instead of stream. It must branch BEFORE the recent-history fetch: handing off after it paints live (future) bars for a frame, which is exactly the leak the feature exists to prevent.

**Files:**
- Modify: `frontend/src/chart/useLiveMarketData.ts` (deps interface, the async load block, the positioning block, the live-stream block, the effect dep array)
- Modify: `frontend/src/ChartCore.tsx` (call `useReplay` BEFORE `useLiveMarketData`, pass `replayEpoch`)

**Interfaces:**
- Consumes: `handle.replayRef` (Task 4), `ReplayApi.replayEpoch` (Task 4).
- Produces: `LiveMarketDataDeps.replayEpoch: number` — bumping it re-runs the load effect, which is how a session start / timeframe switch / exit repaints.

- [ ] **Step 1: Add the dep**

In `frontend/src/chart/useLiveMarketData.ts`, add to `interface LiveMarketDataDeps` (after `effPrecision`):

```ts
  // Bumped by useReplay when the SERIES must be reloaded (replay start / exit).
  // In the load effect's dep array, so entering or leaving replay re-runs the
  // whole load path — rehydrate, indicator visibility, MTF refresh, template —
  // instead of forking a second one.
  replayEpoch: number;
```

and destructure it alongside the others in the hook body.

- [ ] **Step 2: Branch the history load**

Replace the load block (currently `let bars: KLineData[]; let degraded: string | null = null; try { const loaded = await fetchRecentWithStatus(...) } catch { ... }`) with:

```ts
      // A REPLAYING cell owns its own bars: it paints only what is closed at the
      // cursor and never streams. Branching HERE — before the recent-history
      // fetch — is load-bearing: handing off at the tail would paint live bars
      // (the future) for a frame, and in a masked session that is the one thing
      // the feature exists to prevent.
      const replay = handle.replayRef.current;
      const replaying = replay?.isActive() ?? false;
      let bars: KLineData[];
      let degraded: string | null = null;
      if (replaying) {
        bars = await replay!.barsFor(period.resolution);
      } else {
        // Tolerate a failed initial load (offline/DNS/refused/CORS make fetchRecent
        // REJECT, not return []): fall back to no history and carry on. Crucially this
        // still reaches rehydrate() below, which advances overlays.hydratedEpic — skip
        // it and persist() stays gated on the stale epic forever, silently dropping
        // every alert/drawing the user adds until they switch symbol again.
        try {
          const loaded = await fetchRecentWithStatus(symbol.epic, period.resolution, 500, priceSide, brokerId);
          bars = loaded.bars;
          degraded = loaded.degraded;
        } catch (err) {
          console.warn(`[chart] initial load failed for ${symbol.epic}; continuing with no history`, err);
          bars = [];
          if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
```

- [ ] **Step 3: Skip the center-cover, retry and positioning for a replaying cell**

Three guarded edits in the same async block, each by prefixing the existing condition:

1. The parallel center cover — change `if (centerTargetTs != null && bars.length > 0 && centerTargetTs < bars[0].timestamp) {` to:

```ts
      // Replay positions itself at the cursor (right edge of its own slice), so
      // the preserve-center cover would only fetch history it never uses.
      if (!replaying && centerTargetTs != null && bars.length > 0 && centerTargetTs < bars[0].timestamp) {
```

2. The retry scheduler — change `} else if (!period.liveOnly && !cancelled) {` (the `shouldRetryHistory` branch) to:

```ts
      } else if (!period.liveOnly && !cancelled && !replaying) {
```

3. The view anchor. **`if (!keepPainted) {` appears TWICE in this file** (once
   around line 523 for the data apply, once around line 570 for the view anchor)
   — match on the two-line form below so the edit lands on the SECOND one:

```ts
      if (!keepPainted) {
        if (restoreView && restoreView.barSpace > 0) {
```

becomes:

```ts
      if (replaying) {
        // The cursor bar IS the right edge of the replay slice.
        handle.chartRef.current.scrollToRealTime();
      } else if (!keepPainted) {
        if (restoreView && restoreView.barSpace > 0) {
```

   The EARLIER `if (!keepPainted)` block (the one setting `cursorSecRef` and
   calling `dataFacade.setBars(bars, !period.liveOnly)`) is correct as-is for
   replay and must NOT be touched: the replay slice flows through it unchanged,
   which is what paints the session and arms scroll-back paging.

- [ ] **Step 4: Never open the stream while replaying**

Wrap the live block. Replace:

```ts
      // Live updates for the current bar.
      handle.wsRef.current?.close();
      setStatus("connecting");
```

with (note `handle.wsRef.current?.close()` also appears in the effect's cleanup
below — the comment line and the following `setStatus("connecting")` make this
match unique, so keep both in the `old_string`):

```ts
      // Live updates for the current bar. A replaying cell gets NONE: beyond the
      // future candles, the callback publishes setLivePrice to the positions dock
      // and drives the price/bid/ask axis tags. Closing the previous socket still
      // happens — entering replay must kill the stream this cell had.
      handle.wsRef.current?.close();
      handle.wsRef.current = null;
      if (replaying) {
        // Stale spread sides would keep painting bid/ask lines from live prices.
        handle.bidRef.current = null;
        handle.askRef.current = null;
        // The price-axis tag renders `(lastPrice ?? priceTag.price)` — leaving the
        // last streamed price in place would pin TODAY's price to the axis of a
        // session replaying months ago. Nulling it falls back to priceTag.price,
        // which is the cursor bar's close (the chart holds only revealed bars).
        setLastPrice(null);
        return;
      }
      setStatus("connecting");
```

(the `return` exits the async IIFE — the effect's cleanup still runs.)

- [ ] **Step 5: Add the dep to the effect's dep array**

Change:

```ts
  }, [symbol.epic, period.resolution, priceSide, brokerId, retryNonce]);
```

to:

```ts
  }, [symbol.epic, period.resolution, priceSide, brokerId, retryNonce, replayEpoch]);
```

- [ ] **Step 6: Mount the hook in ChartCore, above `useLiveMarketData`**

In `frontend/src/ChartCore.tsx`, immediately BEFORE the `useLiveMarketData(handle, { ... })` call:

```tsx
  // Chart replay for this cell. Declared BEFORE useLiveMarketData so its render-
  // time handle assignment is in place when that hook's load effect runs, and so
  // replayEpoch is available to pass down.
  const replay = useReplay(handle, {
    epic: symbol.epic,
    resolution: period.resolution,
    priceSide,
    brokerId,
    scope,
  });
```

Add `replayEpoch: replay.replayEpoch,` to the `useLiveMarketData` deps object and
`import { useReplay } from "./chart/useReplay";` to the imports.

- [ ] **Step 7: Verify the whole suite still builds and the untouched path still works**

Run: `cd frontend && npx tsc -b --noEmit 2>&1 | head -30`
Expected: no errors.

Run: `cd frontend && npx vitest run 2>&1 | tail -25`
Expected: the same failures as `main` and no new ones. Capture the baseline first with `git stash && npx vitest run 2>&1 | tail -25 && git stash pop` if you are unsure which failures pre-exist.

Then on the dev server, with no replay session running: the chart still loads,
streams, switches timeframe and pages back exactly as before. This branch is on
the ONE effect every cell's data flows through — a regression here breaks every
chart, not just replaying ones.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/chart/useLiveMarketData.ts frontend/src/ChartCore.tsx
git commit -m "feat(replay): branch the cell load onto replay bars, never stream"
```

---

### Task 6: Start selection (curtain pick + random jump)

Entering replay opens *picking* mode: either click a point on the chart behind a curtain that hides everything to its right, or jump to a random point in a window.

**Files:**
- Create: `frontend/src/ReplayStartPanel.tsx`
- Modify: `frontend/src/ChartCore.tsx` (Replay button, curtain, panel mount)
- Modify: `frontend/src/App.css` (`.replay-ctl`, `.replay-curtain`, `.replay-start-panel`)

**Interfaces:**
- Consumes: `ReplayApi` (Task 4), `JUMP_WINDOWS` / `JumpWindowKey` (Task 3), shared `Tooltip` / `InfoTip`.
- Produces: `ReplayStartPanel` props — `{ loading: boolean; error: string | null; onJump(windowMs: number, masked: boolean): void; onCancel(): void; maskedDefault: boolean }`.

- [ ] **Step 1: Write the panel**

Create `frontend/src/ReplayStartPanel.tsx`:

```tsx
// Picking-mode chrome for chart replay: pick a start point on the chart (behind
// the curtain that hides everything to its right) or jump to a random point in a
// window. Presentational only — all state lives in chart/useReplay.ts.
import { useEffect, useRef, useState } from "react";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import { JUMP_WINDOWS, type JumpWindowKey } from "./lib/replaySession";

interface Props {
  loading: boolean;
  error: string | null;
  /** Jump to a random point inside `windowMs` before now. */
  onJump(windowMs: number, masked: boolean): void;
  /** Start a MANUAL pick with this masking choice (the curtain click reads it). */
  onMaskedChange(masked: boolean): void;
  masked: boolean;
  onCancel(): void;
}

const DAY_MS = 86_400_000;

export default function ReplayStartPanel({
  loading,
  error,
  onJump,
  onMaskedChange,
  masked,
  onCancel,
}: Props) {
  const [windowKey, setWindowKey] = useState<JumpWindowKey>("1M");
  const [customDays, setCustomDays] = useState("90");
  const rootRef = useRef<HTMLDivElement>(null);

  // Esc cancels picking (the curtain is a modal-ish mode).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const windowMs = () => {
    if (windowKey === "custom") return Math.max(1, Number(customDays) || 1) * DAY_MS;
    return JUMP_WINDOWS.find((w) => w.key === windowKey)?.ms ?? 30 * DAY_MS;
  };

  return (
    <div className="replay-start-panel" ref={rootRef}>
      <div className="rsp-title">
        Start replay
        <InfoTip
          title="Bar replay"
          text={[
            "Pick a point in the past and play the bars forward one at a time.",
            "Click the chart to set the start (everything to the right is hidden), or jump to a random point.",
          ]}
        />
      </div>

      <div className="rsp-hint">Click the chart to pick a start point.</div>

      <div className="rsp-row">
        <span className="rsp-label">Random jump</span>
        <select
          className="rsp-select"
          value={windowKey}
          onChange={(e) => setWindowKey(e.target.value as JumpWindowKey)}
        >
          {JUMP_WINDOWS.map((w) => (
            <option key={w.key} value={w.key}>
              {w.label}
            </option>
          ))}
        </select>
      </div>

      {windowKey === "custom" && (
        <div className="rsp-row">
          <span className="rsp-label">Days back</span>
          <input
            className="rsp-input"
            type="number"
            min={1}
            value={customDays}
            onChange={(e) => setCustomDays(e.target.value)}
          />
        </div>
      )}

      <label className="rsp-check">
        <input
          type="checkbox"
          checked={masked}
          onChange={(e) => onMaskedChange(e.target.checked)}
        />
        Hide dates
        <InfoTip
          title="Hide dates"
          text="Blind session: the axis, crosshair and tooltip show Day 1, Day 2 (and so on) instead of real dates. The real dates are revealed when you exit."
        />
      </label>

      <div className="rsp-actions">
        <Tooltip content="Jump to a random point in the window">
          <button className="rsp-jump" disabled={loading} onClick={() => onJump(windowMs(), masked)}>
            {loading ? "Finding candles..." : "Jump"}
          </button>
        </Tooltip>
        <Tooltip content="Roll again for a different point">
          <button
            className="rsp-reroll"
            disabled={loading}
            aria-label="Re-roll"
            onClick={() => onJump(windowMs(), masked)}
          >
            ⚄
          </button>
        </Tooltip>
        <button className="rsp-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {error && <div className="rsp-error">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Wire the button, curtain and panel into ChartCore**

In `frontend/src/ChartCore.tsx`, add the curtain x state near the other cell-chrome state:

```tsx
  // Picking-mode curtain: page x of the pointer, so everything to its right can
  // be covered (opaque, not dimmed — a dimmed future is still readable).
  const [curtainX, setCurtainX] = useState<number | null>(null);
  // Masking choice armed in the start panel; the curtain click reads it. Manual
  // picks default OFF, random jumps default ON (the panel owns that default).
  const [pickMasked, setPickMasked] = useState(false);
```

Track the pointer and handle the pick while `mode === "picking"`:

```tsx
  // Curtain tracking + start pick. Only mounted while picking, so it adds no
  // listener cost to a normal cell.
  useEffect(() => {
    if (replay.state.mode !== "picking") {
      setCurtainX(null);
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const onMove = (e: PointerEvent) => {
      setCurtainX(e.clientX - el.getBoundingClientRect().left);
    };
    const onClick = (e: MouseEvent) => {
      const c = chartRef.current;
      if (!c) return;
      // "absolute" convert coords are chart-container-relative, not viewport
      // (same convention as the range-pick tool).
      const x = e.clientX - el.getBoundingClientRect().left;
      const r = c.convertFromPixel([{ x }], { paneId: "candle_pane", absolute: true });
      const p = Array.isArray(r) ? r[0] : r;
      if (p && typeof p.timestamp === "number") {
        replay.startAt(p.timestamp, { masked: pickMasked });
      }
    };
    el.addEventListener("pointermove", onMove, true);
    el.addEventListener("click", onClick, true);
    return () => {
      el.removeEventListener("pointermove", onMove, true);
      el.removeEventListener("click", onClick, true);
    };
  }, [replay.state.mode, replay, pickMasked]);
```

Render the cell button beside the heatmap control (gate per Global Constraints 9 and 11):

```tsx
      {!period.liveOnly && !snapView && replay.state.mode === "off" && (
        <div className="replay-ctl">
          <Tooltip content="Bar replay: play the chart forward from a point in the past">
            <button className="replay-toggle" onClick={replay.enterPicking}>
              ⟲ Replay
            </button>
          </Tooltip>
        </div>
      )}

      {replay.state.mode === "picking" && (
        <>
          {curtainX != null && (
            <div className="replay-curtain" style={{ left: Math.max(0, curtainX) }} />
          )}
          <ReplayStartPanel
            loading={replay.state.loading}
            error={replay.state.error}
            masked={pickMasked}
            onMaskedChange={setPickMasked}
            onJump={(ms, masked) => replay.randomJump(ms, masked)}
            onCancel={replay.cancelPicking}
          />
        </>
      )}
```

Import `ReplayStartPanel` at the top.

Masking defaults (spec §3: ON for random jumps, OFF for manual picks). One
checkbox drives both, so the panel remembers whether the user has touched it:
`ReplayStartPanel` keeps `const touched = useRef(false)`, the checkbox's
`onChange` sets `touched.current = true` before calling `onMaskedChange`, and the
Jump button passes `onJump(windowMs(), touched.current ? masked : true)`. An
untouched checkbox therefore means "off for a click, on for a jump", which is
exactly the spec's pair of defaults. Add both lines to the component from Step 1
(the `touched` ref declaration beside the other state, and the two call sites).

- [ ] **Step 3: Add the styles**

Append to `frontend/src/App.css`:

```css
/* --- chart replay ---------------------------------------------------------- */
/* Entry button: sits left of the heatmap toggle in the cell's top-right stack. */
.replay-ctl { position: absolute; top: 8px; right: 148px; z-index: 6; }
.replay-toggle {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px;
  padding: 4px 10px; font-size: 12px; cursor: pointer;
}
.replay-toggle:hover { border-color: var(--accent); }

/* Opaque curtain over everything right of the pointer while picking a start.
   Opaque, never dimmed: a dimmed future is still readable, and this feature
   exists to make the future unreadable. */
.replay-curtain {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 20;
  background: var(--bg);
  border-left: 1px dashed var(--accent);
  pointer-events: none;
}

.replay-start-panel {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 41;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-width: 260px;
  font-size: 12px; color: var(--text);
}
.rsp-title { font-weight: 600; display: flex; align-items: center; gap: 4px; }
.rsp-hint { opacity: 0.75; }
.rsp-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.rsp-label { opacity: 0.85; }
.rsp-select, .rsp-input {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px; padding: 3px 6px; font-size: 12px;
}
.rsp-input { width: 72px; }
.rsp-check { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.rsp-actions { display: flex; align-items: center; gap: 6px; }
.rsp-jump {
  background: var(--accent); color: var(--accent-text); border: 1px solid var(--accent);
  border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer;
}
.rsp-jump:disabled { opacity: 0.6; cursor: default; }
.rsp-reroll, .rsp-cancel {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px;
  font-size: 12px; cursor: pointer;
}
.rsp-error { color: var(--danger); }
```

- [ ] **Step 4: Manual verification (no automated harness for the curtain)**

Run the dev server (`cd frontend && npm run dev`), open a 1H US100 chart, click **⟲ Replay**:
- The curtain follows the pointer and fully hides bars to its right.
- Clicking sets a start; the chart repaints showing only bars up to that click.
- **Jump** with "Past month" lands somewhere with candles; re-roll moves it.
- Esc cancels picking and leaves the chart untouched.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ReplayStartPanel.tsx frontend/src/ChartCore.tsx frontend/src/App.css
git commit -m "feat(replay): curtained start pick + random-jump panel"
```

---

### Task 7: Controls pill

TradingView-style floating pill at the bottom center, plus the cell accent tint that keeps the mode visible when the pill idles.

**Files:**
- Create: `frontend/src/ReplayPill.tsx`
- Modify: `frontend/src/ChartCore.tsx` (render the pill, add the wrap class, hide `ChartRangeBar` while replaying)
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes: `ReplayApi`, `REPLAY_SPEEDS` (Task 4), `makeMaskedFormatDate` is NOT used here (Task 8 owns the axis); the pill formats its own readout.
- Produces: `ReplayPill` props — `{ state: ReplayUiState; onStepBack(): void; onPlayPause(): void; onStepForward(): void; onSpeed(ms: number): void; onNewStart(): void; onExit(): void; readout: string }`.

- [ ] **Step 1: Write the pill**

Create `frontend/src/ReplayPill.tsx`:

```tsx
// Floating replay controls (TradingView puts them bottom-center). Presentational:
// every action is a callback into chart/useReplay.ts.
import Tooltip from "./components/Tooltip";
import { REPLAY_SPEEDS, type ReplayUiState } from "./chart/useReplay";

interface Props {
  state: ReplayUiState;
  /** Already-formatted cursor label: a real date, or "Day N HH:mm" when masked. */
  readout: string;
  onStepBack(): void;
  onPlayPause(): void;
  onStepForward(): void;
  onSpeed(ms: number): void;
  onNewStart(): void;
  onExit(): void;
}

export default function ReplayPill({
  state,
  readout,
  onStepBack,
  onPlayPause,
  onStepForward,
  onSpeed,
  onNewStart,
  onExit,
}: Props) {
  const rewound = state.cursorMs < state.highWaterMs;
  return (
    <div className="replay-pill" role="group" aria-label="Replay controls">
      <Tooltip content="Step back one bar (view only: trades are not undone)">
        <button className="rp-btn" aria-label="Step back" onClick={onStepBack}>
          ⏮
        </button>
      </Tooltip>
      <Tooltip content={state.playing ? "Pause" : "Play"}>
        <button
          className="rp-btn rp-play"
          aria-label={state.playing ? "Pause" : "Play"}
          onClick={onPlayPause}
          disabled={state.atEnd}
        >
          {state.playing ? "⏸" : "▶"}
        </button>
      </Tooltip>
      <Tooltip content="Step forward one bar">
        <button className="rp-btn" aria-label="Step forward" onClick={onStepForward} disabled={state.atEnd}>
          ⏭
        </button>
      </Tooltip>

      <select
        className="rp-speed"
        aria-label="Replay speed"
        value={state.speedMs}
        onChange={(e) => onSpeed(Number(e.target.value))}
      >
        {REPLAY_SPEEDS.map((s) => (
          <option key={s.ms} value={s.ms}>
            {s.label}
          </option>
        ))}
      </select>

      <span className={`rp-readout${state.masked ? " masked" : ""}`}>{readout}</span>

      {rewound && <span className="rp-rewound">rewound</span>}
      {state.atEnd && <span className="rp-atend">caught up</span>}
      {state.error && <span className="rp-error">{state.error}</span>}

      <Tooltip content="Pick a new start point">
        <button className="rp-btn" aria-label="Pick new start" onClick={onNewStart}>
          ⟲
        </button>
      </Tooltip>
      <Tooltip content="Exit replay and return to live">
        <button className="rp-btn rp-exit" aria-label="Exit replay" onClick={onExit}>
          ✕
        </button>
      </Tooltip>
    </div>
  );
}
```

- [ ] **Step 2: Render it from ChartCore and mark the cell**

Add the readout formatter beside the other ChartCore memos:

```tsx
  // Cursor readout for the pill: masked sessions get the same relative label the
  // axis shows, so the pill can never be the thing that leaks the date.
  const replayReadout = useMemo(() => {
    const { mode, cursorMs, startMs, masked } = replay.state;
    if (mode !== "active" || !cursorMs) return "";
    const fmt = masked
      ? makeMaskedFormatDate(startMs, clock)
      : makeFormatDate(clock, dateFormat, showWeekday);
    const dtf = new Intl.DateTimeFormat("en", {
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZone: timezone || browserTimezone(),
    });
    return fmt({ dateTimeFormat: dtf, timestamp: cursorMs, template: "YYYY-MM-DD HH:mm", type: "crosshair" });
  }, [replay.state, clock, dateFormat, showWeekday, timezone]);
```

Render the pill and hide the quick-range bar (it navigates to "now" and its
Go-to-date field would both break the session and reveal the date):

```tsx
      {replay.state.mode === "off" && (
        <ChartRangeBar
          activeKey={activeRange}
          disabled={!chartReady}
          onPick={onRangePick}
          onGoToDate={onGoToDate}
        />
      )}
      {replay.state.mode === "active" && (
        <ReplayPill
          state={replay.state}
          readout={replayReadout}
          onStepBack={replay.stepBack}
          onPlayPause={replay.togglePlay}
          onStepForward={replay.stepForward}
          onSpeed={replay.setSpeed}
          onNewStart={replay.enterPicking}
          onExit={replay.exit}
        />
      )}
```

Add the mode class to the wrap so the border tint applies — change the wrap's
className expression to append `${replay.state.mode === "active" ? " replaying" : ""}`.

Add `import ReplayPill from "./ReplayPill";` and extend the timeFormat import to
`import { makeFormatDate, makeMaskedFormatDate } from "./lib/timeFormat";`.

- [ ] **Step 3: Add the styles**

Append to `frontend/src/App.css`:

```css
/* Replay controls: TV puts them bottom-center over the chart. Always visible
   while a session is active (unlike the hover-revealed quick-range bar, which is
   hidden entirely during replay). */
.replay-pill {
  position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 12;
  display: flex; align-items: center; gap: 4px;
  padding: 4px 8px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  font-size: 12px; color: var(--text);
}
.rp-btn {
  appearance: none; border: none; background: transparent; color: var(--text);
  padding: 2px 7px; border-radius: 5px; cursor: pointer; font-size: 13px; line-height: 1.4;
}
.rp-btn:hover { background: var(--hover); }
.rp-btn:disabled { opacity: 0.4; cursor: default; background: transparent; }
.rp-play { font-size: 14px; }
.rp-speed {
  background: var(--input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px; padding: 2px 4px; font-size: 11px;
}
.rp-readout { font-variant-numeric: tabular-nums; opacity: 0.9; padding: 0 4px; }
.rp-readout.masked { color: var(--accent); }
.rp-rewound, .rp-atend { font-size: 11px; opacity: 0.8; }
.rp-error { font-size: 11px; color: var(--danger); max-width: 220px; }
.rp-exit:hover { background: color-mix(in srgb, var(--danger) 24%, transparent); }

/* A replaying cell carries a subtle accent edge so the mode is obvious in a
   split layout even when the pill is idle. */
.chart-wrap.replaying { box-shadow: inset 0 0 0 1px var(--accent); }
```

- [ ] **Step 4: Manual verification**

Dev server: start a replay, then
- ▶ plays; bars appear one at a time; ⏸ stops.
- ⏭ / ⏮ move one bar; after ⏮ the pill shows "rewound".
- Speed 10x visibly accelerates.
- The quick-range bar no longer appears on hover near the bottom.
- The cell shows the accent edge.
- **Timeframe switch mid-session** (spec: "cursor keeps the same moment in
  time"): with the cursor mid-hour on 15m, switch to 1H. The chart must show only
  hourly bars that had CLOSED by the cursor (the forming hour is absent), the
  readout must be unchanged, and switching back to 15m must return to the same
  bar. Then switch to 1D and back — the derived/coarse path uses the same rule.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ReplayPill.tsx frontend/src/ChartCore.tsx frontend/src/App.css
git commit -m "feat(replay): floating controls pill + replaying cell tint"
```

---

### Task 8: Masked clock + every other date-leak surface

The formatter (Task 2) covers the axis, the crosshair label and the OHLC tooltip. Everything else in the cell that renders a date must be masked or suppressed — enumerated here rather than discovered at test time.

**Files:**
- Modify: `frontend/src/ChartCore.tsx` (formatter effect, crosshair label formatter, separator reset, snapshot-marker guard)
- Modify: `frontend/src/chart/useChartPaint.ts` (countdown + bid/ask suppression)

**Interfaces:**
- Consumes: `makeMaskedFormatDate` (Task 2), `handle.replayRef` (Task 4).
- Produces: `ChartPaintDeps.replayRef: React.MutableRefObject<ReplayHandle | null>` (read live inside the redraw loop; not a value snapshot, so the existing memo dep arrays stay correct).

- [ ] **Step 1: Swap the formatter while masked**

In `frontend/src/ChartCore.tsx`, the formatter effect (the one keyed on `[clock, dateFormat, showWeekday, timezone]`) must also depend on the masking state. Change its body's first lines to:

```tsx
    const masked = replay.state.mode === "active" && replay.state.masked;
    const fmt = masked
      ? makeMaskedFormatDate(replay.state.startMs, clock)
      : makeFormatDate(clock, dateFormat, showWeekday);
```

and extend the dep array to
`[clock, dateFormat, showWeekday, timezone, replay.state.mode, replay.state.masked, replay.state.startMs]`.

This one change covers the time axis, the crosshair time label AND
`crosshairLabelFmtRef` (the synced-crosshair label), because all three are built
from `fmt` in that effect.

- [ ] **Step 2: Clear the period separator on entry**

The period-start separator paints a date pill (`sepCacheRef.label`). It is only ever set by a quick-range pick, which is unavailable during replay, but a session entered right after a pick would keep the stale pill. Add to ChartCore, beside the other replay effects:

```tsx
  // Entering replay drops the quick-range furniture: the separator pill carries a
  // real date, and the range pill describes a window that no longer applies.
  useEffect(() => {
    if (replay.state.mode === "off") return;
    separatorTsRef.current = null;
    sepCacheRef.current = null;
    setActiveRange(null);
    handle.redrawRef.current();
  }, [replay.state.mode, handle]);
```

- [ ] **Step 3: Suppress the live-only chrome in the paint loop**

In `frontend/src/chart/useChartPaint.ts`:

1. Add to `ChartPaintDeps`:

```ts
  // The cell's replay handle (null when it has never replayed). Read live: a
  // replaying cell has no stream, so the bar countdown and the bid/ask pills
  // would otherwise paint from stale live state.
  replayRef: React.MutableRefObject<import("./chartHandle").ReplayHandle | null>;
```

2. Destructure `replayRef` with the other deps, and in the price-tag block change:

```ts
        let countdown: string | null = null;
        if (marketClosedRef.current) {
```

to:

```ts
        let countdown: string | null = null;
        const replaying = replayRef.current?.isActive() ?? false;
        if (replaying) {
          // No stream, no next-bar clock: a countdown here would tick against
          // real time while the chart sits in the past.
          countdown = null;
        } else if (marketClosedRef.current) {
```

3. In the bid/ask pill block, add `replaying` to the guard that already requires the feed to be live so both tags stay null during replay (find the condition gating `setBidTag`/`setAskTag` on `statusRef.current === "live"` and add `&& !replaying`).

4. Pass `replayRef` from ChartCore's `useChartPaint({...})` call site.

- [ ] **Step 4: Force the legend's live dot off while replaying**

In ChartCore's `<ChartLegend ctx={{ ... }}>`, change the two computed flags:

```tsx
          // A replaying cell has no stream: neither the green live dot nor the
          // amber stale dot means anything, and both would claim the bars on
          // screen are current.
          live: replay.state.mode === "off" && status === "live" && !marketClosed && !streamStale,
          stale: replay.state.mode === "off" && streamStale && !marketClosed && status === "live",
```

- [ ] **Step 5: Verify no absolute date renders in a masked session**

Dev server: start a masked replay (Jump with "Hide dates" on) and check by eye:
- Time-axis ticks read `Day N` / `Day N HH:mm`, never a year or month.
- The crosshair label and the OHLC tooltip read `Day N HH:mm`.
- The pill readout reads `Day N HH:mm`.
- No countdown, no bid/ask axis pills, no separator pill, no quick-range bar.

Then confirm the mask is session-scoped: exit replay and check the axis is back to real dates.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/ChartCore.tsx frontend/src/chart/useChartPaint.ts
git commit -m "feat(replay): masked clock plus every other date-leak surface"
```

---

### Task 9: Sibling-cell isolation and exit restore

A replaying cell lives at a different time from its siblings, so it neither consumes nor publishes crosshair/range sync. Exit puts the cell back on live data.

**Files:**
- Modify: `frontend/src/ChartCore.tsx` (four sync call sites + a `replayActiveRef`)

**Interfaces:**
- Consumes: `replay.state.mode` (Task 4).
- Produces: `replayActiveRef: React.MutableRefObject<boolean>` — a live mirror the sync effects (which are keyed on `[cellId]` and must not re-subscribe) can read.

- [ ] **Step 1: Add the live mirror**

In ChartCore, beside the other mirror refs:

```tsx
  // Live mirror of "this cell is replaying", for the sync effects: they are keyed
  // on [cellId] so they can't close over replay state, and re-subscribing them on
  // every cursor step would be wasteful.
  const replayActiveRef = useRef(false);
  replayActiveRef.current = replay.state.mode === "active";
```

- [ ] **Step 2: Suppress publishing**

Guard the crosshair broadcast (in `onCrosshair`):

```tsx
      if (syncCrosshairRef.current && !replayActiveRef.current) {
        chartSync.publish(tabIdRef.current, { sourceCellId: cellId, timestamp: ts });
      }
```

and the lock-mode range publish in the same handler:

```tsx
      if (lockedRef.current && !overlays.isDrawing() && !replayActiveRef.current) {
```

and the range broadcast in `onRange` — add an early return at the top of that
handler's body:

```tsx
      // A replaying cell sits at a different moment in time; broadcasting its
      // window would drag every sibling into the past.
      if (replayActiveRef.current) return;
```

- [ ] **Step 3: Suppress receiving**

At the top of both subscription callbacks (`chartSync.subscribe(tabId, (m) => {` and `rangeSync.subscribe(tabId, (m) => {`), after the existing self-broadcast guard:

```tsx
      if (replayActiveRef.current) return; // replaying: not on the siblings' timeline
```

- [ ] **Step 4: Confirm the exit path restores live**

No new code: `replay.exit()` clears the session, sets `mode: "off"` and bumps
`replayEpoch`, which re-runs the load effect down its normal path
(`fetchRecentWithStatus` + `openLive`) exactly as a symbol/TF change does.

Verify on the dev server:
- Start replay in a split layout with two cells; move the crosshair in each — no guide crosses between them while one replays, and the sibling still syncs with a third cell.
- Exit replay: the cell returns to the live edge, the price tag ticks again, and the legend dot goes green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ChartCore.tsx
git commit -m "feat(replay): keep a replaying cell off the tab's sync channels"
```

---

### Task 10: Higher-timeframe no-lookahead clamp

An EMA pinned to 1H on a 15m replay must not use the 1H bar that is still forming at the cursor. The MTF coordinator's fetch already ends at the chart's newest bar, but the backend returns that bucket fully aggregated (built from data the replay has not reached).

**Files:**
- Modify: `frontend/src/lib/mtfCoordinator.ts`
- Test: `frontend/src/lib/mtfCursorClamp.test.ts`

**Interfaces:**
- Consumes: `barCloseMs` (Task 1), `Chart` from klinecharts.
- Produces:
  - `setHtfCursorClamp(chart: Chart, read: (() => number) | null): void` — register/clear a cell's cursor reader (0 = not replaying).
  - `clampHtfBars(bars: KLineData[], cursorMs: number, nominalMs: number): KLineData[]` (exported for the test).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/mtfCursorClamp.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import { clampHtfBars } from "./mtfCoordinator";

const HOUR = 3_600_000;
const bar = (ts: number): KLineData => ({ timestamp: ts, open: 1, high: 2, low: 0, close: 1 });
const T = Date.UTC(2026, 2, 2, 12);

describe("clampHtfBars", () => {
  const htf = [0, 1, 2, 3].map((i) => bar(T + i * HOUR));

  it("drops the higher-timeframe bar still forming at the cursor", () => {
    // Cursor known through 14:30 — the 14:00 hourly bar has NOT closed.
    const out = clampHtfBars(htf, T + 2.5 * HOUR, HOUR);
    expect(out.map((b) => b.timestamp)).toEqual([T, T + HOUR]);
  });

  it("keeps a bar that closes exactly at the cursor", () => {
    expect(clampHtfBars(htf, T + 2 * HOUR, HOUR).map((b) => b.timestamp)).toEqual([T, T + HOUR]);
  });

  it("is a no-op when not replaying (cursor 0)", () => {
    expect(clampHtfBars(htf, 0, HOUR)).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/lib/mtfCursorClamp.test.ts`
Expected: FAIL — `clampHtfBars is not exported from ./mtfCoordinator`.

- [ ] **Step 3: Implement the clamp**

In `frontend/src/lib/mtfCoordinator.ts`, add near the `mtfRetries` WeakMap (same
per-chart idiom, so a disposed chart's entry frees with it):

```ts
// --- replay cursor clamp ----------------------------------------------------
//
// A replaying cell must not let a higher-timeframe series look ahead: the
// backend serves the bucket CONTAINING the cursor fully aggregated (it is in the
// past as far as the API is concerned), so an EMA pinned to 1H on a 15m replay
// would read an hour the user has not reached. Same no-lookahead rule the
// backtester enforces. The reader returns 0 when the cell is not replaying.
const htfCursors = new WeakMap<Chart, () => number>();

export function setHtfCursorClamp(chart: Chart, read: (() => number) | null): void {
  if (read) htfCursors.set(chart, read);
  else htfCursors.delete(chart);
}

/** Keep only HTF bars fully CLOSED at the cursor. `cursorMs` 0 = not replaying. */
export function clampHtfBars(bars: KLineData[], cursorMs: number, nominalMs: number): KLineData[] {
  if (!cursorMs) return bars;
  const out: KLineData[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (barCloseMs(bars, i, nominalMs) <= cursorMs) out.push(bars[i]);
    else break; // ascending: everything after this is later still
  }
  return out;
}
```

Import `barCloseMs` from `./replayBars`.

Then apply it at the single choke point every MTF indicator shares — the end of
`fetchHtfBars`, just before the return:

```ts
  const cursorMs = htfCursors.get(chart)?.() ?? 0;
  return { htf: clampHtfBars(htf, cursorMs, htfMs), htfMs, failed };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/mtfCursorClamp.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the reader from the replay hook**

In `frontend/src/chart/useReplay.ts`, add the registration effect (import
`setHtfCursorClamp` from `../lib/mtfCoordinator`):

```ts
  // Publish the cursor to the MTF coordinator so every higher-timeframe series
  // this cell computes stops at the same no-lookahead boundary the chart does.
  useEffect(() => {
    const chart = handle.chartRef.current;
    if (!chart) return;
    setHtfCursorClamp(chart, () => (latest.current.state.mode === "active" ? latest.current.state.cursorMs : 0));
    return () => setHtfCursorClamp(chart, null);
  }, [handle]);
```

Also re-fetch the HTF series as the cursor advances, so the clamp releases newly
closed HTF bars (coalesced — a 10x play must not fire a fetch per step):

```ts
  // The cursor crossing a higher-timeframe bar close makes new HTF data legal;
  // refresh on a settle rather than per step.
  useEffect(() => {
    if (state.mode !== "active") return;
    const id = window.setTimeout(() => {
      const chart = handle.chartRef.current;
      if (chart) void refreshMtfIndicators(chart, latest.current.epic, latest.current.brokerId);
    }, 400);
    return () => window.clearTimeout(id);
  }, [state.mode, state.cursorMs, handle]);
```

- [ ] **Step 6: Verify by hand**

Dev server: on a 15m chart add an EMA pinned to 1H (the MTF pin menu), start a
replay, and step through an hour boundary. The EMA's last value must only change
when the cursor crosses the hour, never mid-hour.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/mtfCoordinator.ts frontend/src/lib/mtfCursorClamp.test.ts frontend/src/chart/useReplay.ts
git commit -m "feat(replay): clamp higher-timeframe indicator data to the cursor"
```

---

### Task 11: Replay ledger (pure)

The per-session order/position book, advanced one bar at a time. New code — the backend paper executor cannot be reused (Global Constraint 1) — but the fill convention is copied verbatim from the backtester (Global Constraint 2) so replay trades and revealed strategy trades obey the same rules.

**Files:**
- Create: `frontend/src/lib/replayLedger.ts`
- Test: `frontend/src/lib/replayLedger.test.ts`

**Interfaces:**
- Consumes: `KLineData` (klinecharts), `TradeView` / `OrderSide` (`./trading`).
- Produces:
  - `interface ReplayOrder { id: string; side: OrderSide; quantity: number; limit: number; stop: number | null; takeProfit: number | null; placedMs: number }`
  - `interface ReplayPosition { id: string; side: OrderSide; quantity: number; entry: number; stop: number | null; takeProfit: number | null; openedMs: number }`
  - `interface ReplayClosedTrade { side: OrderSide; quantity: number; entry: number; exit: number; entryMs: number; exitMs: number; pnl: number; reason: "stop" | "target" | "manual" }`
  - `interface ReplayLedgerState { orders: ReplayOrder[]; positions: ReplayPosition[]; closed: ReplayClosedTrade[]; seq: number }`
  - `emptyLedger(): ReplayLedgerState`
  - `placeMarket(s, a: { side; quantity; price; stop; takeProfit; atMs }): ReplayLedgerState`
  - `placeLimit(s, a: { side; quantity; limit; stop; takeProfit; atMs }): ReplayLedgerState`
  - `cancelOrder(s, id: string): ReplayLedgerState`
  - `closeAt(s, id: string, price: number, atMs: number): ReplayLedgerState`
  - `editLevels(s, id: string, e: { price?: number | null; stop?: number | null; takeProfit?: number | null }): ReplayLedgerState`
  - `advanceBar(s, bar: KLineData, closeMs: number): ReplayLedgerState`
  - `toTradeViews(s, epic: string, mark: number | null): TradeView[]`
  - `interface ReplaySummary { trades: number; wins: number; winRate: number; netPnl: number; openPositions: number }`
  - `summarize(s): ReplaySummary`
  - `canPlaceAt(cursorMs: number, highWaterMs: number): boolean`
  - `shouldAdvanceAt(cursorMs: number, highWaterMs: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/replayLedger.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { KLineData } from "klinecharts";
import {
  advanceBar,
  canPlaceAt,
  cancelOrder,
  closeAt,
  editLevels,
  emptyLedger,
  placeLimit,
  placeMarket,
  shouldAdvanceAt,
  summarize,
  toTradeViews,
} from "./replayLedger";

const T = Date.UTC(2026, 2, 2, 12);
const HOUR = 3_600_000;
const candle = (o: number, h: number, l: number, c: number, ts = T): KLineData => ({
  timestamp: ts,
  open: o,
  high: h,
  low: l,
  close: c,
});

describe("market orders", () => {
  it("fills instantly at the price the user is looking at", () => {
    const s = placeMarket(emptyLedger(), {
      side: "buy", quantity: 2, price: 100, stop: 95, takeProfit: 110, atMs: T,
    });
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]).toMatchObject({ side: "buy", quantity: 2, entry: 100, stop: 95 });
  });

  it("closes at a given price and books the P&L", () => {
    let s = placeMarket(emptyLedger(), { side: "buy", quantity: 2, price: 100, stop: null, takeProfit: null, atMs: T });
    s = closeAt(s, s.positions[0].id, 105, T + HOUR);
    expect(s.positions).toHaveLength(0);
    expect(s.closed[0]).toMatchObject({ pnl: 10, reason: "manual" });
  });

  it("books a short's P&L in the opposite direction", () => {
    let s = placeMarket(emptyLedger(), { side: "sell", quantity: 1, price: 100, stop: null, takeProfit: null, atMs: T });
    s = closeAt(s, s.positions[0].id, 90, T + HOUR);
    expect(s.closed[0].pnl).toBe(10);
  });
});

describe("limit orders", () => {
  it("fills a buy limit at the limit when the bar's low crosses it", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 99, stop: null, takeProfit: null, atMs: T });
    s = advanceBar(s, candle(100, 101, 98, 100), T + HOUR);
    expect(s.orders).toHaveLength(0);
    expect(s.positions[0].entry).toBe(99);
  });

  it("fills at the OPEN when the market gapped through the limit (never worse)", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 99, stop: null, takeProfit: null, atMs: T });
    s = advanceBar(s, candle(97, 98, 96, 97), T + HOUR);
    expect(s.positions[0].entry).toBe(97);
  });

  it("leaves an untouched limit resting", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 90, stop: null, takeProfit: null, atMs: T });
    s = advanceBar(s, candle(100, 101, 98, 100), T + HOUR);
    expect(s.orders).toHaveLength(1);
    expect(s.positions).toHaveLength(0);
  });

  it("cancels a resting order", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 90, stop: null, takeProfit: null, atMs: T });
    s = cancelOrder(s, s.orders[0].id);
    expect(s.orders).toHaveLength(0);
  });
});

describe("intrabar exits (mirrors backend engine/backtest.py::_intrabar_exit)", () => {
  const long = () =>
    placeMarket(emptyLedger(), { side: "buy", quantity: 1, price: 100, stop: 95, takeProfit: 110, atMs: T });

  it("resolves a gap through the target at the open, filling at the target", () => {
    const s = advanceBar(long(), candle(112, 115, 111, 114), T + HOUR);
    expect(s.closed[0]).toMatchObject({ exit: 110, reason: "target" });
  });

  it("gives the STOP priority when one bar spans both levels", () => {
    const s = advanceBar(long(), candle(100, 111, 94, 105), T + HOUR);
    expect(s.closed[0]).toMatchObject({ exit: 95, reason: "stop" });
  });

  it("fills a gapped-through stop at the open (pessimistic)", () => {
    const s = advanceBar(long(), candle(90, 92, 88, 91), T + HOUR);
    expect(s.closed[0]).toMatchObject({ exit: 90, reason: "stop" });
  });

  it("takes the target when only the high reaches it", () => {
    const s = advanceBar(long(), candle(100, 111, 99, 108), T + HOUR);
    expect(s.closed[0]).toMatchObject({ exit: 110, reason: "target" });
  });

  it("mirrors the rules for a short", () => {
    const short = placeMarket(emptyLedger(), {
      side: "sell", quantity: 1, price: 100, stop: 105, takeProfit: 90, atMs: T,
    });
    expect(advanceBar(short, candle(88, 89, 87, 88), T + HOUR).closed[0]).toMatchObject({
      exit: 90, reason: "target",
    });
    expect(advanceBar(short, candle(100, 106, 89, 95), T + HOUR).closed[0]).toMatchObject({
      exit: 105, reason: "stop",
    });
  });

  it("lets a position opened by a limit fill stop out on the SAME bar", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 99, stop: 97, takeProfit: null, atMs: T });
    s = advanceBar(s, candle(100, 101, 96, 98), T + HOUR);
    expect(s.positions).toHaveLength(0);
    expect(s.closed[0]).toMatchObject({ entry: 99, exit: 97, reason: "stop" });
  });

  it("stamps the exit at the bar's close time", () => {
    const s = advanceBar(long(), candle(100, 111, 99, 108), T + HOUR);
    expect(s.closed[0].exitMs).toBe(T + HOUR);
  });
});

describe("editLevels", () => {
  it("moves a position's stop and target", () => {
    let s = placeMarket(emptyLedger(), { side: "buy", quantity: 1, price: 100, stop: 95, takeProfit: null, atMs: T });
    s = editLevels(s, s.positions[0].id, { stop: 98, takeProfit: 105 });
    expect(s.positions[0]).toMatchObject({ stop: 98, takeProfit: 105 });
  });

  it("moves a resting order's limit price", () => {
    let s = placeLimit(emptyLedger(), { side: "buy", quantity: 1, limit: 90, stop: null, takeProfit: null, atMs: T });
    s = editLevels(s, s.orders[0].id, { price: 92 });
    expect(s.orders[0].limit).toBe(92);
  });
});

describe("toTradeViews / summarize", () => {
  it("projects positions and orders into the shape the chart lines consume", () => {
    let s = placeMarket(emptyLedger(), { side: "buy", quantity: 2, price: 100, stop: 95, takeProfit: null, atMs: T });
    s = placeLimit(s, { side: "sell", quantity: 1, limit: 120, stop: null, takeProfit: null, atMs: T });
    const views = toTradeViews(s, "US100", 103);
    expect(views.map((v) => v.kind)).toEqual(["position", "order"]);
    expect(views[0]).toMatchObject({ epic: "US100", side: "buy", priceLevel: 100, upnl: 6 });
    expect(views[1]).toMatchObject({ kind: "order", priceLevel: 120, upnl: null });
  });

  it("summarizes the session", () => {
    let s = placeMarket(emptyLedger(), { side: "buy", quantity: 1, price: 100, stop: null, takeProfit: null, atMs: T });
    s = closeAt(s, s.positions[0].id, 110, T + HOUR);
    s = placeMarket(s, { side: "buy", quantity: 1, price: 100, stop: null, takeProfit: null, atMs: T });
    s = closeAt(s, s.positions[0].id, 96, T + 2 * HOUR);
    expect(summarize(s)).toMatchObject({ trades: 2, wins: 1, winRate: 0.5, netPnl: 6, openPositions: 0 });
  });

  it("gates trading and bar advance on the high-water mark", () => {
    // The rewind-and-cheat loophole: a rewound cursor may neither place orders
    // nor re-run the bars it already played (which would re-fill filled orders).
    expect(canPlaceAt(100, 100)).toBe(true);
    expect(canPlaceAt(99, 100)).toBe(false);
    expect(shouldAdvanceAt(101, 100)).toBe(true);
    expect(shouldAdvanceAt(100, 100)).toBe(false);
  });

  it("mints stable ids without crypto, so a persisted session resumes intact", () => {
    const s = placeMarket(emptyLedger(), { side: "buy", quantity: 1, price: 100, stop: null, takeProfit: null, atMs: T });
    expect(s.positions[0].id).toBe("rp1");
    expect(s.seq).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/replayLedger.test.ts`
Expected: FAIL — cannot resolve `./replayLedger`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/replayLedger.ts`:

```ts
// The per-session trading book for chart replay: pure, bar-driven, and entirely
// separate from the real paper journal.
//
// Why not the paper executor: that one lives in the BACKEND
// (auto_trader/brokers/paper_exec.py), prices fills from the live tick snapshot,
// and books into the real paper account. A replay fill must price off the bar
// the user is looking at, in the past, in a book nobody else can see.
//
// The intrabar convention is copied verbatim from the BACKTESTER
// (backend/auto_trader/engine/backtest.py::_intrabar_exit) so a replay trade and
// a revealed strategy trade on the same bar resolve identically:
//   1. a gap through the target at the open exits AT the target,
//   2. otherwise the STOP wins when one bar's range spans both (risk first),
//      filling at min(open, stop) for a long — the pessimistic side,
//   3. otherwise the target when the extreme reaches it.
// A position opened on a bar may also exit on that bar.
//
// No cost model: fills use raw bar prices (the chart's priceSide already selects
// bid/mid/ask candles). The report card says so.
import type { KLineData } from "klinecharts";
import type { OrderSide, TradeView } from "./trading";

export interface ReplayOrder {
  id: string;
  side: OrderSide;
  quantity: number;
  limit: number;
  stop: number | null;
  takeProfit: number | null;
  placedMs: number;
}

export interface ReplayPosition {
  id: string;
  side: OrderSide;
  quantity: number;
  entry: number;
  stop: number | null;
  takeProfit: number | null;
  openedMs: number;
}

export interface ReplayClosedTrade {
  side: OrderSide;
  quantity: number;
  entry: number;
  exit: number;
  entryMs: number;
  exitMs: number;
  pnl: number;
  reason: "stop" | "target" | "manual";
}

export interface ReplayLedgerState {
  orders: ReplayOrder[];
  positions: ReplayPosition[];
  closed: ReplayClosedTrade[];
  /** Monotonic id counter. Deliberately NOT crypto.randomUUID: ids must survive
   * a JSON round-trip through the persisted session and stay reproducible in tests. */
  seq: number;
}

export function emptyLedger(): ReplayLedgerState {
  return { orders: [], positions: [], closed: [], seq: 0 };
}

const pnlOf = (side: OrderSide, entry: number, exit: number, qty: number): number =>
  (side === "buy" ? exit - entry : entry - exit) * qty;

export function placeMarket(
  s: ReplayLedgerState,
  a: {
    side: OrderSide;
    quantity: number;
    price: number;
    stop: number | null;
    takeProfit: number | null;
    atMs: number;
  },
): ReplayLedgerState {
  const seq = s.seq + 1;
  return {
    ...s,
    seq,
    positions: [
      ...s.positions,
      {
        id: `rp${seq}`,
        side: a.side,
        quantity: a.quantity,
        entry: a.price,
        stop: a.stop,
        takeProfit: a.takeProfit,
        openedMs: a.atMs,
      },
    ],
  };
}

export function placeLimit(
  s: ReplayLedgerState,
  a: {
    side: OrderSide;
    quantity: number;
    limit: number;
    stop: number | null;
    takeProfit: number | null;
    atMs: number;
  },
): ReplayLedgerState {
  const seq = s.seq + 1;
  return {
    ...s,
    seq,
    orders: [
      ...s.orders,
      {
        id: `ro${seq}`,
        side: a.side,
        quantity: a.quantity,
        limit: a.limit,
        stop: a.stop,
        takeProfit: a.takeProfit,
        placedMs: a.atMs,
      },
    ],
  };
}

export function cancelOrder(s: ReplayLedgerState, id: string): ReplayLedgerState {
  return { ...s, orders: s.orders.filter((o) => o.id !== id) };
}

export function closeAt(
  s: ReplayLedgerState,
  id: string,
  price: number,
  atMs: number,
): ReplayLedgerState {
  const p = s.positions.find((x) => x.id === id);
  if (!p) return s;
  return {
    ...s,
    positions: s.positions.filter((x) => x.id !== id),
    closed: [
      ...s.closed,
      {
        side: p.side,
        quantity: p.quantity,
        entry: p.entry,
        exit: price,
        entryMs: p.openedMs,
        exitMs: atMs,
        pnl: pnlOf(p.side, p.entry, price, p.quantity),
        reason: "manual",
      },
    ],
  };
}

/** Apply dragged/edited levels. `price` moves a RESTING order's limit (a filled
 * position's entry is history); `stop`/`takeProfit` apply to either. Undefined
 * means "unchanged", null means "removed" — the same by-presence convention
 * mergeTradeLevels uses. */
export function editLevels(
  s: ReplayLedgerState,
  id: string,
  e: { price?: number | null; stop?: number | null; takeProfit?: number | null },
): ReplayLedgerState {
  const patch = <T extends { stop: number | null; takeProfit: number | null }>(t: T): T => ({
    ...t,
    stop: e.stop !== undefined ? e.stop : t.stop,
    takeProfit: e.takeProfit !== undefined ? e.takeProfit : t.takeProfit,
  });
  return {
    ...s,
    orders: s.orders.map((o) =>
      o.id === id ? { ...patch(o), limit: e.price != null ? e.price : o.limit } : o,
    ),
    positions: s.positions.map((p) => (p.id === id ? patch(p) : p)),
  };
}

/** Advance the book over one newly revealed bar: resting limits fill first, then
 * every open position (including one just filled) is tested for stop/target.
 * `closeMs` is the bar's close — the instant every fill on this bar is stamped
 * with, so the ledger's times line up with the replay cursor. */
export function advanceBar(
  s: ReplayLedgerState,
  bar: KLineData,
  closeMs: number,
): ReplayLedgerState {
  let next = s;

  // 1) Resting limit orders. A buy fills when the market trades at or below the
  //    limit, at the limit — or better if the bar OPENED through it.
  for (const o of s.orders) {
    const crossed = o.side === "buy" ? bar.low <= o.limit : bar.high >= o.limit;
    if (!crossed) continue;
    const fill = o.side === "buy" ? Math.min(o.limit, bar.open) : Math.max(o.limit, bar.open);
    next = {
      ...next,
      seq: next.seq + 1,
      orders: next.orders.filter((x) => x.id !== o.id),
      positions: [
        ...next.positions,
        {
          id: `rp${next.seq + 1}`,
          side: o.side,
          quantity: o.quantity,
          entry: fill,
          stop: o.stop,
          takeProfit: o.takeProfit,
          openedMs: closeMs,
        },
      ],
    };
  }

  // 2) Stop / target for every open position, backtester order.
  for (const p of [...next.positions]) {
    if (p.stop == null && p.takeProfit == null) continue;
    let hit: { price: number; reason: "stop" | "target" } | null = null;
    if (p.side === "buy") {
      if (p.takeProfit != null && bar.open >= p.takeProfit) {
        hit = { price: p.takeProfit, reason: "target" };
      } else if (p.stop != null && bar.low <= p.stop) {
        hit = { price: Math.min(bar.open, p.stop), reason: "stop" };
      } else if (p.takeProfit != null && bar.high >= p.takeProfit) {
        hit = { price: p.takeProfit, reason: "target" };
      }
    } else {
      if (p.takeProfit != null && bar.open <= p.takeProfit) {
        hit = { price: p.takeProfit, reason: "target" };
      } else if (p.stop != null && bar.high >= p.stop) {
        hit = { price: Math.max(bar.open, p.stop), reason: "stop" };
      } else if (p.takeProfit != null && bar.low <= p.takeProfit) {
        hit = { price: p.takeProfit, reason: "target" };
      }
    }
    if (!hit) continue;
    next = {
      ...next,
      positions: next.positions.filter((x) => x.id !== p.id),
      closed: [
        ...next.closed,
        {
          side: p.side,
          quantity: p.quantity,
          entry: p.entry,
          exit: hit.price,
          entryMs: p.openedMs,
          exitMs: closeMs,
          pnl: pnlOf(p.side, p.entry, hit.price, p.quantity),
          reason: hit.reason,
        },
      ],
    };
  }

  return next;
}

/** Project the book into the shape the chart's position lines, pills and bracket
 * already consume, so replay reuses that whole layer untouched. `mark` is the
 * cursor bar's close (null before any bar is revealed). */
export function toTradeViews(
  s: ReplayLedgerState,
  epic: string,
  mark: number | null,
): TradeView[] {
  return [
    ...s.positions.map(
      (p): TradeView => ({
        kind: "position",
        id: p.id,
        epic,
        side: p.side,
        quantity: p.quantity,
        priceLevel: p.entry,
        stop: p.stop,
        takeProfit: p.takeProfit,
        upnl: mark == null ? null : pnlOf(p.side, p.entry, mark, p.quantity),
        openedAt: p.openedMs,
        expiresAt: null,
        leverage: null,
        margin: null,
        source: "manual",
      }),
    ),
    ...s.orders.map(
      (o): TradeView => ({
        kind: "order",
        id: o.id,
        epic,
        side: o.side,
        quantity: o.quantity,
        priceLevel: o.limit,
        stop: o.stop,
        takeProfit: o.takeProfit,
        upnl: null,
        openedAt: o.placedMs,
        expiresAt: null,
        leverage: null,
        margin: null,
        source: "manual",
      }),
    ),
  ];
}

export interface ReplaySummary {
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  openPositions: number;
}

/** The high-water trading gate. Trading is legal only at the session's leading
 * edge: step-back is a VIEW-ONLY rewind, so trades never un-happen and the user
 * must not be able to act on bars they have already seen. */
export function canPlaceAt(cursorMs: number, highWaterMs: number): boolean {
  return cursorMs >= highWaterMs;
}

/** Whether a step should ADVANCE the book over its newly revealed bar. Only a
 * cursor moving past the high-water mark reaches new market data; replaying a
 * bar already played must not re-fill the orders it already filled. */
export function shouldAdvanceAt(cursorMs: number, highWaterMs: number): boolean {
  return cursorMs > highWaterMs;
}

export function summarize(s: ReplayLedgerState): ReplaySummary {
  const trades = s.closed.length;
  const wins = s.closed.filter((t) => t.pnl > 0).length;
  const netPnl = s.closed.reduce((a, t) => a + t.pnl, 0);
  return {
    trades,
    wins,
    winRate: trades ? wins / trades : 0,
    netPnl,
    openPositions: s.positions.length,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/replayLedger.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Tighten the persisted type and commit**

In `frontend/src/lib/replaySession.ts`, replace `ledger: unknown;` with:

```ts
  ledger: ReplayLedgerState | null;
```

and `import type { ReplayLedgerState } from "./replayLedger";`.

```bash
git add frontend/src/lib/replayLedger.ts frontend/src/lib/replayLedger.test.ts frontend/src/lib/replaySession.ts
git commit -m "feat(replay): bar-driven session ledger with backtester fill rules"
```

---

### Task 12: Manual trading during replay

Wire the ledger to the cell: a compact ticket, the existing draggable lines/pills pointed at the ledger, and the high-water rule that closes the rewind-and-cheat loophole.

**Files:**
- Create: `frontend/src/ReplayTicket.tsx`
- Modify: `frontend/src/chart/useReplay.ts` (own the ledger, advance it per step, publish views)
- Modify: `frontend/src/chart/TradePills.tsx` (optional `actions` prop)
- Modify: `frontend/src/ChartCore.tsx` (don't let the global feed stomp a replaying cell; pass replay actions to TradePills; render the ticket)

**Interfaces:**
- Consumes: everything from Task 11; `handle.tradesRef`, `handle.posDrawRef`, `handle.redrawRef`.
- Produces:
  - `ReplayApi` gains: `ledger: ReplayLedgerState`, `canTrade: boolean`, `place(a: { side; quantity; type: "market" | "limit"; price: number | null; stop: number | null; takeProfit: number | null }): void`, `closeTrade(id: string): void`, `cancel(id: string): void`, `edit(id, e): void`, `markPrice: number | null` (the value, computed by the hook's `markPriceNow()`).
  - `TradePillsProps.actions?: { apply(t: TradeView, merged): Promise<void>; close(t: TradeView): Promise<void>; cancel(t: TradeView): Promise<void> }`

- [ ] **Step 1: Give the hook the ledger**

In `frontend/src/chart/useReplay.ts`:

```ts
import {
  advanceBar,
  canPlaceAt,
  cancelOrder,
  closeAt,
  editLevels,
  emptyLedger,
  placeLimit,
  placeMarket,
  shouldAdvanceAt,
  toTradeViews,
  type ReplayLedgerState,
} from "../lib/replayLedger";
import { revealedCount } from "../lib/replayBars";
```

State + publication:

```ts
  const [ledger, setLedger] = useState<ReplayLedgerState>(() => {
    const saved = loadReplaySession(scope);
    return (saved?.epic === epic && saved.ledger) || emptyLedger();
  });
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;

  /** The price a replay trade transacts at: the close of the newest revealed bar. */
  const markPriceNow = useCallback((): number | null => {
    const res = storeResRef.current;
    const n = revealedCount(barsRef.current, latest.current.state.cursorMs, nominalMs(res));
    return n > 0 ? barsRef.current[n - 1].close : null;
  }, [nominalMs]);

  // Publish the book into the cell's existing trade-line layer: the same
  // TradeView array the live feed writes, so lines, pills, bracket and drag all
  // work unchanged (ChartCore stops feeding it from the global feed while
  // replaying — see its subscribeTrades guard).
  const publishLedger = useCallback(
    (next: ReplayLedgerState) => {
      setLedger(next);
      ledgerRef.current = next;
      handle.tradesRef.current = toTradeViews(next, latest.current.epic, markPriceNow());
      handle.posDrawRef.current();
      handle.redrawRef.current();
    },
    [handle, markPriceNow],
  );
```

Advance the ledger inside `stepForward`, right after the state update and before
`applySlice` — the newly revealed bar is the one to advance over:

```ts
    const res2 = storeResRef.current;
    const idx = revealedCount(barsRef.current, next, nominalMs(res2)) - 1;
    const newBar = barsRef.current[idx];
    // Fills only ever happen when the cursor moves PAST the high-water mark: a
    // replayed-again bar must not re-trigger the orders it already filled.
    if (newBar && shouldAdvanceAt(next, cur.state.highWaterMs)) {
      publishLedger(advanceBar(ledgerRef.current, newBar, next));
    } else {
      publishLedger(ledgerRef.current); // re-mark P&L at the new cursor
    }
```

Trading actions (all gated on the high-water rule):

```ts
  /** Trading is live only at the session's leading edge. While rewound the book
   * is frozen: trades cannot un-happen, so letting the user act on bars they have
   * already seen would be trading with hindsight. */
  const canTrade = state.mode === "active" && canPlaceAt(state.cursorMs, state.highWaterMs);

  const place = useCallback(
    (a: {
      side: "buy" | "sell";
      quantity: number;
      type: "market" | "limit";
      price: number | null;
      stop: number | null;
      takeProfit: number | null;
    }) => {
      const cur = latest.current;
      if (cur.state.mode !== "active" || !canPlaceAt(cur.state.cursorMs, cur.state.highWaterMs)) return;
      const mark = markPriceNow();
      if (mark == null) return;
      publishLedger(
        a.type === "market"
          ? placeMarket(ledgerRef.current, {
              side: a.side, quantity: a.quantity, price: mark,
              stop: a.stop, takeProfit: a.takeProfit, atMs: cur.state.cursorMs,
            })
          : placeLimit(ledgerRef.current, {
              side: a.side, quantity: a.quantity, limit: a.price ?? mark,
              stop: a.stop, takeProfit: a.takeProfit, atMs: cur.state.cursorMs,
            }),
      );
    },
    [markPriceNow, publishLedger],
  );

  const closeTrade = useCallback((id: string) => {
    const mark = markPriceNow();
    if (mark == null) return;
    publishLedger(closeAt(ledgerRef.current, id, mark, latest.current.state.cursorMs));
  }, [markPriceNow, publishLedger]);

  const cancel = useCallback(
    (id: string) => publishLedger(cancelOrder(ledgerRef.current, id)),
    [publishLedger],
  );

  const edit = useCallback(
    (id: string, e: { price?: number | null; stop?: number | null; takeProfit?: number | null }) =>
      publishLedger(editLevels(ledgerRef.current, id, e)),
    [publishLedger],
  );
```

Persist the ledger: change the persistence effect's `ledger: null` to
`ledger: ledgerRef.current` and add `ledger` to its dep array. Clear it in
`exit()` with `setLedger(emptyLedger())`, `handle.tradesRef.current = []` and a
`refreshTrades()` (exported from `../lib/trading`). The refresh is not optional:
the global trades feed is EVENT-driven (a fetch on subscribe, then only on
actions and backend pushes), so without it the cell would show no position lines
at all until the next trade event — possibly for the rest of the session.

Add `ledger`, `canTrade`, `place`, `closeTrade`, `cancel`, `edit`,
`markPrice: markPriceNow()` to the returned `ReplayApi` (and to its interface).

- [ ] **Step 2: Stop the global feed from stomping a replaying cell**

In `frontend/src/ChartCore.tsx`, in the `subscribeTrades` callback:

```tsx
      const unsubTrades = subscribeTrades((t) => {
        // A replaying cell's book is the replay ledger, not the account's. The
        // account's real positions belong to real time and must not draw here.
        if (replayActiveRef.current) return;
        tradesRef.current = t;
        drawPositions();
        drawTradeMarkers();
        handle.redrawRef.current();
      });
```

- [ ] **Step 3: Route the pills' actions**

In `frontend/src/chart/TradePills.tsx`, add to `TradePillsProps`:

```ts
  /** Where Apply / Close / Cancel go. Defaults to the account's HTTP dealing
   * calls; a replaying cell passes ledger-backed implementations instead. */
  actions?: {
    apply(t: TradeView, merged: { price: number | null; stop: number | null; takeProfit: number | null }): Promise<void>;
    close(t: TradeView): Promise<void>;
    cancel(t: TradeView): Promise<void>;
  };
```

Default it once at the top of the component:

```tsx
  const act = actions ?? {
    apply: async (t, merged) => {
      await applyEditedLevels(t, merged, getTradesAccount());
      refreshTrades();
    },
    close: async (t) => {
      await closePosition(t.id, getTradesAccount());
      refreshTrades();
    },
    cancel: async (t) => {
      await cancelWorkingOrder(t.id, getTradesAccount());
      refreshTrades();
    },
  };
```

and replace the three call sites:
- `removeLevel`: `await applyEditedLevels(t, merged, getTradesAccount()); ... refreshTrades();` → `await act.apply(t, merged);`
- the Apply button: same substitution.
- the confirm's `onConfirm`: `if (isOrder) await cancelWorkingOrder(...) else await closePosition(...); ... refreshTrades();` → `if (isOrder) await act.cancel(t); else await act.close(t);`

(`discardPendingEdit` / `setTradeSelected` calls around them stay.)

- [ ] **Step 4: Pass the replay actions from ChartCore**

At the `<TradePills ... />` render:

```tsx
        actions={
          replay.state.mode === "active"
            ? {
                apply: async (t, merged) => {
                  replay.edit(t.id, { price: merged.price, stop: merged.stop, takeProfit: merged.takeProfit });
                },
                close: async (t) => replay.closeTrade(t.id),
                cancel: async (t) => replay.cancel(t.id),
              }
            : undefined
        }
```

- [ ] **Step 5: Write the ticket**

Create `frontend/src/ReplayTicket.tsx`:

```tsx
// Order entry for a replay session. Deliberately NOT the app's OrderTicket: that
// one submits to a broker account over HTTP at live prices. This writes to the
// cell's replay ledger at the cursor bar's close.
import { useState } from "react";
import Tooltip from "./components/Tooltip";

interface Props {
  /** Cursor bar close: what a market order fills at. */
  mark: number | null;
  precision: number;
  /** False while the cursor is rewound behind the high-water mark. */
  canTrade: boolean;
  /** Formatted high-water time to return to (already masked when masked). */
  returnTo: string;
  onPlace(a: {
    side: "buy" | "sell";
    quantity: number;
    type: "market" | "limit";
    price: number | null;
    stop: number | null;
    takeProfit: number | null;
  }): void;
  onClose(): void;
}

export default function ReplayTicket({ mark, precision, canTrade, returnTo, onPlace, onClose }: Props) {
  const [type, setType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [stop, setStop] = useState("");
  const [tp, setTp] = useState("");

  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));
  const submit = (side: "buy" | "sell") =>
    onPlace({
      side,
      quantity: Math.max(1, Number(qty) || 1),
      type,
      price: type === "limit" ? num(price) : null,
      stop: num(stop),
      takeProfit: num(tp),
    });

  return (
    <div className="replay-ticket">
      <div className="rt-head">
        <span>Replay trade</span>
        <button className="rt-close" aria-label="Close ticket" onClick={onClose}>
          ✕
        </button>
      </div>

      {!canTrade && (
        <div className="rt-locked">
          Rewound: step forward to {returnTo} to trade. Trades already taken stand.
        </div>
      )}

      <div className="rt-row">
        <div className="seg rt-seg">
          <button className={type === "market" ? "seg-on" : ""} onClick={() => setType("market")}>
            Market
          </button>
          <button className={type === "limit" ? "seg-on" : ""} onClick={() => setType("limit")}>
            Limit
          </button>
        </div>
        <span className="rt-mark">{mark != null ? mark.toFixed(precision) : "-"}</span>
      </div>

      <div className="rt-row">
        <label className="rt-label">Units</label>
        <input className="rt-input" value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      {type === "limit" && (
        <div className="rt-row">
          <label className="rt-label">Limit</label>
          <input className="rt-input" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
      )}
      <div className="rt-row">
        <label className="rt-label">Stop</label>
        <input className="rt-input" value={stop} onChange={(e) => setStop(e.target.value)} />
      </div>
      <div className="rt-row">
        <label className="rt-label">Target</label>
        <input className="rt-input" value={tp} onChange={(e) => setTp(e.target.value)} />
      </div>

      <div className="rt-actions">
        <Tooltip content="Sell at the current replay price">
          <button className="rt-sell" disabled={!canTrade || mark == null} onClick={() => submit("sell")}>
            Sell
          </button>
        </Tooltip>
        <Tooltip content="Buy at the current replay price">
          <button className="rt-buy" disabled={!canTrade || mark == null} onClick={() => submit("buy")}>
            Buy
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
```

Add a "Trade" toggle button to `ReplayPill` (`onToggleTicket` prop + `ticketOpen`
flag) and render `<ReplayTicket />` from ChartCore when it is open, with
`returnTo` formatted through the same `replayReadout` formatter applied to
`state.highWaterMs`.

- [ ] **Step 6: Add the styles**

Append to `frontend/src/App.css`:

```css
.replay-ticket {
  position: absolute; right: 12px; bottom: 52px; z-index: 42;
  width: 210px; padding: 10px; border-radius: 8px;
  background: var(--surface); border: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text);
}
.rt-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
.rt-close { background: none; border: none; color: var(--text); cursor: pointer; }
.rt-locked {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-radius: 6px; padding: 6px; line-height: 1.35;
}
.rt-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.rt-label { opacity: 0.85; }
.rt-input {
  width: 92px; background: var(--input-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px; padding: 3px 6px; font-size: 12px;
}
.rt-mark { font-variant-numeric: tabular-nums; }
.rt-seg { font-size: 11px; }
.rt-actions { display: flex; gap: 6px; }
.rt-buy, .rt-sell {
  flex: 1; padding: 5px 0; border-radius: 6px; border: none; cursor: pointer;
  color: #fff; font-weight: 600;
}
.rt-buy { background: var(--pos); }
.rt-sell { background: var(--neg); }
.rt-buy:disabled, .rt-sell:disabled { opacity: 0.45; cursor: default; }
```

- [ ] **Step 7: Verify by hand**

Dev server, in a replay session:
- Buy market: an entry line + pill appear at the cursor bar's close; P&L updates as you step.
- Set a stop above/below and step until it is crossed: the position closes on the right bar with the stop's price.
- Place a limit away from price: a resting order line appears and fills when a bar's range reaches it.
- Drag the stop line and Apply: the level moves (no network call — check the devtools Network tab stays quiet).
- Step back: the ticket shows the rewound note and Buy/Sell are disabled; the open position stays on the chart.
- The app's positions dock does NOT show the replay position (it is cell-local, and correct).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/ReplayTicket.tsx frontend/src/ReplayPill.tsx frontend/src/chart/useReplay.ts frontend/src/chart/TradePills.tsx frontend/src/ChartCore.tsx frontend/src/App.css
git commit -m "feat(replay): manual trading against the session ledger"
```

---

### Task 13: Session report card

The exit reveal: what the session did, and — for a masked session — when it actually was.

**Files:**
- Create: `frontend/src/ReplayReportCard.tsx`
- Modify: `frontend/src/chart/useReplay.ts` (`requestExit` / `confirmExit`)
- Modify: `frontend/src/ChartCore.tsx` (render it), `frontend/src/App.css`

**Interfaces:**
- Consumes: `summarize` (Task 11).
- Produces:
  - `ReplayApi.requestExit(): void` — opens the card instead of exiting outright.
  - `ReplayApi.pendingReport: { summary: ReplaySummary; startMs: number; cursorMs: number; masked: boolean } | null`
  - `ReplayApi.dismissReport(): void` — closes the card and performs the real exit.
  - `ReplayApi.exit()` stays the immediate teardown (used by the symbol-change guard).

- [ ] **Step 1: Add the exit-with-report flow to the hook**

```ts
  const [pendingReport, setPendingReport] = useState<{
    summary: ReplaySummary;
    startMs: number;
    cursorMs: number;
    masked: boolean;
  } | null>(null);

  /** Exit path from the UI: show what happened first. A session with no trades
   * and no masking has nothing to reveal, so it exits straight away. */
  const requestExit = useCallback(() => {
    const s = latest.current.state;
    const sum = summarize(ledgerRef.current);
    if (sum.trades === 0 && sum.openPositions === 0 && !s.masked) {
      exit();
      return;
    }
    setPendingReport({ summary: sum, startMs: s.startMs, cursorMs: s.cursorMs, masked: s.masked });
    setState((st) => ({ ...st, playing: false }));
  }, [exit]);

  const dismissReport = useCallback(() => {
    setPendingReport(null);
    exit();
  }, [exit]);
```

Wire the pill's ✕ and "pick new start" to `requestExit` (for "pick new start",
after the card is dismissed re-enter picking: keep a `restartAfterReport` ref, or
simply have the card carry a second button — see Step 2).

- [ ] **Step 2: Write the card**

Create `frontend/src/ReplayReportCard.tsx`:

```tsx
// Shown when a replay session ends: what the session did, and — for a blind
// session — when it actually was. The reveal is the point: a masked session
// deliberately never showed a real date until now.
import type { ReplaySummary } from "./lib/replayLedger";

interface Props {
  summary: ReplaySummary;
  /** Real (unmasked) session bounds, formatted by the caller in the cell's timezone. */
  startLabel: string;
  endLabel: string;
  masked: boolean;
  onDone(): void;
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;

export default function ReplayReportCard({ summary, startLabel, endLabel, masked, onDone }: Props) {
  return (
    <div className="replay-report" role="dialog" aria-label="Replay session report">
      <div className="rr-title">Session report</div>

      {masked && (
        <div className="rr-reveal">
          <span className="rr-reveal-label">This was</span>
          <span className="rr-reveal-range">
            {startLabel} to {endLabel}
          </span>
        </div>
      )}

      <div className="rr-stats">
        <div className="rr-stat">
          <span className="rr-k">Trades</span>
          <span className="rr-v">{summary.trades}</span>
        </div>
        <div className="rr-stat">
          <span className="rr-k">Win rate</span>
          <span className="rr-v">{summary.trades ? pct(summary.winRate) : "-"}</span>
        </div>
        <div className="rr-stat">
          <span className="rr-k">Net P&amp;L</span>
          <span className={`rr-v ${summary.netPnl >= 0 ? "pos" : "neg"}`}>{signed(summary.netPnl)}</span>
        </div>
        {summary.openPositions > 0 && (
          <div className="rr-stat">
            <span className="rr-k">Still open</span>
            <span className="rr-v">{summary.openPositions}</span>
          </div>
        )}
      </div>

      <div className="rr-note">
        Prices come straight from the candles: no spread, slippage or commission.
      </div>

      <button className="rr-done" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Render it and format the reveal**

In ChartCore, next to the pill:

```tsx
      {replay.pendingReport && (
        <ReplayReportCard
          summary={replay.pendingReport.summary}
          // The reveal is always UNMASKED — that is the whole point of the card.
          startLabel={formatRealTime(replay.pendingReport.startMs)}
          endLabel={formatRealTime(replay.pendingReport.cursorMs)}
          masked={replay.pendingReport.masked}
          onDone={replay.dismissReport}
        />
      )}
```

where `formatRealTime` is a small local memo using `makeFormatDate(clock, dateFormat, showWeekday)` and the same `Intl.DateTimeFormat` construction as `replayReadout` (factor the `dtf` out of `replayReadout` into a shared memo so the two cannot drift).

- [ ] **Step 4: Styles**

```css
.replay-report {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 60;
  min-width: 280px; padding: 16px 18px; border-radius: 10px;
  background: var(--surface); border: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 10px; color: var(--text);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
.rr-title { font-size: 14px; font-weight: 600; }
.rr-reveal { display: flex; flex-direction: column; gap: 2px; }
.rr-reveal-label { font-size: 11px; opacity: 0.7; }
.rr-reveal-range { font-size: 13px; color: var(--accent); font-variant-numeric: tabular-nums; }
.rr-stats { display: flex; flex-direction: column; gap: 4px; }
.rr-stat { display: flex; justify-content: space-between; font-size: 12px; }
.rr-k { opacity: 0.8; }
.rr-v { font-variant-numeric: tabular-nums; }
.rr-v.pos { color: var(--pos); }
.rr-v.neg { color: var(--neg); }
.rr-note { font-size: 11px; opacity: 0.7; line-height: 1.4; }
.rr-done {
  align-self: flex-end; background: var(--accent); color: var(--accent-text);
  border: none; border-radius: 6px; padding: 5px 14px; font-size: 12px; cursor: pointer;
}
```

- [ ] **Step 5: Verify by hand**

Take two trades in a masked session, then hit ✕: the card shows the counts, the
win rate, the net P&L and the real date range. "Done" returns the cell to live
data with the axis showing real dates again.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/ReplayReportCard.tsx frontend/src/chart/useReplay.ts frontend/src/ChartCore.tsx frontend/src/App.css
git commit -m "feat(replay): session report card with the date reveal"
```

---

### Task 14: Progressive strategy reveal

The cell's saved backtest, revealed bar by bar as the cursor passes each fill.

**Files:**
- Create: `frontend/src/lib/replayReveal.ts`
- Test: `frontend/src/lib/replayReveal.test.ts`
- Modify: `frontend/src/chart/useReplay.ts` (the toggle + re-render on step), `frontend/src/ReplayPill.tsx`, `frontend/src/ChartCore.tsx`

**Interfaces:**
- Consumes: `StoredBacktestResult` (`lib/persist`), `loadBacktestResult` (`lib/persist`), `renderArtifacts` / `teardownArtifacts` / `backtestRenderFlags` (`lib/backtest`), `backtestResultSignal` (`lib/signals`).
- Produces: `filterResultToCursor(result: StoredBacktestResult, cursorMs: number): StoredBacktestResult`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/replayReveal.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { filterResultToCursor } from "./replayReveal";
import type { StoredBacktestResult } from "./persist";

const S = (ms: number) => Math.floor(ms / 1000);
const T = Date.UTC(2026, 2, 2, 12);
const HOUR = 3_600_000;

const result = {
  epic: "US100",
  resolution: "HOUR",
  markers: [
    { time: S(T), side: "buy", price: 100, reason: "entry", leg: "long" },
    { time: S(T + 2 * HOUR), side: "sell", price: 110, reason: "target", leg: "long" },
    { time: S(T + 5 * HOUR), side: "buy", price: 105, reason: "entry", leg: "long" },
  ],
  trades: [
    { entry_time: S(T), exit_time: S(T + 2 * HOUR), pnl: 10 },
    { entry_time: S(T + 5 * HOUR), exit_time: S(T + 7 * HOUR), pnl: -4 },
  ],
  equity: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ time: S(T + i * HOUR), value: 1000 + i })),
  summary: { net_pnl: 6, n_trades: 2, win_rate: 0.5, max_drawdown: 4 },
  metrics: { profit_factor: 2.5, expectancy: 3 },
} as unknown as StoredBacktestResult;

describe("filterResultToCursor", () => {
  it("keeps only markers at or before the cursor", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.markers).toHaveLength(2);
  });

  it("keeps only trades whose EXIT has happened (an open trade is not yet a result)", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.trades).toHaveLength(1);
    expect(out.summary.n_trades).toBe(1);
  });

  it("truncates the equity curve at the cursor", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.equity.map((p) => p.time)).toEqual([S(T), S(T + HOUR), S(T + 2 * HOUR), S(T + 3 * HOUR)]);
  });

  it("recomputes the summary so the panel cannot spoil the outcome", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.summary).toMatchObject({ net_pnl: 10, n_trades: 1, win_rate: 1 });
  });

  it("drops the per-direction breakdown and the run-level metrics that would leak", () => {
    const out = filterResultToCursor(result, T + 3 * HOUR);
    expect(out.by_leg).toBeUndefined();
    expect(out.metrics.profit_factor).not.toBe(2.5);
  });

  it("returns an empty-but-valid result before the first fill", () => {
    const out = filterResultToCursor(result, T - HOUR);
    expect(out.markers).toEqual([]);
    expect(out.trades).toEqual([]);
    expect(out.summary.n_trades).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/lib/replayReveal.test.ts`
Expected: FAIL — cannot resolve `./replayReveal`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/replayReveal.ts`:

```ts
// Progressive strategy reveal for chart replay: the cell's SAVED backtest,
// filtered to what has happened at the cursor. Markers pop in as bars arrive,
// dock rows appear as trades close, and the equity curve draws up to the cursor.
//
// Filtering matters beyond the drawing: renderArtifacts already skips fills
// outside the loaded bar window, but the trades panel and the summary chip read
// the PUBLISHED result — an unfiltered publish would list the future's trades
// and, worse, show the run's final P&L in a blind session.
//
// Backend times are unix SECONDS; the cursor is ms.
import type { StoredBacktestResult } from "./persist";

export function filterResultToCursor(
  result: StoredBacktestResult,
  cursorMs: number,
): StoredBacktestResult {
  const cursorSec = Math.floor(cursorMs / 1000);
  const markers = result.markers.filter((m) => m.time <= cursorSec);
  // A trade only becomes a RESULT when it closes; an open one has no P&L yet.
  const trades = result.trades.filter((t) => t.exit_time <= cursorSec);
  const equity = result.equity.filter((p) => p.time <= cursorSec);

  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.value);
    maxDd = Math.max(maxDd, peak - p.value);
  }
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  const losses = trades.length - wins;
  const first = equity[0]?.value ?? 0;
  const last = equity[equity.length - 1]?.value ?? first;

  return {
    ...result,
    markers,
    trades,
    equity,
    summary: {
      net_pnl: netPnl,
      n_trades: trades.length,
      win_rate: trades.length ? wins / trades.length : 0,
      max_drawdown: maxDd,
    },
    // Running values only. The fields that need whole-run context
    // (avg_duration_bars, sharpe/sortino/calmar/cagr/sqn/exposure) are omitted
    // rather than carried over: a run-level figure next to a partial trade list
    // is exactly the spoiler this feature exists to avoid.
    metrics: {
      return_pct: first ? ((last - first) / first) * 100 : 0,
      profit_factor: grossLoss > 0 ? grossWin / grossLoss : null,
      expectancy: trades.length ? netPnl / trades.length : 0,
      avg_win: wins ? grossWin / wins : 0,
      avg_loss: losses ? -grossLoss / losses : 0,
      avg_win_loss_ratio: losses && wins && grossLoss > 0 ? grossWin / wins / (grossLoss / losses) : null,
      largest_win: trades.reduce((a, t) => Math.max(a, t.pnl), 0),
      largest_loss: trades.reduce((a, t) => Math.min(a, t.pnl), 0),
      max_drawdown_pct: first ? (maxDd / first) * 100 : 0,
      avg_duration_bars: 0,
      max_consec_wins: 0,
      max_consec_losses: 0,
    },
    by_leg: undefined,
  };
}
```

Deliberately NOT filtered: `period` (the run's trading-window shading) rides
through the `...result` spread and paints its full band, extending right of the
cursor. That is the run's CONFIGURED window, not an outcome — it reveals nothing
about what price did — and clipping it would make the band jitter on every step.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/lib/replayReveal.test.ts`
Expected: PASS. Adjust ONLY the test's expectations for fields your `BacktestResult` type actually requires (the type is `api.ts`'s `BacktestResult` minus `candles`); every required metric field must be present in the returned object or `tsc` fails.

- [ ] **Step 5: Wire the toggle**

In `frontend/src/chart/useReplay.ts`:

```ts
  const [showStrategy, setShowStrategy] = useState(false);
  // Marker/trade counts last drawn, so an unchanged reveal skips the redraw.
  const revealSigRef = useRef("");

  // Re-render the revealed slice whenever the cursor moves (coalesced to a frame:
  // 10x playback steps every 100ms and renderArtifacts rebuilds overlays).
  useEffect(() => {
    const chart = handle.chartRef.current;
    if (!chart) return;
    if (state.mode !== "active" || !showStrategy) return;
    const saved = loadBacktestResult(scope, epic);
    if (!saved) return;
    const raf = requestAnimationFrame(() => {
      const shown = filterResultToCursor(saved, latest.current.state.cursorMs);
      // Most steps reveal nothing new. Re-rendering anyway would rebuild every
      // marker overlay ten times a second at 10x AND drop the user's trade
      // selection (teardownArtifacts resets selectedTradeSignal /
      // highlightTradeSignal), so only redraw when the revealed set changes.
      const sig = `${shown.markers.length}:${shown.trades.length}`;
      if (revealSigRef.current === sig) return;
      revealSigRef.current = sig;
      teardownArtifacts(chart);
      const flags = backtestRenderFlags(latest.current.resolution, saved.resolution);
      renderArtifacts(chart, shown, { markerMode: flags.markerMode, canEquity: flags.drawEquity });
      backtestResultSignal.set(shown);
    });
    return () => cancelAnimationFrame(raf);
  }, [state.mode, state.cursorMs, showStrategy, scope, epic, handle]);

  // Turning it OFF (or ending the session) restores the cell's own saved result.
  const toggleStrategy = useCallback(() => {
    setShowStrategy((v) => {
      if (v) {
        const chart = handle.chartRef.current;
        if (chart) rehydrateBacktest(chart, latest.current.scope, latest.current.epic, latest.current.resolution);
      }
      return !v;
    });
  }, [handle]);
```

Expose `showStrategy`, `toggleStrategy`, and `hasStrategy` (computed as
`loadBacktestResult(scope, epic) != null`, read once per session start into
state) on `ReplayApi`.

Add the toggle to `ReplayPill`:

```tsx
      <Tooltip
        content={
          hasStrategy
            ? "Reveal the saved backtest as the cursor passes each trade"
            : "Run a backtest on this chart first"
        }
      >
        <button
          className={`rp-btn${showStrategy ? " rp-on" : ""}`}
          disabled={!hasStrategy}
          onClick={onToggleStrategy}
        >
          Strategy
        </button>
      </Tooltip>

(`hasStrategy`, `showStrategy` and `onToggleStrategy` join `ReplayPill`'s props
interface and its destructuring — the component destructures every prop, so do
not reach through a `props` object.)
```

with `.rp-on { background: var(--accent); color: var(--accent-text); }` in the CSS.

Note (deliberate narrowing of spec §7): the reveal uses the cell's SAVED
backtest rather than kicking off a fresh run. Building a run request means
reproducing several hundred lines of BacktestButton's config-to-request logic;
the saved result is the same artifact a rehydrate draws, and the button is
disabled with an explanatory tooltip when the cell has none.

- [ ] **Step 6: Verify by hand**

Run a backtest on a 1H chart, then start a replay inside the tested range and
toggle **Strategy**: markers appear only as the cursor reaches them, the trades
dock grows one row per closed trade, and the summary chip shows running numbers
that never jump ahead of the cursor.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/replayReveal.ts frontend/src/lib/replayReveal.test.ts frontend/src/chart/useReplay.ts frontend/src/ReplayPill.tsx frontend/src/ChartCore.tsx frontend/src/App.css
git commit -m "feat(replay): progressive strategy reveal at the cursor"
```

---

### Task 15: End-to-end spec, backlog removal, docs

**Files:**
- Create: `frontend/e2e/chart-replay.spec.ts`
- Modify: `docs/BACKLOG.md`

- [ ] **Step 1: Write the Playwright spec**

Create `frontend/e2e/chart-replay.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { seedSingleChartDefault, stubStateApi } from "./helpers";

// Bar replay, end to end against the running dev server + backend (the same
// convention every spec in this directory uses — real candles, no candle stub).
//
// Limits of what headless can assert: the time axis, the crosshair label and the
// OHLC tooltip are painted on CANVAS, so the "no absolute date anywhere" claim is
// only checkable here for the DOM chrome (the pill readout). The canvas side is
// covered by the masked-formatter unit tests (src/lib/timeFormat.test.ts) plus
// manual verification.
test("chart replay: jump, step, mask, persist, exit", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await seedSingleChartDefault(page);
  await stubStateApi(page);
  await page.goto("/");
  await page.locator(".tab-bar").waitFor();
  await page.locator(".chart canvas").first().waitFor();

  // Enter picking mode.
  await page.locator(".replay-toggle").click();
  await expect(page.locator(".replay-start-panel")).toBeVisible();

  // Random jump with the default blind ("Hide dates") session.
  await page.locator(".rsp-jump").click();
  const pill = page.locator(".replay-pill");
  await pill.waitFor({ timeout: 20000 });

  // The readout is masked: a relative day, never a real date.
  const readout = page.locator(".rp-readout");
  await expect(readout).toHaveClass(/masked/);
  await expect(readout).toHaveText(/^Day -?\d+/);

  // The quick-range bar (which navigates to "now" and carries a date picker) is
  // gone for the duration of the session.
  await expect(page.locator(".chart-range-bar")).toHaveCount(0);

  // Stepping forward advances the cursor.
  const before = await readout.textContent();
  await page.locator('[aria-label="Step forward"]').click();
  await expect(readout).not.toHaveText(before ?? "");

  // The session is persisted device-locally, keyed by cell scope.
  const saved = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem("auto-trader.replaySessions");
      return raw ? Object.keys(JSON.parse(raw) as Record<string, unknown>).length : 0;
    });
  await expect.poll(saved).toBe(1);

  // A reload resumes the session (mode, mask and cursor all restored).
  await page.reload();
  await page.locator(".replay-pill").waitFor({ timeout: 20000 });
  await expect(page.locator(".rp-readout")).toHaveClass(/masked/);

  // Exit through the report card: the reveal shows a real date range, and the
  // cell returns to live (the quick-range bar comes back).
  await page.locator('[aria-label="Exit replay"]').click();
  await expect(page.locator(".replay-report")).toBeVisible();
  await expect(page.locator(".rr-reveal-range")).toHaveText(/\d{4}|\d{2}\//);
  await page.locator(".rr-done").click();
  await expect(page.locator(".replay-pill")).toHaveCount(0);
  await expect.poll(saved).toBe(0);

  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run it**

Start the backend and the dev server first (the config reuses a running server on
`http://localhost:5173`), then:

Run: `cd frontend && npx playwright test e2e/chart-replay.spec.ts`
Expected: PASS. If the jump lands on an instrument window without candles the
panel shows its "Couldn't find candles" error — that is a real product state, so
if it happens repeatedly for `US100`, widen the spec's window selection to
"Past year" via `.rsp-select` before clicking Jump rather than loosening the
assertions.

- [ ] **Step 3: Run the full unit suite and the typechecker**

Run: `cd frontend && npx tsc -b --noEmit && npx vitest run 2>&1 | tail -20`
Expected: no type errors; no NEW unit failures versus `main`.

Run: `cd frontend && npx eslint src/lib/replay*.ts src/chart/useReplay.ts src/Replay*.tsx`
Expected: clean.

- [ ] **Step 4: Remove the shipped entry from the backlog**

`docs/BACKLOG.md` states its own convention in lines 3-4: "Once a spec ships,
remove it from here". Delete the **Chart replay** bullet (currently lines 15-19)
from the "Specced, ready to implement" section. Leave the spec file in place —
the plan and the spec are the record.

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/chart-replay.spec.ts docs/BACKLOG.md
git commit -m "test(replay): end-to-end replay session spec; drop the backlog entry"
```

---

## Notes for the executor

**Order matters.** Tasks 1-3 are pure and independent. Task 4 needs 1 and 3. Task 5 needs 4 and is the one edit most likely to break the normal (non-replay) chart — review it on its own. Tasks 6-10 need 5. Task 11 is pure and can be written any time after Task 1. Task 12 needs 11 and 7. Tasks 13-14 need 12 and 7.

**Two things that will look like bugs but are not:**
- Step-back parks the view at the right edge (`setBars` → `resetData`). That is where the cursor is; see Global Constraint 6.
- Scroll-back paging during a session works and prepends real older bars. `mergeOlder` keeps them; a later slice apply does not wipe them.

**If a replay session ever paints a bar past the cursor, stop and fix it before continuing.** That is the one defect class this feature cannot ship with.
