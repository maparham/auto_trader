// The Strategy tab: the User Defined / Built-in switch, then either the
// coded strategy's picker, params and per-side exits/risk, or the rule
// builder for the long or short side.
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import type { ParamSpec, StrategyInfo } from "../api";
import { StrategyParams } from "../components/StrategyParams";
import StrategyPicker from "../StrategyPicker";
import type { BacktestConfig, Rule, RuleGroup } from "../lib/backtestConfig";
import { resolveParamValues, type CodedStrategyConfig } from "../lib/codedConfig";
import type { ExprInstance } from "../lib/expr/catalog";
import { applyRiskSync, riskPatch, riskSyncOn } from "../lib/riskSync";
import type { RangeAxis, SweepAxis } from "../lib/sweep";
import { loadSweepAxes, pruneSweepAxes, sweepContext } from "../lib/sweepMemory";
import { RiskSection } from "./RiskScalingSections";
import { RuleGroupSection } from "./RuleBuilder";
import { EMPTY_RISK } from "./shared";
import { SidePanel } from "./SidePanel";
import type { useExprPick } from "./useExprPick";

type AxisPatch = Partial<Pick<RangeAxis, "from" | "to" | "step">>;

export function StrategySection({
  cfg,
  setCfg,
  side,
  selectSide,
  sideEnabled,
  codedCfg,
  updateCoded,
  strategyList,
  strategyListError,
  reloadStrategies,
  selectedStrategy,
  paramError,
  setSweepAxes,
  displayAxes,
  sweepEditable,
  toggleSweepAxis,
  toggleRiskSweepAxis,
  toggleRangeSweepAxis,
  patchAxis,
  setGroup,
  defaultAvwapAnchor,
  effectiveRes,
  copyRules,
  pasteRules,
  exprPick,
  exprInstances,
}: {
  cfg: BacktestConfig;
  setCfg: (c: BacktestConfig) => void;
  side: "long" | "short";
  selectSide: (s: "long" | "short") => void;
  sideEnabled: boolean;
  codedCfg: CodedStrategyConfig;
  updateCoded: (c: CodedStrategyConfig) => void;
  strategyList: StrategyInfo[];
  strategyListError: string | null;
  reloadStrategies: () => void;
  selectedStrategy: StrategyInfo | undefined;
  paramError: string | null;
  setSweepAxes: Dispatch<SetStateAction<SweepAxis[]>>;
  displayAxes: SweepAxis[];
  sweepEditable: boolean;
  toggleSweepAxis: (target: string, spec: ParamSpec) => void;
  toggleRiskSweepAxis: (target: string, current: number) => void;
  toggleRangeSweepAxis: (target: string, current: number) => void;
  patchAxis: (target: string, patch: AxisPatch) => void;
  setGroup: (which: "longEntry" | "longExit" | "shortEntry" | "shortExit", group: RuleGroup) => void;
  defaultAvwapAnchor: number;
  effectiveRes: string;
  copyRules: (rules: Rule[]) => void;
  pasteRules: () => Promise<Rule[] | null>;
  exprPick: ReturnType<typeof useExprPick>;
  exprInstances: readonly ExprInstance[];
}) {
  return (
    <>
          {/* The whole side view takes on the side's identity colour — long =
              the chart's up/green, short = down/red — via one --side variable.
              Parking greys it out (data-parked). */}
          <div
            className="bt-strategy"
            style={{ "--side": side === "long" ? "var(--pos)" : "var(--neg)" } as CSSProperties}
            data-parked={(side === "long" ? cfg.longEnabled : cfg.shortEnabled) === false}
          >
      <div className="bt-subtabs" role="tablist" aria-label="Strategy mode">
        <button
          className={(cfg.mode ?? "rules") === "rules" ? "on" : ""}
          onClick={() => {
            // Sweep axes are mode-scoped (`param:`/`risk:` in coded, `rule:`
            // in rules) and persisted per context, so each mode switch swaps
            // to the target mode's own persisted set (restored on switch-back).
            // This keeps the other mode's axes out of applySweepCombo, which
            // would silently ignore them or send the backend a rejected combo.
            setSweepAxes(pruneSweepAxes(loadSweepAxes(sweepContext("rules", null)), cfg));
            setCfg({ ...cfg, mode: "rules" });
          }}
        >
          User Defined
        </button>
        <button
          className={cfg.mode === "coded" ? "on" : ""}
          onClick={() => {
            setSweepAxes(pruneSweepAxes(loadSweepAxes(sweepContext("coded", cfg.codedStrategy)), codedCfg));
            setCfg({ ...cfg, mode: "coded" });
          }}
        >
          Built-in
        </button>
      </div>
      {cfg.mode === "coded" ? (
        <>
          <StrategyPicker
            value={cfg.codedStrategy}
            onChange={(filename) => setCfg({ ...cfg, codedStrategy: filename })}
            list={strategyList}
            loadError={strategyListError}
            onReload={reloadStrategies}
          />
          <StrategyParams
            specs={selectedStrategy?.params ?? []}
            values={resolveParamValues(selectedStrategy?.params ?? [], codedCfg.params)}
            onChange={(params) => updateCoded({ ...codedCfg, params })}
            sweep={{ axes: displayAxes, onToggle: toggleSweepAxis, onAxisChange: patchAxis }}
          />
          {paramError && <div className="al-note bt-param-error">{paramError}</div>}
          {(["long", "short"] as const).map((s) => {
            const isLong = s === "long";
            return (
              <div key={s} style={{ "--side": isLong ? "var(--pos)" : "var(--neg)" } as CSSProperties}>
                <RuleGroupSection
                  title={isLong ? "Sell to close" : "Buy to close"}
                  info={`Conditions that close an open ${s} position. A stop or target can close it first.`}
                  group={isLong ? codedCfg.longExit : codedCfg.shortExit}
                  onChange={(g) => updateCoded({ ...codedCfg, [isLong ? "longExit" : "shortExit"]: g })}
                  emptyHint={`No ${s}-exit rules, so an open ${s} holds until the trading window ends.`}
                  defaultAvwapAnchor={defaultAvwapAnchor}
                  baseResolution={effectiveRes}
                  onCopy={copyRules}
                  onPaste={pasteRules}
                  instances={exprInstances}
                  isExit
                />
                <RiskSection
                  risk={(isLong ? codedCfg.longRisk : codedCfg.shortRisk) ?? EMPTY_RISK}
                  onChange={(r) => updateCoded({ ...codedCfg, ...riskPatch(riskSyncOn(codedCfg), s, r) })}
                  sweep={{
                    axes: displayAxes,
                    side: s,
                    onToggle: toggleRiskSweepAxis,
                    // Synced: the axis lives on the long side regardless of
                    // which block's kind dropdown changed — drop both sides'.
                    onKindChange: (field) => {
                      const sides = riskSyncOn(codedCfg) ? (["long", "short"] as const) : ([s] as const);
                      setSweepAxes((axes) =>
                        axes.filter((a) => !sides.some((sd) => a.target.startsWith(`risk:${sd}.${field}.`))));
                    },
                    onAxisChange: patchAxis,
                  }}
                  sync={{
                    on: riskSyncOn(codedCfg),
                    onToggle: () => {
                      const on = !riskSyncOn(codedCfg);
                      updateCoded(applyRiskSync({ ...codedCfg, riskSynced: on }, s));
                      // Axes created per-side while unsynced move to the
                      // canonical long side (deduped) so they keep sweeping
                      // — and now mirror — after the switch.
                      if (on) setSweepAxes((axes) => {
                        const remapped = axes.map((a) =>
                          a.target.startsWith("risk:short.")
                            ? { ...a, target: a.target.replace(/^risk:short\./, "risk:long.") }
                            : a);
                        return remapped.filter((a, i) => remapped.findIndex((b) => b.target === a.target) === i);
                      });
                    },
                  }}
                />
              </div>
            );
          })}
          <div className="al-note">
            When set here, stop/target overrides any sl=/tp= the strategy file passes.
          </div>
        </>
      ) : (
        <>
      <div className="bt-side-row">
        <div className="bt-side-tabs seg">
          <button
            className={`bt-side-long${side === "long" ? " seg-on" : ""}`}
            onClick={() => selectSide("long")}
          >
            <span className={`bt-side-dot${cfg.longEnabled === false ? " off" : ""}`} aria-hidden="true" />
            Long
          </button>
          <button
            className={`bt-side-short${side === "short" ? " seg-on" : ""}`}
            onClick={() => selectSide("short")}
          >
            <span className={`bt-side-dot${cfg.shortEnabled === false ? " off" : ""}`} aria-hidden="true" />
            Short
          </button>
        </div>
        {/* Arm switch for the side being edited — parking keeps a side's rules
            but stops it opening/closing positions. The aria-label + aria-checked
            carry the accessible name and on/off; the state word is decorative.
            The switch and its state word are one right-aligned control group. */}
        <div className="bt-arm-group">
          <button
            type="button"
            role="switch"
            aria-checked={sideEnabled}
            aria-label={`Trade the ${side} side`}
            className={`bt-switch${sideEnabled ? " on" : ""}`}
            onClick={() => setCfg({ ...cfg, [side === "long" ? "longEnabled" : "shortEnabled"]: !sideEnabled })}
          >
            <span className="bt-switch-knob" />
          </button>
          <span className={`bt-arm-state${sideEnabled ? " on" : ""}`} aria-hidden="true">{sideEnabled ? "On" : "Off"}</span>
        </div>
      </div>
      <SidePanel
        side={side}
        cfg={cfg}
        setCfg={setCfg}
        setGroup={setGroup}
        defaultAvwapAnchor={defaultAvwapAnchor}
        baseResolution={effectiveRes}
        onCopy={copyRules}
        onPaste={pasteRules}
        exprPick={exprPick}
        instances={exprInstances}
        sweep={{
          axes: displayAxes,
          side,
          editable: sweepEditable,
          onToggle: toggleRangeSweepAxis,
          onToggleRisk: toggleRiskSweepAxis,
          // Dropping a stop/target kind drops its stale value/mult axis so a
          // now-unread field can't sweep N identical rows (matches coded mode).
          onKindChange: (field) => {
            const sides = riskSyncOn(cfg) ? (["long", "short"] as const) : ([side] as const);
            setSweepAxes((axes) =>
              axes.filter((a) => !sides.some((sd) => a.target.startsWith(`risk:${sd}.${field}.`))));
          },
          onAxisChange: patchAxis,
        }}
      />
        </>
      )}
          </div>
    </>
  );
}
