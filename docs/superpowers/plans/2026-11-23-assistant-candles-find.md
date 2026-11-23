# Assistant candles_find Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One assistant tool call finds bars matching simple conditions over a long date range, and can mark them on the chart with one Undo.

**Architecture:** Pure scan logic (derive fields, filter, format) in a new `assistant/candleScan.ts`. A fetch helper there re-asks `/api/candles` while the backend reports a partial fill. `assistant/undo.ts` runs `candles_find` as a local tool and, for `mark`, places all drawings through a new batch `placeDrawings` on the drawings overlay manager (one persist), recording one Change.

**Tech Stack:** TypeScript, React app, vitest, klinecharts overlays.

**Spec:** `docs/superpowers/specs/2026-11-23-assistant-candles-find-design.md`

## Global Constraints

- Do not change `drawing.add` (the MCP bridge uses it).
- Tool results stay under `RESULT_CAP` (8192) from `assistant/tools.ts`.
- Refuse windows over 20,000 bars.
- Partial fill: re-ask while `X-Candles-Partial` is set, up to 30 s total, abortable by the turn's signal.
- No em dashes in UI or tool text.
- Run only the affected test files (never the whole frontend suite). Typecheck with `npx tsc -b` from `frontend/`.
- Commit to `main`; stage files by explicit path.

## Review Focus

- A window with zero matches: result says `matched: 0`; `mark` places nothing and records no Change.
- The first bar in the window has no previous bar: its `gap%`, `change%` are `null` and `afterWeekend` is `false`; a `where` on a null field does not match.
- An unknown `where.field` or `op`: error naming the valid ones, nothing fetched.
- `mark` with more matches than 500: error before placing anything (asks for a tighter filter).
- Focus moves to another chart during the fetch: `mark` refuses (FOCUS_CHANGED), nothing placed.

---

### Task 1: Pure scan logic

**Files:**
- Create: `frontend/src/assistant/candleScan.ts`
- Test: `frontend/src/assistant/candleScan.test.ts`

**Interfaces:**
- Produces:
  - `type ScanField = "time" | "weekday" | "open" | "high" | "low" | "close" | "change%" | "gap%" | "afterWeekend"`
  - `const SCAN_FIELDS: readonly ScanField[]`, `const SCAN_OPS = [">", ">=", "<", "<=", "==", "!="] as const`
  - `interface ScanRow { time: number; weekday: number; open: number; high: number; low: number; close: number; "change%": number | null; "gap%": number | null; afterWeekend: boolean }`
  - `interface Cond { field: ScanField; op: (typeof SCAN_OPS)[number]; value: number | boolean }`
  - `deriveRows(bars: KLineData[], barMs: number): ScanRow[]`
  - `checkWhere(where: unknown): Cond[]` (throws `Error` naming valid fields/ops)
  - `matches(row: ScanRow, where: Cond[]): boolean`
  - `formatResult(head: { epic: string; resolution: string; scanned: number; partial: boolean }, rows: ScanRow[], fields: ScanField[], cap: number): string`

Definitions (from the spec):
- `weekday`: for `barMs >= 86_400_000` (daily and longer) `new Date(time + 6 * 3600_000).getUTCDay()` (IG daily bars open 22:00 UTC the day before); for intraday `new Date(time).getUTCDay()`. 0 = Sunday.
- `change%`: `(close - prevClose) / prevClose * 100`; `gap%`: `(open - prevClose) / prevClose * 100`; both rounded to 3 decimals; `null` on the first bar.
- `afterWeekend`: true when BOTH (a) a UTC Saturday overlaps `(prev.time, time)` (let `d` = first UTC midnight strictly after `prev.time`; walk days while `d < time`; true if any is Saturday, or if `prev.time` falls on a UTC Saturday and `time` is on a later day), AND (b) `time - prev.time > 1.5 * barMs` (a real gap, so 24/7 markets never count).
- `formatResult` JSON: `{ epic, resolution, scanned, matched, partial, degraded, cols: fields, rows: [[...], ...], omitted }` (`head` also carries `degraded: string | null`), rows in time order as tuples in `fields` order. If longer than `cap - 64`, drop the oldest 10% of rows per pass (as `indicatorValues` does, `undo.ts:175`) until it fits, and set `omitted` to the count dropped (else 0).

- [ ] **Step 1: Write failing tests** in `candleScan.test.ts`:
  - `deriveRows` on Thu/Fri/Mon daily bars (times 2026-11-12, 11-13, 11-16 at 00:00 UTC, closes 100, 101, opens Monday 103): Monday row has `"gap%": 1.98` (= (103-101)/101*100 rounded to 3 → 1.98), `afterWeekend: true`; Friday row `afterWeekend: false`; first row `"gap%": null`.
  - IG-style daily bars opening 22:00 UTC: Monday session bar at Sunday 2026-11-15T22:00Z has `weekday: 1` and `afterWeekend: true`; the Friday session bar at Thursday 22:00Z has `weekday: 5`.
  - 4H bars Friday 20:00Z then Sunday 22:00Z: second has `afterWeekend: true`, first has `weekday: 5`; Tuesday 00:00Z after Monday 20:00Z: `false`.
  - 24/7 daily bars Fri, Sat, Sun, Mon at 00:00Z: every `afterWeekend` is `false`.
  - `checkWhere([{field: "nope", op: ">", value: 0}])` throws with message containing `gap%`; bad op throws with message containing `>=`.
  - `matches` with `[{field:"gap%",op:">",value:0},{field:"afterWeekend",op:"==",value:true}]`: true for the Monday row, false for the first row (null gap).
  - `formatResult` with 2000 rows and cap 8192: output length < 8192, `omitted > 0`, last tuple is the newest row.
- [ ] **Step 2: Run** `cd frontend && npx vitest run src/assistant/candleScan.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement** the exports above in `candleScan.ts`.
- [ ] **Step 4: Run** the same command; expect PASS.
- [ ] **Step 5: Commit** `git add frontend/src/assistant/candleScan.ts frontend/src/assistant/candleScan.test.ts && git commit -m "feat(assistant): candle scan rows, filter and result format"`

### Task 2: Fetch until filled

**Files:**
- Modify: `frontend/src/assistant/candleScan.ts`
- Test: `frontend/src/assistant/candleScan.test.ts`

**Interfaces:**
- Consumes: `fetchRangeWithStatus(epic, resolution, fromSec, toSec, priceSide, brokerId, signal): Promise<CandlesResult>` from `lib/feed/candles.ts` (`CandlesResult` has `bars`, `degraded: string | null`, `partial: FillProgress | null`).
- Produces: `fetchFilled(args: { epic: string; resolution: string; fromMs: number; toMs: number; priceSide: PriceSide; broker: string; signal: AbortSignal; budgetMs?: number /* default 30000 */; now?: () => number }): Promise<{ bars: KLineData[]; partial: boolean; degraded: string | null }>`

Loop: call `fetchRangeWithStatus`; if `partial` is null, return `{bars, partial: false, degraded}`; else if budget left, call again; else return the last result with `partial: true`. Throw if `signal` is aborted. `degraded` passes through so the tool can tell the model the broker was down.

- [ ] **Step 1: Write failing tests** (mock `../lib/feed/candles` `fetchRangeWithStatus`):
  - first call reports partial, second does not: 2 calls, `partial: false`, bars from the second call.
  - a result with `degraded: "broker unreachable (503)"`: returned as is.
  - always partial with `now` advancing 20 s per call and `budgetMs` 30000: stops, `partial: true`.
  - aborted signal: rejects.
- [ ] **Step 2: Run** `npx vitest run src/assistant/candleScan.test.ts`; expect the new tests to FAIL.
- [ ] **Step 3: Implement** `fetchFilled`. Unix seconds to the API: `Math.floor(fromMs/1000)`, `Math.ceil(toMs/1000)`.
- [ ] **Step 4: Run** again; expect PASS.
- [ ] **Step 5: Commit** `git add frontend/src/assistant/candleScan.ts frontend/src/assistant/candleScan.test.ts && git commit -m "feat(assistant): fetch candles until the backend fill completes"`

### Task 3: The candles_find tool, mark, and prompt

**Files:**
- Modify: `frontend/src/lib/overlays/drawings.ts` (add `placeDrawings` next to `placeDrawing`, ~line 278)
- Modify: `frontend/src/assistant/tools.ts` (`LOCAL_TOOLS`, `LOCAL_DEFS`)
- Modify: `frontend/src/assistant/undo.ts` (`LOCAL_EXEC`, `local()`)
- Modify: `frontend/src/assistant/prompt.ts` (history line ~16 and drawings line ~19)
- Modify: `frontend/src/components/AssistantPanel.tsx` (`TOOL_WORKING_LABEL`, ~line 92: `candles_find: "Scanning candles"`)
- Modify: `docs/features/ai-assistant.md` (add `candles_find` to the LOCAL_TOOLS list, one short paragraph)
- Test: `frontend/src/assistant/undo.test.ts`, `frontend/src/assistant/tools.test.ts`, `frontend/src/assistant/prompt.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 exports; `agentPeriod` (`agent/actions/agentPeriod.ts`), `tfSecondsOf` (`lib/timeframe.ts`), `loadSettings().priceSide` (`theme.ts`), `focusedChart()`, `focusedDrawings()`.
- Produces:
  - `placeDrawings(specs: Parameters<OverlayManager["placeDrawing"]>[0][]): string[]` on the overlay manager: creates each like `placeDrawing` (same `canPlaceDrawing` guard, trade-box seeding), then ONE `persist()` and ONE `notifyDrawing()`, no selection change. Returns created ids (fewer than specs when a create fails).
  - `removeDrawings(ids: string[]): number` on the overlay manager: removes each id that still exists (skips missing ones), then ONE `persist()` and ONE `notifyDrawing()`. Returns the count removed.
  - Tool `candles_find`, input schema: `from` (number, ms, required), `to` (number, ms, required), `resolution` (string, optional), `where` (array of `{field: enum SCAN_FIELDS, op: enum SCAN_OPS, value: number | boolean}`, `additionalProperties: false`, all three required), `fields` (array, items enum SCAN_FIELDS), `mark` (`{ tool: enum ["verticalStraightLine","rect"], color?: string, text?: string }`, `additionalProperties: false`, `tool` required).
  - Description (exact): "Read-only scan of the focused chart's market over any date range, without moving the chart. Each bar has time, weekday (0=Sun, of the trading session), open, high, low, close, change% (vs previous close), gap% (open vs previous close) and afterWeekend (true when a weekend lies between this bar and the previous one). where: conditions joined by AND. Returns matching rows as tuples in `cols` order. With mark, it also draws each match (verticalStraightLine at the bar, or rect over the gap from previous close to open) as one undoable change. Use this for any question about past bars."

Execution in `local()` for `candles_find`:
1. Validate everything before fetching: `checkWhere(input.where ?? [])`; `fields` names in SCAN_FIELDS; `mark.tool` in the two tools and `mark.color` matching `/^#[0-9a-fA-F]{6}$/` when given; `from < to`. Resolve resolution: `input.resolution ? agentPeriod(input.resolution)?.resolution : focusedChart().resolution`; unknown → error `INVALID_ARGS: unknown resolution`.
2. `barSec = tfSecondsOf(res)`; null or `< 60` (seconds resolutions have no window history) → error asking for 1m or higher. Bars estimate `(to - from) / 1000 / barSec` > 20000 → error naming a higher timeframe or a shorter range.
3. `fetchFilled` from `from - max(4 days, 3 * barSec * 1000)` (a calendar margin, so the first in-window bar has a previous bar across weekends and holidays) to `to`, with the focused chart's epic/broker (`at.epic`, `brokerNow()`), `loadSettings().priceSide`, `ctx.signal`.
4. `deriveRows(allBars, barSec * 1000)` over ALL fetched bars; `windowRows` = rows with `time` in `[from, to]`; `scanned = windowRows.length`; matches = `windowRows.filter(matches)`. For a rect, the previous row comes from the full derived list.
5. `fields` default: `["time", ...where fields]` deduped.
6. No `mark`: return `{ content: formatResult(...), isError: false }`.
7. With `mark`: matched > 500 → error. Matched 0 → result without a change. If `cellNow() !== at.cellId || epicNow() !== at.epic` → `FOCUS_CHANGED` error. Build specs: vertical line `points: [{timestamp: row.time, value: row.close}]`; rect `points: [{timestamp: prevRow.time, value: prevRow.close}, {timestamp: row.time, value: row.open}]`; styles/extendData built the same way `drawing.add` does (`{line:{color}}`, rect polygon fill via `hexToRgba`, extendData `{text, priceLabels: true}`). Call `focusedDrawings().overlays.placeDrawings(specs)`. 0 ids → error `DRAW_FAILED: could not create the drawings`. Change: `{ label: "Marked N bars" (N = ids placed; "1 bar" singular), ...at, undo: () => focusedDrawings().overlays.removeDrawings(ids) }`. No `createdId`. Content: formatResult plus `"marked": N` (and `"notPlaced": k` when fewer than matched).

- [ ] **Step 1: Write failing tests** in `undo.test.ts` (mock `./candleScan`'s `fetchFilled` via `vi.mock` partial, keep the real pure functions; add `placeDrawings: vi.fn(() => ids)` to the `drawings` double):
  - `candles_find` with `where: [{field:"gap%",op:">",value:0},{field:"afterWeekend",op:"==",value:true}]` over the Task 1 Thu/Fri/Mon bars returns `matched: 1`, `cols: ["time","gap%","afterWeekend"]`, no change.
  - with `mark: {tool:"verticalStraightLine"}`: `placeDrawings` called once with 1 spec; change label `"Marked 1 bar"` (singular for 1, "bars" otherwise); `undoTurn` calls `removeDrawings` once with the ids.
  - `mark: {tool: "circle"}` or `color: "red"`: isError, `fetchFilled` not called.
  - `placeDrawings` returns `[]`: isError `DRAW_FAILED`, no change.
  - a Monday 00:00Z `from` with 4H bars: `fetchFilled` is called with `fromMs <= from - 4 days`.
  - `tools.test.ts:51`: update `LOCAL_TOOLS` length from 8 to 9.
  - zero matches with `mark`: no change, `placeDrawings` not called.
  - 501 matches with `mark`: isError, `placeDrawings` not called.
  - window of 2 years at `MINUTE` resolution: isError mentioning `20000`/higher timeframe, `fetchFilled` not called.
  - focus changed between fetch and mark (change `focus.cellId` inside the `fetchFilled` mock): isError `FOCUS_CHANGED`, nothing placed.
  - `tools.test.ts`: `buildTools()` includes `candles_find` with `required: ["from","to"]`.
  - `prompt.test.ts`: system prompt mentions `candles_find`.
- [ ] **Step 2: Run** `npx vitest run src/assistant/undo.test.ts src/assistant/tools.test.ts src/assistant/prompt.test.ts`; expect the new tests to FAIL.
- [ ] **Step 3: Implement** `placeDrawings`, `removeDrawings`, the panel label, the tool def, `local()` branch, `LOCAL_TOOLS`/`LOCAL_EXEC` entries, and prompt lines: history line becomes "Questions about the chart's history: answer from candles_find (any date range, no scrolling), indicator_values and chart_state. Never move the visible range to read history, and never use a backtest to answer a question."; drawings line adds "To mark many bars, use candles_find with mark."
- [ ] **Step 4: Run** the same tests, then `cd frontend && npx tsc -b && npx eslint src/assistant src/lib/overlays/drawings.ts`; expect PASS and zero errors.
- [ ] **Step 5: Commit** `git add frontend/src/lib/overlays/drawings.ts frontend/src/components/AssistantPanel.tsx frontend/src/assistant/tools.ts frontend/src/assistant/undo.ts frontend/src/assistant/prompt.ts frontend/src/assistant/undo.test.ts frontend/src/assistant/tools.test.ts frontend/src/assistant/prompt.test.ts docs/features/ai-assistant.md docs/superpowers/specs/2026-11-23-assistant-candles-find-design.md docs/superpowers/plans/2026-11-23-assistant-candles-find.md && git commit -m "feat(assistant): candles_find scans any range and marks matches"`
