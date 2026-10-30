// Create / edit an account alert: a metric on one dealing account with 1 to 3
// tiers (warn, danger, critical). The server evaluates it; this dialog shows
// the SERVER's current value, which is the figure the tiers are judged against.
import { useEffect, useMemo, useState } from "react";
import FloatingModal from "./components/FloatingModal";
import InfoTip from "./components/InfoTip";
import { ALL_ON, CHANNELS } from "./components/AlertCommonFields";
import {
  METRIC_LABELS, accountLabel, addAccountAlert, deleteAccountAlert, fetchAccountMetrics, findAccountAlert,
  fmtMetric, newAlertId, patchAccountAlert, type AccountAlert, type AccountMetric, type AccountMetricsResponse,
  type AccountTier, type AlertNotifyChannels, type TierLabel,
} from "./lib/alertsApi";
import { requestConfirm, type AccountAlertRequest } from "./lib/signals";

const TIER_LABELS: TierLabel[] = ["warn", "danger", "critical"];
// Metrics where a tier is hit by the value FALLING (levels step down).
const FALLING: ReadonlySet<AccountMetric> = new Set(["marginLevel", "equity", "available", "openPnl", "openPnlPct"]);
// Metrics whose levels are percentages: the added-tier step is a fixed 10 points.
const PCT: ReadonlySet<AccountMetric> = new Set(["marginLevel", "openPnlPct", "drawdown"]);

/** The tier "Add tier" appends: one step past the last tier, in the direction
 *  the metric fires, labelled with the next severity (capped at critical). */
function nextTier(metric: AccountMetric, tiers: AccountTier[]): AccountTier {
  const last = tiers.at(-1);
  if (!last) return { level: 0, label: "warn" };
  const step = PCT.has(metric) ? 10 : Math.max(Math.abs(last.level) * 0.1, 1);
  const level = Number((FALLING.has(metric) ? last.level - step : last.level + step).toFixed(2));
  const label = TIER_LABELS[Math.min(TIER_LABELS.indexOf(last.label) + 1, TIER_LABELS.length - 1)];
  return { level, label };
}

/** Default tiers: margin level gets Capital's three steps; drawdown one 5%
 *  step; anything else one tier 10% worse than the current value. */
function defaultTiers(metric: AccountMetric, current: number | null): AccountTier[] {
  if (metric === "marginLevel") return [{ level: 150, label: "warn" }, { level: 120, label: "danger" }, { level: 100, label: "critical" }];
  if (metric === "drawdown") return [{ level: 5, label: "warn" }];
  const base = current ?? 0;
  const worse = FALLING.has(metric) ? base - Math.abs(base) * 0.1 : base + Math.abs(base) * 0.1;
  return [{ level: Number(worse.toFixed(2)), label: "warn" }];
}

function orderError(metric: AccountMetric, tiers: AccountTier[]): string | null {
  const levels = tiers.map((t) => t.level);
  if (levels.some((l) => !Number.isFinite(l))) return "Every tier needs a number";
  for (let i = 1; i < levels.length; i++) {
    const ok = FALLING.has(metric) ? levels[i] < levels[i - 1] : levels[i] > levels[i - 1];
    if (!ok) return FALLING.has(metric) ? "Levels must fall from one tier to the next" : "Levels must rise from one tier to the next";
  }
  return null;
}

interface Props { request: AccountAlertRequest; now: number; onClose: () => void }

export default function AccountAlertModal({ request, onClose }: Props) {
  const existing = request.mode === "edit" ? findAccountAlert(request.id) : undefined;
  useEffect(() => { if (request.mode === "edit" && !existing) onClose(); }, [request, existing, onClose]);
  if (request.mode === "edit" && !existing) return null;
  const account = request.mode === "edit" ? existing!.account : request.account;
  const metric = request.mode === "edit" ? existing!.metric : request.metric;
  return <Body key={`${account}|${metric}|${existing?.id ?? "new"}`} account={account} metric={metric} existing={existing} onClose={onClose} />;
}

function Body({ account, metric, existing, onClose }: {
  account: string; metric: AccountMetric; existing?: AccountAlert; onClose: () => void;
}) {
  const isEdit = !!existing;
  const [live, setLive] = useState<AccountMetricsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const currency = (live?.metrics.currency as string | null | undefined) ?? null;
  const current = metric === "drawdown" ? (existing?.current ?? null) : ((live?.metrics[metric] as number | null | undefined) ?? null);
  const [tiers, setTiers] = useState<AccountTier[]>(existing?.tiers ?? []);
  const [baseline, setBaseline] = useState<"daily" | "sinceCreated">(existing?.baseline ?? "sinceCreated");
  const [message, setMessage] = useState(existing?.message ?? "");
  const [notify, setNotify] = useState<AlertNotifyChannels>(existing?.notify ?? ALL_ON);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchAccountMetrics(account).then((r) => {
      if (!alive) return;
      setLive(r);
      setLoaded(true);
      if (!isEdit) setTiers((t) => (t.length ? t : defaultTiers(metric, (r?.metrics[metric] as number | null | undefined) ?? null)));
    });
    return () => { alive = false; };
  }, [account, metric, isEdit]);

  const error = useMemo(() => (tiers.length ? orderError(metric, tiers) : "Add at least one tier"), [metric, tiers]);
  const setTier = (i: number, patch: Partial<AccountTier>) => setTiers((t) => t.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    if (error || busy) return;
    setBusy(true);
    const ok = isEdit
      ? await patchAccountAlert(existing!.id, { tiers, baseline: metric === "drawdown" ? baseline : undefined, message, notify })
      : await addAccountAlert({
          kind: "account", id: newAlertId(), account, metric, tiers, baseline: metric === "drawdown" ? baseline : undefined,
          message, expiresAt: null, notify, precision: 2, createdAt: Date.now(),
        });
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FloatingModal
      className="alert-modal"
      title={<span>{isEdit ? "Edit account alert" : "Account alert"} · <strong>{accountLabel(account)}</strong></span>}
      onClose={onClose}
      footer={
        <>
          {isEdit && (
            <button className="ghost" onClick={() => requestConfirm({
              message: `Delete this ${METRIC_LABELS[metric]} alert on ${accountLabel(account)}?`,
              onConfirm: () => { deleteAccountAlert(existing!.id); onClose(); },
            })}>Delete</button>
          )}
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="confirm-primary" onClick={() => void save()} disabled={!!error || busy}>
            {isEdit ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <div className="alert-body">
        <div className="al-field">
          <span>{METRIC_LABELS[metric]}</span>
          <span>
            {metric === "drawdown" && !isEdit
              ? "starts at 0% on the next check"
              : current == null
                ? (loaded ? "no value yet" : "loading")
                : `now ${fmtMetric(metric, current, currency)}`}
            <InfoTip title="Server value" text={["This is the figure the alert is judged on.", "It can differ a little from the dock when resting orders reserve margin."]} />
          </span>
        </div>
        {live && !live.monitored && (
          <div className="al-field">
            <span />
            <span className="al-note">Not monitored: {live.unmonitoredReason}</span>
          </div>
        )}
        {metric === "drawdown" && (
          <div className="al-field" role="radiogroup" aria-label="Peak">
            <span>Peak</span>
            <label><input type="radio" name="baseline" aria-label="Since midnight" checked={baseline === "daily"} onChange={() => setBaseline("daily")} /> Since midnight</label>
            <label><input type="radio" name="baseline" aria-label="Since created" checked={baseline === "sinceCreated"} onChange={() => setBaseline("sinceCreated")} /> Since created</label>
          </div>
        )}
        <div className="al-field">
          <span>Tiers</span>
          {tiers.map((t, i) => (
            <div key={i} className="al-tier">
              <input className="al-value" type="number" step="any" aria-label={`Tier ${i + 1} level`} value={Number.isFinite(t.level) ? t.level : ""}
                onChange={(e) => setTier(i, { level: e.target.value === "" ? NaN : Number(e.target.value) })} />
              <select className="al-operator" aria-label={`Tier ${i + 1} label`} value={t.label} onChange={(e) => setTier(i, { label: e.target.value as TierLabel })}>
                {TIER_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <button className="ghost" aria-label={`Remove tier ${i + 1}`} onClick={() => setTiers((x) => x.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          {tiers.length < 3 && (
            <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setTiers((x) => [...x, nextTier(metric, x)])}>Add tier</button>
          )}
          {error && <div className="al-error">{error}</div>}
        </div>
        <div className="al-field">
          <span>Message</span>
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional" />
        </div>
        <div className="al-field" role="group" aria-label="Notify">
          <span>Notify</span>
          <div className="al-tier">
            {CHANNELS.map(([key, label]) => (
              <label key={key}><input type="checkbox" checked={notify[key]} onChange={(e) => setNotify({ ...notify, [key]: e.target.checked })} /> {label}</label>
            ))}
          </div>
        </div>
      </div>
    </FloatingModal>
  );
}
