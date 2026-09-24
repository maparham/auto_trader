// Price-alert lines: selection, hover and drag, the stored-alert writes, and
// reconciling a cell's lines with the shared per-epic alert list.
import {
  loadAlerts,
  addStoredAlert,
  updateStoredAlert,
  normalizeAlert,
  newAlertId,
  type SavedAlert,
  type AlertCondition,
  type AlertTrigger,
} from "../persist";
import { ALERT_LINE_SELECTED_SIZE, ALERT_LINE_SIZE, ALERT_LINE_STYLE, type AlertConfig, sameAlertCfg } from "./shared";
import { OverlayDisplay } from "./display";

export abstract class OverlayAlerts extends OverlayDisplay {
  // May an alert INTENT write storage right now? Mirrors the two guards persist()
  // used to enforce, re-applied at each by-id alert write site now that alert writes
  // no longer flow through persist(): the chart must be mounted, we must not be mid
  // programmatic rebuild (hydrating), and `entries` must reflect the current epic
  // (else the symbol-change load window would write the wrong epic's shared list).
  protected canWriteAlerts(): boolean {
    return !!this.chart && !this.hydrating && this.hydratedEpic === this.epic;
  }

  // Write one alert edit (level + cfg) to storage by its stable id. The single seam
  // for edit / drag-end / trigger-toggle — each a genuine user intent. No-op when a
  // write isn't allowed (rebuild / symbol-change window) or the overlay has no saved
  // id yet. Storage is source of truth; the on-chart line is updated by the caller.
  protected writeAlertUpdate(ovId: string, level: number, cfg: AlertConfig): void {
    const savedId = this.alertIds.get(ovId);
    if (!savedId || !this.canWriteAlerts()) return;
    updateStoredAlert(
      this.epic,
      savedId,
      level,
      {
        condition: cfg.condition,
        trigger: cfg.trigger,
        message: cfg.message,
        expiresAt: cfg.expiresAt ?? null,
        notify: cfg.notify ?? {
          toast: true,
          browser: true,
          sound: true,
          push: true,
          telegram: true,
        },
        startAtCreation: cfg.startAtCreation ?? true,
      },
      this.broker || undefined,
    );
  }
  // The click-selected alert line (null when none). ChartCore freezes that line's
  // pill in place — a selected pill must stay put so its delete button is reachable.
  getSelectedAlertId(): string | null {
    return this.selectedAlertId;
  }

  // The alert line the cursor is currently over (null when none). ChartCore hides
  // the "+" alert-setter affordance while hovering a live alert — the setter would
  // otherwise sit at the same price and show through the alert's own pill.
  getHoveredAlertId(): string | null {
    return this.hoveredAlertId;
  }

  // True while an alert line is mid-drag. ChartCore hides the "+" axis affordance
  // for the duration so it doesn't sit over the dragged line's pill.
  isDraggingAlert(): boolean {
    return this.draggingAlert;
  }

  // Manual alert drag, driven by ChartCore (not klinecharts' native overlay drag)
  // so a press anywhere within the magnet band grabs the line on the FIRST press —
  // identical to trade lines. begin → dragAlertTo… → end mirror the native
  // onPressedMoving / onPressedMoveEnd handlers below.
  beginAlertDrag(id: string): void {
    this.draggingAlert = true;
    this.draggingAlertId = id; // keep this line `active` (pill glued) for the gesture
    this.notifyAlerts(); // glue the on-line label while dragging
  }
  dragAlertTo(id: string, rawLevel: number): void {
    // alertPoints, not a value-only point: that would drop the creation-time
    // anchor and the line would span the whole pane until a reload.
    this.chart?.overrideOverlay({ id, points: this.alertPoints(id, rawLevel) });
    this.notifyAlerts();
  }
  endAlertDrag(id: string): void {
    this.draggingAlert = false;
    this.draggingAlertId = null;
    // Quantize the raw cursor-pixel price to instrument precision before writing, so
    // the stored level matches the rendered pill (mirrors onPressedMoveEnd). The
    // dropped level is written by the by-id update intent — NOT persist() (now
    // drawings-only), or the level wouldn't stick and the ensuing reconcile would
    // snap the line back to its pre-drag price.
    const raw = this.byId(id)?.points?.[0]?.value;
    if (raw != null) {
      const rounded = this.roundLevel(raw);
      if (rounded !== raw) this.chart?.overrideOverlay({ id, points: this.alertPoints(id, rounded) });
      const cfg = this.alertCfg.get(id);
      if (cfg) this.writeAlertUpdate(id, rounded, cfg);
    }
    this.notifyAlerts();
  }

  // Apply an alert line's resting/emphasized weight. A line is emphasized (thick)
  // while it is EITHER click-selected OR hovered (from the chart or the sidebar), so
  // this single rule keeps the two states from fighting — un-hovering a selected
  // line must not thin it, and deselecting a hovered line must not either.
  protected applyAlertLineWeight(id: string | null): void {
    if (!id || !this.byId(id)) return;
    const emphasized = id === this.selectedAlertId || id === this.hoveredAlertId;
    this.chart?.overrideOverlay({
      id,
      styles: { line: { size: emphasized ? ALERT_LINE_SELECTED_SIZE : ALERT_LINE_SIZE } },
      // While emphasized, alertPriceLine extends a startAtCreation line across
      // the whole pane (the anchor dot stays put) so the full level is readable;
      // resting restores the from-creation span. Alerts carry no other
      // extendData, so wholesale replacement here is safe.
      extendData: { fullWidth: emphasized },
    });
  }

  // Single source of truth for "which alert line is selected". ALL selection
  // paths route through here — klinecharts' onSelected/onDeselected AND the
  // sidebar row click — so the previously-selected line is always restored to its
  // resting weight before the new one is emphasized (a programmatic select never
  // makes klinecharts fire onDeselected on the previous one). Idempotent: a no-op
  // when the id is unchanged, so it's safe to call from any handler without looping.
  protected setSelectedAlert(id: string | null): void {
    if (id === this.selectedAlertId) return;
    const prev = this.selectedAlertId;
    this.selectedAlertId = id;
    this.applyAlertLineWeight(prev); // resting weight unless it's still hovered
    this.applyAlertLineWeight(id);
    // Selection feeds the crosshair-label rule: if the cursor is on the alert being
    // (de)selected, its axis label must hide/restore in lockstep (see hoverAlert).
    this.applyCrosshairForAlert();
    this.notifyAlerts();
  }

  // Select an alert line from OUTSIDE the chart (the sidebar row click). Pass null
  // to clear (e.g. a click on empty chart space, mirroring indicator deselect).
  selectAlert(id: string | null): void {
    this.setSelectedAlert(id);
  }

  // Set the hovered alert line from OUTSIDE the chart (the sidebar row hover), so
  // the matching line goes into hover mode (emphasis + on-line pill) and vice
  // versa — getAlerts() exposes `hovered` so the sidebar can mirror the chart's
  // hover too. Idempotent; routes through the same weight rule as selection.
  hoverAlert(id: string | null): void {
    if (id === this.hoveredAlertId) return;
    const prev = this.hoveredAlertId;
    this.hoveredAlertId = id;
    this.applyAlertLineWeight(prev); // resting weight unless it's still selected
    this.applyAlertLineWeight(id);
    // Reconcile the crosshair: hide its horizontal LINE over any alert; hide its axis
    // LABEL only over the SELECTED alert (see applyCrosshairForAlert). Independent of
    // the legend's whole-crosshair `show` toggle (a different key), so they coexist.
    this.applyCrosshairForAlert();
    this.notifyAlerts();
  }

  // Reconcile the horizontal crosshair (line + its y-axis price label) with the current
  // alert hover. Both the native LINE and the native LABEL are hidden whenever the cursor
  // is over ANY alert line (selected or not), symmetrically: the line would sit right on
  // top of the amber dashed alert line and read as redundant noise, and the readout is
  // already owned by ChartCore's cursor-following price box (the z-49 `.axis-plus-price`,
  // which sits on top of the amber tag), so the native label is redundant too.
  // CRITICAL: klinecharts gates BOTH the line and the label on `horizontal.show` (it's
  // a master switch — see CrosshairLineView._drawLine and the label view, both of which
  // require horizontal.show first). So we must NOT toggle horizontal.show (that hides
  // the label too); keep it true and toggle the child flags `line.show` / `text.show`.
  // Applied via plain chart.setStyles(): v10's setStyles no longer forces a price-scale
  // re-fit to data (the old v9 hover-jolt): it routes through the store and a layout
  // that only rebuilds y-axis ticks for the unchanged range, so a crosshair-only style
  // patch repaints without moving the view. (The v9 code reached _chartStore directly to
  // dodge that re-fit; v10 removed the need, so the private escape is gone.)
  // Called by ChartCore when cursor enters/leaves the snap band (within ALERT_SNAP_PX).
  // Hides the klinecharts native horizontal line so ChartCore's own drawn line can
  // replace it at the snapped y without two lines appearing.
  setSuppressNativeLine(v: boolean): void {
    if (v === this.snapNativeSuppressed) return;
    this.snapNativeSuppressed = v;
    this.applyCrosshairForAlert();
  }

  protected applyCrosshairForAlert(): void {
    const overAlert = this.hoveredAlertId != null || this.snapNativeSuppressed;
    const styles = {
      crosshair: {
        horizontal: { show: true, line: { show: !overAlert }, text: { show: !overAlert } },
      },
    };
    this.chart?.setStyles(styles);
  }

  // --- drawing selection / hover ---------------------------------------------

  // Current alert lines with their live levels (read from the overlay points).
  // `condition` feeds the on-line pill label; `active` is true while the line is
  // hovered or click-selected so ChartCore knows to show that pill.
  // NOTE: returns the RAW overlay level (unlike getAlert(), which rounds for the edit
  // modal). Intentional: every consumer here renders via `.toFixed(precision)`, so the
  // raw value is fine — don't "fix" the asymmetry by rounding here without checking.
  getAlerts(): Array<{
    id: string;
    level: number;
    condition: AlertCondition;
    trigger: AlertTrigger;
    message: string;
    expiresAt: number | null;
    startAtCreation: boolean;
    createdAt: number;
    hovered: boolean;
    active: boolean;
    selected: boolean;
  }> {
    if (!this.chart) return [];
    const out: Array<{
      id: string;
      level: number;
      condition: AlertCondition;
      trigger: AlertTrigger;
      message: string;
      expiresAt: number | null;
      startAtCreation: boolean;
      createdAt: number;
      hovered: boolean;
      active: boolean;
      selected: boolean;
    }> = [];
    for (const [id, kind] of this.entries) {
      if (kind !== "alert") continue;
      const level = this.byId(id)?.points?.[0]?.value;
      if (level == null) continue;
      const cfg = this.alertCfg.get(id);
      const hovered = id === this.hoveredAlertId;
      // A line being dragged stays `active` even if native hover momentarily drops, so
      // its on-line pill doesn't flicker mid-drag (see draggingAlertId).
      const dragging = this.draggingAlert && id === this.draggingAlertId;
      out.push({
        id,
        level,
        condition: cfg?.condition ?? "crossing",
        trigger: cfg?.trigger ?? "every",
        message: cfg?.message ?? "",
        expiresAt: cfg?.expiresAt ?? null,
        startAtCreation: cfg?.startAtCreation ?? true,
        createdAt: this.alertCreatedAt.get(id) ?? 0,
        hovered,
        active: hovered || dragging || id === this.selectedAlertId,
        selected: id === this.selectedAlertId,
      });
    }
    return out;
  }

  // Resolve a stable SavedAlert id (the `al-…`/`lg-…` form stored per epic) to the
  // LIVE overlay id in this cell, or null if no alert line currently carries it.
  // The two id spaces differ — createOverlay mints the overlay id; `alertIds` maps
  // overlayId → savedId — so cross-symbol navigation (which only knows the saved id)
  // must translate before selectAlert()/hoverAlert(), which speak overlay ids.
  findAlertOverlayId(savedId: string): string | null {
    for (const [ovId, sid] of this.alertIds) if (sid === savedId) return ovId;
    return null;
  }

  // Resolve an alert line by content match (condition + level at the given
  // precision) to its overlay id, or null. Used for History rows, whose firing
  // record predates stable ids (or was dragged since) — a best-effort match that
  // simply finds nothing when the alert no longer exists (per spec: no highlight).
  findAlertOverlayIdByMatch(
    condition: AlertCondition,
    level: number,
    precision: number,
  ): string | null {
    const want = level.toFixed(precision);
    for (const a of this.getAlerts())
      if (a.condition === condition && a.level.toFixed(precision) === want) return a.id;
    return null;
  }

  // Flip an alert's trigger (once ↔ every) in place — the pill's clickable toggle.
  // Persists + notifies; the alert keeps its stable id, so the backend engine
  // sees the changed signature (level|condition|trigger) and re-arms + re-seeds it.
  toggleAlertTrigger(id: string): void {
    if (!this.chart || this.entries.get(id) !== "alert") return;
    const cfg = this.alertCfg.get(id);
    if (!cfg) return;
    const next: AlertConfig = { ...cfg, trigger: cfg.trigger === "once" ? "every" : "once" };
    this.alertCfg.set(id, next);
    const level = this.byId(id)?.points?.[0]?.value;
    if (level != null) this.writeAlertUpdate(id, level, next); // by-id intent, not persist()
    this.notifyAlerts();
  }

  // Flip where an alert's line starts (creation bar ↔ whole pane) in place — the
  // sidebar row's clickable badge. Cosmetic only: unlike toggleAlertTrigger this
  // leaves the engine's signature (level|condition|trigger) alone, so nothing
  // re-arms. Persists + notifies; alertPoints re-anchors the line off the new cfg.
  toggleAlertLineStart(id: string): void {
    if (!this.chart || this.entries.get(id) !== "alert") return;
    const cfg = this.alertCfg.get(id);
    if (!cfg) return;
    const next: AlertConfig = { ...cfg, startAtCreation: !(cfg.startAtCreation ?? true) };
    this.alertCfg.set(id, next); // BEFORE the points rewrite — alertPoints reads it
    const level = this.byId(id)?.points?.[0]?.value;
    if (level == null) return;
    this.chart.overrideOverlay({ id, points: this.alertPoints(id, level) });
    this.writeAlertUpdate(id, level, next); // by-id intent, not persist()
    this.notifyAlerts();
  }

  // Create a configured price alert (from the modal). Draggable alertPriceLine that mints
  // a fresh stable id now, so it keeps one identity across drags and edits. The write
  // is a by-id storage intent (addStoredAlert), NOT a persist() of the chart snapshot;
  // the line is then materialised through the same single draw path rehydrate/reconcile
  // use, so this cell and every same-epic peer render identically. Returns the new
  // overlay id (the synchronous contract callers rely on), or null in a rebuild /
  // symbol-change window where a write isn't allowed.
  addAlert(level: number, cfg: AlertConfig): string | null {
    if (!this.canWriteAlerts()) return null;
    level = this.roundLevel(level);
    const saved = normalizeAlert({ id: newAlertId(), level, ...cfg, createdAt: Date.now() });
    // 4th arg: the instrument's display precision, stored with the row so the
    // BACKEND (which now formats the firing message) renders the same decimals
    // the axis does. Omitting it would silently store 2 for every symbol.
    // 5th arg: the chart resolution this alert was created on, stored so the
    // backend's Telegram snapshot renders the same timeframe the user set the
    // level against.
    void addStoredAlert(
      this.epic, saved, this.broker || undefined, this.pricePrecision ?? 2, this.resolution || undefined,
    );
    const id = this.materializeSavedAlert(saved);
    if (id) this.notifyAlerts(); // peers reconcile off the bump; sidebar re-pulls
    return id;
  }

  // Edit an existing alert (from the edit modal). Moves the line to `level` and
  // replaces its config. The stable id is unchanged, so the backend sees the same
  // alert with a new signature and re-arms + re-seeds its baseline itself — a
  // changed level/condition can fire again, with no spurious crossing off the move.
  updateAlert(id: string, level: number, cfg: AlertConfig): void {
    if (!this.chart || this.entries.get(id) !== "alert") return;
    level = this.roundLevel(level);
    this.alertCfg.set(id, cfg);
    // Points AFTER the config: a toggled startAtCreation changes where the line
    // starts, and alertPoints reads the cached config to decide.
    this.chart.overrideOverlay({ id, points: this.alertPoints(id, level) }); // update the view
    this.writeAlertUpdate(id, level, cfg); // by-id storage intent, not persist()
    this.notifyAlerts();
  }

  // Live config for one alert (level + cfg), for prefilling the edit modal.
  getAlert(id: string): { level: number; cfg: AlertConfig } | null {
    if (!this.chart || this.entries.get(id) !== "alert") return null;
    const raw = this.byId(id)?.points?.[0]?.value;
    if (raw == null) return null;
    // Round on read too, so the edit modal shows a clean number even for legacy
    // alerts stored at full precision before levels were quantized on write.
    const level = this.roundLevel(raw);
    const cfg = this.alertCfg.get(id) ?? {
      condition: "crossing" as AlertCondition,
      trigger: "every" as AlertTrigger,
      message: "",
    };
    return { level, cfg };
  }

  // Full resync of this cell's alert lines to storage, matched by STABLE id (not by
  // value — two alerts can share a level, and a dragged line would otherwise
  // self-match the wrong row). Called on the alerts signal, which fires when ANYONE
  // changes the epic's (now GLOBAL) alert list: the backend removing a
  // fired "once", OR another cell showing the same epic in a split layout adding /
  // moving / deleting / re-configuring one. So this must do three things, not just
  // remove:
  //   - remove overlays whose id is gone from storage,
  //   - ADD overlays for saved alerts this cell doesn't have yet (a peer cell added
  //     them) — without this, a same-epic split cell shows the alert in the side
  //     panel but never draws the line, AND its next persist() would drop it,
  //   - re-level / re-config overlays whose stored value drifted (moved elsewhere) —
  //     INCLUDING the notify channels, or a notify-only edit in a peer cell gets
  //     reverted when this stale cell next persists.
  // Keeping every same-epic cell's overlays == storage is also what makes persist()
  // safe: each cell writes the COMPLETE list, so cells never stomp each other.
  // Runs under the `hydrating` guard so the create/remove/override churn does NOT
  // re-persist (storage is the source of truth here). The `reconciling` re-entrancy
  // guard is essential: removeOverlay → onRemoved → notifyAlerts → bumpAlerts fires
  // this same cell's signal subscription synchronously; without the guard that
  // re-entrant call's own guarded() finally would clear `hydrating` for the call
  // still in progress, and a later onRemoved would persist a half-removed list to
  // the shared global key. notifyAlerts (redraw + cross-cell bump) fires only when
  // something changed, so peers converge instead of looping.
  reconcileAlerts(): void {
    if (!this.chart || this.reconciling) return;
    // Guard the symbol-change window: setEpic() advanced this.epic but the old epic's
    // overlays still render until rehydrate() rebuilds. Reconciling now would draw the
    // NEW epic's saved alert lines on top of the OLD epic's bars (a flash of wrong-
    // instrument lines) until rehydrate self-corrects. rehydrate() re-reads storage, so
    // nothing is lost by skipping — a peer's edit lands when this cell finishes loading.
    if (this.hydratedEpic !== this.epic) return;
    // Don't fight an in-progress drag on this cell: dragAlertTo moves the line ahead
    // of storage (it only persists on drop), so reconciling against the saved level
    // here would snap the dragged line back to its old price on every move. The drop
    // (endAlertDrag) persists + notifies, which reconciles peers to the final level.
    if (this.draggingAlert) return;
    this.reconciling = true;
    try {
      const saved = loadAlerts(this.epic, this.broker || undefined).map((a, i) => normalizeAlert(a, i));
      const savedById = new Map(saved.map((a) => [a.id, a]));
      // Stable id -> this cell's overlay id, for the alerts we currently render.
      const haveByAid = new Map<string, string>();
      for (const [id, kind] of this.entries) {
        if (kind !== "alert") continue;
        const aid = this.alertIds.get(id);
        if (aid != null) haveByAid.set(aid, id);
      }

      let changed = false;
      this.guarded(() => {
        // Drop overlays no longer in storage (backend removed / peer cell deleted).
        for (const [id, kind] of [...this.entries]) {
          if (kind !== "alert") continue;
          const aid = this.alertIds.get(id);
          if (aid == null || !savedById.has(aid)) {
            this.chart!.removeOverlay({ id }); // onRemoved cleans the id maps + entries
            changed = true;
          }
        }
        // Add or re-sync each saved alert.
        for (const a of saved) {
          const ovId = haveByAid.get(a.id);
          if (ovId == null) {
            // A peer cell added this alert — materialise the line here too.
            if (this.materializeSavedAlert(a)) changed = true;
            continue;
          }
          // Already present — pull the level/config forward if it drifted elsewhere.
          const ov = this.byId(ovId);
          const levelDrift = !!ov && ov.points?.[0]?.value !== a.level;
          const cfg = this.alertCfg.get(ovId);
          const cfgDrift = !cfg || !sameAlertCfg(cfg, a);
          // Config + creation time BEFORE the points rewrite — alertPoints reads both.
          if (cfgDrift) this.alertCfg.set(ovId, this.cfgFromSaved(a));
          this.alertCreatedAt.set(ovId, a.createdAt ?? 0);
          // A startAtCreation toggle is cfg drift at an UNCHANGED level, so the
          // points rewrite can't be gated on the level alone or a peer cell would
          // keep drawing from the old x-start.
          if (levelDrift || cfgDrift) {
            this.chart!.overrideOverlay({ id: ovId, points: this.alertPoints(ovId, a.level) });
            changed = true;
          }
        }
      });
      if (changed) this.notifyAlerts();
    } finally {
      this.reconciling = false;
    }
  }

  // Sidebar eye: hide/show every alert line at once (session-only; storage and the
  // backend engine are untouched — see alertsHidden). Consumers that hit-test or
  // tag alert lines (alertHitTest, snap targets, drag grab, axis tags) gate on
  // getAlertsHidden() themselves, so a hidden line is neither visible nor grabbable.
  setAlertsHidden(hidden: boolean): void {
    if (this.alertsHidden === hidden) return;
    this.alertsHidden = hidden;
    for (const [id, kind] of this.entries) {
      if (kind === "alert") this.chart?.overrideOverlay({ id, visible: !hidden });
    }
    if (hidden) {
      // A hidden line can't stay hovered/selected: klinecharts fires no onMouseLeave
      // for an overlay that just went invisible, so the emphasis + suppressed
      // crosshair would stick (same reason rehydrate clears these).
      if (this.hoveredAlertId !== null) {
        this.hoveredAlertId = null;
        this.applyCrosshairForAlert();
      }
      this.setSelectedAlert(null);
    }
    this.alertsListener?.(); // ChartCore: drop/restore the DOM axis tags in lockstep
  }

  // The single SavedAlert -> AlertConfig mapping. Shared by materializeSavedAlert and
  // reconcileAlerts' re-sync branch so the cached config can't drift between them;
  // sameAlertCfg() compares against exactly these fields.
  private cfgFromSaved(a: SavedAlert): AlertConfig {
    return {
      condition: a.condition,
      trigger: a.trigger,
      message: a.message,
      expiresAt: a.expiresAt ?? null,
      notify: a.notify,
      startAtCreation: a.startAtCreation ?? true,
    };
  }

  // The point an alert line is drawn from. alertPriceLine (like the built-in priceLine) runs its
  // line from the point's x to the right edge, and a point carrying only a `value`
  // resolves to x=0 — so a value-only point spans the whole pane, while a point
  // stamped with the creation time starts the line there ("alerts don't concern the
  // past bars"). Legacy rows have createdAt 0: keep those full-width rather than
  // handing klinecharts a 1970 timestamp to extrapolate from. A creation time older
  // than the loaded bars clamps to the first bar, which reads as full-width too.
  //
  // CLAMPED TO THE LAST BAR. Wall-clock "now" routinely sits PAST the newest candle
  // — a 1D chart over a weekend is days past it, and even intraday the forming bar
  // opened minutes ago — and klinecharts extrapolates a beyond-data timestamp into
  // the blank space right of the data instead of clamping. Unclamped, a fresh alert
  // starts several bars into the future with a visible gap after the last candle.
  // The bar the alert was created IN is the honest anchor, and it stays correct as
  // later bars arrive.
  protected alertPoints(id: string, level: number): { value: number; timestamp?: number }[] {
    const cfg = this.alertCfg.get(id);
    const createdAt = this.alertCreatedAt.get(id) ?? 0;
    if (!(cfg?.startAtCreation ?? true) || createdAt <= 0) return [{ value: level }];
    const bars = this.chart?.getDataList() ?? [];
    const last = bars[bars.length - 1];
    return [{ value: level, timestamp: last ? Math.min(createdAt, last.timestamp) : createdAt }];
  }

  // Materialise a saved alert row as this cell's on-chart line and register its id
  // maps. The ONE place a SavedAlert becomes an overlay — shared by rehydrate (full
  // rebuild) and reconcileAlerts (a peer cell added it), so both render identically.
  // Returns the overlay id, or null if create() declined (e.g. no chart).
  protected materializeSavedAlert(a: SavedAlert): string | null {
    // IDEMPOTENT BY SAVED ID. addStoredAlert (backend client) bumps the alerts
    // signal synchronously, INSIDE the write — so ChartCore's live
    // `alertsChanged -> reconcileAlerts` subscription re-enters this cell and
    // materializes the brand-new row BEFORE addAlert() gets to. Without this
    // guard the caller then draws a second line for the same alert (the localStorage
    // helpers didn't bump, so the old ordering hid this).
    const existing = this.findAlertOverlayId(a.id);
    if (existing != null) return existing;
    // Respect the session eye toggle: an alert added/reconciled while "Hide alert
    // lines" is on must materialize hidden, not flash visible.
    const id = this.create("alert", "alertPriceLine", [{ value: a.level }], ALERT_LINE_STYLE, undefined, {
      visible: !this.alertsHidden,
    });
    if (!id) return null;
    this.alertCfg.set(id, this.cfgFromSaved(a));
    // Carry the stored stable id (normalizeAlert backfills legacy rows). The next
    // persist() writes it back explicitly, locking a backfilled id.
    this.alertIds.set(id, a.id);
    this.alertCreatedAt.set(id, a.createdAt ?? 0);
    // The line is created value-only above (the overlay id the maps are keyed by
    // only exists once createOverlay returns), then anchored here now that its
    // config + creation time are registered — skipped when it would re-write the
    // same value-only point (flag off, or a legacy row with no creation time).
    const points = this.alertPoints(id, a.level);
    if (points[0].timestamp != null) this.chart?.overrideOverlay({ id, points });
    return id;
  }

  // --- rehydration (called by ChartCore after the facade's setBars) ----------
}
