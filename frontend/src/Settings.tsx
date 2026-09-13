// App settings modal. Tabbed: "General" (theme + time formatting) and "Alerts"
// (defaults a freshly-created alert inherits). Structured so more tabs/rows drop in.

import { useEffect, useMemo, useState } from "react";
import CloseButton from "./CloseButton";
import NotificationSettings from "./NotificationSettings";
import { isDemoMode } from "./lib/demoMode";
import { useIsAdmin } from "./admin/useIsAdmin";
import { getLastBacktestResult } from "./lib/lastBacktestResult";
import {
  publishDemo,
  fetchDemoLive,
  fetchCurrentDemo,
  type DemoLive,
} from "./lib/demoPublish";
import { describeDemoLayout } from "./lib/demoSnapshot";
import { enterDemoPreview } from "./lib/demoPreview";

// Demo layout payload ceilings, in bytes of captured JSON. A visitor's
// localStorage holds roughly 5 MB and seedDemoLayout cannot report a quota
// failure, so warn well before that and refuse past WARN's double.
const DEMO_BYTES_WARN = 1_500_000;
const DEMO_BYTES_MAX = 3_000_000;
const fmtBytes = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.round(n / 1000)} KB`;
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import type {
  AlertDefaults,
  AlertExpiry,
  BidAsk,
  Clock,
  DateFormat,
  PriceSide,
  Settings,
  Theme,
} from "./theme";
import type { AlertCondition, AlertTrigger } from "./lib/persist";
import type { GoLivePillPos } from "./lib/liveEdge";
import { chartColors, LEVERAGE_TYPES } from "./theme";
import ColorLineStylePicker, { type LineStyleOpt } from "./ColorLineStylePicker";
import { useDraggable } from "./lib/useDraggable";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import { TIMEZONES, offsetLabel } from "./lib/timezones";
import { CONDITIONS, DURATION_PRESETS } from "./lib/alertUi";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  // Deep-link target: which tab to open on (e.g. the alert modal's
  // "notification settings" shortcut lands on "alerts").
  initialTab?: Tab;
}

type Tab = "general" | "alerts" | "trading" | "demo";

const THEMES: Theme[] = ["dark", "light"];
const CLOCKS: { value: Clock; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "12h", label: "12h" },
];
// Labels are the same sample date (Fri Jul 10 2026) rendered each way.
const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: "ymd", label: "2026-07-10" },
  { value: "dmy", label: "10/07/2026" },
  { value: "mdy", label: "07/10/2026" },
  { value: "med", label: "Jul 10 '26" },
];

// Which side of the spread candles draw from. "bid" matches the capital.com
// platform (it plots the sell price); "mid" is the bid/ask midpoint; "ask" is buy.
const PRICE_SIDES: { value: PriceSide; label: string }[] = [
  { value: "bid", label: "Bid" },
  { value: "mid", label: "Mid" },
  { value: "ask", label: "Ask" },
];

// Live bid & ask display, like TradingView's "Bid and ask price lines".
const BID_ASK: { value: BidAsk; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "labels", label: "Labels" },
  { value: "lines", label: "Lines" },
];

// Where the jump-to-end pill parks on the chart (lib/liveEdge.ts). Each
// option renders as a mini chart glyph — frame + time/price axes — with the
// pill drawn where that placement puts it; the label lives in the tooltip.
const GOLIVE_POSITIONS: { value: GoLivePillPos; label: string; pill: JSX.Element }[] = [
  {
    value: "axis",
    label: "Above the time axis",
    pill: <rect x="6" y="9" width="6" height="2.6" rx="1.3" fill="currentColor" stroke="none" />,
  },
  {
    value: "topRight",
    label: "Top right of the chart",
    pill: <rect x="6" y="2.6" width="6" height="2.6" rx="1.3" fill="currentColor" stroke="none" />,
  },
  {
    value: "priceLine",
    label: "On the Price line",
    pill: (
      <>
        <line x1="1" y1="7.2" x2="14" y2="7.2" strokeDasharray="1.6 1.6" />
        <rect x="6" y="5.9" width="6" height="2.6" rx="1.3" fill="currentColor" stroke="none" />
      </>
    ),
  },
];

// The glyph's shared chart furniture: outer frame, time axis along the bottom,
// price axis down the right — so the pill rect reads as a position, not a shape.
function GoLiveGlyph({ pill }: { pill: JSX.Element }) {
  return (
    <svg
      className="golive-glyph"
      viewBox="0 0 18 14"
      width="18"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
    >
      <rect x="0.5" y="0.5" width="17" height="13" rx="1.5" />
      <line x1="14.5" y1="0.5" x2="14.5" y2="13.5" />
      <line x1="0.5" y1="12.5" x2="14.5" y2="12.5" />
      {pill}
    </svg>
  );
}

const TRIGGERS: { value: AlertTrigger; label: string }[] = [
  { value: "once", label: "Once only" },
  { value: "every", label: "Every time" },
];

export default function SettingsModal({ settings, onChange, onClose, initialTab }: Props) {
  const drag = useDraggable();
  const [tab, setTab] = useState<Tab>(initialTab ?? "general");
  useCloseOnEscape(onClose);
  // Same authority the Clerk account menu's Admin entry uses (Toolbar.tsx):
  // the server is the only source of truth on admin-ness. Skipped entirely in
  // demo mode so an anonymous visitor's Settings never probes /api/admin/*
  // with no session.
  const isAdmin = useIsAdmin(!isDemoMode());

  const ad = settings.alertDefaults;
  const setAd = (patch: Partial<AlertDefaults>) =>
    onChange({ ...settings, alertDefaults: { ...ad, ...patch } });

  const ba = settings.bidAskStyle;
  const setBA = (patch: Partial<typeof ba>) =>
    onChange({ ...settings, bidAskStyle: { ...ba, ...patch } });

  const tr = settings.trading;
  const setTr = (patch: Partial<typeof tr>) =>
    onChange({ ...settings, trading: { ...tr, ...patch } });

  // Public demo publishing (admin-only, see the "demo" tab below). watchlist
  // is edited as free text and parsed on publish/blur; staged holds captured
  // backtests until Publish sends them along with the CURRENT workspace
  // layout (demoPublish.ts's publishDemo captures that itself). Publish
  // REPLACES the whole published payload server-side, so opening the tab
  // prefills watchlist/staged from whatever is currently live
  // (fetchCurrentDemo) rather than starting blank. Otherwise Publish would
  // silently wipe anything published in an earlier session.
  const [demoWatchlist, setDemoWatchlist] = useState("");
  const [demoCaptureName, setDemoCaptureName] = useState("");
  const [demoStaged, setDemoStaged] = useState<{ name: string; result: unknown }[]>([]);
  const [demoCaptureNotice, setDemoCaptureNotice] = useState<string | null>(null);
  // There is one live demo, replaced by the next publish - no version history
  // in this panel (an append-only list with a "roll back" that appended yet
  // another row read as a bug). This is the newest store row, purely so the
  // panel can say when what visitors see went out.
  const [demoLive, setDemoLive] = useState<DemoLive | null>(null);
  const [demoLoadError, setDemoLoadError] = useState<string | null>(null);
  const [demoLoaded, setDemoLoaded] = useState(false);
  const [demoPublishing, setDemoPublishing] = useState(false);
  const [demoPublishError, setDemoPublishError] = useState<string | null>(null);
  const [demoJustPublished, setDemoJustPublished] = useState(false);
  // Set by the first refusal of a content-less layout; a second Publish click
  // goes through (see publishDemoStaged).
  const [demoBareOk, setDemoBareOk] = useState(false);
  // Recomputed whenever the tab is (re)opened: it reads localStorage, and the
  // admin may have saved a layout since the modal last rendered.
  const demoLayout = useMemo(
    () => (tab === "demo" && isAdmin ? describeDemoLayout() : { count: 0, defaultName: null }),
    [tab, isAdmin],
  );

  const loadDemoLive = () => {
    fetchDemoLive()
      .then((live) => {
        setDemoLive(live);
        setDemoLoadError(null);
      })
      .catch((e) => setDemoLoadError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    if (tab !== "demo" || !isAdmin || demoLoaded) return;
    setDemoLoaded(true);
    loadDemoLive();
    fetchCurrentDemo()
      .then((current) => {
        setDemoWatchlist(current ? current.watchlist.join(", ") : "");
        setDemoStaged(current?.backtests ?? []);
        setDemoLoadError(null);
      })
      .catch((e) => setDemoLoadError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isAdmin, demoLoaded]);

  const captureDemoBacktest = () => {
    const result = getLastBacktestResult();
    if (result == null) {
      setDemoCaptureNotice("No completed backtest result to capture. Run one first.");
      return;
    }
    const name = demoCaptureName.trim();
    if (!name) {
      setDemoCaptureNotice("Name the backtest before capturing it.");
      return;
    }
    if (demoStaged.some((b) => b.name === name)) {
      setDemoCaptureNotice("A staged backtest already has that name. Use a different name.");
      return;
    }
    setDemoStaged((prev) => [...prev, { name, result }]);
    setDemoCaptureName("");
    setDemoCaptureNotice(null);
  };

  const publishDemoStaged = () => {
    // captureDemoLayout() reads the SAVED named layouts, so a workspace that
    // was only rearranged (never saved) captures as nothing. Publishing that
    // "succeeds" and strands visitors on the built-in fallback chart, so stop
    // here with copy that says what to do instead.
    if (demoLayout.count === 0) {
      setDemoPublishError(
        "No saved layout to publish. Save the current workspace as a layout, then set it as the default.",
      );
      return;
    }
    // A fresh visitor browser has no activeLayoutId, so App's startup falls
    // through to defaultLayoutId (see resolveStartup). Publishing layouts with
    // no default lands them on the built-in fallback chart instead.
    if (demoLayout.defaultName == null) {
      setDemoPublishError(
        "No default layout. Star the layout the demo should open with, then publish.",
      );
      return;
    }
    // Drawings and indicators live under each cell's scope, and only get
    // captured for cells the SAVED body names. A default layout with none is
    // usually a workspace that was rearranged but never saved back, so say so
    // once; a second click publishes the bare layout anyway.
    if (demoLayout.scopeItems === 0 && !demoBareOk) {
      setDemoBareOk(true);
      setDemoPublishError(
        "The default layout has no drawings or indicators saved on it. Save the layout again from the workspace you want, or click Publish once more to publish it bare.",
      );
      return;
    }
    // The visitor's browser seeds this into localStorage, which holds about
    // 5 MB; seedDemoLayout swallows a quota failure per key, so an oversized
    // payload would half-seed in silence.
    if (demoLayout.bytes > DEMO_BYTES_MAX) {
      setDemoPublishError(
        `Layout is ${fmtBytes(demoLayout.bytes)}, over the ${fmtBytes(DEMO_BYTES_MAX)} limit. Publish a layout with fewer charts or drawings.`,
      );
      return;
    }
    const seen = new Set<string>();
    let duplicate = false;
    for (const b of demoStaged) {
      if (seen.has(b.name)) {
        duplicate = true;
        break;
      }
      seen.add(b.name);
    }
    if (duplicate) {
      setDemoPublishError("Two staged backtests share a name. Rename one before publishing.");
      return;
    }
    const watchlist = demoWatchlist
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setDemoPublishing(true);
    setDemoPublishError(null);
    publishDemo({ watchlist, backtests: demoStaged })
      .then(() => {
        setDemoJustPublished(true);
        loadDemoLive();
      })
      .catch((e) => setDemoPublishError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDemoPublishing(false));
  };

  return (
    <div className="modal-backdrop modal-backdrop--clear" onMouseDown={onClose}>
      <div className="modal" style={drag.style} onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head" {...drag.handleProps}>
          <strong>Settings</strong>
          <CloseButton onClick={onClose} />
        </header>

        <div className="ind-tabs">
          {([
            ["general", "General"],
            ["alerts", "Alerts"],
            ["trading", "Trading"],
            ...(isAdmin ? ([["demo", "Public demo"]] as [Tab, string][]) : []),
          ] as [Tab, string][]).map(([t, label]) => (
            <button
              key={t}
              className={`ind-tab ${tab === t ? "on" : ""}`}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "general" && (
          <>
            <div className="setting-row">
              <label>Theme</label>
              <div className="seg">
                {THEMES.map((t) => (
                  <button
                    key={t}
                    className={settings.theme === t ? "seg-on" : ""}
                    onClick={() => onChange({ ...settings, theme: t })}
                  >
                    {t === "dark" ? "🌙 Dark" : "☀️ Light"}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <label className="label-info">
                Chart background
                <InfoTip text="Override the chart pane background with a custom color, e.g. a dimmer grey for night use. Applies to all charts." />
              </label>
              <div className="chart-bg-ctl">
                <ColorLineStylePicker
                  title="Chart background"
                  // Show the resolved color: the override if set, else the theme's
                  // default background, so the swatch reflects what's drawn.
                  color={settings.chartBg || chartColors[settings.theme].bg}
                  onColor={(hex) => onChange({ ...settings, chartBg: hex })}
                  opacity={settings.chartBgOpacity ?? 1}
                  onOpacity={(a) =>
                    onChange({
                      // Tuning opacity first activates the override on the theme's
                      // current default color so the change is visible immediately.
                      ...settings,
                      chartBg: settings.chartBg || chartColors[settings.theme].bg,
                      chartBgOpacity: a,
                    })
                  }
                />
                {settings.chartBg && (
                  <button
                    type="button"
                    className="bg-reset"
                    onClick={() =>
                      onChange({ ...settings, chartBg: undefined, chartBgOpacity: undefined })
                    }
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            <div className="setting-row">
              <label>Price</label>
              <div className="seg">
                {PRICE_SIDES.map((p) => (
                  <button
                    key={p.value}
                    className={settings.priceSide === p.value ? "seg-on" : ""}
                    onClick={() => onChange({ ...settings, priceSide: p.value })}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <label>Bid &amp; ask</label>
              <div className="seg">
                {BID_ASK.map((b) => (
                  <button
                    key={b.value}
                    className={settings.bidAsk === b.value ? "seg-on" : ""}
                    onClick={() => onChange({ ...settings, bidAsk: b.value })}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Bid/ask color (both modes) + line opacity & style (lines mode only,
                where they apply). Opacity/style are shared across the two swatches. */}
            {settings.bidAsk !== "off" && (
              <div className="setting-row">
                <label>Bid / ask style</label>
                <div className="ba-style-pickers">
                  <ColorLineStylePicker
                    title="Bid line"
                    color={ba.bidColor}
                    onColor={(hex) => setBA({ bidColor: hex })}
                    opacity={settings.bidAsk === "lines" ? ba.opacity : undefined}
                    onOpacity={settings.bidAsk === "lines" ? (a) => setBA({ opacity: a }) : undefined}
                    lineStyle={settings.bidAsk === "lines" ? ba.lineStyle : undefined}
                    onLineStyle={settings.bidAsk === "lines" ? (s) => setBA({ lineStyle: s }) : undefined}
                    lineStyleOptions={["solid", "dashed", "dotted"] as LineStyleOpt[]}
                  />
                  <ColorLineStylePicker
                    title="Ask line"
                    color={ba.askColor}
                    onColor={(hex) => setBA({ askColor: hex })}
                    opacity={settings.bidAsk === "lines" ? ba.opacity : undefined}
                    onOpacity={settings.bidAsk === "lines" ? (a) => setBA({ opacity: a }) : undefined}
                    lineStyle={settings.bidAsk === "lines" ? ba.lineStyle : undefined}
                    onLineStyle={settings.bidAsk === "lines" ? (s) => setBA({ lineStyle: s }) : undefined}
                    lineStyleOptions={["solid", "dashed", "dotted"] as LineStyleOpt[]}
                  />
                </div>
              </div>
            )}

            <div className="setting-row">
              <label>Crosshair</label>
              <ColorLineStylePicker
                title="Crosshair line"
                // "" follows the theme; show the resolved color so the swatch
                // reflects what's actually drawn.
                color={settings.crosshair.color || chartColors[settings.theme].textDim}
                onColor={(hex) =>
                  onChange({
                    ...settings,
                    crosshair: { ...settings.crosshair, color: hex },
                  })
                }
                opacity={settings.crosshair.opacity}
                onOpacity={(a) =>
                  onChange({
                    ...settings,
                    crosshair: { ...settings.crosshair, opacity: a },
                  })
                }
                lineStyle={settings.crosshair.lineStyle}
                onLineStyle={(s) =>
                  onChange({
                    ...settings,
                    crosshair: { ...settings.crosshair, lineStyle: s },
                  })
                }
                lineStyleOptions={["solid", "dashed", "dotted"] as LineStyleOpt[]}
              />
            </div>

            <div className="setting-row">
              <label>Timezone</label>
              <select
                className="tz-select"
                value={settings.timezone}
                onChange={(e) => onChange({ ...settings, timezone: e.target.value })}
              >
                {TIMEZONES.map((tz) => {
                  const off = offsetLabel(tz.value);
                  return (
                    <option key={tz.value} value={tz.value}>
                      {off ? `${tz.label} ${off}` : tz.label}
                    </option>
                  );
                })}
              </select>
            </div>

            <div className="setting-row">
              <label>Time format</label>
              <div className="seg">
                {CLOCKS.map((c) => (
                  <button
                    key={c.value}
                    className={settings.clock === c.value ? "seg-on" : ""}
                    onClick={() => onChange({ ...settings, clock: c.value })}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <label>Date format</label>
              <select
                className="tz-select"
                value={settings.dateFormat}
                onChange={(e) =>
                  onChange({ ...settings, dateFormat: e.target.value as DateFormat })
                }
              >
                {DATE_FORMATS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="setting-row">
              <label>Weekday</label>
              <div className="seg">
                {[
                  [false, "Off"],
                  [true, "On"],
                ].map(([value, label]) => (
                  <button
                    key={String(value)}
                    className={settings.showWeekday === value ? "seg-on" : ""}
                    onClick={() => onChange({ ...settings, showWeekday: value as boolean })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <label className="label-info">
                Auto-save templates
                <InfoTip text="Save indicators and drawings per symbol. Fresh charts open with their saved template." />
              </label>
              <div className="seg">
                {[
                  [false, "Off"],
                  [true, "On"],
                ].map(([value, label]) => (
                  <button
                    key={String(value)}
                    className={settings.autoSaveTemplates === value ? "seg-on" : ""}
                    onClick={() => onChange({ ...settings, autoSaveTemplates: value as boolean })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <label className="label-info">
                Preserve center on timeframe change
                <InfoTip text="On: the centered time stays put across timeframes and reloads, and the anchored bar is marked on the time axis. Off: switching timeframe jumps to the latest candle." />
              </label>
              <div className="seg">
                {[
                  [false, "Off"],
                  [true, "On"],
                ].map(([value, label]) => (
                  <button
                    key={String(value)}
                    className={settings.preserveCenterOnTfChange === value ? "seg-on" : ""}
                    onClick={() =>
                      onChange({ ...settings, preserveCenterOnTfChange: value as boolean })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <label className="label-info">
                Jump to end
                <InfoTip text='Where the "12d back" jump button parks while the newest bar is off-screen: above the time axis, at the top right of the chart, or riding the last-price line.' />
              </label>
              <div className="seg">
                {GOLIVE_POSITIONS.map((p) => (
                  <Tooltip key={p.value} content={p.label}>
                    <button
                      className={`golive-pos${settings.goLivePillPos === p.value ? " seg-on" : ""}`}
                      aria-label={p.label}
                      aria-pressed={settings.goLivePillPos === p.value}
                      onClick={() => onChange({ ...settings, goLivePillPos: p.value })}
                    >
                      <GoLiveGlyph pill={p.pill} />
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === "alerts" && (
          <>
            <div className="setting-sub">Defaults for new alerts</div>

            <div className="setting-row">
              <label>Condition</label>
              <select
                className="tz-select"
                value={ad.condition}
                onChange={(e) => setAd({ condition: e.target.value as AlertCondition })}
              >
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="setting-row">
              <label>Trigger</label>
              <div className="seg">
                {TRIGGERS.map((t) => (
                  <button
                    key={t.value}
                    className={ad.trigger === t.value ? "seg-on" : ""}
                    onClick={() => setAd({ trigger: t.value })}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <label>Expiration</label>
              <ExpiryDefaultPicker value={ad.expiry} onChange={(expiry) => setAd({ expiry })} />
            </div>

            <div className="setting-row">
              <label>Notifications</label>
              <div className="notify-toggles">
                {(
                  [
                    ["toast", "App"],
                    ["browser", "Browser"],
                    ["sound", "Sound"],
                    ["push", "Push"],
                    ["telegram", "Telegram"],
                  ] as const
                ).map(([ch, label]) => (
                  <label key={ch} className="notify-toggle">
                    <input
                      type="checkbox"
                      checked={ad.notify[ch] ?? true}
                      onChange={(e) => setAd({ notify: { ...ad.notify, [ch]: e.target.checked } })}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <label>Alert line</label>
              <label className="notify-toggle">
                <input
                  type="checkbox"
                  checked={ad.startAtCreation}
                  onChange={(e) => setAd({ startAtCreation: e.target.checked })}
                />
                Start line at creation time
              </label>
            </div>
            <div className="setting-hint">
              The line begins at the bar the alert was created on, so it says nothing
              about the bars before it. When off, it spans the whole chart. Every alert
              can override this in its own settings.
            </div>

            {!isDemoMode() && <NotificationSettings />}
          </>
        )}

        {tab === "trading" && (
          <>
            <div className="setting-sub">Order line editing</div>
            <div className="setting-row">
              <label>Confirm line edits</label>
              <label className="notify-toggle">
                <input
                  type="checkbox"
                  checked={tr.confirmLineEdits}
                  onChange={(e) => setTr({ confirmLineEdits: e.target.checked })}
                />
                Ask before applying a dragged level
              </label>
            </div>
            <div className="setting-hint">
              When off, dragging a stop, target, or order line on the chart applies
              the new price immediately instead of showing Apply / Discard.
            </div>

            <div className="setting-sub">Paper account</div>
            <div className="setting-hint">
              Used only to estimate the order ticket's margin / trade value /
              reward. Approximate — not a real balance.
            </div>
            <div className="setting-row">
              <label>Balance</label>
              <input
                className="num-input"
                type="number"
                min="0"
                step="any"
                value={tr.accountBalance}
                onChange={(e) => setTr({ accountBalance: Number(e.target.value) })}
              />
            </div>
            <div className="setting-row">
              <label>Currency</label>
              <input
                className="num-input"
                value={tr.accountCurrency}
                onChange={(e) => setTr({ accountCurrency: e.target.value })}
              />
            </div>
            <div className="setting-row">
              <label>Default leverage</label>
              <input
                className="num-input"
                type="number"
                min="1"
                step="1"
                value={tr.defaultLeverage}
                onChange={(e) => setTr({ defaultLeverage: Number(e.target.value) })}
              />
            </div>
            {LEVERAGE_TYPES.map((t) => (
              <div className="setting-row" key={t}>
                <label>{t.charAt(0) + t.slice(1).toLowerCase()} leverage</label>
                <input
                  className="num-input"
                  type="number"
                  min="1"
                  step="1"
                  value={tr.leverage[t] ?? tr.defaultLeverage}
                  onChange={(e) =>
                    setTr({ leverage: { ...tr.leverage, [t]: Number(e.target.value) } })
                  }
                />
              </div>
            ))}
          </>
        )}

        {tab === "demo" && isAdmin && (
          <>
            {demoLoadError ? (
              <div className="setting-hint demo-note bt-error">{demoLoadError}</div>
            ) : (
              <div className="setting-hint demo-note">
                {demoLive != null
                  ? `Live: published ${new Date(demoLive.createdAt).toLocaleString()}. Publishing replaces it.`
                  : "Nothing published yet."}
              </div>
            )}

            <div className="setting-sub">Layout</div>
            <div className="setting-row">
              <label className="label-info">
                This browser
                <InfoTip
                  title="What gets published"
                  text={[
                    "This browser's saved layouts, and the default one opens.",
                    "Drawings and indicators ride along, per chart.",
                    "Items counts what the default layout carries.",
                    "Captured from the active broker's workspace.",
                  ]}
                />
              </label>
              {demoLayout.count === 0 ? (
                <span className="demo-stat demo-stat-warn">No saved layout</span>
              ) : demoLayout.defaultName == null ? (
                <span className="demo-stat demo-stat-warn">
                  {demoLayout.count} {demoLayout.count === 1 ? "layout" : "layouts"}, no default
                </span>
              ) : (
                <span
                  className={
                    demoLayout.scopeItems === 0 || demoLayout.bytes > DEMO_BYTES_WARN
                      ? "demo-stat demo-stat-warn"
                      : "demo-stat"
                  }
                >
                  {demoLayout.defaultName} · {demoLayout.scopeItems} saved{" "}
                  {demoLayout.scopeItems === 1 ? "item" : "items"} · {fmtBytes(demoLayout.bytes)}
                </span>
              )}
            </div>

            <div className="setting-row">
              <label className="label-info">
                Data source
                <InfoTip
                  title="Visitors chart Yahoo Finance"
                  text={[
                    "Published charts serve free Yahoo Finance data.",
                    "Each chart's symbol is remapped to its Yahoo equivalent.",
                    "Symbols with no match block the publish, with a list.",
                  ]}
                />
              </label>
              <span className="demo-stat">Yahoo Finance</span>
            </div>

            <div className="setting-sub">Watchlist</div>
            <div className="setting-row">
              <label className="label-info">
                Epics (optional)
                <InfoTip
                  title="Watchlist"
                  text={[
                    "Comma-separated, kept on the published record.",
                    "The demo browses the whole Yahoo catalogue anyway.",
                    "Epics that do not resolve are rejected.",
                  ]}
                />
              </label>
              <input
                className="num-input demo-text-input"
                value={demoWatchlist}
                placeholder="e.g. US100, EURUSD"
                onChange={(e) => setDemoWatchlist(e.target.value)}
              />
            </div>

            <div className="setting-sub">Backtests</div>
            <div className="setting-row">
              <label className="label-info">
                Name
                <InfoTip
                  title="Canned backtests"
                  text={[
                    "Stages the last completed run from this session.",
                    "Visitors browse staged runs in the Backtest panel.",
                    "Publishing with none is fine.",
                  ]}
                />
              </label>
              <input
                className="num-input demo-text-input"
                value={demoCaptureName}
                placeholder="e.g. NQ breakout"
                onChange={(e) => setDemoCaptureName(e.target.value)}
              />
              <button type="button" onClick={captureDemoBacktest}>
                Capture
              </button>
            </div>
            {demoCaptureNotice && (
              <div className="setting-hint demo-note bt-notice">{demoCaptureNotice}</div>
            )}
            {demoStaged.map((b, i) => (
              <div className="setting-row demo-staged-row" key={`${b.name}-${i}`}>
                <label>{b.name}</label>
                <button
                  type="button"
                  onClick={() => setDemoStaged((prev) => prev.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
            ))}

            <div className="setting-row demo-publish-row">
              {demoJustPublished && !demoPublishError ? (
                <span className="setting-hint">Published. Visitors see it now.</span>
              ) : (
                <span />
              )}
              {/* Opens the live demo in this tab, on its own key namespace,
                  so the admin never has to sign out to check a publish. */}
              <Tooltip content={demoLive == null ? "Nothing published yet" : undefined}>
                <button type="button" onClick={enterDemoPreview} disabled={demoLive == null}>
                  View
                </button>
              </Tooltip>
              <button
                type="button"
                className="demo-publish"
                onClick={publishDemoStaged}
                disabled={demoPublishing}
              >
                {demoPublishing ? "Publishing…" : "Publish"}
              </button>
            </div>
            {demoPublishError && (
              <div className="setting-hint demo-note bt-error">{demoPublishError}</div>
            )}

          </>
        )}
      </div>
    </div>
  );
}

// Default-expiry intent picker: open-ended / a duration preset / a fixed time.
// (For a default, "datetime" rarely makes sense, so we offer open-ended + presets;
// the per-alert modal additionally exposes a calendar picker.)
function ExpiryDefaultPicker({
  value,
  onChange,
}: {
  value: AlertExpiry;
  onChange: (e: AlertExpiry) => void;
}) {
  const isOpen = value.kind === "open";
  return (
    <div className="seg expiry-seg">
      <button className={isOpen ? "seg-on" : ""} onClick={() => onChange({ kind: "open" })}>
        Open-ended
      </button>
      {DURATION_PRESETS.map((p) => (
        <button
          key={p.label}
          className={value.kind === "duration" && value.ms === p.ms ? "seg-on" : ""}
          onClick={() => onChange({ kind: "duration", ms: p.ms })}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
