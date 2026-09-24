import type { BacktestConfig, Rule, RuleGroup } from "../lib/backtestConfig";
import type { ExprInstance } from "../lib/expr/catalog";
import { applyRiskSync, riskPatch, riskSyncOn } from "../lib/riskSync";
import type { RangeAxis, SweepAxis } from "../lib/sweep";
import { RiskSection, ScalingSection } from "./RiskScalingSections";
import { RuleGroupSection } from "./RuleBuilder";
import { DEFAULT_SCALING, EMPTY_RISK } from "./shared";

// One side of the strategy (long or short): an arm switch that parks the whole
// side without losing its rules, above that side's entry/exit rule groups.
// Parking dims the rules but keeps them editable, so you can set a side up
// before you switch it on. Long and short are structurally identical, so both
// render through here rather than being copy-pasted.
export function SidePanel({
  side,
  cfg,
  setCfg,
  setGroup,
  defaultAvwapAnchor,
  baseResolution,
  onCopy,
  onPaste,
  exprPick,
  instances,
  sweep,
}: {
  side: "long" | "short";
  cfg: BacktestConfig;
  setCfg: (c: BacktestConfig) => void;
  setGroup: (which: "longEntry" | "longExit" | "shortEntry" | "shortExit", g: RuleGroup) => void;
  defaultAvwapAnchor: number;
  baseResolution: string;
  onCopy: (rules: Rule[]) => void;
  onPaste: () => Promise<Rule[] | null>;
  // "Pick from chart" arming, coordinated by the parent so only one row is armed
  // at a time. Absent with no chart (Live panel) — the button doesn't render.
  exprPick?: {
    armed: { group: "longEntry" | "longExit" | "shortEntry" | "shortExit"; row: number } | null;
    arm: (group: "longEntry" | "longExit" | "shortEntry" | "shortExit", row: number) => void;
    disarm: () => void;
  };
  // The live chart's referenceable panes, passed straight through to each rule
  // editor for lint + completion. Absent (Live panel, no chart) = no panes.
  instances?: readonly ExprInstance[];
  // Task 9: optional per-operand-field sweep toggle for rule mode. Undefined
  // (coded mode's own RuleGroupSection use, the Live panel) renders as before.
  // `onToggleRisk` / `onKindChange` carry the SL/TP sweep toggle for the risk
  // block — separate from the rule-operand toggle (% step heuristic, drops
  // stale axes on a stop/target kind change).
  sweep?: {
    axes: SweepAxis[];
    side: "long" | "short";
    editable: boolean;
    onToggle: (target: string, current: number) => void;
    onToggleRisk: (target: string, current: number) => void;
    onKindChange: (field: "stop" | "target") => void;
    onAxisChange: (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
  };
}) {
  const isLong = side === "long";
  const enabled = (isLong ? cfg.longEnabled : cfg.shortEnabled) !== false;
  const entry = isLong ? cfg.longEntry : cfg.shortEntry;
  const exit = isLong ? cfg.longExit : cfg.shortExit;
  // Bind the parent's arming API to one group key, so each rule section gets a
  // simple { armedRow, arm(row), disarm } view of the single shared armed state.
  const sidePick = (group: "longEntry" | "longExit" | "shortEntry" | "shortExit") =>
    exprPick
      ? {
          armedRow: exprPick.armed?.group === group ? exprPick.armed.row : null,
          arm: (row: number) => exprPick.arm(group, row),
          disarm: exprPick.disarm,
        }
      : undefined;

  return (
    <>
      {/* The arm switch now lives beside the Long/Short tabs in the parent; this
          panel keeps only the inert wrapper. */}
      {/* When the side is parked, `inert` makes every rule/field/button inside
          non-interactive (pointer AND keyboard) — the switch above stays live so
          it can be turned back on. `.bt-parked` supplies the dimmed visual cue. */}
      <div className={`bt-side-rules${enabled ? "" : " bt-parked"}`} inert={!enabled}>
        <RuleGroupSection
          title={isLong ? "Buy to open" : "Sell to open"}
          info={`Conditions that open a ${side} position. From two rules up, the AND/OR switch beside this title sets whether all of them must pass or just one.`}
          group={entry}
          onChange={(g) => setGroup(isLong ? "longEntry" : "shortEntry", g)}
          emptyHint={`No ${side}-entry rules, so this strategy won't open any ${side} positions.`}
          defaultAvwapAnchor={defaultAvwapAnchor}
          baseResolution={baseResolution}
          onCopy={onCopy}
          onPaste={onPaste}
          pickIndicator={sidePick(isLong ? "longEntry" : "shortEntry")}
          instances={instances}
          sweep={sweep && { ...sweep, group: "entry" }}
        />
        <RuleGroupSection
          title={isLong ? "Sell to close" : "Buy to close"}
          info={`Conditions that close an open ${side} position. A stop or target can close it first. From two rules up, the AND/OR switch beside this title sets whether all of them must pass or just one.`}
          group={exit}
          onChange={(g) => setGroup(isLong ? "longExit" : "shortExit", g)}
          emptyHint={`No ${side}-exit rules, so an open ${side} holds until the trading window ends.`}
          defaultAvwapAnchor={defaultAvwapAnchor}
          baseResolution={baseResolution}
          onCopy={onCopy}
          onPaste={onPaste}
          pickIndicator={sidePick(isLong ? "longExit" : "shortExit")}
          instances={instances}
          isExit
          sweep={sweep && { ...sweep, group: "exit" }}
        />
        <RiskSection
          risk={(isLong ? cfg.longRisk : cfg.shortRisk) ?? EMPTY_RISK}
          onChange={(r) => setCfg({ ...cfg, ...riskPatch(riskSyncOn(cfg), side, r) })}
          sweep={sweep && {
            axes: sweep.axes,
            side: sweep.side,
            onToggle: sweep.onToggleRisk,
            onKindChange: sweep.onKindChange,
            onAxisChange: sweep.onAxisChange,
          }}
          sync={{
            on: riskSyncOn(cfg),
            // Turning sync ON copies the side being viewed across; OFF just
            // stops mirroring, both sides keep their (identical) values.
            onToggle: () => setCfg(applyRiskSync({ ...cfg, riskSynced: !riskSyncOn(cfg) }, side)),
          }}
        />
        <ScalingSection
          scaling={(isLong ? cfg.longScaling : cfg.shortScaling) ?? DEFAULT_SCALING}
          onChange={(s) => setCfg({ ...cfg, [isLong ? "longScaling" : "shortScaling"]: s })}
        />
      </div>
    </>
  );
}
