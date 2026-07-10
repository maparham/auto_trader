import { useState } from "react";
import {
  EXPIRY_PRESETS,
  resolveExpiry,
  type ExpiryPreset,
  type ExpiryUnit,
} from "../lib/expiry";

// A dropdown of GTC + good-till-date presets + Custom. Custom reveals an inline
// "In [n] [unit]" relative entry with a date-time fallback. Emits the resolved
// epoch-ms timestamp (or null = GTC) via onChange — the parent stores that.
type Mode = "relative" | "absolute";

interface Props {
  value: number | null; // resolved epoch ms, or null = GTC (for display seeding)
  onChange: (ms: number | null) => void;
}

// Epoch ms → local `YYYY-MM-DDTHH:mm` for a <input type=datetime-local> value.
// Local (not UTC) so the input shows the same wall-clock time the user picked.
function toLocalInput(ms: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ExpirySelect({ value, onChange }: Props) {
  const [sel, setSel] = useState<string>(value == null ? "gtc" : "custom");
  // A non-null value at mount means we're seeding from an existing order's saved
  // expiry (EditTicket) — show it in the absolute "On <date-time>" form rather
  // than defaulting to relative, so the displayed time matches the real one.
  // EditTicket is keyed by trade.id and remounts per order, so mount-time
  // seeding is sufficient (no post-mount `value` syncing).
  const [mode, setMode] = useState<Mode>(value == null ? "relative" : "absolute");
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<ExpiryUnit>("minutes");
  const [atLocal, setAtLocal] = useState(value == null ? "" : toLocalInput(value)); // <input type=datetime-local> value

  function emitPreset(preset: ExpiryPreset) {
    onChange(resolveExpiry({ kind: "preset", preset }, Date.now()));
  }
  function emitRelative(a: string, u: ExpiryUnit) {
    const n = Number(a);
    onChange(Number.isFinite(n) && n > 0 ? resolveExpiry({ kind: "relative", amount: n, unit: u }, Date.now()) : null);
  }
  function emitAbsolute(local: string) {
    const ms = local ? new Date(local).getTime() : NaN;
    onChange(Number.isFinite(ms) ? ms : null);
  }

  function onSelect(v: string) {
    setSel(v);
    if (v === "gtc") onChange(null);
    else if (v === "custom") {
      if (mode === "relative") emitRelative(amount, unit);
      else emitAbsolute(atLocal);
    } else emitPreset(v as ExpiryPreset);
  }

  return (
    <label className="ot-field-block">
      <span className="ot-flabel">Expires</span>
      <div className="ot-input-row">
        <select className="ot-input" value={sel} onChange={(e) => onSelect(e.target.value)}>
          <option value="gtc">Good-Till-Cancelled</option>
          {EXPIRY_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </div>

      {sel === "custom" && (
        <div className="ot-expiry-custom">
          <label>
            <input
              type="radio"
              name="expiry-mode"
              checked={mode === "relative"}
              onChange={() => { setMode("relative"); emitRelative(amount, unit); }}
            />
            In
            <input
              aria-label="amount"
              className="ot-input num"
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); if (mode === "relative") emitRelative(e.target.value, unit); }}
            />
            <select
              aria-label="unit"
              className="ot-input"
              value={unit}
              onChange={(e) => { const u = e.target.value as ExpiryUnit; setUnit(u); if (mode === "relative") emitRelative(amount, u); }}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </label>
          <label>
            <input
              type="radio"
              name="expiry-mode"
              checked={mode === "absolute"}
              onChange={() => { setMode("absolute"); emitAbsolute(atLocal); }}
            />
            On
            <input
              aria-label="date-time"
              className="ot-input"
              type="datetime-local"
              value={atLocal}
              onChange={(e) => { setAtLocal(e.target.value); if (mode === "absolute") emitAbsolute(e.target.value); }}
            />
          </label>
        </div>
      )}
    </label>
  );
}
