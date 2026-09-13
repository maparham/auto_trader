// The published demo snapshot: fetched once at boot (DemoApp) from the
// public `GET /api/demo/snapshot`, and the seed/capture pair that moves its
// `layout` map into and out of localStorage. Plain `fetch` (not `apiFetch`):
// this endpoint is public and unauthenticated, and the demo boot must not
// depend on Clerk having minted a token yet.
import { API_BASE } from "./http";
import { PREFIX, root, familyRoot } from "./persist/core";
import { readScopeContent } from "./persist/transfer";

// `layout` is a map of workspace-persist SUFFIX -> raw JSON string, exactly
// as persist/core's root()/familyRoot() key builders address them (see
// keyForSuffix below). A later "publish" (Task 9) fills this map by reading
// the same keys back out of localStorage via captureDemoLayout(); seeding it
// here is just writing those same keys forward into a fresh browser.
export type DemoSnapshot = {
  version: number;
  /** Data broker the demo serves on ("yfinance" for new publishes; payloads
   *  from before the field existed fall back to "dukascopy"). DemoApp points
   *  the persist broker here BEFORE seeding, and App pins the demo account to
   *  `${broker}:data`. */
  broker: string;
  layout: Record<string, string>;
  watchlist: string[];
  backtests: { name: string; result: Record<string, unknown> }[];
};

let current: DemoSnapshot | null = null;

/** Fetch and parse the published demo snapshot. `null` on 404 (nothing
 *  published yet), any other non-OK status, or a network failure - all
 *  equally mean "boot the demo without a curated layout" to the caller. */
export async function fetchDemoSnapshot(): Promise<DemoSnapshot | null> {
  try {
    const res = await fetch(`${API_BASE}/api/demo/snapshot`);
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body.version !== "number" || !body.payload) return null;
    const payload = body.payload as Record<string, unknown>;
    const snapshot: DemoSnapshot = {
      version: body.version,
      broker: typeof payload.broker === "string" ? payload.broker : "dukascopy",
      layout: (payload.layout as Record<string, string>) ?? {},
      watchlist: Array.isArray(payload.watchlist) ? (payload.watchlist as string[]) : [],
      backtests: Array.isArray(payload.backtests)
        ? (payload.backtests as DemoSnapshot["backtests"])
        : [],
    };
    current = snapshot;
    return snapshot;
  } catch {
    return null;
  }
}

/** The last snapshot `fetchDemoSnapshot` resolved (or null before boot / on
 *  no publish). Synchronous so App components can read it after boot without
 *  threading the fetch promise through the tree. */
export function getDemoSnapshot(): DemoSnapshot | null {
  return current;
}

// --- layout suffix list: the ONE place capture (publish) and seed (boot) ---
// agree on what "the layout" means. Mirrors the MIRRORED roots documented in
// persist/workspace.ts's "named workspace layouts" section: the layout INDEX,
// its DEFAULT pointer, and each named layout's BODY.
const LAYOUTS_SUFFIX = "layouts";
const DEFAULT_LAYOUT_SUFFIX = "defaultLayoutId";
const layoutBodySuffix = (id: string) => `layout.${id}`;

// A layout body is only the skeleton (tabs, cells, symbols, periods). What a
// chart actually SHOWS - drawings, indicators, indicatorConfig, avwap anchors,
// per-cell view flags - lives under the cell's own scope, which is NOT broker
// keyed (see persist/core's "what is and isn't broker-scoped"). Those entries
// ride in the same map behind this marker: `scope:<scope>.<suffix>` addresses
// `${PREFIX}.<scope>.<suffix>` verbatim. Payloads published before this existed
// simply carry none, so they seed exactly as they used to.
const SCOPE_MARK = "scope:";
// Scope content a DEMO visitor must not inherit. A `backtest.<epic>` pointer
// names a run id in the admin's backend; the demo principal cannot fetch
// /api/backtest at all (see api/demo_access.py), so seeding one buys a failed
// request per chart. Sweeps are the same story, and snapshotMeta belongs to the
// gallery, which demo hides.
const SKIPPED_SCOPE_SUFFIXES = ["backtest.", "sweep.", "snapshotMeta"];

function scopeSuffixWanted(suffix: string): boolean {
  return !SKIPPED_SCOPE_SUFFIXES.some((s) => suffix.startsWith(s));
}

// defaultLayoutId is per-feed (root()); the index and each layout body are
// shared across a broker family (familyRoot()) - see persist/core.ts.
function keyForSuffix(suffix: string): string {
  if (suffix.startsWith(SCOPE_MARK)) return `${PREFIX}.${suffix.slice(SCOPE_MARK.length)}`;
  return suffix === DEFAULT_LAYOUT_SUFFIX ? root(suffix) : familyRoot(suffix);
}

/** Every cell scope named by a layout body, in order. */
function scopesOfBody(raw: string): string[] {
  try {
    const ws = JSON.parse(raw) as { tabs?: Array<{ cells?: Array<{ scope?: string }> }> };
    const out: string[] = [];
    for (const t of ws.tabs ?? [])
      for (const c of t.cells ?? []) if (c.scope) out.push(c.scope);
    return out;
  } catch {
    return [];
  }
}

/** Read the ACTIVE persist broker's layout keys back out of localStorage, as
 *  raw JSON strings keyed by suffix, ready to publish. Caller sets the
 *  persist broker (e.g. to "dukascopy") before calling. */
export function captureDemoLayout(): Record<string, string> {
  const out: Record<string, string> = {};
  const layoutsRaw = localStorage.getItem(keyForSuffix(LAYOUTS_SUFFIX));
  if (layoutsRaw == null) return out;
  out[LAYOUTS_SUFFIX] = layoutsRaw;
  const defaultRaw = localStorage.getItem(keyForSuffix(DEFAULT_LAYOUT_SUFFIX));
  if (defaultRaw != null) out[DEFAULT_LAYOUT_SUFFIX] = defaultRaw;
  try {
    const list = JSON.parse(layoutsRaw) as Array<{ id: string }>;
    for (const { id } of list) {
      const suffix = layoutBodySuffix(id);
      const raw = localStorage.getItem(keyForSuffix(suffix));
      if (raw == null) continue;
      out[suffix] = raw;
      for (const scope of scopesOfBody(raw))
        for (const [s, v] of Object.entries(readScopeContent(scope)))
          if (scopeSuffixWanted(s)) out[`${SCOPE_MARK}${scope}.${s}`] = v;
    }
  } catch {
    /* malformed index: publish just what parsed above */
  }
  return out;
}

/** Write a published `layout` map into localStorage under whichever broker
 *  persist/core's persistBroker currently points at. DemoApp calls
 *  setPersistBroker("dukascopy") first. */
export function seedDemoLayout(layout: Record<string, string>): void {
  for (const [suffix, json] of Object.entries(layout)) {
    try {
      localStorage.setItem(keyForSuffix(suffix), json);
    } catch {
      /* storage unavailable or full: best effort, App still boots */
    }
  }
}

/** What captureDemoLayout() would publish, for the admin editor's summary row:
 *  how many saved layouts the active broker has, the name of the one visitors
 *  would open (App's startup falls back to defaultLayoutId in a fresh browser),
 *  how many scope entries the DEFAULT layout's cells contributed (drawings,
 *  indicators, view flags), and the payload's size in bytes.
 *
 *  `scopeItems` is the one that catches a hollow publish: a body saved before
 *  the admin drew anything, or a live workspace that was never saved back into
 *  its layout, captures tabs with no content under them. */
export interface DemoLayoutSummary {
  count: number;
  defaultName: string | null;
  scopeItems: number;
  bytes: number;
}

export function describeDemoLayout(): DemoLayoutSummary {
  const captured = captureDemoLayout();
  const bytes = JSON.stringify(captured).length;
  const raw = captured[LAYOUTS_SUFFIX];
  if (raw == null) return { count: 0, defaultName: null, scopeItems: 0, bytes: 0 };
  try {
    const list = JSON.parse(raw) as Array<{ id: string; name?: string }>;
    if (!Array.isArray(list)) return { count: 0, defaultName: null, scopeItems: 0, bytes };
    const defRaw = captured[DEFAULT_LAYOUT_SUFFIX];
    const defId = defRaw != null ? (JSON.parse(defRaw) as string) : null;
    const hit = defId ? list.find((l) => l.id === defId) : undefined;
    const body = defId ? captured[layoutBodySuffix(defId)] : undefined;
    const defScopes = body ? scopesOfBody(body) : [];
    const scopeItems = Object.keys(captured).filter(
      (k) =>
        k.startsWith(SCOPE_MARK) &&
        defScopes.some((sc) => k.startsWith(`${SCOPE_MARK}${sc}.`)),
    ).length;
    return { count: list.length, defaultName: hit?.name ?? null, scopeItems, bytes };
  } catch {
    return { count: 0, defaultName: null, scopeItems: 0, bytes };
  }
}
