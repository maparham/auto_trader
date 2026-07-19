# Zoom-to-range tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Zoom to range" tool to the left draw sidebar: arm it, drag a full-height band across a time range, and on release the chart drops one timeframe lower centered on the band's midpoint; the band stays visible until the user clicks away.

**Architecture:** The band drag is a clone of the existing backtest "Pick Range" gesture (`rangeBand` transient overlay, driven by `startRangePick`/`updateRangePick` in `overlays.ts` and the `onRangePick*` pointer handlers in `ChartCore.tsx`). The timeframe drop reuses the `onBacktestDrillIn` pattern (park a pending view target, call `onPeriod`, let the data-load effect apply it once the new-TF bars land) — but with a new *pending center* ref (`pendingCenterRef`) consumed by `useLiveMarketData`, which forces the view to center on the midpoint unconditionally (winning over `keepCenter` and the `resetViewOnTimeframeChange` setting). The band is redrawn from stored timestamps after the reload settles.

**Tech Stack:** TypeScript, React, klinecharts v10, Vitest (node env with the existing klinecharts-enum mock), the app's `Signal` primitive.

## Global Constraints

- **No em dashes / "--"** in end-user text or chat prose (code, comments, commits fine).
- **Reuse shared components** — do not hand-roll what already exists (band machinery, arm pattern, drill-in pattern).
- **No backward-compat / migration code** without asking. This is session-only, no persistence, no migration.
- **Backend owns business logic** — N/A here (pure frontend chart interaction).
- **Work on main**, commit directly, no feature branch.
- **Transient, session-only**: the band is NOT persisted, NOT selectable/editable, excluded from persistence exactly like `measure`/`rangeBand`/`slope`.
- Every `feat:`/`test:` commit message ends with the two trailer lines used in this repo:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01M8cGAih8NJKFT2a8jqXRg5
  ```

---

### Task 1: `oneTfLower` timeframe-ladder helper

Pure function: given the current resolution and the user's favorite resolutions, return the enabled quick-bar period immediately *finer* than the current one, or `null` at the floor. Duration-based (not index-based) so it behaves even when the current resolution is not itself on the quick bar.

**Files:**
- Modify: `frontend/src/lib/feed.ts` (add `oneTfLower` next to `quickBarPeriods`, ~line 744)
- Test: `frontend/src/lib/oneTfLower.test.ts` (create)

**Interfaces:**
- Consumes: `quickBarPeriods(favoriteResolutions: string[]): Period[]` and `RESOLUTION_SECONDS` (both already in `feed.ts`), `Period` type.
- Produces: `oneTfLower(currentResolution: string, favoriteResolutions: string[]): Period | null`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/oneTfLower.test.ts
import { describe, it, expect } from "vitest";
import { oneTfLower } from "./feed";

describe("oneTfLower", () => {
  // Defaults span 1m,5m,15m,30m,1H,4H,1D,1W (no favorites needed).
  it("returns the next finer default below the current TF", () => {
    expect(oneTfLower("HOUR_4", [])?.resolution).toBe("HOUR"); // 4H -> 1H
    expect(oneTfLower("HOUR", [])?.resolution).toBe("MINUTE_30"); // 1H -> 30m
    expect(oneTfLower("MINUTE_5", [])?.resolution).toBe("MINUTE"); // 5m -> 1m
  });

  it("returns null at the floor (lowest enabled TF)", () => {
    expect(oneTfLower("MINUTE", [])).toBeNull(); // 1m is the default floor
  });

  it("includes pinned favorites in the ladder", () => {
    // Pin 3m (MINUTE_3): now 5m -> 3m instead of 5m -> 1m.
    expect(oneTfLower("MINUTE_5", ["MINUTE_3"])?.resolution).toBe("MINUTE_3");
    // And 3m -> 1m.
    expect(oneTfLower("MINUTE_3", ["MINUTE_3"])?.resolution).toBe("MINUTE");
  });

  it("finds the largest finer TF even when current is off the quick bar", () => {
    // 2W (WEEK_2) not a default and not pinned: still step down to the largest
    // enabled period shorter than 2W, i.e. 1W.
    expect(oneTfLower("WEEK_2", [])?.resolution).toBe("WEEK");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/oneTfLower.test.ts`
Expected: FAIL — `oneTfLower is not a function` (not exported yet).

- [ ] **Step 3: Write minimal implementation**

Add to `frontend/src/lib/feed.ts` immediately after `quickBarPeriods` (after line 744):

```ts
// The enabled quick-bar period immediately FINER than `currentResolution`
// (largest duration strictly below it), or null when there is none (the user
// is already on their lowest enabled timeframe). Duration-based so it works
// even when `currentResolution` itself is not on the quick bar. Used by the
// zoom-to-range tool to drop one timeframe on release.
export function oneTfLower(
  currentResolution: string,
  favoriteResolutions: string[],
): Period | null {
  const curSecs = RESOLUTION_SECONDS[currentResolution];
  if (curSecs == null) return null;
  const ladder = quickBarPeriods(favoriteResolutions); // ascending by duration
  let best: Period | null = null;
  for (const p of ladder) {
    const secs = RESOLUTION_SECONDS[p.resolution] ?? 0;
    if (secs < curSecs) best = p; // ascending, so the last one below wins
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/oneTfLower.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/feed.ts frontend/src/lib/oneTfLower.test.ts
git commit -m "feat(chart): oneTfLower quick-bar ladder helper for zoom-to-range"
```

---

### Task 2: `zoomRangeArmed` signal on the controller

Add the arming Signal, mirroring `measureArmed`/`slopeArmed`/`rangePickArmed`.

**Files:**
- Modify: `frontend/src/lib/chartController.ts` (near line 58, beside `rangePickArmed`)

**Interfaces:**
- Produces: `controller.zoomRangeArmed: Signal<boolean>` (default `false`).

- [ ] **Step 1: Add the signal**

In `frontend/src/lib/chartController.ts`, immediately after the `rangePickArmed` declaration (line 58) and its comment, add:

```ts
  // True while the Zoom-to-range tool is armed (sidebar button toggled on). The
  // next press-drag on the candle pane marks a time range; on release the chart
  // drops one timeframe lower centered on the range midpoint and the band stays
  // visible until a click-away. One-shot: disarms after a pick. Esc also disarms.
  readonly zoomRangeArmed = new Signal<boolean>(false);
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS (no new errors from this change).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/chartController.ts
git commit -m "feat(chart): zoomRangeArmed signal for the zoom-to-range tool"
```

---

### Task 3: Zoom-band overlay methods in `OverlayManager`

Clone the `rangeBand` transient machinery, but with a `finish` that KEEPS the band (returns the range without removing it) plus a `redraw` that recreates it from stored timestamps after a reload. Reuses the `rangeBand` overlay NAME (same full-height painter) and kind (already in the transient-exclusion lists), tracked via its own id so it never collides with the backtest Pick Range band.

**Files:**
- Modify: `frontend/src/lib/overlays.ts` — add private fields beside `rangeBandId` (line ~208) and methods after `hasRangePick` (line ~1318).

**Interfaces:**
- Consumes: `this.create(kind, name, points, ...)`, `this.chart.overrideOverlay(...)`, `this.chart.removeOverlay(...)` (all used by the existing rangePick methods).
- Produces (public methods on `OverlayManager`):
  - `startZoomBand(startTs: number): string | null`
  - `updateZoomBand(endTs: number): void`
  - `finishZoomBand(): { fromMs: number; toMs: number } | null` — KEEPS the band, stores its final `[start,end]`, returns ordered range (null if zero-width).
  - `redrawZoomBand(startTs: number, endTs: number): void` — recreate from timestamps.
  - `clearZoomBand(): void`
  - `hasZoomBand(): boolean`

- [ ] **Step 1: Add private fields**

In `frontend/src/lib/overlays.ts`, just after `private rangeBandId: string | null = null;` (line 208) and its neighbors `rangeStartTs`/`rangeEndTs`, add:

```ts
  // Zoom-to-range tool's persistent band (survives the TF drop it triggers,
  // redrawn from these timestamps after the reload). Tracked separately from the
  // backtest Pick Range band above so the two never clear each other.
  private zoomBandId: string | null = null;
  private zoomBandStartTs: number | null = null;
  private zoomBandEndTs: number | null = null;
```

- [ ] **Step 2: Add the methods**

In `frontend/src/lib/overlays.ts`, immediately after `hasRangePick()` (ends line 1318), add:

```ts
  // --- Zoom-to-range tool band -----------------------------------------------
  // Like the Pick Range band, but finishZoomBand KEEPS the band on release (the
  // whole point of the tool is that the range stays marked after the zoom), and
  // redrawZoomBand recreates it from timestamps once the lower-TF bars land.
  startZoomBand(startTs: number): string | null {
    if (!this.chart) return null;
    this.clearZoomBand();
    this.zoomBandStartTs = startTs;
    this.zoomBandEndTs = startTs;
    const id = this.create("rangeBand", "rangeBand", [
      { timestamp: startTs, value: 0 },
      { timestamp: startTs, value: 0 },
    ], null, true);
    this.zoomBandId = id;
    return id;
  }

  updateZoomBand(endTs: number): void {
    if (!this.zoomBandId || this.zoomBandStartTs == null || !this.chart) return;
    this.zoomBandEndTs = endTs;
    this.chart.overrideOverlay({
      id: this.zoomBandId,
      points: [
        { timestamp: this.zoomBandStartTs, value: 0 },
        { timestamp: endTs, value: 0 },
      ],
    });
  }

  // Freeze the selection but KEEP the band visible. Returns the ordered range,
  // or null if no real width was drawn (a plain click).
  finishZoomBand(): { fromMs: number; toMs: number } | null {
    const start = this.zoomBandStartTs;
    const end = this.zoomBandEndTs;
    if (start == null || end == null || start === end) {
      this.clearZoomBand();
      return null;
    }
    return { fromMs: Math.min(start, end), toMs: Math.max(start, end) };
  }

  // Recreate the band from timestamps after a timeframe change reload. Because
  // the tool only ever moves to a FINER timeframe, both edges land on bar
  // boundaries at the new TF, so no off-grid interpolation is needed.
  redrawZoomBand(startTs: number, endTs: number): void {
    if (!this.chart) return;
    this.clearZoomBand();
    this.zoomBandStartTs = startTs;
    this.zoomBandEndTs = endTs;
    this.zoomBandId = this.create("rangeBand", "rangeBand", [
      { timestamp: startTs, value: 0 },
      { timestamp: endTs, value: 0 },
    ], null, true);
  }

  clearZoomBand(): void {
    if (this.zoomBandId) this.chart?.removeOverlay({ id: this.zoomBandId });
    this.zoomBandId = null;
    this.zoomBandStartTs = null;
    this.zoomBandEndTs = null;
  }

  hasZoomBand(): boolean {
    return this.zoomBandId != null;
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the overlays unit tests (guard against regressions)**

Run: `cd frontend && npx vitest run src/lib/overlays.test.ts`
Expected: PASS (existing tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/overlays.ts
git commit -m "feat(chart): persistent zoom-band overlay methods (start/update/finish/redraw/clear)"
```

---

### Task 4: `pendingCenterRef` on the chart handle

Add the pending-center type and ref so `onZoomToRange` (Task 6) can park a center target that `useLiveMarketData` (Task 5) consumes after the TF drop.

**Files:**
- Modify: `frontend/src/chart/chartHandle.ts` (add `CenterReq` type near `RangeReq` line 24; add field near line 62).
- Modify: `frontend/src/ChartCore.tsx` (create the ref near line 299; pass it into the handle near line 1274).

**Interfaces:**
- Produces:
  ```ts
  export type CenterReq = {
    resolution: string;
    centerTs: number;
    epic: string;
    broker: string;
    side: PriceSide;
    bandStartTs: number;
    bandEndTs: number;
  };
  ```
  and `handle.pendingCenterRef: React.MutableRefObject<CenterReq | null>`.

- [ ] **Step 1: Add the `CenterReq` type**

In `frontend/src/chart/chartHandle.ts`, immediately after the `RangeReq` type block (ends ~line 30), add:

```ts
// A parked "drop one timeframe and center here" request from the zoom-to-range
// tool. Consumed by useLiveMarketData after the lower-TF bars load: it forces
// the view to center on centerTs (winning over keepCenter and the
// reset-on-TF-change setting), then redraws the band from bandStart/EndTs.
export type CenterReq = {
  resolution: string;
  centerTs: number;
  epic: string;
  broker: string;
  side: PriceSide;
  bandStartTs: number;
  bandEndTs: number;
};
```

(`PriceSide` is already imported in this file — it is used by other refs. If not, add it to the existing type import from the same module `RangeReq`'s `side` uses.)

- [ ] **Step 2: Add the handle field**

In `frontend/src/chart/chartHandle.ts`, immediately after `pendingRangeRef` (line 62), add:

```ts
  pendingCenterRef: React.MutableRefObject<CenterReq | null>;
```

- [ ] **Step 3: Create the ref and thread it into the handle**

In `frontend/src/ChartCore.tsx`, immediately after `const pendingRangeRef = useRef<RangeReq | null>(null);` (line 299) add:

```ts
  const pendingCenterRef = useRef<CenterReq | null>(null);
```

Update the `RangeReq` type import in `ChartCore.tsx` to also import `CenterReq` from `./chart/chartHandle`.

Then in the handle object literal where `pendingRangeRef,` is listed (line 1274), add on the next line:

```ts
      pendingCenterRef,
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/chartHandle.ts frontend/src/ChartCore.tsx
git commit -m "feat(chart): pendingCenterRef on chart handle for zoom-to-range"
```

---

### Task 5: Consume `pendingCenterRef` in `useLiveMarketData`

Force the center target to the parked midpoint on the matching-resolution load (unconditionally), redraw the band after the view settles, and clear the ref. Also clear a stale/manual-change band.

**Files:**
- Modify: `frontend/src/chart/useLiveMarketData.ts` — center-target computation (~line 206), teardown block (~line 285-294), post-load re-center (~line 399 and/or ~610).

**Interfaces:**
- Consumes: `handle.pendingCenterRef` (Task 4), `overlays.redrawZoomBand` / `overlays.clearZoomBand` (Task 3), existing `scrollTsToCenter`, `centerTargetTs`.

- [ ] **Step 1: Force the center target from `pendingCenterRef`**

In `frontend/src/chart/useLiveMarketData.ts`, replace the `centerTargetTs` definition (line 206):

```ts
    const centerTargetTs = keepCenter && priorCenterTs != null ? priorCenterTs : (restoreView?.centerTs ?? null);
```

with:

```ts
    // A parked zoom-to-range center wins unconditionally: it is an explicit user
    // intent that must override both keepCenter and resetViewOnTimeframeChange.
    // Only when THIS load is its target resolution (else it stays parked for the
    // load it was queued for).
    const pendingCenter = handle.pendingCenterRef.current;
    const zoomCenterTs =
      pendingCenter && pendingCenter.resolution === period.resolution
        ? pendingCenter.centerTs
        : null;
    const centerTargetTs =
      zoomCenterTs ?? (keepCenter && priorCenterTs != null ? priorCenterTs : (restoreView?.centerTs ?? null));
```

- [ ] **Step 2: Clear the band on a manual/stale change; keep it for the tool's own change**

In the `if (epicChanged || resChanged)` teardown block (lines 285-294), after `overlays.clearRangePick();` add:

```ts
      // The zoom-to-range band: on an epic change or a MANUAL interval change
      // (no matching parked center) it is stale — drop it. On the tool's OWN
      // interval change (pendingCenterRef matches the incoming resolution) leave
      // it to be redrawn after the load settles (Step 3).
      const zoomOwnChange =
        handle.pendingCenterRef.current != null &&
        handle.pendingCenterRef.current.resolution === period.resolution &&
        !epicChanged;
      if (!zoomOwnChange) {
        overlays.clearZoomBand();
        if (epicChanged) handle.pendingCenterRef.current = null; // stale target
      } else {
        overlays.clearZoomBand(); // remove the old-timescale overlay; redraw after load
      }
```

- [ ] **Step 3: Redraw the band and clear the ref after the view settles**

Find the post-load re-center calls that run `scrollTsToCenter(handle.chartRef.current, centerTargetTs)` after the bars land (line ~399 and the trade-restore branch ~610). Immediately AFTER the primary post-load `scrollTsToCenter(..., centerTargetTs)` at line ~399, add:

```ts
        // Redraw the zoom-to-range band from its stored timestamps now that the
        // lower-TF bars are loaded and the view is centered, then consume the ref.
        const pc = handle.pendingCenterRef.current;
        if (pc && pc.resolution === period.resolution) {
          overlays.redrawZoomBand(pc.bandStartTs, pc.bandEndTs);
          handle.pendingCenterRef.current = null;
        }
```

Note for the implementer: read lines 380-410 and 595-620 first to place this AFTER the existing center is applied and inside the same guard that confirms the load completed (mirroring how `centerTargetTs` is re-applied there). If both branches can run, guard with the `pc.resolution === period.resolution` check shown so it only fires once (the ref is nulled on first use).

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/useLiveMarketData.ts
git commit -m "feat(chart): consume pendingCenterRef (force center + redraw zoom band after TF drop)"
```

---

### Task 6: Wire the gesture in `ChartCore` — `onZoomToRange`, drag handlers, arm, dismiss

Clone the Pick Range pointer gesture for the zoom band, arm/disarm off `zoomRangeArmed`, disable scroll/zoom while armed, run `onZoomToRange` on release, clear the band on click-away and Esc.

**Files:**
- Modify: `frontend/src/ChartCore.tsx` — destructure the signal (~line 274 area), `onZoomToRange` handler (near `onBacktestDrillIn` line 498), drag handlers + finalize (clone of `onRangePick*` lines 1908-1958), arm subscription (near line 2069), listener registration (near line 2097), click-away clear (near `onMeasureClear` line 1733), Esc (near line 3306), cursor class (line 3367), and cleanup removeEventListener (near line 2459).

**Interfaces:**
- Consumes: `oneTfLower` (Task 1), `controller.zoomRangeArmed` (Task 2), `overlays.startZoomBand/updateZoomBand/finishZoomBand/hasZoomBand/clearZoomBand` (Task 3), `pendingCenterRef` (Task 4), existing `rangePickTsAtX`, `periodByResolution`, `onPeriod`, `scrollTsToCenter`, `loadFavoriteResolutions`.

- [ ] **Step 1: Import helpers and destructure the signal**

In `frontend/src/ChartCore.tsx`:
- Add `oneTfLower` to the existing import from `./lib/feed` (which already imports `periodByResolution`).
- Add `loadFavoriteResolutions` to the import from `./lib/persist` (create the import if absent — it lives in `./lib/persist`).
- Add `scrollTsToCenter` to the import from `./lib/chartSync` if not already imported in this file.
- Where `rangePickArmed`/`rangePickResult` are destructured from the controller (lines 274-275), add `zoomRangeArmed,` on the next line.

- [ ] **Step 2: Add `onZoomToRange` handler**

In `frontend/src/ChartCore.tsx`, immediately after `onBacktestDrillIn` (ends line 515), add:

```ts
  // Zoom-to-range release: keep the view centered on the range midpoint, one
  // timeframe lower. The drawn width only picks the midpoint; the range is NOT
  // fit to the viewport (deliberate — see the design doc). At the TF floor there
  // is no lower step, so just recenter on the current TF. Either way the band
  // stays visible (redrawn by useLiveMarketData after a TF change, kept as-is
  // when there is none).
  const onZoomToRange = (fromMs: number, toMs: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    onFocus?.(cellId);
    const midTs = Math.round((fromMs + toMs) / 2);
    const target = oneTfLower(period.resolution, loadFavoriteResolutions());
    if (!target || target.resolution === period.resolution) {
      // Floor: recenter now, keep the band (already frozen by finishZoomBand).
      scrollTsToCenter(chart, midTs);
      return;
    }
    pendingCenterRef.current = {
      resolution: target.resolution,
      centerTs: midTs,
      epic: symbol.epic,
      broker: brokerId,
      side: priceSide,
      bandStartTs: fromMs,
      bandEndTs: toMs,
    };
    onPeriod?.(cellId, target);
  };
```

- [ ] **Step 3: Add the drag gesture (clone of the Pick Range handlers)**

In `frontend/src/ChartCore.tsx`, immediately after the `onRangePickDown` block (ends line 1958), add a parallel set. Declare the phase/state vars alongside the existing `rangePick*` state (search for `let rangePickPhase` and add these beside it):

```ts
    let zoomPhase: "idle" | "drag" | "track" = "idle";
    let zoomDownX = 0;
    let zoomMoved = false;
    let zoomDragCleanup: (() => void) | null = null;
```

Then the handlers (reuse `rangePickTsAtX` for x->timestamp, defined above at line ~1895):

```ts
    const zoomFinalize = (endTs: number | null) => {
      if (endTs != null) overlays.updateZoomBand(endTs);
      const res = overlays.finishZoomBand(); // null if no real width (a plain click)
      zoomDragCleanup?.();
      zoomDragCleanup = null;
      zoomPhase = "idle";
      zoomRangeArmed.set(false); // one-shot: disarm after a pick
      if (res) onZoomToRange(res.fromMs, res.toMs); // band stays; view drops one TF
    };
    const onZoomMove = (me: MouseEvent) => {
      const ts = rangePickTsAtX(me.clientX);
      if (ts == null) return;
      if (Math.abs(me.clientX - zoomDownX) > 4) zoomMoved = true;
      overlays.updateZoomBand(ts);
    };
    const onZoomUp = (ue: MouseEvent) => {
      window.removeEventListener("mouseup", onZoomUp, true);
      if (zoomPhase !== "drag") return;
      if (zoomMoved) {
        zoomFinalize(rangePickTsAtX(ue.clientX)); // press-drag: release ends it
      } else {
        zoomPhase = "track"; // a plain click: cursor sizes it, next click ends
      }
    };
    const onZoomDown = (e: MouseEvent) => {
      if (!zoomRangeArmed.value || e.button !== 0) return;
      const c = chartRef.current;
      const mainW = c?.getSize("candle_pane", 'main')?.width ?? Infinity;
      if (e.clientX - el.getBoundingClientRect().left > mainW) return; // price-axis strip
      if (zoomPhase === "track") {
        e.preventDefault();
        e.stopImmediatePropagation();
        zoomFinalize(rangePickTsAtX(e.clientX));
        return;
      }
      const startTs = rangePickTsAtX(e.clientX);
      if (startTs == null) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // the zoom tool owns this gesture
      overlays.startZoomBand(startTs);
      zoomPhase = "drag";
      zoomDownX = e.clientX;
      zoomMoved = false;
      window.addEventListener("mousemove", onZoomMove, true);
      window.addEventListener("mouseup", onZoomUp, true);
      zoomDragCleanup = () => {
        window.removeEventListener("mousemove", onZoomMove, true);
        window.removeEventListener("mouseup", onZoomUp, true);
      };
    };
    // A plain press with a FROZEN zoom band (not armed) dismisses it — "click away".
    const onZoomBandClear = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (zoomRangeArmed.value || zoomPhase !== "idle") return;
      if (overlays.hasZoomBand()) overlays.clearZoomBand();
    };
```

- [ ] **Step 4: Arm/disarm subscription**

In `frontend/src/ChartCore.tsx`, immediately after the `unsubRangePickArm` subscription (ends line 2084), add:

```ts
    // Zoom-to-range arm/disarm: like Pick Range, disable chart scroll/zoom while
    // armed (so the press-drag selects instead of panning) and restore on disarm.
    // On disarm, tear down any half-drawn drag but LEAVE a completed band visible.
    const unsubZoomArm = zoomRangeArmed.subscribe((on) => {
      setZoomArmedUi(on);
      const c = chartRef.current;
      if (on) {
        c?.setScrollEnabled(false);
        c?.setZoomEnabled(false);
        wrapRef.current?.focus({ preventScroll: true }); // so Esc reaches onKeyDown
      } else {
        zoomDragCleanup?.();
        zoomDragCleanup = null;
        if (zoomPhase !== "idle") {
          zoomPhase = "idle";
          if (overlays.hasZoomBand() && overlays.finishZoomBand() == null) {
            // disarmed mid-drag with no real width: drop the half-band
          }
        }
        c?.setScrollEnabled(true);
        c?.setZoomEnabled(true);
      }
    });
```

Add the `zoomArmedUi` state near the other `*ArmedUi` states (search `const [rangePickArmedUi, setRangePickArmedUi]` line 793):

```ts
  const [zoomArmedUi, setZoomArmedUi] = useState(false);
```

- [ ] **Step 5: Register + unregister the mousedown listeners**

In `frontend/src/ChartCore.tsx`, in the listener-registration block, add `onZoomDown` FIRST (like Pick Range, it owns the press) — immediately before `el.addEventListener("mousedown", onRangePickDown, true);` (line 2097):

```ts
      el.addEventListener("mousedown", onZoomDown, true);
```

And add the click-away clear alongside `onMeasureClear` (after line 2099):

```ts
      el.addEventListener("mousedown", onZoomBandClear, true);
```

In the cleanup section (near `el.removeEventListener("mousedown", onRangePickDown, true);` line 2459), add:

```ts
      el.removeEventListener("mousedown", onZoomDown, true);
      el.removeEventListener("mousedown", onZoomBandClear, true);
      unsubZoomArm();
```

(Place `unsubZoomArm()` beside the other `unsub*()` cleanup calls in the same return block.)

- [ ] **Step 6: Esc handling**

In the `onKeyDown` Esc branch (search the block around line 3306 that checks `rangePickArmed.value`), add a zoom clause BEFORE the generic measure/slope clears, mirroring the Pick Range one:

```ts
          if (zoomRangeArmed.value) {
            zoomRangeArmed.set(false); // subscription restores scroll/zoom
            overlays.clearZoomBand();
          } else if (overlays.hasZoomBand()) {
            overlays.clearZoomBand(); // Esc dismisses a frozen band too
          } else if (rangePickArmed.value) {
```

(Fold this into the existing `else if` ladder — the implementer should read lines 3300-3340 and insert these two branches at the top of the ladder so Esc handles the zoom tool before falling through to measure/slope.)

- [ ] **Step 7: Crosshair cursor class**

In the wrap `className` expression (line 3367), add `zoomArmedUi` to the `"anchoring"` cursor condition:

```tsx
        className={anchoring || measureArmedUi || slopeArmedUi || rangePickArmedUi || zoomArmedUi ? "anchoring" : undefined}
```

- [ ] **Step 8: Typecheck + build the frontend**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/ChartCore.tsx
git commit -m "feat(chart): wire zoom-to-range gesture, arm, dismiss, and TF-drop in ChartCore"
```

---

### Task 7: Sidebar button + glyph

Add the "Zoom to range" button to the left `DrawSidebar`, mirroring the Measure/Slope buttons, with a new magnifier-over-range glyph.

**Files:**
- Modify: `frontend/src/lib/menuIcons.tsx` (add `ZoomRangeIcon` beside `RulerIcon`/`SlopeIcon`).
- Modify: `frontend/src/DrawSidebar.tsx` (mirror state ~line 77-88, button ~line 287-297, import the icon line 20).

**Interfaces:**
- Consumes: `controller.zoomRangeArmed` (Task 2), `ZoomRangeIcon`.

- [ ] **Step 1: Add the glyph**

In `frontend/src/lib/menuIcons.tsx`, add beside `SlopeIcon` a magnifier with a small range bracket (keep the existing 16x16 / `currentColor` conventions used by `RulerIcon`):

```tsx
export function ZoomRangeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      {/* magnifier */}
      <circle cx="7" cy="7" r="4.2" />
      <line x1="10.2" y1="10.2" x2="14" y2="14" strokeLinecap="round" />
      {/* range bracket inside the lens */}
      <line x1="5" y1="7" x2="9" y2="7" strokeLinecap="round" />
      <line x1="5" y1="5.6" x2="5" y2="8.4" strokeLinecap="round" />
      <line x1="9" y1="5.6" x2="9" y2="8.4" strokeLinecap="round" />
    </svg>
  );
}
```

- [ ] **Step 2: Mirror the armed state in DrawSidebar**

In `frontend/src/DrawSidebar.tsx`:
- Add `ZoomRangeIcon` to the import from `./lib/menuIcons` (line 20).
- After the slope mirror block (lines 84-88), add:

```tsx
  // Zoom-to-range tool mirror (same optional-chain HMR-safe pattern as measure).
  const [zooming, setZooming] = useState(controller?.zoomRangeArmed?.value ?? false);
  useEffect(() => {
    if (!controller?.zoomRangeArmed) return;
    setZooming(controller.zoomRangeArmed.value);
    return controller.zoomRangeArmed.subscribe(setZooming);
  }, [controller]);
```

- [ ] **Step 3: Add the button**

In `frontend/src/DrawSidebar.tsx`, immediately after the Measure button block (ends ~line 298, the `<Tooltip>...<RulerIcon /></button></Tooltip>` for measure — place it after the Slope button if Slope's button is separate; put it directly below whichever transient-tool button is last), add:

```tsx
      {/* Zoom to range: drag a band, drop one timeframe lower centered on it. */}
      <Tooltip
        placement="right"
        content={[
          "Zoom to range. Drag across a time range.",
          "On release, drops one timeframe lower centered on it.",
        ]}
      >
        <button
          className={`ds-btn${zooming ? " on" : ""}`}
          disabled={!controller?.zoomRangeArmed}
          onClick={() => controller?.zoomRangeArmed?.set(!controller.zoomRangeArmed.value)}
        >
          <ZoomRangeIcon />
        </button>
      </Tooltip>
```

(Match the exact className/`on`-toggle idiom the Measure button uses — read lines 287-298 and copy its structure so the active-state styling is identical.)

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/menuIcons.tsx frontend/src/DrawSidebar.tsx
git commit -m "feat(chart): Zoom-to-range sidebar button + glyph"
```

---

### Task 8: Manual verification in the running app

No automated coverage exists for the pointer/klinecharts wiring, so verify end-to-end in the browser. (The `verify` skill / `/run` can launch the app.)

**Steps (each is an observation, not a code change):**

- [ ] **Step 1:** Start the dev app (do NOT kill an existing HMR server — reuse it). Open a chart on an instrument with history, set it to 4H.
- [ ] **Step 2:** Click the Zoom-to-range button (magnifier glyph) in the left sidebar. Cursor becomes the crosshair; the button shows the active state.
- [ ] **Step 3:** Press-drag across ~6 hours of candles and release. Expect: chart switches to 1H, view centered on the drawn range's midpoint, the translucent band still visible as a sliver near center. The button disarms (one-shot).
- [ ] **Step 4:** Click anywhere on the chart (not armed). Expect: the band disappears.
- [ ] **Step 5:** Repeat the drag, then press Esc. Expect: the band disappears.
- [ ] **Step 6:** Arm the tool, then press Esc mid-drag (before releasing). Expect: the half-drawn band cancels, tool disarms.
- [ ] **Step 7:** Switch to the lowest enabled TF (1m by default). Arm, drag a range, release. Expect: stays on 1m, view recenters on the midpoint, band visible.
- [ ] **Step 8:** In Settings, turn ON "reset view on timeframe change". Repeat Step 3. Expect: the zoom STILL centers on the range (pending center wins over the reset setting).
- [ ] **Step 9:** After a zoom (band showing), manually change the timeframe via the toolbar. Expect: the band disappears (it does not survive a manual TF change).
- [ ] **Step 10:** Reload the page. Expect: no band (session-only, not persisted).
- [ ] **Step 11 (regression):** Confirm the backtest "Pick Range" tool still works (arm from the backtest panel, drag, it fits the range) — the two bands must not interfere.

- [ ] **Step 12: Commit any small fixes found during verification**, then run the full frontend test + typecheck gate:

```bash
cd frontend && npx tsc --noEmit && npx vitest run
```
Expected: PASS.

---

## Self-Review

**Spec coverage:**
- Toolbar button + arming → Task 2, 7. ✔
- Full-height band drag → Task 3 (reuses `rangeBand` painter), Task 6 (gesture). ✔
- Drop one TF lower on the enabled ladder → Task 1 (`oneTfLower`), Task 6 (`onZoomToRange`). ✔
- Keep center on midpoint, natural spacing (width = midpoint only) → Task 6 + Task 5. ✔
- Unconditional center (bypasses keepCenter + resetViewOnTimeframeChange) → Task 5 Step 1. ✔
- Band survives the tool's own TF change, redrawn from timestamps → Task 5 Steps 2-3, Task 3 `redrawZoomBand`. ✔
- TF floor → recenter, no TF change → Task 6 `onZoomToRange` floor branch. ✔
- Transient, session-only, not persisted/selectable → Task 3 (kind `rangeBand`, already excluded). ✔
- Dismiss on click-away / Esc / manual TF-epic change / reload → Task 6 Steps 3,6; Task 5 Step 2. ✔
- Pure click cancels (no width) → Task 3 `finishZoomBand` returns null; Task 6 `zoomFinalize` no-ops. ✔
- Left-drag normalize → Task 3 `finishZoomBand` `Math.min/max`. ✔
- No off-grid decode needed (always finer) → Task 3 `redrawZoomBand` comment. ✔

**Placeholder scan:** No TBD/TODO; every code step shows full code. The two places that say "read lines X-Y first" (Task 5 Step 3, Task 6 Step 6) are precise insertion-point instructions with the exact code to insert, not deferred work.

**Type consistency:** `zoomRangeArmed` (Signal), `pendingCenterRef` / `CenterReq` (fields `resolution, centerTs, epic, broker, side, bandStartTs, bandEndTs`), overlay methods (`startZoomBand`/`updateZoomBand`/`finishZoomBand`/`redrawZoomBand`/`clearZoomBand`/`hasZoomBand`), `oneTfLower(currentResolution, favoriteResolutions)`, `onZoomToRange(fromMs, toMs)` — all names used identically across Tasks 3-7.
