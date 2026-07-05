// Price alerts (per epic, per broker) + the global triggered-alert history log.

import {
  PREFIX,
  brokerRoot,
  getPersistBroker,
  load,
  save,
  removeKeyEverywhere,
} from "./core";

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
