// Keeps an indicator's alerts in step with the indicator: settings edits
// re-point them, removal asks whether to delete them. Alerts are matched by
// {scope, instanceId} because instance ids repeat across chart cells.
import { requestConfirm } from "./signals";
import { supportsStreaming } from "./trading";
import { volumeWeighted, type AlertableCheck, type IndicatorIdentity } from "./alertableIndicators";
import {
  deleteIndicatorAlert, linkedAlerts, linkedLineAlerts, patchIndicatorAlert, patchLineAlert,
  scopeLinkedAlerts, scopeLinkedLineAlerts, type IndicatorAlert, type LineAlert,
} from "./alertsApi";

const sameIdentity = (a: IndicatorIdentity, b: IndicatorIdentity) =>
  a.indicator === b.indicator &&
  JSON.stringify(a.calcParams) === JSON.stringify(b.calcParams) &&
  JSON.stringify(Object.entries(a.config).sort()) === JSON.stringify(Object.entries(b.config).sort());

// What an edit does to one timeframe's linked alerts: re-point the ones the
// new settings still allow, and hand back the ones the server would refuse,
// for the "delete or keep" prompt. A VWMA/EVWMA line needs live volume to be
// read as it happens, so an intrabar alert on a quote-only broker can't
// follow an edit onto one (alert_kinds.py refuses that PATCH).
export function planSync(
  alerts: IndicatorAlert[],
  check: AlertableCheck,
  streams: (broker: string) => boolean = supportsStreaming,
): { patch: Array<{ id: string; identity: IndicatorIdentity }>; conflicted: IndicatorAlert[] } {
  if (alerts.length === 0) return { patch: [], conflicted: [] };
  if (!check.ok) {
    // `hidden` means the CHART's current view can't show an alert entry
    // point right now (e.g. a seconds chart) - it says nothing about
    // whether the alert's own (native, already-validated) timeframe is
    // still alertable. Only a real reason (settings no longer alertable) is
    // a conflict.
    return { patch: [], conflicted: "hidden" in check ? [] : alerts };
  }
  const changed = alerts.filter((a) => !sameIdentity(a.params.identity, check.identity));
  const refused = (a: IndicatorAlert) =>
    volumeWeighted(check.identity) && a.params.evalOn === "intrabar" && !streams(a.broker);
  return {
    patch: changed.filter((a) => !refused(a)).map((a) => ({ id: a.id, identity: check.identity })),
    conflicted: changed.filter(refused),
  };
}

const plural = (n: number) => (n === 1 ? "1 alert" : `${n} alerts`);
const pronoun = (n: number) => (n === 1 ? "it" : "them");

function unlink(alerts: Array<IndicatorAlert | LineAlert>): void {
  for (const a of alerts) {
    if (a.kind === "line") void patchLineAlert(a.id, { params: { link: null } });
    else void patchIndicatorAlert(a.id, { params: { link: null } });
  }
}

// Re-point linked alerts' link.instanceId when an instance is renamed (the
// chart pane is torn down and recreated under the new id - see
// renameInstanceEverywhere). The scope never changes on a rename, only the
// id within it.
export function relinkAlerts(scope: string, oldId: string, newId: string): void {
  const alerts = linkedAlerts(scope, oldId);
  for (const a of alerts) void patchIndicatorAlert(a.id, { params: { link: { scope, instanceId: newId } } });
  for (const a of linkedLineAlerts(scope, oldId)) {
    void patchLineAlert(a.id, { params: { link: { scope, instanceId: newId, lineKey: a.params.link!.lineKey } } });
  }
}

// Line alerts are frozen: an edit never re-points or prompts them, which
// holds because linkedAlerts returns indicator alerts only.
export function syncAlertsAfterEdit(
  scope: string,
  instanceId: string,
  checkFor: (timeframe: string) => AlertableCheck,
): void {
  const alerts = linkedAlerts(scope, instanceId);
  if (alerts.length === 0) return;
  // Alerts on the SAME indicator instance can sit on different native
  // timeframes (one HOUR alert, one DAY alert); each is checked against ITS
  // OWN `params.timeframe`, never the chart's currently-displayed
  // resolution (F6) - the chart's view has nothing to do with whether an
  // individual alert's own timeframe is still valid.
  const byTimeframe = new Map<string, IndicatorAlert[]>();
  for (const a of alerts) {
    const group = byTimeframe.get(a.params.timeframe) ?? [];
    group.push(a);
    byTimeframe.set(a.params.timeframe, group);
  }
  const conflicted: IndicatorAlert[] = [];
  for (const [timeframe, group] of byTimeframe) {
    const plan = planSync(group, checkFor(timeframe));
    for (const p of plan.patch) void patchIndicatorAlert(p.id, { params: { identity: p.identity } });
    conflicted.push(...plan.conflicted);
  }
  if (conflicted.length === 0) return;
  requestConfirm({
    title: "Indicator alerts",
    message: `These settings can't be alerted on. Delete its ${plural(conflicted.length)}, or keep ${pronoun(conflicted.length)} on the old settings?`,
    confirmLabel: "Delete",
    cancelLabel: "Keep",
    onConfirm: () => conflicted.forEach((a) => deleteIndicatorAlert(a.id)),
    onCancel: () => unlink(conflicted),
  });
}

export function syncAlertsAfterRemove(scope: string, instanceId: string): void {
  // A Trendlines pane's line alerts go (or unlink) with it, like its own.
  const alerts = [...linkedAlerts(scope, instanceId), ...linkedLineAlerts(scope, instanceId)];
  if (alerts.length === 0) return;
  requestConfirm({
    title: "Indicator alerts",
    message: `Also delete its ${plural(alerts.length)}?`,
    confirmLabel: "Delete",
    cancelLabel: "Keep",
    onConfirm: () => alerts.forEach((a) => deleteIndicatorAlert(a.id)),
    onCancel: () => unlink(alerts),
  });
}

// Bulk and programmatic indicator-list changes (template replace, strategy
// overlays, undo/redo and layout sync) have no single "you removed this one"
// moment to ask about, so they unlink instead of asking: any alert in `scope`
// whose instance is not in `liveInstanceIds` keeps watching its own identity
// but stops following the cell. Without this the dangling link would be
// adopted by the next instance minted under the same bare name ("EMA").
export async function reconcileLinksForScope(scope: string, liveInstanceIds: Set<string>): Promise<void> {
  const live = (id: string) => liveInstanceIds.has(id);
  const stale = scopeLinkedAlerts(scope).filter((a) => !live(a.params.link!.instanceId));
  const staleLines = scopeLinkedLineAlerts(scope).filter((a) => !live(a.params.link!.instanceId));
  await Promise.all([
    ...stale.map((a) => patchIndicatorAlert(a.id, { params: { link: null } })),
    ...staleLines.map((a) => patchLineAlert(a.id, { params: { link: null } })),
  ]);
}
