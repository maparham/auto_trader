// Price alerts + the triggered-alert history log.
//
// SHIM: the implementation moved to `lib/alertsApi.ts` — alerts now live in the
// BACKEND (SQLite, evaluated + fired server-side), not in localStorage. This
// module stays as a re-export so the ~dozen `from "./persist"` importers keep a
// stable path. Everything alert-shaped (types, CONDITION_LABELS, normalizeAlert,
// newAlertId, the load/add/update/delete/triggered functions, hydrateAlerts,
// applyAlertEvent, setOnAlertFired) comes from there.
//
// `parseAlertsStateKey` / `loadAlertsRaw` / `saveAlerts` / `pushTriggered` are
// GONE: whole-list localStorage saves are replaced by per-alert intents, the
// ws-reconcile job by `applyAlertEvent`, and triggered history is server-written.

export * from "../alertsApi";

import { PREFIX, save, removeKeyEverywhere } from "./core";

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
