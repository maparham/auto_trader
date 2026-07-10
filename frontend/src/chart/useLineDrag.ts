// Horizontal price-line drag engine, peeled out of ChartCore's one-time init
// effect. Two gestures live here:
//
//  1. The AVWAP anchor drag — when AVWAP is selected and the cursor presses on
//     its anchor handle, steal the gesture from klinecharts (capture-phase
//     stopPropagation, so its pan never starts) and re-anchor on each move.
//  2. The manual horizontal-line drag (trade SL/TP/entry + alert lines) — a
//     press anywhere the ns-resize band shows grabs the nearest draggable line
//     on the FIRST press, selected or not, and drives the drag ourselves.
//
// Both attach their own listeners in this hook's own effect, in the SAME order
// and on the SAME targets (window for the move/up pair, `el` capture-phase for
// the two mousedowns) as the original init effect. The hook's effect is placed
// AFTER the init effect in ChartCore's source, so `onAnchorDown`/`onLineDown`
// still attach LAST among the capture-phase mousedowns (after rangePick /
// measure / slope / clone / axis), preserving the "measure/rangePick sees the
// press first" precedence.
//
// Cross-boundary state: every ref this code reads/writes stays declared at
// ChartCore component scope (so the staying crosshair `onMove`/`onClick`/
// `onLeave` keep the same identities) and is threaded in via `deps`. Two
// out-direction bridges let the staying crosshair handlers observe an in-flight
// drag: `deps.tradeDragActiveRef`/`deps.alertDragActiveRef` are assigned inside
// this hook's effect and read by `onMove`/`onLeave`. `deps.tradeLinePixelsRef`
// is the in-direction bridge to the init-effect-local `tradeLinePixels()` that
// three staying readers share.
import { useEffect } from "react";
import { type Chart, DomPosition, type Indicator } from "klinecharts";
import { DRAFT_ID } from "../lib/positionLines";
import {
  draggingLineSignal,
  pendingEditsSignal,
  draftOrderSignal,
  tradePanelOpen,
  setTradeSelected,
  Signal,
  type TradeLineField,
} from "../lib/signals";
import { saveAvwapAnchor } from "../lib/persist";
import { ALERT_SNAP_PX, selectedAvwapId } from "./chartGeometry";
import { first } from "./chartPainters";
import { clampLevelToPrice, getLivePrice } from "../lib/trading";
import type { SelectedIndicator } from "../lib/chartController";
import type { OverlayManager } from "../lib/overlays";
import type { ChartHandle } from "./chartHandle";

// A trade line resolved to a pixel-y, as produced by the init-effect-local
// tradeLinePixels(); the grab test only needs id/field/draggable/y.
export type TradeLinePx = {
  id: string;
  field: TradeLineField;
  level: number;
  draggable: boolean;
  y: number | undefined;
  restKind: "bar" | "stub" | "full";
  entryTs: number | undefined;
  emphasized: boolean;
};

export interface LineDragDeps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  scope: string;
  avwapAnchorMode: Signal<string | null>;
  measureArmed: Signal<boolean>;
  slopeArmed: Signal<boolean>;
  selectedIndicator: Signal<SelectedIndicator | null>;
  overlays: OverlayManager;
  ANCHOR_GRAB_PX: number;
  precisionRef: React.MutableRefObject<number>;
  confirmLineEditsRef: React.MutableRefObject<boolean>;
  cursorModeRef: React.MutableRefObject<"" | "cur-pointer" | "cur-default" | "cur-grab" | "cur-grabbing" | "cur-ns">;
  draggingAnchorRef: React.MutableRefObject<boolean>;
  dragMovedRef: React.MutableRefObject<boolean>;
  justDraggedRef: React.MutableRefObject<boolean>;
  anchorPxRef: React.MutableRefObject<{ x: number; y: number; ts: number; color: string } | null>;
  pendingAnchorXRef: React.MutableRefObject<number>;
  anchorRafRef: React.MutableRefObject<number>;
  draggingTradeRef: React.MutableRefObject<string | null>;
  setCursorMode: (m: "" | "cur-pointer" | "cur-default" | "cur-grab" | "cur-grabbing" | "cur-ns") => void;
  setTradeSelectedFn: typeof setTradeSelected;
  // In-direction bridge: the init-effect-local tradeLinePixels() (three staying readers).
  tradeLinePixelsRef: React.MutableRefObject<() => TradeLinePx[]>;
  // Out-direction bridges: staying onMove (tradeDrag) / onLeave (alertDrag) read these.
  tradeDragActiveRef: React.MutableRefObject<() => boolean>;
  alertDragActiveRef: React.MutableRefObject<() => boolean>;
}

export function useLineDrag(handle: ChartHandle, deps: LineDragDeps): void {
  const {
    containerRef,
    scope,
    avwapAnchorMode,
    measureArmed,
    slopeArmed,
    selectedIndicator,
    overlays,
    ANCHOR_GRAB_PX,
    precisionRef,
    confirmLineEditsRef,
    cursorModeRef,
    draggingAnchorRef,
    dragMovedRef,
    justDraggedRef,
    anchorPxRef,
    pendingAnchorXRef,
    anchorRafRef,
    draggingTradeRef,
    setCursorMode,
    setTradeSelectedFn,
    tradeLinePixelsRef,
    tradeDragActiveRef,
    alertDragActiveRef,
  } = deps;
  const { chartRef, tradesRef, epicRef } = handle;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const repaint = () => handle.redrawRef.current();

    // AVWAP anchor drag. When AVWAP is selected and the cursor presses on its
    // anchor handle, we steal the gesture from klinecharts (capture-phase
    // stopPropagation, so its mousedown — and thus chart panning — never starts)
    // and re-anchor on each move. Persist on release.
    const onAnchorMove = (ev: MouseEvent) => {
      if (!draggingAnchorRef.current) return;
      dragMovedRef.current = true;
      const r = el.getBoundingClientRect();
      pendingAnchorXRef.current = ev.clientX - r.left;
      if (anchorRafRef.current) return; // coalesce to one recalc per frame
      anchorRafRef.current = requestAnimationFrame(() => {
        anchorRafRef.current = 0;
        const c = chartRef.current;
        if (!c || !draggingAnchorRef.current) return;
        const pt = first(
          c.convertFromPixel([{ x: pendingAnchorXRef.current }], {
            paneId: "candle_pane",
            absolute: true,
          }),
        );
        if (typeof pt.timestamp !== "number") return;
        const id = selectedAvwapId(c, selectedIndicator.value);
        if (!id) return;
        c.overrideIndicator({ name: id, calcParams: [pt.timestamp] });
        repaint();
      });
    };
    const onAnchorUp = () => {
      if (!draggingAnchorRef.current) return;
      draggingAnchorRef.current = false;
      if (anchorRafRef.current) {
        cancelAnimationFrame(anchorRafRef.current);
        anchorRafRef.current = 0;
      }
      window.removeEventListener("mousemove", onAnchorMove);
      window.removeEventListener("mouseup", onAnchorUp, true);
      const c = chartRef.current;
      const id = c ? selectedAvwapId(c, selectedIndicator.value) : null;
      const ind = id
        ? (c?.getIndicatorByPaneId("candle_pane", id) as Indicator | null | undefined)
        : null;
      const ts = Number(ind?.calcParams?.[0]) || 0;
      if (id && ts > 0) saveAvwapAnchor(scope, epicRef.current, id, ts);
      // A real drag must not also fire the click→deselect that follows mouseup.
      // The synthesized click (if any) consumes this synchronously; the timeout
      // self-clears it when the release was OFF the chart (toolbar/legend), where
      // no click is synthesized — so the flag can't get stuck and swallow a later
      // legitimate click.
      if (dragMovedRef.current) {
        justDraggedRef.current = true;
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 0);
      }
      if (cursorModeRef.current === "cur-grabbing") {
        cursorModeRef.current = "cur-grab";
        setCursorMode("cur-grab");
      }
    };
    const onAnchorDown = (e: MouseEvent) => {
      if (e.button !== 0 || avwapAnchorMode.value) return;
      if (measureArmed.value || overlays.isMeasureDrawing()) return; // placing a measure anchor
      if (slopeArmed.value || overlays.isSlopeDrawing()) return; // placing a slope anchor
      const c0 = chartRef.current;
      if (!c0 || !selectedAvwapId(c0, selectedIndicator.value)) return;
      const a = anchorPxRef.current;
      if (!a) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (Math.hypot(x - a.x, y - a.y) > ANCHOR_GRAB_PX) return;
      // Grab it: block klinecharts' pan and begin dragging the anchor.
      e.preventDefault();
      e.stopPropagation();
      draggingAnchorRef.current = true;
      dragMovedRef.current = false;
      justDraggedRef.current = false; // fresh gesture
      cursorModeRef.current = "cur-grabbing";
      setCursorMode("cur-grabbing");
      window.addEventListener("mousemove", onAnchorMove);
      window.addEventListener("mouseup", onAnchorUp, true);
    };

    // --- Manual horizontal-line drag (trade SL/TP/entry + alert lines) ---
    // klinecharts only drags these overlays once they're already selected (a first press
    // on an unselected line reads as a click), so we drive the drag ourselves: a press
    // anywhere the ns-resize cursor shows grabs the nearest draggable line on the FIRST
    // press, selected or not. Both line kinds share one state machine (makeLineDrag) and
    // differ only in three seams: what it grabs (`grab`), what a move does (`onMove`), and
    // what a release does (`onCommit`). The shared plumbing — first-move detection, the
    // y→price convert, the window listener add/remove pairing, and the justDraggedRef
    // trailing-click swallow — lives in one place. A press hands the gesture to whichever
    // kind has the GLOBALLY nearest line (the registry below), so a nearer alert beats a
    // farther trade and vice-versa.
    type LineHit = { d: number }; // pixel distance from the press to the line it found
    type LineGrab = { d: number; begin: () => void }; // a found line, ready to start dragging
    type LineDrag = {
      // Probe for the nearest grabbable line of this kind at pixel y; null if none in band.
      tryGrab: (yPix: number) => LineGrab | null;
      isActive: () => boolean; // a drag of this kind is in flight (window listeners live)
      dispose: () => void; // drop window listeners NOW (unmount mid-drag; teardown can't
      // wait for onUp, which fires on window and may never come if the cell is gone)
    };
    // One drag state machine. `grab(y)` returns the kind's nearest hit (with its pixel
    // distance `d`); `onMove(hit, level)` is fed the price at the cursor's y on each move
    // after the first; `onBegin(hit)` runs once on that first move; `onCommit(hit, moved)`
    // runs on release and returns whether to swallow the trailing click.
    const makeLineDrag = <H extends LineHit>(spec: {
      grab: (yPix: number) => H | null;
      onBegin?: (hit: H) => void;
      onMove: (hit: H, level: number, chart: Chart) => void;
      onCommit: (hit: H, moved: boolean) => boolean;
      // Tear down an IN-FLIGHT drag's transient side-effects without committing it —
      // run from dispose() on unmount-mid-drag, where onCommit must NOT fire (no
      // persist/select on a dying cell), but a begin-side-effect on a GLOBAL signal
      // would otherwise stick true forever.
      onAbort?: (hit: H) => void;
    }): LineDrag => {
      let active: H | null = null;
      let moved = false;
      const onMove = (ev: MouseEvent) => {
        const c = chartRef.current;
        if (!active || !c) return;
        const r = el.getBoundingClientRect();
        const pt = first(
          c.convertFromPixel([{ y: ev.clientY - r.top }], { paneId: "candle_pane", absolute: true }),
        );
        if (pt.value == null) return;
        if (!moved) {
          moved = true;
          spec.onBegin?.(active);
        }
        spec.onMove(active, pt.value, c);
      };
      const onUp = () => {
        const hit = active;
        if (!hit) return;
        active = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp, true);
        if (spec.onCommit(hit, moved)) {
          // Swallow the trailing click so it can't undo what the release just did. The
          // synthesized click (if any) consumes this synchronously; the timeout self-
          // clears it when the release was OFF the chart (where no click fires), so the
          // flag can't get stuck and swallow a later legitimate click.
          justDraggedRef.current = true;
          setTimeout(() => { justDraggedRef.current = false; }, 0);
        }
      };
      const start = (hit: H) => {
        active = hit;
        moved = false;
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp, true);
      };
      return {
        tryGrab: (yPix) => {
          const hit = spec.grab(yPix);
          return hit ? { d: hit.d, begin: () => start(hit) } : null;
        },
        isActive: () => active != null,
        dispose: () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp, true);
          if (active) spec.onAbort?.(active); // drop an in-flight drag's transient state
          active = null;
        },
      };
    };

    // Trade lines (SL / TP / order-entry, plus a staged limit's draft entry/SL/TP).
    // Nearest DRAGGABLE line within ALERT_SNAP_PX of pixel y — the same band that shows
    // the ns-resize cursor. onMove routes a DRAFT_ID drag to the draft order instead of a
    // server-trade pending edit.
    const grabbableTradeLine = (yPix: number): { id: string; field: TradeLineField; d: number } | null => {
      let best: { id: string; field: TradeLineField; d: number } | null = null;
      for (const t of tradeLinePixelsRef.current()) {
        if (!t.draggable || t.y == null) continue;
        const d = Math.abs(t.y - yPix);
        if (d <= ALERT_SNAP_PX && (!best || d < best.d)) best = { id: t.id, field: t.field, d };
      }
      return best;
    };
    const tradeDrag = makeLineDrag<{ id: string; field: TradeLineField; d: number }>({
      grab: grabbableTradeLine,
      onBegin: () => draggingLineSignal.set(true), // pause no-confirm auto-apply until the drop
      onMove: (hit, value, c) => {
        let level = Number(value.toFixed(precisionRef.current));
        // Reveal this trade's lines full-width for the duration of the drag (below,
        // drawPositions reads draggingTradeRef) so a stub SL/TP doesn't jump mid-drag.
        // Draft lines are already full-width, so skip the reveal bookkeeping for them.
        if (hit.id !== DRAFT_ID) draggingTradeRef.current = hit.id;
        // A staged DRAFT line (limit-order entry / SL / TP) edits the draft order, not a
        // server trade — route it there and bail. The backend validates levels on submit,
        // so no client-side clamp here (matches the draft's old native-drag behaviour).
        if (hit.id === DRAFT_ID) {
          const d = draftOrderSignal.value;
          if (d) {
            const key = hit.field === "tp" ? "takeProfit" : hit.field; // price|stop|takeProfit
            draftOrderSignal.set({ ...d, [key]: level });
            handle.paintBracketRef.current(); // keep the draft's bracket glued while dragging
          }
          return;
        }
        // Keep SL/TP on the valid side of their reference (long: SL below / TP above;
        // short: reversed) — clamp so the line can't be dragged across it. A WORKING
        // ORDER measures from its own limit (the live shown one, so a mid-edit entry
        // drag re-references it) since it isn't filled yet; a POSITION from the market.
        const trade = tradesRef.current.find((t) => t.id === hit.id);
        if (trade && (hit.field === "stop" || hit.field === "tp")) {
          const reference =
            trade.kind === "order"
              ? pendingEditsSignal.value[hit.id]?.price ?? trade.priceLevel
              : getLivePrice(epicRef.current) ?? c.getDataList().at(-1)?.close;
          if (reference != null) {
            const tick = Number((10 ** -precisionRef.current).toFixed(precisionRef.current));
            level = Number(
              clampLevelToPrice(hit.field, trade.side, reference, level, tick).toFixed(precisionRef.current),
            );
          }
        }
        const pendKey = hit.field === "tp" ? "takeProfit" : hit.field;
        const cur = pendingEditsSignal.value;
        pendingEditsSignal.set({ ...cur, [hit.id]: { ...cur[hit.id], [pendKey]: level } });
        // Keep the bracket glued to the line AS it drags. The pending-edit subscription
        // only repaints on the next rAF, so the line (redrawn synchronously) would
        // otherwise pull ahead of its spine/legs for a frame — repaint now, in lockstep.
        handle.paintBracketRef.current();
        // Confirm mode: focus the dragged line so its pill (Apply/Discard) shows — but
        // openPanel=false, so DRAGGING a line never pops the edit ticket open (only an
        // explicit double-click does). No-confirm mode leaves selection alone (the dock
        // auto-applies on the drop).
        if (confirmLineEditsRef.current) setTradeSelectedFn(hit.id, hit.field, false);
      },
      onCommit: (_hit, moved) => {
        // A press with no move is a plain click → let onClick select/toggle (don't swallow).
        if (!moved) return false;
        draggingLineSignal.set(false); // let no-confirm auto-apply commit the final level
        // Drop done: drop the drag-reveal and retract the line to its resting extent
        // (unless still hovered/selected, which drawPositions re-derives). Only when a
        // real trade was revealed — a draft never sets the ref, so skip its redundant redraw.
        if (draggingTradeRef.current != null) {
          draggingTradeRef.current = null;
          handle.posDrawRef.current();
        }
        // A real drag must not also fire the trailing click (which would toggle the
        // just-focused line's selection back off) — swallow it.
        return true;
      },
      // draggingLineSignal is a GLOBAL signal (pauses no-confirm auto-apply across every
      // cell). If this cell unmounts mid-drag, onCommit never runs — reset it here so it
      // can't stay paused forever. Idempotent: harmless if the drag never moved.
      onAbort: () => {
        draggingLineSignal.set(false);
        if (draggingTradeRef.current != null) {
          draggingTradeRef.current = null;
          handle.posDrawRef.current();
        }
      },
    });

    // Alert lines. klinecharts' native alert drag only engages on a press dead-on the
    // line after a separate selecting click, so a press in the magnet band reads as a
    // click, never a drag. We grab the nearest alert within the band on the FIRST press
    // and drive it ourselves (overlays.beginAlertDrag/dragAlertTo/endAlertDrag), so a
    // crosshair snap means the line is immediately draggable.
    const grabbableAlert = (yPix: number): { id: string; d: number } | null => {
      const c = chartRef.current;
      if (!c) return null;
      let best: { id: string; d: number } | null = null;
      for (const al of overlays.getAlerts()) {
        const ay = first(
          c.convertToPixel([{ value: al.level }], { paneId: "candle_pane", absolute: true }),
        ).y;
        if (ay == null) continue;
        const d = Math.abs(ay - yPix);
        if (d <= ALERT_SNAP_PX && (!best || d < best.d)) best = { id: al.id, d };
      }
      return best;
    };
    const alertDrag = makeLineDrag<{ id: string; d: number }>({
      grab: grabbableAlert,
      onBegin: (hit) => overlays.beginAlertDrag(hit.id), // hide the "+" and glue the label, like the native drag
      onMove: (hit, value) => overlays.dragAlertTo(hit.id, value),
      onCommit: (hit, moved) => {
        // A real drag quantizes + persists; a press with no move is a plain click → select.
        if (moved) {
          overlays.endAlertDrag(hit.id);
        } else {
          overlays.selectAlert(hit.id);
          // We swallow the trailing click below, but that click is the ONLY path that
          // enforces single-selection across types (it clears a selected indicator/trade).
          // Mirror that cross-type deselect here so selecting an alert still drops them —
          // otherwise a previously-selected trade/indicator stays lit alongside the alert.
          if (selectedIndicator.value) { selectedIndicator.set(null); repaint(); }
          if (!tradePanelOpen.value) setTradeSelectedFn(null);
        }
        // Either way, swallow the trailing click: onClick's alertHitTest uses the tighter
        // HIT_TOLERANCE_PX, so a click inside the wider magnet band would otherwise miss
        // and deselect (or toggle) the very line we just grabbed.
        return true;
      },
    });

    // Expose the in-flight state to the staying crosshair handlers (onMove reads
    // tradeDrag, onLeave reads alertDrag) — they can't see these hook-local closures.
    tradeDragActiveRef.current = () => tradeDrag.isActive();
    alertDragActiveRef.current = () => alertDrag.isActive();

    // The registry: one capture-phase mousedown grabs the GLOBALLY nearest line across
    // all kinds. Trade is listed first, so an equal-distance press grabs the trade (an
    // alert must be strictly closer to win) — preserving the prior precedence where the
    // trade handler ran first and only declined to a strictly-nearer alert.
    const lineDrags: LineDrag[] = [tradeDrag, alertDrag];
    const onLineDown = (e: MouseEvent) => {
      if (e.button !== 0 || avwapAnchorMode.value || e.metaKey || e.ctrlKey) return;
      if (measureArmed.value || overlays.isMeasureDrawing()) return; // placing a measure anchor
      if (slopeArmed.value || overlays.isSlopeDrawing()) return; // placing a slope anchor
      const c = chartRef.current;
      if (!c) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const mainW = c.getSize("candle_pane", DomPosition.Main)?.width ?? Infinity;
      if (x > mainW) return; // the y-axis strip is a scale gesture, not a line grab
      let winner: LineGrab | null = null;
      for (const drag of lineDrags) {
        const g = drag.tryGrab(y);
        if (g && (!winner || g.d < winner.d)) winner = g;
      }
      if (!winner) return;
      // Grab it: block klinecharts' pan, its own (selection-gated) overlay drag, AND its
      // click-select (we select ourselves on a no-move release).
      e.preventDefault();
      e.stopPropagation();
      winner.begin();
    };

    // Capture-phase so it runs before klinecharts' own canvas mousedown — when we
    // grab the anchor handle we stopPropagation, blocking the chart's pan start.
    el.addEventListener("mousedown", onAnchorDown, true);
    el.addEventListener("mousedown", onLineDown, true);

    return () => {
      el.removeEventListener("mousedown", onAnchorDown, true);
      el.removeEventListener("mousedown", onLineDown, true);
      // Drop any live window listeners from an in-flight line drag — teardown can't wait
      // for onUp (it fires on window and may never come if the cell unmounts mid-drag).
      lineDrags.forEach((d) => d.dispose());
      window.removeEventListener("mousemove", onAnchorMove);
      window.removeEventListener("mouseup", onAnchorUp, true);
      tradeDragActiveRef.current = () => false;
      alertDragActiveRef.current = () => false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
