// Keeps an indicator's alerts in step with the indicator: settings edits
// re-point them, removal asks whether to delete them. Alerts are matched by
// {scope, instanceId} because instance ids repeat across chart cells.
import { requestConfirm } from "./signals";
import { repointIndicatorAlert } from "./alertsApi";
import { alertInstanceOf } from "./indicatorAlertInstance";
import type { AlertInstance } from "./indicatorAlertInstance";
import {
  deleteIndicatorAlert, linkedAlerts, linkedLineAlerts, patchIndicatorAlert, patchLineAlert,
  scopeLinkedAlerts, scopeLinkedLineAlerts, type IndicatorAlert, type LineAlert,
} from "./alertsApi";

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

// Each linked alert is re-pointed at the pane's new settings; the server
// re-validates every one against its own timeframe and refuses the ones the
// new settings can't serve (an output that no longer exists, a volume line
// intrabar on a quote-only broker), and those get the delete-or-keep prompt.
// Line alerts are frozen: linkedAlerts returns indicator alerts only.
export async function syncAlertsAfterEdit(scope: string, instanceId: string, instance: AlertInstance): Promise<void> {
  const alerts = linkedAlerts(scope, instanceId);
  if (alerts.length === 0) return;
  const results = await Promise.all(alerts.map(async (a) => ({ a, r: await repointIndicatorAlert(a.id, instance) })));
  const conflicted = results.filter((x) => x.r === "refused").map((x) => x.a);
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

// AVWAP's anchor lives in calcParams[0], set directly via chart.overrideIndicator
// by the click/drag handlers (ChartCore.tsx, chart/useLineDrag.ts) once the user
// picks a new anchor bar. Both bypass IndicatorSettings.tsx's save path, the only
// other caller of syncAlertsAfterEdit above, so without this a linked alert keeps
// watching the OLD anchor forever: AVWAP's output set never changes on a
// re-anchor, so the pane never trips the "settings changed" prompt on its own.
export async function syncAvwapAlertsAfterReanchor(
  scope: string,
  instanceId: string,
  anchorMs: number,
  extendData: unknown,
): Promise<void> {
  await syncAlertsAfterEdit(scope, instanceId, alertInstanceOf("AVWAP", [anchorMs], extendData));
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
