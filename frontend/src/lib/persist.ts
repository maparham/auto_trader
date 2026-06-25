// Typed localStorage helpers for chart state that survives a refresh.
//
// Keying convention — each chart CELL is a full TradingView-style layout, so all
// of the below are namespaced by the cell's opaque `scope` prefix:
//  - drawings        : per-scope, per-epic
//  - alerts          : per-scope, per-epic
//  - avwapAnchor     : per-scope, per-epic
//  - indicators      : per-scope
//  - indicatorConfig : per-scope
// Two cells on the SAME symbol are independent. Within a cell we still sub-key the
// per-epic stores by epic (a BTC trendline shouldn't show on the same cell's US100)
// but deliberately NOT by period (a 1H trendline on the 1m chart is acceptable).
// The triggered-alert HISTORY remains global (a cross-cell, cross-symbol log).

import type { DeepPartial, OverlayStyle } from "klinecharts";
import type { Instrument, Period } from "./feed";

const PREFIX = "auto-trader";

// --- backend mirror ----------------------------------------------------------
//
// localStorage stays the synchronous source for rendering (load() is unchanged),
// but every write also mirrors to the backend so the workspace survives across
// browsers/devices. Sync model: BACKEND WINS ON LOAD (TradingView-style) — see
// hydrateFromBackend(). Mirroring is PER-KEY (not a whole-namespace blob), exactly
// like localStorage's independent setItem: two mounted cells writing different keys
// never clobber each other, preserving the no-global-scope design above.
//
// All mirror calls are fire-and-forget — persistence to the backend is best-effort
// and must never block or break the (already-committed) localStorage write. They're
// also guarded so the module stays usable in the test/node env (no fetch/window).
const API_BASE =
  (import.meta as unknown as { env?: { VITE_API_BASE?: string } }).env
    ?.VITE_API_BASE ?? "http://localhost:8000";

// Mirroring is DISABLED until hydrateFromBackend() has pulled the backend snapshot
// (it flips this true). This is the single "don't mirror until hydrated" gate, and
// it's load-bearing in two ways:
//  - it stops every cell's mount-time save() (indicator/avwap/normalize writes that
//    fire during the GET round-trip) from pushing STALE local state over newer
//    backend data before we've pulled it — a per-component `hydrated` prop can't
//    reach those writes, a module flag does.
//  - it keeps the test/node env from hitting a real backend: vitest never calls
//    hydrateFromBackend(), so the flag stays false and save() mirrors nothing
//    (Node 18+ has a global fetch, so `typeof fetch` is NOT a safe test guard).
let mirrorEnabled = false;

// A random id for THIS tab, sent as `origin` on every write. The backend echoes it
// in the live broadcast so this tab can ignore its own change (otherwise receiving
// our own edit back would remount our grid mid-interaction). Stable for the tab's
// lifetime; not persisted (each tab/load is a distinct origin, which is what we
// want — two tabs in the same browser SHOULD sync to each other).
const CLIENT_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Math.floor(Math.random() * 1e9)}`;

// Values we just applied FROM a remote /ws/state push (per key). Re-mirroring the
// same value would echo it back to the tab that sent it; two tabs holding DIFFERENT
// state (e.g. priceSide mid vs bid, or different timeframes) then ping-pong forever
// and thrash the live feed. The React save effects that fire after we apply a push
// can't tell a remote echo from a local edit, so we drop the mirror whose value
// matches what we just applied. Value-based, so a genuine local edit (a different
// value) always mirrors — no risk of swallowing a real change. Entry is consumed on
// match. "\0deleted" marks a remotely-applied delete.
const remoteEcho = new Map<string, string>();

function mirrorSet(key: string, value: string): void {
  if (!mirrorEnabled || typeof fetch === "undefined") return;
  if (remoteEcho.get(key) === value) {
    remoteEcho.delete(key);
    return; // this write is the echo of a value another tab just pushed us
  }
  // `value` is the already-serialized JSON string; reparse so the body is
  // {value:<json>} and the backend stores it the same shape it'll hand back.
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  void fetch(
    `${API_BASE}/api/state/${encodeURIComponent(key)}?origin=${CLIENT_ID}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: parsed }),
    },
  ).catch(() => {
    /* offline / backend down: localStorage already holds the write */
  });
}

function mirrorDelete(key: string): void {
  if (!mirrorEnabled || typeof fetch === "undefined") return;
  if (remoteEcho.get(key) === "\0deleted") {
    remoteEcho.delete(key);
    return; // echo of a remote delete
  }
  void fetch(
    `${API_BASE}/api/state/${encodeURIComponent(key)}?origin=${CLIENT_ID}`,
    { method: "DELETE" },
  ).catch(() => {
    /* best-effort */
  });
}

// --- per-cell namespacing ----------------------------------------------------
//
// Each cell is a full TradingView-style layout: its own indicators, drawings,
// alerts and AVWAP anchors, INDEPENDENT even when two cells show the same symbol.
// We achieve that by prefixing every layout storage key with the cell's `scope`.
// The scope is an OPAQUE string stored on the cell (see ChartCell.scope) and
// passed explicitly to every accessor — there is NO global "active scope" mutable,
// because multiple cells are mounted at once and each must address its own keys
// (an async rehydrate race would otherwise let the last writer win).
//
// Scope shape:
//  - migrated single cell : `tab.<tabId>`              (byte-identical to the
//                           pre-cells keys, so existing layouts survive upgrade)
//  - any additional cell  : `tab.<tabId>.cell.<cellId>`
const ns = (scope: string, suffix: string) => `${PREFIX}.${scope}.${suffix}`;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save<T>(key: string, value: T): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
  } catch {
    /* quota / serialization issues are non-fatal for persistence */
    return;
  }
  mirrorSet(key, serialized); // best-effort backend mirror (fire-and-forget)
}

// App-level settings (theme/timezone/clock/dateFormat + alert defaults) live under
// a single PREFIX-owned key and ride the same backend mirror + cross-device sync as
// the rest of the workspace. theme.ts owns the shape and defaults; these thin
// wrappers just give it the mirrored load/save (theme.ts must not reach into
// localStorage directly, or settings would stop syncing).
const SETTINGS_KEY = `${PREFIX}.settings`;
export function loadSettingsRaw<T>(fallback: T): T {
  return load<T>(SETTINGS_KEY, fallback);
}
export function saveSettingsRaw<T>(value: T): void {
  save(SETTINGS_KEY, value);
}

// --- device-local writes (NOT mirrored) --------------------------------------
//
// A handful of keys are intentionally PER-DEVICE and must never reach the backend
// or other instances: which named layout this browser/tab currently has open
// (`activeLayoutId`) and the unsaved scratch workspace. They share localStorage's
// synchronous read (load()) but use this non-mirroring write so switching layout
// on one device doesn't drag every other instance to the same layout.
function saveLocal<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / serialization issues are non-fatal */
  }
}
function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
}

// --- startup hydration (backend wins) ----------------------------------------
//
// On app start, pull the whole workspace snapshot from the backend and overwrite
// localStorage with it — the backend is the source of truth, so opening any
// device shows the latest layout (TradingView-style). The synchronous initial
// render still uses whatever localStorage already holds (instant, no flash on the
// common same-device case); this reconciles a beat later only when another device
// wrote something newer.
//
// First-run seeding: if the backend is EMPTY (fresh install) but this browser has
// local state, push the local keys up instead of wiping them — so an existing
// user's current browser becomes the seed rather than being cleared.
//
// Returns true if localStorage changed (caller should re-read tabs into React
// state to re-render); false if nothing changed or the backend was unreachable
// (graceful offline — keep working off localStorage).
export async function hydrateFromBackend(): Promise<boolean> {
  if (typeof fetch === "undefined") return false;
  let snapshot: Record<string, unknown>;
  try {
    const res = await fetch(`${API_BASE}/api/state`);
    if (!res.ok) return false;
    snapshot = (await res.json()) as Record<string, unknown>;
  } catch {
    return false; // backend down → keep local state, app still works
  }
  // A non-object body (null / array / primitive) is a malformed snapshot we can't
  // reconcile. Bail BEFORE enabling mirroring so we keep working off localStorage
  // and don't start pushing writes against state we never validated. (Object.keys
  // below would otherwise throw on null — AFTER mirroring was already live.)
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  // Backend reachable and snapshot in hand: from here on, mirror every write up.
  // (Flipped BEFORE the writes below so seedBackendFromLocal's PUTs go through.)
  mirrorEnabled = true;

  const keys = Object.keys(snapshot);
  if (keys.length === 0) {
    // Empty backend: seed it from this browser's existing localStorage (the only
    // keys we own are PREFIX-namespaced) so we don't start by wiping the user.
    seedBackendFromLocal();
    return false;
  }

  let changed = false;
  for (const key of keys) {
    const next = JSON.stringify(snapshot[key]);
    if (localStorage.getItem(key) !== next) {
      localStorage.setItem(key, next);
      changed = true;
    }
  }
  // Upserting alone lets a layout deleted on another device reappear here: its key
  // is absent from the snapshot but still in our localStorage, and (mirrorEnabled
  // now true) the next write would push it back up, resurrecting it everywhere. The
  // backend is the source of truth, so remove any PREFIX-owned key it doesn't carry.
  // Direct removeItem (not save/purge) so we DON'T mirror the delete back up — the
  // backend already lacks it. Snapshot keys are the exact localStorage keys.
  const present = new Set(keys);
  const own = `${PREFIX}.`;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(own) || present.has(k) || DEVICE_LOCAL_KEYS.has(k)) continue;
    localStorage.removeItem(k);
    changed = true;
  }
  return changed;
}

// One-time push of every PREFIX-owned localStorage key to a fresh/empty backend.
// Uses mirrorSet (fire-and-forget) — best-effort, never blocks startup. Skips the
// device-local keys (activeLayoutId / scratch): seeding them would leak this
// browser's open layout into the snapshot, and another device's hydrate would then
// adopt it — the very cross-device bleed these keys are meant to avoid.
function seedBackendFromLocal(): void {
  const own = `${PREFIX}.`;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(own) || DEVICE_LOCAL_KEYS.has(k)) continue;
    const v = localStorage.getItem(k);
    if (v != null) mirrorSet(k, v);
  }
}

// --- live cross-tab/device updates (WebSocket push) --------------------------
//
// After hydration, subscribe to /ws/state. When ANOTHER tab/device writes, the
// backend pushes {key, value, origin} (upsert) or {key, deleted, origin}. We apply
// it to localStorage DIRECTLY — never through save(), which would re-mirror it and
// loop — and invoke `onChange` so React re-seeds + remounts to show it. Our own
// echoes (origin === CLIENT_ID) are ignored so an active edit doesn't remount us.
//
// Reconnects with backoff: the dev backend runs under `--reload`, so the socket
// drops on every backend edit and must come back on its own.
type StateMessage =
  | { key: string; value: unknown; origin?: string }
  | { key: string; deleted: true; origin?: string };

export function subscribeToBackendUpdates(onChange: () => void): () => void {
  if (typeof WebSocket === "undefined") return () => {};
  const url = `${API_BASE.replace(/^http/, "ws")}/ws/state`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;

  const connect = (): void => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
    };
    ws.onmessage = (ev) => {
      let msg: StateMessage;
      try {
        msg = JSON.parse(ev.data as string) as StateMessage;
      } catch {
        return;
      }
      if (msg.origin === CLIENT_ID) return; // ignore our own echo
      if ("deleted" in msg && msg.deleted) {
        localStorage.removeItem(msg.key);
        remoteEcho.set(msg.key, "\0deleted");
      } else {
        const serialized = JSON.stringify((msg as { value: unknown }).value);
        localStorage.setItem(msg.key, serialized);
        // Remember it so the save effect this triggers doesn't mirror it back out
        // (see remoteEcho) — otherwise two differing tabs ping-pong and the feed thrashes.
        remoteEcho.set(msg.key, serialized);
      }
      onChange();
    };
    ws.onclose = () => {
      if (closed) return;
      // Backoff 0.5s → 5s; the backend may be mid-reload.
      const delay = Math.min(5000, 500 * 2 ** retry++);
      setTimeout(connect, delay);
    };
    // An error fires onclose right after; let onclose own the reconnect.
    ws.onerror = () => ws?.close();
  };

  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}

// --- chart tabs + cells (multi-chart layouts) --------------------------------

// TradingView-style split layouts. A tab is one layout holding 1..N cells; each
// cell is an independent chart view (instrument + interval + its own layout state
// addressed by `scope`). `2h` = side-by-side, `2v` = stacked, `4` = 2x2, etc.
export type LayoutKind = "1" | "2h" | "2v" | "3" | "4";

// Number of cells each layout shows (drives add/trim when the layout changes).
export const LAYOUT_CELLS: Record<LayoutKind, number> = {
  "1": 1,
  "2h": 2,
  "2v": 2,
  "3": 3,
  "4": 4,
};

export interface ChartCell {
  id: string;
  symbol: Instrument;
  period: Period;
  scope: string; // opaque per-cell storage prefix (see ns())
}

export interface ChartTab {
  id: string;
  layout: LayoutKind;
  cells: ChartCell[];
  activeCellId: string;
  // Per-tab sync toggles (TradingView "link" controls). When on, a change in the
  // focused cell broadcasts to the tab's other cells.
  syncSymbol?: boolean;
  syncInterval?: boolean;
  syncCrosshair?: boolean;
  // When on, scrolling/zooming the time axis in the focused chart matches the same
  // wall-clock window on the tab's other cells (cross-interval; mapped by timestamp).
  syncTime?: boolean;
  // Master "lock charts" override. When on, every interaction with the cell under
  // the cursor (TF change, pan, zoom, crosshair) mirrors to the tab's other cells
  // as if the cursor were on each of them — each cell keeps its own symbol. It's a
  // derived override of the four flags above (interval/crosshair/time forced on,
  // symbol forced off) so unlocking restores their prior state for free; the flags
  // themselves are never mutated. See the effective* helpers in App.tsx.
  locked?: boolean;
}

// Pre-cells persisted tab shape (one chart per tab). Kept only to migrate.
interface ChartTabV1 {
  id: string;
  symbol: Instrument;
  period: Period;
}

const TABS_KEY = `${PREFIX}.tabs`;
const ACTIVE_TAB_KEY = `${PREFIX}.activeTab`;

// The migrated cell reuses the tab's own prefix so its keys are byte-identical to
// the pre-cells layout — existing drawings/alerts/indicators survive the upgrade.
export const primaryCellScope = (tabId: string) => `tab.${tabId}`;
export const cellScope = (tabId: string, cellId: string) =>
  `tab.${tabId}.cell.${cellId}`;

// Convert a persisted v1 tab (one chart) into the cell-based shape: a single
// primary cell carrying the tab's old symbol/period and the byte-identical scope.
function migrateTabV1(t: ChartTabV1): ChartTab {
  const cellId = `${t.id}-c0`;
  return {
    id: t.id,
    layout: "1",
    cells: [
      { id: cellId, symbol: t.symbol, period: t.period, scope: primaryCellScope(t.id) },
    ],
    activeCellId: cellId,
  };
}

// Migrate any v1 entries (no `cells`) so old users keep their work. Shared by
// loadTabs (legacy bare-tabs key) and loadLayout/loadScratch (layout bodies).
function migrateTabs(list: Array<ChartTab | ChartTabV1>): ChartTab[] {
  return list.map((t) =>
    "cells" in t && Array.isArray((t as ChartTab).cells)
      ? (t as ChartTab)
      : migrateTabV1(t as ChartTabV1),
  );
}

export function loadTabs(): ChartTab[] | null {
  const list = load<Array<ChartTab | ChartTabV1> | null>(TABS_KEY, null);
  if (!Array.isArray(list) || list.length === 0) return null;
  return migrateTabs(list);
}
export function saveTabs(tabs: ChartTab[]): void {
  save(TABS_KEY, tabs);
}
export function loadActiveTab(): string | null {
  return load<string | null>(ACTIVE_TAB_KEY, null);
}
export function saveActiveTab(id: string): void {
  save(ACTIVE_TAB_KEY, id);
}

// --- named workspace layouts -------------------------------------------------
//
// A LAYOUT is a named snapshot of the ENTIRE workspace: every tab (each tab a
// multi-cell split), plus which tab was active. TradingView's "Layouts" — open
// any device and apply your default; save the current arrangement under a name.
//
// Sync split (deliberate, see saveLocal above):
//   - the layout INDEX (`layouts`), each layout's body (`layout.<id>`) and the
//     DEFAULT (`defaultLayoutId`) are MIRRORED → they appear on every device.
//   - the ACTIVE layout (`activeLayoutId`) and the unsaved SCRATCH workspace are
//     DEVICE-LOCAL → each browser/tab can have a different layout open.
//
// Per-cell content (drawings/indicators/alerts/avwap/indicatorConfig) is NOT
// re-namespaced per layout: it's already addressed by each cell's globally-unique
// `scope` (`tab.<tabId>[.cell.<cellId>]`), and a layout's tabs carry those scopes.
// The ONE rule that keeps layouts independent: cloning a layout ("Save as…") must
// generate fresh tab/cell ids AND copy each cell's scope content to the new scopes
// (see cloneWorkspace) — otherwise two layouts alias the same drawings.

const LAYOUTS_KEY = `${PREFIX}.layouts`;
const DEFAULT_LAYOUT_KEY = `${PREFIX}.defaultLayoutId`;
const ACTIVE_LAYOUT_KEY = `${PREFIX}.activeLayoutId`; // device-local
const SCRATCH_KEY = `${PREFIX}.scratch`; // device-local

// PREFIX-owned keys that are intentionally NEVER mirrored (written via saveLocal).
// hydrateFromBackend's prune must skip these: the backend snapshot never contains
// them, so pruning them would wipe this device's open layout / scratch on startup.
const AUTOSAVE_KEY = `${PREFIX}.autosave`; // device-local
const DEVICE_LOCAL_KEYS: ReadonlySet<string> = new Set([
  ACTIVE_LAYOUT_KEY,
  SCRATCH_KEY,
  AUTOSAVE_KEY,
]);
const layoutKey = (id: string) => `${PREFIX}.layout.${id}`;

export interface LayoutMeta {
  id: string;
  name: string;
}
// The persisted body of one layout: the workspace it captures.
export interface Workspace {
  tabs: ChartTab[];
  activeTabId: string;
}

export function loadLayouts(): LayoutMeta[] {
  return load<LayoutMeta[]>(LAYOUTS_KEY, []);
}
export function loadLayout(id: string): Workspace | null {
  const w = load<Workspace | null>(layoutKey(id), null);
  if (!w || !Array.isArray(w.tabs)) return null;
  // Run any v1 tabs in the body through the same migration loadTabs() applies.
  return { tabs: migrateTabs(w.tabs), activeTabId: w.activeTabId };
}

// Create or update-in-place the layout `id` (keeps tab/cell ids → scopes, so the
// existing per-cell content stays addressed). Used by both "Save" (existing id)
// and the index bookkeeping for a freshly-created layout.
export function saveLayout(id: string, name: string, ws: Workspace): void {
  save(layoutKey(id), ws);
  const list = loadLayouts();
  const idx = list.findIndex((l) => l.id === id);
  if (idx >= 0) list[idx] = { id, name };
  else list.push({ id, name });
  save(LAYOUTS_KEY, list);
}

export function renameLayout(id: string, name: string): void {
  const list = loadLayouts();
  const idx = list.findIndex((l) => l.id === id);
  if (idx < 0) return;
  list[idx] = { id, name };
  save(LAYOUTS_KEY, list);
}

// Delete a layout: drop its index entry, its body, every cell scope it owned, and
// clear the default if it pointed here. (activeLayoutId is healed by the caller.)
export function deleteLayout(id: string): void {
  const ws = loadLayout(id);
  const list = loadLayouts().filter((l) => l.id !== id);
  save(LAYOUTS_KEY, list);
  removeKeyEverywhere(layoutKey(id));
  if (ws) for (const t of ws.tabs) purgeTabScope(t.id);
  if (loadDefaultLayoutId() === id) saveDefaultLayoutId(null);
}

export function loadDefaultLayoutId(): string | null {
  return load<string | null>(DEFAULT_LAYOUT_KEY, null);
}
export function saveDefaultLayoutId(id: string | null): void {
  if (id == null) {
    removeKeyEverywhere(DEFAULT_LAYOUT_KEY);
  } else {
    save(DEFAULT_LAYOUT_KEY, id);
  }
}

// Device-local: which layout this browser/tab currently shows. null = scratch.
export function loadActiveLayoutId(): string | null {
  return load<string | null>(ACTIVE_LAYOUT_KEY, null);
}
export function saveActiveLayoutId(id: string | null): void {
  if (id == null) removeLocal(ACTIVE_LAYOUT_KEY);
  else saveLocal(ACTIVE_LAYOUT_KEY, id);
}

// Device-local: the unsaved workspace shown before the user names a layout.
export function loadScratch(): Workspace | null {
  const w = load<Workspace | null>(SCRATCH_KEY, null);
  if (!w || !Array.isArray(w.tabs)) return null;
  return { tabs: migrateTabs(w.tabs), activeTabId: w.activeTabId };
}
export function saveScratch(ws: Workspace): void {
  saveLocal(SCRATCH_KEY, ws);
}
export function clearScratch(): void {
  removeLocal(SCRATCH_KEY);
}

// Device-local: whether autosave is enabled (default true, matching TV).
export function loadAutosave(): boolean {
  return load<boolean>(AUTOSAVE_KEY, true);
}
export function saveAutosave(enabled: boolean): void {
  saveLocal(AUTOSAVE_KEY, enabled);
}

// Remove a mirrored key from this device AND tell the backend/other tabs to drop
// it. (save() always mirrors; there was no symmetric remove-and-mirror helper.)
function removeKeyEverywhere(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  mirrorDelete(key);
}

// Deep-copy a workspace under FRESH tab/cell ids, copying each cell's scope
// content (drawings/indicators/alerts/avwap/indicatorConfig) to the new scopes so
// the copy is fully independent of the source. Returns the new workspace plus the
// scope remap (unused by callers today, handy for tests/debug). `mintTabId` /
// `mintCellId` are injected so the caller owns id generation (App.tsx's seq).
export function cloneWorkspace(
  src: Workspace,
  mintTabId: () => string,
  mintCellId: () => string,
): Workspace {
  const tabs: ChartTab[] = src.tabs.map((t) => {
    const newTabId = mintTabId();
    let activeCellId = "";
    const cells: ChartCell[] = t.cells.map((c, i) => {
      const newCellId = i === 0 ? null : mintCellId();
      // The primary cell reuses the tab's primary scope (mirrors makeTab/migrate).
      const id = newCellId ?? `${newTabId}-c0`;
      const scope =
        i === 0 ? primaryCellScope(newTabId) : cellScope(newTabId, id);
      copyScopeContent(c.scope, scope);
      if (c.id === t.activeCellId || activeCellId === "") activeCellId = id;
      return { id, symbol: c.symbol, period: c.period, scope };
    });
    return {
      id: newTabId,
      layout: t.layout,
      cells,
      activeCellId: cells.some((c) => c.id === activeCellId)
        ? activeCellId
        : cells[0].id,
      syncSymbol: t.syncSymbol,
      syncInterval: t.syncInterval,
      syncCrosshair: t.syncCrosshair,
      syncTime: t.syncTime,
      locked: t.locked,
    };
  });
  const srcActiveIdx = src.tabs.findIndex((t) => t.id === src.activeTabId);
  return {
    tabs,
    activeTabId: tabs[srcActiveIdx >= 0 ? srcActiveIdx : 0]?.id ?? "",
  };
}

// Copy every `${PREFIX}.<from>.*` key to `${PREFIX}.<to>.*` (mirrored to the
// backend). Used by cloneWorkspace. CAREFUL: a primary scope (`tab.<id>`) is a
// PREFIX of its nested cell scopes (`tab.<id>.cell.<cid>`), so a naive prefix scan
// would also drag every nested-cell key into the clone's primary scope (leaked junk
// under stale cell ids). Each cell is copied under its OWN scope by the caller, so
// here we EXCLUDE the nested `cell.` keys when copying a primary scope.
function copyScopeContent(from: string, to: string): void {
  const head = `${PREFIX}.${from}.`;
  const nested = `${head}cell.`; // only meaningful when `from` is a primary scope
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(head) && !k.startsWith(nested))
      pairs.push([k, `${PREFIX}.${to}.${k.slice(head.length)}`]);
  }
  for (const [src, dst] of pairs) {
    const v = localStorage.getItem(src);
    if (v == null) continue;
    try {
      localStorage.setItem(dst, v);
      mirrorSet(dst, v);
    } catch {
      /* non-fatal */
    }
  }
}

// --- drawings (overlays the user drew) ---------------------------------------

export interface SavedOverlay {
  name: string;
  points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>;
  styles?: DeepPartial<OverlayStyle> | null;
  lock?: boolean;
  // TV-style edit state. All optional → older saved drawings (which lack them)
  // rehydrate unchanged: visible defaults true, zLevel 0, extendData absent.
  visible?: boolean;
  zLevel?: number;
  extendData?: unknown;
}

const drawingsKey = (scope: string, epic: string) => ns(scope, `drawings.${epic}`);

export function loadDrawings(scope: string, epic: string): SavedOverlay[] {
  return load<SavedOverlay[]>(drawingsKey(scope, epic), []);
}
export function saveDrawings(scope: string, epic: string, list: SavedOverlay[]): void {
  save(drawingsKey(scope, epic), list);
}

// --- active indicators (per cell) --------------------------------------------

// One active indicator INSTANCE. `id` is the unique klinecharts name (e.g.
// "EMA#a1b2"); `type` is the real indicator type (EMA/MA/AVWAP/RSI/…). Multiple
// instances of the same type can coexist — that's the whole point. (Was a bare
// `string[]` of type-names back when only one instance per type was allowed.)
export interface IndicatorInstance {
  id: string;
  type: string;
}

const indicatorsKey = (scope: string) => ns(scope, "indicators");

// Load the active instance list, MIGRATING the old `string[]` (one instance per
// name) shape: each old name becomes an instance whose id === type === name. Using
// the name as the id is deliberate — the per-indicator config map was ALSO keyed by
// name, so a name-as-id instance keeps reading its existing saved config with zero
// config migration.
export function loadIndicators(scope: string): IndicatorInstance[] {
  const raw = load<Array<string | IndicatorInstance>>(indicatorsKey(scope), []);
  return raw.map((e) =>
    typeof e === "string" ? { id: e, type: e } : { id: e.id, type: e.type },
  );
}
export function saveIndicators(scope: string, list: IndicatorInstance[]): void {
  save(indicatorsKey(scope), list);
}

// --- favourite indicators (global preference) --------------------------------
//
// Which indicator TYPES the user has starred in the menu — a personal preference,
// NOT chart state, so it is global (no scope) rather than per-cell. The per-cell
// `indicators` store above is the ACTIVE set on one chart; this is just the
// "shortlist" shown in the menu's Favorites section. Stored as an ordered list of
// type codes (e.g. ["EMA", "RSI"]); order = the order they were starred.
const FAVORITE_INDICATORS_KEY = `${PREFIX}.indicatorFavorites`;

export function loadFavoriteIndicators(): string[] {
  return load<string[]>(FAVORITE_INDICATORS_KEY, []);
}
export function saveFavoriteIndicators(list: string[]): void {
  save(FAVORITE_INDICATORS_KEY, list);
}

// --- per-indicator presets (global, keyed by indicator TYPE) -----------------
//
// TradingView's indicator settings "Defaults" menu. GLOBAL (not per-cell, not
// per-symbol) — a personal preference like the favourites list above — so a tuned
// EMA setup is available on every chart. Two layers, both keyed by indicator TYPE
// (EMA/MA/RSI/…), both holding the SAME SavedIndicatorConfig snapshot the settings
// modal already produces (currentConfig) — no new serialization:
//  - default : ONE config per type. Freshly-ADDED instances of that type seed from
//              it (see applyIndicator). Never touches existing/rehydrated instances.
//  - presets : named configs per type ("Fast EMA", …), applied on demand.
// The AVWAP anchor is intentionally absent from SavedIndicatorConfig, so a preset is
// anchorless — correct, since a fresh AVWAP is unplaced regardless.
const indicatorDefaultKey = (type: string) => `${PREFIX}.indicatorDefault.${type}`;
const indicatorPresetsKey = (type: string) => `${PREFIX}.indicatorPresets.${type}`;

export function loadIndicatorDefault(type: string): SavedIndicatorConfig | null {
  return load<SavedIndicatorConfig | null>(indicatorDefaultKey(type), null);
}
export function saveIndicatorDefault(type: string, cfg: SavedIndicatorConfig): void {
  save(indicatorDefaultKey(type), cfg);
}
export function clearIndicatorDefault(type: string): void {
  const key = indicatorDefaultKey(type);
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  mirrorDelete(key);
}

export function loadIndicatorPresets(type: string): Record<string, SavedIndicatorConfig> {
  return load<Record<string, SavedIndicatorConfig>>(indicatorPresetsKey(type), {});
}
export function saveIndicatorPreset(
  type: string,
  name: string,
  cfg: SavedIndicatorConfig,
): void {
  const all = loadIndicatorPresets(type);
  all[name] = cfg;
  save(indicatorPresetsKey(type), all);
}
export function deleteIndicatorPreset(type: string, name: string): void {
  const all = loadIndicatorPresets(type);
  if (name in all) {
    delete all[name];
    save(indicatorPresetsKey(type), all);
  }
}

// --- per-symbol chart templates (global, keyed by epic) ----------------------
//
// A saved layout (indicators + drawings) tied to a SYMBOL, not a cell — so a
// NAS100 setup can follow NAS100 onto any chart. TradingView's "chart layout
// template" / "apply default to symbol". v1 = ONE default template per epic
// (saving overwrites it; that single template auto-applies to fresh charts of the
// symbol and can be applied on demand to any chart).
//
// The payload reuses the existing saved shapes VERBATIM (IndicatorInstance[],
// per-id SavedIndicatorConfig, SavedOverlay[]) so capture/apply just shuttle the
// same blobs the per-cell stores already hold — no new serialization. AVWAP anchors
// (deliberately NOT inside SavedIndicatorConfig — they live under avwap.<epic>.<id>)
// are captured separately so a templated AVWAP keeps its anchor. Stored under a
// global (un-scoped) key so it's shared across cells/tabs and mirrored to the
// backend like everything else.
export interface SymbolTemplate {
  epic: string;
  indicators: IndicatorInstance[];
  indicatorConfigs: Record<string, SavedIndicatorConfig>;
  drawings: SavedOverlay[];
  avwapAnchors: Record<string, number>; // instance id -> anchor ms
  savedAt: number;
}

const templateKey = (epic: string) => `${PREFIX}.template.${epic}`;

export function loadSymbolTemplate(epic: string): SymbolTemplate | null {
  return load<SymbolTemplate | null>(templateKey(epic), null);
}
export function saveSymbolTemplate(t: SymbolTemplate): void {
  save(templateKey(t.epic), t);
}
export function deleteSymbolTemplate(epic: string): void {
  const key = templateKey(epic);
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  mirrorDelete(key); // keep the backend / other tabs in step
}

// --- global default chart template (symbol-agnostic) -------------------------
//
// A single, NOT-per-epic default layout that auto-applies to EVERY fresh chart
// regardless of symbol — for indicators useful on almost any chart (Volume, a
// session VWAP, etc.) so they don't have to be re-added by hand each time.
// TradingView's "apply as default to all symbols".
//
// Unlike SymbolTemplate this carries ONLY indicators + their per-id configs:
// drawings and AVWAP anchors are price/time/epic-specific (drawings live under
// the epic; anchors under avwap.<epic>.<id>), so they're meaningless-to-wrong on
// an arbitrary symbol and are deliberately excluded at capture. Stored under one
// global key, mirrored to the backend like everything else.
export interface DefaultTemplate {
  indicators: IndicatorInstance[];
  indicatorConfigs: Record<string, SavedIndicatorConfig>;
  savedAt: number;
}

const defaultTemplateKey = () => `${PREFIX}.defaultTemplate`;

export function loadDefaultTemplate(): DefaultTemplate | null {
  return load<DefaultTemplate | null>(defaultTemplateKey(), null);
}
export function saveDefaultTemplate(t: DefaultTemplate): void {
  save(defaultTemplateKey(), t);
}
export function deleteDefaultTemplate(): void {
  const key = defaultTemplateKey();
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  mirrorDelete(key); // keep the backend / other tabs in step
}

// Full per-indicator settings snapshot, keyed by instance id (per cell, like the
// active set). Survives reload so Inputs (length / source / offset / smoothing /
// MTF timeframe via extendData), Style (line color/size), Visibility, and the
// "hide value in legend" toggle all stick. Applied when the indicator is
// (re)created. NOTE: AVWAP's anchor (calcParams[0]) is intentionally NOT stored
// here — it's per-instance (see avwapAnchor). extendData stores only config, never
// the bulky computed MTF series (recomputed on load by the MTF coordinator). Old
// configs were keyed by type-name; a migrated instance's id === its old name, so
// those entries are found unchanged.
export interface SavedIndicatorConfig {
  calcParams?: number[];
  visible?: boolean;
  // klinecharts persists indicator.styles.lines verbatim; entries carry the FULL
  // line style (style/dashedValue/smooth) so a restored line never crashes the
  // drawer. `style`/`dashedValue` is what the Style-tab line-style picker writes.
  styles?: { lines: Array<{ color?: string; size?: number; style?: string; dashedValue?: number[] }> };
  extendData?: Record<string, unknown>;
}

const indicatorCfgKey = (scope: string) => ns(scope, "indicatorConfig");

export function loadIndicatorConfigs(scope: string): Record<string, SavedIndicatorConfig> {
  return load<Record<string, SavedIndicatorConfig>>(indicatorCfgKey(scope), {});
}
// Full replace — the settings modal always supplies a complete snapshot. `id` is
// the instance id.
export function saveIndicatorConfig(scope: string, id: string, cfg: SavedIndicatorConfig): void {
  const all = loadIndicatorConfigs(scope);
  all[id] = cfg;
  save(indicatorCfgKey(scope), all);
}
// Patch only the `visible` flag, preserving the rest of the snapshot. Used by the
// legend / tooltip eye toggle, which (unlike the settings modal) doesn't have a
// full config to write.
export function saveIndicatorVisible(scope: string, id: string, visible: boolean): void {
  const all = loadIndicatorConfigs(scope);
  all[id] = { ...all[id], visible };
  save(indicatorCfgKey(scope), all);
}
// Drop a removed instance's config so it doesn't leak storage (instances are now
// unbounded; the old one-per-name model never needed cleanup).
export function deleteIndicatorConfig(scope: string, id: string): void {
  const all = loadIndicatorConfigs(scope);
  if (id in all) {
    delete all[id];
    save(indicatorCfgKey(scope), all);
  }
}

// --- price alerts (per epic) -------------------------------------------------

// TradingView-style alert conditions (price vs a level).
export type AlertCondition =
  | "crossing"
  | "crossing_up"
  | "crossing_down"
  | "greater"
  | "less";
export type AlertTrigger = "once" | "every";

// Human-readable condition labels (shared by the create modal and the on-line
// alert pill so they read identically).
export const CONDITION_LABELS: Record<AlertCondition, string> = {
  crossing: "Crossing",
  crossing_up: "Crossing Up",
  crossing_down: "Crossing Down",
  greater: "Greater Than",
  less: "Less Than",
};

// Per-alert notification channels (which surfaces fire when the alert triggers).
// Absent on alerts saved before this existed → normalizeAlert turns them all on.
export interface AlertNotifyChannels {
  toast: boolean;
  browser: boolean;
  sound: boolean;
}

export interface SavedAlert {
  // Stable identity, generated once at creation and shared by the on-chart
  // overlay, the background alertEngine, and storage. It is THE join key across
  // all three: the engine keys arming/crossing-baseline by id (not by value), so
  // editing a level mutates an existing alert instead of silently becoming a new
  // one. See frontend/docs/alert-identity-redesign.md.
  id: string;
  level: number;
  condition: AlertCondition;
  trigger: AlertTrigger;
  message: string;
  // Wall-clock expiry (ms, UTC). null/absent = open-ended (never expires). The
  // engine prunes alerts whose expiresAt has passed (client-side only — alerts
  // are only evaluated while a tab is open).
  expiresAt?: number | null;
  // Which channels fire on trigger. Absent → all on (legacy behavior).
  notify?: AlertNotifyChannels;
  // Wall-clock creation time (ms, UTC). Absent on legacy alerts (treated as 0).
  createdAt?: number;
}

const ALL_CHANNELS: AlertNotifyChannels = { toast: true, browser: true, sound: true };

// A fresh, globally-unique alert id. Used at CREATION (addAlert) — never derived
// from content, so a later level/condition edit keeps the same identity.
export function newAlertId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `al-${crypto.randomUUID()}`
    : `al-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Deterministic id for a LEGACY alert persisted before ids existed. Derived from
// content + its INDEX in the stored list so every reader (engine + overlay) that
// iterates the same loadAlerts() array backfills the SAME id for the same row —
// they agree until the next persist() writes the id out explicitly and locks it.
// The index is what disambiguates two field-identical legacy alerts (same level /
// condition / trigger / message / expiry): content alone collapsed them onto one
// id, so arming/edits/deletes aliased both. Deterministic backfill is safe ONLY
// because it is generate-once: after the first persist the `id` field is present
// and this is never consulted again (a content-derived id that re-derived on every
// read would change on edit and reintroduce the very bug this design fixes).
function legacyAlertId(a: Partial<SavedAlert> & { level: number }, index: number): string {
  const s = `${index}|${a.level}|${a.condition ?? "crossing"}|${a.trigger ?? "every"}|${a.message ?? ""}|${a.expiresAt ?? ""}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  return `lg-${(h >>> 0).toString(36)}`;
}

// Fill in defaults for alerts saved before these fields existed. `index` is the
// alert's position in the stored list (passed by every caller that maps over
// loadAlerts) — used only to mint a stable, unique id for legacy rows.
export function normalizeAlert(
  a: Partial<SavedAlert> & { level: number },
  index = 0,
): SavedAlert {
  return {
    id: a.id ?? legacyAlertId(a, index),
    level: a.level,
    condition: a.condition ?? "crossing",
    trigger: a.trigger ?? "every",
    message: a.message ?? "",
    expiresAt: a.expiresAt ?? null,
    notify: a.notify
      ? {
          toast: a.notify.toast ?? true,
          browser: a.notify.browser ?? true,
          sound: a.notify.sound ?? true,
        }
      : { ...ALL_CHANNELS },
    // Preserve existing createdAt; 0 for legacy alerts (sort them last).
    createdAt: a.createdAt ?? 0,
  };
}

const alertsKey = (scope: string, epic: string) => ns(scope, `alerts.${epic}`);

// All alert access is scope-explicit (the background alert engine spans every
// cell, and overlay managers each address their own scope).
export function loadAlerts(scope: string, epic: string): SavedAlert[] {
  return load<SavedAlert[]>(alertsKey(scope, epic), []);
}
export function saveAlerts(scope: string, epic: string, list: SavedAlert[]): void {
  save(alertsKey(scope, epic), list);
}

// Returns every {scope, epic, alerts} tuple found in localStorage across all cells.
// Scans keys matching: auto-trader.<scope>.alerts.<epic>
export function loadAllAlerts(): { scope: string; epic: string; alerts: SavedAlert[] }[] {
  const prefix = `${PREFIX}.`;
  const marker = `.alerts.`;
  const results: { scope: string; epic: string; alerts: SavedAlert[] }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    const inner = k.slice(prefix.length); // e.g. "tab.abc.alerts.US100"
    const idx = inner.indexOf(marker);
    if (idx === -1) continue;
    const scope = inner.slice(0, idx);
    const epic = inner.slice(idx + marker.length);
    if (!scope || !epic) continue;
    const alerts = load<SavedAlert[]>(k, []);
    if (alerts.length > 0) results.push({ scope, epic, alerts });
  }
  return results;
}

// --- triggered alert history (global chronological log) ----------------------

// One record per alert firing, across ALL symbols. History is a log (newest
// first), not per-epic state — so it lives under a single global key and is
// capped to keep localStorage bounded. `time` is the firing time (ms, UTC).
export interface TriggeredAlert {
  time: number;
  epic: string;
  condition: AlertCondition;
  level: number;
  price: number;
  message: string;
  // The epic's display precision captured at firing time. History is
  // cross-symbol, so a row must format with its OWN symbol's precision, not
  // the panel's currently-focused one. Optional: records saved before this
  // field existed fall back to the focused precision.
  precision?: number;
}

const TRIGGERED_KEY = `${PREFIX}.triggered`;
const TRIGGERED_CAP = 200; // keep the newest N firings

export function loadTriggered(): TriggeredAlert[] {
  return load<TriggeredAlert[]>(TRIGGERED_KEY, []);
}

// Prepend (newest first) and prune to the cap. Returns the new list so callers
// can update in-memory state without a re-read.
export function pushTriggered(entry: TriggeredAlert): TriggeredAlert[] {
  const list = [entry, ...loadTriggered()].slice(0, TRIGGERED_CAP);
  save(TRIGGERED_KEY, list);
  return list;
}

// "Last seen" marker (ms) for the History tab: the firing time up to which the
// user has already viewed. Entries with time > this are "new" (unseen). Set to the
// newest entry's time when the History tab is opened.
const TRIGGERED_SEEN_KEY = `${PREFIX}.triggeredSeen`;

export function loadTriggeredSeen(): number {
  return load<number>(TRIGGERED_SEEN_KEY, 0);
}
export function saveTriggeredSeen(time: number): void {
  save(TRIGGERED_SEEN_KEY, time);
}

export function clearTriggered(): void {
  save(TRIGGERED_KEY, []);
}

// --- AVWAP anchor timestamp (per epic, per instance, ms) ---------------------
// Per-instance now (was one anchor per epic) so multiple AVWAPs on one symbol each
// keep their own anchor. Legacy single-anchor entries (`avwap.<epic>`) are read as
// a fallback so a pre-multi-instance AVWAP (whose instance id === "AVWAP") keeps
// its placed anchor across the upgrade.
const avwapKey = (scope: string, epic: string, id: string) =>
  ns(scope, `avwap.${epic}.${id}`);
const legacyAvwapKey = (scope: string, epic: string) => ns(scope, `avwap.${epic}`);

export function loadAvwapAnchor(scope: string, epic: string, id: string): number {
  const v = load<number>(avwapKey(scope, epic, id), 0);
  if (v) return v;
  // Migration fallback: the old per-epic anchor, claimed by the bare "AVWAP" id.
  if (id === "AVWAP") return load<number>(legacyAvwapKey(scope, epic), 0);
  return 0;
}
export function saveAvwapAnchor(scope: string, epic: string, id: string, anchorMs: number): void {
  save(avwapKey(scope, epic, id), anchorMs);
}

// --- per-cell / per-tab layout lifecycle -------------------------------------

// Remove every namespaced key under a scope prefix so localStorage doesn't leak
// layout cruft. `${PREFIX}.${scope}.*` matches drawings/alerts/indicators/
// indicatorConfig/avwap — but NOT the tab list / active-tab keys. Used when a cell
// is closed (its own scope) or a whole tab is closed (the tab's primary scope,
// which prefix-matches all its nested cell scopes too).
export function purgeScope(scope: string): void {
  const prefix = `${PREFIX}.${scope}.`;
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) doomed.push(k);
  }
  doomed.forEach((k) => {
    localStorage.removeItem(k);
    mirrorDelete(k); // keep the backend in step when a cell/tab is closed
  });
}

// Closing a whole tab: purge its primary scope, which prefix-matches every nested
// cell scope (`tab.<id>.cell.<cellId>`) as well.
export function purgeTabScope(id: string): void {
  purgeScope(primaryCellScope(id));
}

// One-time migration to named layouts. Existing users have a bare `tabs` key (and
// maybe `activeTab`) but no `layouts` index. Wrap that workspace into a single
// named layout, make it the default, and adopt it as this device's active layout —
// so the upgrade is seamless (no blank screen, no lost work). New installs (no
// `tabs`) skip this and get the blank-until-named scratch behaviour. Idempotent:
// once a `layouts` index exists, this is a no-op. Returns true if it migrated
// (caller re-seeds React state). MUST run AFTER hydrateFromBackend so (a) the
// saveLayout/default writes mirror to the backend (mirrorEnabled is true by then)
// and (b) the layout id is derived from the BACKEND-synced `tabs` — so two devices
// converge on the same `layout-<id>` instead of each minting its own.
export function migrateToNamedLayouts(): boolean {
  if (loadLayouts().length > 0) return false; // already migrated
  let tabs = loadTabs();
  let activeTabId = loadActiveTab();
  // No `tabs` key, but a PRE-tabs (v0) install may have a single-chart workspace
  // under `auto-trader.symbol`/`.period` + un-namespaced indicators/drawings. Wrap
  // it into a first tab (deterministic id so devices converge) and pull the legacy
  // un-namespaced layout keys into that tab's primary scope (migrateLegacyLayout).
  if (!tabs || tabs.length === 0) {
    const v0 = loadLegacyV0Workspace();
    if (!v0) return false; // truly fresh install → stays on scratch (blank launch)
    migrateLegacyLayout(v0.id);
    tabs = [v0];
    activeTabId = v0.id;
  }
  const id = `layout-${tabs[0].id}`;
  saveLayout(id, "My Workspace", { tabs, activeTabId: activeTabId ?? tabs[0].id });
  saveDefaultLayoutId(id);
  saveActiveLayoutId(id);
  // Retire the bare keys so we don't double-source the workspace.
  removeKeyEverywhere(TABS_KEY);
  removeKeyEverywhere(ACTIVE_TAB_KEY);
  return true;
}

// Read a pre-tabs (v0) single-chart workspace from `auto-trader.symbol`/`.period`,
// returning a one-cell tab with a DETERMINISTIC id (so two upgrading devices that
// hydrate the same legacy keys produce the same layout). Returns null if there's no
// v0 symbol key (i.e. nothing to migrate). The un-namespaced indicators/drawings
// are moved into this tab's primary scope by the caller via migrateLegacyLayout.
function loadLegacyV0Workspace(): ChartTab | null {
  const symbol = load<Instrument | null>(`${PREFIX}.symbol`, null);
  if (!symbol) return null;
  const period = load<Period | null>(`${PREFIX}.period`, null);
  if (!period) return null;
  const id = "legacy-v0";
  const cellId = `${id}-c0`;
  // Retire the v0 chart keys (the layout keys are handled by migrateLegacyLayout).
  removeKeyEverywhere(`${PREFIX}.symbol`);
  removeKeyEverywhere(`${PREFIX}.period`);
  return {
    id,
    layout: "1",
    activeCellId: cellId,
    cells: [{ id: cellId, symbol, period, scope: primaryCellScope(id) }],
  };
}

// One-time migration: pre-tabs builds stored layout under un-namespaced keys
// (`${PREFIX}.drawings.${epic}`, `.indicators`, `.indicatorConfig`,
// `.alerts.${epic}`, `.avwap.${epic}`). Copy them into the given (first) tab's
// primary cell scope so existing users keep their work, then drop the originals.
// Idempotent (a missing source key is simply skipped); safe to call on startup.
export function migrateLegacyLayout(firstTabId: string): void {
  const dest = primaryCellScope(firstTabId); // `tab.<firstTabId>`
  const legacyExact = ["indicators", "indicatorConfig"];
  const legacyPrefixed = ["drawings.", "alerts.", "avwap."];
  const moved: Array<[string, string]> = []; // [from, to]

  // Exact (global) keys.
  for (const suffix of legacyExact) {
    const from = `${PREFIX}.${suffix}`;
    if (localStorage.getItem(from) != null)
      moved.push([from, `${PREFIX}.${dest}.${suffix}`]);
  }
  // Per-epic keys: scan for any `${PREFIX}.<prefix><epic>`.
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    for (const p of legacyPrefixed) {
      const head = `${PREFIX}.${p}`;
      // Exclude already-namespaced keys (`${PREFIX}.tab.…`).
      if (k.startsWith(head) && !k.startsWith(`${PREFIX}.tab.`)) {
        const rest = k.slice(`${PREFIX}.`.length); // e.g. "drawings.US100"
        moved.push([k, `${PREFIX}.${dest}.${rest}`]);
      }
    }
  }
  for (const [from, to] of moved) {
    const v = localStorage.getItem(from);
    if (v != null) {
      // Don't clobber an existing namespaced value (re-run safety).
      if (localStorage.getItem(to) == null) localStorage.setItem(to, v);
      localStorage.removeItem(from);
    }
  }
}
