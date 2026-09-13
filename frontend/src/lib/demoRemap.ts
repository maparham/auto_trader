// Publish-time epic remapping for the public demo. New publishes serve
// visitors on the credential-free yfinance broker (it covers stocks/ETFs,
// which dukascopy does not), but the captured layout came from whatever
// broker the admin was working on, and epics are broker-specific. This module
// rewrites a captured layout map (demoSnapshot.ts's captureDemoLayout shape)
// onto yfinance's curated catalogue: cell symbols inside layout bodies, and
// the epic-bearing scope-key suffixes (`drawings.<epic>`, `avwap.<epic>[.<id>]`)
// that would otherwise silently detach from their renamed chart.
//
// Mapping rule: a small alias table for source-broker names that differ from
// the canonical epics (Capital.com's spot metals), then identity against the
// yfinance catalogue. A cell symbol that maps to nothing is reported in
// `unmapped` so the caller can refuse the publish with a symbol list; an
// unmappable scope KEY is just dropped (stale drawings for an epic no cell
// shows should not block publishing).
import type { Instrument } from "./feed";

// Source-broker epic -> canonical yfinance epic, where the names differ.
// Capital.com calls the spot metals GOLD/SILVER; everything else the app
// trades already uses the canonical names (US100, EURUSD, AAPL, BTCUSD...).
const EPIC_ALIASES: Record<string, string> = {
  GOLD: "XAUUSD",
  SILVER: "XAGUSD",
};

/** The yfinance instrument a source-broker epic maps to, or null. */
export function mapEpicToYfinance(
  epic: string,
  catalogue: Map<string, Instrument>,
): Instrument | null {
  return catalogue.get(EPIC_ALIASES[epic] ?? epic) ?? null;
}

export interface DemoRemapResult {
  layout: Record<string, string>;
  /** Cell-symbol epics with no yfinance equivalent, in first-seen order. */
  unmapped: string[];
}

const SCOPE_MARK = "scope:";
// Scope suffixes that embed an epic in the KEY (persist/artifacts.ts key
// builders). backtest./sweep. never reach a publish (captureDemoLayout skips
// them), so drawings and avwap are the whole list.
const EPIC_SUFFIX_MARKS = [".drawings.", ".avwap."] as const;

/** Split `rest` (everything after "drawings."/"avwap.") into the mappable
 *  epic and its tail (avwap anchor ids). Epics from searched catalogues can
 *  contain dots (IG's "IX.D..." style), so try the longest dotted prefix
 *  first. Null when no prefix maps. */
function splitEpic(
  rest: string,
  catalogue: Map<string, Instrument>,
): { mapped: Instrument; tail: string } | null {
  const parts = rest.split(".");
  for (let k = parts.length; k >= 1; k--) {
    const mapped = mapEpicToYfinance(parts.slice(0, k).join("."), catalogue);
    if (mapped) return { mapped, tail: parts.slice(k).join(".") };
  }
  return null;
}

function remapScopeKey(
  suffix: string,
  catalogue: Map<string, Instrument>,
): string | null {
  for (const mark of EPIC_SUFFIX_MARKS) {
    const at = suffix.indexOf(mark);
    if (at < 0) continue;
    const head = suffix.slice(0, at + mark.length);
    const hit = splitEpic(suffix.slice(at + mark.length), catalogue);
    if (!hit) return null; // unmappable epic-bearing key: drop it
    return `${head}${hit.mapped.epic}${hit.tail ? `.${hit.tail}` : ""}`;
  }
  return suffix; // no epic in this key
}

interface CellShape {
  symbol?: { epic?: string } & Record<string, unknown>;
}

/** Rewrite a captured layout map onto the yfinance catalogue. Layout bodies
 *  get their cell symbols replaced by the catalogue row (epic, display name,
 *  precision all move together); epic-keyed scope entries are re-keyed the
 *  same way. Entries that don't parse are copied through untouched - they
 *  degrade for a visitor exactly the way stale localStorage always has. */
export function remapDemoLayout(
  layout: Record<string, string>,
  catalogue: Map<string, Instrument>,
): DemoRemapResult {
  const out: Record<string, string> = {};
  const unmapped: string[] = [];
  const noteUnmapped = (epic: string) => {
    if (!unmapped.includes(epic)) unmapped.push(epic);
  };

  for (const [key, raw] of Object.entries(layout)) {
    if (key.startsWith(SCOPE_MARK)) {
      const remapped = remapScopeKey(key.slice(SCOPE_MARK.length), catalogue);
      if (remapped != null) out[`${SCOPE_MARK}${remapped}`] = raw;
      continue;
    }
    if (!key.startsWith("layout.")) {
      out[key] = raw;
      continue;
    }
    try {
      const body = JSON.parse(raw) as { tabs?: Array<{ cells?: CellShape[] }> };
      for (const t of body.tabs ?? [])
        for (const c of t.cells ?? []) {
          const epic = c.symbol?.epic;
          if (typeof epic !== "string") continue;
          const inst = mapEpicToYfinance(epic, catalogue);
          if (inst) c.symbol = { ...inst };
          else noteUnmapped(epic);
        }
      out[key] = JSON.stringify(body);
    } catch {
      out[key] = raw;
    }
  }
  return { layout: out, unmapped };
}

/** Remap a hand-typed watchlist the same way. Unmappable entries are
 *  reported, not dropped - the caller refuses the publish. */
export function remapWatchlist(
  epics: string[],
  catalogue: Map<string, Instrument>,
): { epics: string[]; unmapped: string[] } {
  const out: string[] = [];
  const unmapped: string[] = [];
  for (const epic of epics) {
    const inst = mapEpicToYfinance(epic, catalogue);
    if (inst) {
      if (!out.includes(inst.epic)) out.push(inst.epic);
    } else if (!unmapped.includes(epic)) unmapped.push(epic);
  }
  return { epics: out, unmapped };
}
