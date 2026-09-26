// Transient chart tools: the measure ruler, the slope line, the backtest Pick
// Range band, the zoom band, the Find-similar match bands, and the press-drag
// placement of a time-range highlight.
import type { Overlay, DeepPartial, OverlayStyle } from "klinecharts";
import { loadDrawingDefault } from "../persist";
import { RESOLUTION_SECONDS } from "../feed";
import { timeRangeSpan } from "../timeRangeMetrics";
import {
  type DrawingExtra,
  MATCH_BAND_STYLE,
  MATCH_FWD_BAND_STYLE,
  TIME_RANGE_DEFAULT_STYLE,
  asDrawingExtra,
  cloneStyles,
} from "./shared";
import { OverlayAlerts } from "./alerts";

export abstract class OverlayTools extends OverlayAlerts {
  // --- transient measure tool (TV ruler) ------------------------------------
  // Begin an interactive measurement: klinecharts collects the two anchors by
  // CLICK (click start → move → click end), exactly like the Draw-menu tools — no
  // press-drag. Removes any existing measure first (single-instance). onDrawEnd
  // (in create()) freezes it and fires measureDone so the caller can disarm.
  startMeasureDraw(): string | null {
    if (!this.chart) return null;
    this.clearMeasure();
    this.drawingInProgress = true; // suppress lock click-align during the two placing clicks
    const id = this.create("measure", "measure"); // no points → klinecharts draws it by click
    if (id) {
      this.measureId = id;
      this.measureDrawing = true;
    } else {
      this.drawingInProgress = false;
    }
    return id;
  }

  // Discard the measurement (cancel mid-draw, next interaction, Esc, symbol change).
  clearMeasure(): void {
    if (this.measureId) this.chart?.removeOverlay({ id: this.measureId }); // onRemoved nulls the fields
    this.measureId = null;
    this.measureDrawing = false;
  }

  hasMeasure(): boolean {
    return this.measureId != null;
  }

  // True between the first placing click and completion — lets a caller tell a
  // placing click apart from a plain "click away that clears the frozen box".
  isMeasureDrawing(): boolean {
    return this.measureDrawing;
  }

  // --- transient Slope tool (TV-style angle ruler) --------------------------
  // Begin drawing a slope line: klinecharts collects the two anchors by CLICK, like
  // measure. onDrawEnd (in create()) freezes the draw state and fires slopeDone so the
  // caller can disarm. Unlike measure the line then stays interactive — ChartCore drives
  // its endpoint/midpoint/knob drags through updateSlope. Single-instance.
  startSlopeDraw(): string | null {
    if (!this.chart) return null;
    this.clearSlope();
    this.drawingInProgress = true; // suppress lock click-align during the two placing clicks
    // Stamp the base bar interval so the slope readout's price/time is gap-free (each bar
    // counts as this many minutes, independent of weekend/overnight gaps).
    const secs = RESOLUTION_SECONDS[this.resolution];
    const baseIntervalMinutes = secs ? secs / 60 : undefined;
    const id = this.create("slope", "slope", undefined, null, undefined, { extendData: { baseIntervalMinutes } }); // no points → klinecharts draws it by click
    if (id) {
      this.slopeId = id;
      this.slopeDrawing = true;
    } else {
      this.drawingInProgress = false;
    }
    return id;
  }

  // Discard the slope line (Esc, arming a new one, symbol/interval change).
  clearSlope(): void {
    if (this.slopeId) this.chart?.removeOverlay({ id: this.slopeId }); // onRemoved nulls the fields
    this.slopeId = null;
    this.slopeDrawing = false;
  }

  hasSlope(): boolean {
    return this.slopeId != null;
  }

  isSlopeDrawing(): boolean {
    return this.slopeDrawing;
  }

  // The slope line's two anchor points ({ timestamp, value, dataIndex }), or null if
  // there's no live line. ChartCore reads these to hit-test the handles in pixel space.
  getSlopePoints(): Array<{ timestamp?: number; value?: number; dataIndex?: number }> | null {
    if (!this.slopeId) return null;
    const ov = this.byId(this.slopeId);
    return ov?.points ? (ov.points as Array<{ timestamp?: number; value?: number; dataIndex?: number }>) : null;
  }

  // Move the slope line's anchors during an interactive handle drag (endpoint move,
  // midpoint translate, or rotate). ChartCore computes the new data-space points from
  // the cursor and pushes them here; klinecharts re-runs createPointFigures to repaint.
  updateSlope(points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>): void {
    if (!this.slopeId || !this.chart) return;
    this.chart.overrideOverlay({ id: this.slopeId, points: points as Overlay["points"] });
  }

  // --- transient "Pick Range" band (backtest) --------------------------------
  // Begin a range selection at `startTs`: create the full-height band with both
  // anchors at the start (zero width). ChartCore's drag then calls updateRangePick
  // as the cursor moves and finishRangePick on release. Created WITH points, so it
  // renders immediately (no click-to-place draw mode).
  startRangePick(startTs: number): string | null {
    if (!this.chart) return null;
    this.clearRangePick();
    this.rangeStartTs = startTs;
    this.rangeEndTs = startTs;
    const id = this.create("rangeBand", "rangeBand", [
      { timestamp: startTs, value: 0 },
      { timestamp: startTs, value: 0 },
    ], null, true);
    this.rangeBandId = id;
    return id;
  }

  // Move the band's end anchor during the drag.
  updateRangePick(endTs: number): void {
    if (!this.rangeBandId || this.rangeStartTs == null || !this.chart) return;
    this.rangeEndTs = endTs;
    this.chart.overrideOverlay({
      id: this.rangeBandId,
      points: [
        { timestamp: this.rangeStartTs, value: 0 },
        { timestamp: endTs, value: 0 },
      ],
    });
  }

  // End the selection: remove the band and return the ordered [fromMs,toMs], or
  // null if no real range was drawn.
  finishRangePick(): { fromMs: number; toMs: number } | null {
    const start = this.rangeStartTs;
    const end = this.rangeEndTs;
    this.clearRangePick();
    if (start == null || end == null || start === end) return null;
    return { fromMs: Math.min(start, end), toMs: Math.max(start, end) };
  }

  // Discard the band (disarm, Esc, symbol change, or a click with no drag).
  clearRangePick(): void {
    if (this.rangeBandId) this.chart?.removeOverlay({ id: this.rangeBandId }); // onRemoved nulls the fields
    this.rangeBandId = null;
    this.rangeStartTs = null;
    this.rangeEndTs = null;
  }

  hasRangePick(): boolean {
    return this.rangeBandId != null;
  }

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

  // --- "Find similar" match bands --------------------------------------------
  // Mark where a jumped-to match starts and ends: one band over the matched
  // candles, and (when the panel had forward bars to measure) a dimmer one over
  // the aftermath. The two are ADJACENT, so their shared edge IS the divider
  // between "the shape" and "what happened next" — no third overlay draws it.
  // Both take their colors from styles.polygon via the matchBand template, which
  // is how the same template renders the two strengths; the aftermath sits at
  // roughly the row preview's 0.45 opacity so the list and the chart agree.
  //
  // Every timestamp is in MILLISECONDS (like every other overlay anchor here),
  // while PatternMatch carries seconds — callers convert.
  //
  // The anchors are the RAW first and last bar of each window. Enclosing those
  // bars rather than stopping at their centres is the matchBand template's job,
  // in pixel space off getBarSpace() (see its geometry note: klinecharts snaps a
  // timestamp to a whole bar index, so there is no sub-bar precision to nudge an
  // anchor with). `forward` is the window the panel measured, from its FIRST
  // forward bar, which is the bar immediately after matchToTs — so the two bands
  // come out exactly adjacent and their shared edge is the divider. null when
  // the match had no aftermath to measure.
  showMatchBands(
    matchFromTs: number,
    matchToTs: number,
    forward: { fromTs: number; toTs: number } | null,
  ): void {
    if (!this.chart) return;
    this.clearMatchBands();
    this.matchBandId = this.create(
      "rangeBand",
      "matchBand",
      [
        { timestamp: matchFromTs, value: 0 },
        { timestamp: matchToTs, value: 0 },
      ],
      cloneStyles(MATCH_BAND_STYLE),
      true,
    );
    if (forward == null || forward.toTs < forward.fromTs) return;
    this.matchFwdBandId = this.create(
      "rangeBand",
      "matchBand",
      [
        { timestamp: forward.fromTs, value: 0 },
        { timestamp: forward.toTs, value: 0 },
      ],
      cloneStyles(MATCH_FWD_BAND_STYLE),
      true,
    );
  }

  clearMatchBands(): void {
    if (this.matchBandId) this.chart?.removeOverlay({ id: this.matchBandId });
    if (this.matchFwdBandId) this.chart?.removeOverlay({ id: this.matchFwdBandId });
    this.matchBandId = null;
    this.matchFwdBandId = null;
  }

  // --- time-range highlight (persistent) -------------------------------------
  // Begin placing a highlight at `startTs` (bar open under the press): create the
  // full-height band with both anchors at the start. ChartCore's drag calls
  // updateTimeRange as the cursor moves and finishTimeRange on release. Seeded from
  // this overlay-name's saved default (like addDrawing) so per-name colors/templates
  // apply. Persistent — the overlay stays after placement.
  startTimeRange(startTs: number): string | null {
    if (!this.canPlaceDrawing() || this.readOnly) return null;
    this.clearTimeRangeDraft();
    this.timeRangeStartTs = startTs;
    this.drawingInProgress = true; // suppress lock click-align during the press-drag
    const seed = this.seedFromDefault("timeRange");
    const styles = seed?.styles ?? TIME_RANGE_DEFAULT_STYLE;
    const id = this.create("drawing", "timeRange", [
      { timestamp: startTs, value: 0 },
      { timestamp: startTs, value: 0 },
    ], styles, undefined, { extendData: seed?.extendData });
    this.timeRangeId = id;
    if (!id) this.drawingInProgress = false;
    return id;
  }

  // Move the band's end anchor during the drag (live preview).
  updateTimeRange(endTs: number): void {
    if (!this.timeRangeId || this.timeRangeStartTs == null || !this.chart) return;
    this.chart.overrideOverlay({
      id: this.timeRangeId,
      points: [
        { timestamp: this.timeRangeStartTs, value: 0 },
        { timestamp: endTs, value: 0 },
      ],
    });
  }

  // Finish placing: collapse to the clicked candle's span (endTs null/unchanged) or
  // the dragged range, INCLUSIVE of the bar under the cursor (to = later open + one
  // bar). Normalizes, keeps the overlay, and persists. Returns the placed id or null.
  finishTimeRange(endTs: number | null): string | null {
    const start = this.timeRangeStartTs;
    const id = this.timeRangeId;
    this.timeRangeId = null;
    this.timeRangeStartTs = null;
    this.drawingInProgress = false;
    if (!id || start == null || !this.chart) {
      if (id) this.chart?.removeOverlay({ id });
      return null;
    }
    const tfMs = this.barIntervalMs() ?? 0;
    const { from, to } = timeRangeSpan(start, endTs, tfMs);
    this.chart.overrideOverlay({
      id,
      points: this.materializePoints([
        { timestamp: from, value: 0 },
        { timestamp: to, value: 0 },
      ]) as Overlay["points"],
    });
    const ov = this.byId(id);
    if (ov) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
    this.persist();
    // Leave the just-placed band click-selected so the user can hit Delete/⌘C
    // immediately (mirrors the clone path). deleteSelectedDrawing reads this id.
    this.selectedDrawingId = id;
    this.notifyDrawing();
    return id;
  }

  // Discard the in-progress highlight (disarm, Esc, symbol/interval change) BEFORE
  // it's placed. A finished highlight is a normal drawing and isn't touched here.
  clearTimeRangeDraft(): void {
    if (this.timeRangeId) this.chart?.removeOverlay({ id: this.timeRangeId });
    this.timeRangeId = null;
    this.timeRangeStartTs = null;
    this.drawingInProgress = false;
  }

  isTimeRangeDrawing(): boolean {
    return this.timeRangeId != null;
  }

  // --- pattern ghost (the pasted pattern overlay) ----------------------------
  // A ghost auto-aligns to the candles under it until the user drags it
  // VERTICALLY, which is the whole reason this drag state exists: the score is
  // blind to price level, so "did they move it up/down" is the only signal that
  // they want to place it themselves. Recorded on press, judged on release.
  //
  // Paste + Re-align live here (not in ChartCore) so the ghost goes through the
  // same create/persist path as every other drawing.

  // Translate a saved default for `name` into create()'s styles + extendData, or
  // undefined when there's no default. extendData carries only the appearance flags
  // (showMiddle/priceLabels/visibility) — never points or text.
  protected seedFromDefault(
    name: string,
  ): { styles?: DeepPartial<OverlayStyle>; extendData?: DrawingExtra } | undefined {
    const def = loadDrawingDefault(name);
    if (!def) return undefined;
    const extendData: DrawingExtra = {};
    if (def.showMiddle !== undefined) extendData.showMiddle = def.showMiddle;
    if (def.priceLabels !== undefined) extendData.priceLabels = def.priceLabels;
    if (def.visibility !== undefined) extendData.visibility = def.visibility;
    if (def.fib !== undefined) extendData.fib = def.fib;
    if (def.ghostStyle !== undefined) extendData.ghostStyle = def.ghostStyle;
    const styles: DeepPartial<OverlayStyle> = {};
    if (def.line) (styles as { line?: unknown }).line = def.line;
    if (def.polygon) (styles as { polygon?: unknown }).polygon = def.polygon;
    return {
      styles: Object.keys(styles).length ? styles : undefined,
      extendData: Object.keys(extendData).length ? extendData : undefined,
    };
  }
}
