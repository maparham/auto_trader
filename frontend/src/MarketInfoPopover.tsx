// Market-info popover — opened from the ⓘ button in the chart legend, anchored
// at the button (TradingView/Capital-style), dismissed by outside click or Esc.
//
// Curated sections up top (day range bar, local trading hours, formatted
// trading info), and the FULL raw broker payload under a collapsed "All
// details" — so curation never hides anything the broker sends, and new broker
// fields keep appearing with zero code changes (the old modal's guarantee).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import CloseButton from "./CloseButton";
import { fetchMarketDetail, type MarketDetail } from "./lib/feed";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import {
  fundingText,
  leverageText,
  localOpeningHours,
  marginText,
  priceText,
  rangePosition,
  spreadText,
  swapTimeText,
} from "./lib/marketInfoFormat";

interface Props {
  epic: string;
  // Active data broker id — the detail is broker-specific (epics aren't portable).
  brokerId: string;
  // Friendly title (e.g. the legend symbol name); falls back to epic.
  title?: string;
  // Viewport point to anchor the top-left corner at (the ⓘ button's bottom-left).
  anchor: { x: number; y: number };
  onClose: () => void;
}

const WIDTH = 300;
const MARGIN = 8; // min gap to the viewport edges

// ---------------------------------------------------------------------------
// Generic raw renderer (unchanged from the old InstrumentDetailsModal) — feeds
// the "All details" section. Renders whatever the broker sends, skips empties.
// ---------------------------------------------------------------------------

// camelCase / snake_case key -> "Title Case" label, with a few broker acronyms
// kept uppercase. Cheap humanize so raw API keys read sensibly.
function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  const titled = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return titled.replace(/\b(Utc|Id|Epic|Fx|Cfd)\b/gi, (m) => m.toUpperCase());
}

// True for values we shouldn't show as a row: null/undefined, empty string, and
// Capital's "-" placeholder (used for e.g. non-expiring instruments' expiry).
function isEmpty(v: unknown): boolean {
  return v == null || v === "" || v === "-";
}

// Format one raw value for display. Handles the shapes the broker actually sends:
// {value, unit} dealing-rule objects, the openingHours per-day dict, primitive
// scalars, and arrays. Returns null when the value should be skipped entirely.
function formatValue(key: string, v: unknown): string | null {
  if (isEmpty(v)) return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number" || typeof v === "string") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => formatValue(key, x)).filter((x): x is string => x != null);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Dealing-rule shape: { value, unit } -> "0.001 POINTS".
    if ("value" in o && !isEmpty(o.value)) {
      return isEmpty(o.unit) ? String(o.value) : `${o.value} ${o.unit}`;
    }
    // openingHours: { mon: ["00:00 - 21:00", ...], ..., zone: "UTC" }.
    if (key.toLowerCase().includes("hours")) return formatRawOpeningHours(o);
    // Fallback: any other nested object -> compact "k: v" pairs.
    const pairs = Object.entries(o)
      .map(([k, val]) => {
        const f = formatValue(k, val);
        return f == null ? null : `${humanize(k)}: ${f}`;
      })
      .filter((x): x is string => x != null);
    return pairs.length ? pairs.join("; ") : null;
  }
  return null;
}

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

// Raw openingHours -> a compact multi-line block in the BROKER's zone (the
// curated section above shows the local-time version).
function formatRawOpeningHours(o: Record<string, unknown>): string | null {
  const zone = typeof o.zone === "string" ? o.zone : "";
  const lines = DAY_ORDER.filter((d) => d in o).map((d) => {
    const wins = Array.isArray(o[d]) ? (o[d] as unknown[]).map(String) : [];
    return `${DAY_LABEL[d]}  ${wins.length ? wins.join(", ") : "closed"}`;
  });
  if (!lines.length) return null;
  return lines.join("\n") + (zone ? `\n(${zone})` : "");
}

function rowsFor(section: Record<string, unknown>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(section)) {
    const value = formatValue(k, v);
    if (value != null) out.push({ label: humanize(k), value });
  }
  return out;
}

const RAW_SECTIONS: Array<{ key: keyof MarketDetail; title: string }> = [
  { key: "instrument", title: "Instrument" },
  { key: "dealingRules", title: "Dealing rules" },
  { key: "snapshot", title: "Market snapshot" },
];

// Safe typed getters into the untyped sections.
function num(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" && v !== "" && v !== "-" ? v : undefined;
}
function obj(o: Record<string, unknown>, k: string): Record<string, unknown> | undefined {
  const v = o[k];
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export default function MarketInfoPopover({ epic, brokerId, title, anchor, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [showRaw, setShowRaw] = useState(false);
  // Clamped position — starts at the anchor, adjusted after measuring.
  const [pos, setPos] = useState(anchor);

  // One fetch on open (not polled — the snapshot is a point-in-time quote and
  // that's fine for a click-to-open view).
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void fetchMarketDetail(epic, brokerId).then((d) => {
      if (cancelled) return;
      if (d) {
        setDetail(d);
        setState("ready");
      } else {
        setState("error");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [epic, brokerId]);

  useCloseOnEscape(onClose);

  // Outside mousedown dismisses (same pattern as ContextMenu). The opening
  // click was a `click` on the ⓘ, so its mousedown predates this listener.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  // Keep the card inside the viewport once its real size is known (content
  // changes across loading → ready → raw expanded).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(MARGIN, Math.min(anchor.x, window.innerWidth - r.width - MARGIN)),
      y: Math.max(MARGIN, Math.min(anchor.y, window.innerHeight - r.height - MARGIN)),
    });
  }, [anchor, state, showRaw]);

  const offsetMinutes = -new Date().getTimezoneOffset();

  const inst = detail?.instrument ?? {};
  const rules = detail?.dealingRules ?? {};
  const snap = detail?.snapshot ?? {};

  const decimals = num(snap, "decimalPlacesFactor");
  const low = num(snap, "low");
  const high = num(snap, "high");
  const bid = num(snap, "bid");
  const offer = num(snap, "offer");
  const rangePct = rangePosition(low, high, bid);

  const hoursDict = obj(inst, "openingHours");
  const hourRows = hoursDict ? localOpeningHours(hoursDict, offsetMinutes) : [];

  const fee = obj(inst, "overnightFee");
  const feeLong = fee ? fundingText(fee.longRate) : null;
  const feeShort = fee ? fundingText(fee.shortRate) : null;
  const feeTime = fee ? swapTimeText(fee.swapChargeTimestamp, offsetMinutes) : null;

  const minSize = formatValue("minDealSize", rules.minDealSize);
  const margin = marginText(num(inst, "marginFactor"), inst.marginFactorUnit);
  const leverage = leverageText(num(inst, "marginFactor"), inst.marginFactorUnit);
  const spread = spreadText(bid, offer, decimals);

  // Row order mirrors Capital's sheet: Currency, Min size, [funding block],
  // Margin, Leverage, Spread, Type — the funding block is spliced in after the
  // first two rows below.
  const infoRows: Array<{ label: string; value: string }> = [];
  const currency = str(inst, "currency");
  if (currency) infoRows.push({ label: "Currency", value: currency });
  if (minSize) infoRows.push({ label: "Min size", value: minSize });
  const laterRows: Array<{ label: string; value: string }> = [];
  if (margin) laterRows.push({ label: "Margin", value: margin });
  if (leverage) laterRows.push({ label: "Leverage", value: leverage });
  if (spread) laterRows.push({ label: "Spread", value: spread });
  const type = str(inst, "type");
  if (type) laterRows.push({ label: "Type", value: type });

  const infoRow = (r: { label: string; value: string }) => (
    <div className="mi-row" key={r.label}>
      <span className="mi-label">{r.label}</span>
      <span className="mi-value">{r.value}</span>
    </div>
  );

  return (
    <div ref={ref} className="mi-popover" style={{ left: pos.x, top: pos.y, width: WIDTH }}>
      <div className="mi-head">
        <div className="mi-titles">
          <span className="mi-name">{title || epic}</span>
          <span className="mi-epic">{epic}</span>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      {state === "loading" && <p className="instrument-note">Loading…</p>}
      {state === "error" && (
        <p className="instrument-note">Couldn’t load instrument details.</p>
      )}

      {state === "ready" && detail && (
        <>
          {rangePct != null && (
            <div className="mi-section">
              <div className="mi-section-title">Day range</div>
              <div className="mi-range">
                <div className="mi-range-track">
                  <div className="mi-range-marker" style={{ left: `${rangePct}%` }} />
                  {/* clamp keeps the centered pill from poking past the card
                      when the price sits at the extremes of the range */}
                  <div
                    className="mi-range-pill"
                    style={{ left: `clamp(28px, ${rangePct}%, calc(100% - 28px))` }}
                  >
                    {priceText(bid, decimals)}
                  </div>
                </div>
                <div className="mi-range-ends">
                  <span className="mi-range-low">Low {priceText(low, decimals)}</span>
                  <span className="mi-range-high">High {priceText(high, decimals)}</span>
                </div>
              </div>
            </div>
          )}

          {hourRows.length > 0 && (
            <div className="mi-section">
              <div className="mi-section-title">
                Trading hours <span className="mi-caption">your local time</span>
              </div>
              {hourRows.map((r) => (
                <div className="mi-hours-row" key={r.days}>
                  <span className="mi-hours-days">{r.days}</span>
                  <span className="mi-hours-times">{r.hours}</span>
                </div>
              ))}
            </div>
          )}

          {(infoRows.length > 0 || laterRows.length > 0 || feeLong || feeShort) && (
            <div className="mi-section">
              <div className="mi-section-title">Trading info</div>
              {infoRows.map(infoRow)}
              {(feeLong || feeShort) && (
                <div className="mi-funding">
                  <div className="mi-row">
                    <span className="mi-label">Overnight funding</span>
                  </div>
                  {feeLong && (
                    <div className="mi-row mi-sub">
                      <span className="mi-label">Long</span>
                      <span className="mi-value">{feeLong}</span>
                    </div>
                  )}
                  {feeShort && (
                    <div className="mi-row mi-sub">
                      <span className="mi-label">Short</span>
                      <span className="mi-value">{feeShort}</span>
                    </div>
                  )}
                  {feeTime && (
                    <div className="mi-row mi-sub">
                      <span className="mi-label">Time</span>
                      <span className="mi-value">{feeTime}</span>
                    </div>
                  )}
                </div>
              )}
              {laterRows.map(infoRow)}
            </div>
          )}

          <button className="mi-alldetails-toggle" onClick={() => setShowRaw((s) => !s)}>
            <span className={`mi-chevron${showRaw ? " open" : ""}`}>▸</span> All details
          </button>
          {showRaw &&
            RAW_SECTIONS.map(({ key, title: sectionTitle }) => {
              const rows = rowsFor(detail[key]);
              if (!rows.length) return null;
              return (
                <div className="instrument-section" key={key}>
                  <div className="instrument-section-title">{sectionTitle}</div>
                  <dl className="instrument-grid">
                    {rows.map((r) => (
                      <div className="instrument-row" key={r.label}>
                        <dt>{r.label}</dt>
                        <dd>{r.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              );
            })}
        </>
      )}
    </div>
  );
}
