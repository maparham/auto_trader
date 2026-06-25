// App settings modal. Tabbed: "General" (theme + time formatting) and "Alerts"
// (defaults a freshly-created alert inherits). Structured so more tabs/rows drop in.

import { useState } from "react";
import CloseButton from "./CloseButton";
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
import { chartColors } from "./theme";
import ColorLineStylePicker, { type LineStyleOpt } from "./ColorLineStylePicker";
import { useDraggable } from "./lib/useDraggable";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import { TIMEZONES, offsetLabel } from "./lib/timezones";
import { CONDITIONS, DURATION_PRESETS } from "./lib/alertUi";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}

type Tab = "general" | "alerts";

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

const TRIGGERS: { value: AlertTrigger; label: string }[] = [
  { value: "once", label: "Once only" },
  { value: "every", label: "Every time" },
];

export default function SettingsModal({ settings, onChange, onClose }: Props) {
  const drag = useDraggable();
  const [tab, setTab] = useState<Tab>("general");
  useCloseOnEscape(onClose);

  const ad = settings.alertDefaults;
  const setAd = (patch: Partial<AlertDefaults>) =>
    onChange({ ...settings, alertDefaults: { ...ad, ...patch } });

  const ba = settings.bidAskStyle;
  const setBA = (patch: Partial<typeof ba>) =>
    onChange({ ...settings, bidAskStyle: { ...ba, ...patch } });

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" style={drag.style} onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head" {...drag.handleProps}>
          <strong>Settings</strong>
          <CloseButton onClick={onClose} />
        </header>

        <div className="ind-tabs">
          {([
            ["general", "General"],
            ["alerts", "Alerts"],
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
                {(["toast", "browser", "sound"] as const).map((ch) => (
                  <label key={ch} className="notify-toggle">
                    <input
                      type="checkbox"
                      checked={ad.notify[ch]}
                      onChange={(e) => setAd({ notify: { ...ad.notify, [ch]: e.target.checked } })}
                    />
                    {ch === "toast" ? "App" : ch === "browser" ? "Browser" : "Sound"}
                  </label>
                ))}
              </div>
            </div>
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
