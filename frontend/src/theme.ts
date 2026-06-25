// App-level settings, persisted via persist.ts (so they mirror to the backend and
// sync across devices like the rest of the workspace). Theme drives both the CSS
// variables (via data-theme on <html>) and the chart colors (lightweight-charts
// doesn't read CSS, so Chart applies these explicitly).

import type { LineStyleOpt } from "./ColorLineStylePicker";
import type { AlertCondition, AlertTrigger } from "./lib/persist";
import { loadSettingsRaw, saveSettingsRaw } from "./lib/persist";

export type Theme = "dark" | "light";

// How the time axis renders the clock and the date. "24h" + "ymd" is
// klinecharts' built-in format (byte-for-byte), so it's the default.
export type Clock = "24h" | "12h";
export type DateFormat = "ymd" | "dmy" | "mdy" | "med";

// Which side of the spread candles are drawn from. "mid" (bid/ask midpoint) is
// our default; "bid" matches the capital.com platform (it draws the sell price);
// "ask" is the buy price. Global — applies to every chart, live + history.
export type PriceSide = "bid" | "mid" | "ask";

// Live bid & ask display (TradingView's "Bid and ask price lines"), independent
// of PriceSide. "off" = nothing; "labels" = colored Bid/Ask pills on the price
// axis; "lines" = those pills plus dashed horizontal lines across the chart.
export type BidAsk = "off" | "labels" | "lines";

// Appearance of the bid & ask lines/labels. Colors drive both the axis labels and
// (in "lines" mode) the horizontal lines; `opacity` and `lineStyle` apply to the
// LINES only — labels stay opaque for readability (TradingView does the same).
export interface BidAskStyle {
  bidColor: string;
  askColor: string;
  opacity: number; // 0..1, lines only
  lineStyle: "solid" | "dashed" | "dotted";
}

// Appearance of the chart crosshair lines (the horizontal/vertical guides that
// track the cursor). `color` is a sentinel: "" means "follow the theme" (the muted
// textDim, recolored on theme switch); a hex overrides it. `opacity` (0..1) is
// folded into the color when drawn, since klinecharts lines have no opacity field.
export interface CrosshairStyle {
  lineStyle: LineStyleOpt;
  color: string;
  opacity: number;
}

// Defaults a freshly-created alert inherits (set in Settings → Alerts). Expiry is
// stored as one of three intents so the modal can show the same choice the user
// picked: open-ended, a relative duration (re-anchored to "now" at create time), or
// a fixed wall-clock time.
export type AlertExpiry =
  | { kind: "open" }
  | { kind: "duration"; ms: number }
  | { kind: "datetime"; at: number };

export interface AlertNotify {
  toast: boolean;
  browser: boolean;
  sound: boolean;
}

export interface AlertDefaults {
  condition: AlertCondition;
  trigger: AlertTrigger;
  expiry: AlertExpiry;
  notify: AlertNotify;
}

export interface Settings {
  theme: Theme;
  // IANA timezone name (e.g. "America/New_York") the chart's time axis renders
  // in, or "" to follow the browser's local timezone (klinecharts' default).
  timezone: string;
  // Time-axis timestamp format (ticks + crosshair label).
  clock: Clock;
  dateFormat: DateFormat;
  // Prefix day-granularity timestamps with the weekday ("Fri 2026-07-10"),
  // orthogonal to dateFormat. Off by default so the default preset stays
  // byte-for-byte identical to klinecharts' built-in formatter.
  showWeekday: boolean;
  // Which side of the spread candles render from (bid/mid/ask). Global.
  priceSide: PriceSide;
  // Live bid & ask display: off / axis labels / labels + lines. Global.
  bidAsk: BidAsk;
  // Colors / line opacity / line style for the bid & ask display. Global.
  bidAskStyle: BidAskStyle;
  // Appearance of the crosshair guide lines. Global.
  crosshair: CrosshairStyle;
  // Defaults applied to new alerts (Settings → Alerts tab).
  alertDefaults: AlertDefaults;
}

export const DEFAULT_ALERT_DEFAULTS: AlertDefaults = {
  condition: "crossing",
  trigger: "once",
  expiry: { kind: "open" },
  notify: { toast: true, browser: true, sound: true },
};

// Dashed, black at half opacity (so it reads as a muted grey over the chart) at the
// default less-dense spacing. A picked color overrides; "" would follow the theme.
export const DEFAULT_CROSSHAIR: CrosshairStyle = {
  lineStyle: "dashed",
  color: "#000000",
  opacity: 0.5,
};

// TradingView's bid (blue) / ask (red), drawn as faint dotted lines (opacity 0.5)
// so they read as a light guide rather than competing with the candles.
export const DEFAULT_BID_ASK_STYLE: BidAskStyle = {
  bidColor: "#2962ff",
  askColor: "#f23645",
  opacity: 0.5,
  lineStyle: "dotted",
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  timezone: "",
  clock: "24h",
  dateFormat: "ymd",
  showWeekday: true,
  priceSide: "mid",
  bidAsk: "off",
  bidAskStyle: DEFAULT_BID_ASK_STYLE,
  crosshair: DEFAULT_CROSSHAIR,
  alertDefaults: DEFAULT_ALERT_DEFAULTS,
};

export function loadSettings(): Settings {
  const stored = loadSettingsRaw<Partial<Settings>>({});
  // Shallow-merge over defaults, then deep-merge alertDefaults so a settings blob
  // saved before alertDefaults existed (or with only some keys) is fully populated.
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    crosshair: { ...DEFAULT_CROSSHAIR, ...(stored.crosshair ?? {}) },
    alertDefaults: {
      ...DEFAULT_ALERT_DEFAULTS,
      ...(stored.alertDefaults ?? {}),
      notify: {
        ...DEFAULT_ALERT_DEFAULTS.notify,
        ...(stored.alertDefaults?.notify ?? {}),
      },
    },
  };
}

export function saveSettings(s: Settings): void {
  saveSettingsRaw(s);
}

// Chart palette per theme (candle up/down green/red read fine on both).
export const chartColors: Record<
  Theme,
  { bg: string; text: string; textDim: string; axisText: string; grid: string; border: string }
> = {
  // axisText is a muted grey (not the near-white `text`): at 12px on the price/
  // time axes that reads thin-yet-clear like TradingView, where bright white
  // "blooms" and looks heavy.
  dark: { bg: "#101418", text: "#d1d4dc", textDim: "#8a93a0", axisText: "#b2b5be", grid: "#1c2127", border: "#2a2f36" },
  light: { bg: "#ffffff", text: "#1f2933", textDim: "#5a6573", axisText: "#787b86", grid: "#eef1f5", border: "#cfd6df" },
};
