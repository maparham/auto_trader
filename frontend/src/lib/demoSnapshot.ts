// The published demo snapshot: fetched once at boot (DemoApp) from the
// public `GET /api/demo/snapshot`, and the seed/capture pair that moves its
// `layout` map into and out of localStorage. Plain `fetch` (not `apiFetch`):
// this endpoint is public and unauthenticated, and the demo boot must not
// depend on Clerk having minted a token yet.
import { API_BASE } from "./http";
import { root, familyRoot } from "./persist/core";

// `layout` is a map of workspace-persist SUFFIX -> raw JSON string, exactly
// as persist/core's root()/familyRoot() key builders address them (see
// keyForSuffix below). A later "publish" (Task 9) fills this map by reading
// the same keys back out of localStorage via captureDemoLayout(); seeding it
// here is just writing those same keys forward into a fresh browser.
export type DemoSnapshot = {
  version: number;
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

// defaultLayoutId is per-feed (root()); the index and each layout body are
// shared across a broker family (familyRoot()) - see persist/core.ts.
function keyForSuffix(suffix: string): string {
  return suffix === DEFAULT_LAYOUT_SUFFIX ? root(suffix) : familyRoot(suffix);
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
      if (raw != null) out[suffix] = raw;
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

/** What captureDemoLayout() would publish, for the admin editor's "what gets
 *  published" line: how many saved layouts the active broker has, and the name
 *  of the one visitors would open (App's startup falls back to defaultLayoutId
 *  in a fresh browser). count 0 means there is nothing worth publishing. */
export interface DemoLayoutSummary {
  count: number;
  defaultName: string | null;
}

export function describeDemoLayout(): DemoLayoutSummary {
  const captured = captureDemoLayout();
  const raw = captured[LAYOUTS_SUFFIX];
  if (raw == null) return { count: 0, defaultName: null };
  try {
    const list = JSON.parse(raw) as Array<{ id: string; name?: string }>;
    if (!Array.isArray(list)) return { count: 0, defaultName: null };
    const defRaw = captured[DEFAULT_LAYOUT_SUFFIX];
    const defId = defRaw != null ? (JSON.parse(defRaw) as string) : null;
    const hit = defId ? list.find((l) => l.id === defId) : undefined;
    return { count: list.length, defaultName: hit?.name ?? null };
  } catch {
    return { count: 0, defaultName: null };
  }
}
