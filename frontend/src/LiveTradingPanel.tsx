import { useEffect, useState, type CSSProperties } from "react";
import CloseButton from "./CloseButton";
import { RuleGroupSection, RiskSection, EMPTY_RISK } from "./BacktestSettingsModal";
import { liveStateSignal, initLive, setDraft, setAccount, setQuantity, arm, disarm, resume } from "./lib/liveController";
import { goLiveRequest } from "./lib/signals";
import { journalSignal, journalMetrics, clearJournal, type JournalTrade } from "./lib/liveJournal";
import { cloneRule, type BacktestConfig, type RuleGroup, type Rule } from "./lib/backtestConfig";
import { applyRiskSync, riskPatch, riskSyncOn } from "./lib/riskSync";
import type { BrokerAccount } from "./lib/trading";
import type { LiveState } from "./lib/liveState";
import { StrategyParams } from "./components/StrategyParams";
import { fetchStrategies, type StrategyInfo } from "./api";
import {
  loadCodedCfg,
  saveCodedCfg,
  defaultCodedCfg,
  resolveParamValues,
  codedCfgsDiffer,
  type CodedStrategyConfig,
} from "./lib/codedConfig";

interface Props {
  epic: string;
  resolution: string;
  brokerId: string;
  accounts: BrokerAccount[];
  defaultAccount: string;
  onClose: () => void;
}

type Side = "long" | "short";

/** The Live trading panel — a dedicated surface (never the backtest) that arms a
 *  frozen snapshot of a rule strategy against a demo/live broker account. Reuses
 *  the backtest rule editor; drives the headless engine via liveController. */
export default function LiveTradingPanel({ epic, resolution, brokerId, accounts, defaultAccount, onClose }: Props) {
  const [state, setState] = useState<LiveState>(liveStateSignal.value);
  useEffect(() => liveStateSignal.subscribe(setState), []);
  const [journal, setJournal] = useState<JournalTrade[]>(journalSignal.value);
  useEffect(() => journalSignal.subscribe(setJournal), []);

  // Point the controller at this cell + a sensible default account on mount / when
  // the cell's epic changes. Prefer a demo account; fall back to the app default.
  // A pending "Go live →" seed (a copy of the backtest config) takes precedence.
  useEffect(() => {
    const demo = accounts.find((a) => a.env === "demo") ?? accounts.find((a) => !a.isRealMoney);
    const seed = goLiveRequest.value ?? undefined;
    initLive({ epic, resolution, brokerId, account: demo?.key ?? defaultAccount, seedDraft: seed });
    if (seed) goLiveRequest.set(null);
    // If this epic+account was left armed (reload), restore the snapshot and
    // restart the loop — the per-cycle reconcile adopts the open broker position.
    else void resume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epic, resolution, brokerId]);

  // A later "Go live →" (panel already open) re-seeds the draft.
  useEffect(
    () =>
      goLiveRequest.subscribe((cfg) => {
        if (cfg) {
          setDraft(cfg);
          goLiveRequest.set(null);
        }
      }),
    [],
  );

  const [side, setSide] = useState<Side>("long");
  const [clipboard, setClipboard] = useState<Rule | null>(null);
  const [groupClipboard, setGroupClipboard] = useState<Rule[] | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const cfg = state.draft;
  const armed = state.status === "armed";
  const lost = state.status === "lost-lease";
  const acct = accounts.find((a) => a.key === state.account);
  const realMoney = acct?.isRealMoney ?? state.account.endsWith(":live");
  const isLong = side === "long";

  // Coded strategies (mode === "coded"): the discovered file list, fetched here
  // so the panel can read the selected file's `params` schema for the
  // Parameters/Risk/Exit sections below the picker.
  const [strategyList, setStrategyList] = useState<StrategyInfo[]>([]);
  useEffect(() => {
    fetchStrategies().then(setStrategyList).catch(() => setStrategyList([]));
  }, []);
  const selectedStrategy = strategyList.find((s) => s.filename === cfg.codedStrategy);

  // The LIVE coded set (params + risk + exit groups) — deliberately SEPARATE
  // from the backtest set (codedConfig.ts): fiddling with a backtest knob must
  // never change what an armed live strategy does. Loaded from storage per
  // selected file; every edit writes straight through via updateCoded.
  const [liveCoded, setLiveCoded] = useState<CodedStrategyConfig>(() =>
    cfg.codedStrategy ? loadCodedCfg("live", cfg.codedStrategy) : defaultCodedCfg(),
  );
  useEffect(() => {
    setLiveCoded(cfg.codedStrategy ? loadCodedCfg("live", cfg.codedStrategy) : defaultCodedCfg());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.codedStrategy]);
  const updateCoded = (c: CodedStrategyConfig) => {
    setLiveCoded(c);
    if (cfg.codedStrategy) saveCodedCfg("live", cfg.codedStrategy, c);
  };
  const backtestCoded = cfg.codedStrategy ? loadCodedCfg("backtest", cfg.codedStrategy) : defaultCodedCfg();
  const differsFromBacktest = codedCfgsDiffer(liveCoded, backtestCoded);
  // Drift vs the FROZEN armed snapshot: the running engine still trades the
  // snapshot's coded config, so an edit here hasn't taken effect yet — same
  // "pending changes" idea as the rule-mode draft, just keyed off the separate
  // coded store instead of `state.draft`.
  const codedPendingEdits = armed && !!state.snapshot?.coded && codedCfgsDiffer(liveCoded, state.snapshot.coded);

  function patch(p: Partial<BacktestConfig>) {
    setDraft({ ...cfg, ...p });
  }
  function setGroup(key: "longEntry" | "longExit" | "shortEntry" | "shortExit", g: RuleGroup) {
    patch({ [key]: g });
  }

  const entry = isLong ? cfg.longEntry : cfg.shortEntry;
  const exit = isLong ? cfg.longExit : cfg.shortExit;
  const risk = (isLong ? cfg.longRisk : cfg.shortRisk) ?? EMPTY_RISK;

  const canArmRealMoney = !realMoney || confirmText.trim().toUpperCase() === "ARM";

  async function onArm() {
    setBusy(true);
    try {
      await arm();
      setConfirmText("");
    } finally {
      setBusy(false);
    }
  }

  const recentLog = state.log.slice(-8).reverse();

  return (
    <aside className="bt-cfg-panel live-panel">
      <div className="bt-cfg-head">
        <span className="bt-cfg-title">
          Live — <strong>{epic}</strong> <span className="bt-cfg-res">{resolution}</span>
          <span className={`live-env ${realMoney ? "live" : "demo"}`}>{realMoney ? "LIVE" : "DEMO"}</span>
        </span>
        <CloseButton onClick={onClose} />
      </div>

      <div className="bt-body live-body">
        {/* Account + size */}
        <div className="live-controls">
          <label className="bt-field">
            <span className="bt-field-label">Account</span>
            <select
              value={state.account}
              disabled={armed}
              onChange={(e) => setAccount(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.key} ({a.env})
                </option>
              ))}
              {!accounts.some((a) => a.key === state.account) && (
                <option value={state.account}>{state.account}</option>
              )}
            </select>
          </label>
          <label className="bt-field">
            <span className="bt-field-label">Size</span>
            <input
              type="number"
              min={0}
              step="any"
              value={state.quantity}
              disabled={armed}
              onChange={(e) => setQuantity(Number(e.target.value) || 0)}
            />
          </label>
        </div>

        {/* Pending-edits banner (armed + edited) */}
        {armed && (state.pendingEdits || codedPendingEdits) && (
          <div className="live-banner">
            <span>⚠ Pending changes — not trading yet. Applies to new entries; an open position finishes on its original rules.</span>
          </div>
        )}
        {lost && (
          <div className="live-banner live-banner-err">
            <span>Running in another tab — this tab won't place orders.</span>
          </div>
        )}

        {cfg.mode === "coded" ? (
          /* Coded strategy: the .py file owns entries/exits — the panel tunes
             its declared params + risk + exit rules, mirroring the backtest
             panel (Task 8) but against the SEPARATE live set. */
          <div className="live-strat-summary">
            <span className="strat-picker-name">{cfg.codedStrategy ?? "no strategy selected"}</span>
            <p className="strat-picker-desc">Coded strategy — entries are defined in the file.</p>
            {cfg.codedStrategy && (
              <>
                <div className="live-coded-head">
                  <button
                    type="button"
                    className="live-copy-backtest"
                    onClick={() => updateCoded(loadCodedCfg("backtest", cfg.codedStrategy!))}
                  >
                    Copy from backtest
                  </button>
                  {differsFromBacktest && <span className="al-note">differs from backtest</span>}
                </div>
                {codedPendingEdits && <div className="al-note">edits apply on next arm</div>}
                <StrategyParams
                  specs={selectedStrategy?.params ?? []}
                  values={resolveParamValues(selectedStrategy?.params ?? [], liveCoded.params)}
                  onChange={(params) => updateCoded({ ...liveCoded, params })}
                />
                {(["long", "short"] as const).map((s) => {
                  const codedIsLong = s === "long";
                  return (
                    <div key={s} style={{ "--side": codedIsLong ? "var(--pos)" : "var(--neg)" } as CSSProperties}>
                      <RuleGroupSection
                        title={codedIsLong ? "Sell to close" : "Buy to close"}
                        info={`Conditions that close an open ${s} position. A stop or target can close it first.`}
                        group={codedIsLong ? liveCoded.longExit : liveCoded.shortExit}
                        onChange={(g) => updateCoded({ ...liveCoded, [codedIsLong ? "longExit" : "shortExit"]: g })}
                        emptyHint={`No ${s}-exit rules — an open ${s} holds until the trading window ends.`}
                        defaultAvwapAnchor={Date.now()}
                        baseResolution={resolution}
                        clipboard={clipboard}
                        onCopy={(r) => setClipboard(cloneRule(r))}
                        groupClipboard={groupClipboard}
                        onCopyAll={(rs) => setGroupClipboard(rs.map(cloneRule))}
                        isExit
                      />
                      <RiskSection
                        risk={(codedIsLong ? liveCoded.longRisk : liveCoded.shortRisk) ?? EMPTY_RISK}
                        onChange={(r) => updateCoded({ ...liveCoded, ...riskPatch(riskSyncOn(liveCoded), s, r) })}
                        sync={{
                          on: riskSyncOn(liveCoded),
                          onToggle: () => updateCoded(applyRiskSync({ ...liveCoded, riskSynced: !riskSyncOn(liveCoded) }, s)),
                        }}
                      />
                    </div>
                  );
                })}
                <div className="al-note">
                  When set here, stop/target overrides any sl=/tp= the strategy file passes.
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            {/* Side toggle */}
            <div className="bt-side-tabs seg">
              <button className={`bt-side-long${isLong ? " seg-on" : ""}`} onClick={() => setSide("long")}>Long</button>
              <button className={`bt-side-short${!isLong ? " seg-on" : ""}`} onClick={() => setSide("short")}>Short</button>
            </div>

            <RuleGroupSection
              title={isLong ? "Buy to open" : "Sell to open"}
              info={`Conditions that open a ${side} position.`}
              group={entry}
              onChange={(g) => setGroup(isLong ? "longEntry" : "shortEntry", g)}
              emptyHint={`No ${side}-entry rules — this strategy won't open any ${side} positions.`}
              defaultAvwapAnchor={Date.now()}
              baseResolution={resolution}
              clipboard={clipboard}
              onCopy={(r) => setClipboard(cloneRule(r))}
              groupClipboard={groupClipboard}
              onCopyAll={(rs) => setGroupClipboard(rs.map(cloneRule))}
            />
            <RuleGroupSection
              title={isLong ? "Sell to close" : "Buy to close"}
              info={`Conditions that close an open ${side} position. The broker stop/target can close it first.`}
              group={exit}
              onChange={(g) => setGroup(isLong ? "longExit" : "shortExit", g)}
              emptyHint={`No ${side}-exit rules — an open ${side} holds until the stop/target hits.`}
              defaultAvwapAnchor={Date.now()}
              baseResolution={resolution}
              clipboard={clipboard}
              onCopy={(r) => setClipboard(cloneRule(r))}
              groupClipboard={groupClipboard}
              onCopyAll={(rs) => setGroupClipboard(rs.map(cloneRule))}
            />
            <RiskSection
              risk={risk}
              onChange={(r) => patch(riskPatch(riskSyncOn(cfg), side, r))}
              sync={{
                on: riskSyncOn(cfg),
                // Unlike the backtest modal there's no copy-on-load here — a
                // silent rewrite would surface phantom "pending edits" against
                // an armed strategy. Sync applies on edit and on toggle-on.
                onToggle: () => setDraft(applyRiskSync({ ...cfg, riskSynced: !riskSyncOn(cfg) }, side)),
              }}
            />
          </>
        )}

        {/* Status */}
        <div className="live-status">
          <div className="live-status-row">
            <span className={`live-dot ${armed ? "on" : ""}`} />
            <strong>{armed ? "Armed" : lost ? "Locked" : "Disarmed"}</strong>
            {state.lastEvalSec && (
              <span className="live-muted">last eval {new Date(state.lastEvalSec * 1000).toLocaleTimeString()}</span>
            )}
          </div>
          {recentLog.length > 0 && (
            <ul className="live-log">
              {recentLog.map((e, i) => (
                <li key={i}>
                  <span className="live-muted">{new Date(e.ts * 1000).toLocaleTimeString()}</span> {e.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Strategy journal — closed trades + the same metrics the backtest
            reports, so live is directly comparable to the backtested result. */}
        {(() => {
          const rows = journal.filter((t) => t.epic === epic);
          if (rows.length === 0) return null;
          const m = journalMetrics(rows);
          return (
            <div className="live-journal">
              <div className="live-journal-head">
                <span className="bt-field-label">Journal ({epic})</span>
                <button className="live-journal-clear" onClick={() => clearJournal()}>Clear</button>
              </div>
              <div className="live-metrics">
                <div className="live-mm"><b className={m.net >= 0 ? "pos" : "neg"}>{m.net >= 0 ? "+" : ""}{m.net.toFixed(2)}</b><span>net P&L</span></div>
                <div className="live-mm"><b>{m.count}</b><span>trades</span></div>
                <div className="live-mm"><b>{Math.round(m.winRate * 100)}%</b><span>win</span></div>
                <div className="live-mm"><b className="neg">{m.maxDD.toFixed(2)}</b><span>max DD</span></div>
              </div>
              <ul className="live-journal-list">
                {rows.slice(-8).reverse().map((t, i) => (
                  <li key={i}>
                    <span className="live-muted">{new Date(t.ts * 1000).toLocaleTimeString()}</span>
                    <span className={t.leg === "long" ? "pos" : "neg"}> {t.leg}</span>
                    <span> {t.entry}→{t.exit}</span>
                    <span className={t.pnl >= 0 ? "pos" : "neg"}> {t.pnl >= 0 ? "+" : ""}{t.pnl.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}
      </div>

      {/* Arm / Disarm footer */}
      <div className="live-foot">
        {realMoney && !armed && (
          <input
            className="live-confirm"
            placeholder="Type ARM to trade real money"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
          />
        )}
        {!armed ? (
          <button className="live-arm" disabled={busy || !canArmRealMoney} onClick={onArm}>
            {busy ? "Arming…" : "▶ Arm"}
          </button>
        ) : (
          <>
            {(state.pendingEdits || codedPendingEdits) && (
              <button className="live-rearm" disabled={busy} onClick={onArm}>
                Re-arm to apply
              </button>
            )}
            <button className="live-disarm" onClick={disarm}>◼ Disarm</button>
          </>
        )}
      </div>
    </aside>
  );
}
