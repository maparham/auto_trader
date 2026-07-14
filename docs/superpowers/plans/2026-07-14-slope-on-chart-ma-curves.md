# Slope on-chart MA curves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Show MAs on chart" toggle to the Slope indicator that draws each configured length's underlying moving average on the candle pane, color-matched to its slope line.

**Architecture:** Self-draw the MA curves on a dedicated candle-pane overlay canvas inside ChartCore's existing `redraw` loop (the same pattern as `paintBracket` / `paintSelectionDots`). No companion indicator instance. The only new persisted state is a `showMa` flag on the Slope's `extendData`, so persistence / snapshots / named layouts / symbol templates work for free. A shared pure helper (`slopeMaLines`) computes the per-line MA values + colors from the live Slope indicator using the SAME `slopeLengths` + `maSeries` the Slope uses, so the on-chart MA equals the MA the Slope differentiates by construction.

**Tech Stack:** TypeScript, React, klinecharts (custom shell), vitest.

## Global Constraints

- No em dashes or `--` as punctuation in any UI copy, comment, or reply: use a colon, comma, or period.
- UI copy may use standard trading terms (audience is educated traders); concise over dumbed-down.
- Reuse the shared `Tooltip` / `InfoTip` components, never a native `title=` or a hand-rolled tooltip, for any new tooltip.
- Commit directly to `main` (single-person repo); do not branch.
- The on-chart MA is the raw MA base (unsmoothed): smoothing applies to the slope, not the price MA.
- Curves are solid, one per length, each in its slope line's resolved color (override -> template default -> `SLOPE_PALETTE[li % len]`).
- vitest node env exports klinecharts `IndicatorSeries` / `LineType` as `undefined`; any test importing a module that evaluates an indicator template at load must use the `vi.mock("klinecharts", ...)` + top-level `await import` pattern (see `lib/indicators/slope.test.ts`).

---

### Task 1: `showMa` flag + `slopeMaLines` helper (chart-timeframe)

The shared parity surface. `slopeMaLines` takes a live Slope indicator's fields + the chart candles and returns one `{ color, values }` per length using the same `slopeLengths` + `maSeries` the Slope uses. This task covers the chart-timeframe (non-MTF) branch; Task 2 adds the MTF branch.

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts`
- Test: `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Consumes: `slopeLengths(calcParams)`, `maSeries(candles, maType, length, { source })`, `slopeShared(ext)`, module-local `SLOPE_PALETTE` (all already in `slope.ts`).
- Produces:
  - `SlopeExtend.showMa?: boolean`
  - `SlopeMaLine = { color: string; values: Array<number | undefined> }`
  - `slopeMaLines(ind: SlopeMaSource, candles: KLineData[]): SlopeMaLine[]` where
    `SlopeMaSource = { calcParams?: unknown[]; extendData?: unknown; visible?: boolean; styles?: { lines?: Array<{ color?: string }> } }`.
    Returns `[]` when `showMa` is falsy or `visible === false`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/lib/indicators/slope.test.ts` (the `slopeMaLines` import goes in the existing top-level `await import("./slope")` destructure):

```ts
// add slopeMaLines to the existing import line:
// const { inferBarHours, slopeWithUnits, computeSlope, SLOPE_TEMPLATE, smoothSeries, slopeLineSeries, slopeMaLines } =
//   await import("./slope");

describe("slopeMaLines", () => {
  const candles = [bar(0, 100), bar(60_000, 101), bar(120_000, 102), bar(180_000, 103), bar(240_000, 104)];

  it("returns [] when showMa is off", () => {
    expect(slopeMaLines({ calcParams: [2], extendData: {} }, candles)).toEqual([]);
    expect(slopeMaLines({ calcParams: [2], extendData: { showMa: false } }, candles)).toEqual([]);
  });

  it("returns [] when the indicator is hidden", () => {
    expect(
      slopeMaLines({ calcParams: [2], extendData: { showMa: true }, visible: false }, candles),
    ).toEqual([]);
  });

  it("returns one line per length equal to maSeries base (SMA parity)", () => {
    const lines = slopeMaLines(
      { calcParams: [2, 3], extendData: { showMa: true, maType: "sma" } },
      candles,
    );
    expect(lines.length).toBe(2);
    // SMA(2) of closes 100,101,102,103,104 -> undefined,100.5,101.5,102.5,103.5
    expect(lines[0].values[0]).toBeUndefined();
    expect(lines[0].values[1]).toBeCloseTo(100.5, 10);
    expect(lines[0].values[4]).toBeCloseTo(103.5, 10);
    // SMA(3) -> undefined,undefined,101,102,103
    expect(lines[1].values[2]).toBeCloseTo(101, 10);
  });

  it("resolves color from styles override then palette fallback", () => {
    const lines = slopeMaLines(
      { calcParams: [2, 3], extendData: { showMa: true }, styles: { lines: [{ color: "#123456" }] } },
      candles,
    );
    expect(lines[0].color).toBe("#123456"); // override
    expect(lines[1].color).toBe("#42A5F5"); // SLOPE_PALETTE[1] fallback
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts -t slopeMaLines`
Expected: FAIL with "slopeMaLines is not a function" (import is undefined).

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/lib/indicators/slope.ts`:

Add `showMa?: boolean;` to the `SlopeExtend` interface (next to `colorByDirection`):

```ts
export interface SlopeExtend extends MaExtend {
  maType?: "ema" | "sma";
  units?: SlopeUnit;
  slopePeriod?: number;
  smoothing?: SlopeSmoothing;
  colorByDirection?: boolean;
  showMa?: boolean;
  threshold?: SlopeThreshold;
  mtf?: MaExtend["mtf"] & { htfSeriesByLine?: Array<Array<number | undefined>> };
}
```

Add the type + helper near the bottom of the file, above `SLOPE_TEMPLATE`:

```ts
/** One on-chart MA curve derived from a Slope line: its resolved color + per-bar
 * MA base values (undefined during warm-up). */
export interface SlopeMaLine {
  color: string;
  values: Array<number | undefined>;
}

/** The subset of a live SLOPE indicator the on-chart MA painter reads. */
export interface SlopeMaSource {
  calcParams?: unknown[];
  extendData?: unknown;
  visible?: boolean;
  styles?: { lines?: Array<{ color?: string }> };
}

/** Per-line MA curves to draw on the candle pane for a Slope with "Show MAs on
 * chart" enabled. Empty when showMa is off or the Slope is hidden. Each line is
 * the RAW MA base (maSeries) of that length (smoothing is a slope-only concern),
 * colored to match the slope line (override -> SLOPE_PALETTE). Uses the SAME
 * slopeLengths + maSeries the Slope uses, so the curves match by construction.
 * The MTF branch is added in a later task. */
export function slopeMaLines(ind: SlopeMaSource, candles: KLineData[]): SlopeMaLine[] {
  const ext = (ind.extendData ?? {}) as SlopeExtend;
  if (!ext.showMa || ind.visible === false) return [];
  const lengths = slopeLengths(ind.calcParams);
  const { maType, source } = slopeShared(ext);
  const colorAt = (li: number): string =>
    ind.styles?.lines?.[li]?.color ?? SLOPE_PALETTE[li % SLOPE_PALETTE.length];
  return lengths.map((len, li) => ({
    color: colorAt(li),
    values: maSeries(candles, maType, len, { source }).base,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts`
Expected: PASS (all slope tests, including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/slope.ts frontend/src/lib/indicators/slope.test.ts
git commit -m "feat(slope): showMa flag + slopeMaLines helper (chart TF)"
```

---

### Task 2: MTF branch of `slopeMaLines` + stash HTF MA base

When the Slope is on a higher timeframe, the on-chart MA must be the HTF MA base aligned to the chart bars (no lookahead), like the slope values. `applySlopeTimeframe` already fetches the HTF bars and computes `maSeries(...).base` (inside `slopeLineSeries`); piggyback that fetch to also stash the per-line MA base transiently, and align it in `slopeMaLines`.

**Files:**
- Modify: `frontend/src/lib/indicators/slope.ts`
- Modify: `frontend/src/lib/mtfCoordinator.ts:442-448` (the `ext.mtf = {...}` block in `applySlopeTimeframe`)
- Test: `frontend/src/lib/indicators/slope.test.ts`

**Interfaces:**
- Consumes: `alignHtfToChart(ts, starts, series, htfMs, true)` (already imported in `slope.ts`), `maSeries` (already imported in `mtfCoordinator.ts`).
- Produces: `SlopeExtend.mtf.htfMaBaseByLine?: Array<Array<number | undefined>>` (transient, never persisted).

- [ ] **Step 1: Write the failing test**

Add to the `slopeMaLines` describe block in `slope.test.ts`:

```ts
it("MTF: aligns the stashed HTF MA base to chart bars (no recompute)", () => {
  // Two HTF bars starting at t=0 and t=120_000, base values 10 and 20.
  const chart = [bar(0, 1), bar(60_000, 1), bar(120_000, 1), bar(180_000, 1)];
  const lines = slopeMaLines(
    {
      calcParams: [2],
      extendData: {
        showMa: true,
        mtf: {
          timeframe: "1h",
          htfStarts: [0, 120_000],
          htfMaBaseByLine: [[10, 20]],
          htfMs: 120_000,
        },
      },
    },
    chart,
  );
  // Each chart bar takes the most recent CLOSED HTF bar's base (no lookahead):
  // bars at 0 and 60_000 -> HTF bar 0 (10); bars at 120_000, 180_000 -> HTF bar 1 (20).
  expect(lines[0].values).toEqual([10, 10, 20, 20]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts -t "MTF: aligns"`
Expected: FAIL (values come back as chart-TF `maSeries` output, not the aligned `[10,10,20,20]`).

- [ ] **Step 3: Write minimal implementation**

In `slope.ts`, extend the `mtf` type on `SlopeExtend`:

```ts
  mtf?: MaExtend["mtf"] & {
    htfSeriesByLine?: Array<Array<number | undefined>>;
    htfMaBaseByLine?: Array<Array<number | undefined>>;
  };
```

In `slopeMaLines`, add the MTF branch before the chart-TF `return`:

```ts
  const mtf = ext.mtf;
  if (mtf?.timeframe && mtf.htfMaBaseByLine && mtf.htfStarts && mtf.htfMs) {
    const ts = candles.map((k) => k.timestamp);
    const starts = mtf.htfStarts.map((t) => ({ timestamp: t }) as KLineData);
    return lengths.map((_len, li) => ({
      color: colorAt(li),
      values: alignHtfToChart(ts, starts, mtf.htfMaBaseByLine![li] ?? [], mtf.htfMs!, true),
    }));
  }
```

In `mtfCoordinator.ts`, in `applySlopeTimeframe`, compute + stash the per-line MA base alongside the slope series (the `ext.mtf = {...}` block near line 442):

```ts
  const barHours = inferBarHours(htf);
  const byLine = config.lengths.map((len) =>
    slopeLineSeries(htf, config.maType, len, config.slopeN, config.units, config.options.source, config.smoothing, barHours),
  );
  const maBaseByLine = config.lengths.map((len) =>
    maSeries(htf, config.maType, len, config.options).base,
  );
  ext.mtf = {
    timeframe,
    htfStarts: htf.map((b) => b.timestamp),
    htfSeriesByLine: byLine,
    htfMaBaseByLine: maBaseByLine,
    htfMs,
  };
  chart.overrideIndicator({ name, calcParams, extendData: ext }, paneId);
```

(`maSeries` is already imported at `mtfCoordinator.ts:12`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/indicators/slope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/slope.ts frontend/src/lib/indicators/slope.test.ts frontend/src/lib/mtfCoordinator.ts
git commit -m "feat(slope): MTF-aligned on-chart MA base"
```

---

### Task 3: Settings toggle + persistence + repaint signal

Add the "Show MAs on chart" toggle to the Slope settings panel, persist `showMa`, write it onto the live indicator via `applySlope`, and bump a new signal so ChartCore repaints its overlays immediately (a 1s tick would otherwise be the only refresh).

**Files:**
- Modify: `frontend/src/lib/signals.ts`
- Modify: `frontend/src/IndicatorSettings.tsx` (state ~L297-307; `currentConfig` slope block L611-618; `applySlope` L746-794; the Slope JSX panel near the `slope-lengths` block ~L1195)

**Interfaces:**
- Produces: `indicatorOverlayRepaint: Signal<number>` + `requestIndicatorOverlayRepaint(): void` in `signals.ts` (consumed by ChartCore in Task 4).

- [ ] **Step 1: Add the repaint signal**

In `frontend/src/lib/signals.ts` (near the other request signals):

```ts
// Bumped when an indicator's own-canvas overlay (e.g. the Slope's on-chart MA
// curves, drawn outside klinecharts) needs an immediate repaint after a settings
// change. ChartCore subscribes and re-runs its redraw loop. Without this the
// overlay only refreshes on the 1s tick / next scroll.
export const indicatorOverlayRepaint = new Signal<number>(0);
export function requestIndicatorOverlayRepaint(): void {
  indicatorOverlayRepaint.set(indicatorOverlayRepaint.value + 1);
}
```

- [ ] **Step 2: Add `showMa` state + persistence + applySlope write**

In `IndicatorSettings.tsx`:

Add state after the `colorByDirection` state (~L304):

```ts
  const [showMa, setShowMa] = useState<boolean>(slopeExt0.showMa ?? false);
```

Import the signal helper at the top with the other `./lib/signals` imports:

```ts
import { requestIndicatorOverlayRepaint } from "./lib/signals";
```

In `currentConfig`, inside the `if (isSlope) {` block (after `extendData.threshold = threshold;`):

```ts
      extendData.showMa = showMa;
```

Add `showMa` to `applySlope`'s `next` param type and write it onto the live indicator. Update the `next` type:

```ts
      colorByDirection: boolean;
      threshold: SlopeThreshold;
      showMa: boolean;
      timeframe: string;
```

Add the local + write inside `applySlope` (after `const nextThreshold = ...`):

```ts
    const nextShowMa = next.showMa ?? showMa;
```

and add `showMa: nextShowMa,` to the `overrideIndicator` `extendData` object (next to `threshold: nextThreshold,`). Then, at the END of `applySlope` (after the `void applySlopeTimeframe(...)` call), add:

```ts
    requestIndicatorOverlayRepaint();
```

Also add `showMa` to the `currentConfig` dependency array of the persist effect (the `useEffect` deps list at ~L695 that already lists `threshold`): add `showMa` to that array.

- [ ] **Step 3: Add the toggle to the Slope panel**

Find the Slope-specific JSX (the `{isSlope && (` block around L1195 with `className="slope-lengths"`). Add a labeled checkbox row inside the Slope section (mirroring how `colorByDirection` / `threshold.on` toggles are rendered in that panel; match the existing markup for a boolean row there). Use an `InfoTip` for the help text, not a native `title`:

```tsx
<label className="ind-row">
  <input
    type="checkbox"
    checked={showMa}
    onChange={(e) => {
      const v = e.target.checked;
      setShowMa(v);
      applySlope({ showMa: v });
    }}
  />
  <span>Show MAs on chart</span>
  <InfoTip
    title="Show MAs on chart"
    text="Plot each length's moving average on the price chart, colored to match its slope line."
  />
</label>
```

(Match the exact class names / row wrapper the sibling slope toggles use in that file; `InfoTip` is already imported there per the file's other InfoTips. Keep it inside the existing `.ind-info`-styled container so it does not render as a black box.)

- [ ] **Step 4: Typecheck + build the frontend**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/signals.ts frontend/src/IndicatorSettings.tsx
git commit -m "feat(slope): Show MAs on chart toggle + persistence"
```

---

### Task 4: The `paintSlopeMa` painter + canvas wiring

Draw the MA curves on a dedicated candle-pane overlay canvas inside the redraw loop, and subscribe the repaint signal.

**Files:**
- Modify: `frontend/src/chart/useChartPaint.ts` (deps interface L119-121; painter after `paintBracket` ~L380; call in `redraw` ~L1001)
- Modify: `frontend/src/ChartCore.tsx` (canvas ref ~L555; deps object ~L2765; JSX canvas ~L3238; subscribe the signal near the other `.subscribe(... redrawRef.current())` effects ~L727)

**Interfaces:**
- Consumes: `slopeMaLines` (Task 1/2), `indTypeOf` (`lib/customIndicators`), `indicatorOverlayRepaint` (Task 3), `chart.convertToPixel(pts, { paneId: "candle_pane", absolute: true })`, `chart.getVisibleRange()`, `chart.getDataList()`, `chart.getIndicatorByPaneId()`.
- Produces: `maCanvasRef` on the paint deps + a `paintSlopeMa` painter run in `redraw`.

- [ ] **Step 1: Add the canvas ref to the paint deps + destructure**

In `useChartPaint.ts`, add to the deps interface (next to `selCanvasRef`):

```ts
  maCanvasRef: React.RefObject<HTMLCanvasElement | null>;
```

Add `maCanvasRef,` to the destructure block (next to `selCanvasRef,` ~L172).

Add imports at the top of `useChartPaint.ts`:

```ts
import { slopeMaLines } from "../lib/indicators/slope";
import { indTypeOf } from "../lib/customIndicators";
```

- [ ] **Step 2: Write the painter**

In `useChartPaint.ts`, after `handle.paintBracketRef.current = paintBracket;` (~L380), add:

```ts
  // Slope "Show MAs on chart": draw each SLOPE indicator's underlying MA lines on
  // the candle pane (our own canvas, above klinecharts' candles). Reads the live
  // Slope config every frame via slopeMaLines, so the curves match the slope lines
  // (same lengths / maSeries / colors) and update on any slope edit. Not participating
  // in the candle pane's y-scale is accepted: a far MA can clip on tight zoom.
  const paintSlopeMa = useCallback(() => {
    const chart = chartRef.current;
    const canvas = maCanvasRef.current;
    const wrap = wrapRef.current;
    if (!chart || !canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Collect every SLOPE indicator across all panes (SLOPE lives in a sub-pane;
    // its MAs draw on the candle pane).
    const panes = chart.getIndicatorByPaneId() as
      | Map<string, Map<string, { calcParams?: unknown[]; extendData?: unknown; visible?: boolean; styles?: { lines?: Array<{ color?: string }> } }>>
      | null
      | undefined;
    if (!panes) return;
    const dl = chart.getDataList();
    const vr = chart.getVisibleRange();
    if (!dl.length) return;

    // Clip to the candle pane so curves priced off-screen don't paint over sub-panes.
    const measuredPaneH = chart.getSize("candle_pane", DomPosition.Main)?.height;
    const paneH = measuredPaneH && measuredPaneH > 0 ? measuredPaneH : h;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, paneH);
    ctx.clip();

    for (const inds of panes.values()) {
      for (const ind of inds.values()) {
        if (indTypeOf(ind as never) !== "SLOPE") continue;
        const lines = slopeMaLines(ind, dl);
        for (const line of lines) {
          // Pixel-resolve the visible run of defined points, then stroke a polyline.
          const pts: Array<{ timestamp: number; value: number }> = [];
          for (let i = vr.from; i < vr.to; i++) {
            const v = line.values[i];
            const k = dl[i];
            if (k && typeof v === "number" && Number.isFinite(v)) {
              pts.push({ timestamp: k.timestamp, value: v });
            }
          }
          if (pts.length < 2) continue;
          const px = chart.convertToPixel(pts, { paneId: "candle_pane", absolute: true }) as Array<{
            x: number;
            y: number;
          }>;
          ctx.strokeStyle = line.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          px.forEach((c, k) => (k === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }, []);
```

`paintSlopeMa` is defined in the same hook as `redraw`, so it is called directly there (next step): no handle ref is needed (unlike `paintBracket`, which is exposed on the handle for callers outside the hook). `DomPosition` is already imported in this file (used by `paintBracket` via `chart.getSize("candle_pane", DomPosition.Main)`); if not, add it to the `klinecharts` import.

- [ ] **Step 3: Call the painter in `redraw`**

In `redraw`, next to `paintBracket();` (~L1001):

```ts
    paintBracket();
    paintSlopeMa();
```

Add `paintSlopeMa` to the `redraw` `useCallback` dependency array (which currently is `[paintBracket]`): `[paintBracket, paintSlopeMa]`.

- [ ] **Step 4: Wire the canvas in ChartCore**

In `ChartCore.tsx`:

Add the ref near `bracketCanvasRef` (~L555):

```ts
  const maCanvasRef = useRef<HTMLCanvasElement>(null);
```

Add `maCanvasRef,` to the `useChartPaint({...})` deps object (next to `bracketCanvasRef,` ~L2765).

Add the canvas element BEFORE the separator canvas (so MAs sit under the separator/bracket/selection overlays but over the candles). Insert next to the other overlay canvases (~L3226), with z-index 7:

```tsx
      <canvas
        ref={maCanvasRef}
        data-testid="slope-ma-overlay"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 7,
          pointerEvents: "none",
        }}
      />
```

Subscribe the repaint signal near the other redraw subscriptions (~L727, next to `legendHoverName.subscribe`):

```ts
  useEffect(
    () => indicatorOverlayRepaint.subscribe(() => redrawRef.current()),
    [],
  );
```

Add `indicatorOverlayRepaint` to the `./lib/signals` import in `ChartCore.tsx`.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/chart/useChartPaint.ts frontend/src/ChartCore.tsx
git commit -m "feat(slope): draw on-chart MA curves via candle-pane overlay"
```

---

### Task 5: In-browser verification

Drive the real app and confirm the feature end-to-end. Use the `verify` skill / claude-in-chrome per repo convention; do not kill the user's HMR dev server, and close any tab you opened when done.

**Files:** none (manual/e2e verification).

- [ ] **Step 1: Add a Slope indicator with multiple lengths**

Open the app, add the "MA Slope" (SLOPE) indicator, set MA Lengths to `9, 21, 50`. Confirm three slope lines render in the sub-pane.

- [ ] **Step 2: Toggle "Show MAs on chart" on**

In the Slope settings, enable "Show MAs on chart". Expected: three solid MA curves appear on the candle pane immediately (no need to scroll), each colored to match its slope line.

- [ ] **Step 3: Pan / zoom / scroll-back**

Pan and zoom the chart, and scroll back into older bars. Expected: the curves stay glued to the candles and extend as history loads.

- [ ] **Step 4: Recolor a slope line**

Change one slope line's color in the Style tab. Expected: the matching on-chart MA curve recolors.

- [ ] **Step 5: MTF**

Set the Slope to a higher timeframe (e.g. 1h on a 15m chart). Expected: the curves step like the HTF MA and stay aligned on scroll-back.

- [ ] **Step 6: Off / hide / remove / reload**

Toggle "Show MAs on chart" off: curves disappear. Toggle back on, then hide the Slope via the legend eye: curves disappear. Show it again, then remove the Slope: no orphan curves remain. Reload the page: the curves reappear from the persisted `showMa` flag with no duplicates.

- [ ] **Step 7: Record the result**

Note pass/fail for each check in the final report. If any check fails, use systematic-debugging before editing.
