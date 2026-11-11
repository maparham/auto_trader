# Pinned Trendline Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw a Trendlines line pinned to a COARSER timeframe as one horizontal step per HTF bar on finer charts, so every timeframe shows the same price, replacing the straight anchor-candle stroke.

**Architecture:** A new pure module, `lib/indicators/trendlineSteps.ts`, owns the data-driven candle to HTF bar map and turns (value per HTF bar, range) into pixel step pieces. The Trendlines draw loop, the line hit test, and the line-alert overlay all consume it; the anchor-candle stroke (`pinnedAnchorBars`, `chartLine`, `pinnedAlertStroke`) is removed.

**Tech Stack:** TypeScript, klinecharts v10 (custom indicator draw, custom overlay templates), vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-pinned-trendline-steps-design.md`

## Global Constraints

- Only COARSER pins change (`mtf.htfMs > chartBarMs(dataList)`); same-timeframe pins, finer pins and unpinned Trendlines draw exactly as today.
- No change to detection, selection, emitted values, operands, the backend, or backtest parity.
- Step value of HTF bar `j` is `projectAt(line, j)` (alerts: `pAt + slope * (j - jRef)`).
- The forming HTF bar is `map.forming === mtf.htfStarts.length` (Trendlines never folds a forming bar).
- Run only the affected test files, never the full frontend suite: `cd frontend && npx vitest run <files>`.
- Typecheck with `cd frontend && npx tsc -b` (not `--noEmit`); eslint stays at zero errors. Ask the user once before running tsc + eslint (they share the laptop).
- Commit to the current branch (`main`), staging files by explicit path; never `git add -A`, stash, or clean (other sessions share the worktree). Never push.
- No em dashes in UI text, comments or commit messages.
- Debug layer (`trendlinesDebugDraw.ts`) and picked-line clones (`pickedLineClones.ts`) are OUT of scope (follow-ups); do not touch them.

## Review Focus

1. A Monday on a stock's 1H chart with a 1D pin: the forming step covers Monday's candles only, and the first future step is ~7 candles wide, not ~24 (Task 1 test `forming bar after a weekend`).
2. A broker daily bar missing for a day the chart has candles for (holiday mismatch): those candles join the previous bar's step; no empty step, no throw (Task 1 test `day missing from the pin`).
3. Chart history that starts in the middle of an HTF bar: the partial first bar is drawn but excluded from the `perBar` estimate (Task 1 test `partial first bar`).
4. A stale stash (newest candle two HTF bars past the last start): candles split into two bars, not one (Task 1 test `stale stash`).
5. A line whose first anchor is older than the loaded history: steps start at the first loaded candle, no throw, anchor step value still `p1` when scrolled in (Task 2 test `anchor before loaded history`).

---

### Task 1: The step map and step pieces

**Files:**
- Create: `frontend/src/lib/indicators/trendlineSteps.ts`
- Test: `frontend/src/lib/indicators/trendlineSteps.test.ts`

**Interfaces:**
- Consumes: `htfBarEndMs(openMs, htfMs, timeframe?)` from `lib/mtfForming.ts`.
- Produces:

```ts
export interface HtfStepMap {
  readonly nChart: number;
  /** Index of the forming HTF bar: starts.length. */
  readonly forming: number;
  /** Chart candles per HTF bar (median of up to 5 recent fully loaded bars), >= 1. */
  readonly perBar: number;
  /** HTF bar of chart candle c, 0 <= c < nChart. */
  barOf(c: number): number;
  /** Chart-position span of HTF bar j in candle-edge units (candle c spans
   *  [c - 0.5, c + 0.5]). Projected by perBar off either end of the data.
   *  Null for a bar inside loaded history that holds no candle. */
  span(j: number): { from: number; to: number } | null;
  /** Chart position of fractional HTF index j: span(floor j) interpolated. */
  posOf(j: number): number;
  /** Fractional HTF index at chart position pos (inverse of posOf). */
  jAt(pos: number): number;
}
export function buildHtfStepMap(
  timeAt: (i: number) => number, nChart: number,
  starts: readonly number[], htfMs: number, timeframe?: string,
): HtfStepMap;
/** Memoised per frame: same dataList, length, newest timestamp and starts array. */
export function stepMapFor(dataList: readonly KLineData[], mtf: TrendlinesMtf): HtfStepMap | null;

export interface StepPiece { x0: number; x1: number; y0: number; y1: number }
export function buildSteps(
  map: HtfStepMap, valueAt: (j: number) => number, jFrom: number, jTo: number,
  opts: {
    xOf: (pos: number) => number; yOf: (price: number) => number;
    posMin: number; posMax: number;   // visible chart positions, for culling
    endPos?: number;                  // clamp, e.g. newest + 0.5
  },
): StepPiece[];
/** Where a line's steps end: a line reaching the last closed bar runs through the
 *  forming bar and stops at the newest candle; anything else is unchanged. */
export function stepRange(jRight: number, lastIdx: number, map: HtfStepMap): { jTo: number; endPos?: number };
export function strokeSteps(ctx: CanvasRenderingContext2D, pieces: readonly StepPiece[]): void;
export function distToSteps(px: number, py: number, pieces: readonly StepPiece[]): number;
```

Rules the tests pin (from the spec's "candle to HTF bar map"):
- History: candle `c` is in bar `j` when `starts[j] <= t_c < starts[j+1]`, by its OPEN time.
- Candles with `t >= htfBarEndMs(starts[last])` belong to `forming + floor(k / perBar)` (k counts them from 0); candles before `starts[0]` count back the same way from bar `-1`.
- `buildSteps`: integer `jTo` includes the whole bar `jTo`; fractional `jTo` ends at `posOf(jTo)`; `jFrom` starts at `span(floor(jFrom)).from`. Bars with a null span are skipped. Consecutive pieces narrower than 1px merge into one piece (y0 of the first, y1 of the last). Only bars whose span meets `[posMin, posMax]` are built.
- `stepRange`: `jRight === lastIdx` (integer) gives `{ jTo: map.forming, endPos: map.nChart - 1 + 0.5 }`; otherwise `{ jTo: jRight }`.
- `strokeSteps`: one path; moveTo first `(x0, y0)`, then per piece `lineTo(x0, y0)` (the riser) and `lineTo(x1, y1)`.
- `distToSteps`: binary search the piece under `px`, vertical distance to its y at `px`; within the riser at a boundary, distance to the riser; `Infinity` when `px` is outside every piece.

- [ ] **Step 1: Write the failing tests** in `trendlineSteps.test.ts`, on synthetic hourly candles (stock: 7 one-hour candles per day, 13:30 to 20:30 UTC, Mon to Fri) with daily `starts` at 00:00 UTC:
  - `history containment`: every candle's `barOf` equals the index of its UTC day in `starts`.
  - `forming bar after a weekend`: starts end Friday, candles run into Monday 3 candles; Monday's 3 candles have `barOf === forming`; `span(forming + 1).to - span(forming + 1).from === 7`.
  - `day missing from the pin`: drop Wednesday from `starts`; Wednesday's candles have `barOf` of Tuesday; no `span` in history is null for a remaining day.
  - `partial first bar`: data starts at the 4th candle of a day; `perBar === 7`; `span(0)` covers 4 candles.
  - `stale stash`: starts end Thursday, candles run through Monday; Friday's 7 candles are `forming`, Monday's are `forming + 1`.
  - `DST straddle`: a broker whose daily open shifts one hour in the DST week; every candle belongs to exactly one bar, no bar between first and last start is empty.
  - `buildSteps values`: with `valueAt = (j) => 100 + 2 * j`, every piece's `y0 === y1 === yOf(valueAt(bar))` and piece edges sit on candle edges.
  - `fractional end`: `jTo = 3.5` ends at `posOf(3.5)`.
  - `culling`: a map of 5000 candles with `posMin..posMax` spanning 100 candles builds at most `ceil(100 / perBar) + 2` pieces.
  - `merge`: with `xOf` at 0.1 px per candle, pieces merge and none is narrower than 1px.
  - `stepRange`: `(lastIdx, lastIdx)` returns `jTo === forming` and `endPos === nChart - 0.5`; `(lastIdx + 40, lastIdx)` returns `jTo === lastIdx + 40` and no `endPos`.
  - `distToSteps`: 0 on a step, the vertical gap above it, the horizontal gap at a riser, `Infinity` past the last piece.
- [ ] **Step 2: Run to verify they fail**: `cd frontend && npx vitest run src/lib/indicators/trendlineSteps.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the interfaces above in `trendlineSteps.ts`. `stepMapFor` caches in a `WeakMap` keyed on the dataList with `{ n, newestTs, starts }` as the validity check. Import `TrendlinesMtf` as a type only (no runtime import of `trendlines.ts`, to avoid a cycle).
- [ ] **Step 4: Run to verify they pass** (same command). Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlineSteps.ts frontend/src/lib/indicators/trendlineSteps.test.ts
git commit -m "feat(trendlines): data-driven HTF step map for coarser pins"
```

### Task 2: Draw coarser-pinned lines as steps

**Files:**
- Modify: `frontend/src/lib/indicators/trendlines.ts` (draw loop around the `anchorBars` / `endY` / stroke / extension code, about lines 3440-3830; delete `pinnedAnchorBars` at about 3071-3097 and its doc; reword the coarser-pin note in `trendlineIdxMap` at about 2900-2902)
- Test: `frontend/src/lib/indicators/trendlinesMtf.test.ts`

**Interfaces:**
- Consumes: Task 1's `stepMapFor`, `buildSteps`, `stepRange`, `strokeSteps`.
- Produces: inside the draw loop, `pieces: StepPiece[]` per drawn line (coarser pin only), used by Task 3.

Behaviour (coarser pin only; `map = stepMapFor(dataList, mtf)`):
- `lineExtent(..., lastIdx, runToEdge, forceToLastBar)` is called with `lastIdx` in place of `drawEdge`; the extension's `runToEdge` is `map.jAt(edgeChartIdx)`.
- `{ jTo, endPos } = stepRange(jRight, lastIdx, map)`; `pieces = buildSteps(map, (j) => projectAt(line, j), jLeft, jTo, { xOf: xAxis.convertToPixel, yOf: yPx, posMin, posMax, endPos })` with `posMin/posMax` from the visible range plus one bar of pad.
- Stroke and the selection glow use `strokeSteps`; the double-click extension is `buildSteps` from `jTo` to `jExt`, dashed with `TL_EXTEND_DASH`.
- Touch rings: x from `xAtPivot(idx, kind)` as today, y `yPx(projectAt(line, idx))`.
- Crossing marks: `sideDrawn(c, price)` compares `price` with `projectAt(line, map.barOf(c))`; `crossingChartIdx` gains `opts?: { forward?: boolean }` and is called with `{ forward: false }` (skip the next-HTF-bar search) for coarser pins.
- Tags and notes: when `stepRange` returned an `endPos`, at the newest candle `xAxis.convertToPixel(nChart - 1)` and `yPx(projectAt(line, map.forming))`; otherwise at the last piece's `(x1, y1)`.

- [ ] **Step 1: Write the failing tests** in `trendlinesMtf.test.ts` (reuse the file's fake-canvas draw harness; replace the `pinnedAnchorBars` describe and the "passes through both anchors when an HTF bar holds fewer chart bars" case):
  - `draws a coarser pin as one step per HTF bar`: 1D pin on 4H candles; recorded stroke is horizontal within each day at `projectAt(line, j)` with vertical risers at day boundaries.
  - `same price at the same moment on 4H and 1H`: for each 1H candle, the 1H draw's y equals the 4H draw's y for the 4H candle containing it.
  - `anchor steps equal p1 and p2`.
  - `lastbar mode adds the forming step through the newest candle` with `waitClose` true and false; `segment` mode ending at `lastTouchIdx < lastIdx` adds none.
  - `anchor before loaded history`: `i1` older than the first candle; draw does not throw and the first piece starts at the first loaded candle's left edge.
  - `crossing mark needs a close across its own step`: a riser between two candles whose closes stay above their own steps produces no mark.
  - `same-timeframe and finer pins draw as before`: existing finer-pin tests still pass unchanged.
- [ ] **Step 2: Run to verify they fail**: `cd frontend && npx vitest run src/lib/indicators/trendlinesMtf.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the behaviour above; delete `pinnedAnchorBars` and every use; keep `pinnedEndY` (finer pins still use it).
- [ ] **Step 4: Run** `cd frontend && npx vitest run src/lib/indicators/trendlinesMtf.test.ts src/lib/indicators/trendlines.test.ts src/lib/indicators/trendlines.clip.test.ts src/lib/indicators/trendlinesTsla.test.ts src/lib/indicators/trendlinesEurusd.test.ts src/lib/indicators/trendlinesEurusdDaily.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlinesMtf.test.ts
git commit -m "feat(trendlines): draw coarser-pinned lines as HTF steps"
```

### Task 3: Hit testing, clone, and line alerts on the pin's timeframe

**Files:**
- Modify: `frontend/src/lib/indicators/trendlineMarks.ts` (`TrendlineSegment`, `hitTrendline`)
- Modify: `frontend/src/lib/indicators/trendlines.ts` (segment push: `steps`, `clone`, remove `chartLine`)
- Modify: `frontend/src/lib/pickedLines.ts` (`lineGate`: drop `opts.chartFrame` and `chartFrameOk`)
- Modify: `frontend/src/chart/lineAlertDraft.ts:14-15` (call `lineGate(args.seg, args.ext, args.resolution)`)
- Modify: `frontend/src/lib/indicatorAlertInstance.ts:44-45` (reword the chart-frame comment: the branch stays for alerts made before this change)
- Test: `frontend/src/lib/indicators/trendlineMarks.test.ts`, `frontend/src/chart/lineAlertDraft.test.ts`, `frontend/src/lib/pickedLines.test.ts`

**Interfaces:**
- Consumes: Task 1's `StepPiece`, `distToSteps`; Task 2's `pieces`.
- Produces: `TrendlineSegment.steps?: StepPiece[]` (on-pane pieces, clipped to `[0, tagRight]`); `TrendlineSegment.chartLine` no longer exists; `lineGate(seg, ext, resolution): LineGateResult`.

- [ ] **Step 1: Write the failing tests**
  - `trendlineMarks.test.ts` `hits a stepped segment by x`: a segment with three pieces; a point 2px above the middle piece hits, a point 2px above the extension of the first piece's y over the middle piece's x misses (slop 4, pieces 10px apart in y).
  - `lineAlertDraft.test.ts`: replace "a line drawn through its anchor candles drafts on the chart, even when pinned" with `a coarser pin drafts on its pin` (1D pin on a 4H chart gives `timeframe: "DAY"` and the segment's `alertLine` geometry) and `a 2D pin refuses a line alert` (gives the "Alerts on this timeframe are coming later" reason).
  - `pickedLines.test.ts`: drop the `chartLine` fixture and chart-frame cases; keep the alertLine cases.
  - `trendlinesMtf.test.ts` `clone of a stepped line is straight from its drawn start to its drawn end at the step values`.
- [ ] **Step 2: Run to verify they fail**: `cd frontend && npx vitest run src/lib/indicators/trendlineMarks.test.ts src/chart/lineAlertDraft.test.ts src/lib/pickedLines.test.ts src/lib/indicators/trendlinesMtf.test.ts`. Expected: new cases FAIL.
- [ ] **Step 3: Implement**: `hitTrendline` uses `distToSteps(px, py, seg.steps)` when `seg.steps` is set, else `distToSegment`. The coarser-pin segment sets `steps`, `x0..y1` from the first and last piece, and `clone` returns a straight `[a, b]`: `a` at the first piece's start candle with `projectAt(line, jLeft)`, `b` at the last piece's end candle (the newest candle when `endPos` was set) with that piece's value; segment mode keeps the segment tool.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/trendlineMarks.ts frontend/src/lib/indicators/trendlineMarks.test.ts frontend/src/lib/indicators/trendlines.ts frontend/src/lib/indicators/trendlinesMtf.test.ts frontend/src/lib/pickedLines.ts frontend/src/lib/pickedLines.test.ts frontend/src/chart/lineAlertDraft.ts frontend/src/chart/lineAlertDraft.test.ts frontend/src/lib/indicatorAlertInstance.ts
git commit -m "feat(trendlines): hit-test stepped lines; coarser-pin alerts on the pin's timeframe"
```

### Task 4: Pinned line alerts drawn as steps

**Files:**
- Create: `frontend/src/lib/overlays/alertSteps.ts` (overlay template `alertSteps`, registered like `pickedLineCloneTemplate`)
- Modify: `frontend/src/lib/overlays/indicatorAlerts.ts` (`wantedRays`, `reconcileRays`, `Ray`; extract the reference chain from `loadedLinePoints`)
- Modify: `frontend/src/lib/indicators/trendlines.ts` (delete `pinnedAlertStroke` and its doc)
- Test: `frontend/src/lib/overlays/alertSteps.test.ts`, `frontend/src/lib/overlays/indicatorAlerts.test.ts`

**Interfaces:**
- Consumes: Task 1's `stepMapFor`, `HtfStepMap`.
- Produces:

```ts
// indicatorAlerts.ts
export function alertRef(
  p: Pick<LineAlertParams, "tRef" | "pRef" | "anchors">, times: readonly number[],
): { jRef: number; pAt: number } | null;   // tRef, then t2, then t1 (as loadedLinePoints today)
export function alertStepPoints(
  dataList: readonly KLineData[], mtf: TrendlinesMtf,
  p: Pick<LineAlertParams, "tRef" | "pRef" | "slope" | "anchors">,
): { steps: Array<{ timestamp: number; value: number }>; bell: RayPoints } | null;
// alertSteps.ts
export const alertStepsTemplate: OverlayTemplate; // name "alertSteps"
```

- `alertStepPoints`: one point per HTF bar from the bar of `anchors.t1` (or the first loaded bar) through `map.forming`: `{ timestamp: firstCandleTs(j), value: pAt + slope * (j - jRef) }`, then a final point at the newest candle with the forming value. `bell` is the last two candles at the forming value (horizontal), so `useChartPaint`'s bell extrapolation needs no change. Null when `alertRef` finds no reference.
- `alertStepsTemplate.createPointFigures`: for point i, a horizontal from `x_i - barSpace.halfBar` to `x_{i+1} - halfBar` at `y_i`, then a riser to `y_{i+1}`; the last point runs to `x_last + halfBar`. Styles from `alertLineStyles(false)`.
- `Ray` gains `name: "segment" | "alertSteps"`; under a coarser pin (`mtf.htfMs > chart bar ms`) the ray uses `alertSteps` with `points = steps`; `rayPoints()` returns `bell` for those. A name change removes and recreates the overlay. Alerts on the chart's own timeframe (including old chart-frame alerts) stay `segment`.

- [ ] **Step 1: Write the failing tests**
  - `alertSteps.test.ts` `draws horizontals with risers at candle edges`: call `alertStepsTemplate.createPointFigures` with three coordinates and `barSpace.halfBar = 5`; assert the line figure's points are the staircase.
  - `indicatorAlerts.test.ts` `alertStepPoints gives one point per HTF bar at the alert's own values`: 1D alert (`tRef`, `pRef`, `slope` 2) on 4H candles; values step by 2 per day and the last point is the newest candle at the forming value.
  - `alertStepPoints falls back to t2 then t1 when tRef is not loaded`.
  - `bell pair is horizontal at the forming value`.
- [ ] **Step 2: Run to verify they fail**: `cd frontend && npx vitest run src/lib/overlays/alertSteps.test.ts src/lib/overlays/indicatorAlerts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above; `loadedLinePoints` calls `alertRef`; delete `pinnedAlertStroke`.
- [ ] **Step 4: Run** `cd frontend && npx vitest run src/lib/overlays/alertSteps.test.ts src/lib/overlays/indicatorAlerts.test.ts src/lib/overlays/pickedLineClones.test.ts src/chart/AlertCurveBells.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/overlays/alertSteps.ts frontend/src/lib/overlays/alertSteps.test.ts frontend/src/lib/overlays/indicatorAlerts.ts frontend/src/lib/overlays/indicatorAlerts.test.ts frontend/src/lib/indicators/trendlines.ts
git commit -m "feat(alerts): draw coarser-pinned line alerts as HTF steps"
```

### Task 5: Verify

- [ ] **Step 1: Ask the user once, then run** `cd frontend && npx tsc -b && npx eslint src`. Expected: zero errors.
- [ ] **Step 2: Grep for leftovers**: `grep -rn "pinnedAnchorBars\|pinnedAlertStroke\|chartLine\|chartFrame" frontend/src` returns only the `lineAlertShown` branch's comment in `indicatorAlertInstance.ts`.
- [ ] **Step 3: Live check with the user** (do not add or change indicators through the bridge on their tab): on a chart with a Trendlines pane pinned to 1D, switch the chart between 4H and 1H. Expected: steps per day, the same price at the newest candle on both, both anchors on their wicks, and a line alert made from a stepped line lands on the pin's 1D timeframe with its dashed line on the steps.
