// Signal-candle "why this trade fired" glyphs. A rule-based fill's MarkerDTO
// carries the passing rules' authoritative comparison values (`terms`) and the
// bar the signal fired on (`signal_time`). We derive a SECOND, subtle overlay on
// that signal candle from the same marker — no separate backend marker. Hovering
// it opens a popover listing each passing rule with the values the engine used.
//
// Pure helpers here (no chart/DOM) so the placement + label logic is unit-tested;
// backtest.ts draws the overlay and wires the hover popover.

import type { Marker, Term } from "../api";
import { periodByResolution } from "./feed";

/** The data needed to draw one signal glyph, derived from a fill marker that has
 * rule provenance. `signalTime` is unix seconds (the signal bar). Long fills hang
 * the caret BELOW the candle, short fills ABOVE (per the design). */
export interface SignalGlyph {
  signalTime: number;
  leg: "long" | "short";
  side: "buy" | "sell";
  reason: string;
  placement: "above" | "below";
  terms: Term[];
  combine: string; // "AND" | "OR" — how to read the passing-only terms
}

/** Derive the signal glyphs from a run's fill markers: one per marker that
 * actually fired on a rule (non-empty `terms`) AND knows its signal bar. A
 * mechanical fill (stop/target/session/range-end) has empty terms and is skipped,
 * so its `SL`/`TP` marker stays the sole explanation. Pure + exported for tests. */
export function buildSignalGlyphs(markers: Marker[]): SignalGlyph[] {
  const out: SignalGlyph[] = [];
  for (const m of markers) {
    if (!m.terms || m.terms.length === 0) continue;
    if (m.signal_time == null) continue;
    out.push({
      signalTime: m.signal_time,
      leg: m.leg,
      side: m.side,
      reason: m.reason,
      placement: m.leg === "long" ? "below" : "above",
      terms: m.terms,
      combine: m.combine || "AND",
    });
  }
  return out;
}

/** Prettify an operand's effective timeframe to the label the rest of the UI
 * shows (MINUTE_15 → "15m", HOUR → "1H"), falling back to the raw resolution for
 * an unknown one. */
export function prettyTf(resolution: string): string {
  return periodByResolution(resolution)?.label ?? resolution;
}

/** The popover's operand label: the human name plus `@<tf>` when the operand runs
 * on a timeframe (indicators/series), bare otherwise (price/const/entryPrice). */
export function termLabel(label: string, tf: string | null): string {
  return tf ? `${label} @${prettyTf(tf)}` : label;
}

/** Render a rule operator as a compact symbol for the popover (gt → `>`), so the
 * comparison reads like maths. Cross operators keep a word + arrow. Unknown ops
 * fall through verbatim. */
export function opSymbol(op: string): string {
  switch (op) {
    case "gt":
      return ">";
    case "lt":
      return "<";
    case "gte":
      return "≥";
    case "lte":
      return "≤";
    case "crossesAbove":
      return "crosses ↑";
    case "crossesBelow":
      return "crosses ↓";
    case "crosses":
      return "crosses";
    default:
      return op;
  }
}

/** Whether a fill on this side+leg OPENS the position (an entry) or closes it (an
 * exit) — same mapping as the fill marker's B+/S- glyph. */
export function isEntryFill(side: "buy" | "sell", leg: "long" | "short"): boolean {
  return (leg === "long" && side === "buy") || (leg === "short" && side === "sell");
}

/** The popover header, e.g. `Long entry — signal 11 Mar 15:30 (AND)`. `timeStr` is
 * the caller-formatted local time of the signal bar. */
export function signalHeader(
  glyph: Pick<SignalGlyph, "side" | "leg" | "combine">,
  timeStr: string,
): string {
  const legLabel = glyph.leg === "long" ? "Long" : "Short";
  const action = isEntryFill(glyph.side, glyph.leg) ? "entry" : "exit";
  return `${legLabel} ${action} — signal ${timeStr} (${glyph.combine})`;
}
