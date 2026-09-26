// The state every OverlayManager layer shares, plus the plumbing under them:
// attach/detach, the per-cell settings (epic, scope, broker, read-only),
// listeners, right-click routing, drawing selection and the snap helpers.
// The layers stack base -> persistence -> display -> alerts -> tools ->
// drawings -> OverlayManager (overlays.ts), which owns create().
import type { Chart, Overlay, OverlayEvent, DeepPartial, OverlayStyle, OverlayMode } from "klinecharts";
import { effectiveMagnetMode, magnetSignal, magnetInvertSignal } from "../magnet";
import type { SavedOverlay } from "../persist";
import { bumpAlerts, drawingSettingsRequest } from "../signals";
import { snapScreenAngle, snapSquare, isShiftHeld, type Pt } from "../snapAngle";
import type { ChartDataFacade } from "../../chart/chartDataFacade";
import { SELECT_GLOW_KEY } from "../touchHitSlop";
import type { AlertConfig, Kind } from "./shared";

export abstract class OverlayManagerBase {
  // Defined by a higher layer; declared here so the lower layers can call it.
  protected abstract create(
    kind: Kind,
    name: string,
    points?: SavedOverlay["points"],
    styles?: DeepPartial<OverlayStyle> | null,
    lock?: boolean,
    extra?: { visible?: boolean; zLevel?: number; extendData?: unknown; id?: string },
  ): string | null;
  abstract shiftIndexAnchoredPoints(delta: number): void;

  protected chart: Chart | null = null;
  // v10 data-pipeline facade (set alongside chart in attach). applyOlderBars
  // prepends history through it (was chart.applyNewData).
  protected dataFacade: ChartDataFacade | null = null;
  protected epic = "";
  // Opaque per-cell storage prefix (see persist.ns). Set once by the owning
  // ChartController before rehydrate so every load/save addresses this cell's keys.
  protected scope = "";
  // The data broker this cell streams from (set by ChartCore). Alerts are stored
  // per broker; "" until set, in which case the alert helpers fall back to the
  // active broker (correct before the first setBroker).
  protected broker = "";
  // Read-only snapshot view (a tab restored from a snapshot): drawings materialize
  // locked, alert lines don't materialize at all, and add/remove are no-ops. Set by
  // ChartCore before rehydrate; flipped false on Unlock (followed by a rehydrate).
  protected readOnly = false;
  protected entries = new Map<string, Kind>();
  // Where a pattern ghost sat when the user pressed it (anchor price + bar), so
  // the release can tell a vertical placement from a slide along the bars.
  protected ghostDragStart: { value: number; dataIndex: number; timestamp?: number } | null = null;
  // The right edge a trade drawing's target and stop shared when the current
  // press began — settleTradeDrag reads it to tell which of the two moved.
  protected tradeDragEdge: number | null = null;
  // The live transient measure overlay (TV ruler), or null. Never persisted; a new
  // measure removes the old, and the next plain interaction / Esc / symbol change
  // clears it (ChartCore drives that). Single-instance by design.
  protected measureId: string | null = null;
  // True while klinecharts is collecting the two anchor clicks (between arm and the
  // second placing click). Distinguishes a placing click from a clear-the-frozen-box
  // click, and lets ChartCore cancel an unfinished measure.
  protected measureDrawing = false;
  // Fired when a measurement completes (both anchors placed) so the owner can disarm
  // the one-shot ruler. Set via setMeasureDone; the frozen box stays until next interaction.
  protected measureDone: (() => void) | null = null;
  // The live transient Slope line (TV-style angle ruler), or null. Like measure it is
  // never persisted and single-instance — but UNLIKE measure it stays interactive after
  // it's drawn: ChartCore drags its endpoints / midpoint / rotate knob via updateSlope.
  protected slopeId: string | null = null;
  // True while klinecharts is collecting the two anchor clicks (arm → second click).
  protected slopeDrawing = false;
  // Fired when the two anchors are placed so the owner can disarm the one-shot tool.
  protected slopeDone: (() => void) | null = null;
  // Transient "Pick Range" band (backtest): the shaded time selection driven by a
  // press-drag on the chart. Single-instance; the start/end timestamps are held
  // here (not read back from the overlay) so finishRangePick is exact.
  protected rangeBandId: string | null = null;
  protected rangeStartTs: number | null = null;
  protected rangeEndTs: number | null = null;
  // Zoom-to-range tool's persistent band (survives the TF drop it triggers,
  // redrawn from these timestamps after the reload). Tracked separately from the
  // backtest Pick Range band above so the two never clear each other.
  protected zoomBandId: string | null = null;
  protected zoomBandStartTs: number | null = null;
  protected zoomBandEndTs: number | null = null;
  // The pair of bands a "Find similar" jump paints on the match it landed on:
  // the matched candles, and the forward window the panel measured. Separate
  // from the two bands above so the query band the user dragged stays painted
  // (the two live at different dates, so only one is ever on screen).
  protected matchBandId: string | null = null;
  protected matchFwdBandId: string | null = null;
  // The time-range highlight being placed (press-drag). Unlike rangeBand it is a
  // PERSISTENT drawing (kind "drawing"): finishTimeRange keeps the overlay and
  // persists it. The start timestamp is held here so a click (no drag) can collapse
  // to the clicked candle's span. null when not placing.
  protected timeRangeId: string | null = null;
  protected timeRangeStartTs: number | null = null;
  protected alertCfg = new Map<string, AlertConfig>();
  // klinecharts overlay id -> the alert's STABLE id (SavedAlert.id). The overlay id
  // is regenerated on every rehydrate; the stable id is the identity persisted to
  // the backend and used by its alert engine, so this map is how we write the right
  // id in persist() and match lines to saved rows by id (not by value) in reconcile.
  protected alertIds = new Map<string, string>();
  // klinecharts overlay id -> creation timestamp (ms UTC). Set once at addAlert;
  // restored from SavedAlert.createdAt on rehydrate. 0 for legacy alerts.
  protected alertCreatedAt = new Map<string, number>();
  // Which alert line the cursor is over / which is click-selected. Drive the
  // on-line TV-style pill (hovered) and its persistence (selected until the user
  // clicks away). klinecharts owns the selection lifecycle via onSelected/
  // onDeselected; we just mirror its id so ChartCore can render the DOM pill.
  protected hoveredAlertId: string | null = null;
  protected selectedAlertId: string | null = null;
  // True while ChartCore's snap is active (cursor within ALERT_SNAP_PX of a line):
  // suppresses the klinecharts native horizontal crosshair so ours can replace it.
  protected snapNativeSuppressed = false;
  // True while an alert line is being dragged (between onPressedMoving and
  // onPressedMoveEnd; also cleared on remove/reset so it can't stick). ChartCore's
  // mousemove handler reads it imperatively to suppress the "+" axis affordance
  // during a drag — it would otherwise sit at the cursor's price, overlapping the
  // dragged line's own pill.
  protected draggingAlert = false;
  // The alert id currently being dragged (null when none). getAlerts() reports it as
  // `active` for the whole gesture so its on-line pill stays glued: while dragging, the
  // reliable snap-driven hover is suppressed and only klinecharts' flaky native
  // onMouseEnter/onMouseLeave feeds hoveredAlertId — which toggles as the line moves
  // under the cursor, so a pill gated on hover alone would flicker.
  protected draggingAlertId: string | null = null;
  // Drawing selection/hover (TV-style). klinecharts DOES fire onSelected/
  // onMouseEnter for drawings (verified), so unlike alerts these come straight from
  // its callbacks — no manual hit-test. `hoveredDrawingId` lets ChartCore's DOM
  // contextmenu yield to the overlay's own right-click menu (the bug fix: the
  // "Paste indicator" menu used to clobber it). `selectedDrawingId` drives keyboard
  // delete / copy and the "Settings…" target without a right-click.
  protected hoveredDrawingId: string | null = null;
  protected selectedDrawingId: string | null = null;
  // Drawings and alerts lockUnselectedForPress is holding, with their own lock flag.
  protected pressHeld = new Map<string, boolean>();
  // The drawing currently emphasized from OUTSIDE the chart (a chart-operand picker
  // row hover), so the user can see which on-chart line a row refers to when names/
  // colors are identical. Transient: the line is thickened (+ its concrete color) via
  // overrideOverlay while hovered and restored on leave. `emphasisBase` stashes the
  // real pre-emphasis style so canonicalStyles/persist NEVER bake the thick size in
  // (drawings persist their styles, unlike alert weights). See hoverDrawing.
  protected emphasizedDrawingId: string | null = null;
  protected emphasisBase: DeepPartial<OverlayStyle> | null | undefined = undefined;
  // Overlay id -> the CANONICAL (unfaded) styles for drawings currently rendered as a
  // ghost stub (see displayFor/applyDisplay). Stashed the moment a drawing first fades
  // so persist() can always write the real color back, never the faded one, even
  // while the drawing is rendered faint. Cleared once the drawing is solid again.
  protected fadedStyles = new Map<string, DeepPartial<OverlayStyle> | null | undefined>();
  // Current chart resolution (e.g. "1", "5", "60", "1D"). Drives per-drawing
  // interval visibility (extendData.visibility). Set by ChartCore on every period
  // change and once after rehydrate.
  protected resolution = "";
  // Instrument price precision (decimals). Set by ChartCore in lockstep with the
  // chart's symbol precision (the facade's setSymbol), and used to quantize alert
  // levels so a stored
  // level matches what every `.toFixed(precision)` label renders (no raw float from
  // a cursor-pixel conversion or a line drag). null until known → we skip rounding
  // rather than risk mangling a high-precision instrument with the wrong default.
  protected pricePrecision: number | null = null;
  // Echo guard: suppress persistence while we programmatically rebuild overlays.
  // A DEPTH COUNTER, not a boolean (0 = not hydrating): guarded blocks NEST — a
  // teardown removeOverlay inside rehydrate() fires onRemoved → notifyAlerts →
  // alertsChanged, and the cell's own subscription synchronously runs
  // reconcileAlerts, whose guarded() must not clear the flag the still-running
  // rehydrate depends on. A boolean did exactly that (its finally reset the flag
  // mid-teardown), so every remaining removal persisted a partial, shrinking
  // list — the 2026-07-08 "alerts/drawings vanish on timeframe switch" data loss.
  protected hydrating = 0;
  // Re-entrancy guard for reconcileAlerts: its removeOverlay/notifyAlerts churn
  // synchronously re-fires the alerts signal this cell is subscribed to, so the
  // method can recurse into itself; bail on re-entry (see reconcileAlerts).
  protected reconciling = false;
  // The epic whose overlays `entries` currently reflect — set ONLY by rehydrate().
  // setEpic() changes `this.epic` synchronously but the old epic's overlays linger
  // until the async data load + rehydrate(); persist() bails while these disagree so
  // a stray overlay edit in that window can't write the OLD epic's alerts under the
  // NEW epic's (now GLOBAL, shared, mirrored) alert key. null until first rehydrate.
  protected hydratedEpic: string | null = null;
  protected rightClick: ((e: OverlayEvent<unknown>) => void) | null = null;
  // When an overlay's onRightClick last fired (0 = never). klinecharts delivers it on
  // the right-MOUSEDOWN, which precedes the DOM contextmenu event of the same gesture,
  // so ChartCore's contextmenu handler can ask "did an overlay already claim this
  // right-click?" and yield instead of opening the chart menu on top of the overlay's.
  // A timestamp (not a boolean) so a claim whose contextmenu never arrived (e.g. the
  // press was dragged off the chart) can't swallow a later empty-space right-click.
  protected rightClickClaimedAt = 0;
  // Set only for the duration of a synthetic right-click replayed from a touch
  // long press (ChartCore's onTouchDown): the one overlay id whose onRightClick may
  // open the menu. undefined = no gate (a real mouse right-click).
  protected rightClickOnly: string | null | undefined = undefined;
  // Unsubscribe from the global magnet signals (toggle + hold-invert modifier), set
  // up in attach() and torn down in detach() so this cell's drawings track both (see
  // applyMagnet).
  private magnetUnsub: Array<() => void> = [];
  protected alertsListener: (() => void) | null = null;
  // rehydrate() re-mints every overlay id, so anything holding a drawing id
  // across a rebuild (the settings modal, via onIdRemap below) is silently
  // orphaned without this: its writes keep going to an id that no longer
  // exists. Listeners get an old-id -> new-id map, emitted only when the
  // rebuild provably recreated the same drawings (same epic, same count, same
  // names in order) — a symbol switch or a cross-tab divergence emits nothing
  // and a held id goes stale exactly as before.
  protected idRemapListeners = new Set<(map: ReadonlyMap<string, string>) => void>();
  // ChartCore subscribes to react to drawing selection changes (clear keyboard
  // focus targets, repaint), independent of the alert listener.
  private drawingListener: (() => void) | null = null;
  // The drawing currently carrying the selection glow (see syncSelectGlow).
  protected glowDrawingId: string | null = null;
  // The drawing being dragged (first onPressedMoving to onPressedMoveEnd). It
  // loses its glow for the gesture so fine adjustment sees the bare line.
  protected draggingDrawingId: string | null = null;

  // dataFacade is optional only so unit tests can construct a manager without the
  // v10 data pipeline; production (ChartCore) always passes it, and applyOlderBars
  // no-ops without it.
  attach(chart: Chart, dataFacade?: ChartDataFacade): void {
    this.chart = chart;
    this.dataFacade = dataFacade ?? null;
    // Native Forward (scroll-back) prepends renumber every dataIndex and v10
    // never shifts overlay points itself — the facade's pre-delivery hook makes
    // dataIndex-only (future-anchored) points shift before the bars land, no
    // matter who answers the load. applyOlderBars covers the INIT-type path.
    if (this.dataFacade) {
      this.dataFacade.onForwardPrepend = (count) => this.shiftIndexAnchoredPoints(count);
    }
    // Keep this cell's drawings' snap mode in lockstep with the global magnet toggle
    // AND the hold-invert modifier. New drawings pick it up at create() time; these
    // catch changes AFTER a drawing exists (so dragging an old line then snaps, and a
    // held Ctrl/Cmd flips it mid-gesture — TV-style).
    this.magnetUnsub = [
      magnetSignal.subscribe(() => this.applyMagnet()),
      magnetInvertSignal.subscribe(() => this.applyMagnet()),
    ];
  }
  detach(): void {
    this.magnetUnsub.forEach((u) => u());
    this.magnetUnsub = [];
    this.chart = null;
    if (this.dataFacade) this.dataFacade.onForwardPrepend = null;
    this.dataFacade = null;
    this.entries.clear();
    this.alertCfg.clear();
    this.alertIds.clear();
    this.alertCreatedAt.clear();
    this.fadedStyles.clear();
    this.hoveredAlertId = null;
    this.selectedAlertId = null;
    this.hoveredDrawingId = null;
    this.selectedDrawingId = null;
    this.glowDrawingId = null;
    this.draggingDrawingId = null;
    this.emphasizedDrawingId = null;
    this.emphasisBase = undefined;
    this.draggingAlert = false;
    this.draggingAlertId = null;
    this.drawingInProgress = false;
    this.hydratedEpic = null;
    this.rightClickClaimedAt = 0;
  }
  /** Subscribe to rehydrate's old-id -> new-id map (see idRemapListeners). */
  onIdRemap(fn: (map: ReadonlyMap<string, string>) => void): () => void {
    this.idRemapListeners.add(fn);
    return () => {
      this.idRemapListeners.delete(fn);
    };
  }

  setEpic(epic: string): void {
    this.epic = epic;
    // Leave hydratedEpic stale until rehydrate() rebuilds for the new epic — that's
    // what gates persist() during the symbol-change data-load window (see field).
  }
  setScope(scope: string): void {
    this.scope = scope;
  }
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }
  isReadOnly(): boolean {
    return this.readOnly;
  }
  // Push the current global magnet mode onto every existing DRAWING and the live slope
  // line (alerts/measure never snap). Called when the toolbar toggle or the Ctrl/Cmd
  // invert changes. Overriding `mode` does NOT move a placed drawing — mode only affects
  // klinecharts' coordinate→point snap during a live DRAW (the slope's two placing
  // clicks); the slope's post-draw handle drags snap via ChartCore + snapSlopeEndpoint.
  private applyMagnet(): void {
    if (!this.chart) return;
    const mode = effectiveMagnetMode() as OverlayMode;
    for (const [id, kind] of this.entries) {
      if (kind === "drawing" || kind === "slope") this.chart.overrideOverlay({ id, mode });
    }
  }
  // The data broker this cell belongs to. Alerts are stored PER BROKER, and this
  // cell can save an alert from an async callback that may fire mid broker-switch —
  // so we address the alert store with the cell's OWN broker (set by ChartCore in
  // lockstep with setEpic), never the ambient persistBroker which the toolbar
  // selector may already have flipped. Empty until ChartCore sets it (then load/
  // save fall back to the active broker, which is correct before the first set).
  setBroker(broker: string): void {
    this.broker = broker;
  }
  // Keep in lockstep with the chart's symbol precision (the facade's setSymbol,
  // ChartCore's effPrecision effect) so alert-level rounding uses the same decimals
  // the axis does.
  setPricePrecision(precision: number): void {
    this.pricePrecision = precision;
  }
  // Quantize an alert level to the instrument precision. The numeric form of what
  // `.toFixed(precision)` renders, so the stored level === the displayed level
  // everywhere. Unknown precision → return raw (don't round to a wrong default).
  protected roundLevel(level: number): number {
    return this.pricePrecision == null ? level : Number(level.toFixed(this.pricePrecision));
  }
  setRightClickHandler(fn: ((e: OverlayEvent<unknown>) => void) | null): void {
    this.rightClick = fn;
  }
  // True iff an overlay's onRightClick claimed the CURRENT right-click gesture (its
  // mousedown precedes the caller's contextmenu event; the window below only needs to
  // outlive that same-gesture gap, and keeps a stale claim from swallowing a later
  // empty-space right-click). Consuming clears the claim.
  // Run `fn` (which dispatches a synthetic right-click) with the menu gated to the
  // overlay `id`: onRightClick ignores any other overlay the press lands on.
  withRightClickOnly(id: string, fn: () => void): void {
    this.rightClickOnly = id;
    try {
      fn();
    } finally {
      this.rightClickOnly = undefined;
    }
  }
  consumeOverlayRightClick(): boolean {
    const claimed = this.peekOverlayRightClick();
    this.rightClickClaimedAt = 0;
    return claimed;
  }
  // The same test WITHOUT clearing the claim: the touch long-press asks "did a
  // drawing take this hold?" before offering it to a trendline, and must leave
  // the claim for whatever reads it next.
  peekOverlayRightClick(): boolean {
    return this.rightClickClaimedAt !== 0 && Date.now() - this.rightClickClaimedAt < 500;
  }
  // ChartCore subscribes to redraw its TV-style alert labels when alerts are
  // added, dragged, or removed.
  setAlertsListener(fn: (() => void) | null): void {
    this.alertsListener = fn;
  }
  // ChartCore subscribes to react when a drawing's selection changes (so it can
  // clear/refresh the keyboard target and repaint affordances).
  setDrawingListener(fn: (() => void) | null): void {
    this.drawingListener = fn;
  }
  // Every drawing-selection change goes through here: move the selection
  // glow, then tell the listener.
  protected notifyDrawing(): void {
    this.syncSelectGlow();
    this.drawingListener?.();
  }
  // The selected drawing gets the Trendlines indicator's selection glow, a wide
  // translucent under-stroke (drawn by the `line` figure in touchHitSlop.ts),
  // so it reads as selected even with both end dots off screen. The marker
  // rides on the live line style only; cloneStyles strips it from every
  // snapshot. No glow while the drawing is being placed, dragged or tuned in
  // its settings: the wide stroke hides the exact line the user is adjusting.
  // ChartCore calls this when the settings open or close.
  syncSelectGlow(): void {
    const id = this.selectedDrawingId;
    const busy =
      id === this.draggingDrawingId ||
      (this.drawingInProgress && id === this.pendingDrawId) ||
      id === drawingSettingsRequest.value?.id;
    const next = id && !busy && this.entries.get(id) === "drawing" ? id : null;
    if (next === this.glowDrawingId) return;
    if (this.glowDrawingId) this.setSelectGlow(this.glowDrawingId, false);
    this.glowDrawingId = next;
    if (next) this.setSelectGlow(next, true);
  }
  // Write the whole live `line` back with the flag set, not a one-key patch:
  // overrideOverlay's partial merge is not trusted here (see fade/unfade).
  private setSelectGlow(id: string, on: boolean): void {
    const ov = this.byId(id);
    if (!ov) return;
    const line = { ...((ov.styles?.line as object | undefined) ?? {}), [SELECT_GLOW_KEY]: on };
    this.chart?.overrideOverlay({ id, styles: { line } as never });
  }
  // ChartCore sets this to disarm the one-shot ruler when a measurement completes.
  setMeasureDone(fn: (() => void) | null): void {
    this.measureDone = fn;
  }
  // ChartCore sets this to disarm the one-shot slope tool when both anchors are placed.
  setSlopeDone(fn: (() => void) | null): void {
    this.slopeDone = fn;
  }
  protected notifyAlerts(): void {
    this.alertsListener?.(); // ChartCore: redraw on-chart axis pills
    bumpAlerts(); // alerts sidebar: re-pull the live list (add / delete / drag)
  }

  // True while an interactive drawing is mid-creation (a Draw tool is armed and
  // collecting click points). ChartCore's lock hover-align reads this so moving the
  // cursor to place a drawing's points doesn't also re-anchor the other charts. Set
  // when addDrawing is called without points (interactive), cleared on the overlay's
  // onDrawEnd (completed) or onRemoved (cancelled).
  protected drawingInProgress = false;
  isDrawing(): boolean {
    return this.drawingInProgress;
  }

  // The overlay id klinecharts is currently collecting clicks for (set alongside
  // drawingInProgress in addDrawing's interactive branch), so cancelDrawing knows
  // WHICH overlay to remove. Cleared everywhere drawingInProgress is cleared.
  protected pendingDrawId: string | null = null;

  // Sidebar "hide all drawings" eye — SESSION-ONLY master switch layered over
  // per-drawing intent (extendData.userVisible), so toggling it never rewrites
  // (or persists over) what the user chose per drawing.
  protected drawingsHidden = false;
  getDrawingsHidden(): boolean {
    return this.drawingsHidden;
  }

  // Sidebar "hide alert lines" eye — SESSION-ONLY and per cell, like drawingsHidden.
  // Only the on-chart presentation hides (lines, axis tags, hit/snap targets);
  // storage and the backend's alert engine are untouched, so hidden alerts still
  // fire and the alerts sidebar still lists them.
  protected alertsHidden = false;
  getAlertsHidden(): boolean {
    return this.alertsHidden;
  }

  // The id of the drawing the cursor is over (null when none). ChartCore reads
  // this so its DOM contextmenu yields to the overlay's own right-click menu.
  getHoveredDrawingId(): string | null {
    return this.hoveredDrawingId;
  }
  // The click-selected drawing (null when none). Target for keyboard Delete / ⌘C
  // and the "Settings…" menu action.
  getSelectedDrawingId(): string | null {
    return this.selectedDrawingId;
  }
  // Clear the drawing selection from OUTSIDE the chart — ChartCore calls this on an
  // empty-space click (klinecharts does NOT fire onDeselected for drawings, so we
  // mirror the indicator/alert deselect here).
  selectDrawing(id: string | null): void {
    if (id === this.selectedDrawingId) return;
    this.selectedDrawingId = id;
    this.notifyDrawing();
  }
  // The drawing's own lock flag, not a press hold.
  protected userLock(id: string, ov: Overlay): boolean {
    return this.pressHeld.has(id) ? this.pressHeld.get(id)! : ov.lock;
  }
  // ChartCore calls this from its native container click handler, which runs AFTER
  // klinecharts has processed the same click (its listeners fire on mouseup, before
  // the DOM click). klinecharts' click-overlay info is the source of truth for the
  // visible anchor handles, so mirroring it here keeps "handles visible" and
  // "Delete works" in lockstep. The old guard inferred "this click was on a
  // drawing" from the HOVER mirror, which is mousemove-driven — a click with no
  // prior mousemove over the drawing (chart panned/zoomed under a resting cursor,
  // trackpad tap) selected in klinecharts but cleared our mirror, leaving a
  // selected-looking drawing the Delete key silently ignored. getChartStore() is a
  // real ChartImp method absent from the public typings, hence the cast; if a
  // future klinecharts drops it we fall back to the event-driven mirror untouched.
  syncDrawingSelectionFromClick(): void {
    const store = (
      this.chart as unknown as {
        getChartStore?: () => {
          getClickOverlayInfo?: () => { overlay?: { id: string } | null } | null;
        };
      } | null
    )?.getChartStore?.();
    const info = store?.getClickOverlayInfo?.();
    if (info === undefined) return; // store API unavailable
    const id = info?.overlay?.id ?? null;
    this.selectDrawing(id != null && this.entries.get(id) === "drawing" ? id : null);
  }
  // The epic whose overlays are currently materialized (set only at the end of
  // rehydrate()). Navigation from the alerts sidebar uses this as the "safe to
  // select" gate: a freshly-mounted cell appears in App's ready map BEFORE
  // rehydrate runs, and a select fired then is wiped (rehydrate nulls
  // selectedAlertId). Callers wait until this matches the target epic.
  getHydratedEpic(): string | null {
    return this.hydratedEpic;
  }

  // The single funnel for overlay-by-id lookups. v10 dropped chart.getOverlayById in
  // favour of the filter-based getOverlays({ id }) (OverlayFilter), so every read that
  // used to call getOverlayById routes through here and returns the first match or null.
  protected byId(id: string): Overlay | null {
    return this.chart?.getOverlays({ id })[0] ?? null;
  }

  // --- TV-style Shift snap for straight lines + rectangle -------------------
  // Snapping is in SCREEN (pixel) space — that is what "45° on screen" / "a square"
  // mean — so we convert data↔pixel around the pure geometry in lib/snapAngle.ts.
  // Straight lines snap the moving endpoint to the nearest 45°; the rectangle snaps
  // to a square. Anything else (channels, fib, H/V lines, price lines) is ignored.
  private snapFnFor(name: string): ((f: Pt, m: Pt) => Pt) | null {
    if (name === "segment" || name === "rayLine" || name === "straightLine") return snapScreenAngle;
    if (name === "rect") return snapSquare;
    return null;
  }

  // Convert one data point to a pane-pixel coordinate (pane-relative, matching the
  // convention klinecharts uses for overlay event coordinates). null if unavailable.
  private toPx(overlay: Overlay, point: Overlay["points"][number]): Pt | null {
    const c = this.chart?.convertToPixel(point, { paneId: overlay.paneId }) as Partial<Pt> | undefined;
    return c && typeof c.x === "number" && typeof c.y === "number" ? { x: c.x, y: c.y } : null;
  }
  protected fromPx(overlay: Overlay, p: Pt): Overlay["points"][number] | null {
    const pts = this.chart?.convertFromPixel([p], { paneId: overlay.paneId }) as
      | Array<Overlay["points"][number]>
      | undefined;
    return pts?.[0] ?? null;
  }

  // Draw path: klinecharts already placed points[last]. If Shift is held, snap it
  // about the anchor (points[0]) and overwrite in place.
  protected maybeSnapDrawing(e: OverlayEvent<unknown>): void {
    if (!isShiftHeld()) return;
    const overlay = e.overlay;
    const snap = this.snapFnFor(overlay.name);
    if (!snap || overlay.points.length !== 2) return;
    const fixed = this.toPx(overlay, overlay.points[0]);
    const moving = this.toPx(overlay, overlay.points[1]);
    if (!fixed || !moving) return;
    const snapped = this.fromPx(overlay, snap(fixed, moving));
    if (snapped) overlay.points[1] = snapped;
  }

  // Edit path: the dragged endpoint/corner is points[figureIndex]; snap it about the
  // OTHER point using the cursor's pixel position. Returns true when it took over
  // (caller returns true to skip klinecharts' native point update).
  protected maybeSnapPressed(e: OverlayEvent<unknown>): boolean {
    const overlay = e.overlay;
    const snap = this.snapFnFor(overlay.name);
    // Only an anchor-handle drag (figureKey "overlay_figure_point_N") — never a
    // whole-overlay body translate.
    if (!snap || overlay.points.length !== 2) return false;
    // v10 no longer surfaces figureKey/figureIndex on the OverlayEvent; the pressed
    // point handle arrives as `e.figure`, whose key is `overlay_figure_point_<index>`
    // (OVERLAY_FIGURE_KEY_PREFIX + "point_" + index), so derive both from it.
    const key = e.figure?.key;
    if (!key?.startsWith("overlay_figure_point_")) return false;
    const idx = Number(key.slice("overlay_figure_point_".length));
    if (idx !== 0 && idx !== 1) return false;
    if (typeof e.x !== "number" || typeof e.y !== "number") return false;
    const fixed = this.toPx(overlay, overlay.points[idx === 0 ? 1 : 0]);
    if (!fixed) return false;
    const snapped = this.fromPx(overlay, snap(fixed, { x: e.x, y: e.y }));
    if (!snapped) return false;
    overlay.points[idx] = snapped;
    return true;
  }

  // The live chart resolution (e.g. "MINUTE_5"). Lets UI (the settings modal's
  // preset dropdown) read the current interval without re-deriving it.
  getResolution(): string {
    return this.resolution;
  }
  // Run a block with the echo guard on, so programmatic remove/create inside it
  // does NOT re-persist a transient intermediate state. Returns the block's value.
  // Depth-counted so a guarded block that (indirectly, via the alerts signal)
  // re-enters another guarded block can't un-guard its caller — see `hydrating`.
  protected guarded<T>(fn: () => T): T {
    this.hydrating++;
    try {
      return fn();
    } finally {
      this.hydrating--;
    }
  }
}
