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

import { API_BASE, apiFetch, apiFetchPatient } from "./http";
import { getPersistBroker, registerAlertsRouter } from "./persist/core";
import { bumpAlerts } from "./signals";
import { toast } from "./notify";
import { ALERTABLE, type IndicatorIdentity, indicatorAlertLabel } from "./alertableIndicators";
import { fmtPrice } from "./priceFormat";

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
  kind?: "price_level";
}

export type EvalOn = "close" | "intrabar";
export type AlertTarget = "price" | "value";

export const TRIGGER_LABELS: Record<AlertTrigger, string> = {
  once: "Once only",
  every: "Once per bar",
};

export interface IndicatorAlertParams {
  identity: IndicatorIdentity;
  line: "value";
  timeframe: string;
  target: AlertTarget;
  value: number | null;
  evalOn: EvalOn;
  // The chart cell + instance the alert follows. null once the user kept the
  // alert after removing (or un-alertably editing) its indicator.
  link: { scope: string; instanceId: string } | null;
}

export interface IndicatorAlert {
  kind: "indicator";
  id: string;
  epic: string;
  broker: string;
  condition: AlertCondition;
  trigger: AlertTrigger;
  message: string;
  expiresAt: number | null;
  notify: AlertNotifyChannels;
  createdAt?: number;
  precision: number;
  params: IndicatorAlertParams;
  status?: "ok" | "waiting_for_data";
}

export type AnyAlert = SavedAlert | IndicatorAlert;

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
  /** The broker the alert lives on; absent on rows from older backends. */
  broker?: string;
  label?: string;
  target?: AlertTarget;
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
  label?: string;
  target?: AlertTarget;
  evalOn?: EvalOn;
  trigger?: AlertTrigger;
}

// --- wire shape (server) ------------------------------------------------------

interface AlertRow {
  id: string;
  broker: string;
  epic: string;
  kind: string;
  params: Record<string, unknown>;
  message: string;
  expires_at: number | null;
  notify?: Partial<AlertNotifyChannels>;
  precision: number;
  active: number;
  created_at: number;
  updated_at: number;
  status?: "ok" | "waiting_for_data";
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
  alert?: { params?: Record<string, unknown> } | null;
}

function rowToSavedAlert(row: AlertRow): SavedAlert {
  const p = row.params as Record<string, unknown>;
  return normalizeAlert({
    id: row.id,
    level: p.level as number,
    condition: p.condition as AlertCondition,
    trigger: p.trigger as AlertTrigger,
    message: row.message,
    expiresAt: row.expires_at,
    notify: row.notify as AlertNotifyChannels | undefined,
    createdAt: row.created_at,
    startAtCreation: p.startAtCreation as boolean | undefined,
  });
}

function rowToIndicatorAlert(row: AlertRow): IndicatorAlert {
  const p = row.params as Record<string, unknown>;
  return {
    kind: "indicator",
    id: row.id,
    epic: row.epic,
    broker: row.broker,
    condition: p.condition as AlertCondition,
    trigger: p.trigger as AlertTrigger,
    message: row.message,
    expiresAt: row.expires_at,
    notify: { ...ALL_CHANNELS, ...(row.notify ?? {}) },
    createdAt: row.created_at,
    precision: row.precision,
    status: row.status,
    params: {
      identity: {
        indicator: p.indicator as IndicatorIdentity["indicator"],
        calcParams: p.calcParams as number[],
        config: p.config as Record<string, string>,
        priceTarget: ALERTABLE[p.indicator as IndicatorIdentity["indicator"]]?.priceTarget ?? false,
      },
      line: "value",
      timeframe: p.timeframe as string,
      target: p.target as AlertTarget,
      value: (p.value as number | null) ?? null,
      evalOn: p.evalOn as EvalOn,
      link: (p.link as IndicatorAlertParams["link"]) ?? null,
    },
  };
}

function indicatorWireParams(a: { condition: AlertCondition; trigger: AlertTrigger; params: IndicatorAlertParams }) {
  const { identity, ...rest } = a.params;
  return {
    indicator: identity.indicator,
    calcParams: identity.calcParams,
    config: identity.config,
    ...rest,
    condition: a.condition,
    trigger: a.trigger,
  };
}

function rowToIndicatorAlertLabel(p: Record<string, unknown>): string | undefined {
  try {
    return indicatorAlertLabel(
      { indicator: p.indicator, calcParams: p.calcParams, config: p.config, priceTarget: true } as IndicatorIdentity,
      p.timeframe as string,
    );
  } catch {
    return undefined;
  }
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
    broker: row.broker,
    label: row.alert?.params && row.kind === "indicator"
      ? rowToIndicatorAlertLabel(row.alert.params)
      : undefined,
    target: (row.alert?.params?.target as AlertTarget | undefined) ?? undefined,
  };
}

// --- module caches -------------------------------------------------------------

// Map<broker, Map<epic, SavedAlert[]>>
let alertsCache = new Map<string, Map<string, SavedAlert[]>>();
// Map<id, IndicatorAlert>
let indicatorCache = new Map<string, IndicatorAlert>();
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

// Optimistic indicator-alert writes in flight, and a counter bumped as each
// one settles. A hydrate that overlapped one may hold a snapshot from before
// the server applied it, and our own echo of that write is skipped (origin ===
// CLIENT_ID), so nothing else would correct it: such a snapshot is dropped for
// the indicator cache and re-pulled once no write is pending.
let indWritesInFlight = 0;
let indWriteGen = 0;
let resyncWhenSettled = false;

function indWriteStart(): void {
  indWritesInFlight++;
}

function indWriteSettled(): void {
  indWritesInFlight--;
  indWriteGen++;
  if (indWritesInFlight === 0 && resyncWhenSettled) {
    resyncWhenSettled = false;
    void resyncAlerts();
  }
}

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
    const gen = indWriteGen;
    let refetch = false;
    try {
      const [alertsRes, triggeredRes] = await Promise.all([
        apiFetchPatient(url("/api/alerts")),
        apiFetchPatient(url("/api/alerts/triggered")),
      ]);
      if (alertsRes.ok) {
        const body = (await alertsRes.json()) as { alerts: AlertRow[] };
        const next = new Map<string, Map<string, SavedAlert[]>>();
        const nextInd = new Map<string, IndicatorAlert>();
        for (const row of body.alerts) {
          if (row.kind === "indicator") {
            nextInd.set(row.id, rowToIndicatorAlert(row));
          } else {
            const epics = next.get(row.broker) ?? new Map<string, SavedAlert[]>();
            if (!next.has(row.broker)) next.set(row.broker, epics);
            const list = epics.get(row.epic) ?? [];
            list.push(rowToSavedAlert(row));
            epics.set(row.epic, list);
          }
        }
        alertsCache = next;
        if (indWritesInFlight > 0) resyncWhenSettled = true;
        else if (gen !== indWriteGen) refetch = true;
        else indicatorCache = nextInd;
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
    if (refetch) await resyncAlerts();
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

export function loadIndicatorAlerts(epic: string, broker: string = getPersistBroker()): IndicatorAlert[] {
  return [...indicatorCache.values()].filter((a) => a.epic === epic && a.broker === broker);
}

export function loadAllIndicatorAlerts(broker: string = getPersistBroker()): IndicatorAlert[] {
  return [...indicatorCache.values()].filter((a) => a.broker === broker);
}

export function linkedAlerts(scope: string, instanceId: string): IndicatorAlert[] {
  return [...indicatorCache.values()].filter(
    (a) => a.params.link?.scope === scope && a.params.link.instanceId === instanceId,
  );
}

// Every alert linked to any instance in `scope` on `broker`. Scope strings
// repeat across brokers (each broker has its own workspace), so the bulk
// reconcile that reads this must not touch another broker's links.
export function scopeLinkedAlerts(scope: string, broker: string = getPersistBroker()): IndicatorAlert[] {
  return [...indicatorCache.values()].filter((a) => a.broker === broker && a.params.link?.scope === scope);
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

async function sendJson(path: string, method: string, body: unknown): Promise<Response | null> {
  try {
    return await apiFetch(url(path, true), {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

async function reportFailure(res: Response | null, what: string): Promise<void> {
  let detail = "";
  try {
    detail = res ? ((await res.json()) as { detail?: string }).detail ?? "" : "";
  } catch { /* non-JSON error body */ }
  toast(detail ? `${what}: ${detail}` : what);
}

export async function addIndicatorAlert(a: IndicatorAlert): Promise<boolean> {
  if (indicatorCache.has(a.id)) return true; // idempotent
  indicatorCache.set(a.id, a);
  bumpAlerts();
  indWriteStart();
  const res = await sendJson("/api/alerts", "POST", {
    id: a.id, broker: a.broker, epic: a.epic, kind: "indicator",
    params: indicatorWireParams(a), message: a.message, expires_at: a.expiresAt,
    notify: a.notify, precision: a.precision,
  });
  indWriteSettled();
  if (res?.ok) return true;
  indicatorCache.delete(a.id);
  bumpAlerts();
  await reportFailure(res, "Alert save failed");
  return false;
}

export async function patchIndicatorAlert(
  id: string,
  patch: Partial<Pick<IndicatorAlert, "condition" | "trigger" | "message" | "expiresAt" | "notify">> & {
    params?: Partial<IndicatorAlertParams>;
  },
): Promise<boolean> {
  const prev = indicatorCache.get(id);
  if (!prev) return false;
  const next: IndicatorAlert = { ...prev, ...patch, params: { ...prev.params, ...(patch.params ?? {}) } };
  indicatorCache.set(id, next);
  bumpAlerts();
  indWriteStart();
  const res = await sendJson(`/api/alerts/${encodeURIComponent(id)}`, "PATCH", {
    params: indicatorWireParams(next),
    message: next.message,
    expires_at: next.expiresAt,
    notify: next.notify,
  });
  indWriteSettled();
  if (res?.ok) return true;
  // Only restore if still in cache (might be deleted concurrently)
  if (indicatorCache.has(id)) {
    indicatorCache.set(id, prev);
    bumpAlerts();
  }
  await reportFailure(res, "Alert update failed");
  return false;
}

export function deleteIndicatorAlert(id: string): void {
  if (!indicatorCache.delete(id)) return;
  bumpAlerts();
  indWriteStart();
  void apiFetch(url(`/api/alerts/${encodeURIComponent(id)}`, true), { method: "DELETE" })
    .catch(() => {})
    .finally(indWriteSettled);
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
        broker: payload.broker,
        label: payload.label,
        target: payload.target,
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

// Format an indicator value (RSI, ATR, etc.) with up to 6 significant digits,
// no trailing zeros. 0.0015 -> "0.0015", 70 -> "70", 71.2345678 -> "71.2346".
export function fmtIndicatorValue(v: number | null): string {
  if (v === null) return "";
  return Number(v.toPrecision(6)).toString();
}

// One phrase for "what this alert watches" (alertLabel, no concrete level)
// and "what fired/triggered" (firedDetail in useAlertFiredNotices.ts,
// triggeredLabel below): a value-target indicator alert reads
// "<indicator> <condition> <level>" (the indicator leads: the level is a
// plain number on its own scale, e.g. RSI vs 70), everything else reads
// "<condition> <indicator?> <level?>" (the condition leads: the level, when
// shown at all, is a point on the price line the user already sees on the
// chart). `levelText` is omitted entirely (filtered out, not an empty
// segment) when the caller has no concrete level to show (alertLabel for a
// price-target indicator alert names only the line, not a value).
export function conditionPhrase(
  label: string | undefined,
  condition: AlertCondition,
  target: AlertTarget | undefined,
  levelText: string,
): string {
  const cond = CONDITION_LABELS[condition];
  if (target === "value" && label) return `${label} ${cond} ${levelText}`;
  return [cond, label, levelText].filter(Boolean).join(" ");
}

// The one level format for every alert surface (panel, history, toast): a
// value target is a plain number on the indicator's own scale (6 significant
// digits, no padding), a price target is a point on the price axis and reads
// exactly like the axis (fmtPrice, thousands grouped).
export function levelText(target: AlertTarget, level: number, precision: number): string {
  return target === "value" ? fmtIndicatorValue(level) : fmtPrice(level, precision);
}

export function alertLabel(a: AnyAlert, precision: number): string {
  if (a.kind !== "indicator") {
    return conditionPhrase(undefined, a.condition, undefined, levelText("price", a.level, precision));
  }
  const what = indicatorAlertLabel(a.params.identity, a.params.timeframe);
  return a.params.target === "value"
    ? conditionPhrase(
        what,
        a.condition,
        "value",
        a.params.value == null ? "" : levelText("value", a.params.value, precision),
      )
    : conditionPhrase(what, a.condition, "price", "");
}

export function triggeredLabel(t: TriggeredAlert, hp: number): string {
  const level = levelText(t.target ?? "price", t.level, hp);
  return `${conditionPhrase(t.label, t.condition, t.target, level)} @ ${fmtPrice(t.price, hp)}`;
}
