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
// yfinance catalogue. Best-effort by design: anything with no known mapping
// is passed through VERBATIM, never refused - yfinance treats unknown epics
// as raw Yahoo tickers, so a searched symbol (NKE) publishes fine and a
// genuinely untranslatable epic degrades to an empty chart the admin can see
// in preview.
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
): string {
  for (const mark of EPIC_SUFFIX_MARKS) {
    const at = suffix.indexOf(mark);
    if (at < 0) continue;
    const head = suffix.slice(0, at + mark.length);
    const hit = splitEpic(suffix.slice(at + mark.length), catalogue);
    if (!hit) return suffix; // no known mapping: keep the key as-is
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
 *  same way. Symbols with no mapping, and entries that don't parse, are
 *  copied through untouched - they degrade for a visitor exactly the way
 *  stale localStorage always has. */
export function remapDemoLayout(
  layout: Record<string, string>,
  catalogue: Map<string, Instrument>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(layout)) {
    if (key.startsWith(SCOPE_MARK)) {
      out[`${SCOPE_MARK}${remapScopeKey(key.slice(SCOPE_MARK.length), catalogue)}`] = raw;
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
        }
      out[key] = JSON.stringify(body);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

/** Remap a hand-typed watchlist the same way: known names are translated,
 *  everything else is kept verbatim, and duplicates collapse. */
export function remapWatchlist(
  epics: string[],
  catalogue: Map<string, Instrument>,
): string[] {
  const out: string[] = [];
  for (const epic of epics) {
    const mapped = mapEpicToYfinance(epic, catalogue)?.epic ?? epic;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}
