// Crosshair pointer handlers, peeled out of ChartCore's one-time init effect.
// Two handlers live here:
//
//  1. onMove — the "+" quick-alert affordance + price guide that follows the
//     cursor's price on the right axis (TV-style): hand/grab/ns-resize cursor
//     selection, curve-hover highlight, trade-line hover→dock-row mirror, pill
//     tracking, the alert/trade-line magnet snap, and the native-crosshair
//     suppression while snapped.
//  2. onLeave — clears the "+", snap, curve-hover, trade-hover, and bracket as
//     the cursor leaves the chart.
//
// Both attach their own listeners in this hook's own effect, on the SAME targets
// as the original init effect: onMove on BOTH `wrapRef` and `containerRef` (the
// price-axis strip is a klinecharts DOM element over the wrap, so wrap's
// mousemove stops firing there — the container listener keeps onMove running so
// onAxis can flip true); onLeave on `wrapRef` only. The hook's effect is placed
// AFTER the init effect in ChartCore's source (after useLineDrag), so the chart
// exists when it runs.
//
// Cross-boundary state: every ref/state/callback this code reads stays declared
// at ChartCore component scope (so the staying onClick/redraw keep the same
// identities) and is threaded in via `deps`. Two init-effect-LOCAL functions the
// crosshair calls are reached through bridge refs assigned inside the init effect
// (mirroring D1a's tradeLinePixelsRef): `deps.tradeLinePixelsRef` and
// `deps.alertHitTestRef`. The drag-active bridges `deps.tradeDragActiveRef`
// (read by onMove) / `deps.alertDragActiveRef` (read by onLeave) are assigned by
// useLineDrag's effect and let the crosshair observe an in-flight line drag.
import { useEffect } from "react";
import { DomPosition } from "klinecharts";
import { DRAFT_ID } from "../lib/positionLines";
import { Signal, setTradeHovered, type TradeLineField } from "../lib/signals";
import {
  HIT_TOLERANCE_PX,
  ALERT_SNAP_PX,
  hitTestCache,
  hasPivotAnalysisIndicator,
  buildPivotDeltaLabels,
  pivotDeltaLabelAt,
  type LineCache,
} from "./chartGeometry";
import { first } from "./chartPainters";
import type { SelectedIndicator } from "../lib/chartController";
import type { ChartHandle } from "./chartHandle";
import type { TradeLinePx } from "./useLineDrag";

// A trade pill hit (the always-on entry/SL/TP chip) — id + field of the line the
// cursor is over, as produced by ChartCore's component-scope tradePillHitTest().
type PillHit = { id: string; field: TradeLineField };

export interface PointerCrosshairDeps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  avwapAnchorMode: Signal<string | null>;
  curveHover: Signal<SelectedIndicator | null>;
  ANCHOR_GRAB_PX: number;
  precisionRef: React.MutableRefObject<number>;
  cursorModeRef: React.MutableRefObject<"" | "cur-pointer" | "cur-default" | "cur-grab" | "cur-grabbing" | "cur-ns">;
  draggingAnchorRef: React.MutableRefObject<boolean>;
  anchorPxRef: React.MutableRefObject<{ x: number; y: number; ts: number; color: string } | null>;
  lineCacheRef: React.MutableRefObject<LineCache[]>;
  // Cursor position in container pixels, shared with the paint loop for the
  // Pivots-High/Low Δ-label hover-enlarge pixel hit-test. pivotHoverKeyRef holds
  // the currently-enlarged pivot's identity so a move only repaints on a change.
  pointerPxRef: React.MutableRefObject<{ x: number; y: number } | null>;
  pivotHoverKeyRef: React.MutableRefObject<string | null>;
  plusCrosshairYRef: React.MutableRefObject<number | null>;
  plusBtnRef: React.RefObject<HTMLDivElement | null>;
  plusMenuOpenRef: React.MutableRefObject<boolean>;
  plusPriceRef: React.MutableRefObject<number>;
  plusPriceLabelRef: React.RefObject<HTMLSpanElement | null>;
  cursorXRef: React.MutableRefObject<number>;
  onAxisRef: React.MutableRefObject<boolean>;
  pillNodesRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  hoveredFieldRef: React.MutableRefObject<TradeLineField | null>;
  snapActiveRef: React.MutableRefObject<boolean>;
  snapHoverRef: React.MutableRefObject<string | null>;
  positionPill: (node: HTMLDivElement) => void;
  tradePillHitTest: (clientX: number, clientY: number) => PillHit | null;
  setCursorMode: (m: "" | "cur-pointer" | "cur-default" | "cur-grab" | "cur-grabbing" | "cur-ns") => void;
  setOnAxis: (v: boolean) => void;
  setTradeHovered: typeof setTradeHovered;
  setHoveredPillKey: (v: string | null) => void;
  setFocusedPillKey: (v: string | null) => void;
  // In-direction bridges to init-effect-local functions the crosshair calls.
  tradeLinePixelsRef: React.MutableRefObject<() => TradeLinePx[]>;
  alertHitTestRef: React.MutableRefObject<(x: number, y: number) => string | null>;
  // Out-direction bridges: useLineDrag assigns these; onMove reads tradeDrag, onLeave alertDrag.
  tradeDragActiveRef: React.MutableRefObject<() => boolean>;
  alertDragActiveRef: React.MutableRefObject<() => boolean>;
}

export function usePointerCrosshair(handle: ChartHandle, deps: PointerCrosshairDeps): void {
  const {
    containerRef,
    wrapRef,
    avwapAnchorMode,
    curveHover,
    ANCHOR_GRAB_PX,
    precisionRef,
    cursorModeRef,
    draggingAnchorRef,
    anchorPxRef,
    lineCacheRef,
    pointerPxRef,
    pivotHoverKeyRef,
    plusCrosshairYRef,
    plusBtnRef,
    plusMenuOpenRef,
    plusPriceRef,
    plusPriceLabelRef,
    cursorXRef,
    onAxisRef,
    pillNodesRef,
    hoveredFieldRef,
    snapActiveRef,
    snapHoverRef,
    positionPill,
    tradePillHitTest,
    setCursorMode,
    setOnAxis,
    setTradeHovered,
    setHoveredPillKey,
    setFocusedPillKey,
    tradeLinePixelsRef,
    alertHitTestRef,
    tradeDragActiveRef,
    alertDragActiveRef,
  } = deps;
  const { chartRef, overlays, tradeUiRef } = handle;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const repaint = () => handle.redrawRef.current();

    // Show/move (or clear) our self-drawn horizontal crosshair line, repainting the
    // overlay only when it actually changes so it isn't redrawn every mousemove.
    const setPlusCrosshair = (ny: number | null) => {
      if (plusCrosshairYRef.current !== ny) {
        plusCrosshairYRef.current = ny;
        repaint();
      }
    };

    // Track the cursor pixel for the Pivots-High/Low Δ-label hover-enlarge and
    // repaint only when the pivot under the cursor CHANGES (enter/leave/switch), so
    // the pixel hit-test doesn't force a full redraw on every mousemove. Gated by
    // hasPivotAnalysisIndicator so charts without the indicator never pay for it —
    // the redraw loop reads pointerPxRef and re-hit-tests, so a stationary cursor's
    // plate still stays glued through scroll/zoom/tick.
    const setPointerPx = (px: { x: number; y: number } | null) => {
      pointerPxRef.current = px;
      const c = chartRef.current;
      if (!c || !hasPivotAnalysisIndicator(c)) {
        if (pivotHoverKeyRef.current !== null) {
          pivotHoverKeyRef.current = null;
          repaint();
        }
        return;
      }
      const hit = px ? pivotDeltaLabelAt(buildPivotDeltaLabels(c), px) : null;
      const key = hit ? `${hit.name}:${hit.index}:${hit.side}` : null;
      if (key !== pivotHoverKeyRef.current) {
        pivotHoverKeyRef.current = key;
        repaint();
      }
    };

    // "+" affordance follows the cursor's price on the right axis (TV-style).
    const onMove = (e: MouseEvent) => {
      const c = chartRef.current;
      const btn = plusBtnRef.current;
      if (!c) return;
      if (draggingAnchorRef.current || tradeDragActiveRef.current()) {
        setPointerPx(null); // window listeners drive the drag; drop the Δ-label hover
        return;
      }
      const r = el.getBoundingClientRect();
      const lx = e.clientX - r.left;
      const ly = e.clientY - r.top;
      // Feed the Pivots-High/Low Δ-label hover-enlarge before any of onMove's later
      // early-returns, so parking on a marker/label always registers.
      setPointerPx({ x: lx, y: ly });
      // Legend hover (crosshair-hide + per-row icons/highlight) is now owned by the
      // DOM <ChartLegend> via its own mouse events — nothing to do here.
      // Cursor affordance: hand over a selectable indicator curve, else the chart's
      // crosshair. Driven by a class (klinecharts sets cursor on the canvas itself,
      // beating an inline cursor on an ancestor); updated only on a mode change.
      // A hand cursor over a selectable indicator curve OR a hovered drawing
      // overlay (klinecharts tracks the latter via the overlay's onMouseEnter,
      // mirrored into overlays.hoveredDrawingId). Both signal "click to select".
      // Hit-test the cursor against indicator curves ONCE: drives the hand cursor,
      // the legend-card highlight, AND the curve's selected-mode handles (curveHover).
      // Excludes hovered drawings — a drawing isn't an indicator, so it must not light
      // up a legend. hitTestCache returns a fresh object each call, so compare fields.
      const curveHit = avwapAnchorMode.value
        ? null
        : hitTestCache(lineCacheRef.current, lx, ly);
      const ch = curveHover.value;
      if (ch?.paneId !== curveHit?.paneId || ch?.name !== curveHit?.name) {
        curveHover.set(curveHit);
      }
      const overLine =
        !avwapAnchorMode.value &&
        (!!curveHit || !!overlays.getHoveredDrawingId());
      // Over the AVWAP anchor handle (only painted when AVWAP is selected): a grab
      // cursor signals it's draggable, taking priority over the curve's hand.
      // anchorPxRef is non-null only when an AVWAP instance is selected and on-screen
      // (set in redraw), so its presence already implies "AVWAP selected".
      const a = anchorPxRef.current;
      const overAnchor =
        !avwapAnchorMode.value &&
        !!a &&
        Math.hypot(lx - a.x, ly - a.y) <= ANCHOR_GRAB_PX;
      // Over a trade pill (the always-on entry/SL/TP chip): a hand cursor signals the
      // pill is clickable — a click selects its line. Wins over the line's ns-resize
      // drag cursor within the pill's rect (see the !overTradePillNow gate below).
      // The hit itself also feeds the hover state below, so the pill lift and dock-row
      // highlight agree with the cursor across the whole pill.
      const pillHit = avwapAnchorMode.value ? null : tradePillHitTest(e.clientX, e.clientY);
      const overTradePillNow = pillHit != null;
      const nextCursor = avwapAnchorMode.value
        ? ""
        : overAnchor
          ? "cur-grab"
          : overTradePillNow || overLine
            ? "cur-pointer"
            : "";
      if (nextCursor !== cursorModeRef.current) {
        cursorModeRef.current = nextCursor;
        setCursorMode(nextCursor);
      }
      if (!btn || plusMenuOpenRef.current) return;
      if (avwapAnchorMode.value) {
        btn.style.display = "none"; // don't compete with anchor-placement clicks
        setPlusCrosshair(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Pills follow the cursor while their line is merely hovered (a click-
      // selected line's pill stays frozen so its delete button is reachable). Run
      // this BEFORE the "+"-hover early-return below, so the pill keeps tracking the
      // cursor even while it's parked over the "+" affordance.
      cursorXRef.current = x;
      // Over the price-axis column the pill is hidden entirely (gated in render), so
      // skip repositioning it there; otherwise keep non-selected pills at the cursor.
      const mainW = c.getSize("candle_pane", DomPosition.Main)?.width ?? rect.width;
      const nextOnAxis = x > mainW;
      if (nextOnAxis !== onAxisRef.current) {
        onAxisRef.current = nextOnAxis;
        setOnAxis(nextOnAxis);
      }
      if (!nextOnAxis && pillNodesRef.current.size) {
        const selectedId = overlays.getSelectedAlertId();
        // A pill freezes the instant its line is hovered (same as a click-selected
        // pill) so reaching its delete button is a straight line, not a chase — see
        // registerPill's initial placement above for the one-time position on mount.
        const hoveredId = overlays.getHoveredAlertId();
        for (const [id, node] of pillNodesRef.current) {
          if (id !== selectedId && id !== hoveredId) positionPill(node);
        }
      }
      // This cell's trade lines, resolved to pixel-y ONCE for both the dock-hover
      // mirror just below AND the magnet/snap further down (was built twice/move).
      const tlp = tradeLinePixelsRef.current();
      // Chart -> dock hover: highlight the dock row for the trade line under the
      // cursor (null over the axis or empty space). Mirrors the dock row's own
      // onMouseEnter so hovering a line and hovering a row light up the same pair.
      // The cursor is over EITHER the chart or a dock row at any moment (never
      // both), so this and the row handler never fight over `hovered`.
      let hoverTradeId: string | null = null;
      let hoverField: TradeLineField | null = null;
      if (!nextOnAxis) {
        let bestD = Infinity;
        for (const t of tlp) {
          if (t.id === DRAFT_ID || t.y == null) continue; // the draft has no dock row
          const d = Math.abs(t.y - y);
          if (d <= HIT_TOLERANCE_PX && d < bestD) { bestD = d; hoverTradeId = t.id; hoverField = t.field; }
        }
        // The pill (22px tall) pokes past the line's ±6px band. Inside its rect the
        // hand cursor shows and a click selects, so the hover affordances (pill lift,
        // dock-row highlight) must agree even on the strips the band misses.
        if (!hoverTradeId && pillHit) { hoverTradeId = pillHit.id; hoverField = pillHit.field; }
      }
      hoveredFieldRef.current = hoverField;
      setTradeHovered(hoverTradeId);
      // Hover-lift shadow is scoped to the single line under the cursor, not the trade.
      setHoveredPillKey(hoverTradeId ? `${hoverTradeId}:${hoverField}` : null);
      // Focus for z-order: a selected line wins, else the hovered line. Set here (not only
      // via the signal) so moving between fields of the SAME hovered trade — which doesn't
      // change the signal — still re-tops the pill under the cursor.
      {
        const sel = tradeUiRef.current.selected;
        const fId = sel ?? hoverTradeId;
        const fField = sel != null ? tradeUiRef.current.selectedField : hoverField;
        setFocusedPillKey(fId ? `${fId}:${fField}` : null);
      }
      // Repaint the bracket now that BOTH the cursor x (spine) and the hover gate are
      // current for this move — so parking on a line shows it at once, and leaving the
      // lines (nothing selected) clears it. Cheap: a no-op clear when nothing's active.
      handle.paintBracketRef.current();
      // Over ANY alert line — selected or not — the WHOLE "+" affordance (circle + price
      // box) stays and looks IDENTICAL to a normal hover: the price readout is ALWAYS
      // visible (the box, z-49, reads on top of the never-hidden amber tag), the shape
      // never changes as the cursor crosses a line. We only make it click-THROUGH
      // (`.passthrough` → pointer-events:none) over a line so the mousedown reaches the
      // canvas and selects/drags the line underneath instead of being swallowed by the
      // "+" circle that protrudes into the pane. We union getHoveredAlertId (klinecharts'
      // native onMouseEnter, which can FALSE-NEGATIVE) with a direct alertHitTest so the
      // line is detected in both bands. ONLY EXCEPTION: while DRAGGING a line, hide the
      // affordance entirely (the price box would fight the drag).
      const overAlertId = overlays.getHoveredAlertId() ?? alertHitTestRef.current(x, y);
      // Magnet: the nearest alert line within ALERT_SNAP_PX of the cursor. When set, the
      // price guide snaps onto that line's exact level/y below (so the readout locks to the
      // alert's price and the "+" aligns dead-on the line), and the affordance also goes
      // click-through (so a click there still selects/drags the line under it).
      // Snap targets: alert lines PLUS every trade line (entry/limit, SL, TP for
      // open positions, resting orders, and the staged draft) on this epic — built
      // from the same tradeLineSpecs that draws them, so the magnet locks onto the
      // exact level shown. The price guide snaps to the nearest within ALERT_SNAP_PX.
      // Each target carries whether its line is draggable, so when the crosshair
      // snaps to a draggable one we can show the ns-resize cursor right away (even
      // a few px off the line), matching the on-line hover affordance. Alert lines
      // are draggable; trade lines use their spec's `draggable` (a filled
      // position's entry is not).
      const snapTargets: { y: number; level: number; draggable: boolean; isTrade?: boolean; alertId?: string }[] = [];
      for (const al of overlays.getAlerts()) {
        const ay = first(
          c.convertToPixel([{ value: al.level }], { paneId: "candle_pane", absolute: true }),
        ).y;
        if (ay != null) snapTargets.push({ y: ay, level: al.level, draggable: true, alertId: al.id });
      }
      // Trade lines reuse tlp's already-resolved pixel-y (no re-convert). Hidden,
      // un-revealed lines are absent from tlp, so the magnet won't lock onto them.
      for (const t of tlp) {
        if (t.y != null) snapTargets.push({ y: t.y, level: t.level, draggable: t.draggable, isTrade: true });
      }
      let snapTarget: { y: number; level: number; draggable: boolean; isTrade?: boolean; alertId?: string } | null = null;
      for (const t of snapTargets) {
        if (Math.abs(t.y - y) <= ALERT_SNAP_PX &&
            (snapTarget == null || Math.abs(t.y - y) < Math.abs(snapTarget.y - y))) {
          snapTarget = t;
        }
      }
      // Snapping the crosshair onto an alert line auto-hovers it (emphasis + on-line
      // pill), so the line the guide locked to is immediately the one a press will
      // grab — no waiting for klinecharts' tighter, false-negative-prone onMouseEnter.
      // The magnet band is a superset of that hit band, so the snap can own hover:
      // set it while snapped, clear it on leave (but only the hover WE set, so a
      // sidebar-row hover on a different line is left alone). Skipped mid-drag: the
      // isDraggingAlert guard below returns BEFORE the hover mutation, so a drag past a
      // neighbouring alert can't momentarily emphasise it (and snapTarget here is stale,
      // built from the alert's pre-move y anyway — the alertDrag move drives the real drag).
      if (overlays.isDraggingAlert()) {
        btn.classList.remove("passthrough");
        btn.style.display = "none";
        setPlusCrosshair(null);
        if (snapActiveRef.current) { overlays.setSuppressNativeLine(false); snapActiveRef.current = false; }
        return;
      }
      const snapAlertId = snapTarget && !snapTarget.isTrade ? snapTarget.alertId ?? null : null;
      if (snapAlertId) {
        if (overlays.getHoveredAlertId() !== snapAlertId) overlays.hoverAlert(snapAlertId);
      } else if (snapHoverRef.current && overlays.getHoveredAlertId() === snapHoverRef.current) {
        overlays.hoverAlert(null);
      }
      snapHoverRef.current = snapAlertId;
      // Suppress the klinecharts native horizontal crosshair line while snapping. The
      // native line tracks the cursor's y (a few px off the snapped line), so leaving
      // it on would double the alert/trade line. We DON'T replace it with our own line
      // either (see setPlusCrosshair below) — the alert/trade line is the only guide.
      const nextSnap = snapTarget != null;
      if (nextSnap !== snapActiveRef.current) {
        snapActiveRef.current = nextSnap;
        overlays.setSuppressNativeLine(nextSnap);
      }
      // Snapped to a DRAGGABLE line (within the band, not just on it): show the
      // ns-resize cursor immediately, like the on-line hover affordance. Done via
      // the single-select cursorMode (not a CSS class) so it OVERRIDES the curve-
      // hover "pointer" — dragging a line beats selecting a curve — rather than
      // losing a specificity fight. Off on the axis (x > mainW).
      if (
        snapTarget?.draggable === true &&
        x <= mainW &&
        !overTradePillNow && // the pill's hand cursor wins inside its rect
        (cursorModeRef.current as string) !== "cur-ns"
      ) {
        cursorModeRef.current = "cur-ns";
        setCursorMode("cur-ns");
      }
      btn.classList.toggle("passthrough", overAlertId != null || snapTarget != null);
      // Over a TRADE line (entry/limit, SL, TP, or the staged draft) fully HIDE the
      // "+" price pill — unlike an alert line, which keeps it as a click-through
      // readout, a trade line already carries its own price pill, so a second "+"
      // readout snapped on top just doubles it. The native crosshair line is already
      // suppressed by the snap above, so the trade line stays the sole guide. Alerts
      // still win (keep the passthrough readout) when the cursor is genuinely over
      // one. Union the 6px hover hit (covers open positions/orders) with the 5px snap
      // isTrade flag (also covers the draft, which the hover test skips).
      const overTradeLine = hoverTradeId != null || snapTarget?.isTrade === true;
      if (overTradeLine && overAlertId == null) {
        btn.style.display = "none";
        setPlusCrosshair(null);
        return;
      }
      // Hide the "+" pill the moment the cursor crosses onto the price-axis strip
      // (x > mainW), even when it's over the "+" itself. The axis is a drag/scale
      // gesture zone; a DOM button sitting there with pointer-events:auto would
      // swallow the mousedown and block y-axis scaling. The "+" icon protrudes left
      // of mainW into the candle pane, so it stays reachable while the cursor is in
      // the pane — only the on-axis portion is sacrificed.
      const overPlus = btn.contains(e.target as Node);
      // The "+" is a quick-create PRICE-alert affordance and its price box reads the
      // candle_pane scale — meaningless over a sub-pane (RSI/MACD/Volume), whose y-axis
      // is an indicator value, not a price. Below the candle pane's bottom edge, hide the
      // affordance entirely (like the on-axis guard) so klinecharts' own crosshair label
      // shows that pane's value on its y-axis. Done before any box positioning so crossing
      // the separator never flashes a stale price.
      // klinecharts only populates a pane bounding's `top`/`height` (never `bottom`,
      // which stays 0), so derive the candle pane's bottom edge as top + height.
      const cb = c.getSize("candle_pane", DomPosition.Root);
      const candleBottom = cb ? cb.top + cb.height : null;
      if (x > mainW || (candleBottom != null && y > candleBottom)) {
        btn.style.display = "none";
        setPlusCrosshair(null);
        return;
      }
      // Price comes from the cursor's y (x doesn't affect the value), so it still
      // resolves while the cursor is out over the "+"/axis strip.
      const pt = first(
        c.convertFromPixel([{ y }], { paneId: "candle_pane", absolute: true }),
      );
      if (pt.value == null) return;
      // Snapped onto an alert line: lock the guide to the alert's exact level + y; else
      // it tracks the cursor's price/y as usual.
      const guideY = snapTarget ? snapTarget.y : y;
      const guideVal = snapTarget ? snapTarget.level : pt.value;
      plusPriceRef.current = guideVal;
      if (plusPriceLabelRef.current) {
        plusPriceLabelRef.current.textContent = guideVal.toFixed(precisionRef.current);
        // Size the price box to the y-axis column so the number sits inside the
        // axis and the "+" circle's right edge lands on the column's left border.
        plusPriceLabelRef.current.style.width = `${Math.max(0, rect.width - mainW)}px`;
      }
      // Round so the "+" pill (translateY(-50%), even height) stays crisp.
      btn.style.top = `${Math.round(guideY)}px`;
      btn.style.display = "flex";
      // Over the "+", klinecharts dropped its crosshair; keep our guide alive at the
      // cursor's y. But NOT when snapped onto an alert/trade line: the native line is
      // already suppressed, and drawing ours at the snapped y would sit right on top of
      // that line and read as a doubled/messy line. The alert/trade line is its own
      // guide there, so leave the crosshair line hidden when snapped.
      setPlusCrosshair(overPlus && snapTarget == null ? guideY : null);
    };
    const onLeave = () => {
      setPlusCrosshair(null);
      setPointerPx(null); // drop the Δ-label hover-enlarge as the cursor leaves
      if (snapActiveRef.current) { overlays.setSuppressNativeLine(false); snapActiveRef.current = false; }
      // Drop a snap-driven alert hover as the cursor leaves (klinecharts' own
      // onMouseLeave covers the on-line case; this covers the wider magnet band).
      if (snapHoverRef.current && !alertDragActiveRef.current()) {
        if (overlays.getHoveredAlertId() === snapHoverRef.current) overlays.hoverAlert(null);
        snapHoverRef.current = null;
      }
      // onMove stops firing past the canvas edge, so clear the curve-hover highlight.
      if (curveHover.value !== null) curveHover.set(null);
      // Drop any chart-driven trade-line hover as the cursor leaves the chart. If
      // it's heading for a dock row, that row's onMouseEnter re-sets it (mouseleave
      // here fires before the row's mouseenter), so the highlight lands correctly.
      setTradeHovered(null);
      // Clear a hover-only bracket now that the hover is gone (a SELECTED trade's bracket
      // stays). Runs after setTradeHovered so paintBracket sees the cleared hover.
      handle.paintBracketRef.current();
      if (onAxisRef.current) {
        onAxisRef.current = false;
        setOnAxis(false);
      }
      if (cursorModeRef.current !== "") {
        cursorModeRef.current = "";
        setCursorMode("");
      }
      if (!plusMenuOpenRef.current && plusBtnRef.current) {
        plusBtnRef.current.classList.remove("passthrough");
        plusBtnRef.current.style.display = "none";
      }
    };

    const wrap = wrapRef.current;
    wrap?.addEventListener("mousemove", onMove);
    wrap?.addEventListener("mouseleave", onLeave);
    // The price-axis strip is a klinecharts DOM element that sits over the
    // chart-wrap, so mousemove on wrap stops firing when the cursor slides onto
    // it. We need onMove to keep running there so onAxis can be set to true.
    containerRef.current?.addEventListener("mousemove", onMove);

    return () => {
      wrapRef.current?.removeEventListener("mousemove", onMove);
      wrapRef.current?.removeEventListener("mouseleave", onLeave);
      containerRef.current?.removeEventListener("mousemove", onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
