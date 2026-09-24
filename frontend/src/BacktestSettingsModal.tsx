// Backtest strategy builder: time range + history depth, entry/exit rule
// groups, costs, and named presets. Matches the app's other modals exactly
// (useDraggable/useCloseOnEscape/CloseButton, .modal-backdrop/.modal/.modal-head/
// .modal-foot) — no shared wrapper, no portal.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import CloseButton from "./CloseButton";
import InfoTip from "./components/InfoTip";
import RunBar, { ModeSeg } from "./components/RunBar";
import TipIcon from "./components/TipIcon";
import Tooltip from "./components/Tooltip";
import { backtestActionBlockedByReplay } from "./lib/backtest";
import {
  backtestRunningSignal,
  backtestDurationSignal,
  sweepDurationSignal,
  wfoDurationSignal,
  backtestMessagesSignal,
  sweepAxesSignal,
  holdoutEvalSignal,
  sweepStateSignal,
  requestBacktestCancel,
  requestBacktestClear,
  requestSweepCancel,
  backtestResultSignal,
  sweepTargetSignal,
  saveSweepTarget,
  sweepCombosOverrideSignal,
  sweepArchivedSignal,
  wfoStateSignal,
  wfoRequestSignal,
  wfoRenderRequest,
  requestWfoCancel,
  progressStageSignal,
  backtestConfigLive,
  backtestPanelHiddenSignal,
} from "./lib/signals";
import { stageLabel } from "./lib/progressLabels";
import { resumeSweep } from "./lib/sweepResume";
import { buildWalkForwardPayload, liftFoldPlateau, matchUiAxesByTargets, resumeWfo, uiAxesFromResult, wfoComboSummary, DEFAULT_WFO_CONFIG, type WfoConfigState } from "./lib/wfo";
import { WfoResults } from "./WfoResults";
import { resolveWindow } from "./lib/backtestWindow";
import { useRuleClipboard } from "./lib/useRuleClipboard";
import { RESOLUTION_SECONDS } from "./lib/feed";
import {
  type BacktestConfig,
  type RangeConfig,
  type RuleGroup,
  type Costs,
  type RecurrenceMask,
  type SessionPreset,
} from "./lib/backtestConfig";
import { SESSION_PRESETS, minToTime, sessionWindowInTz } from "./lib/backtestSchedule";
import type { ChartController } from "./lib/chartController";
import BacktestPanel from "./BacktestPanel";
import { SweepResults } from "./SweepResults";
import { comboCount, materializePeriodAxes, mirrorRiskAxes, SWEEP_WARN_COMBOS, type RangeAxis, type SweepAxis, type SweepCombo, type SweepOption } from "./lib/sweep";
import { omitParkedLitAxes, patchExprLiterals, pruneLitAxes } from "./lib/expr/sweepLiterals";
import { refineAxesAround, sampleCombos } from "./lib/sweepSearch";
import { useStableCallback } from "./lib/useStableCallback";
import { sweepAxisLabel, withSweepLabels, type LabelConfig } from "./lib/sweepLabels";
import {
  sweepContext, recallSweepRange, recordSweepRanges,
  loadSweepAxes, saveSweepAxes, pruneSweepAxes,
} from "./lib/sweepMemory";
import { loadHoldout, saveHoldoutPct, recordPeek, splitHoldout } from "./lib/holdout";
import { applyRiskSync, riskSyncOn } from "./lib/riskSync";
import { fmtRunDuration } from "./lib/duration";
import { fetchStrategies, computeStatus, listSweepArchives, getSweepArchive, deleteSweepArchive, getWfoFoldTable, getWfoArchiveTables, type StrategyInfo, type ParamSpec, type SweepArchiveSummary, type CostProfile, type SweepRow, type WfoResult } from "./api";
import { WfoArchive } from "./WfoArchive";
import {
  loadCodedCfg,
  saveCodedCfg,
  defaultCodedCfg,
  type CodedStrategyConfig,
} from "./lib/codedConfig";
import {
  saveBacktestLastUsed,
  loadBacktestSide,
  saveBacktestSide,
  loadBacktestMode,
  saveBacktestMode,
  type BacktestRunMode,
  loadSweepResultId,
  saveSweepResultId,
  clearSweepResultId,
  loadWfoSchedule,
  saveWfoSchedule,
} from "./lib/persist";
import { ColumnGlyph } from "./backtestSettings/icons";
import { PastSweepsMenu } from "./backtestSettings/menus";
import { ActiveWindowsSection } from "./backtestSettings/ActiveWindowsSection";
import { CostsSection } from "./backtestSettings/CostsSection";
import { PresetsPane } from "./backtestSettings/PresetsPane";
import { StrategySection } from "./backtestSettings/StrategySection";
import { HistoryDepthSection, PeriodSection } from "./backtestSettings/PeriodSection";
import { useExprInstances, useExprPick } from "./backtestSettings/useExprPick";
import { useInstrumentCosts } from "./backtestSettings/useInstrumentCosts";
import { usePanelLayout } from "./backtestSettings/usePanelLayout";
import { useSectionScrollspy } from "./backtestSettings/useSectionScrollspy";
import {
  EMPTY_RISK,
  PRESETS_TAB,
  SCROLL_TABS,
  blockNegKeys,
  clampPosOnBlur,
  cleanNumInput,
  costProfileCache,
  withChartTz,
  type BacktestTab,
} from "./backtestSettings/shared";

// Re-exported so LiveTradingPanel and the tests keep importing from here.
export { RiskSection } from "./backtestSettings/RiskScalingSections";
export { RuleGroupSection } from "./backtestSettings/RuleBuilder";
export { EMPTY_RISK, resetCostProfileCache } from "./backtestSettings/shared";

interface Props {
  initial: BacktestConfig;
  epic: string;
  // The active broker id, so the Costs tab can prefill/refetch the instrument
  // cost profile (spread, slippage, financing) from that broker.
  brokerId: string;
  resolution: string;
  // The focused chart cell, so "Pick Range" can arm a drag-select on it. Null when
  // no cell is focused — the button is then disabled.
  controller: ChartController | null;
  // The chart's display timezone (already resolved to a concrete IANA zone —
  // never ""). The schedule mask, calendar chips and clock filters are all
  // evaluated in this one zone: there is no separate backtest timezone. To gate
  // on a market's real hours, set the chart to that market's zone.
  chartTimezone: string;
  onRun: (cfg: BacktestConfig) => void;
  onClose: () => void;
}

export default function BacktestSettingsModal({ initial, epic, brokerId, resolution, controller, chartTimezone, onRun, onClose }: Props) {
  // "Copy immediately" half of the SL/TP sync: a config arriving with sync on
  // but the sides drifted apart (saved before the option existed, or edited
  // while off) is normalized on load, the side being viewed winning.
  const [cfg, setCfg] = useState<BacktestConfig>(() => applyRiskSync(initial, loadBacktestSide()));
  // Single source of truth for the stall-window progress label (downloading
  // candles / submitting / uploading to compute host / running backtest),
  // shown above all three result panels regardless of mode so it's visible
  // even before a sweep/WFO panel has mounted.
  const stage = useSyncExternalStore(
    (cb) => progressStageSignal.subscribe(cb),
    () => progressStageSignal.value,
  );
  // True while "Pick Range" is armed on the chart (mirrors the controller signal),
  // so the button reflects the active state.
  const [pickingRange, setPickingRange] = useState(false);
  // Which saved preset the panel is editing. Not persisted across opens — a
  // fresh open starts from the last-used config with no active preset.
  const [activePreset, setActivePreset] = useState<string | null>(null);
  // The instrument cost profile behind the Costs tab: source note + refetch. Seeded
  // from the session cache so re-opening for the same epic shows the note without a
  // refetch. null until the first fetch resolves (or when it fails).
  const [costProfile, setCostProfile] = useState<CostProfile | null>(() => costProfileCache.get(epic) ?? null);
  // Restore the last-viewed tab (device-local) and persist it on switch, so
  // re-opening the modal returns to the side you were working on.
  const [side, setSide] = useState<"long" | "short">(loadBacktestSide);
  const [tab, setTab] = useState<BacktestTab>("period");
  // Backtest vs Sweep mode. The mode gates what Run does and which results the
  // bottom region shows — NOT whether results exist: both result sets stay
  // populated, so flipping the switch flips the view with nothing cleared.
  // Device-local, restored on open; a sweep still running when the modal opens
  // (re-attach below) forces "sweep" so its progress is immediately visible.
  const [btMode, setBtMode] = useState<BacktestRunMode>(() =>
    sweepStateSignal.value ? "sweep" : loadBacktestMode(),
  );
  const selectMode = (m: BacktestRunMode) => {
    setBtMode(m);
    saveBacktestMode(m);
  };
  // Auto-persist the config on every edit, so changes like deleting a rule stick
  // even if the modal is closed without running. Previously the last-used config
  // was saved ONLY on Run, so an edit made and then abandoned reappeared on the
  // next reload (loadBacktestLastUsed returned the stale saved copy). The backend
  // mirror (save() → PUT) is un-debounced, so we coalesce edits with a short timer
  // rather than firing a request per keystroke. `initial` already came from
  // loadBacktestLastUsed(), so skip the mount pass to avoid a redundant re-mirror.
  const firstCfgSave = useRef(true);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  useEffect(() => {
    if (firstCfgSave.current) {
      firstCfgSave.current = false;
      // The copy-on-load risk-sync normalization (applyRiskSync above, which
      // returns `initial` unchanged when it's a no-op) must reach storage right
      // away: the run payload is rebuilt from loadBacktestLastUsed(), so a
      // drifted stored side would run a stop the panel no longer displays.
      if (cfg !== initial) saveBacktestLastUsed(cfg);
      return;
    }
    const t = setTimeout(() => saveBacktestLastUsed(cfg), 400);
    return () => clearTimeout(t);
  }, [cfg]);
  // Flush the latest config when the modal unmounts, so an edit made inside the
  // debounce window right before closing isn't dropped by the timer cleanup above.
  useEffect(() => () => saveBacktestLastUsed(cfgRef.current), []);
  // Publish the live config so the chart's rule-proximity heatmap tracks edits as
  // they happen (undebounced: the heatmap fetch is debounced on its own side).
  // Clear to null on unmount so the chart falls back to the persisted config.
  useEffect(() => {
    backtestConfigLive.set(cfg);
  }, [cfg]);
  useEffect(() => () => backtestConfigLive.set(null), []);
  // "Pick Range" ↔ chart wiring: mirror the armed flag for the button state, and
  // when the chart publishes a picked range drop it into the Custom from/to (and
  // switch to Custom mode). Re-subscribes if the focused cell changes.
  useEffect(() => {
    if (!controller) {
      setPickingRange(false);
      return;
    }
    setPickingRange(controller.rangePickArmed.value);
    const unsubArmed = controller.rangePickArmed.subscribe(setPickingRange);
    const unsubResult = controller.rangePickResult.subscribe((res) => {
      if (!res) return;
      // Never from a REPLAYING cell. A picked range is the real epoch of the
      // bars under the cursor, and these two fields print it as a local date and
      // time next to an axis reading "Day 3 09:30" — the one number the session
      // exists to hide, handed back with the session still running (and then
      // persisted by saveBacktestLastUsed). The button below is disabled, so this
      // is the belt for a result already in flight when the session started.
      if (controller.replaying.value) {
        controller.rangePickResult.set(null);
        return;
      }
      setCfg((c) => ({ ...c, range: { ...c.range, mode: "custom", fromMs: res.fromMs, toMs: res.toMs } }));
      controller.rangePickResult.set(null); // consume one-shot
    });
    return () => {
      unsubArmed();
      unsubResult();
      controller.rangePickArmed.set(false); // don't leave the chart armed if the panel closes mid-pick
    };
  }, [controller]);

  const selectSide = (s: "long" | "short") => {
    setSide(s);
    saveBacktestSide(s);
  };
  // Whether the side being edited is armed (opens/closes positions). Drives the
  // arm switch that sits beside the Long/Short tabs.
  const sideEnabled = (side === "long" ? cfg.longEnabled : cfg.shortEnabled) !== false;

  // Coded strategies (mode === "coded"): the discovered file list is fetched
  // HERE (not inside StrategyPicker) so this modal can also read the selected
  // file's `params` schema for the Parameters/Risk/Exit sections below the
  // picker — StrategyPicker just renders whatever list it's given.
  const [strategyList, setStrategyList] = useState<StrategyInfo[]>([]);
  const [strategyListError, setStrategyListError] = useState<string | null>(null);
  const reloadStrategies = () => {
    fetchStrategies()
      .then((list) => {
        setStrategyList(list);
        setStrategyListError(null);
      })
      .catch((e) => setStrategyListError(e instanceof Error ? e.message : "failed to load strategies"));
  };
  useEffect(() => void reloadStrategies(), []);
  const selectedStrategy = strategyList.find((s) => s.filename === cfg.codedStrategy);

  // The per-strategy-file panel config (params + risk + exit groups), loaded
  // from the "backtest" coded set whenever the selected file changes. Every
  // edit writes straight through to storage via updateCoded.
  // applyRiskSync: same copy-on-load normalization as `cfg` above; both side
  // blocks are visible at once here, so long wins.
  const [codedCfg, setCodedCfg] = useState<CodedStrategyConfig>(() =>
    applyRiskSync(cfg.codedStrategy ? loadCodedCfg("backtest", cfg.codedStrategy) : defaultCodedCfg(), "long"),
  );
  useEffect(() => {
    const stored = cfg.codedStrategy ? loadCodedCfg("backtest", cfg.codedStrategy) : defaultCodedCfg();
    const nextCoded = applyRiskSync(stored, "long");
    setCodedCfg(nextCoded);
    // Write the normalization back: the run payload is rebuilt from storage
    // (BacktestButton's loadCodedCfg), not from this state — leaving the stored
    // copy drifted would show one stop kind while the run sends the other.
    // applyRiskSync returns the same reference when it changed nothing.
    if (cfg.codedStrategy && nextCoded !== stored) saveCodedCfg("backtest", cfg.codedStrategy, nextCoded);
    // Coded axes are per-file: switching files swaps in that file's saved set.
    if (cfg.mode === "coded") {
      setSweepAxes(pruneSweepAxes(loadSweepAxes(sweepContext("coded", cfg.codedStrategy)), nextCoded));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.codedStrategy]);
  const updateCoded = (c: CodedStrategyConfig) => {
    setCodedCfg(c);
    if (cfg.codedStrategy) saveCodedCfg("backtest", cfg.codedStrategy, c);
  };
  // Sweep axes: persisted per context (rules / coded file) so the setup
  // survives close, apply, reload, and mode switches. Restored axes are pruned
  // against the current config so a deleted rule cannot leave a phantom axis.
  // labelCfg() is declared below (TDZ), so the initializer inlines the ternary.
  // Any number of axes; SWEEP_WARN_COMBOS is only a soft warning on run size
  // (the footer count highlights it). Written to sweepAxesSignal right before a run so
  // BacktestButton can branch on it.
  const [sweepAxes, setSweepAxes] = useState<SweepAxis[]>(() =>
    pruneSweepAxes(
      loadSweepAxes(sweepContext(cfg.mode, cfg.codedStrategy)),
      cfg.mode === "coded" ? codedCfg : cfg,
    ),
  );
  // The axes that actually ran, materialized (period → concrete windows) at run
  // time — SweepResults labels against these, not the still-editable sweepAxes.
  const [ranAxes, setRanAxes] = useState<SweepAxis[]>([]);
  // Past sweeps archived server-side for this epic, for the reopen picker.
  const [pastSweeps, setPastSweeps] = useState<SweepArchiveSummary[]>([]);
  const [, setPickedSweep] = useState("");
  // The reopen picker stays a SHARED per-epic library (a past-sweeps history any
  // cell can pull from). It no longer auto-reopens the newest sweep — which
  // result is SHOWN is now bound per tab+cell via the sweep pointer (see the
  // restore effect below), so two cells on the same epic don't inherit each
  // other's sweep.
  const refreshPastSweeps = () => {
    listSweepArchives(epic)
      .then(setPastSweeps)
      .catch((e) => console.warn("list sweeps failed", e));
  };
  // Reopen an archived sweep: load its ran-axes into the results-axes state and
  // its rows into the sweep results state, with progress cleared so apply works.
  // No-op while a sweep is running: reopening would stomp the live run's axes and
  // rows (wrong ranAxes for streaming rows, defeating applySweepCombo's running
  // guard). The picker controls are disabled while running too; this is the
  // belt-and-braces guard.
  const reopenSweep = (id: string, bind = false) => {
    if (sweepStateSignal.value?.running) return;
    getSweepArchive(id)
      .then((a) => {
        setRanAxes(a.axes);
        sweepStateSignal.set({
          rows: a.rows, done: a.rows.length, total: a.rows.length, running: false,
        });
        // A user reopen (bind) makes this archive THIS cell's bound result, so it
        // restores here — not the previous one — on the next switch/reload. The
        // silent restore path (bind=false) must NOT rewrite the pointer.
        if (bind && controller) saveSweepResultId(controller.scope, epic, id);
      })
      .catch((e) => console.warn("reopen sweep failed", e));
  };
  const removePastSweep = (id: string) => {
    deleteSweepArchive(id)
      .then(() => {
        setPickedSweep("");
        // If this cell was bound to the deleted sweep, drop the dangling pointer.
        if (controller && loadSweepResultId(controller.scope, epic) === id) {
          clearSweepResultId(controller.scope, epic);
        }
        refreshPastSweeps();
      })
      .catch((e) => console.warn("delete sweep failed", e));
  };
  // Drop the on-screen sweep results (the footer "Clear results" action). Resets
  // the picker so the same archive can be reopened right after.
  const clearSweepResults = () => {
    sweepStateSignal.set(null);
    setRanAxes([]);
    setPickedSweep("");
    // Explicit clear also unbinds this cell — nothing to restore on next switch.
    if (controller) clearSweepResultId(controller.scope, epic);
  };
  // Search strategy for a sweep: "grid" enumerates every combo; "random" draws
  // N combos uniformly from the same ranges (seed fixed at 1 for reproducibility).
  // Session-only UI preference — plain state, not persisted.
  const [searchMode, setSearchMode] = useState<"grid" | "random">("grid");
  const [randomN, setRandomN] = useState(200);
  // Appends the toggled-on axis (shared by every sweep toggle).
  const addAxis = (axes: SweepAxis[], next: SweepAxis) => [...axes, next];
  // The storage context sweep memory/axes are keyed by: "rules", or the coded
  // strategy file, so param:n on two different .py files never collide.
  const sweepCtx = () => sweepContext(cfg.mode, cfg.codedStrategy);
  // Holdout ("lockbox"): the reserved-tail config for the current strategy
  // context. Keyed identically to sweep memory (rules / coded file), so the
  // reservation follows the strategy, not the panel. Reloaded on context change.
  const [holdout, setHoldout] = useState<{ pct: number; peeks: number } | null>(
    () => loadHoldout(sweepContext(cfg.mode, cfg.codedStrategy)),
  );
  useEffect(() => {
    setHoldout(loadHoldout(sweepContext(cfg.mode, cfg.codedStrategy)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.mode, cfg.codedStrategy]);
  const changeHoldoutPct = (pct: number | null) => {
    const key = sweepCtx();
    saveHoldoutPct(key, pct);
    setHoldout(loadHoldout(key));
  };
  // In Backtest mode every sweep control is inert: the glyphs render dimmed
  // (CSS off the bt-mode-backtest root class) and the toggles below no-op, so
  // the configured axes can't change invisibly while their editors are hidden.
  // Sweep controls stay editable in walk-forward too: WFO reuses the same
  // parameter-axis toggles to define its optimization grid. Only pure Backtest
  // mode makes them inert.
  const sweepEditable = btMode !== "backtest";
  // What the config sections render against: in Backtest mode the axes read as
  // absent, so swept fields show their plain inputs again (the value a single
  // run actually uses) and the inline from/to/step editors hide. The real
  // sweepAxes survive untouched for the next flip back to Sweep mode.
  const displayAxes = sweepEditable ? sweepAxes : [];
  // `lit:` axes on DISABLED rules are parked: kept in sweepAxes (and shown
  // greyed on their rule row) so re-enabling the rule restores them, but
  // excluded from everything a run consumes — combo count, grid submission,
  // WFO payload — because a disabled rule never evaluates and each swept value
  // would just re-run the identical backtest. A side whose trade toggle is off
  // parks every rule on that side the same way: an unarmed side never opens
  // positions, so none of its rules evaluate either. (The side flags live on
  // cfg in both modes; codedCfg has none of its own.)
  const disabledRuleRows = useMemo(() => {
    const src = cfg.mode === "coded" ? codedCfg : cfg;
    const out = new Set<string>();
    for (const [side, group, key] of [
      ["long", "entry", "longEntry"],
      ["long", "exit", "longExit"],
      ["short", "entry", "shortEntry"],
      ["short", "exit", "shortExit"],
    ] as const) {
      const sideOff = (side === "long" ? cfg.longEnabled : cfg.shortEnabled) === false;
      (((src as any)?.[key]?.rules ?? []) as { enabled?: boolean }[]).forEach((r, i) => {
        if (sideOff || r.enabled === false) out.add(`${side}.${group}.${i}`);
      });
    }
    return out;
  }, [cfg, codedCfg]);
  const activeSweepAxes = useMemo(
    () => omitParkedLitAxes(sweepAxes, disabledRuleRows),
    [sweepAxes, disabledRuleRows],
  );
  const toggleSweepAxis = (target: string, spec: ParamSpec) => {
    if (!sweepEditable) return;
    setSweepAxes((axes) => {
      if (axes.some((a) => a.target === target)) return axes.filter((a) => a.target !== target);
      const mem = recallSweepRange(sweepCtx(), target);
      const next: SweepAxis = {
        kind: "range",
        target,
        label: spec.label,
        from: mem?.from ?? spec.min ?? (spec.default as number),
        to: mem?.to ?? spec.max ?? (spec.default as number) * 2,
        step: mem?.step ?? spec.step ?? 1,
      };
      return addAxis(axes, next);
    });
  };
  // The config a rule/risk axis label resolves against: rules mode reads the
  // rule config, coded mode reads the per-file coded config (exit rules + risk).
  const labelCfg = (): LabelConfig => (cfg.mode === "coded" ? codedCfg : cfg);
  // Shared inline-editor patch: RangeChip edits flow back through here.
  const patchAxis = (target: string, patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) =>
    setSweepAxes((axes) => axes.map((a) => (a.target === target && a.kind === "range" ? { ...a, ...patch } : a)));
  // Write-through: every axes change lands in the current context's key. Deps
  // are [sweepAxes] ON PURPOSE: on a mode/file switch the axes swap in the
  // same update (or a later effect) as cfg, so this never writes one
  // context's axes under another context's key.
  useEffect(() => {
    saveSweepAxes(sweepCtx(), sweepAxes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepAxes]);
  // param: axes can only be validated once the strategy schema loads; drop any
  // axis naming a param the selected file no longer declares. Keyed on cfg.mode
  // too so entering coded mode (mode-switch restore passes all param: axes
  // through) re-runs the prune, not just a strategy-file change.
  useEffect(() => {
    if (cfg.mode !== "coded" || !selectedStrategy) return;
    const names = new Set(selectedStrategy.params.map((p) => p.name));
    setSweepAxes((axes) => {
      const kept = axes.filter(
        (a) => !a.target.startsWith("param:") || names.has(a.target.slice("param:".length)),
      );
      return kept.length === axes.length ? axes : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStrategy, cfg.mode]);
  // Drop lit: axes whose literal vanished after an expression edit / row delete.
  useEffect(() => {
    const src = cfg.mode === "coded" ? codedCfg : cfg; // coded exits are structured; still safe to scan
    const groups = (
      [
        ["long", "entry", "longEntry"],
        ["long", "exit", "longExit"],
        ["short", "entry", "shortEntry"],
        ["short", "exit", "shortExit"],
      ] as const
    ).map(([side, group, key]) => ({
      side,
      group,
      exprs: (((src as any)?.[key]?.rules ?? []) as any[]).map((r: any) => r.expr ?? ""),
    }));
    setSweepAxes((axes) => {
      const next = pruneLitAxes(axes, groups);
      return next.length === axes.length ? axes : next; // identity-stable no-op
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.longEntry, cfg.longExit, cfg.shortEntry, cfg.shortExit]);
  // Risk numeric fields have no declared min/max/step — pick sensible defaults
  // from the field's current value (from = current, to = 2x, step = a coarse
  // fraction so a first sweep is immediately useful without hand-tuning).
  const toggleRiskSweepAxis = (target: string, current: number) => {
    if (!sweepEditable) return;
    setSweepAxes((axes) => {
      if (axes.some((a) => a.target === target)) return axes.filter((a) => a.target !== target);
      const base = current || 1;
      const mem = recallSweepRange(sweepCtx(), target);
      const next: SweepAxis = {
        kind: "range",
        target,
        label: sweepAxisLabel(target, labelCfg()) ?? target.split(".").slice(1).join(" "),
        from: mem?.from ?? base,
        to: mem?.to ?? base * 2,
        step: mem?.step ?? Math.max(base / 10, 0.1),
      };
      return addAxis(axes, next);
    });
  };
  // Numeric range axis for an expression literal (lit: target) — same heuristic
  // as toggleRiskSweepAxis (no declared min/max/step to draw from). The literal
  // sweep chips in RuleGroupSection wire their toggle through here.
  const toggleRangeSweepAxis = (target: string, current: number) => {
    if (!sweepEditable) return;
    setSweepAxes((axes) => {
      if (axes.some((a) => a.target === target)) return axes.filter((a) => a.target !== target);
      const base = current || 1;
      const mem = recallSweepRange(sweepCtx(), target);
      const next: SweepAxis = {
        kind: "range",
        target,
        label: sweepAxisLabel(target, labelCfg()) ?? target,
        from: mem?.from ?? base,
        to: mem?.to ?? base * 2,
        step: mem?.step ?? Math.max(base / 10, 1),
      };
      return addAxis(axes, next);
    });
  };
  const timeWindowAxis = displayAxes.find((a) => a.target === "timeWindow");
  const twOption = (startMin: number, endMin: number, tz: string, label?: string): SweepOption => ({
    label: label ?? `${minToTime(startMin)}-${minToTime(endMin)} ${tz}`,
    patch: { "timeWindow:startMin": startMin, "timeWindow:endMin": endMin, "timeWindow:tz": tz },
  });
  // Time-window axis: a discrete list of intraday windows, seeded with the
  // mask's current window when one is set.
  const toggleTimeWindowSweepAxis = () => {
    if (!sweepEditable) return;
    if (btMode === "walkforward") return; // session (timeWindow) axes are dropped in WFO
    setSweepAxes((axes) => {
      if (axes.some((a) => a.target === "timeWindow")) return axes.filter((a) => a.target !== "timeWindow");
      const t = cfg.range.mask?.timeOfDay;
      const tz = chartTimezone;
      return addAxis(axes, {
        kind: "list", target: "timeWindow", label: "Window",
        options: t ? [twOption(t.startMin, t.endMin, tz)] : [],
      });
    });
  };
  const addTimeWindowOption = (o: SweepOption) =>
    setSweepAxes((axes) => axes.map((a) =>
      a.target === "timeWindow" && a.kind === "list" && !a.options.some((x) => x.label === o.label)
        ? { ...a, options: [...a.options, o] }
        : a));
  // A session preset fills its hours converted into the chart timezone (the
  // window is read there like every other clock filter, no per-preset tz).
  const addSessionWindowOption = (key: SessionPreset | "") => {
    if (!key) return;
    const p = SESSION_PRESETS[key];
    const w = sessionWindowInTz(p.window, p.tz, chartTimezone, Date.now());
    if (!w) return; // Crypto: 24h, no window to sweep
    addTimeWindowOption(twOption(w.startMin, w.endMin, chartTimezone, p.label));
  };
  // Removing the last option empties the axis; drop it entirely so an empty
  // kind:"list" axis can't strand a slot or make comboCount return Infinity.
  const removeTimeWindowOption = (i: number) =>
    setSweepAxes((axes) => axes
      .map((a) =>
        a.target === "timeWindow" && a.kind === "list"
          ? { ...a, options: a.options.filter((_, j) => j !== i) }
          : a)
      .filter((a) => !(a.target === "timeWindow" && a.kind === "list" && a.options.length === 0)));
  const periodAxis = displayAxes.find((a) => a.target === "period");
  // Period axis: walk-forward, the range split into n equal windows. Stored as
  // just n while editing; materialized into concrete windows at run time so it
  // always reflects the range as currently configured.
  const togglePeriodSweepAxis = () => {
    if (!sweepEditable) return;
    if (btMode === "walkforward") return; // period axes are dropped in WFO
    setSweepAxes((axes) =>
      axes.some((a) => a.target === "period")
        ? axes.filter((a) => a.target !== "period")
        : addAxis(axes, { kind: "period", target: "period", label: "Period", n: 4 }));
  };
  const setPeriodN = (n: number) =>
    setSweepAxes((axes) => axes.map((a) =>
      a.kind === "period" ? { ...a, n: Math.max(2, Math.min(50, Math.round(n) || 2)) } : a));
  const sweepCombos = comboCount(activeSweepAxes);
  // Random search submits at most `randomN` combos (sampleCombos dedupes, so it
  // never exceeds the grid), so the footer count/estimate/warn track the actual
  // sample size, not the full grid. Grid mode runs the whole grid.
  const effectiveCombos = searchMode === "random" ? Math.min(randomN, sweepCombos) : sweepCombos;
  const effectiveWarn = !isFinite(effectiveCombos) || effectiveCombos > SWEEP_WARN_COMBOS;
  const [sweepState, setSweepState] = useState(sweepStateSignal.value);
  useEffect(() => sweepStateSignal.subscribe(setSweepState), []);
  // Walk-forward schedule config (device-local, re-hydrated on open) + its live
  // run state, subscribed here so the mode badge and Run button re-render as a
  // WFO job advances (mirrors the sweepState subscription above).
  // Spread over the defaults so a config persisted before a field existed
  // (e.g. evalMode) still resolves to its default rather than undefined.
  const [wfoCfg, setWfoCfg] = useState<WfoConfigState>(
    () => ({ ...DEFAULT_WFO_CONFIG, ...loadWfoSchedule(DEFAULT_WFO_CONFIG) }));
  const changeWfoCfg = (n: WfoConfigState) => { setWfoCfg(n); saveWfoSchedule(n); };
  const [wfoState, setWfoState] = useState(wfoStateSignal.value);
  useEffect(() => wfoStateSignal.subscribe(setWfoState), []);
  // Combo count + dropped-axis labels for the WFO config footer/badge. Building
  // the payload throws on an invalid config (no axes / no train span); the panel
  // treats that as 0 combos / no dropped axes rather than surfacing the error here.
  // `wfoUsableAxes` are the surviving (non-period, non-timeWindow) sweep axes
  // the WFO grid actually varies — WfoResults labels params and drift by them.
  const { wfoComboTotal, wfoDroppedAxes, wfoUsableAxes } = useMemo(() => {
    // Counts the grid without materializing it. This memo re-runs on every
    // backtest-config identity change — six times over a workspace restore, as
    // measured — and enumerating a large saved grid on each of those cost
    // seconds of paint and gigabytes of heap before the chart ever appeared.
    //
    // The try stays: a malformed persisted axis (e.g. an options-[] list axis)
    // must degrade to 0 combos, never throw and crash the whole modal render.
    try {
      const { comboTotal, usable, dropped } = wfoComboSummary(activeSweepAxes, wfoCfg);
      return { wfoComboTotal: comboTotal, wfoDroppedAxes: dropped, wfoUsableAxes: usable };
    } catch {
      return { wfoComboTotal: 0, wfoDroppedAxes: [] as string[], wfoUsableAxes: [] as SweepAxis[] };
    }
  }, [activeSweepAxes, wfoCfg]);
  const [wfoError, setWfoError] = useState<string | null>(null);
  const [wfoSchemeIndex, setWfoSchemeIndex] = useState(0);
  // Live-job fold-table fetch for the folds drill-in; archive-backed loading
  // arrives with the archive browser task.
  const loadWfoFoldTable = useStableCallback(async (key: string): Promise<SweepRow[]> => {
    const jobId = wfoStateSignal.value?.jobId;
    if (!jobId) return [];
    const { rows } = await getWfoFoldTable(jobId, key, sweepTargetSignal.value);
    return rows.map(liftFoldPlateau);
  });
  // A reopened archive shown in the WFO results area (null = show the ranking
  // list, when there is no live/last run). Carries the run id + its result so
  // WfoResults renders off a reconstructed done-state.
  const [wfoArchiveOpen, setWfoArchiveOpen] = useState<{ id: string; result: WfoResult } | null>(null);
  const openWfoArchive = (a: { id: string; result: WfoResult }) => {
    setWfoSchemeIndex(0);
    setWfoArchiveOpen(a);
  };
  // Archive fold tables come as one dict keyed "s{i}/f{k}" — fetch once and cache
  // it, so the folds drill-in resolves each key from memory (mirrors the live
  // job's per-key fetch but off the stored dict).
  const wfoArchiveTables = useRef<{ id: string; dict: Record<string, SweepRow[]> } | null>(null);
  const loadWfoArchiveFoldTable = useStableCallback(async (key: string): Promise<SweepRow[]> => {
    const id = wfoArchiveOpen?.id;
    if (!id) return [];
    if (wfoArchiveTables.current?.id !== id) {
      wfoArchiveTables.current = { id, dict: await getWfoArchiveTables(id) };
    }
    return (wfoArchiveTables.current.dict[key] ?? []).map(liftFoldPlateau);
  });
  // Axes used to LABEL the live/last run's WFO results (fold params, drill-in
  // combos, drift strip): prefer the axes the RESULT carried (frozen at submit
  // via the `ui` field on WfoAxis) — the user may have edited the sweep config
  // since the run started, and the current-config wfoUsableAxes would then
  // mislabel the combos. A still-running (or pre-field) result has none; fall
  // back to the config's.
  const wfoResultAxes = uiAxesFromResult(wfoState?.result);
  const wfoLiveAxes = wfoResultAxes.length ? wfoResultAxes : wfoUsableAxes;
  // Same for a reopened archive: its result carries its own axes. A pre-field
  // archive stored none — label it with the CURRENT config's axes only when
  // they align 1:1 with the archived axes by kind+targets (raw keys otherwise).
  const wfoArchiveUiAxes = uiAxesFromResult(wfoArchiveOpen?.result);
  const wfoArchiveAxes = wfoArchiveOpen
    ? wfoArchiveUiAxes.length
      ? wfoArchiveUiAxes
      : matchUiAxesByTargets(wfoArchiveOpen.result.axes, activeSweepAxes)
    : [];
  // Reconstructed done-state for the reopened archive (WfoRunState shape).
  const wfoArchiveState = wfoArchiveOpen
    ? { phase: "done" as const, done: 0, total: 0, running: false, foldRows: [], result: wfoArchiveOpen.result }
    : null;
  // Bumped whenever a sweep is archived server-side (live run or re-attach). Mirror
  // it into state so the past-sweeps fetch effect re-runs and a sweep that finishes
  // while the section is open shows up in the picker without a reopen.
  const [archivedTick, setArchivedTick] = useState(sweepArchivedSignal.value);
  useEffect(() => sweepArchivedSignal.subscribe(setArchivedTick), []);
  // Where the sweep runs (local vs remote). Mirror the signal into state so the
  // footer estimate + toggle re-render when the target changes; the runner reads
  // sweepTargetSignal.value at submit time regardless.
  const [sweepTarget, setSweepTarget] = useState(sweepTargetSignal.value);
  useEffect(() => sweepTargetSignal.subscribe(setSweepTarget), []);
  // Whether remote compute is configured server-side (fetched once on open). The
  // Compute toggle is hidden until this resolves true, so a plain single-backend
  // install never sees a control it can't use.
  const [remoteCompute, setRemoteCompute] = useState(false);
  useEffect(() => {
    let alive = true;
    void computeStatus().then((s) => { if (alive) setRemoteCompute(s.remoteConfigured); });
    return () => { alive = false; };
  }, []);
  // On open, re-attach to a sweep job that survived a reload (submitted then the
  // panel/tab closed: the server job keeps running). Only when no run already
  // owns the state, so we never double-publish into a live in-session sweep.
  useEffect(() => {
    if (sweepStateSignal.value === null)
      // A re-attached job flips the view to Sweep so the landed/streaming rows
      // are visible; setBtMode (not selectMode) so an automatic flip doesn't
      // overwrite the user's saved mode preference.
      void resumeSweep().then((attached) => {
        if (attached) setBtMode("sweep");
      });
  }, []);
  // Same re-attach for a walk-forward job that outlived a reload: only when no
  // run already owns the WFO state, and flip the view to walk-forward so its
  // streaming folds are immediately visible (setBtMode, not selectMode).
  useEffect(() => {
    if (wfoStateSignal.value === null)
      void resumeWfo().then((attached) => {
        if (attached) setBtMode("walkforward");
      });
  }, []);
  // Clear any leftover sweep run/axes when the modal unmounts/closes, so a
  // stale in-flight state (or un-applied axes) from a previous session can't
  // bleed into a fresh open. Detach (server=false) rather than cancel: this
  // aborts BacktestButton's local poll loop but leaves the server job running,
  // so a reload can re-attach to it. The abort also stops that loop re-publishing
  // the state this cleanup just tore down (a ghost sweep with no axes on reopen).
  useEffect(() => () => {
    requestSweepCancel(false);
    sweepStateSignal.set(null);
    sweepAxesSignal.set([]);
    // Detach any live WFO poll too (server=false: leave the job running so a
    // reload can re-attach). A COMPLETED result is left intact so it survives
    // reopen for the results view — but a still-RUNNING job's state must be
    // cleared so the mount-resume gate (`if (wfoStateSignal.value === null)
    // resumeWfo()`) fires on reopen and re-attaches to the live job. Without
    // this the detached job would be orphaned (its poll aborted, its state
    // frozen), never re-attached.
    requestWfoCancel(false);
    if (wfoStateSignal.value?.running) wfoStateSignal.set(null);
  }, []);

  // Rule mode's own combo-apply — patches `lit:` axes back into the addressed
  // rule expressions on cfg's rule groups (plus timeWindow/period/risk axes).
  // Kept separate from the coded branch below (different config shape:
  // RuleGroup arrays on `cfg`, not `codedCfg`).
  function applyRuleSweepCombo(combo: Record<string, number | boolean | string>) {
    if (sweepStateSignal.value?.running) return;
    let next = cfg;
    // timeWindow combo: patch the applied window onto the mask.
    const twS = combo["timeWindow:startMin"];
    const twE = combo["timeWindow:endMin"];
    if (typeof twS === "number" && typeof twE === "number") {
      const tz = typeof combo["timeWindow:tz"] === "string" ? combo["timeWindow:tz"] : chartTimezone;
      next = {
        ...next,
        range: {
          ...next.range,
          mask: {
            ...(next.range.mask ?? { enabled: true }),
            enabled: true,
            timeOfDay: { startMin: twS, endMin: twE },
            tz,
            session: undefined,
          },
        },
      };
    }
    // period combo: apply the window as a custom range.
    const pFrom = combo["period:from"];
    const pTo = combo["period:to"];
    if (typeof pFrom === "number" && typeof pTo === "number") {
      next = { ...next, range: { ...next.range, mode: "custom", fromMs: pFrom * 1000, toMs: pTo * 1000 } };
    }
    // lit: expression-literal axes, grouped per rule row so multi-literal
    // rows splice in one pass (spans shift after each substitution).
    const litPatches = new Map<string, { ordinal: number; value: number }[]>();
    for (const [key, value] of Object.entries(combo)) {
      if (typeof value !== "number") continue;
      // SL/TP axes patch the per-side risk DTO, same shape as the coded branch.
      // risk:<side>.<stop|target>.<value|mult>
      if (key.startsWith("risk:")) {
        const [, rside, field, prop] = key.split(/[:.]/);
        const riskKey = rside === "long" ? "longRisk" : "shortRisk";
        const risk = next[riskKey] ?? EMPTY_RISK;
        next = {
          ...next,
          [riskKey]: { ...risk, [field]: { ...risk[field as "stop" | "target"], [prop]: value } },
        };
        continue;
      }
      const lit = /^lit:(long|short)\.(entry|exit)\.(\d+)\.(\d+)$/.exec(key);
      if (lit) {
        const [, lside, lgroup, rowIdx, ordinal] = lit;
        const rowKey = `${lside}.${lgroup}.${rowIdx}`;
        const patches = litPatches.get(rowKey) ?? [];
        patches.push({ ordinal: Number(ordinal), value });
        litPatches.set(rowKey, patches);
      }
    }
    // Rewrite each addressed rule's expression with the swept literal values.
    // rowIdx is the FULL-list index (disabled rows included), matching the
    // groups as stored on cfg. A row that vanished since the sweep ran is
    // skipped; patchExprLiterals itself tolerates edited/unparseable rows.
    // Known accepted gap (same as the risk:/param: paths): a rule edited since
    // the sweep that still has the same literal count applies silently onto
    // literals whose meaning may have changed — sweep state doesn't snapshot
    // the original expressions, so there's nothing to diff against.
    for (const [rowKey, patches] of litPatches) {
      const [lside, lgroup, rowIdxStr] = rowKey.split(".");
      const groupKey = (lside === "long"
        ? lgroup === "entry" ? "longEntry" : "longExit"
        : lgroup === "entry" ? "shortEntry" : "shortExit") as
        "longEntry" | "longExit" | "shortEntry" | "shortExit";
      const rowIdx = Number(rowIdxStr);
      const rule = next[groupKey].rules[rowIdx];
      if (!rule?.expr) continue;
      const patched = patchExprLiterals(rule.expr, patches);
      if (patched === rule.expr) continue;
      next = {
        ...next,
        [groupKey]: {
          ...next[groupKey],
          rules: next[groupKey].rules.map((r, i) => (i === rowIdx ? { ...r, expr: patched } : r)),
        },
      };
    }
    // Synced risk axes are canonicalized to long; copy the applied values across
    // to short (no-op when unsynced or already equal).
    next = applyRiskSync(next, "long");
    setCfg(next);
    // Clear the published axes so the follow-up run is a plain backtest, and
    // flip to Backtest mode so its result is what lands on screen. The sweep
    // table survives untouched one flip away: sweepStateSignal is kept so
    // other rows can still be inspected and applied.
    sweepAxesSignal.set([]);
    selectMode("backtest");
    run(next);
  }

  function applySweepCombo(combo: Record<string, number | boolean | string>) {
    if (cfg.mode !== "coded") return applyRuleSweepCombo(combo);
    if (!cfg.codedStrategy) return;
    // I2: a streaming sweep's run() no-ops while a run is already in flight
    // (BacktestButton guards on `running`), so applying mid-sweep would clear
    // the axes/state and silently fail to re-run, stranding the panel showing
    // stale results. Rows are visually disabled while running (SweepResults);
    // this is the belt-and-braces guard against a stale click still landing.
    if (sweepStateSignal.value?.running) return;
    let next = codedCfg;
    // period/timeWindow combos live on cfg (range/mask), not codedCfg.
    let cfgNext = cfg;
    const twS = combo["timeWindow:startMin"];
    const twE = combo["timeWindow:endMin"];
    if (typeof twS === "number" && typeof twE === "number") {
      const tz = typeof combo["timeWindow:tz"] === "string" ? combo["timeWindow:tz"] : chartTimezone;
      cfgNext = {
        ...cfgNext,
        range: {
          ...cfgNext.range,
          mask: {
            ...(cfgNext.range.mask ?? { enabled: true }),
            enabled: true,
            timeOfDay: { startMin: twS, endMin: twE },
            tz,
            session: undefined,
          },
        },
      };
    }
    // period combo: apply the window as a custom range.
    const pFrom = combo["period:from"];
    const pTo = combo["period:to"];
    if (typeof pFrom === "number" && typeof pTo === "number") {
      cfgNext = { ...cfgNext, range: { ...cfgNext.range, mode: "custom", fromMs: pFrom * 1000, toMs: pTo * 1000 } };
    }
    for (const [key, value] of Object.entries(combo)) {
      if (key.startsWith("param:")) {
        const name = key.slice("param:".length);
        next = { ...next, params: { ...next.params, [name]: value } };
      } else if (key.startsWith("risk:")) {
        const [, side, field, prop] = key.split(/[:.]/); // risk:<side>.<field>.<prop>
        const riskKey = side === "long" ? "longRisk" : "shortRisk";
        const risk = next[riskKey] ?? EMPTY_RISK;
        next = {
          ...next,
          [riskKey]: { ...risk, [field]: { ...risk[field as "stop" | "target"], [prop]: value } },
        };
      }
    }
    // Synced-risk axes are canonicalized to the long side, so the combo only
    // carried risk:long.* keys — copy the applied values across to short.
    next = applyRiskSync(next, "long");
    updateCoded(next);
    if (cfgNext !== cfg) setCfg(cfgNext);
    // Published axes cleared + mode flipped so the run is a plain backtest
    // whose result lands on screen; sweepStateSignal kept so the results
    // table survives the apply one flip away (see applyRuleSweepCombo).
    sweepAxesSignal.set([]);
    selectMode("backtest");
    run(cfgNext !== cfg ? cfgNext : undefined);
  }

  // A run's 422 can name a declared param (a stale schema mid-edit) — surfaced
  // in red under the Parameters section instead of only the generic run-error
  // spot, so it's clear which knob is at fault.
  const [messages, setMessages] = useState(backtestMessagesSignal.value);
  useEffect(() => backtestMessagesSignal.subscribe(setMessages), []);
  // Anchored on the backend's exact "param '<name>':" message shape — a bare
  // substring match on the name misfires for short names (a param `n` would
  // claim "no candles in the selected range").
  const paramError =
    cfg.mode === "coded" && messages.error && selectedStrategy?.params.some((p) => messages.error!.includes(`param '${p.name}'`))
      ? messages.error
      : null;

  // Mirror the in-flight run state (owned by BacktestButton) so the footer's
  // "Run backtest" reads as unavailable while a run is going — its click was
  // already a no-op mid-run, but the button looked active.
  const [runInFlight, setRunInFlight] = useState(backtestRunningSignal.value);
  useEffect(() => backtestRunningSignal.subscribe(setRunInFlight), []);
  // Whether a backtest result exists (owned by BacktestButton/persistence) —
  // gates the footer's "Clear results" so it only shows with something to clear.
  const [hasBtResult, setHasBtResult] = useState(backtestResultSignal.value != null);
  useEffect(() => backtestResultSignal.subscribe((r) => setHasBtResult(r != null)), []);
  // Is the cell this panel is pointed at inside a chart-replay session? This
  // panel is app-level and survives entering one, so both of its chart-acting
  // controls (Pick Range, Run) have to know. Re-subscribed when the focused cell
  // changes, like the rangePick wiring above.
  const [replayingCell, setReplayingCell] = useState(controller?.replaying.value ?? false);
  useEffect(() => {
    setReplayingCell(controller?.replaying.value ?? false);
    return controller?.replaying.subscribe(setReplayingCell);
  }, [controller]);
  const pickBlocked = backtestActionBlockedByReplay({ replaying: replayingCell, action: "pick-range" });
  const runBlocked = backtestActionBlockedByReplay({ replaying: replayingCell, action: "run" });
  // Last completed run's wall-clock duration, per mode (footer readout).
  const [btDurationMs, setBtDurationMs] = useState(backtestDurationSignal.value);
  useEffect(() => backtestDurationSignal.subscribe(setBtDurationMs), []);
  const [sweepDurationMs, setSweepDurationMs] = useState(sweepDurationSignal.value);
  useEffect(() => sweepDurationSignal.subscribe(setSweepDurationMs), []);
  const [wfoDurationMs, setWfoDurationMs] = useState(wfoDurationSignal.value);
  useEffect(() => wfoDurationSignal.subscribe(setWfoDurationMs), []);
  // Refresh the shared per-epic reopen picker whenever the sweep results section
  // becomes visible, the epic changes, or a sweep lands server-side (archivedTick
  // re-fires so a just-finished sweep appears without a reopen). No auto-reopen —
  // which result is SHOWN is bound per tab+cell by the restore effect below.
  // The results section is always rendered, so sweep mode alone is the gate.
  const sweepSectionOpen = btMode === "sweep";
  useEffect(() => {
    if (!sweepSectionOpen) return;
    refreshPastSweeps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepSectionOpen, epic, archivedTick]);

  // Bind the DISPLAYED sweep to this tab+cell: on a cell/epic switch (or when the
  // section first opens), restore THIS cell's own sweep from its persisted pointer
  // — or blank the view when it has none — so switching tabs never leaves another
  // cell's sweep on screen. Skipped while a sweep is running (never disturb a live
  // run); the running run writes its own pointer on completion. `scope` is keyed
  // so switching between two cells on the SAME epic still rebinds.
  const scope = controller?.scope ?? null;
  useEffect(() => {
    if (!sweepSectionOpen || !scope) return;
    if (sweepStateSignal.value?.running) return;
    const boundId = loadSweepResultId(scope, epic);
    if (!boundId) {
      // This cell has no sweep — blank the view (don't inherit another cell's).
      setPickedSweep("");
      sweepStateSignal.set(null);
      return;
    }
    let cancelled = false;
    setPickedSweep(boundId);
    getSweepArchive(boundId)
      .then((a) => {
        if (cancelled) return;
        setRanAxes(a.axes);
        sweepStateSignal.set({
          rows: a.rows, done: a.rows.length, total: a.rows.length, running: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        // Pointer dangles (archive deleted elsewhere or evicted past the server
        // cap): unbind and blank so a previous cell's sweep can't linger.
        clearSweepResultId(scope, epic);
        setPickedSweep("");
        sweepStateSignal.set(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, epic, sweepSectionOpen]);
  const {
    panelWidth, resetPanelWidth, onResizeStart, pinned, setPinned, hidden, chartHost,
    sideBySide, setResultsSideBySide, resultsColWidth, resetResultsColWidth, onResultsColResizeStart,
  } = usePanelLayout(pickingRange, setTab);

  const { bodyRef, setRef, jumpToTab, onBodyScroll } = useSectionScrollspy(tab, setTab);
  // The rule clipboard, shared across all four groups so rules can be pasted
  // between entry/exit and between the long and short sides — and, because copy
  // writes a self-contained envelope (rules + referenced pane configs) to the
  // system clipboard, across windows and app instances too.
  const { copyRules, pasteRules } = useRuleClipboard({ controller, epic, resolution, brokerId });

  const exprPick = useExprPick(controller, setCfg);
  const exprInstances = useExprInstances(controller);

  // The timeframe the run will actually use: the config override when set, else
  // the active chart timeframe (the `resolution` prop). Window math + the header
  // badge follow this so they reflect the run, not necessarily the chart.
  const effectiveRes = cfg.range.resolution ?? resolution;
  const resSeconds = RESOLUTION_SECONDS[effectiveRes] ?? 60;

  const defaultAvwapAnchor = resolveWindow(cfg, resSeconds, Date.now()).fromMs;

  // Functional updates: the calendar popover can call onSpan then onMaskPatch
  // back-to-back within one click handler (span completion also defaults the
  // mask on). Two setCfg calls both closing over the same pre-update `cfg`
  // would have the second clobber the first's range fields; folding off the
  // previous state instead composes them correctly.
  function setRange(patch: Partial<RangeConfig>) {
    setCfg((prev) => ({ ...prev, range: { ...prev.range, ...patch } }));
  }
  function setMask(patch: Partial<RecurrenceMask>) {
    setCfg((prev) => {
      const base: RecurrenceMask = prev.range.mask ?? { enabled: false };
      return { ...prev, range: { ...prev.range, mask: { ...base, ...patch } } };
    });
  }

  function setCosts(patch: Partial<Costs>) {
    setCfg({ ...cfg, costs: { ...cfg.costs, ...patch } });
  }

  const { setInstrumentCost, refetchCosts } = useInstrumentCosts({ epic, brokerId, setCfg, setCosts, setCostProfile });

  function setGroup(which: "longEntry" | "longExit" | "shortEntry" | "shortExit", group: RuleGroup) {
    setCfg({ ...cfg, [which]: group });
  }

  // Docked panel: running does NOT close it, so you can tweak and re-run
  // against the chart beside it. The header ✕ is the only close. Every caller is
  // an explicit user run (the footer button, a sweep-row apply, a holdout
  // evaluation), so scrolling down to the results is what was asked for —
  // nothing finishing in the background can move the pane mid-edit. In column
  // mode the results are already on screen and there is no section to jump to.
  // Optional override lets a caller that just computed a new cfg via setCfg
  // (a setState, not synchronous) run against that value immediately instead
  // of the stale `cfg` still in this closure — see applyRuleSweepCombo.
  function run(override?: BacktestConfig) {
    onRun(withChartTz(override ?? cfg, chartTimezone));
    if (!sideBySide) jumpToTab("results", false);
  }
  // Footer "Run backtest": publish the CURRENT sweep axes right before firing —
  // separate from applySweepCombo's own run(), which explicitly clears the
  // signal to [] first for its single-combo follow-up run.
  function runFromFooter() {
    if (btMode === "walkforward") {
      // Build the whole grid + schedule payload and hand it to BacktestButton
      // via wfoRequestSignal (its walk-forward branch consumes it). The request
      // range is holdout-clamped by BacktestButton itself, exactly as for a
      // sweep, so no extra clamp is needed here. Risk axes mirror the same way
      // the sweep branch mirrors them.
      try {
        const { payload } = buildWalkForwardPayload(mirrorRiskAxes(activeSweepAxes), wfoCfg);
        setWfoError(null);
        setWfoArchiveOpen(null);
        setWfoSchemeIndex(0); // a fresh run starts on the primary scheme, not a stale pick
        wfoRequestSignal.set(payload);
        sweepCombosOverrideSignal.set(null);
        run();
      } catch (e) {
        setWfoError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (btMode !== "sweep") {
      // Backtest mode: always a single run. Publish an empty axis set even
      // when axes are configured — the mode gates the run, so BacktestButton
      // must take its single-run path.
      sweepAxesSignal.set([]);
      sweepCombosOverrideSignal.set(null);
      run();
      return;
    }
    if (activeSweepAxes.length === 0) return; // button is disabled; belt and braces
    // A fresh sweep replaces the on-screen results, so any reopened-archive
    // selection is now stale — clear it so the picker doesn't mislabel the run.
    setPickedSweep("");
    // Synced SL/TP: stamp risk axes with their short-side mirror so the sweep
    // moves both legs together (the axes themselves stay long-side only).
    const synced = cfg.mode === "coded" ? riskSyncOn(codedCfg) : riskSyncOn(cfg);
    const mirrored = synced ? mirrorRiskAxes(activeSweepAxes) : activeSweepAxes;
    // Period axes materialize against the range as configured RIGHT NOW, so an
    // edit between toggle and run can never sweep stale windows.
    const { fromMs, toMs } = resolveWindow(cfg, resSeconds, Date.now());
    // Holdout clamp: a reserved tail shrinks the sweepable window to the training
    // span so period (window) axes never materialize over the locked-away tail.
    const effToMs = holdout ? splitHoldout(fromMs, toMs, holdout.pct).trainToMs : toMs;
    // Re-label against the config as it runs (collision-aware across all axes),
    // so results name each axis by what it swept even if a rule is edited after.
    const finalAxes = withSweepLabels(materializePeriodAxes(mirrored, fromMs, effToMs), labelCfg());
    // "Last used" range memory: recorded at run time, keyed per context.
    recordSweepRanges(sweepCtx(), sweepAxes);
    setRanAxes(finalAxes);
    sweepAxesSignal.set(finalAxes);
    // Random search: sample N combos from the fully-materialized axes and hand
    // them to BacktestButton as a one-shot override. Grid always clears it so a
    // stale sample from a prior random run can never leak into this grid run.
    // Seed fixed at 1: same ranges + N reproduce the same sample.
    sweepCombosOverrideSignal.set(
      searchMode === "random" ? sampleCombos(finalAxes, randomN, 1) : null,
    );
    run();
  }
  // Evaluate on the reserved holdout tail: a single run over [holdoutFromMs, toMs]
  // via the one-shot holdoutEvalSignal (BacktestButton skips the training clamp
  // when it sees the flag). Every look is counted — a holdout peeked at often
  // quietly stops being out-of-sample — and the count is surfaced below.
  function evaluateHoldout() {
    if (runInFlight || !holdout) return;
    const key = sweepCtx();
    sweepAxesSignal.set([]); // force BacktestButton's single-run path
    sweepCombosOverrideSignal.set(null);
    holdoutEvalSignal.set(true);
    run();
    const peeks = recordPeek(key);
    setHoldout((h) => (h ? { ...h, peeks } : h));
  }

  // Stable SweepResults props: it's memoized, and a fresh onApply/onRefine
  // closure or progress object here would re-render the whole (large) results
  // tree on every keystroke in this modal.
  const applySweepComboStable = useStableCallback(applySweepCombo);
  const refineSweepAxes = useCallback(
    (combo: Record<string, number | boolean | string>) =>
      setSweepAxes((axes) => refineAxesAround(axes, combo as SweepCombo)),
    [],
  );
  const sweepProgress = useMemo(
    () =>
      sweepState?.running
        ? {
            done: sweepState.done,
            total: sweepState.total,
            etaSeconds: sweepState.etaSeconds,
            startedAt: sweepState.startedAt,
          }
        : null,
    [sweepState],
  );

  // One results instance, rendered either in the stacked region or the docked
  // column. Follows the active Backtest|Sweep mode; nothing is duplicated.
  const resultsBody = (
    <>
      {stageLabel(stage) && (
        <div className="sweep-progress"><span>{stageLabel(stage)}</span></div>
      )}
      {/* codedRun only steers tooltip copy (the Baselines tip gains a Built-in
          caveat line). BacktestResult carries no coded marker to derive it from,
          and BacktestButton doesn't render the panel, so it reads the live
          strategy mode here rather than travelling with the result. */}
      {btMode === "backtest" && <BacktestPanel codedRun={cfg.mode === "coded"} />}
      {/* Kept mounted whenever results exist, hidden with CSS when the mode
          isn't sweep: flipping Backtest↔Sweep would otherwise unmount and
          remount this whole tree, re-running the full derived cascade (plateau,
          sort, best-per-column, heatmap index) over every row and re-mounting
          the Tooltip-heavy DOM in one blocking commit — the large-sweep freeze.
          A display toggle keeps the memoized state and DOM alive, so the switch
          is instant. */}
      {sweepState ? (
        <div className="sweep-panel" style={btMode === "sweep" ? undefined : { display: "none" }}>
          {sweepState.cancelled ? (
            <div className="al-note">Cancelled, kept {sweepState.done} of {sweepState.total}</div>
          ) : sweepState.error ? (
            <div className="al-note bt-param-error">{sweepState.error}</div>
          ) : null}
          <SweepResults
            rows={sweepState.rows}
            axes={ranAxes.length ? ranAxes : sweepAxes}
            onApply={applySweepComboStable}
            onRefine={refineSweepAxes}
            progress={sweepProgress}
          />
        </div>
      ) : (
        btMode === "sweep" && (
          <div className="bt-results-empty">
            No sweep results yet. Turn on the sweep toggle next to the fields you want to
            vary, then press Run sweep.
          </div>
        )
      )}
      {/* Walk-forward results. A reopened archive takes priority; otherwise the
          live/last run's keep-mounted panel (same display toggle as the sweep
          panel above, so flipping modes never re-runs the results tree); with no
          run at all, the archive ranking list fills the area. */}
      {wfoArchiveState ? (
        <div className="wfo-panel" style={btMode === "walkforward" ? undefined : { display: "none" }}>
          <WfoResults
            state={wfoArchiveState}
            archiveId={wfoArchiveOpen!.id}
            onBackToArchive={() => setWfoArchiveOpen(null)}
            onApplyCombo={applySweepComboStable}
            onLoadFoldTable={loadWfoArchiveFoldTable}
            // Archived results carry their axes (see the `ui` field on WfoAxis),
            // so fold tables label combos like sweep results; see wfoArchiveAxes
            // for the pre-field fallback.
            axes={wfoArchiveAxes}
            schemeIndex={wfoSchemeIndex}
            onSchemeIndex={setWfoSchemeIndex}
          />
        </div>
      ) : wfoState ? (
        <div className="wfo-panel" style={btMode === "walkforward" ? undefined : { display: "none" }}>
          {wfoState.cancelled ? (
            <div className="al-note">Cancelled after {wfoState.done} of {wfoState.total}</div>
          ) : wfoState.error ? (
            <div className="al-note bt-param-error">{wfoState.error}</div>
          ) : null}
          <WfoResults
            state={wfoState}
            onApplyCombo={applySweepComboStable}
            onLoadFoldTable={loadWfoFoldTable}
            axes={wfoLiveAxes}
            schemeIndex={wfoSchemeIndex}
            onSchemeIndex={(i) => {
              setWfoSchemeIndex(i);
              // Re-render this scheme's stitched OOS equity + fold bands on the
              // chart (BacktestButton owns the chart handle + last WFO result).
              wfoRenderRequest.set({ schemeIndex: i });
            }}
          />
        </div>
      ) : (
        btMode === "walkforward" && (
          <div className="wfo-panel">
            <WfoArchive epic={epic} onOpen={openWfoArchive} />
          </div>
        )
      )}
    </>
  );

  // The Backtest | Sweep | Walk-fwd switch leads the panel's header line,
  // standing in for a static panel name. It gates what the whole panel
  // configures (not just the results view), so it sits above the section tabs
  // rather than among them — two tab systems sharing the nav row could show
  // two "active tabs" at once (e.g. Presets + Walk-fwd).
  const modeSeg = (
    <ModeSeg
      mode={btMode}
      onSelectMode={selectMode}
      modeBadge={sweepState?.running ? (
        <span className="bt-mode-badge">{sweepState.done}/{sweepState.total}</span>
      ) : btMode === "backtest" && activeSweepAxes.length > 0 && isFinite(sweepCombos) ? (
        <span className="bt-mode-badge">{sweepCombos}</span>
      ) : null}
      wfoBadge={wfoState?.running ? (
        // Progress only — the phase name would push the seg past the tab bar's
        // right edge on a narrow panel. WfoResults spells the phase out.
        <span className="bt-mode-badge">{wfoState.done}/{wfoState.total}</span>
      ) : wfoComboTotal > 0 ? (
        <span className="bt-mode-badge">{wfoComboTotal}x{wfoCfg.trainSpans.length}</span>
      ) : null}
    />
  );

  // The Cancel-sweep/Clear-results lead and the Run button normally sit in the
  // panel footer, but move to the docked column's own footer when it is open —
  // the sweep info (counters, Search/Compute toggles) stays behind in the
  // panel. Built once here because either footer may render them.
  const runClusterLead =
    btMode === "sweep" && sweepState ? (
      sweepState.running ? (
        <button className="ghost" onClick={() => requestSweepCancel(true)}>
          Cancel sweep
        </button>
      ) : (
        <button className="ghost" onClick={clearSweepResults}>
          Clear results
        </button>
      )
    ) : btMode === "walkforward" && wfoState ? (
      wfoState.running ? (
        <button className="ghost" onClick={() => requestWfoCancel(true)}>
          Cancel walk-forward
        </button>
      ) : (
        <button className="ghost" onClick={() => wfoStateSignal.set(null)}>
          Clear results
        </button>
      )
    ) : btMode === "backtest" && runInFlight && !sweepState?.running && !wfoState?.running ? (
      // Single runs have no resumable server job, so unlike the sweep/WFO
      // cancels there is no detach variant: cancel always aborts the fetch
      // AND stops the server engine (BacktestButton owns both).
      <button className="ghost" onClick={requestBacktestCancel}>
        Cancel backtest
      </button>
    ) : btMode === "backtest" && !runInFlight && hasBtResult ? (
      // Same job as the results pane's ✕, reachable without a summary row: the
      // teardown lives in BacktestButton (it owns the chart), reached through
      // the same clear-request signal.
      <button className="ghost" onClick={requestBacktestClear}>
        Clear results
      </button>
    ) : null;
  // Last completed run's wall-clock duration (session-only, final number only —
  // hidden while a run is in flight). Per mode so a backtest never shows the
  // sweep's time or vice versa. Built once: it renders in whichever footer
  // holds the Run button — the docked column's when open, else the panel's.
  const [durationMs, durationBusy] = btMode === "backtest"
    ? [btDurationMs, runInFlight]
    : btMode === "walkforward"
    ? [wfoDurationMs, !!wfoState?.running]
    : [sweepDurationMs, !!sweepState?.running];
  const durationInfo = durationMs != null && !durationBusy ? (
    <span className="sweep-counter bt-run-duration">Took {fmtRunDuration(durationMs)}</span>
  ) : null;
  // Compact past-sweeps reopen picker: a bare dropdown + delete icon, shown in
  // the sweep footer only when there is archived history to reopen. No label or
  // placeholder text — the dropdown is self-evident and stays narrow.
  const pastSweepsPicker = btMode === "sweep" && pastSweeps.length > 0 ? (
    <PastSweepsMenu
      sweeps={pastSweeps}
      disabled={sweepState?.running}
      onReopen={(id) => {
        setPickedSweep(id);
        reopenSweep(id, true);
      }}
      onDelete={removePastSweep}
    />
  ) : null;
  const runLabel = runInFlight
    ? "Running…"
    : btMode === "walkforward"
      ? "Run walk-forward"
      : btMode === "sweep"
        ? "Run sweep"
        : "Run backtest";
  const runDisabled =
    !!runBlocked ||
    runInFlight ||
    (btMode === "sweep" && activeSweepAxes.length === 0) ||
    (btMode === "walkforward" &&
      (wfoComboTotal === 0 || wfoCfg.trainSpans.length === 0 || !!wfoState?.running));

  const tree = (
    <>
    <div className={pinned ? "bt-dock" : `bt-overlay${hidden ? " bt-hidden" : ""}`}>
    {sideBySide && (
      <aside className={`bt-results-col bt-mode-${btMode}`} style={{ width: resultsColWidth }}>
        <div
          className="bt-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize results column"
          onPointerDown={onResultsColResizeStart}
          onDoubleClick={resetResultsColWidth}
        />
        <div className="bt-cfg-head">
          {/* Dock-back sits at the header's far LEFT (away from the config
              panel) and points right, toward the panel the results return to. */}
          <span className="bt-results-head-left">
            <Tooltip content="Dock results back into the panel">
              <button
                className="bt-results-layout-btn"
                aria-label="Dock results back into the panel"
                onClick={() => setResultsSideBySide(false)}
              >
                <ColumnGlyph flipped />
              </button>
            </Tooltip>
            <span className="bt-cfg-title">Results</span>
          </span>
        </div>
        <div className="bt-results-col-body">{resultsBody}</div>
        <div className="modal-foot bt-cfg-foot">
          <RunBar
            sweepInfo={durationInfo}
            runClusterLead={runClusterLead}
            runLabel={runLabel}
            runDisabled={runDisabled}
            runDisabledReason={runBlocked}
            onRun={runFromFooter}
          />
        </div>
      </aside>
    )}
    <aside className={`bt-cfg-panel bt-mode-${btMode}`} style={{ width: panelWidth }}>
        <div
          className="bt-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize backtest panel"
          onPointerDown={onResizeStart}
          onDoubleClick={resetPanelWidth}
        />
        <div className="bt-cfg-head">
          <span className="bt-cfg-title">
            {modeSeg} — <strong>{epic}</strong> <span className="bt-cfg-res">{effectiveRes}</span>
          </span>
          <span className="bt-cfg-head-actions">
            <Tooltip
              content={
                pinned
                  ? "Unpin: overlay the chart and hide on chart click"
                  : "Pin: dock beside the chart (chart shrinks)"
              }
            >
              <button
                className={`bt-pin-btn${pinned ? " on" : ""}`}
                aria-label={pinned ? "Unpin panel" : "Pin panel"}
                onClick={() => setPinned(!pinned)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                  {/* Material Symbols push_pin (filled / outlined by state). */}
                  <path
                    fill="currentColor"
                    d={pinned
                      ? "M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"
                      : "M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"}
                  />
                </svg>
              </button>
            </Tooltip>
            <CloseButton onClick={onClose} />
          </span>
        </div>

        <div className="bt-panel-body">
          {/* Presets sits last, after the scroll anchors, because it is the one
              tab that swaps the body out rather than scrolling within it. */}
          <nav className="bt-htabs">
            {[
              ...SCROLL_TABS.filter((t) => t.value !== "results" || !sideBySide),
              PRESETS_TAB,
            ].map((t) => (
              <button
                key={t.value}
                className={tab === t.value ? "on" : ""}
                onClick={() => jumpToTab(t.value)}
              >
                {t.label}
                <TipIcon text={t.tip} />
              </button>
            ))}
          </nav>
        {/* Hidden rather than unmounted: the section refs the scrollspy and the
            tab jumps depend on must survive a trip through Presets. */}
        <div className="bt-settings-region" hidden={tab === "presets"}>
          <div className="bt-body" ref={bodyRef} onScroll={onBodyScroll}>
            <section className="bt-scroll-section" ref={setRef("period")}>
                <PeriodSection
                  cfg={cfg}
                  setCfg={setCfg}
                  setRange={setRange}
                  setMask={setMask}
                  btMode={btMode}
                  controller={controller}
                  chartTimezone={chartTimezone}
                  resolution={resolution}
                  resSeconds={resSeconds}
                  pickingRange={pickingRange}
                  pickBlocked={pickBlocked}
                  holdout={holdout}
                  changeHoldoutPct={changeHoldoutPct}
                  runInFlight={runInFlight}
                  evaluateHoldout={evaluateHoldout}
                  wfoCfg={wfoCfg}
                  changeWfoCfg={changeWfoCfg}
                  wfoDroppedAxes={wfoDroppedAxes}
                  periodAxis={periodAxis}
                  togglePeriodSweepAxis={togglePeriodSweepAxis}
                  setPeriodN={setPeriodN}
                />
                <ActiveWindowsSection
                  cfg={cfg}
                  setMask={setMask}
                  btMode={btMode}
                  resSeconds={resSeconds}
                  chartTimezone={chartTimezone}
                  timeWindowAxis={timeWindowAxis}
                  toggleTimeWindowSweepAxis={toggleTimeWindowSweepAxis}
                  addTimeWindowOption={addTimeWindowOption}
                  addSessionWindowOption={addSessionWindowOption}
                  removeTimeWindowOption={removeTimeWindowOption}
                  twOption={twOption}
                />
                <HistoryDepthSection cfg={cfg} setRange={setRange} effectiveRes={effectiveRes} controller={controller} />
            </section>

            <section className="bt-scroll-section" ref={setRef("strategy")}>
              <StrategySection
                cfg={cfg}
                setCfg={setCfg}
                side={side}
                selectSide={selectSide}
                sideEnabled={sideEnabled}
                codedCfg={codedCfg}
                updateCoded={updateCoded}
                strategyList={strategyList}
                strategyListError={strategyListError}
                reloadStrategies={reloadStrategies}
                selectedStrategy={selectedStrategy}
                paramError={paramError}
                setSweepAxes={setSweepAxes}
                displayAxes={displayAxes}
                sweepEditable={sweepEditable}
                toggleSweepAxis={toggleSweepAxis}
                toggleRiskSweepAxis={toggleRiskSweepAxis}
                toggleRangeSweepAxis={toggleRangeSweepAxis}
                patchAxis={patchAxis}
                setGroup={setGroup}
                defaultAvwapAnchor={defaultAvwapAnchor}
                effectiveRes={effectiveRes}
                copyRules={copyRules}
                pasteRules={pasteRules}
                exprPick={exprPick}
                exprInstances={exprInstances}
              />
            </section>

            <section className="bt-scroll-section" ref={setRef("costs")}>
              <CostsSection
                cfg={cfg}
                setCfg={setCfg}
                setCosts={setCosts}
                setInstrumentCost={setInstrumentCost}
                refetchCosts={refetchCosts}
                costProfile={costProfile}
              />
            </section>

            {/* Results: the pane's last section, so scrolling past Costs runs
                straight into them. Sized to fill the pane (see .bt-results-region)
                so landing here gives the whole height, not a strip. */}
            {!sideBySide && (
              <section className="bt-scroll-section bt-results-region" ref={setRef("results")}>
                {resultsBody}
              </section>
            )}
          </div>
        </div>

        {/* Presets: its own pane, not a section of the scroll above. It lists
            OTHER saved configurations rather than any part of the one being
            edited, so scrolling out of the settings and into it by accident
            would be a category error. Kept mounted so the library does not
            refetch and lose its sort/filter on every visit. */}
        <div className="bt-presets-region" hidden={tab !== "presets"}>
          <PresetsPane
            cfg={cfg}
            setCfg={setCfg}
            setCodedCfg={setCodedCfg}
            side={side}
            activePreset={activePreset}
            setActivePreset={setActivePreset}
            epic={epic}
            effectiveRes={effectiveRes}
            btMode={btMode}
            controller={controller}
            resolution={resolution}
            brokerId={brokerId}
          />
        </div>
        </div>

        {/* Presets swaps the body out for its library, which has its own
            actions (Save/Go live) — a mode-bound Run button and sweep hints
            down here would act on something the pane isn't showing. */}
        {tab !== "presets" && (
        <div className="modal-foot bt-cfg-foot">
          <RunBar
            lead={
              <Tooltip content={sideBySide ? "Dock results back into the panel" : "Show results in a side column"}>
                <button
                  className="bt-results-layout-btn"
                  aria-label={sideBySide ? "Dock results back into the panel" : "Show results in a side column"}
                  onClick={() => setResultsSideBySide(!sideBySide)}
                >
                  <ColumnGlyph flipped={sideBySide} />
                </button>
              </Tooltip>
            }
            sweepInfo={<>
              {holdout && (
                <span className="sweep-counter bt-holdout-badge">
                  Holdout: last {holdout.pct}% reserved
                </span>
              )}
              {btMode === "sweep" && activeSweepAxes.length === 0 && (
                <span className="sweep-counter">Turn on a field's sweep toggle to run</span>
              )}
              {btMode === "walkforward" && activeSweepAxes.length === 0 && (
                <span className="sweep-counter">Turn on a field's sweep toggle to define the grid</span>
              )}
              {btMode === "walkforward" && wfoError && (
                <span className="sweep-counter bt-param-error">{wfoError}</span>
              )}
              {/* No per-axis breakdown or "runs sampled" counter here: the
                  footer shows ONLY the total combo count (user decision). */}
              {btMode === "sweep" && activeSweepAxes.length > 0 && (
                <span className={`bt-sweep-estimate${effectiveWarn ? " bt-sweep-warn" : ""}`}>
                  {/* The number carries the weight; the unit stays quiet. The
                      space keeps textContent reading "275 combos". */}
                  <strong>{isFinite(effectiveCombos) ? effectiveCombos : "∞"}</strong>{" "}
                  {effectiveCombos === 1 ? "combo" : "combos"}
                </span>
              )}
              {btMode === "walkforward" && wfoComboTotal > 0 && (
                <span className="bt-sweep-estimate">
                  <strong>{wfoComboTotal}</strong> {wfoComboTotal === 1 ? "combo" : "combos"} x{" "}
                  {wfoCfg.trainSpans.length} {wfoCfg.trainSpans.length === 1 ? "scheme" : "schemes"}
                  <InfoTip
                    text={[
                      "The size of the run. Combos are every combination of the swept parameter values, each scored per fold.",
                      "A scheme is one train/test schedule; selecting several train spans runs one scheme per span.",
                    ]}
                  />
                </span>
              )}
              {/* Duration follows the Run button: the docked column's footer
                  shows it while the column is open, so skip it here then. */}
              {!sideBySide && durationInfo}
              {pastSweepsPicker}
              {btMode === "sweep" && activeSweepAxes.length > 0 && (
                <span className="bt-search-toggle">
                  <Tooltip content={[
                    "Grid: run every combination of the ranges.",
                    "Random: sample N combos (same ranges + N draw the same sample).",
                  ]}>
                    <select
                      className="bt-search-select"
                      aria-label="Search strategy"
                      value={searchMode}
                      onChange={(e) => setSearchMode(e.currentTarget.value as "grid" | "random")}
                    >
                      <option value="grid">Grid</option>
                      <option value="random">Random</option>
                    </select>
                  </Tooltip>
                  {searchMode === "random" && (
                    <label className="bt-random-n">
                      <span>N</span>
                      <input
                        type="number"
                        min={10}
                        value={randomN}
                        onKeyDown={blockNegKeys}
                        onChange={(e) => setRandomN(Number(cleanNumInput(e.currentTarget)))}
                        onBlur={(e) => clampPosOnBlur(e.currentTarget, 10, setRandomN)}
                      />
                    </label>
                  )}
                </span>
              )}
              {(btMode === "sweep" || btMode === "walkforward") && activeSweepAxes.length > 0 && remoteCompute && (
                <span className="bt-compute-toggle">
                  <Tooltip content={[
                    "Local: run the job on this machine.",
                    "Remote: run the job on the remote compute host.",
                  ]}>
                    <select
                      className="bt-search-select"
                      aria-label="Compute target"
                      value={sweepTarget}
                      onChange={(e) => {
                        const t = e.currentTarget.value as "local" | "remote";
                        sweepTargetSignal.set(t);
                        saveSweepTarget(t);
                      }}
                    >
                      <option value="local">Local</option>
                      <option value="remote">Remote</option>
                    </select>
                  </Tooltip>
                  {/* Host status + Start/Stop live in the toolbar's ComputeHostButton
                      now (single manual control); no chip here. */}
                </span>
              )}
            </>}
            runClusterLead={sideBySide ? null : runClusterLead}
            runLabel={runLabel}
            runDisabled={runDisabled}
            runDisabledReason={runBlocked}
            onRun={sideBySide ? undefined : runFromFooter}
          />
        </div>
        )}
    </aside>
    </div>
    {!pinned && hidden && (
      <button
        className="bt-peek"
        aria-label="Show backtest panel"
        onClick={() => backtestPanelHiddenSignal.set(false)}
      >
        ◂ Backtest
      </button>
    )}
    </>
  );
  // Falls back to rendering in place when there is no chart area to portal
  // into (no App shell around us — tests, or a mount that races the chart):
  // wrong anchor beats an invisible panel.
  return pinned || !chartHost ? tree : createPortal(tree, chartHost);
}
