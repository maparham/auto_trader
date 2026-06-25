// Instrument-details modal — opened by clicking the symbol name in the chart
// legend (TradingView-style). Shows EVERYTHING the broker's single-market detail
// provides, rendered generically: the three raw sections (instrument, dealing
// rules, snapshot) as grouped key/value rows. Generic on purpose — the field set
// varies per instrument (FX populates pip/currency fields commodities leave
// null), so a hand-typed list would drift; we render whatever the broker sends
// and skip empties.

import { useEffect, useState } from "react";
import CloseButton from "./CloseButton";
import { fetchMarketDetail, type MarketDetail } from "./lib/feed";
import { useDraggable } from "./lib/useDraggable";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";

interface Props {
  epic: string;
  // Friendly title (e.g. the legend symbol) shown in the header; falls back to epic.
  title?: string;
  onClose: () => void;
}

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
    if (key.toLowerCase().includes("hours")) return formatOpeningHours(o);
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

// openingHours -> a compact multi-line "Mon  00:00 - 21:00, 22:00 - 00:00" block,
// closed days shown as "closed", with the zone appended.
function formatOpeningHours(o: Record<string, unknown>): string | null {
  const zone = typeof o.zone === "string" ? o.zone : "";
  const lines = DAY_ORDER.filter((d) => d in o).map((d) => {
    const wins = Array.isArray(o[d]) ? (o[d] as unknown[]).map(String) : [];
    return `${DAY_LABEL[d]}  ${wins.length ? wins.join(", ") : "closed"}`;
  });
  if (!lines.length) return null;
  return lines.join("\n") + (zone ? `\n(${zone})` : "");
}

// One section (instrument / dealingRules / snapshot) -> list of {label, value}
// rows, empties dropped.
function rowsFor(section: Record<string, unknown>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(section)) {
    const value = formatValue(k, v);
    if (value != null) out.push({ label: humanize(k), value });
  }
  return out;
}

const SECTIONS: Array<{ key: keyof MarketDetail; title: string }> = [
  { key: "instrument", title: "Instrument" },
  { key: "dealingRules", title: "Dealing rules" },
  { key: "snapshot", title: "Market snapshot" },
];

export default function InstrumentDetailsModal({ epic, title, onClose }: Props) {
  const drag = useDraggable();
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  // One fetch on open (not polled — the snapshot section is a point-in-time quote
  // and that's fine for a click-to-open view).
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void fetchMarketDetail(epic).then((d) => {
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
  }, [epic]);

  useCloseOnEscape(onClose);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal instrument-modal"
        style={drag.style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head" {...drag.handleProps}>
          <span className="instrument-title">{title || epic}</span>
          <CloseButton onClick={onClose} />
        </div>
        <div className="instrument-body">
          {state === "loading" && <p className="instrument-note">Loading…</p>}
          {state === "error" && (
            <p className="instrument-note">Couldn’t load instrument details.</p>
          )}
          {state === "ready" &&
            detail &&
            SECTIONS.map(({ key, title: sectionTitle }) => {
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
        </div>
      </div>
    </div>
  );
}
