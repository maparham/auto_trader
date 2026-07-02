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

import { LineType } from "klinecharts";
import type { Chart, Overlay, OverlayEvent, DeepPartial, OverlayStyle } from "klinecharts";
import {
  loadDrawings,
  saveDrawings,
  loadAlerts,
  saveAlerts,
  normalizeAlert,
  newAlertId,
  type SavedOverlay,
  type SavedAlert,
  type AlertCondition,
  type AlertTrigger,
  type AlertNotifyChannels,
} from "./persist";
import { bumpAlerts } from "./signals";
import { hexToRgba } from "./lineStyle";
import {
  type VisibilityModel,
  defaultVisibility,
  isVisibleOnResolution,
  barsSpanned,
} from "./visibility";

type Kind = "drawing" | "alert" | "measure";

// A measure anchor point — the same loose shape klinecharts stores on an overlay.
type MeasurePoint = { timestamp?: number; value?: number; dataIndex?: number };

// One-level-deep merge of a style patch onto a base style: for each top-level style
// category present in the patch (line, text, ...), shallow-merge its fields over the
// base's, so a partial category edit doesn't drop sibling fields the patch didn't
// mention. Mirrors the granularity every other style write in this file already uses
// (e.g. `{ line: { ...(styles?.line ?? {}), color: ... } }` in fade/unfade below).
function mergeStyles(
  base: DeepPartial<OverlayStyle> | null | undefined,
  patch: DeepPartial<OverlayStyle>,
): DeepPartial<OverlayStyle> {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    const baseVal = (base as Record<string, unknown> | null | undefined)?.[key];
    merged[key] =
      value && typeof value === "object" && !Array.isArray(value) &&
      baseVal && typeof baseVal === "object"
        ? { ...baseVal, ...value }
        : value;
  }
  return merged as DeepPartial<OverlayStyle>;
}

// Deep-clone a style object before stashing it as a ghost's "canonical" backup.
// klinecharts mutates an overlay's `styles` in place when overrideOverlay is called
// (verified empirically), so a shallow/reference stash of `ov.styles` gets silently
// corrupted the moment the next override (e.g. the fade itself) touches the same
// object — permanently baking the ghost color in as if it were the original. A plain
// JSON round-trip is sufficient here: overlay styles are plain data (colors, sizes,
// dash arrays), never functions/class instances/circular refs.
// Exported so other snapshot-then-later-mutate call sites (e.g. IndicatorSettings.tsx's
// Cancel-button snapshot of an indicator's live `styles`) can reuse the exact same
// deep-clone instead of re-deriving the technique.
export function cloneStyles<T>(styles: T): T {
  return styles == null ? styles : (JSON.parse(JSON.stringify(styles)) as T);
}

export interface AlertConfig {
  condition: AlertCondition;
  trigger: AlertTrigger;
  message: string;
  // Wall-clock expiry (ms, UTC) or null for open-ended. See SavedAlert.expiresAt.
  expiresAt?: number | null;
  // Which notification channels fire on trigger (absent = all on).
  notify?: AlertNotifyChannels;
}

// Per-drawing config stashed on the overlay's `extendData` (persisted as-is via
// SavedOverlay.extendData). Everything is optional so a drawing with no extendData
// behaves as all-defaults.
//   visibility  — per-timeframe visibility model (TV Visibility tab). Absent ⇒
//                 default (all intervals). The user's own Visibility checkbox is the
//                 separate `visible` flag; the EFFECTIVE on-chart visibility is
//                 (visible && interval matches).
//   text        — a label drawn near the drawing (custom-overlay feature).
//   showMiddle  — draw a marker at the segment midpoint (custom-overlay feature).
//   priceLabels — show the built-in y-axis value tag(s) for this drawing.
export interface DrawingExtra {
  // The Visibility checkbox (user intent). Absent ⇒ true. The overlay's live
  // `visible` flag is the EFFECTIVE value (intent AND interval), so intent must
  // live here where interval-filtering never overwrites it.
  userVisible?: boolean;
  // Per-timeframe visibility model (TV Visibility tab). Absent ⇒ default (all intervals).
  visibility?: VisibilityModel;
  text?: string;
  showMiddle?: boolean;
  priceLabels?: boolean;
}

// Narrow unknown extendData to our shape (never throws; non-objects → {}).
export function asDrawingExtra(v: unknown): DrawingExtra {
  return v && typeof v === "object" ? (v as DrawingExtra) : {};
}

// True when a cell's cached alert config already matches a saved row — every
// firing-relevant field PLUS the notify channels (absent channel = on). Used by
// reconcileAlerts to decide whether a peer's edit needs pulling in; omitting notify
// here lets a notify-only edit drift and get reverted on this cell's next persist().
function sameAlertCfg(cfg: AlertConfig, a: SavedAlert): boolean {
  return (
    cfg.condition === a.condition &&
    cfg.trigger === a.trigger &&
    cfg.message === a.message &&
    (cfg.expiresAt ?? null) === (a.expiresAt ?? null) &&
    (cfg.notify?.toast ?? true) === (a.notify?.toast ?? true) &&
    (cfg.notify?.browser ?? true) === (a.notify?.browser ?? true) &&
    (cfg.notify?.sound ?? true) === (a.notify?.sound ?? true)
  );
}



const ALERT_LINE_COLOR = "#f5a623";
const ALERT_LINE_SIZE = 1;
const ALERT_LINE_SELECTED_SIZE = 2; // slightly thicker while click-selected
// Dashed alert line (distinct from the dotted last-price line). klinecharts'
// built-in `priceLine` overlay also draws a value `text` figure at the left end of
// the line (hardcoded in its createPointFigures, not gated by needDefaultYAxisFigure)
// — we render our own TV-style axis tag on the right instead, so make that built-in
// left label fully transparent to suppress it.
const HIDDEN_TEXT = {
  color: "transparent",
  backgroundColor: "transparent",
  borderColor: "transparent",
  size: 0,
};
const ALERT_LINE_STYLE: DeepPartial<OverlayStyle> = {
  line: { color: ALERT_LINE_COLOR, style: LineType.Dashed, dashedValue: [4, 4], size: ALERT_LINE_SIZE },
  text: HIDDEN_TEXT,
};

export class OverlayManager {
  private chart: Chart | null = null;
  private epic = "";
  // Opaque per-cell storage prefix (see persist.ns). Set once by the owning
  // ChartController before rehydrate so every load/save addresses this cell's keys.
  private scope = "";
  // The data broker this cell streams from (set by ChartCore). Alerts are stored
  // per broker; "" until set, in which case the alert helpers fall back to the
  // active broker (correct before the first setBroker).
  private broker = "";
  private entries = new Map<string, Kind>();
  // The live transient measure overlay (TV ruler), or null. Never persisted; a new
  // measure removes the old, and the next plain interaction / Esc / symbol change
  // clears it (ChartCore drives that). Single-instance by design.
  private measureId: string | null = null;
  private alertCfg = new Map<string, AlertConfig>();
  // klinecharts overlay id -> the alert's STABLE id (SavedAlert.id). The overlay id
  // is regenerated on every rehydrate; the stable id is the identity persisted to
  // storage and used by the background engine, so this map is how we write the right
  // id in persist() and match lines to saved rows by id (not by value) in reconcile.
  private alertIds = new Map<string, string>();
  // klinecharts overlay id -> creation timestamp (ms UTC). Set once at addAlert;
  // restored from SavedAlert.createdAt on rehydrate. 0 for legacy alerts.
  private alertCreatedAt = new Map<string, number>();
  // Which alert line the cursor is over / which is click-selected. Drive the
  // on-line TV-style pill (hovered) and its persistence (selected until the user
  // clicks away). klinecharts owns the selection lifecycle via onSelected/
  // onDeselected; we just mirror its id so ChartCore can render the DOM pill.
  private hoveredAlertId: string | null = null;
  private selectedAlertId: string | null = null;
  // True while ChartCore's snap is active (cursor within ALERT_SNAP_PX of a line):
  // suppresses the klinecharts native horizontal crosshair so ours can replace it.
  private snapNativeSuppressed = false;
  // True while an alert line is being dragged (between onPressedMoving and
  // onPressedMoveEnd; also cleared on remove/reset so it can't stick). ChartCore's
  // mousemove handler reads it imperatively to suppress the "+" axis affordance
  // during a drag — it would otherwise sit at the cursor's price, overlapping the
  // dragged line's own pill.
  private draggingAlert = false;
  // The alert id currently being dragged (null when none). getAlerts() reports it as
  // `active` for the whole gesture so its on-line pill stays glued: while dragging, the
  // reliable snap-driven hover is suppressed and only klinecharts' flaky native
  // onMouseEnter/onMouseLeave feeds hoveredAlertId — which toggles as the line moves
  // under the cursor, so a pill gated on hover alone would flicker.
  private draggingAlertId: string | null = null;
  // Drawing selection/hover (TV-style). klinecharts DOES fire onSelected/
  // onMouseEnter for drawings (verified), so unlike alerts these come straight from
  // its callbacks — no manual hit-test. `hoveredDrawingId` lets ChartCore's DOM
  // contextmenu yield to the overlay's own right-click menu (the bug fix: the
  // "Paste indicator" menu used to clobber it). `selectedDrawingId` drives keyboard
  // delete / copy and the "Settings…" target without a right-click.
  private hoveredDrawingId: string | null = null;
  private selectedDrawingId: string | null = null;
  // Overlay id -> the CANONICAL (unfaded) styles for drawings currently rendered as a
  // ghost stub (see displayFor/applyDisplay). Stashed the moment a drawing first fades
  // so persist() can always write the real color back, never the faded one, even
  // while the drawing is rendered faint. Cleared once the drawing is solid again.
  private fadedStyles = new Map<string, DeepPartial<OverlayStyle> | null | undefined>();
  // Current chart resolution (e.g. "1", "5", "60", "1D"). Drives per-drawing
  // interval visibility (extendData.visibility). Set by ChartCore on every period
  // change and once after rehydrate.
  private resolution = "";
  // Instrument price precision (decimals). Set by ChartCore in lockstep with the
  // chart's setPriceVolumePrecision, and used to quantize alert levels so a stored
  // level matches what every `.toFixed(precision)` label renders (no raw float from
  // a cursor-pixel conversion or a line drag). null until known → we skip rounding
  // rather than risk mangling a high-precision instrument with the wrong default.
  private pricePrecision: number | null = null;
  // Echo guard: suppress persistence while we programmatically rebuild overlays.
  private hydrating = false;
  // Re-entrancy guard for reconcileAlerts: its removeOverlay/notifyAlerts churn
  // synchronously re-fires the alerts signal this cell is subscribed to, so the
  // method can recurse into itself; bail on re-entry (see reconcileAlerts).
  private reconciling = false;
  // The epic whose overlays `entries` currently reflect — set ONLY by rehydrate().
  // setEpic() changes `this.epic` synchronously but the old epic's overlays linger
  // until the async data load + rehydrate(); persist() bails while these disagree so
  // a stray overlay edit in that window can't write the OLD epic's alerts under the
  // NEW epic's (now GLOBAL, shared, mirrored) alert key. null until first rehydrate.
  private hydratedEpic: string | null = null;
  private rightClick: ((e: OverlayEvent) => void) | null = null;
  private alertsListener: (() => void) | null = null;
  // ChartCore subscribes to react to drawing selection changes (clear keyboard
  // focus targets, repaint), independent of the alert listener.
  private drawingListener: (() => void) | null = null;

  attach(chart: Chart): void {
    this.chart = chart;
  }
  detach(): void {
    this.chart = null;
    this.entries.clear();
    this.alertCfg.clear();
    this.alertIds.clear();
    this.alertCreatedAt.clear();
    this.fadedStyles.clear();
    this.hoveredAlertId = null;
    this.selectedAlertId = null;
    this.hoveredDrawingId = null;
    this.selectedDrawingId = null;
    this.draggingAlert = false;
    this.draggingAlertId = null;
    this.drawingInProgress = false;
    this.hydratedEpic = null;
  }
  setEpic(epic: string): void {
    this.epic = epic;
    // Leave hydratedEpic stale until rehydrate() rebuilds for the new epic — that's
    // what gates persist() during the symbol-change data-load window (see field).
  }
  setScope(scope: string): void {
    this.scope = scope;
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
  // Keep in lockstep with the chart's setPriceVolumePrecision (ChartCore's
  // effPrecision effect) so alert-level rounding uses the same decimals the axis does.
  setPricePrecision(precision: number): void {
    this.pricePrecision = precision;
  }
  // Quantize an alert level to the instrument precision. The numeric form of what
  // `.toFixed(precision)` renders, so the stored level === the displayed level
  // everywhere. Unknown precision → return raw (don't round to a wrong default).
  private roundLevel(level: number): number {
    return this.pricePrecision == null ? level : Number(level.toFixed(this.pricePrecision));
  }
  setRightClickHandler(fn: ((e: OverlayEvent) => void) | null): void {
    this.rightClick = fn;
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
  private notifyAlerts(): void {
    this.alertsListener?.(); // ChartCore: redraw on-chart axis pills
    bumpAlerts(); // alerts sidebar: re-pull the live list (add / delete / drag)
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
    this.chart?.overrideOverlay({ id, points: [{ value: rawLevel }] });
    this.notifyAlerts();
  }
  endAlertDrag(id: string): void {
    this.draggingAlert = false;
    this.draggingAlertId = null;
    // Quantize the raw cursor-pixel price to instrument precision before persisting,
    // so the stored level matches the rendered pill (mirrors onPressedMoveEnd).
    const raw = this.chart?.getOverlayById(id)?.points?.[0]?.value;
    if (raw != null) {
      const rounded = this.roundLevel(raw);
      if (rounded !== raw) this.chart?.overrideOverlay({ id, points: [{ value: rounded }] });
    }
    this.persist();
    this.notifyAlerts();
  }

  // True while an interactive drawing is mid-creation (a Draw tool is armed and
  // collecting click points). ChartCore's lock hover-align reads this so moving the
  // cursor to place a drawing's points doesn't also re-anchor the other charts. Set
  // when addDrawing is called without points (interactive), cleared on the overlay's
  // onDrawEnd (completed) or onRemoved (cancelled).
  private drawingInProgress = false;
  isDrawing(): boolean {
    return this.drawingInProgress;
  }

  // Apply an alert line's resting/emphasized weight. A line is emphasized (thick)
  // while it is EITHER click-selected OR hovered (from the chart or the sidebar), so
  // this single rule keeps the two states from fighting — un-hovering a selected
  // line must not thin it, and deselecting a hovered line must not either.
  private applyAlertLineWeight(id: string | null): void {
    if (!id || !this.chart?.getOverlayById(id)) return;
    const emphasized = id === this.selectedAlertId || id === this.hoveredAlertId;
    this.chart.overrideOverlay({
      id,
      styles: { line: { size: emphasized ? ALERT_LINE_SELECTED_SIZE : ALERT_LINE_SIZE } },
    });
  }

  // Single source of truth for "which alert line is selected". ALL selection
  // paths route through here — klinecharts' onSelected/onDeselected AND the
  // sidebar row click — so the previously-selected line is always restored to its
  // resting weight before the new one is emphasized (a programmatic select never
  // makes klinecharts fire onDeselected on the previous one). Idempotent: a no-op
  // when the id is unchanged, so it's safe to call from any handler without looping.
  private setSelectedAlert(id: string | null): void {
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
  // Applied WITHOUT chart.setStyles(), which would run adjustPaneViewport(…, forceY=
  // true) and jolt the whole view; merging straight into the store skips that and the
  // crosshair repaints on the next mousemove. Falls back to setStyles if the private
  // store shape ever changes (klinecharts ^9.8).
  // Called by ChartCore when cursor enters/leaves the snap band (within ALERT_SNAP_PX).
  // Hides the klinecharts native horizontal line so ChartCore's own drawn line can
  // replace it at the snapped y without two lines appearing.
  setSuppressNativeLine(v: boolean): void {
    if (v === this.snapNativeSuppressed) return;
    this.snapNativeSuppressed = v;
    this.applyCrosshairForAlert();
  }

  private applyCrosshairForAlert(): void {
    const overAlert = this.hoveredAlertId != null || this.snapNativeSuppressed;
    const styles = {
      crosshair: {
        horizontal: { show: true, line: { show: !overAlert }, text: { show: !overAlert } },
      },
    };
    const store = (this.chart as unknown as { _chartStore?: { setOptions?: (o: unknown) => void } })
      ?._chartStore;
    if (store?.setOptions) store.setOptions({ styles });
    else this.chart?.setStyles(styles);
  }

  // --- drawing selection / hover ---------------------------------------------

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
    this.drawingListener?.();
  }
  // Live snapshot of a drawing (for copy / clone / the settings modal). Returns the
  // stable anchors + styles + name, by VALUE — safe to stash in a clipboard.
  getDrawing(id: string): {
    name: string;
    points: Array<{ timestamp?: number; value?: number }>;
    styles: DeepPartial<OverlayStyle> | null;
    lock: boolean;
    visible: boolean;
    zLevel: number;
    extendData: unknown;
  } | null {
    const ov = this.chart?.getOverlayById(id);
    if (!ov || this.entries.get(id) !== "drawing") return null;
    return {
      name: ov.name,
      points: (ov.points ?? []).map((p) => ({ timestamp: p.timestamp, value: p.value })),
      styles: this.canonicalStyles(id, ov) ?? null,
      lock: !!ov.lock,
      // INTENT, not the live (effective) flag — the overlay's `visible` is the
      // interval-filtered render state, but the checkbox + clone/paste/setExtend
      // all want what the user chose. See effectiveVisible / userVisible.
      visible: asDrawingExtra(ov.extendData).userVisible ?? true,
      zLevel: ov.zLevel ?? 0,
      extendData: ov.extendData,
    };
  }
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
      createdAt: number;
      hovered: boolean;
      active: boolean;
      selected: boolean;
    }> = [];
    for (const [id, kind] of this.entries) {
      if (kind !== "alert") continue;
      const level = this.chart.getOverlayById(id)?.points?.[0]?.value;
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
        createdAt: this.alertCreatedAt.get(id) ?? 0,
        hovered,
        active: hovered || dragging || id === this.selectedAlertId,
        selected: id === this.selectedAlertId,
      });
    }
    return out;
  }

  // The epic whose overlays are currently materialized (set only at the end of
  // rehydrate()). Navigation from the alerts sidebar uses this as the "safe to
  // select" gate: a freshly-mounted cell appears in App's ready map BEFORE
  // rehydrate runs, and a select fired then is wiped (rehydrate nulls
  // selectedAlertId). Callers wait until this matches the target epic.
  getHydratedEpic(): string | null {
    return this.hydratedEpic;
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
  // Persists + notifies; the alert keeps its stable id, so the background engine
  // sees the changed signature (level|condition|trigger) and re-arms + re-seeds it.
  toggleAlertTrigger(id: string): void {
    if (!this.chart || this.entries.get(id) !== "alert") return;
    const cfg = this.alertCfg.get(id);
    if (!cfg) return;
    this.alertCfg.set(id, { ...cfg, trigger: cfg.trigger === "once" ? "every" : "once" });
    this.persist();
    this.notifyAlerts();
  }

  // Shared create path: standard event wiring for every overlay we own.
  private create(
    kind: Kind,
    name: string,
    points?: SavedOverlay["points"],
    styles?: DeepPartial<OverlayStyle> | null,
    lock?: boolean,
    extra?: { visible?: boolean; zLevel?: number; extendData?: unknown },
  ): string | null {
    if (!this.chart) return null;
    const isAlert = kind === "alert";
    const isMeasure = kind === "measure";
    const id = this.chart.createOverlay({
      name,
      points: points as Overlay["points"],
      styles: styles ?? undefined,
      lock,
      visible: extra?.visible,
      zLevel: extra?.zLevel,
      extendData: extra?.extendData,
      // Alerts render their own TV-style axis label (DOM pill in ChartCore), so
      // suppress klinecharts' default y-axis value box to avoid a duplicate. For
      // drawings the price tag is on by default but user-toggleable (Visibility
      // tab) — honor extendData.priceLabels when present so rehydrate restores it.
      needDefaultYAxisFigure: isAlert || isMeasure ? false : asDrawingExtra(extra?.extendData).priceLabels ?? true,
      // Returning true marks the right-click handled, suppressing klinecharts'
      // default "delete on right-click" so our context menu can take over.
      onRightClick: (e) => {
        this.rightClick?.(e);
        return true;
      },
      onDrawEnd: () => {
        this.drawingInProgress = false;
        this.persist();
        if (isAlert) this.notifyAlerts();
        return false;
      },
      onPressedMoving: () => {
        if (isAlert) {
          this.draggingAlert = true;
          this.notifyAlerts(); // keep the label glued during a drag
        }
        return false;
      },
      onPressedMoveEnd: (e) => {
        // A drag leaves the alert line at a raw cursor-pixel price. Quantize it
        // back to the instrument precision BEFORE persisting, so the stored level
        // matches the rendered pill (and reconcileAlerts' String(level) key agrees).
        if (isAlert) {
          this.draggingAlert = false;
          this.draggingAlertId = null;
          const raw = e.overlay.points?.[0]?.value;
          if (raw != null) {
            const rounded = this.roundLevel(raw);
            if (rounded !== raw) this.chart?.overrideOverlay({ id: e.overlay.id, points: [{ value: rounded }] });
          }
        }
        this.persist();
        if (isAlert) this.notifyAlerts();
        return false;
      },
      onRemoved: (e) => {
        this.entries.delete(e.overlay.id);
        if (this.measureId === e.overlay.id) this.measureId = null;
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
          this.drawingListener?.();
        }
        if (!this.hydrating) this.persist();
        if (isAlert) this.notifyAlerts();
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
          this.drawingListener?.();
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
          this.drawingListener?.();
        }
        return false;
      },
    });
    if (typeof id !== "string") return null;
    this.entries.set(id, kind);
    return id;
  }

  // --- transient measure tool (TV ruler) ------------------------------------
  // Start a measurement at a single anchor (both points collapsed). Removes any
  // existing measure first — only one is live at a time. Created fully placed (not
  // interactive-draw), so it never fires onDrawEnd/persist.
  startMeasure(p: MeasurePoint): string | null {
    if (!this.chart) return null;
    this.clearMeasure();
    const id = this.create("measure", "measure", [p, p] as SavedOverlay["points"]);
    this.measureId = id;
    return id;
  }

  // Live-update the measurement's end point while the user drags.
  updateMeasure(p: MeasurePoint): void {
    if (!this.chart || !this.measureId) return;
    const start = this.chart.getOverlayById(this.measureId)?.points?.[0];
    if (!start) return;
    this.chart.overrideOverlay({ id: this.measureId, points: [start, p] });
  }

  // Discard the live measurement (next interaction / Esc / symbol change).
  clearMeasure(): void {
    if (this.measureId) this.chart?.removeOverlay(this.measureId); // onRemoved nulls measureId
    this.measureId = null;
  }

  hasMeasure(): boolean {
    return this.measureId != null;
  }

  // --- user actions (called by Toolbar / chart "+" menu) ---------------------

  // Place a drawing. With points it's created in place (e.g. a horizontal line
  // at a price from the "+" menu); without, klinecharts enters interactive draw.
  addDrawing(name: string, points?: SavedOverlay["points"]): string | null {
    // No points = interactive draw (klinecharts collects clicks until the figure is
    // complete). Flag it so a lock click-to-align doesn't fire on those clicks; the
    // onDrawEnd in create() clears it.
    if (!points) this.drawingInProgress = true;
    const id = this.create("drawing", name, points);
    if (id && points) this.persist(); // interactive draws persist via onDrawEnd
    else if (!id) this.drawingInProgress = false; // creation failed → don't get stuck
    return id;
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
    const id = this.create("drawing", spec.name, spec.points, spec.styles, spec.lock, {
      visible: spec.visible,
      zLevel: spec.zLevel,
      extendData: spec.extendData,
    });
    if (id) {
      this.persist();
      this.selectedDrawingId = id;
      this.drawingListener?.();
    }
    return id;
  }

  // --- drawing edits (called by the settings modal / context menu) ------------

  // Effective on-chart visibility = user intent AND the current interval is allowed AND
  // (auto-hide off OR the drawing spans >= minBars at the current resolution). Intent
  // and the model live in extendData so persist() reads intent without the filter
  // corrupting it. `pts` are the overlay's anchor points (for the bar-span check).
  private effectiveVisible(
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

  private resolveLineColor(styles: DeepPartial<OverlayStyle> | null | undefined): string {
    return (styles?.line as { color?: string } | undefined)?.color ?? this.DEFAULT_LINE_COLOR;
  }

  // The CANONICAL (unfaded) styles for a drawing — `ov.styles` while solid, or the
  // stashed pre-fade value while it's a ghost. `ov.styles` on a ghosted overlay holds
  // the faded rgba, so every reader that copies/persists a drawing's styles (persist,
  // getDrawing, setExtend) MUST go through this, or a clone/extend/save of a currently-
  // ghosted drawing would bake the faded color in as if it were the real one.
  private canonicalStyles(id: string, ov: Overlay): DeepPartial<OverlayStyle> | null | undefined {
    if (this.fadedStyles.has(id)) return this.fadedStyles.get(id);
    // klinecharts mutates `ov.styles` IN PLACE on overrideOverlay (verified empirically —
    // see cloneStyles above), and every caller here (getDrawing, setExtend, persist) wants
    // a snapshot "by value" that a later style edit must not retroactively corrupt. Clone
    // it so callers never alias the live, mutable object.
    return cloneStyles(ov.styles);
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
  private applyDisplay(id: string, ov: Overlay, extra: DrawingExtra): void {
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
      // MUST be a deep clone: klinecharts mutates an overlay's `styles` object in
      // place on overrideOverlay (verified empirically), so stashing `ov.styles` by
      // reference would let the very next line's fade() call corrupt this same
      // object — permanently baking the ghost color in as "canonical" and making
      // every later un-fade attempt restore the ghost color instead of the original.
      if (!wasFaded) this.fadedStyles.set(id, cloneStyles(ov.styles));
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
    const ov = this.chart?.getOverlayById(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), userVisible: visible };
    this.applyDisplay(id, ov, extra);
    this.persist();
  }

  // The per-timeframe visibility model for a drawing (TV Visibility tab).
  setVisibilityModel(id: string, model: VisibilityModel): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.chart?.getOverlayById(id);
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
    const ov = this.chart?.getOverlayById(id);
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
    const ov = this.chart?.getOverlayById(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), text };
    this.chart?.overrideOverlay({ id, extendData: extra });
    this.persist();
  }

  // Toggle the midpoint marker (custom-overlay feature). Same extendData path.
  setShowMiddle(id: string, on: boolean): void {
    if (this.entries.get(id) !== "drawing") return;
    const ov = this.chart?.getOverlayById(id);
    if (!ov) return;
    const extra: DrawingExtra = { ...asDrawingExtra(ov.extendData), showMiddle: on };
    this.chart?.overrideOverlay({ id, extendData: extra });
    this.persist();
  }

  // Record the chart's current resolution and re-derive every drawing's effective
  // visibility against it. A VIEW reaction (interval changed), not a user edit — so
  // it does NOT persist (persist samples intent from extendData, untouched here).
  setResolution(resolution: string): void {
    this.resolution = resolution;
    this.applyIntervalVisibility();
  }
  // The live chart resolution (e.g. "MINUTE_5"). Lets UI (the settings modal's
  // preset dropdown) read the current interval without re-deriving it.
  getResolution(): string {
    return this.resolution;
  }
  private applyIntervalVisibility(): void {
    if (!this.chart) return;
    for (const [id, kind] of this.entries) {
      if (kind !== "drawing") continue;
      const ov = this.chart.getOverlayById(id);
      if (!ov) continue;
      this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
    }
  }

  setLock(id: string, lock: boolean): void {
    this.chart?.overrideOverlay({ id, lock });
    this.persist();
  }

  // Move a drawing's anchor points (Coordinates tab). Points are {timestamp,value}.
  updatePoints(id: string, points: SavedOverlay["points"]): void {
    if (this.entries.get(id) !== "drawing") return;
    this.chart?.overrideOverlay({ id, points: points as Overlay["points"] });
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
      max = Math.max(max, this.chart.getOverlayById(oid)?.zLevel ?? 0);
    }
    this.chart.overrideOverlay({ id, zLevel: max + 1 });
    this.persist();
  }
  sendToBack(id: string): void {
    if (!this.chart || this.entries.get(id) !== "drawing") return;
    let min = 0;
    for (const [oid, kind] of this.entries) {
      if (kind !== "drawing") continue;
      min = Math.min(min, this.chart.getOverlayById(oid)?.zLevel ?? 0);
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
    const ov = this.chart.getOverlayById(id);
    if (!ov) return id;
    const TREND = new Set(["segment", "rayLine", "straightLine"]);
    if (!TREND.has(ov.name)) return id; // not a convertible trend line
    const target = mode === "none" ? "segment" : mode === "ray" ? "rayLine" : "straightLine";
    if (target === ov.name) return id;
    const spec = {
      name: target,
      points: (ov.points ?? []).map((p) => ({ timestamp: p.timestamp, value: p.value })),
      // The CANONICAL style, never the faded ghost color — the recreated overlay must
      // look identical to the (possibly currently-ghosted) original, not bake the fade
      // in as if it were the real one (see canonicalStyles/fadedStyles).
      styles: this.canonicalStyles(id, ov) ?? null,
      lock: !!ov.lock,
      zLevel: ov.zLevel ?? 0,
      extendData: ov.extendData,
    };
    // Remove + recreate under the hydrating guard so the transient remove doesn't
    // persist an empty intermediate state; persist once after.
    const newId = this.guarded(() => {
      this.chart!.removeOverlay(id); // onRemoved drops entries + any stashed fadedStyles
      this.entries.delete(id);
      return this.create("drawing", spec.name, spec.points, spec.styles, spec.lock, {
        zLevel: spec.zLevel,
        extendData: spec.extendData,
      });
    });
    if (newId) {
      // Re-derive visible/faded for the new id from the current resolution (rather
      // than carrying over the OLD overlay's live `visible`/style verbatim) so a
      // ghosted drawing extends as a ghost, not a solid one.
      const newOv = this.chart.getOverlayById(newId);
      if (newOv) this.applyDisplay(newId, newOv, asDrawingExtra(newOv.extendData));
      this.selectedDrawingId = newId;
      this.persist();
      this.drawingListener?.();
    }
    return newId;
  }

  // Create a configured price alert (from the modal). Draggable priceLine. Mints a
  // fresh stable id now, so the alert keeps one identity across drags and edits.
  addAlert(level: number, cfg: AlertConfig): string | null {
    level = this.roundLevel(level);
    const id = this.create("alert", "priceLine", [{ value: level }], ALERT_LINE_STYLE);
    if (id) {
      this.alertCfg.set(id, cfg);
      this.alertIds.set(id, newAlertId());
      this.alertCreatedAt.set(id, Date.now());
      this.persist();
      this.notifyAlerts();
    }
    return id;
  }

  // Edit an existing alert (from the edit modal). Moves the line to `level` and
  // replaces its config. The stable id is unchanged, so the engine sees the same
  // alert with a new signature and re-arms + re-seeds its baseline itself — a
  // changed level/condition can fire again, with no spurious crossing off the move.
  updateAlert(id: string, level: number, cfg: AlertConfig): void {
    if (!this.chart || this.entries.get(id) !== "alert") return;
    level = this.roundLevel(level);
    this.chart.overrideOverlay({ id, points: [{ value: level }] });
    this.alertCfg.set(id, cfg);
    this.persist();
    this.notifyAlerts();
  }

  // Live config for one alert (level + cfg), for prefilling the edit modal.
  getAlert(id: string): { level: number; cfg: AlertConfig } | null {
    if (!this.chart || this.entries.get(id) !== "alert") return null;
    const raw = this.chart.getOverlayById(id)?.points?.[0]?.value;
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

  remove(id: string): void {
    this.chart?.removeOverlay(id); // onRemoved unregisters + persists
  }

  // Full resync of this cell's alert lines to storage, matched by STABLE id (not by
  // value — two alerts can share a level, and a dragged line would otherwise
  // self-match the wrong row). Called on the alerts signal, which fires when ANYONE
  // changes the epic's (now GLOBAL) alert list: the background engine removing a
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
        // Drop overlays no longer in storage (engine removed / peer cell deleted).
        for (const [id, kind] of [...this.entries]) {
          if (kind !== "alert") continue;
          const aid = this.alertIds.get(id);
          if (aid == null || !savedById.has(aid)) {
            this.chart!.removeOverlay(id); // onRemoved cleans the id maps + entries
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
          const ov = this.chart!.getOverlayById(ovId);
          if (ov && ov.points?.[0]?.value !== a.level) {
            this.chart!.overrideOverlay({ id: ovId, points: [{ value: a.level }] });
            changed = true;
          }
          const cfg = this.alertCfg.get(ovId);
          if (!cfg || !sameAlertCfg(cfg, a)) {
            this.alertCfg.set(ovId, this.cfgFromSaved(a));
            changed = true;
          }
          this.alertCreatedAt.set(ovId, a.createdAt ?? 0);
        }
      });
      if (changed) this.notifyAlerts();
    } finally {
      this.reconciling = false;
    }
  }

  clearDrawings(): void {
    for (const [id, kind] of this.entries) {
      if (kind === "drawing") this.chart?.removeOverlay(id);
    }
  }

  unlockAll(): void {
    for (const id of this.entries.keys()) {
      this.chart?.overrideOverlay({ id, lock: false });
    }
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
      const ov = this.chart?.getOverlayById(id);
      if (ov) this.applyDisplay(id, ov, asDrawingExtra(ov.extendData));
    } else {
      this.chart?.overrideOverlay({ id, styles });
    }
    this.persist();
  }

  // Run a block with the echo guard on, so programmatic remove/create inside it
  // does NOT re-persist a transient intermediate state. Returns the block's value.
  private guarded<T>(fn: () => T): T {
    this.hydrating = true;
    try {
      return fn();
    } finally {
      this.hydrating = false;
    }
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
    };
  }

  // Materialise a saved alert row as this cell's on-chart line and register its id
  // maps. The ONE place a SavedAlert becomes an overlay — shared by rehydrate (full
  // rebuild) and reconcileAlerts (a peer cell added it), so both render identically.
  // Returns the overlay id, or null if create() declined (e.g. no chart).
  private materializeSavedAlert(a: SavedAlert): string | null {
    const id = this.create("alert", "priceLine", [{ value: a.level }], ALERT_LINE_STYLE);
    if (!id) return null;
    this.alertCfg.set(id, this.cfgFromSaved(a));
    // Carry the stored stable id (normalizeAlert backfills legacy rows). The next
    // persist() writes it back explicitly, locking a backfilled id.
    this.alertIds.set(id, a.id);
    this.alertCreatedAt.set(id, a.createdAt ?? 0);
    return id;
  }

  // --- rehydration (called by ChartCore after applyNewData) ------------------

  // Rebuild this epic's overlays. Must run AFTER data is loaded so timestamped
  // points map onto the timescale. Guarded so the rebuild doesn't re-persist.
  rehydrate(): void {
    if (!this.chart) return;
    // Remember WHICH alert was selected by its stable saved id (not the overlay id,
    // which this rebuild re-mints). A same-epic rehydrate — a live data refresh, or
    // React's dev double-mount — must not silently drop the user's (or a navigation's)
    // selection; we re-select the line that still carries this saved id below.
    const prevSelectedSavedId =
      this.selectedAlertId != null ? this.alertIds.get(this.selectedAlertId) ?? null : null;
    this.hydrating = true;
    try {
      for (const id of [...this.entries.keys()]) this.chart.removeOverlay(id);
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

      for (const d of loadDrawings(this.scope, this.epic)) {
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
        this.create("drawing", d.name, d.points, d.styles, d.lock, {
          visible: this.effectiveVisible(extra, d.points),
          zLevel: d.zLevel,
          extendData: extra,
        });
      }
      // Repaint any drawing that loaded on a filtered interval as a ghost stub (rather
      // than the plain effectiveVisible above, which would leave it invisible) — so a
      // reload on e.g. a minute chart still shows a faint, clickable stand-in.
      this.applyIntervalVisibility();
      const rawAlerts = loadAlerts(this.epic, this.broker || undefined);
      for (let ai = 0; ai < rawAlerts.length; ai++) {
        this.materializeSavedAlert(normalizeAlert(rawAlerts[ai], ai));
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
      this.hydrating = false;
    }
    this.notifyAlerts();
  }

  // NOTE: alert FIRING moved to the background alertEngine (the single authority
  // across all tabs). This module now only renders/persists alert lines; the
  // engine evaluates ticks (via the shared evaluateAlert) and calls
  // reconcileAlerts() through the alerts signal to drop lines it removed.

  // --- persistence -----------------------------------------------------------

  private persist(): void {
    if (this.hydrating || !this.chart) return;
    // Guard the symbol-change window: setEpic() advanced this.epic but the old
    // epic's overlays are still in `entries` until rehydrate() rebuilds. Writing now
    // would save the OLD overlays under the NEW epic's shared global alert key.
    if (this.hydratedEpic !== this.epic) return;
    const drawings: SavedOverlay[] = [];
    const alerts: SavedAlert[] = [];
    for (const [id, kind] of this.entries) {
      if (kind === "measure") continue; // transient ruler — never persisted
      const ov = this.chart.getOverlayById(id);
      if (!ov) continue;
      if (kind === "alert") {
        const level = ov.points?.[0]?.value;
        if (level == null) continue;
        const cfg = this.alertCfg.get(id);
        // Reuse the alert's stable id; mint one only if somehow missing (keeps a
        // backfilled legacy id from drifting on the next save).
        let aid = this.alertIds.get(id);
        if (!aid) {
          aid = newAlertId();
          this.alertIds.set(id, aid);
        }
        alerts.push(normalizeAlert({ id: aid, level, ...cfg, createdAt: this.alertCreatedAt.get(id) ?? 0 }));
      } else {
        drawings.push({
          name: ov.name,
          // Persist only the stable anchors (timestamp/value). dataIndex is a
          // position into THIS session's dataList; after a refresh reloads a
          // shifted window it would point at the wrong bar, so drop it and let
          // klinecharts recompute it from the timestamp on rehydration.
          points: (ov.points ?? []).map((p) => ({
            timestamp: p.timestamp,
            value: p.value,
          })),
          // The stashed canonical style while this id is a ghost (faded interval/
          // auto-hide stub) — ov.styles is the FADED color in that state, and
          // persist() must never write that; see canonicalStyles/fadedStyles.
          styles: this.canonicalStyles(id, ov) ?? undefined,
          lock: ov.lock,
          // Persist INTENT, not the live (effective) flag — the overlay's `visible`
          // is interval-filtered, so reading it here would corrupt the user's choice
          // when they save while on a filtered interval. extendData carries intent.
          visible: asDrawingExtra(ov.extendData).userVisible ?? true,
          zLevel: ov.zLevel,
          extendData: ov.extendData,
        });
      }
    }
    saveDrawings(this.scope, this.epic, drawings);
    saveAlerts(this.epic, alerts, this.broker || undefined);
  }
}
