// Shared constants/helpers for the alert UIs (create/edit modal + the Settings →
// Alerts defaults tab) so they read identically.

import type { AlertCondition } from "./persist";
import { CONDITION_LABELS } from "./persist";
import type { AlertExpiry } from "../theme";

export const CONDITIONS: { value: AlertCondition; label: string }[] = (
  Object.keys(CONDITION_LABELS) as AlertCondition[]
).map((value) => ({ value, label: CONDITION_LABELS[value] }));

// Quick-pick durations offered for expiration (besides open-ended / custom).
export const DURATION_PRESETS: { label: string; ms: number }[] = [
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "1d", ms: 24 * 60 * 60 * 1000 },
  { label: "1w", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
];

// End of the local day for `now` (today 23:59), as epoch ms.
export function endOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(23, 59, 0, 0);
  return d.getTime();
}

// Expiration options shown in the per-alert modal dropdown, TradingView-style:
// open-ended ("Won't expire"), end of day, quick durations, and a custom date.
// Each non-custom option carries the concrete expiry (ms) it resolves to at `now`.
export type ExpiryOption =
  | { id: "open"; label: string; expiresAt: null }
  | { id: "eod" | "1h" | "1w"; label: string; expiresAt: number }
  | { id: "custom"; label: string };

export function expiryOptions(now: number): ExpiryOption[] {
  return [
    { id: "open", label: "Never", expiresAt: null },
    { id: "eod", label: "End of day", expiresAt: endOfDay(now) },
    { id: "1h", label: "1 hour", expiresAt: now + 60 * 60 * 1000 },
    { id: "1w", label: "1 week", expiresAt: now + 7 * 24 * 60 * 60 * 1000 },
    { id: "custom", label: "Custom date" },
  ];
}

// Which dropdown option a concrete expiry corresponds to. A timestamp within a
// minute of a preset (end of day / 1h / 1w) selects that preset; null is
// open-ended; anything else is a custom date.
export function matchExpiryOption(expiresAt: number | null, now: number): ExpiryOption["id"] {
  if (expiresAt == null) return "open";
  const opts = expiryOptions(now);
  for (const o of opts) {
    if ("expiresAt" in o && o.expiresAt != null && Math.abs(expiresAt - o.expiresAt) < 60_000) {
      return o.id;
    }
  }
  return "custom";
}

// Resolve a default-expiry INTENT to a concrete expiry timestamp (ms) at the
// moment an alert is created. Open-ended → null; duration → now + ms; datetime →
// the fixed time as-is (already absolute).
export function resolveExpiry(expiry: AlertExpiry, now: number): number | null {
  if (expiry.kind === "duration") return now + expiry.ms;
  if (expiry.kind === "datetime") return expiry.at;
  return null;
}

// Format a remaining duration (ms) down to minutes, largest two non-zero units:
// "1d, 6h", "6h, 12m", "12m". Sub-minute → "<1m"; non-positive → "expired".
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return "<1m";
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.slice(0, 2).join(", ");
}

// Short resolved-time label for an expiry dropdown row, e.g. "Jun 24, 23:59".
// Formatter is cached: toLocaleString builds a fresh Intl.DateTimeFormat per
// call, which is far too slow for bulk callers (the backtest trades table
// formats two timestamps per row).
const expiryShortFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export function formatExpiryShort(ms: number): string {
  return expiryShortFmt.format(ms);
}

// Long resolved-time label for the closed dropdown button, e.g.
// "July 22, 2026 at 19:05". Open-ended → "Open-ended".
export function formatExpiryLong(ms: number | null): string {
  if (ms == null) return "Never";
  const d = new Date(ms);
  const date = d.toLocaleString(undefined, { month: "long", day: "numeric", year: "numeric" });
  const time = d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} at ${time}`;
}

// <input type="datetime-local"> value (local wall-clock, no tz suffix) ⇄ epoch ms.
// The input has no timezone, so treat its value as local time (matches how the
// user reads the picker).
export function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
export function localInputToMs(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}
