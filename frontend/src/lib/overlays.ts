// Per-cell manager for chart overlays — both user drawings and price alerts.
// Each chart cell owns ONE instance (created by its ChartController); the focused
// cell's instance is routed to Toolbar / AlertsSidebar / the alert modals. Every
// overlay goes through one createOverlay path, one registry, one persistence
// subscription, and one right-click hook.
//
// DRAWINGS are scoped to the cell (keyed by scope+epic), so two cells never stomp
// each other's drawings. ALERTS are GLOBAL per epic (keyed by epic alone — they
// belong to the instrument, see persist.alertsKey): two cells showing the same
// epic share one stored list. reconcileAlerts() keeps every same-epic cell's lines
// in sync with that shared list on the alerts signal, which is what makes the
// shared list safe (each cell renders, and persists, the complete set).
//
// The class is built as a stack of layers under overlays/ (base, persistence,
// display, alerts, tools, drawings); this top layer owns create(), the one
// createOverlay path, plus remove() and rehydrate().

import type { Overlay, DeepPartial, OverlayStyle, OverlayMode } from "klinecharts";
import { effectiveMagnetMode, MAGNET_SENSITIVITY } from "./magnet";
import { loadDrawings, loadAlerts, deleteStoredAlert, normalizeAlert, type SavedOverlay } from "./persist";
import { isShiftHeld } from "./snapAngle";
import { defaultVisibility } from "./visibility";
import { type DrawingExtra, GHOST_NAME, type Kind, asDrawingExtra, isTradeDrawing } from "./overlays/shared";
import { OverlayDrawings } from "./overlays/drawings";
export { asDrawingExtra, cloneStyles } from "./overlays/shared";
export type { AlertConfig, DrawingExtra } from "./overlays/shared";

export class OverlayManager extends OverlayDrawings {
  // Shared create path: standard event wiring for every overlay we own.
  protected create(
    kind: Kind,
    name: string,
    points?: SavedOverlay["points"],
    styles?: DeepPartial<OverlayStyle> | null,
    lock?: boolean,
    extra?: { visible?: boolean; zLevel?: number; extendData?: unknown; id?: string },
  ): string | null {
    if (!this.chart) return null;
    const isAlert = kind === "alert";
    const isMeasure = kind === "measure";
    const isRangeBand = kind === "rangeBand";
    const isSlope = kind === "slope";
    const isDrawing = kind === "drawing";
    const isTrade = isTradeDrawing(name);
    const id = this.chart.createOverlay({
      // A caller-supplied id (rehydrate reviving a persisted drawing) keeps the
      // overlay's identity across rebuilds; everyone else lets the library mint.
      id: extra?.id,
      name,
      points: this.materializePoints(points) as Overlay["points"],
      styles: styles ?? undefined,
      lock,
      // Default to visible when no explicit intent is given. klinecharts' OverlayImp
      // defaults `visible` to true, but its config `merge` writes any own key over that
      // default, so passing `visible: undefined` (as an interactive addDrawing does: it
      // sends no visible) clobbers it to undefined. v10's OverlayView.drawImp gates the
      // IN-PROGRESS (progress) overlay's draw on a truthy `visible`, so that made the
      // rubber-band preview invisible while drawing (the completed overlay only renders
      // because onDrawEnd runs applyDisplay, which sets visible:true). Coalescing to true
      // here keeps the preview drawn; a rehydrated/hidden drawing still passes an explicit
      // false, which is preserved.
      visible: extra?.visible ?? true,
      zLevel: extra?.zLevel,
      extendData: extra?.extendData,
      // TV-style Magnet: only user DRAWINGS snap to OHLC — never alert lines or the
      // transient measure ruler. klinecharts does the snapping natively when `mode`
      // is weak/strong on the candle pane (see lib/magnet.ts).
      // Slope snaps like a drawing (user opted in); alerts/measure/rangeBand never do.
      // v10 gotcha: OverlayView._coordinateToPoint snaps whenever `mode !== 'normal'`,
      // and createOverlay's config merge CLOBBERS the OverlayImp 'normal' default even
      // with `undefined` (same gotcha as `visible` above). So a non-snapping overlay
      // MUST pass 'normal' explicitly — `undefined` reads as "not normal" and snaps.
      mode: isDrawing || isSlope ? (effectiveMagnetMode() as OverlayMode) : ("normal" as OverlayMode),
      modeSensitivity: isDrawing || isSlope ? MAGNET_SENSITIVITY : undefined,
      // Alerts render their own TV-style axis label (DOM pill in ChartCore), so
      // suppress klinecharts' default y-axis value box to avoid a duplicate. For
      // drawings the price tag is on by default but user-toggleable (Visibility
      // tab) — honor extendData.priceLabels when present so rehydrate restores it.
      needDefaultYAxisFigure: isAlert || isMeasure || isRangeBand || isSlope ? false : asDrawingExtra(extra?.extendData).priceLabels ?? true,
      // Same reasoning on the time axis, for alerts only: a startAtCreation line
      // carries a real timestamp, and klinecharts would stamp its date under the
      // line's start whenever it's click-selected. Spread rather than passed as
      // `undefined` — createOverlay's config merge writes any OWN key over the
      // library default, so an explicit undefined would silently disable the
      // x-axis label for drawings too (same gotcha as `visible`/`mode` above).
      ...(isAlert ? { needDefaultXAxisFigure: false } : {}),
      // v10 changed the right-click contract: the return value no longer suppresses
      // klinecharts' default "delete the overlay on right-click" — only calling
      // e.preventDefault() does (OverlayView._figureMouseRightClickEvent removes the
      // overlay whenever the handler didn't prevent). Without it, every right-click on
      // a drawing/alert DELETED it (and the removal cleared hoveredDrawingId before
      // the DOM contextmenu event, which is what stacked the chart menu on top of the
      // overlay menu). Keep returning true for the separate consumed/repaint path.
      onRightClick: (e) => {
        // Always prevent: klinecharts deletes the overlay otherwise (see above).
        e.preventDefault?.();
        // A touch long press only opens the menu of the drawing already selected
        // (see rightClickOnly); a hold that lands on any other overlay is ignored.
        if (this.rightClickOnly !== undefined && e.overlay.id !== this.rightClickOnly) return true;
        // Claim this right-click gesture BEFORE the DOM contextmenu event fires (this
        // callback runs on the mousedown), so ChartCore's contextmenu handler yields
        // to the overlay menu the handler below opens (see consumeOverlayRightClick).
        this.rightClickClaimedAt = Date.now();
        this.rightClick?.(e);
        return true;
      },
      onDrawEnd: () => {
        this.drawingInProgress = false;
        this.pendingDrawId = null;
        this.syncSelectGlow(); // placed: a selected drawing gets its glow now
        // Measure is transient: don't persist. Freeze it and let the owner disarm
        // the one-shot ruler; the frozen box stays until the next interaction.
        if (isMeasure) {
          this.measureDrawing = false;
          this.measureDone?.();
          return false;
        }
        // Slope is transient too, but stays interactive after placing — freeze the
        // draw state (so ChartCore's handle drags take over) and disarm the one-shot.
        if (isSlope) {
          this.slopeDrawing = false;
          this.slopeDone?.();
          return false;
        }
        // A trade drawing is placed with two clicks (entry, target) but needs a
        // third point for its stop, because klinecharts only projects an
        // overlay's OWN points to pixels. Seed it opposite the target at a 1:2
        // risk/reward, on the same right edge; the user drags it from there.
        if (isTrade && typeof id === "string") this.completeTradeDrawing(id);
        // Reject a drawing that finished with collapsed/incomplete anchors (e.g. a fib
        // whose two clicks landed on the same bar): it renders as an unclickable
        // zero-width strip the user can't select or delete. Remove it rather than
        // persist the stuck state. onRemoved handles entries/persist bookkeeping.
        if (isDrawing && typeof id === "string") {
          const ov = this.byId(id);
          if (ov && OverlayManager.isDegenerateDrawing(ov.points)) {
            this.chart?.removeOverlay({ id });
            return false;
          }
        }
        this.persist();
        // A seeded default may carry per-interval visibility; enforce it now (persist
        // alone doesn't run applyDisplay). Harmless when none is seeded — empty
        // visibility ⇒ show on all intervals. `id` is closed over and assigned by the
        // time onDrawEnd fires.
        if (isDrawing && typeof id === "string") {
          const ov = this.byId(id);
          if (ov) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
        }
        if (isAlert) this.notifyAlerts();
        return false;
      },
      // TV-style Shift snap while drawing a straight line / rectangle: fires AFTER
      // klinecharts sets the moving point, and its return is ignored — so we just
      // overwrite points[last] in place and the redraw picks it up.
      onDrawing: (e) => {
        if (isDrawing) this.maybeSnapDrawing(e);
        return false;
      },
      onPressedMoveStart: (e) => {
        // Trade drawings: remember the right edge the target and stop shared, so
        // the release can tell WHICH of them the user dragged sideways.
        if (isTrade) this.tradeDragEdge = e.overlay.points?.[1]?.timestamp ?? null;
        // Ghost only: remember where it started so the release can tell a
        // placement from a slide (see settleGhostDrag).
        if (e.overlay.name === GHOST_NAME) {
          const p = e.overlay.points?.[0];
          this.ghostDragStart =
            p?.value != null
              ? { value: p.value, dataIndex: p.dataIndex ?? -1, timestamp: p.timestamp }
              : null;
        }
        return false;
      },
      onPressedMoving: (e) => {
        if (isAlert) {
          this.draggingAlert = true;
          this.notifyAlerts(); // keep the label glued during a drag
        }
        // A trade level dragged across the entry converts the trade in place
        // (long ⇄ short): reflect the opposite leg live, before klinecharts
        // moves the dragged point itself — see maybeFlipTrade.
        if (isTrade) this.maybeFlipTrade(e);
        // Drop the glow for the drag (see syncSelectGlow).
        if (isDrawing && this.draggingDrawingId !== e.overlay.id) {
          this.draggingDrawingId = e.overlay.id;
          this.syncSelectGlow();
        }
        // Shift snap while dragging an endpoint/corner: returning true tells
        // klinecharts to SKIP its own point update so our snapped point stands.
        if (isDrawing && isShiftHeld() && this.maybeSnapPressed(e)) return true;
        return false;
      },
      onPressedMoveEnd: (e) => {
        // A drag leaves the alert line at a raw cursor-pixel price. Quantize it back
        // to the instrument precision BEFORE writing, so the stored level matches the
        // rendered pill (and reconcileAlerts' level compare agrees). The dropped level
        // is written by a by-id storage intent, never a chart-snapshot persist().
        if (isAlert) {
          this.draggingAlert = false;
          this.draggingAlertId = null;
          const raw = e.overlay.points?.[0]?.value;
          if (raw != null) {
            const rounded = this.roundLevel(raw);
            // ALWAYS restore the alert's OWN point, not just when rounding moved
            // it: klinecharts writes dataIndex+timestamp into the point on any
            // drag, and alertPriceLine then draws from whatever bar the
            // drop landed on — pan away and the dashed line runs from an
            // arbitrarily distant x on every frame. alertPoints re-stamps the
            // creation time (or drops the timestamp entirely) so the x-start stays
            // the one the alert owns.
            this.chart?.overrideOverlay({
              id: e.overlay.id,
              points: this.alertPoints(e.overlay.id, rounded),
            });
            const cfg = this.alertCfg.get(e.overlay.id);
            if (cfg) this.writeAlertUpdate(e.overlay.id, rounded, cfg);
          }
          this.notifyAlerts();
          return false;
        }
        // A trade's target and stop share the drawing's right edge, but
        // klinecharts drags one point at a time — pull the other one back into
        // line before this drop is persisted.
        if (isTrade) this.settleTradeDrag(e.overlay);
        if (this.draggingDrawingId !== null) {
          this.draggingDrawingId = null;
          this.syncSelectGlow();
        }
        // A ghost decides on release whether the drag placed it by hand.
        if (e.overlay.name === GHOST_NAME) this.settleGhostDrag(e.overlay);
        this.persist(); // a dragged drawing endpoint
        return false;
      },
      onRemoved: (e) => {
        // Grab the alert's stable saved id BEFORE the id maps are cleared below —
        // a genuine user delete writes a by-id delete intent to storage (guarded).
        const alertSavedId = isAlert ? this.alertIds.get(e.overlay.id) ?? null : null;
        this.entries.delete(e.overlay.id);
        if (this.measureId === e.overlay.id) {
          this.measureId = null;
          this.measureDrawing = false;
        }
        if (this.slopeId === e.overlay.id) {
          this.slopeId = null;
          this.slopeDrawing = false;
        }
        if (this.rangeBandId === e.overlay.id) {
          this.rangeBandId = null;
          this.rangeStartTs = null;
          this.rangeEndTs = null;
        }
        if (this.zoomBandId === e.overlay.id) {
          this.zoomBandId = null;
          this.zoomBandStartTs = null;
          this.zoomBandEndTs = null;
        }
        if (this.matchBandId === e.overlay.id) this.matchBandId = null;
        if (this.matchFwdBandId === e.overlay.id) this.matchFwdBandId = null;
        if (this.timeRangeId === e.overlay.id) {
          this.timeRangeId = null;
          this.timeRangeStartTs = null;
        }
        this.alertCfg.delete(e.overlay.id);
        this.alertIds.delete(e.overlay.id);
        this.alertCreatedAt.delete(e.overlay.id);
        this.fadedStyles.delete(e.overlay.id); // drop any stashed ghost-canonical style

        // Removing an alert mid-drag won't fire onPressedMoveEnd, so clear the drag
        // flag here too — otherwise it sticks true and the "+" setter stays hidden.
        this.draggingAlert = false;
        this.draggingAlertId = null;
        // Cancelling a drawing mid-creation (Escape / switching tools) removes the
        // in-progress overlay and fires THIS, not onDrawEnd — so clear the flag here
        // too, or it sticks true and the lock hover-align stays silently disabled.
        this.drawingInProgress = false;
        this.pendingDrawId = null;
        if (this.draggingDrawingId === e.overlay.id) this.draggingDrawingId = null;
        if (this.hoveredAlertId === e.overlay.id) {
          // Removing the hovered alert won't fire onMouseLeave, so restore the
          // crosshair (line + label) here or it stays stuck hidden.
          this.hoveredAlertId = null;
          this.applyCrosshairForAlert();
        }
        if (this.selectedAlertId === e.overlay.id) this.selectedAlertId = null;
        if (this.hoveredDrawingId === e.overlay.id) this.hoveredDrawingId = null;
        if (this.selectedDrawingId === e.overlay.id) {
          this.selectedDrawingId = null;
          this.notifyDrawing();
        }
        if (!this.hydrating) this.persist(); // drawings-only; a drawing was removed
        // A GENUINE user delete (not programmatic teardown/reconcile churn) removes
        // the alert from storage by id. canWriteAlerts() gates out hydrating rebuilds
        // and the symbol-change window — the same holes that made a snapshot persist()
        // catastrophic. deleteStoredAlert is a no-op if the id is already gone.
        if (isAlert && alertSavedId != null && this.canWriteAlerts()) {
          deleteStoredAlert(this.epic, alertSavedId, this.broker || undefined);
        }
        // Guarded (hydrating) removals are programmatic churn — rehydrate tears
        // every overlay down and re-notifies ONCE at its end, and reconcile
        // notifies itself when something changed. Bumping the alerts signal per
        // teardown removal synchronously re-entered reconcileAlerts mid-rehydrate
        // (see `hydrating`), which is how the TF-switch vanish started.
        if (isAlert && !this.hydrating) this.notifyAlerts();
        return false;
      },
      // Hover/selection drive the TV-style on-line pill. klinecharts keeps a
      // single click-selected instance and fires onDeselected on the previous one
      // when another overlay (or empty space) is clicked, so "stays selected until
      // you click away" comes for free — we just mirror the id.
      onMouseEnter: (e) => {
        if (isAlert) {
          this.hoverAlert(e.overlay.id); // emphasis + pill + sidebar row mirror
        } else {
          this.hoveredDrawingId = e.overlay.id;
        }
        return false;
      },
      onMouseLeave: (e) => {
        if (isAlert && this.hoveredAlertId === e.overlay.id) {
          this.hoverAlert(null);
        } else if (!isAlert && this.hoveredDrawingId === e.overlay.id) {
          this.hoveredDrawingId = null;
        }
        return false;
      },
      onSelected: (e) => {
        if (isAlert) this.setSelectedAlert(e.overlay.id);
        else {
          // klinecharts fires onSelected for drawings on click (verified). Mirror
          // its id; it manages the single-selection lifecycle (selecting another
          // overlay deselects this one) for the visible anchor handles, but does
          // NOT fire onDeselected on empty-space clicks — ChartCore clears via
          // selectDrawing(null) there.
          this.selectedDrawingId = e.overlay.id;
          this.notifyDrawing();
        }
        return false;
      },
      onDeselected: (e) => {
        // Only clear if THIS overlay is the one we have selected (klinecharts fires
        // onDeselected on the previous overlay when another is clicked).
        if (isAlert) {
          if (this.selectedAlertId === e.overlay.id) this.setSelectedAlert(null);
        } else if (this.selectedDrawingId === e.overlay.id) {
          this.selectedDrawingId = null;
          this.notifyDrawing();
        }
        return false;
      },
    });
    if (typeof id !== "string") return null;
    this.entries.set(id, kind);
    return id;
  }

  remove(id: string): void {
    if (this.readOnly) return; // snapshot view: nothing gets deleted
    this.chart?.removeOverlay({ id }); // onRemoved unregisters + persists
  }

  // Rebuild this epic's overlays. Must run AFTER data is loaded so timestamped
  // points map onto the timescale. Guarded so the rebuild doesn't re-persist.
  // On a timeframe switch the caller passes the NEW resolution — it must be
  // adopted BEFORE points materialize, because a future-anchored timestamp is
  // decoded to "n bars past the last candle" using the resolution's bar width
  // (see materializePoints); decoding with the previous timeframe's width lands
  // the anchor at the wrong x AND the next persist() writes that drift back to
  // storage. Omit it when the resolution is unchanged (template re-apply).
  rehydrate(resolution?: string): void {
    // Adopt the new resolution even when the chart is momentarily detached (an
    // HMR-stale controller, a teardown/remount interleaving): a later no-arg
    // rehydrate or persist must never see the previous timeframe's bar width.
    if (resolution != null) this.resolution = resolution;
    if (!this.chart) return;
    // Remember WHICH alert was selected by its stable saved id (not the overlay id,
    // which this rebuild re-mints). A same-epic rehydrate — a live data refresh, or
    // React's dev double-mount — must not silently drop the user's (or a navigation's)
    // selection; we re-select the line that still carries this saved id below.
    const prevSelectedSavedId =
      this.selectedAlertId != null ? this.alertIds.get(this.selectedAlertId) ?? null : null;
    let droppedDegenerate = false;
    // Any drawing that came back under a minted id (id-less pre-upgrade storage,
    // or the duplicate fallback) writes straight back, so the NEXT rebuild is
    // stable — "the next user edit will persist it" is not guaranteed to come.
    let mintedIds = false;
    // The drawings being torn down, in entries order — the SAME order and filter
    // persist() writes them with, which is the order the storage loop below
    // recreates them in. That is what makes index-pairing them valid (guarded
    // further by the name check when the map is built).
    const prevDrawings: Array<{ id: string; name: string }> = [];
    if (this.hydratedEpic === this.epic) {
      for (const [id, kind] of this.entries) {
        if (kind === "alert" || kind === "measure" || kind === "rangeBand" || kind === "slope") continue;
        const ov = this.byId(id);
        if (!ov || OverlayManager.isDegenerateDrawing(ov.points)) continue;
        prevDrawings.push({ id, name: ov.name });
      }
    }
    const nextDrawings: Array<{ id: string; name: string }> = [];
    this.hydrating++;
    try {
      for (const id of [...this.entries.keys()]) this.chart.removeOverlay({ id });
      this.entries.clear();
      this.alertCfg.clear();
      this.alertIds.clear();
      this.alertCreatedAt.clear();
      this.fadedStyles.clear(); // old epic's ids are gone; a fresh rebuild starts unfaded
      if (this.hoveredAlertId !== null) {
        // Wiping overlays on rehydrate (e.g. symbol change) won't fire
        // onMouseLeave, so restore the crosshair (line + label).
        this.hoveredAlertId = null;
        this.applyCrosshairForAlert();
      }
      this.selectedAlertId = null;
      this.hoveredDrawingId = null;
      this.selectedDrawingId = null;
      this.glowDrawingId = null;

      // Corrupt-storage guard: two records claiming one id would make
      // createOverlay return the FIRST overlay instead of creating the second,
      // silently dropping a drawing — the duplicate falls back to a minted id.
      const usedIds = new Set<string>();
      for (const d of loadDrawings(this.scope, this.epic)) {
        // Skip a drawing whose stored anchors are collapsed/incomplete — recreating it
        // would resurrect an unclickable zero-width strip the user can't delete. We
        // re-persist below so the corrupt entry is scrubbed from storage for good.
        if (OverlayManager.isDegenerateDrawing(d.points)) {
          droppedDegenerate = true;
          continue;
        }
        // Seed userVisible from the persisted top-level `visible` when extendData
        // hasn't recorded intent yet (the common case for a drawing whose Show-on-
        // chart toggle was never touched — persist() always writes the top-level
        // field, but only writes extendData.userVisible once the user interacts
        // with it). The overlay's live `visible` flag is then the EFFECTIVE value
        // (intent AND interval).
        const base = asDrawingExtra(d.extendData);
        const extra: DrawingExtra = {
          ...base,
          userVisible: base.userVisible ?? d.visible ?? true,
          visibility: base.visibility ?? defaultVisibility(),
        };
        const keepId = d.id && !usedIds.has(d.id) ? d.id : undefined;
        if (keepId) usedIds.add(keepId);
        else mintedIds = true; // pre-upgrade save (no id) or a duplicate: re-persist below
        const createdId = this.create("drawing", d.name, d.points, d.styles, this.readOnly || d.lock, {
          visible: this.effectiveVisible(extra, d.points),
          zLevel: d.zLevel,
          extendData: extra,
          id: keepId,
        });
        if (createdId) nextDrawings.push({ id: createdId, name: d.name });
      }
      // Repaint any drawing that loaded on a filtered interval as a ghost stub (rather
      // than the plain effectiveVisible above, which would leave it invisible) — so a
      // reload on e.g. a minute chart still shows a faint, clickable stand-in.
      this.applyIntervalVisibility();
      // Read-only snapshot view: alerts are LIVE global state per epic — rendering
      // (let alone dragging) them on a frozen study copy would be anachronistic
      // clutter and an accidental-edit hazard. Skip them entirely.
      if (!this.readOnly) {
        const rawAlerts = loadAlerts(this.epic, this.broker || undefined);
        for (let ai = 0; ai < rawAlerts.length; ai++) {
          this.materializeSavedAlert(normalizeAlert(rawAlerts[ai], ai));
        }
      }
      // Re-select the line that still carries the previously-selected saved id (gone
      // if its alert was removed). Restores selection across a same-epic rebuild.
      if (prevSelectedSavedId != null) {
        const restored = this.findAlertOverlayId(prevSelectedSavedId);
        this.selectedAlertId = restored;
        if (restored) this.applyAlertLineWeight(restored);
      }
      // entries now reflect this.epic — let persist() write through again.
      this.hydratedEpic = this.epic;
    } finally {
      this.hydrating--;
    }
    // Scrub any degenerate drawings we skipped above out of storage (persist() is a
    // no-op while hydrating, so it must run after the guard block re-enables writes).
    if (droppedDegenerate || mintedIds) this.persist();
    // Re-point held drawing ids at their recreated overlays — but only when the
    // rebuild demonstrably restored the same list (see idRemapListeners).
    if (
      prevDrawings.length > 0 &&
      prevDrawings.length === nextDrawings.length &&
      prevDrawings.every((p, i) => p.name === nextDrawings[i].name)
    ) {
      // With persisted ids (SavedOverlay.id) a rebuild keeps every id and this
      // map is empty — it only carries the drawings whose id actually changed
      // (storage saved before ids existed, or a duplicate-id fallback above).
      const map = new Map(
        prevDrawings.flatMap((p, i) => (p.id === nextDrawings[i].id ? [] : [[p.id, nextDrawings[i].id] as [string, string]])),
      );
      if (map.size > 0) for (const fn of this.idRemapListeners) fn(map);
    }
    this.notifyAlerts();
  }

  // NOTE: alert FIRING lives in the BACKEND (the single authority, running with
  // no tab open). This module only renders/persists alert lines; the server's
  // `__alerts__:` pushes land in alertsApi.applyAlertEvent, which re-hydrates and
  // bumps the alerts signal so reconcileAlerts() drops lines it removed.

  // --- persistence -----------------------------------------------------------

  // --- future-anchored points --------------------------------------------------
  // klinecharts gives a point placed beyond the last candle (a trendline projected
  // into the future) NO timestamp — dataIndexToTimestamp returns null past the data,
  // leaving only a session-relative dataIndex. And on the way back in, its
  // timestampToDataIndex CLAMPS an out-of-range timestamp to the nearest existing
  // bar, while a point with neither field renders at x=0. So future anchors are
  // ENCODED to storage as an extrapolated timestamp (last bar + n × bar width) by
  // stablePoints(), and DECODED back to a beyond-data dataIndex (timestamp dropped —
  // klinecharts prefers timestamp when both are set) by materializePoints().
}
