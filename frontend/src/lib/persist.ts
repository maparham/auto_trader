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
import type { BacktestConfig } from "./backtestConfig";

const PREFIX = "auto-trader";

// --- per-broker workspace isolation ------------------------------------------
//
// Each DATA-BROKER (capital / ig-demo / ig-live) is its own isolated platform
// instance: its own tabs, named layouts, scratch, recent symbols, templates and
// alerts. We get that by prefixing every WORKSPACE-ROOT key with the broker id —
// `auto-trader.b.<broker>.<suffix>`. Switching brokers swaps the whole workspace.
//
// What is and isn't broker-scoped:
//  - ROOTS (this file's tabs/layouts/scratch/recent/template/alerts)  -> per broker
//  - SCOPED per-cell keys (drawings/indicators/avwap/indicatorConfig) -> NOT prefixed.
//    They're addressed by a globally-unique tab/cell `scope` that only ever lives
//    inside one broker's workspace, so they're isolated transitively — and a chart's
//    async unmount-save can't write them under the wrong broker (the key carries no
//    broker, so a mid-switch flip is irrelevant to them).
//  - GLOBAL PREFERENCES (settings, indicator defaults/presets, favourites) -> shared.
//
// `persistBroker` names the broker whose App-owned roots read/write.
// INVARIANT — SINGLE WRITER: it is assigned in EXACTLY TWO places — the eager init
// just below (module load) and App's broker-switch handler via setPersistBroker().
// The whole correctness argument rests on this; do NOT add a third writer. App-level
// roots are only ever mutated through App's controlled flow, which swaps the visible
// tabs and persistBroker TOGETHER in one handler — so the persistence namespace
// always tracks the CONTENT owner, never the transient UI selection mid-switch. The
// one root written from a remounting chart subtree is ALERTS, so those take an
// EXPLICIT `broker` argument instead of reading persistBroker (see alert helpers).
function brokerFromActiveAccount(): string {
  try {
    // App persists the active account as "{broker}:{env}" under this bare key.
    const acct = localStorage.getItem("activeAccount");
    if (acct) return acct.split(":")[0];
  } catch {
    /* test/node env without localStorage → default below */
  }
  return "capital"; // feed.ts DEFAULT_BROKER; literal to avoid an import cycle
}
// Lazily initialized (NOT at module eval time): App.tsx's one-time key migration
// (capital:live -> capital-live:live) also runs at its own module's top level, and
// import evaluation order can run this module's top-level code first — reading
// "activeAccount" here before the migration rewrites it would freeze persistBroker
// on the stale pre-migration broker id for the rest of the session. Deferring the
// read to first use guarantees the migration has already run by then.
let persistBroker: string | null = null;
function ensurePersistBroker(): string {
  if (persistBroker === null) persistBroker = brokerFromActiveAccount();
  return persistBroker;
}
export function setPersistBroker(broker: string): void {
  persistBroker = broker;
}
export function getPersistBroker(): string {
  return ensurePersistBroker();
}
// A workspace-root key for the ACTIVE broker. Dynamic (reads persistBroker on every
// call) so it always tracks the current broker — never freeze it into a const.
const root = (suffix: string) => `${PREFIX}.b.${ensurePersistBroker()}.${suffix}`;
// A workspace-root key for an EXPLICIT broker (used by the per-cell/engine alert
// paths, which must not depend on the ambient persistBroker — see invariant above).
const brokerRoot = (broker: string, suffix: string) =>
  `${PREFIX}.b.${broker}.${suffix}`;

// Named layouts are SHARED across the two Capital feeds (the demo `capital` host
// and the live `capital-live` host are one broker, Capital.com, with two data
// feeds): the saved-layout library is keyed by the broker FAMILY, not the per-feed
// id, so both feeds show the same list. Only the layout INDEX and BODIES use this;
// every other per-broker root (tabs, default/active layout, scratch, autosave,
// recents, templates, alerts) stays per-feed, so the live feed still opens blank.
//
// Scoped to Capital ON PURPOSE: Capital is the only broker that splits into two
// data feeds. IG's demo/live register as fully independent brokers (ig-demo /
// ig-live) and ALREADY hold their own saved layouts under their own per-feed keys;
// folding them into one "ig" family would orphan those existing keys. So every
// non-Capital broker keeps its own namespace (family == its own id).
// The single source of truth for "is this broker one of the two Capital feeds" —
// trading.ts's isCapital() re-exports this rather than re-listing the ids, so the
// two places that need to agree on Capital's membership (money-display logic in
// PositionsPanel and layout-family scoping here) can't drift out of sync.
// Exported from here (not trading.ts) because trading.ts already imports from this
// module (onTradesDirty), so the reverse import would be circular.
export function isCapitalBroker(brokerId: string): boolean {
  return brokerId === "capital" || brokerId === "capital-live";
}
const CAPITAL_FAMILY_MEMBERS = ["capital", "capital-live"];
const layoutFamily = () => {
  const broker = ensurePersistBroker();
  return isCapitalBroker(broker) ? "capital" : broker;
};
const familyRoot = (suffix: string) => `${PREFIX}.b.${layoutFamily()}.${suffix}`;
// Every per-feed broker id that shares the current broker's layout family — used to
// keep per-feed roots (like defaultLayoutId) in sync when a family-shared layout
// they point at is deleted from a sibling feed.
const familyMembers = () =>
  layoutFamily() === "capital" ? CAPITAL_FAMILY_MEMBERS : [ensurePersistBroker()];

// Per-broker roots that are intentionally DEVICE-LOCAL (written via saveLocal, never
// mirrored): which named layout this device shows, the unsaved scratch workspace,
// and the autosave toggle. hydrateFromBackend's prune/seed must skip them — the
// backend snapshot never carries them, so pruning would wipe this device's open
// layout. Suffix-matched because each broker has its own copy (the old exact-string
// Set couldn't span brokers).
const DEVICE_LOCAL_SUFFIXES = ["activeLayoutId", "scratch", "autosave"] as const;
function isDeviceLocalKey(k: string): boolean {
  return (
    k.startsWith(`${PREFIX}.b.`) &&
    DEVICE_LOCAL_SUFFIXES.some((s) => k.endsWith(`.${s}`))
  );
}

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

// Magnet mode (TV-style OHLC snap for drawings) is a GLOBAL preference — one
// setting for every chart cell — that rides the same mirror + cross-device sync as
// the rest of the workspace. lib/magnet.ts owns the shape and defaults; these thin
// wrappers just give it the mirrored load/save (magnet.ts must not reach into
// localStorage directly, or the setting would stop syncing).
const MAGNET_KEY = `${PREFIX}.magnet`;
export function loadMagnet<T>(fallback: T): T {
  return load<T>(MAGNET_KEY, fallback);
}
export function saveMagnet<T>(value: T): void {
  save(MAGNET_KEY, value);
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
    if (!k || !k.startsWith(own) || present.has(k) || isDeviceLocalKey(k)) continue;
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
    if (!k || !k.startsWith(own) || isDeviceLocalKey(k)) continue;
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

// Backend "trades changed" push (a paper trigger filled/closed). It rides the
// /ws/state channel under this key prefix but ISN'T workspace state — listeners
// (the trades layer) refetch positions/orders once instead of polling. Mirrors
// TRADES_DIRTY_PREFIX in the backend.
const TRADES_DIRTY_PREFIX = "__trades__:";
const _tradesDirty = new Set<(account: string) => void>();

/** Subscribe to backend trades-changed pushes; `cb` gets the affected account. */
export function onTradesDirty(cb: (account: string) => void): () => void {
  _tradesDirty.add(cb);
  return () => _tradesDirty.delete(cb);
}

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
      // Trades-changed push (not workspace state): fan out to the trades layer so it
      // refetches once, and stop — it has no value to mirror into localStorage.
      if (typeof msg.key === "string" && msg.key.startsWith(TRADES_DIRTY_PREFIX)) {
        const account = msg.key.slice(TRADES_DIRTY_PREFIX.length);
        for (const fn of _tradesDirty) fn(account);
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
  // Per-tab cell-size fractions (column widths / row heights, each summing to 1)
  // set by dragging the borders between cells. Absent = equal split. Reset when
  // the layout kind changes.
  sizes?: { cols: number[]; rows: number[] };
}

// Pre-cells persisted tab shape (one chart per tab). Kept only to migrate.
interface ChartTabV1 {
  id: string;
  symbol: Instrument;
  period: Period;
}

// Per-broker workspace roots (see root() — addresses the ACTIVE broker).
const tabsKey = () => root("tabs");

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
  const list = load<Array<ChartTab | ChartTabV1> | null>(tabsKey(), null);
  if (!Array.isArray(list) || list.length === 0) return null;
  return migrateTabs(list);
}
export function saveTabs(tabs: ChartTab[]): void {
  save(tabsKey(), tabs);
}

// --- merge tabs (inverse of cell detach) --------------------------------------

// Layout kind implied by a cell count — merging re-derives the shape and drops
// any custom sizes (the standard rule when the layout kind changes).
export const KIND_FOR_COUNT: Record<number, LayoutKind> = { 1: "1", 2: "2h", 3: "3", 4: "4" };

export function canMergeTabs(tabs: ChartTab[], sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return false;
  const src = tabs.find((t) => t.id === sourceId);
  const dst = tabs.find((t) => t.id === targetId);
  return !!src && !!dst && src.cells.length + dst.cells.length <= 4;
}

// Merge the whole source tab into the target: every source cell moves across
// and the source tab disappears from the returned array. Cells are RE-SCOPED
// under the target tab id (content copied via copyScopeContent, source prefix
// purged) — keeping the foreign scope would break the invariant closeTab /
// deleteLayout rely on (purging a tab's content by its own prefix reaches all
// of its cells). `position` places the incoming cells relative to the target's
// existing ones. Returns null when the merge is invalid or would exceed 4 cells.
export function mergeTabInto(
  tabs: ChartTab[],
  sourceId: string,
  targetId: string,
  position: "before" | "after" = "after",
): ChartTab[] | null {
  if (!canMergeTabs(tabs, sourceId, targetId)) return null;
  const src = tabs.find((t) => t.id === sourceId)!;
  const dst = tabs.find((t) => t.id === targetId)!;
  // A locked target mirrors every interaction across its cells on ONE shared
  // timeframe (toggleLock harmonizes periods when engaging). The lock carries
  // over to the merged tab via the spread below, so incoming cells must adopt
  // the target's timeframe or the merged tab would claim a lock its cells
  // visibly violate.
  const lockPeriod = dst.locked ? dst.cells[0]?.period : undefined;
  const moved: ChartCell[] = src.cells.map((c) => {
    const scope = cellScope(targetId, c.id);
    copyScopeContent(c.scope, scope);
    return lockPeriod ? { ...c, scope, period: lockPeriod } : { ...c, scope };
  });
  purgeTabScope(sourceId);
  const cells = position === "before" ? [...moved, ...dst.cells] : [...dst.cells, ...moved];
  const { sizes: _sizes, ...dstRest } = dst;
  const merged: ChartTab = {
    ...dstRest,
    cells,
    layout: KIND_FOR_COUNT[cells.length],
    // The merged-in chart is what the user just pulled over — focus it, and
    // link the cells (the point of viewing tabs together): interval, crosshair
    // and date range all sync. Symbol sync stays off — merged tabs usually
    // intentionally show different instruments.
    activeCellId: src.activeCellId,
    syncInterval: true,
    syncCrosshair: true,
    syncTime: true,
    syncSymbol: false,
  };
  return tabs.filter((t) => t.id !== sourceId).map((t) => (t.id === targetId ? merged : t));
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

// Per-broker named-layout roots. The MIRRORED ones (index/body/default) sync across
// devices; the DEVICE-LOCAL ones (activeLayoutId/scratch/autosave) don't (see
// isDeviceLocalKey + saveLocal). All address the ACTIVE broker via root().
// layoutsKey/layoutKey are namespaced by broker FAMILY (see layoutFamily above) so
// the saved-layout library is shared between e.g. capital and capital-live.
const layoutsKey = () => familyRoot("layouts");
const defaultLayoutKey = () => root("defaultLayoutId");
const activeLayoutKey = () => root("activeLayoutId"); // device-local
const scratchKey = () => root("scratch"); // device-local
const autosaveKey = () => root("autosave"); // device-local
const layoutKey = (id: string) => familyRoot(`layout.${id}`);

export interface LayoutMeta {
  id: string;
  name: string;
}
// The persisted body of one layout: the workspace it captures.
export interface Workspace {
  tabs: ChartTab[];
  // The active tab is intentionally NOT a synced concept — it's per-instance and
  // lives in React state (see App.tsx). The persisted value is only a seed for the
  // very first render after load; live selection is never written back. We keep the
  // field so older bodies (which DID carry a real id) still seed gracefully.
  activeTabId: string;
}

// Which tab should be active given the workspace `ws` and the instance's CURRENT
// in-memory selection `prevId`. The active tab is per-instance, so we KEEP the
// instance's own selection whenever that tab still exists in `ws` (this is what
// stops a sibling browser tab's selection from hijacking ours on a backend push).
// Only when `prevId` is gone (e.g. broker switch, layout switch, tab closed) do we
// fall back to the body's seed, then the first tab.
export function pickActiveTabId(prevId: string, ws: Workspace): string {
  if (prevId && ws.tabs.some((t) => t.id === prevId)) return prevId;
  if (ws.activeTabId && ws.tabs.some((t) => t.id === ws.activeTabId))
    return ws.activeTabId;
  return ws.tabs[0]?.id ?? "";
}

export function loadLayouts(): LayoutMeta[] {
  return load<LayoutMeta[]>(layoutsKey(), []);
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
  save(layoutsKey(), list);
}

export function renameLayout(id: string, name: string): void {
  const list = loadLayouts();
  const idx = list.findIndex((l) => l.id === id);
  if (idx < 0) return;
  list[idx] = { id, name };
  save(layoutsKey(), list);
}

// Delete a layout: drop its index entry, its body, every cell scope it owned, and
// clear the default if it pointed here. (activeLayoutId is healed by the caller.)
//
// The layout body/index are family-shared (layoutFamily), but defaultLayoutId is
// per-feed — so a shared layout can be someone's default under a SIBLING feed even
// though it's being deleted from the current one. Clear it there too, or that
// feed's default silently and permanently points at a layout that no longer exists.
export function deleteLayout(id: string): void {
  const ws = loadLayout(id);
  const list = loadLayouts().filter((l) => l.id !== id);
  save(layoutsKey(), list);
  removeKeyEverywhere(layoutKey(id));
  if (ws) for (const t of ws.tabs) purgeTabScope(t.id);
  for (const broker of familyMembers()) {
    const key = brokerRoot(broker, "defaultLayoutId");
    if (load<string | null>(key, null) === id) removeKeyEverywhere(key);
  }
}

export function loadDefaultLayoutId(): string | null {
  return load<string | null>(defaultLayoutKey(), null);
}
export function saveDefaultLayoutId(id: string | null): void {
  if (id == null) {
    removeKeyEverywhere(defaultLayoutKey());
  } else {
    save(defaultLayoutKey(), id);
  }
}

// Device-local: which layout this browser/tab currently shows. null = scratch.
export function loadActiveLayoutId(): string | null {
  return load<string | null>(activeLayoutKey(), null);
}
export function saveActiveLayoutId(id: string | null): void {
  if (id == null) removeLocal(activeLayoutKey());
  else saveLocal(activeLayoutKey(), id);
}

// Device-local: the unsaved workspace shown before the user names a layout.
export function loadScratch(): Workspace | null {
  const w = load<Workspace | null>(scratchKey(), null);
  if (!w || !Array.isArray(w.tabs)) return null;
  return { tabs: migrateTabs(w.tabs), activeTabId: w.activeTabId };
}
export function saveScratch(ws: Workspace): void {
  saveLocal(scratchKey(), ws);
}
export function clearScratch(): void {
  removeLocal(scratchKey());
}

// Device-local: whether autosave is enabled (default true, matching TV).
export function loadAutosave(): boolean {
  return load<boolean>(autosaveKey(), true);
}
export function saveAutosave(enabled: boolean): void {
  saveLocal(autosaveKey(), enabled);
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
      sizes: t.sizes,
    };
  });
  const srcActiveIdx = src.tabs.findIndex((t) => t.id === src.activeTabId);
  return {
    tabs,
    activeTabId: tabs[srcActiveIdx >= 0 ? srcActiveIdx : 0]?.id ?? "",
  };
}

// Copy every `${PREFIX}.<from>.*` key to `${PREFIX}.<to>.*` (mirrored to the
// backend). Used by cloneWorkspace and App.tsx's detach-cell. CAREFUL: a primary
// scope (`tab.<id>`) is a PREFIX of its nested cell scopes (`tab.<id>.cell.<cid>`),
// so a naive prefix scan would also drag every nested-cell key into the clone's
// primary scope (leaked junk under stale cell ids). Each cell is copied under its
// OWN scope by the caller, so here we EXCLUDE the nested `cell.` keys when copying
// a primary scope.
export function copyScopeContent(from: string, to: string): void {
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

// --- price-axis scale source (per cell) --------------------------------------
//
// TradingView-style "Scale price chart only": when true, the candle-pane price
// axis auto-fits to the candle OHLC only and overlay indicators no longer expand
// it (so adding an overlay never shrinks the candles). Default true.
const scalePriceOnlyKey = (scope: string) => ns(scope, "scalePriceOnly");

export function loadScalePriceOnly(scope: string): boolean {
  return load<boolean>(scalePriceOnlyKey(scope), true);
}
export function saveScalePriceOnly(scope: string, value: boolean): void {
  save(scalePriceOnlyKey(scope), value);
}

// --- legend collapsed (per cell) ----------------------------------------------
//
// TradingView-style legend chevron: when true, the candle-pane legend hides its
// indicator rows and shows only the symbol/OHLC row. Default false (expanded).
const legendCollapsedKey = (scope: string) => ns(scope, "legendCollapsed");

export function loadLegendCollapsed(scope: string): boolean {
  return load<boolean>(legendCollapsedKey(scope), false);
}
export function saveLegendCollapsed(scope: string, value: boolean): void {
  save(legendCollapsedKey(scope), value);
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

// --- drawing-tool preferences (left sidebar) ---------------------------------
//
// Starred drawing tools (GLOBAL preference, star order) — mirrors the
// indicator favorites idiom above. And the last-used tool per sidebar family
// (device-local), so each family button re-arms what you used last.
const FAVORITE_DRAWINGS_KEY = `${PREFIX}.drawingFavorites`;
export function loadFavoriteDrawings(): string[] {
  return load<string[]>(FAVORITE_DRAWINGS_KEY, []);
}
export function saveFavoriteDrawings(list: string[]): void {
  save(FAVORITE_DRAWINGS_KEY, list);
}

const LAST_DRAW_TOOLS_KEY = `${PREFIX}.lastDrawTools`;
export function loadLastDrawTools(): Record<string, string> {
  return load<Record<string, string>>(LAST_DRAW_TOOLS_KEY, {});
}
export function saveLastDrawTools(map: Record<string, string>): void {
  saveLocal(LAST_DRAW_TOOLS_KEY, map);
}

// --- recently opened symbols (PER BROKER, mirrored) --------------------------
//
// A personal MRU list: the epics of symbols the user recently opened from the
// symbol-search modal, most-recent-first, capped. Stores epics only (not Instrument
// snapshots) so the rendered name/status/type stay fresh off the catalogue, and
// resolves to nothing for an epic that left the catalogue. PER BROKER because epics
// are broker-specific (a Capital MRU is meaningless on IG) — keyed via root().
const recentSymbolsKey = () => root("recentSymbols");
const RECENT_SYMBOLS_MAX = 12;

export function loadRecentSymbols(): string[] {
  return load<string[]>(recentSymbolsKey(), []);
}
export function pushRecentSymbol(epic: string): void {
  const next = [epic, ...loadRecentSymbols().filter((e) => e !== epic)].slice(
    0,
    RECENT_SYMBOLS_MAX,
  );
  save(recentSymbolsKey(), next);
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

// --- backtest configs (global) ------------------------------------------------
//
// Same shape as the indicator-preset pair above: named presets (Save/load/Delete
// in the settings modal) plus a last-used snapshot that auto-restores next time
// the modal opens. GLOBAL (not per-symbol/per-cell) — a strategy you built is
// useful on any chart.
export type SavedBacktestConfig = BacktestConfig;

// v2: config shape changed from entry/exit to four groups (hedging). Old keys
// are abandoned rather than migrated — a stale long-only config would be missing
// the short groups, so callers fall back to defaultBacktestConfig().
const BACKTEST_PRESETS_KEY = `${PREFIX}.backtestPresets.v2`;
const BACKTEST_LAST_USED_KEY = `${PREFIX}.backtestLastUsed.v2`;

export function loadBacktestPresets(): Record<string, SavedBacktestConfig> {
  return load<Record<string, SavedBacktestConfig>>(BACKTEST_PRESETS_KEY, {});
}
export function saveBacktestPreset(name: string, cfg: SavedBacktestConfig): void {
  const all = loadBacktestPresets();
  all[name] = cfg;
  save(BACKTEST_PRESETS_KEY, all);
}
export function deleteBacktestPreset(name: string): void {
  const all = loadBacktestPresets();
  if (name in all) {
    delete all[name];
    save(BACKTEST_PRESETS_KEY, all);
  }
}

export function loadBacktestLastUsed(): SavedBacktestConfig | null {
  return load<SavedBacktestConfig | null>(BACKTEST_LAST_USED_KEY, null);
}
export function saveBacktestLastUsed(cfg: SavedBacktestConfig): void {
  save(BACKTEST_LAST_USED_KEY, cfg);
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
// PER-BROKER key (root()) so it's shared across cells/tabs of one broker and
// mirrored to the backend; epics are broker-specific, so templates don't cross
// brokers.
export interface SymbolTemplate {
  epic: string;
  indicators: IndicatorInstance[];
  indicatorConfigs: Record<string, SavedIndicatorConfig>;
  drawings: SavedOverlay[];
  avwapAnchors: Record<string, number>; // instance id -> anchor ms
  savedAt: number;
}

const templateKey = (epic: string) => root(`template.${epic}`);

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
// full config to write. Also patches extendData.userVisible to the same value —
// applyIndicatorIntervalVisibility (lib/indicators.ts) reads intent from THAT field
// on every period change, so leaving it stale here would make the eye toggle appear
// to self-revert on the next reload (the top-level `visible` patched above only
// seeds the initial creation flag, per applyIndicator's `cfg?.visible === false` check).
export function saveIndicatorVisible(scope: string, id: string, visible: boolean): void {
  const all = loadIndicatorConfigs(scope);
  const prev = all[id];
  all[id] = { ...prev, visible, extendData: { ...prev?.extendData, userVisible: visible } };
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

// Alerts are per instrument (epic) and PER BROKER, NOT per-cell/per-tab — unlike
// drawings/indicators/avwap, which stay scoped to their cell. Within a broker an
// alert belongs to the symbol: open US100 in any chart, on any tab, and the same
// alerts show. Key shape: `auto-trader.b.<broker>.alerts.<epic>`.
//
// Alerts are the ONE workspace root written from a remounting chart subtree
// (overlays.ts, per cell), so every alert helper takes the broker EXPLICITLY rather
// than reading the ambient persistBroker — a cell's async save during a broker
// switch must address the broker it belongs to, not whatever the selector just
// flipped to (see the persistBroker invariant). It DEFAULTS to getPersistBroker()
// for the non-racy callers (the alerts panel, tests) that act on the active broker.
const alertsKey = (epic: string, broker: string = getPersistBroker()) =>
  brokerRoot(broker, `alerts.${epic}`);

export function loadAlerts(epic: string, broker: string = getPersistBroker()): SavedAlert[] {
  return load<SavedAlert[]>(alertsKey(epic, broker), []);
}
// Raw stored JSON for an epic's alerts (null if unset). The hot-path alert engine
// uses this as a cheap per-tick cache key: a getItem + string compare avoids a
// JSON.parse + per-alert normalize allocation on every tick when nothing changed,
// and the raw string flips whenever ANYONE writes (engine, peer cell, /ws/state).
export function loadAlertsRaw(epic: string, broker: string = getPersistBroker()): string | null {
  try {
    return localStorage.getItem(alertsKey(epic, broker));
  } catch {
    return null;
  }
}
export function saveAlerts(epic: string, list: SavedAlert[], broker: string = getPersistBroker()): void {
  save(alertsKey(epic, broker), list);
}

// --- direct (overlay-less) edits of a stored alert, keyed by its stable id --------
// The alerts panel's all-symbols rows act on alerts whose chart may not be open, so
// they can't go through a cell's OverlayManager. These mutate the global per-epic
// list directly; callers bump alertsChanged so every open cell's reconcileAlerts and
// the background engine pick up the change. The id is the NORMALIZED id (legacy rows
// are matched by their deterministic backfilled id, same as the engine/sidebar see).

// Find a stored alert by its (normalized) stable id, or null.
export function loadStoredAlert(
  epic: string,
  id: string,
  broker: string = getPersistBroker(),
): SavedAlert | null {
  const raw = loadAlerts(epic, broker);
  for (let i = 0; i < raw.length; i++) {
    const n = normalizeAlert(raw[i], i);
    if (n.id === id) return n;
  }
  return null;
}

// Replace a stored alert's level + config in place, keeping its id/createdAt. No-op if
// the id isn't found. Other rows are left exactly as stored (not re-normalized) so an
// edit to one alert never rewrites a sibling's identity/defaults.
export function updateStoredAlert(
  epic: string,
  id: string,
  level: number,
  cfg: {
    condition: AlertCondition;
    trigger: AlertTrigger;
    message: string;
    expiresAt: number | null;
    notify: AlertNotifyChannels;
  },
  broker: string = getPersistBroker(),
): void {
  const raw = loadAlerts(epic, broker);
  let changed = false;
  const next = raw.map((r, i) => {
    const n = normalizeAlert(r, i);
    if (n.id !== id) return r;
    changed = true;
    return { ...n, level, ...cfg };
  });
  if (changed) saveAlerts(epic, next, broker);
}

// Remove a stored alert by its (normalized) stable id. No-op if absent.
export function deleteStoredAlert(
  epic: string,
  id: string,
  broker: string = getPersistBroker(),
): void {
  const raw = loadAlerts(epic, broker);
  const survivors = raw.filter((r, i) => normalizeAlert(r, i).id !== id);
  if (survivors.length !== raw.length) saveAlerts(epic, survivors, broker);
}

// Returns every {epic, alerts} tuple stored for `broker` (default: active). Scans
// keys matching that broker's per-epic form `auto-trader.b.<broker>.alerts.<epic>`,
// so the alerts panel lists only the active broker's alerts (each broker is its own
// isolated instance).
export function loadAllAlerts(
  broker: string = getPersistBroker(),
): { epic: string; alerts: SavedAlert[] }[] {
  const prefix = brokerRoot(broker, "alerts.");
  const results: { epic: string; alerts: SavedAlert[] }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    const epic = k.slice(prefix.length); // "US100"
    if (!epic) continue;
    const alerts = load<SavedAlert[]>(k, []);
    if (alerts.length > 0) results.push({ epic, alerts });
  }
  return results;
}


// One-time cleanup for the per-broker isolation rollout. The workspace USED to be
// GLOBAL (one shared set of tabs/layouts/scratch/recent/templates/alerts). It's now
// ISOLATED PER BROKER (`auto-trader.b.<broker>.*`), and the rollout is a FRESH START
// (no carry-over — each broker begins blank), so the old global ROOT keys are
// abandoned. Remove them ONCE so they don't linger as dead weight in localStorage and
// the backend. PRESERVED: global PREFERENCES (settings, indicator defaults/presets/
// favourites, triggered history) and every new `auto-trader.b.*` key. NOT pruned: the
// old per-cell `auto-trader.tab.*` scope content — a boot-time prune could race a
// freshly-mounted cell's mount-save of an identically-shaped key; the orphans are
// harmless (never referenced, new tabs mint new ids) and match today's tab-scope GC.
// Gated by a sentinel → runs exactly once; call AFTER hydrateFromBackend so the
// deletes reach the backend (else the next hydrate re-seeds them).
const PER_BROKER_SENTINEL = `${PREFIX}.perBrokerMigrated`;
export function pruneLegacyGlobalWorkspace(): boolean {
  try {
    if (localStorage.getItem(PER_BROKER_SENTINEL) != null) return false;
  } catch {
    return false; // no localStorage (test/node) → nothing to prune
  }
  const exact = new Set([
    `${PREFIX}.tabs`,
    `${PREFIX}.activeTab`,
    `${PREFIX}.layouts`,
    `${PREFIX}.defaultLayoutId`,
    `${PREFIX}.activeLayoutId`,
    `${PREFIX}.scratch`,
    `${PREFIX}.autosave`,
    `${PREFIX}.recentSymbols`,
  ]);
  // Old GLOBAL per-id / per-epic roots. (New forms live under `auto-trader.b.*`, which
  // none of these prefixes match — `auto-trader.layout.` ≠ `auto-trader.b.<broker>.layout.`.)
  const prefixes = [`${PREFIX}.layout.`, `${PREFIX}.template.`, `${PREFIX}.alerts.`];
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (exact.has(k) || prefixes.some((p) => k.startsWith(p))) doomed.push(k);
  }
  for (const k of doomed) removeKeyEverywhere(k);
  save(PER_BROKER_SENTINEL, true);
  return doomed.length > 0;
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
  // The stable SavedAlert id this firing came from, so the History row can jump
  // to (and select) the exact alert line even if it was dragged since firing.
  // Optional: rows saved before this field — and any whose alert was a "once"
  // that has since been removed — match by condition+level instead, or not at all.
  alertId?: string;
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

