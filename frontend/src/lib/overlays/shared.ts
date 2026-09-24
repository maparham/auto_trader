// Module-level pieces of the overlay manager: the style helpers, the
// per-alert and per-drawing config types, the built-in default looks, and
// the alertPriceLine template (registered here, at import).
import {
  type PolygonType,
  type OverlayFigure,
  type OverlayTemplate,
  type DeepPartial,
  type OverlayStyle,
  registerOverlay,
} from "klinecharts";
import type { SavedAlert, AlertCondition, AlertTrigger, AlertNotifyChannels } from "../persist";
import type { VisibilityModel } from "../visibility";
import type { FibConfig } from "../fibConfig";
import { SELECT_GLOW_KEY } from "../touchHitSlop";
import type { TradeConfig } from "../tradePlan";
import { TRADE_BOX } from "../tradeOverlay";
import type { GhostFit, GhostPattern, GhostStyle } from "../patternGhost";

export type Kind = "drawing" | "alert" | "measure" | "rangeBand" | "slope";

// One-level-deep merge of a style patch onto a base style: for each top-level style
// category present in the patch (line, text, ...), shallow-merge its fields over the
// base's, so a partial category edit doesn't drop sibling fields the patch didn't
// mention. Mirrors the granularity every other style write in this file already uses
// (e.g. `{ line: { ...(styles?.line ?? {}), color: ... } }` in fade/unfade below).
export function mergeStyles(
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
  if (styles == null) return styles;
  const out = JSON.parse(JSON.stringify(styles)) as T & { line?: Record<string, unknown> };
  // The selection glow is a live-only marker (see syncSelectGlow); no
  // snapshot, and so nothing persisted, copied or cloned, may carry it.
  if (out.line && SELECT_GLOW_KEY in out.line) delete out.line[SELECT_GLOW_KEY];
  return out;
}

export interface AlertConfig {
  condition: AlertCondition;
  trigger: AlertTrigger;
  message: string;
  // Wall-clock expiry (ms, UTC) or null for open-ended. See SavedAlert.expiresAt.
  expiresAt?: number | null;
  // Which notification channels fire on trigger (absent = all on).
  notify?: AlertNotifyChannels;
  // Draw the line from the alert's creation time instead of across the whole
  // pane (absent = on). See alertPoints(). Cosmetic only — never sent to the
  // engine's firing signature.
  startAtCreation?: boolean;
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
  // Fib level/extend/… config (the custom fibonacciLine + fibChannel overlays).
  fib?: FibConfig;
  // The copied candles a pattern-overlay ("ghost") draws and scores, plus the
  // market and timeframe they came from (custom patternGhost overlay only).
  ghost?: GhostPattern;
  // Set once the user drags a ghost VERTICALLY: stop auto-aligning it to the
  // candles underneath. See the patternGhost template for why the two modes
  // exist.
  ghostPinned?: boolean;
  // The placement a pinned ghost keeps: the mean and sd its shape is stretched
  // onto. A pin freezes the whole affine map, not just a price — anchoring by
  // price alone kept the position but swapped the SCALE, so a 4px nudge could
  // resize the ghost several-fold on release.
  ghostFit?: GhostFit;
  // How the ghost is painted (shape, opacity, colour, whether the score shows).
  // Absent on ghosts pasted before the settings panel existed; asGhostStyle
  // reads that back as the look they already had.
  ghostStyle?: GhostStyle;
  // Label groups + account overrides for a Trade box drawing (tradeBox).
  // Absent on a freshly drawn one — asTradeConfig fills the defaults.
  trade?: TradeConfig;
}

// The trade-planning drawing: a three-point overlay whose third point (the stop)
// is synthesized once the two-click draw completes.
export const isTradeDrawing = (name: string): boolean => name === TRADE_BOX;

// The pattern-overlay's klinecharts name (see customOverlays' patternGhost).
export const GHOST_NAME = "patternGhost";
// A drag that moves the ghost less than this vertically was aimed along the time
// axis: keep auto-aligning rather than pinning it on a stray pixel or two.
export const GHOST_PIN_PX = 3;

// Narrow unknown extendData to our shape (never throws; non-objects → {}).
export function asDrawingExtra(v: unknown): DrawingExtra {
  return v && typeof v === "object" ? (v as DrawingExtra) : {};
}

// Every notify channel, so a comparison can't silently skip one. Push and
// telegram are BACKEND-delivered but still per-alert config the modal edits, so
// they belong here exactly like the three in-tab channels.
const NOTIFY_CHANNELS = ["toast", "browser", "sound", "push", "telegram"] as const;

// True when a cell's cached alert config already matches a saved row — every
// firing-relevant field PLUS the notify channels (absent channel = on). Used by
// reconcileAlerts to decide whether a peer's edit needs pulling in; omitting notify
// here lets a notify-only edit drift and get reverted on this cell's next persist().
export function sameAlertCfg(cfg: AlertConfig, a: SavedAlert): boolean {
  return (
    cfg.condition === a.condition &&
    cfg.trigger === a.trigger &&
    cfg.message === a.message &&
    (cfg.expiresAt ?? null) === (a.expiresAt ?? null) &&
    (cfg.startAtCreation ?? true) === (a.startAtCreation ?? true) &&
    NOTIFY_CHANNELS.every((ch) => (cfg.notify?.[ch] ?? true) === (a.notify?.[ch] ?? true))
  );
}



const ALERT_LINE_COLOR = "#f5a623";
export const ALERT_LINE_SIZE = 1;
export const ALERT_LINE_SELECTED_SIZE = 2; // slightly thicker while click-selected
// Dashed alert line (distinct from the dotted last-price line). We render our
// own TV-style axis tag on the right, so the text style is fully transparent to
// suppress klinecharts' default click-selected y-axis value pill (gated by
// needDefaultYAxisFigure, styled by `text`).
const HIDDEN_TEXT = {
  color: "transparent",
  backgroundColor: "transparent",
  borderColor: "transparent",
  size: 0,
};
export const ALERT_LINE_STYLE: DeepPartial<OverlayStyle> = {
  line: { color: ALERT_LINE_COLOR, style: 'dashed', dashedValue: [4, 4], size: ALERT_LINE_SIZE },
  text: HIDDEN_TEXT,
};

// Alert lines default to starting at the alert's creation bar (see alertPoints),
// so mid-pane the dashed stroke just begins — a bare cut edge that reads as a
// paint glitch. `alertPriceLine` is the built-in `priceLine`'s line figure
// (identical geometry: point x to the right edge) plus a small filled dot at the
// anchor, marking the start as intentional. Differences from the built-in: the
// hardcoded value `text` figure at the left end is dropped (it was painted with
// HIDDEN_TEXT anyway). The dot only appears when the line is actually anchored
// to a bar — a value-only point (startAtCreation off / legacy createdAt 0)
// resolves to x=0 and spans the pane — and is skipped at x<=0, where a
// clamped older-than-history anchor reads as full-width too.
const alertPriceLine: OverlayTemplate = {
  name: "alertPriceLine",
  totalStep: 2,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ overlay, coordinates, bounding }) => {
    const c = coordinates[0];
    if (!c) return [];
    // Hovered/selected (applyAlertLineWeight sets extendData.fullWidth): span the
    // whole pane so the level is readable across all history; the anchor dot
    // below stays at the creation bar. Resting: start at the anchor.
    const fullWidth = (overlay.extendData as { fullWidth?: boolean } | null)?.fullWidth === true;
    const start = fullWidth ? { x: 0, y: c.y } : c;
    const figures: OverlayFigure[] = [
      { type: "line", attrs: { coordinates: [start, { x: bounding.width, y: c.y }] } },
    ];
    const line = overlay.styles?.line;
    if (overlay.points[0]?.timestamp != null && c.x > 0) {
      figures.push({
        type: "circle",
        // Scales with the selected-state line thickness (r 3 idle, 4 selected).
        attrs: { x: c.x, y: c.y, r: 2 + (line?.size ?? ALERT_LINE_SIZE) },
        styles: { style: "fill", color: line?.color ?? ALERT_LINE_COLOR },
        // Don't let the dot swallow drags meant for the line.
        ignoreEvent: true,
      });
    }
    return figures;
  },
};
// Module-scope on purpose: alerts materialize in every boot mode that imports
// this manager (App, SnapshotApp), not only where registerCustomOverlays runs.
registerOverlay(alertPriceLine);

// Built-in default look for a fresh rectangle (no saved default yet): translucent
// accent fill + solid border. Reuses the app accent used by rangeBand. Overridable
// per-instance in the settings modal and via "set as default".
export const RECT_DEFAULT_STYLE: DeepPartial<OverlayStyle> = {
  polygon: { style: "stroke_fill" as PolygonType, color: "rgba(41, 98, 255, 0.12)", borderColor: "#2962ff", borderSize: 1 },
};

// Built-in default look for a fresh time-range highlight (no saved default yet):
// translucent accent fill + solid border, same accent family as rect/rangeBand.
// Overridable per-instance and via "set as default" (per-overlay-name).
export const TIME_RANGE_DEFAULT_STYLE: DeepPartial<OverlayStyle> = {
  polygon: { style: "stroke_fill" as PolygonType, color: "rgba(41, 98, 255, 0.10)", borderColor: "#2962ff", borderSize: 1 },
};

// The two strengths of the "Find similar" match bands. Same accent hue as
// rangeBand (rgb(41, 98, 255)); the matched candles get rangeBand's own alphas,
// and the aftermath band is that scaled by ~0.45 — the opacity the row preview
// already dims its forward candles to (.pm-fwd in App.css) — so the list and the
// chart read the same way.
export const MATCH_BAND_STYLE: DeepPartial<OverlayStyle> = {
  polygon: { style: "stroke_fill" as PolygonType, color: "rgba(41, 98, 255, 0.12)", borderColor: "rgba(41, 98, 255, 0.7)", borderSize: 1 },
};
export const MATCH_FWD_BAND_STYLE: DeepPartial<OverlayStyle> = {
  polygon: { style: "stroke_fill" as PolygonType, color: "rgba(41, 98, 255, 0.05)", borderColor: "rgba(41, 98, 255, 0.32)", borderSize: 1 },
};
