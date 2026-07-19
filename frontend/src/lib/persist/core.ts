// Shared low-level persistence primitives: broker keying, the backend mirror,
// localStorage load/save, settings/magnet, startup hydration, live cross-tab
// updates, and per-cell scope helpers. Everything else in the persist/ folder
// builds on these.

import { API_BASE } from "../http";

export const PREFIX = "auto-trader";

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
  // App persists the active account as "{broker}:{env}": sessionStorage is THIS
  // browser tab's selection; the bare localStorage key is the last-used seed
  // shared by all tabs (see App.tsx's activeAccount state + persist effect).
  // Guarded PER LAYER: one storage throwing (e.g. partitioned iframe blocking
  // sessionStorage) must not skip the other's still-working fallback.
  let acct: string | null = null;
  try {
    acct = sessionStorage.getItem("activeAccount");
  } catch {
    /* sessionStorage unavailable → seed below */
  }
  if (acct == null) {
    try {
      acct = localStorage.getItem("activeAccount");
    } catch {
      /* test/node env without storage → default below */
    }
  }
  if (acct) return acct.split(":")[0];
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
export const root = (suffix: string) => `${PREFIX}.b.${ensurePersistBroker()}.${suffix}`;
// A workspace-root key for an EXPLICIT broker (used by the per-cell/engine alert
// paths, which must not depend on the ambient persistBroker — see invariant above).
export const brokerRoot = (broker: string, suffix: string) =>
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
export const familyRoot = (suffix: string) => `${PREFIX}.b.${layoutFamily()}.${suffix}`;
// Every per-feed broker id that shares the current broker's layout family — used to
// keep per-feed roots (like defaultLayoutId) in sync when a family-shared layout
// they point at is deleted from a sibling feed.
export const familyMembers = () =>
  layoutFamily() === "capital" ? CAPITAL_FAMILY_MEMBERS : [ensurePersistBroker()];

// Per-broker roots that are intentionally DEVICE-LOCAL (written via saveLocal, never
// mirrored): which named layout this device shows, the unsaved scratch workspace,
// and the autosave toggle. hydrateFromBackend's prune/seed must skip them — the
// backend snapshot never carries them, so pruning would wipe this device's open
// layout. Suffix-matched because each broker has its own copy (the old exact-string
// Set couldn't span brokers).
const DEVICE_LOCAL_SUFFIXES = ["activeLayoutId", "scratch", "autosave"] as const;
// Flat (non-per-broker) keys that are ALSO device-local: the backtest panel's UI
// prefs (open flag, long/short tab, settings/results split) and the last-used
// drawing tools. All are written via saveLocal and never mirrored, so the backend
// snapshot never carries them — without this the prune loop below would delete
// them a beat after each load, so the SECOND reload lost them (e.g. the backtest
// panel reopened once, then stayed closed). ANY new saveLocal-only flat key must
// be added here for the same reason.
const DEVICE_LOCAL_FLAT_KEYS = new Set([
  `${PREFIX}.backtestOpen`,
  `${PREFIX}.liveOpen`,
  `${PREFIX}.backtestSide`,
  `${PREFIX}.backtestMode`,
  `${PREFIX}.backtestSplit`,
  `${PREFIX}.backtestPanelWidth`,
  `${PREFIX}.backtestResultsSideBySide`,
  `${PREFIX}.backtestResultsColWidth`,
  `${PREFIX}.backtestPeriodsShown`,
  `${PREFIX}.backtestMarkersShown`,
  `${PREFIX}.backtestEquityShown`,
  `${PREFIX}.backtestAnalysisTab`,
  `${PREFIX}.backtestAnalysisCollapsed`,
  `${PREFIX}.sweepTarget`,
  `${PREFIX}.lastDrawTools`,
  `${PREFIX}.viewPos`,
  `${PREFIX}.holdout`,
  `${PREFIX}.alertUnseen`,
]);
function isDeviceLocalKey(k: string): boolean {
  return (
    DEVICE_LOCAL_FLAT_KEYS.has(k) ||
    (k.startsWith(`${PREFIX}.b.`) &&
      DEVICE_LOCAL_SUFFIXES.some((s) => k.endsWith(`.${s}`)))
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

export function mirrorDelete(key: string): void {
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
export const ns = (scope: string, suffix: string) => `${PREFIX}.${scope}.${suffix}`;

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// Returns true when the localStorage write committed, false when it was dropped
// (quota exceeded or a non-serializable value). A dropped write is non-fatal to
// the running session (the in-memory state still renders) but means the data
// won't survive a reload/switch — callers that care (e.g. large backtest results)
// check the return and surface it. Historically this swallowed the failure
// silently, which hid backtest-too-large data loss behind a later rehydrate.
export function save<T>(key: string, value: T): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
  } catch (err) {
    console.warn(
      `[persist] dropped write for "${key}" (${
        typeof value === "object" ? "quota/serialization" : "serialization"
      })`,
      err,
    );
    return false;
  }
  mirrorSet(key, serialized); // best-effort backend mirror (fire-and-forget)
  return true;
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
export function saveLocal<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / serialization issues are non-fatal */
  }
}
export function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
}

// --- per-browser-tab session values -------------------------------------------
//
// The "what am I looking at" selections (active account, active layout) are
// PER BROWSER TAB: sessionStorage is this tab's truth, and callers keep a
// localStorage copy as the last-used seed for future tabs (same pattern as
// App.tsx's ACTIVE_TAB_SESSION_KEY). Raw-string API — callers JSON-encode.
// Guarded like the localStorage helpers so the module stays usable in node.
export function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
export function sessionSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* non-fatal */
  }
}
export function sessionRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
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
    if (!k || !k.startsWith(own) || isDeviceLocalKey(k) || isLegacyTabsKey(k)) continue;
    const v = localStorage.getItem(k);
    if (v != null) mirrorSet(k, v);
  }
}

// The RETIRED per-broker working-set root (`auto-trader.b.<broker>.tabs`) — the
// working tab set lives in the named layout body / scratch now. workspace.ts's
// pruneLegacyTabsKeys deletes these on every boot; seedBackendFromLocal above
// must skip them too, or its fire-and-forget PUT can race the prune's DELETE on
// an empty-backend first run and resurrect the key in the backend. Broker ids
// never contain dots, so requiring no further dot after the broker segment
// spares a layout body that happens to be named "tabs" (`...layout.tabs`).
export function isLegacyTabsKey(k: string): boolean {
  return /^auto-trader\.b\.[^.]+\.tabs$/.test(k);
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

export function subscribeToBackendUpdates(
  onChange: (key: string) => void,
): () => void {
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
      // Forward the changed KEY so the handler can tell a per-cell CONTENT change
      // (drawings/indicators/alerts on a cell we're showing) from a layout/tabs
      // change. The old no-arg callback forced App to guess via a tabs-array compare,
      // which silently missed content changes to a mounted cell — another tab's edit
      // updated our localStorage but not our on-chart overlays, so our next persist()
      // stomped it back (cross-tab data loss). See App.onBackendPush.
      onChange(msg.key);
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

// --- per-cell / per-tab scope helpers ----------------------------------------

// The migrated cell reuses the tab's own prefix so its keys are byte-identical to
// the pre-cells layout — existing drawings/alerts/indicators survive the upgrade.
export const primaryCellScope = (tabId: string) => `tab.${tabId}`;
export const cellScope = (tabId: string, cellId: string) =>
  `tab.${tabId}.cell.${cellId}`;

// Remove a mirrored key from this device AND tell the backend/other tabs to drop
// it. (save() always mirrors; there was no symmetric remove-and-mirror helper.)
export function removeKeyEverywhere(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  mirrorDelete(key);
}

// Copy every `${PREFIX}.<from>.*` key to `${PREFIX}.<to>.*` (mirrored to the
// backend). Used by cloneWorkspace and App.tsx's detach-cell. CAREFUL: a primary
// scope (`tab.<id>`) is a PREFIX of its nested cell scopes (`tab.<id>.cell.<cid>`),
// so a naive prefix scan would also drag every nested-cell key into the clone's
// primary scope (leaked junk under stale cell ids). Each cell is copied under its
// OWN scope by the caller, so here we EXCLUDE the nested `cell.` keys when copying
// a primary scope.
// Returns false when any write failed (storage quota) — callers that DELETE
// the source afterwards (merge) must check it, or a silently-lost copy turns
// into permanent data loss.
export function copyScopeContent(from: string, to: string): boolean {
  const head = `${PREFIX}.${from}.`;
  const nested = `${head}cell.`; // only meaningful when `from` is a primary scope
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(head) && !k.startsWith(nested))
      pairs.push([k, `${PREFIX}.${to}.${k.slice(head.length)}`]);
  }
  let ok = true;
  for (const [src, dst] of pairs) {
    const v = localStorage.getItem(src);
    if (v == null) continue;
    try {
      localStorage.setItem(dst, v);
      mirrorSet(dst, v);
    } catch {
      ok = false; // quota — non-fatal for the copy itself
    }
  }
  return ok;
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
