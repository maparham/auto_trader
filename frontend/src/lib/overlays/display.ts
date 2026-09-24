// How a drawing looks on screen: per-timeframe visibility, the ghost fade,
// hover emphasis, style/lock/text/extend setters and z-order.
import type { Overlay, DeepPartial, OverlayStyle } from "klinecharts";
import type { SavedOverlay } from "../persist";
import { hexToRgba } from "../lineStyle";
import { type VisibilityModel, defaultVisibility, isVisibleOnResolution, barsSpanned } from "../visibility";
import type { FibConfig } from "../fibConfig";
import { type TradeConfig, type TradePoint, normalizeTradePoints } from "../tradePlan";
import { type DrawingExtra, asDrawingExtra, cloneStyles, mergeStyles } from "./shared";
import { OverlayPersistence } from "./persistence";

export abstract class OverlayDisplay extends OverlayPersistence {
  // Touch: a finger must tap a drawing or alert line to select it before it can
  // drag it, so a pan that happens to start on a line can't move it by accident. klinecharts
  // checks `lock` before it lets a press grab an overlay, and an overlay that
  // refuses the press leaves the gesture to the chart's own pan. So ChartCore
  // calls this on a finger's pointerdown (which precedes the touchstart
  // klinecharts hit-tests on) and runs the returned release right after that
  // touchstart. The lock is set on the instance directly, not via
  // overrideOverlay, so nothing repaints; pressHeld remembers each drawing's
  // own flag, which every lock reader here (userLock) reports instead, so the
  // hold is never saved or shown even if the release comes late.
  lockUnselectedForPress(): () => void {
    if (this.chart && this.pressHeld.size === 0) {
      for (const ov of this.chart.getOverlays()) {
        const id = ov.id;
        const kind = this.entries.get(id);
        const selected = kind === "alert" ? this.selectedAlertId : this.selectedDrawingId;
        if (ov.lock || id === selected || (kind !== "drawing" && kind !== "alert")) continue;
        this.pressHeld.set(id, ov.lock);
        (ov as { lock: boolean }).lock = true;
      }
    }
    return () => {
      for (const [id, lock] of this.pressHeld) {
        const ov = this.byId(id) as { lock: boolean } | null;
        if (ov) ov.lock = lock;
      }
      this.pressHeld.clear();
    };
  }
  // Emphasize a drawing from OUTSIDE the chart (a chart-operand picker row hover),
  // thickening its line so the user can spot which on-chart drawing the row is —
  // essential when several same-type drawings share a name/color. `null` clears.
  // Idempotent; only one drawing is emphasized at a time (like hoveredDrawingId).
  hoverDrawing(id: string | null): void {
    if (id === this.emphasizedDrawingId) return;
    if (this.emphasizedDrawingId) this.unemphasizeDrawing(this.emphasizedDrawingId);
    this.emphasizedDrawingId = null;
    this.emphasisBase = undefined;
    if (id) this.emphasizeDrawing(id);
  }
  private emphasizeDrawing(id: string): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.byId(id);
    if (!ov) return;
    // Capture the TRUE base style. `emphasizedDrawingId` is still null here, so
    // canonicalStyles reports the real style — arm the shield only AFTER we have a
    // valid base, so a bail-out above never leaves it pointing at an undefined base.
    const base = this.fadedStyles.has(id) ? this.fadedStyles.get(id) : cloneStyles(ov.styles);
    this.emphasisBase = cloneStyles(base);
    this.emphasizedDrawingId = id;
    // Reconstruct the whole `line` with concrete color+size — overrideOverlay's partial
    // merge is not trusted here (see fade/unfade), so a size-only patch could drop color.
    this.chart?.overrideOverlay({
      id,
      styles: { line: { ...(base?.line ?? {}), color: this.resolveLineColor(base), size: this.resolveLineSize(base) + this.EMPHASIS_EXTRA_SIZE } },
    });
  }
  private unemphasizeDrawing(id: string): void {
    const base = this.emphasisBase;
    this.emphasisBase = undefined;
    this.emphasizedDrawingId = null;
    const ov = this.byId(id);
    if (!ov) return;
    // Write the concrete base line back (never omit — same reason as unfade).
    this.chart?.overrideOverlay({
      id,
      styles: { line: { ...(base?.line ?? {}), color: this.resolveLineColor(base), size: this.resolveLineSize(base) } },
    });
    // A currently-faded (ghost) drawing must return to its faint render; re-run the
    // display decision to re-apply the fade over the restored size.
    if (this.fadedStyles.has(id)) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
  }
  // Live snapshot of a drawing (for copy / clone / the settings modal). Returns the
  // stable anchors + styles + name, by VALUE — safe to stash in a clipboard.
  getDrawing(id: string): {
    name: string;
    points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>;
    styles: DeepPartial<OverlayStyle> | null;
    lock: boolean;
    visible: boolean;
    zLevel: number;
    extendData: unknown;
  } | null {
    const ov = this.byId(id);
    if (!ov || this.entries.get(id) !== "drawing") return null;
    return {
      name: ov.name,
      // Keep dataIndex: a point past the last candle has NO timestamp (klinecharts'
      // dataIndexToTimestamp returns null beyond the data) and renders x from
      // dataIndex alone — dropping it teleports the anchor to x=0 (left edge) on
      // any recreate (setExtend / clone / paste / modal Cancel).
      points: (ov.points ?? []).map((p) => ({ timestamp: p.timestamp, value: p.value, dataIndex: p.dataIndex })),
      styles: this.canonicalStyles(id, ov) ?? null,
      lock: !!this.userLock(id, ov),
      // INTENT, not the live (effective) flag — the overlay's `visible` is the
      // interval-filtered render state, but the checkbox + clone/paste/setExtend
      // all want what the user chose. See effectiveVisible / userVisible.
      visible: asDrawingExtra(ov.extendData).userVisible ?? true,
      zLevel: ov.zLevel ?? 0,
      extendData: ov.extendData,
    };
  }
  /** Every straight-line drawing on this cell as { id, name, points, text, color } —
   * the source for the chart-operand picker. `text` is the user's custom label (so
   * two same-type drawings are distinguishable) and `color` is the CANONICAL (unfaded)
   * line color (so the picker swatch matches the chart even while a line is ghosted).
   * Excludes alerts and transient overlays (measure/rangeBand/slope). Points are by
   * value; safe to snapshot. */
  listDrawings(): Array<{ id: string; name: string; points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>; text?: string; color: string }> {
    const out: Array<{ id: string; name: string; points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>; text?: string; color: string }> = [];
    if (!this.chart) return out;
    for (const [id, kind] of this.entries) {
      if (kind !== "drawing") continue;
      const ov = this.byId(id);
      if (!ov) continue;
      const text = asDrawingExtra(ov.extendData).text?.trim() || undefined;
      const color = this.drawingLineColor(id, ov);
      out.push({ id, name: ov.name, points: ov.points, text, color });
    }
    return out;
  }
  // Effective on-chart visibility = user intent AND the current interval is allowed AND
  // (auto-hide off OR the drawing spans >= minBars at the current resolution). Intent
  // and the model live in extendData so persist() reads intent without the filter
  // corrupting it. `pts` are the overlay's anchor points (for the bar-span check).
  protected effectiveVisible(
    extra: DrawingExtra,
    pts?: ReadonlyArray<{ timestamp?: number }>,
  ): boolean {
    const intent = extra.userVisible ?? true;
    const model = extra.visibility ?? defaultVisibility();
    if (!(intent && isVisibleOnResolution(model, this.resolution))) return false;
    if (model.autoHide.on && pts && pts.length >= 2) {
      const ts = pts.map((p) => p.timestamp ?? NaN).filter((n) => Number.isFinite(n));
      if (ts.length >= 2) {
        const span = barsSpanned(Math.min(...ts), Math.max(...ts), this.resolution);
        if (span < model.autoHide.minBars) return false;
      }
    }
    return true;
  }

  // Split the visibility decision into render + fade:
  //   visible:false        — the user turned it off (Show on chart unchecked) → fully
  //                          hidden, same as before.
  //   { visible, faded }   — interval/auto-hide says hide but the user wants it on →
  //                          stay rendered, but faded (ghost), so it's still clickable
  //                          to reopen its settings and undo the filter (there's no
  //                          object-list panel to find it otherwise).
  private displayFor(
    extra: DrawingExtra,
    pts?: ReadonlyArray<{ timestamp?: number }>,
  ): { visible: boolean; faded: boolean } {
    if (this.drawingsHidden) return { visible: false, faded: false }; // master eye off
    const intent = extra.userVisible ?? true;
    if (!intent) return { visible: false, faded: false };
    const effective = this.effectiveVisible({ ...extra, userVisible: true }, pts);
    return { visible: true, faded: !effective };
  }

  private readonly GHOST_OPACITY = 0.18;
  // Fallback line color when a drawing carries no explicit override. klinecharts
  // itself leaves a never-customized overlay's `.styles` as `{}` (verified against
  // its source: OverlayImp only resolves concrete colors at PAINT time, merging
  // `getDefaultOverlayStyle()` in) — so `line.color` can legitimately be absent here
  // (see hexToRgba/fade/unfade). This mirrors that same default (getDefaultOverlayStyle's
  // line.color, klinecharts ^9.8) so a restored default-colored drawing matches what it
  // looked like before it was ever faded, not an arbitrary blue.
  private readonly DEFAULT_LINE_COLOR = "#1677FF";
  // klinecharts' default overlay line.size (getDefaultOverlayStyle, ^9.8) — the
  // effective width of a drawing left at its default, which its `.styles` omits (only
  // resolved at paint). Emphasis writes a CONCRETE size, so it needs this fallback,
  // exactly as resolveLineColor needs DEFAULT_LINE_COLOR.
  private readonly DEFAULT_LINE_SIZE = 1;
  // Extra px added to a drawing's line width while it's picker-hovered.
  private readonly EMPHASIS_EXTRA_SIZE = 2;

  protected resolveLineColor(styles: DeepPartial<OverlayStyle> | null | undefined): string {
    return (styles?.line as { color?: string } | undefined)?.color ?? this.DEFAULT_LINE_COLOR;
  }
  private resolveLineSize(styles: DeepPartial<OverlayStyle> | null | undefined): number {
    return (styles?.line as { size?: number } | undefined)?.size ?? this.DEFAULT_LINE_SIZE;
  }
  // The drawing's CANONICAL (unfaded) line color WITHOUT cloning its whole style tree —
  // for the operand-picker swatch, read once per drawing per picker-open. Mirrors
  // canonicalStyles' precedence (ghost stash > live) but returns just the color string.
  private drawingLineColor(id: string, ov: Overlay): string {
    if (this.fadedStyles.has(id)) return this.resolveLineColor(this.fadedStyles.get(id));
    return this.resolveLineColor(ov.styles);
  }

  // Reduce a style's line color opacity to GHOST_OPACITY without losing its hue.
  private fade(styles: DeepPartial<OverlayStyle> | null | undefined): DeepPartial<OverlayStyle> {
    const lineColor = this.resolveLineColor(styles);
    return { line: { ...(styles?.line ?? {}), color: hexToRgba(lineColor, this.GHOST_OPACITY) } };
  }

  // Inverse of fade(): write back a CONCRETE resolved color (never omit it), so
  // restoring is not at the mercy of whether overrideOverlay deep-merges or replaces
  // `styles`, and works even when the canonical style never had an explicit
  // `line.color` (the common case — a drawing left at its default color). Persisted
  // styles (fadedStyles / SavedOverlay) still keep the ORIGINAL canonical value
  // as-is — this only concerns the live, on-chart override.
  private unfade(styles: DeepPartial<OverlayStyle> | null | undefined): DeepPartial<OverlayStyle> {
    return { line: { ...(styles?.line ?? {}), color: this.resolveLineColor(styles) } };
  }

  // Apply the visible/faded decision for one drawing to the live overlay, keeping
  // `fadedStyles` in sync so persist() always has the canonical style on hand.
  protected applyDisplay(id: string, ov: Overlay, extra: DrawingExtra): void {
    const { visible, faded } = this.displayFor(extra, ov.points);
    const wasFaded = this.fadedStyles.has(id);
    if (!visible) {
      // Restore the canonical (concrete-color) style before hiding (if this id was
      // mid-ghost), so a stray read of ov.styles — including persist() — never sees
      // the faded color.
      const canonical = this.fadedStyles.get(id);
      this.fadedStyles.delete(id);
      this.chart?.overrideOverlay({
        id,
        extendData: extra,
        visible: false,
        ...(wasFaded ? { styles: this.unfade(canonical) } : {}),
      });
      return;
    }
    if (faded) {
      // Stash the canonical (unfaded) styles ONCE so persist() never saves the ghost.
      // Read via canonicalStyles, NOT raw ov.styles: if this drawing is picker-hovered
      // right now its live `ov.styles` carries the transient +2px emphasis, and stashing
      // that would bake the thick size in as "canonical" permanently. canonicalStyles
      // returns the real pre-emphasis style (emphasisBase) in that case, ov.styles
      // otherwise. Clone so fadedStyles never aliases emphasisBase or the live object
      // (klinecharts mutates `ov.styles` in place on overrideOverlay).
      if (!wasFaded) this.fadedStyles.set(id, cloneStyles(this.canonicalStyles(id, ov)));
      const canonical = this.fadedStyles.get(id);
      this.chart?.overrideOverlay({
        id,
        extendData: extra,
        visible: true,
        styles: this.fade(canonical),
      });
    } else if (wasFaded) {
      // Restore the canonical (concrete-color) style — write it back explicitly so
      // the un-fade doesn't depend on overrideOverlay's styles merge semantics.
      const canonical = this.fadedStyles.get(id);
      this.fadedStyles.delete(id);
      this.chart?.overrideOverlay({ id, extendData: extra, visible: true, styles: this.unfade(canonical) });
    } else {
      // Never faded — just keep extendData/visible in sync, styles untouched.
      this.chart?.overrideOverlay({ id, extendData: extra, visible: true });
    }
  }

  setVisible(id: string, visible: boolean): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.byId(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), userVisible: visible };
    this.applyDisplay(id, ov, extra);
    this.persist();
  }

  // The per-timeframe visibility model for a drawing (TV Visibility tab).
  setVisibilityModel(id: string, model: VisibilityModel): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.byId(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), visibility: model };
    this.applyDisplay(id, ov, extra);
    this.persist();
  }

  // Toggle the built-in y-axis price tag(s) for a drawing. klinecharts gates these
  // on the overlay's needDefaultYAxisFigure flag, which overrideOverlay accepts at
  // runtime (no recreate). Persisted via extendData.priceLabels so rehydrate can
  // restore it (the flag itself is not in SavedOverlay).
  setPriceLabels(id: string, on: boolean): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.byId(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), priceLabels: on };
    this.chart?.overrideOverlay({ id, extendData: extra, needDefaultYAxisFigure: on });
    this.persist();
  }

  // Set a drawing's text label (custom-overlay feature). Stored on extendData;
  // the overridden trend-line createPointFigures reads it. overrideOverlay
  // re-invokes createPointFigures (verified), so this repaints live.
  setText(id: string, text: string): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.byId(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), text };
    this.chart?.overrideOverlay({ id, extendData: extra });
    this.persist();
  }

  // Toggle the midpoint marker (custom-overlay feature). Same extendData path.
  setShowMiddle(id: string, on: boolean): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.byId(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), showMiddle: on };
    this.chart?.overrideOverlay({ id, extendData: extra });
    this.persist();
  }

  // Replace a fib drawing's level/extend/… config (custom-overlay feature). Same
  // extendData path as setText — overrideOverlay re-invokes createPointFigures.
  setFibConfig(id: string, fib: FibConfig): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.byId(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), fib };
    this.chart?.overrideOverlay({ id, extendData: extra });
    this.persist();
  }

  // Replace a trade drawing's label/account config (custom-overlay feature).
  // Same extendData path as setFibConfig — overrideOverlay re-invokes
  // createPointFigures, so the pills redraw immediately.
  setTradeConfig(id: string, trade: TradeConfig): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.byId(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), trade };
    this.chart?.overrideOverlay({ id, extendData: extra });
    this.persist();
  }

  // Record the chart's current resolution and re-derive every drawing's effective
  // visibility against it. A VIEW reaction, not a user edit — so it does NOT
  // persist (persist samples intent from extendData, untouched here).
  // CAUTION — not for production interval changes: this does NOT re-materialize
  // future-anchored points, so calling it on a timeframe switch leaves their
  // dataIndex encoded with the OLD bar width and the next persist() writes that
  // drift to storage. Interval changes must go through rehydrate(resolution).
  // Kept as the seam for exercising in-place interval-visibility transitions
  // (fade/ghost) on EXISTING overlays, which rehydrate (a full rebuild) can't.
  setResolution(resolution: string): void {
    this.resolution = resolution;
    this.applyIntervalVisibility();
  }
  protected applyIntervalVisibility(): void {
    if (!this.chart) return;
    for (const [id, kind] of this.entries) {
      if (kind !== "drawing") continue;
      const ov = this.byId(id);
      if (!ov) continue;
      this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
    }
  }

  setLock(id: string, lock: boolean): void {
    this.pressHeld.delete(id); // a real lock outlives a press hold
    this.chart?.overrideOverlay({ id, lock });
    this.persist();
  }

  // Move a drawing's anchor points (Coordinates tab). Points are {timestamp,value}.
  updatePoints(id: string, points: SavedOverlay["points"]): void {
    if (this.entries.get(id) !== "drawing") return;
    let next = points;
    // A trade's invariants (one right edge, zones on opposite sides of the
    // entry) are enforced by the drag handlers for pointer moves — numeric
    // edits arriving here must pass through the same normalization or the
    // Coordinates tab can persist geometry every drag handler assumes
    // impossible.
    if (this.byId(id)?.name === "tradeBox") {
      const fixed = normalizeTradePoints(points as TradePoint[]);
      if (fixed) next = fixed as SavedOverlay["points"];
    }
    this.chart?.overrideOverlay({ id, points: next as Overlay["points"] });
    this.persist();
  }

  // Stash arbitrary per-drawing config (middle-point flag, text, etc.) used by
  // custom figure rendering. Stored on the overlay and persisted.
  setExtendData(id: string, extendData: unknown): void {
    if (this.entries.get(id) !== "drawing") return;
    this.chart?.overrideOverlay({ id, extendData });
    this.persist();
  }

  // Visual order: among DRAWINGS only, push this one above all others / below all.
  // klinecharts paints higher zLevel last (on top). Alerts keep their own band.
  bringToFront(id: string): void {
    if (!this.chart || this.entries.get(id) !== "drawing") return;
    let max = 0;
    for (const [oid, kind] of this.entries) {
      if (kind !== "drawing") continue;
      max = Math.max(max, this.byId(oid)?.zLevel ?? 0);
    }
    this.chart.overrideOverlay({ id, zLevel: max + 1 });
    this.persist();
  }
  sendToBack(id: string): void {
    if (!this.chart || this.entries.get(id) !== "drawing") return;
    let min = 0;
    for (const [oid, kind] of this.entries) {
      if (kind !== "drawing") continue;
      min = Math.min(min, this.byId(oid)?.zLevel ?? 0);
    }
    this.chart.overrideOverlay({ id, zLevel: min - 1 });
    this.persist();
  }

  // "Extend" a trend line (TV: none | one side | both). klinecharts has no
  // extend flag and ignores overrideOverlay({name}) (verified), so we map extend to
  // the equivalent built-in: segment (no extend) / rayLine (one side) / straightLine
  // (both). Implemented as remove + recreate preserving points/styles → a NEW id,
  // which the caller (modal) must adopt. Only the trend-line family is convertible;
  // returns the SAME id (no-op) for any other overlay.
  setExtend(id: string, mode: "none" | "ray" | "both"): string | null {
    if (!this.chart || this.entries.get(id) !== "drawing") return id;
    const ov = this.byId(id);
    if (!ov) return id;
    const TREND = new Set(["segment", "rayLine", "straightLine"]);
    if (!TREND.has(ov.name)) return id; // not a convertible trend line
    const target = mode === "none" ? "segment" : mode === "ray" ? "rayLine" : "straightLine";
    if (target === ov.name) return id;
    return this.renameDrawing(id, ov, target);
  }

  // Move a drawing to a DIFFERENT klinecharts overlay name, keeping everything
  // else (points, canonical style, lock, z, extendData). klinecharts has no
  // rename, so this is a remove + recreate and the id changes — which is why
  // callers that hold an id either take the returned one (setExtend) or announce
  // the remap (the trade-direction flip). Returns the new id, or null if the
  // recreate failed.
  private renameDrawing(id: string, ov: Overlay, name: string): string | null {
    const spec = {
      points: (ov.points ?? []).map((p) => ({ timestamp: p.timestamp, value: p.value, dataIndex: p.dataIndex })),
      // The CANONICAL style, never the faded ghost color — the recreated overlay must
      // look identical to the (possibly currently-ghosted) original, not bake the fade
      // in as if it were the real one (see canonicalStyles/fadedStyles).
      styles: this.canonicalStyles(id, ov) ?? null,
      lock: !!this.userLock(id, ov),
      zLevel: ov.zLevel ?? 0,
      extendData: ov.extendData,
    };
    // Remove + recreate under the hydrating guard so the transient remove doesn't
    // persist an empty intermediate state; persist once after.
    const newId = this.guarded(() => {
      this.chart!.removeOverlay({ id }); // onRemoved drops entries + any stashed fadedStyles
      this.entries.delete(id);
      return this.create("drawing", name, spec.points, spec.styles, spec.lock, {
        zLevel: spec.zLevel,
        extendData: spec.extendData,
      });
    });
    if (newId) {
      // Re-derive visible/faded for the new id from the current resolution (rather
      // than carrying over the OLD overlay's live `visible`/style verbatim) so a
      // ghosted drawing extends as a ghost, not a solid one.
      const newOv = this.byId(newId);
      if (newOv) this.applyDisplay(newId, newOv, asDrawingExtra(newOv.extendData));
      this.selectedDrawingId = newId;
      this.persist();
      this.notifyDrawing();
    }
    return newId;
  }

  clearDrawings(): void {
    for (const [id, kind] of this.entries) {
      if (kind === "drawing") this.chart?.removeOverlay({ id });
    }
  }

  // Sidebar eye: hide/show every drawing at once (session-only; per-drawing
  // intent and persistence are untouched — see displayFor).
  setDrawingsHidden(hidden: boolean): void {
    if (this.drawingsHidden === hidden) return;
    this.drawingsHidden = hidden;
    for (const [id, kind] of this.entries) {
      if (kind !== "drawing") continue;
      const ov = this.byId(id);
      if (ov) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
    }
  }

  // Sidebar padlock: lock every drawing (alerts and the measure ruler are not
  // drawings and stay interactive). Persisted via SavedOverlay.lock.
  lockAllDrawings(): void {
    this.pressHeld.clear();
    for (const [id, kind] of this.entries) {
      if (kind === "drawing") this.chart?.overrideOverlay({ id, lock: true });
    }
    this.persist();
  }

  // ANY (not all) locked: the sidebar padlock unlocks when at least one drawing is
  // locked, so it keeps the old one-click "unlock all" escape hatch — a mixed state
  // must never silently lock (and persist) everything the user left unlocked.
  anyDrawingsLocked(): boolean {
    for (const [id, kind] of this.entries) {
      const ov = kind === "drawing" ? this.byId(id) : null;
      if (ov && this.userLock(id, ov)) return true;
    }
    return false;
  }

  unlockAll(): void {
    this.pressHeld.clear();
    for (const id of this.entries.keys()) {
      this.chart?.overrideOverlay({ id, lock: false });
    }
    this.persist();
  }

  // The Style tab's handler (DrawingSettings.tsx) — reachable by clicking a ghost to
  // reopen its settings, so this MUST interact correctly with fadedStyles: writing the
  // patch straight onto the live overlay (as if it were always solid) would corrupt a
  // ghost's fade, and canonicalStyles() would still return the stale pre-edit stash on
  // the persist() this method itself triggers, silently discarding the user's edit. If
  // this id is currently ghosted, fold the patch into the stash instead — it becomes
  // the new canonical (persists correctly, survives un-ghosting later) — then replay
  // applyDisplay so the live overlay repaints faded using the NEW color.
  setStyle(id: string, styles: DeepPartial<OverlayStyle>): void {
    if (this.fadedStyles.has(id)) {
      this.fadedStyles.set(id, mergeStyles(this.fadedStyles.get(id), styles));
      const ov = this.byId(id);
      if (ov) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
    } else {
      this.chart?.overrideOverlay({ id, styles });
    }
    this.persist();
  }
}
