// Backend-backed alerts client: replaces localStorage persistence for price
// alerts + the triggered-alert history log. `persist/alerts.ts` is now a shim
// that re-exports this module, so the app's `from "./persist"` imports resolve
// here.
//
// The client keeps the FLAT SavedAlert shape used across the frontend today;
// this module maps it to/from the server's `{kind, params}` wire shape at the
// fetch boundary. Reads are synchronous off an in-memory cache populated by
// hydrateAlerts(); writes are optimistic (cache mutated immediately, network
// call fired after) so the UI never waits on a round trip to feel responsive.

import { API_BASE, apiFetch } from "./http";
import { getPersistBroker, registerAlertsRouter } from "./persist/core";
import { bumpAlerts } from "./signals";
import { toast } from "./notify";

// --- types (re-homed from persist/alerts.ts) ---------------------------------

export type AlertCondition =
  | "crossing"
  | "crossing_up"
  | "crossing_down"
  | "greater"
  | "less";
export type AlertTrigger = "once" | "every";

export const CONDITION_LABELS: Record<AlertCondition, string> = {
  crossing: "Crossing",
  crossing_up: "Crossing Up",
  crossing_down: "Crossing Down",
  greater: "Greater Than",
  less: "Less Than",
};

export interface AlertNotifyChannels {
  toast: boolean;
  browser: boolean;
  sound: boolean;
  push: boolean;
  telegram: boolean;
}

export interface SavedAlert {
  id: string;
  level: number;
  condition: AlertCondition;
  trigger: AlertTrigger;
  message: string;
  expiresAt?: number | null;
  notify?: AlertNotifyChannels;
  createdAt?: number;
  // Draw the chart line from `createdAt` rather than across the whole pane
  // (absent = on). Purely cosmetic — the backend's firing signature ignores it —
  // so an alert says nothing about the bars that predate it.
  startAtCreation?: boolean;
}

const ALL_CHANNELS: AlertNotifyChannels = {
  toast: true,
  browser: true,
  sound: true,
  push: true,
  telegram: true,
};

export function newAlertId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `al-${crypto.randomUUID()}`
    : `al-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Deterministic id for a LEGACY alert persisted before ids existed. Copied
// verbatim from persist/alerts.ts (see its comment) — content + list index so
// every reader backfills the same id for the same row.
function legacyAlertId(a: Partial<SavedAlert> & { level: number }, index: number): string {
  const s = `${index}|${a.level}|${a.condition ?? "crossing"}|${a.trigger ?? "every"}|${a.message ?? ""}|${a.expiresAt ?? ""}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  return `lg-${(h >>> 0).toString(36)}`;
}

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
          push: a.notify.push ?? true,
          telegram: a.notify.telegram ?? true,
        }
      : { ...ALL_CHANNELS },
    createdAt: a.createdAt ?? 0,
    startAtCreation: a.startAtCreation ?? true,
  };
}

// One record per alert firing, across all symbols (History tab, newest first).
export interface TriggeredAlert {
  time: number;
  epic: string;
  condition: AlertCondition;
  level: number;
  price: number;
  message: string;
  precision?: number;
  alertId?: string;
}

export interface FiredPayload {
  id: string;
  broker: string;
  epic: string;
  price: number;
  level: number;
  condition: AlertCondition;
  message: string;
  precision: number;
  notify: Partial<AlertNotifyChannels>;
  /** Server firing moment (ms epoch); absent on payloads from older backends. */
  time?: number;
}

// --- wire shape (server) ------------------------------------------------------

interface AlertRow {
  id: string;
  broker: string;
  epic: string;
  kind: string;
  params: {
    level: number;
    condition: AlertCondition;
    trigger: AlertTrigger;
    timeframe?: string;
    startAtCreation?: boolean;
  };
  message: string;
  expires_at: number | null;
  notify?: Partial<AlertNotifyChannels>;
  precision: number;
  active: number;
  created_at: number;
  updated_at: number;
}

interface TriggeredRow {
  time: number;
  alert_id?: string;
  broker?: string;
  epic: string;
  kind?: string;
  price: number;
  level: number;
  condition: AlertCondition;
  message: string;
  precision?: number;
}

function rowToSavedAlert(row: AlertRow): SavedAlert {
  return normalizeAlert({
    id: row.id,
    level: row.params.level,
    condition: row.params.condition,
    trigger: row.params.trigger,
    message: row.message,
    expiresAt: row.expires_at,
    notify: row.notify as AlertNotifyChannels | undefined,
    createdAt: row.created_at,
    startAtCreation: row.params.startAtCreation,
  });
}

function triggeredRowToClient(row: TriggeredRow): TriggeredAlert {
  return {
    time: row.time,
    epic: row.epic,
    condition: row.condition,
    level: row.level,
    price: row.price,
    message: row.message,
    precision: row.precision,
    alertId: row.alert_id,
  };
}

// --- module caches -------------------------------------------------------------

// Map<broker, Map<epic, SavedAlert[]>>
let alertsCache = new Map<string, Map<string, SavedAlert[]>>();
let triggeredCache: TriggeredAlert[] = [];
let triggeredSeenCache = 0;

// The broker/epic each cached alert lives under (id -> location), so a PATCH/
// DELETE/update-cache call keyed only by (epic, id) can find its row without a
// linear scan, and so applyAlertEvent's "fired" branch can attribute a firing.
function brokerMap(broker: string): Map<string, SavedAlert[]> {
  let m = alertsCache.get(broker);
  if (!m) {
    m = new Map();
    alertsCache.set(broker, m);
  }
  return m;
}

// --- a per-tab origin so this tab can be told apart from another tab/device's
// write in the /ws/state broadcast (mirrors persist/core's CLIENT_ID). --------
const CLIENT_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Math.floor(Math.random() * 1e9)}`;

function url(path: string, withOrigin = false): string {
  const sep = path.includes("?") ? "&" : "?";
  return withOrigin ? `${API_BASE}${path}${sep}origin=${CLIENT_ID}` : `${API_BASE}${path}`;
}

// --- hydrate -------------------------------------------------------------------

// Single-flight: concurrent callers share one in-flight GET round trip instead
// of firing duplicate requests (applyAlertEvent's "changed" handler calls this
// on every remote push, which can arrive in bursts).
let inFlightHydrate: Promise<void> | null = null;

// hydrateAlerts + the signal bump, as one call. The pairing is what every
// REMOTE-origin re-pull needs (a hydrate nothing rings leaves the chart lines and
// the sidebar on the stale set), and keeping it here means persist/core can
// trigger a re-sync without importing ./signals itself — that import edge is a
// module-init hazard (see the note on signals.ts's sweepTarget seed).
export function resyncAlerts(): Promise<void> {
  return hydrateAlerts().then(() => bumpAlerts());
}

export function hydrateAlerts(): Promise<void> {
  if (inFlightHydrate) return inFlightHydrate;
  inFlightHydrate = (async () => {
    try {
      const [alertsRes, triggeredRes] = await Promise.all([
        apiFetch(url("/api/alerts")),
        apiFetch(url("/api/alerts/triggered")),
      ]);
      if (alertsRes.ok) {
        const body = (await alertsRes.json()) as { alerts: AlertRow[] };
        const next = new Map<string, Map<string, SavedAlert[]>>();
        for (const row of body.alerts) {
          const epics = next.get(row.broker) ?? new Map<string, SavedAlert[]>();
          if (!next.has(row.broker)) next.set(row.broker, epics);
          const list = epics.get(row.epic) ?? [];
          list.push(rowToSavedAlert(row));
          epics.set(row.epic, list);
        }
        alertsCache = next;
      }
      if (triggeredRes.ok) {
        const body = (await triggeredRes.json()) as { entries: TriggeredRow[]; seen: number };
        triggeredCache = body.entries.map(triggeredRowToClient);
        triggeredSeenCache = body.seen;
      }
    } catch {
      // Offline / backend down: keep whatever the cache already holds, same
      // graceful-offline stance as persist/core's hydrateFromBackend.
    } finally {
      inFlightHydrate = null;
    }
  })();
  return inFlightHydrate;
}

// --- synchronous reads -----------------------------------------------------

export function loadAlerts(epic: string, broker: string = getPersistBroker()): SavedAlert[] {
  return brokerMap(broker).get(epic) ?? [];
}

export function loadAllAlerts(
  broker: string = getPersistBroker(),
): { epic: string; alerts: SavedAlert[] }[] {
  const results: { epic: string; alerts: SavedAlert[] }[] = [];
  for (const [epic, alerts] of brokerMap(broker)) {
    if (alerts.length > 0) results.push({ epic, alerts });
  }
  return results;
}

export function loadStoredAlert(
  epic: string,
  id: string,
  broker: string = getPersistBroker(),
): SavedAlert | null {
  return loadAlerts(epic, broker).find((a) => a.id === id) ?? null;
}

export function loadTriggered(): TriggeredAlert[] {
  return triggeredCache;
}

export function loadTriggeredSeen(): number {
  return triggeredSeenCache;
}

// --- optimistic writes -------------------------------------------------------

function setAlerts(epic: string, broker: string, list: SavedAlert[]): void {
  brokerMap(broker).set(epic, list);
}

export async function addStoredAlert(
  epic: string,
  alert: SavedAlert,
  broker: string = getPersistBroker(),
  precision = 2,
  timeframe?: string,
): Promise<void> {
  const prev = loadAlerts(epic, broker);
  if (prev.some((a) => a.id === alert.id)) return; // already present (idempotent)
  setAlerts(epic, broker, [...prev, alert]);
  bumpAlerts();

  const body = {
    id: alert.id,
    broker,
    epic,
    kind: "price_level",
    // `timeframe` (the chart resolution the alert was created on) rides in
    // params so the backend can render the Telegram snapshot on the same
    // timeframe the user was looking at. PATCHes never resend it — the server
    // merges params sub-keys, so it survives level drags/edits.
    params: {
      level: alert.level,
      condition: alert.condition,
      trigger: alert.trigger,
      startAtCreation: alert.startAtCreation ?? true,
      ...(timeframe ? { timeframe } : {}),
    },
    message: alert.message,
    expires_at: alert.expiresAt ?? null,
    notify: alert.notify,
    precision,
  };
  try {
    const res = await apiFetch(url("/api/alerts", true), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST /api/alerts failed: ${res.status}`);
  } catch {
    // Rollback: drop the optimistic row.
    setAlerts(epic, broker, loadAlerts(epic, broker).filter((a) => a.id !== alert.id));
    bumpAlerts();
    toast("Alert save failed");
  }
}

export interface AlertUpdateCfg {
  condition: AlertCondition;
  trigger: AlertTrigger;
  message: string;
  expiresAt: number | null;
  notify: AlertNotifyChannels;
  // REQUIRED, unlike SavedAlert's optional field: this is the patch body, where
  // omitting it would PATCH the server back to the default (true) and silently
  // re-extend a line the user shortened. Callers must state the intent.
  startAtCreation: boolean;
}

const DEBOUNCE_MS = 300;
const pendingPatch = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; body: Record<string, unknown> }
>();

export function updateStoredAlert(
  epic: string,
  id: string,
  level: number,
  cfg: AlertUpdateCfg,
  broker: string = getPersistBroker(),
): void {
  const raw = loadAlerts(epic, broker);
  let changed = false;
  const next = raw.map((a) => {
    if (a.id !== id) return a;
    changed = true;
    return { ...a, level, ...cfg };
  });
  if (!changed) return;
  setAlerts(epic, broker, next);
  bumpAlerts();

  const patchBody = {
    params: {
      level,
      condition: cfg.condition,
      trigger: cfg.trigger,
      startAtCreation: cfg.startAtCreation,
    },
    message: cfg.message,
    expires_at: cfg.expiresAt,
    notify: cfg.notify,
  };

  const existing = pendingPatch.get(id);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const pending = pendingPatch.get(id);
    pendingPatch.delete(id);
    if (!pending) return;
    void apiFetch(url(`/api/alerts/${encodeURIComponent(id)}`, true), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pending.body),
    }).catch(() => {
      /* best-effort — the cache already holds the edit; a later re-hydrate
         (or the next edit) will reconcile if this silently dropped */
    });
  }, DEBOUNCE_MS);
  pendingPatch.set(id, { timer, body: patchBody });
}

export function deleteStoredAlert(
  epic: string,
  id: string,
  broker: string = getPersistBroker(),
): void {
  const pending = pendingPatch.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    pendingPatch.delete(id);
  }
  const raw = loadAlerts(epic, broker);
  const survivors = raw.filter((a) => a.id !== id);
  if (survivors.length === raw.length) return;
  setAlerts(epic, broker, survivors);
  bumpAlerts();

  void apiFetch(url(`/api/alerts/${encodeURIComponent(id)}`, true), {
    method: "DELETE",
  }).catch(() => {
    /* best-effort, mirrors mirrorDelete's fire-and-forget contract */
  });
}

export function pushTriggeredSeen(time: number): void {
  triggeredSeenCache = time;
  bumpAlerts();
  void apiFetch(url("/api/alerts/triggered/seen"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ time }),
  }).catch(() => {
    /* best-effort */
  });
}

export function clearTriggered(): void {
  triggeredCache = [];
  bumpAlerts();
  void apiFetch(url("/api/alerts/triggered"), { method: "DELETE" }).catch(() => {
    /* best-effort */
  });
}

// --- live event application (from /ws/state pushes, another tab/device or
// the backend engine) --------------------------------------------------------

const EVENT_PREFIX = "__alerts__:";

let onFired: ((p: FiredPayload) => void) | null = null;

export function setOnAlertFired(cb: ((p: FiredPayload) => void) | null): void {
  onFired = cb;
}

interface ChangedValue {
  broker: string;
  epic: string;
  origin?: string;
}

const TRIGGERED_CAP = 200; // keep the newest N firings, mirrors persist/alerts.ts

export function applyAlertEvent(key: string, value: unknown): boolean {
  if (!key.startsWith(EVENT_PREFIX)) return false;
  const kind = key.slice(EVENT_PREFIX.length);

  if (kind === "changed") {
    const changed = value as ChangedValue;
    // Skip our own echo — this tab already applied the change optimistically
    // when it made the write; re-hydrating would just re-fetch what we have.
    if (changed?.origin !== CLIENT_ID) {
      void resyncAlerts();
    }
    return true;
  }

  if (kind === "fired") {
    const payload = value as FiredPayload;
    triggeredCache = [
      {
        // The server's stamp, so History matches the stored row and the
        // Telegram caption rather than this client's clock.
        time: typeof payload.time === "number" ? payload.time : Date.now(),
        epic: payload.epic,
        condition: payload.condition,
        level: payload.level,
        price: payload.price,
        message: payload.message,
        precision: payload.precision,
        alertId: payload.id,
      },
      ...triggeredCache,
    ].slice(0, TRIGGERED_CAP);
    onFired?.(payload);
    return true;
  }

  // Any other __alerts__: subkey is still an alerts-namespace event — the
  // caller uses this boolean to decide whether to fall through to the
  // generic /api/state localStorage path, which alerts events never belong on.
  return true;
}

// Hand persist/core the two entry points it needs for the /ws/state socket. Done
// HERE, not by an import over there, so `persist/core` stays a leaf of this
// module's dependency graph — see the registerAlertsRouter comment for why that
// direction is load-bearing (a cycle through ./signals TDZs core's PREFIX at
// boot). Runs on first import of this module, which the persist barrel does at
// app load, well before subscribeToBackendUpdates dials.
registerAlertsRouter(applyAlertEvent, () => void resyncAlerts());
