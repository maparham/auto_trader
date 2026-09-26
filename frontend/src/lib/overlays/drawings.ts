// Placing drawings: the click-to-place and programmatic paths, the trade
// box's synthesized stop and drags, pattern ghosts, and the per-drawing
// config snapshot the settings modal reads and writes.
import type { LineType, Overlay, OverlayEvent, DeepPartial, OverlayStyle } from "klinecharts";
import type { SavedOverlay, SavedDrawingConfig } from "../persist";
import { asFibConfig } from "../fibConfig";
import { isFibOverlay } from "../drawTools";
import { asTradeConfig, defaultStopPrice, flipTradeLeg, syncTradePoints } from "../tradePlan";
import {
  asGhostStyle,
  ghostPrices,
  windowMoments,
  windowUnder,
  type GhostFit,
  type GhostPattern,
  type GhostStyle,
} from "../patternGhost";
import {
  type DrawingExtra,
  GHOST_NAME,
  GHOST_PIN_PX,
  RECT_DEFAULT_STYLE,
  asDrawingExtra,
  isTradeDrawing,
} from "./shared";
import { OverlayTools } from "./tools";

export abstract class OverlayDrawings extends OverlayTools {
  /** Paste a copied pattern with its first bar on the bar at `ts`, anchored at
   *  `value` (the drop price, used only until the first auto-fit). Returns the
   *  new overlay id. */
  pastePatternGhost(ts: number, value: number, ghost: GhostPattern): string | null {
    if (!this.canPlaceDrawing() || this.readOnly) return null;
    const seed = this.seedFromDefault("patternGhost");
    const extendData: DrawingExtra = { ...asDrawingExtra(seed?.extendData), ghost };
    const id = this.create("drawing", "patternGhost", [{ timestamp: ts, value }], seed?.styles, undefined, {
      extendData,
    });
    if (!id) return null;
    this.persist();
    // An in-place create never fires onDrawEnd, so any seeded per-interval
    // visibility has to be enforced here (same as addDrawing's points branch).
    const ov = this.byId(id);
    if (ov) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
    // Leave it selected so Delete works straight away, like a placed time range.
    this.selectedDrawingId = id;
    this.notifyDrawing();
    return id;
  }

  /** Hand a pinned ghost back to the auto-fit, so what is drawn is what is
   *  scored. A no-op on a ghost that was never pinned. */
  realignGhost(id: string): void {
    const ov = this.byId(id);
    if (!ov || ov.name !== GHOST_NAME) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData) };
    if (!extra.ghostPinned) return;
    delete extra.ghostPinned;
    delete extra.ghostFit;
    this.applyDisplay(id, ov, extra);
    this.persist();
  }

  /** Repaint a ghost: shape / opacity / colour / score visibility. The copied
   *  shape and the match are untouched — this is look only. */
  setGhostStyle(id: string, style: GhostStyle): void {
    const ov = this.byId(id);
    if (!ov || ov.name !== GHOST_NAME) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), ghostStyle: asGhostStyle(style) };
    this.chart?.overrideOverlay({ id, extendData: extra });
    this.persist();
  }

  /** True for a pattern ghost, so the drawing context menu can offer Re-align
   *  only where it means something. */
  isPinnedGhost(id: string): boolean {
    const ov = this.byId(id);
    return ov?.name === GHOST_NAME && asDrawingExtra(ov.extendData).ghostPinned === true;
  }

  // Vertical pixels between two prices on the candle pane, for the pin test.
  private priceGapPx(a: number, b: number): number {
    if (!this.chart) return 0;
    const cs = this.chart.convertToPixel([{ value: a }, { value: b }], {
      paneId: "candle_pane",
      absolute: true,
    });
    if (!Array.isArray(cs) || cs.length < 2) return 0;
    const y0 = cs[0]?.y;
    const y1 = cs[1]?.y;
    return y0 == null || y1 == null ? 0 : Math.abs(y1 - y0);
  }

  // The placement the ghost was actually DRAWN at before the drag — position and
  // scale both. Pinning has to start from this, not from the anchor value nobody
  // was looking at, and it goes through the same ghostPrices the template paints
  // with so the two cannot drift.
  private ghostDrawnFit(
    ghost: GhostPattern,
    at: { dataIndex: number; timestamp?: number; value: number },
  ): GhostFit | null {
    const list = this.chart?.getDataList() ?? [];
    const n = ghost.bars.length;
    const drawn = ghostPrices(ghost.bars, {
      actual: windowUnder(list, at, n),
      reference: windowUnder(list, { dataIndex: Math.max(0, list.length - n) }, n),
      anchorPrice: at.value,
    });
    return windowMoments(drawn);
  }

  // Give a freshly drawn trade its stop point. The two-click gesture places only
  // entry and target, so on draw-end the stop is seeded opposite the target at
  // half the reward (a 1:2 trade) and pinned to the same right edge. Called from
  // create()'s onDrawEnd, before the degenerate-anchor check.
  protected completeTradeDrawing(id: string): void {
    const ov = this.byId(id);
    const points = ov?.points ?? [];
    if (!ov || points.length !== 2) return; // already complete (rehydrate/paste)
    const entry = points[0]?.value;
    const target = points[1]?.value;
    if (entry == null || target == null) return;
    this.chart?.overrideOverlay({
      id,
      points: [
        ...points,
        { ...points[1], value: defaultStopPrice(entry, target) },
      ] as Overlay["points"],
    });
  }

  // Keep a trade's reward and risk zones on opposite sides of the entry while a
  // level handle is dragged across it: the OTHER leg reflects over the entry at
  // its own distance (flipTradeLeg), converting the trade long ⇄ short in place
  // instead of piling both zones onto one side. Runs inside onPressedMoving,
  // which fires BEFORE klinecharts moves the dragged point — so the dragged
  // level is predicted from the cursor (same conversion the native update will
  // make) and only the opposite leg is written here; returning false from the
  // handler then lets the native update place the dragged point itself. A
  // whole-body translate moves all three points together and never crosses.
  protected maybeFlipTrade(e: OverlayEvent<unknown>): void {
    const overlay = e.overlay;
    const points = overlay.points;
    if (points.length !== 3) return; // still being drawn: no stop yet
    const key = e.figure?.key;
    if (!key?.startsWith("overlay_figure_point_")) return; // body drag, not a handle
    const idx = Number(key.slice("overlay_figure_point_".length));
    if (idx !== 0 && idx !== 1 && idx !== 2) return;
    if (typeof e.x !== "number" || typeof e.y !== "number") return;
    const value = this.fromPx(overlay, { x: e.x, y: e.y })?.value;
    const [entry, target, stop] = points.map((p) => p?.value);
    if (value == null || entry == null || target == null || stop == null) return;
    const flip = flipTradeLeg({ entry, target, stop }, idx as 0 | 1 | 2, value);
    if (flip) points[flip.index] = { ...points[flip.index], value: flip.value };
  }

  // Pull a trade's target and stop back onto one right edge after a horizontal
  // drag moved only the point under the cursor. Called from create()'s
  // onPressedMoveEnd; a vertical-only drag is a no-op.
  protected settleTradeDrag(ov: Overlay): void {
    const prevEdge = this.tradeDragEdge;
    this.tradeDragEdge = null;
    if (prevEdge == null || !this.chart) return;
    const points = (ov.points ?? []) as Array<{ timestamp: number; value: number }>;
    const synced = syncTradePoints(points, prevEdge);
    if (!synced) return;
    this.chart.overrideOverlay({ id: ov.id, points: synced as Overlay["points"] });
  }

  // Decide, on release, whether the drag was a placement (vertical) or just a
  // slide along the bars. Called from create()'s onPressedMoveEnd.
  protected settleGhostDrag(ov: Overlay): void {
    const start = this.ghostDragStart;
    this.ghostDragStart = null;
    if (!start || !this.chart) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData) };
    const ghost = extra.ghost;
    const end = ov.points?.[0]?.value;
    if (!ghost || end == null) return;
    const delta = end - start.value;
    // An already-placed ghost just travels with the drag: the frozen fit is what
    // draws it, so a vertical move has to move THAT, not only the anchor point.
    if (extra.ghostPinned) {
      if (delta === 0 || !extra.ghostFit) return; // slid along the bars
      extra.ghostFit = { ...extra.ghostFit, mean: extra.ghostFit.mean + delta };
      this.chart.overrideOverlay({ id: ov.id, extendData: extra });
      return;
    }
    if (this.priceGapPx(start.value, end) <= GHOST_PIN_PX) return; // slid sideways: stay aligned
    // Pin it where it VISUALLY was: the placement it had before the press, moved
    // by the drag. Freezing the whole fit (not just a price) is what stops it
    // resizing on release — the drawn scale comes from the candles it was over,
    // which a bare price anchor throws away.
    const drawn = this.ghostDrawnFit(ghost, start);
    if (!drawn) return; // nothing was drawable to pin; leave it aligned
    extra.ghostPinned = true;
    extra.ghostFit = { mean: drawn.mean + delta, sd: drawn.sd };
    this.chart.overrideOverlay({ id: ov.id, extendData: extra });
  }

  // --- user actions (called by Toolbar / chart "+" menu) ---------------------

  // Place a drawing. With points it's created in place (e.g. a horizontal line
  // at a price from the "+" menu); without, klinecharts enters interactive draw.
  addDrawing(name: string, points?: SavedOverlay["points"]): string | null {
    if (this.readOnly) return null; // snapshot view: no new drawings
    // Not hydrated yet: an interactive tool waits for rehydrate() to arm it (see
    // deferredTool); an in-place draw has nothing to wait for and is refused.
    if (!this.canPlaceDrawing()) {
      if (!points) {
        this.cancelDrawing();
        this.deferredTool = name;
      }
      return null;
    }
    this.deferredTool = null;
    // Re-arming replaces the in-progress tool: klinecharts keeps ONE progress slot
    // and silently overwrites it WITHOUT firing onRemoved, which would strand the
    // previous overlay's id in `entries` forever (getOverlayById(ghost) → null, so
    // e.g. anyDrawingsLocked/persist iterate a dead id). Cancel it properly first.
    if (!points) this.cancelDrawing();
    // No points = interactive draw (klinecharts collects clicks until the figure is
    // complete). Flag it so a lock click-to-align doesn't fire on those clicks; the
    // onDrawEnd in create() clears it.
    if (!points) this.drawingInProgress = true;
    // Seed from this overlay-name's saved default (set as default / TV-style). Only
    // fresh draws route through addDrawing — rehydrate/paste call create() directly —
    // so existing drawings are never restyled. extendData also drives the y-axis tag
    // (needDefaultYAxisFigure reads priceLabels in create()).
    const seed = this.seedFromDefault(name);
    // Fresh rectangle with no saved default → seed the built-in translucent look so
    // it never renders with klinecharts' opaque polygon default.
    const styles = seed?.styles ?? (name === "rect" ? RECT_DEFAULT_STYLE : undefined);
    const id = this.create("drawing", name, points, styles, undefined, {
      extendData: seed?.extendData,
    });
    if (id && points) {
      this.persist();
      // In-place draws (e.g. the chart "+" menu) complete synchronously and never fire
      // create()'s onDrawEnd, so enforce any seeded per-interval visibility here —
      // mirroring the interactive path's Step 3b. Harmless when nothing is seeded
      // (empty extra ⇒ visible). persist() ran first, so it captured the canonical
      // (unfaded) style, never a ghost rgba.
      const ov = this.byId(id);
      if (ov) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
    } else if (id && !points) this.pendingDrawId = id; // remember it for cancelDrawing()
    else if (!id) {
      // creation failed → don't get stuck
      this.drawingInProgress = false;
      this.pendingDrawId = null;
    }
    return id;
  }

  // Esc while placing a drawing (TV: Esc cancels the tool). Removes the in-progress
  // overlay; its onRemoved clears drawingInProgress/pendingDrawId (verified against
  // FakeChart AND real klinecharts — removeOverlay on an unfinished overlay still
  // fires onRemoved, same as clearMeasure() above already relies on).
  // Returns true if there was something to cancel (caller preventDefaults).
  cancelDrawing(): boolean {
    if (this.deferredTool) {
      this.deferredTool = null;
      return true;
    }
    if (!this.drawingInProgress || !this.pendingDrawId) return false;
    this.chart?.removeOverlay({ id: this.pendingDrawId });
    // Belt-and-braces: don't rely solely on onRemoved firing (it does today, but a
    // future klinecharts version silently not doing so for a never-finalized overlay
    // must not leave the tool stuck "armed").
    this.drawingInProgress = false;
    this.pendingDrawId = null;
    return true;
  }

  // Re-create a fully-specified drawing in place (paste / clone). Unlike addDrawing,
  // this carries styles + visible/zLevel/extendData so a copied drawing reappears
  // identical (offset by the caller). Persists immediately and selects the new one.
  placeDrawing(spec: {
    name: string;
    points: SavedOverlay["points"];
    styles?: DeepPartial<OverlayStyle> | null;
    lock?: boolean;
    visible?: boolean;
    zLevel?: number;
    extendData?: unknown;
  }): string | null {
    if (!this.canPlaceDrawing()) return null; // it would never be saved (see deferredTool)
    const id = this.create("drawing", spec.name, spec.points, spec.styles, spec.lock, {
      visible: spec.visible,
      zLevel: spec.zLevel,
      extendData: spec.extendData,
    });
    if (id) {
      // No onDrawEnd on this path (it is the non-interactive one), so a trade
      // arriving with only entry+target still needs its stop seeded.
      if (isTradeDrawing(spec.name)) this.completeTradeDrawing(id);
      this.persist();
      this.selectedDrawingId = id;
      this.notifyDrawing();
    }
    return id;
  }

  // Place a drawing as if the user had just drawn it: styled from their saved
  // default for `name` (klinecharts' own look when there is none), not from a
  // snapshot. Persists and selects it like placeDrawing.
  placeFreshDrawing(name: string, points: SavedOverlay["points"]): string | null {
    if (this.readOnly) return null;
    const seed = this.seedFromDefault(name);
    const id = this.placeDrawing({ name, points, styles: seed?.styles, extendData: seed?.extendData });
    // An in-place create never fires onDrawEnd, so any seeded per-interval
    // visibility has to be enforced here (same as pastePatternGhost).
    const ov = id ? this.byId(id) : null;
    if (id && ov) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
    return id;
  }

  // --- drawing edits (called by the settings modal / context menu) ------------

  // Read the LIVE overlay into a reusable SavedDrawingConfig (no points/text). Used
  // by the settings modal's "Save as default/preset" — reading the live overlay (not
  // stale React state) is what makes the extend-via-name model correct: an extended
  // line resolves to name `straightLine` and saves under that key.
  getDrawingConfig(id: string): SavedDrawingConfig | null {
    const live = this.getDrawing(id);
    if (!live) return null;
    const line = (live.styles?.line ?? {}) as { color?: string; size?: number; style?: LineType };
    const extra = asDrawingExtra(live.extendData);
    // Rectangle carries its look in polygon styles (fill/border) rather than line.
    if (live.name === "rect") {
      const poly = (live.styles?.polygon ?? {}) as { color?: string; borderColor?: string; borderSize?: number };
      const dflt = RECT_DEFAULT_STYLE.polygon as { color: string; borderColor: string; borderSize: number };
      return {
        polygon: {
          color: poly.color ?? dflt.color,
          borderColor: poly.borderColor ?? dflt.borderColor,
          borderSize: poly.borderSize ?? dflt.borderSize,
        },
        priceLabels: extra.priceLabels,
        visibility: extra.visibility,
      };
    }
    return {
      // CONCRETE values, never the overlay's implicit `undefined`s: klinecharts' style
      // merge skips undefined fields, so an undefined size/style would never overwrite
      // a customized line back to the default on "Reset settings" — Reset would revert
      // color but leave a widened line at its custom width. Resolving them also means a
      // default saved from an unstyled drawing is a real config, not a hollow {line:{}}.
      line: {
        color: this.resolveLineColor(live.styles),
        size: line.size ?? 1,
        style: line.style ?? 'solid',
      },
      ...(isFibOverlay(live.name) ? { fib: asFibConfig(extra.fib) } : {}),
      ...(live.name === GHOST_NAME ? { ghostStyle: asGhostStyle(extra.ghostStyle) } : {}),
      ...(isTradeDrawing(live.name) ? { trade: asTradeConfig(extra.trade) } : {}),
      showMiddle: extra.showMiddle,
      priceLabels: extra.priceLabels,
      visibility: extra.visibility,
    };
  }

  // Push a SavedDrawingConfig onto an EXISTING drawing (Reset settings / apply
  // template). Reuses the per-field setters so each persists; never changes the
  // overlay name, so no recreate is needed.
  applyDrawingConfig(id: string, cfg: SavedDrawingConfig): void {
    if (cfg.line) this.setStyle(id, { line: cfg.line } as DeepPartial<OverlayStyle>);
    if (cfg.polygon) this.setStyle(id, { polygon: cfg.polygon } as DeepPartial<OverlayStyle>);
    if (cfg.fib !== undefined) this.setFibConfig(id, cfg.fib);
    if (cfg.ghostStyle !== undefined) this.setGhostStyle(id, cfg.ghostStyle);
    if (cfg.trade !== undefined) this.setTradeConfig(id, cfg.trade);
    if (cfg.showMiddle !== undefined) this.setShowMiddle(id, cfg.showMiddle);
    if (cfg.priceLabels !== undefined) this.setPriceLabels(id, cfg.priceLabels);
    if (cfg.visibility !== undefined) this.setVisibilityModel(id, cfg.visibility);
  }
}
