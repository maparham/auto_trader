// The Backtest control, lifted out of the toolbar into the top tab bar. Runs the
// user's rule-built strategy (⚙ opens the settings modal) on the focused cell's
// chart and overlays markers + equity; the summary chip (pnl / trades / win%)
// sits to its right. Self-contained: it owns its own run state and only needs
// the focused controller + the active period/broker.

import { useEffect, useState } from "react";
import {
  runAndRender,
  clearBacktest,
  fitBacktestTrades,
  coverBacktestHistory,
  oldestBacktestAnchorMs,
  renderWfoArtifacts,
} from "./lib/backtest";
import type { ChartController } from "./lib/chartController";
import Tooltip from "./components/Tooltip";
import { fetchRange, RESOLUTION_SECONDS, type Period } from "./lib/feed";
import type { PriceSide } from "./theme";
import { defaultBacktestConfig, type BacktestConfig, type RuleGroup } from "./lib/backtestConfig";
import { resolveMask } from "./lib/backtestSchedule";
import { loadCodedCfg, resolveParamValues, sendableRisk } from "./lib/codedConfig";
import { fetchStrategies, saveSweepArchive } from "./api";
import {
  resolveWindow,
  resolveHistoryStart,
  minimalHistoryStart,
  requiredWarmupBars,
  warmupBarCount,
  widenUntilWarm,
  warmupWalkFloor,
} from "./lib/backtestWindow";
import {
  loadBacktestLastUsed,
  saveBacktestLastUsed,
  loadBacktestPeriodsShown,
  loadBacktestMarkersShown,
  loadBacktestEquityShown,
  saveSweepResultId,
} from "./lib/persist";
import {
  openBacktestSettings,
  backtestRunRequest,
  backtestClearRequest,
  backtestResultSignal,
  backtestRunCompletedSignal,
  backtestMessagesSignal,
  backtestPeriodsShownSignal,
  backtestMarkersShownSignal,
  backtestEquityShownSignal,
  backtestRunningSignal,
  progressStageSignal,
  backtestDurationSignal,
  sweepDurationSignal,
  sweepAxesSignal,
  sweepStateSignal,
  sweepCancelRequest,
  sweepCancelServer,
  sweepTargetSignal,
  computeHostStateSignal,
  holdoutEvalSignal,
  sweepCombosOverrideSignal,
  sweepArchivedSignal,
  highlightTradeSignal,
  selectedTradeSignal,
  wfoRequestSignal,
  wfoStateSignal,
  wfoCancelRequest,
  wfoCancelServer,
  wfoRenderRequest,
  wfoDurationSignal,
} from "./lib/signals";
import { robustWindowBounds, runSweep, sweepCatchState } from "./lib/sweep";
import { runWalkForward, stopResumedWfo, wfoCatchState } from "./lib/wfo";
import { toast } from "./lib/notify";
import { sweepContext } from "./lib/sweepMemory";
import { loadHoldout, splitHoldout } from "./lib/holdout";
import { stopResumedSweep } from "./lib/sweepResume";
import type { BacktestRequest, ExprBacktestRequest, ExprRow, SweepRow } from "./api";
import { collectExprInstances, exprInstancesFor, exprWarmupByRef } from "./lib/exprInstances";
import { liveExprInstances } from "./lib/indicators";

interface Props {
  controller: ChartController | null;
  period?: Period;
  // Symbol epic — only used to reset the readout when the instrument changes.
  epic?: string;
  brokerId: string;
  // The chart's active price side. The backtest MUST fetch the same side the
  // chart shows: the cache is populated per side, and a mismatch (e.g. fetching
  // "mid" while the chart shows "bid") silently backtests a different, often
  // far shorter, candle series than the one on screen.
  priceSide: PriceSide;
}

export default function BacktestButton({ controller, period, epic, brokerId, priceSide }: Props) {
  const chart = controller?.chart ?? null;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The transient run error belongs to a specific run; drop it when the symbol or
  // timeframe changes. Reset during render on the key change (React's "adjust
  // state on prop change" pattern) rather than in an effect. The result itself is
  // now persisted and rehydrated by ChartCore, so it is NOT cleared here anymore.
  const runKey = `${epic ?? ""}|${period?.resolution ?? ""}`;
  const [msgKey, setMsgKey] = useState(runKey);
  if (msgKey !== runKey) {
    setMsgKey(runKey);
    setError(null);
  }

  // Publish the transient error so the results pane renders it (it no longer
  // lives next to this toolbar button).
  useEffect(() => {
    backtestMessagesSignal.set({ error });
  }, [error]);

  // The results pane's clear (✕) asks for a clear through this signal; the
  // teardown lives here because only this component has the chart/controller.
  useEffect(() => backtestClearRequest.subscribe(() => clear()));

  // The panel's "Run backtest" saves the config as last-used then bumps this
  // signal, which runs the backtest here (run() always reads the latest
  // last-used config, so no config needs to be threaded through). The toolbar
  // button only opens the panel — running lives with the config.
  useEffect(() => backtestRunRequest.subscribe(() => void run()));

  // Modal scheme picker -> chart: re-render the requested scheme's stitched OOS
  // equity + fold bands from the stored last WFO result. No deps (like the
  // subscribes above) so it re-binds each render, capturing the current chart.
  useEffect(() =>
    wfoRenderRequest.subscribe(() => {
      const req = wfoRenderRequest.value;
      if (!req) return;
      // Render off the LIVE published result — a direct run, a resume, and a
      // reopen all set wfoStateSignal.value.result. A ref that only the direct-run
      // path writes would leave the scheme picker stale (or empty) on resumed runs.
      const scheme = wfoStateSignal.value?.result?.schemes[req.schemeIndex];
      if (chart && scheme) renderWfoArtifacts(chart, scheme);
    }),
  );

  // Seed the on-chart display toggles from device-local storage once at startup
  // (the component is mounted for the whole app session).
  useEffect(() => {
    backtestPeriodsShownSignal.set(loadBacktestPeriodsShown());
    backtestMarkersShownSignal.set(loadBacktestMarkersShown());
    backtestEquityShownSignal.set(loadBacktestEquityShown());
  }, []);

  async function run() {
    // Holdout ("lockbox") one-shot: consume the evaluate flag at the VERY top,
    // before the guard below can early-return. If a stranded flag survived a
    // no-op run, the next NORMAL run would silently evaluate on the reserved
    // tail — contaminating the out-of-sample guarantee this feature protects.
    // Consuming it on a no-op run is harmless (the user just re-clicks).
    const evaluatingHoldout = holdoutEvalSignal.value;
    holdoutEvalSignal.set(false);
    if (!chart || !epic || !period || running) return;
    setRunning(true);
    // Wall-clock start for the footer's "Took Ns" readout. Captured before any
    // fetching so the displayed duration covers the whole run, not just the
    // engine call.
    const runStart = performance.now();
    // Published imperatively (not via an effect on `running`) so the settings
    // modal's disabled "Run backtest" can never strand: the finally below always
    // resets it, even if this component were unmounted mid-run.
    backtestRunningSignal.set(true);
    setError(null);
    // Captured once up front: the modal publishes the axes (empty in Backtest
    // mode) right before bumping the run request, and nothing may change them
    // mid-run (run() no-ops while running).
    const sweepAxes = sweepAxesSignal.value;
    // Random-search one-shot override: captured + cleared up front (like the
    // holdout flag) so a stale sample can never leak into the next grid sweep.
    const sweepCombosOverride = sweepCombosOverrideSignal.value;
    sweepCombosOverrideSignal.set(null);
    // Walk-forward one-shot request: captured + cleared up front (like the
    // holdout flag and sweep override above) so a run that bails in prepare
    // (no candles in range, a thrown fetch/schema error) can't leave the
    // payload armed — the next plain backtest/sweep would silently execute a
    // walk-forward. The walkforward branch below uses this captured value.
    const wfoRequest = wfoRequestSignal.value;
    wfoRequestSignal.set(null);
    // Single run: drop the previous result from the pane right away — when two
    // runs produce identical numbers, a pane that never visibly changes reads
    // as "the click did nothing". Emptying it (the pane shows its running
    // state) makes every run observable. Chart artifacts are torn down later
    // by runAndRender, once the fresh result is in hand. A sweep leaves the
    // last single-run result alone: it streams into sweepStateSignal, and the
    // modal's mode switch flips between the two coexisting result sets.
    // Selection/highlight indexes belong to the result being dropped — clear
    // them here too. teardownArtifacts' own reset is owner-gated on
    // backtestResultSignal still holding the old result, which this null-set
    // defeats, so without this a re-run inherits the previous run's selected
    // trade index against the NEW trade list.
    if (sweepAxes.length === 0) {
      backtestResultSignal.set(null);
      highlightTradeSignal.set(null);
      selectedTradeSignal.set(null);
      // Only a successful finish writes a duration; a failed run shows none.
      backtestDurationSignal.set(null);
    }
    try {
      const cfg = loadBacktestLastUsed() ?? defaultBacktestConfig();
      const coded = cfg.mode === "coded";
      if (coded && !cfg.codedStrategy) {
        setError("no coded strategy selected: pick one in the backtest panel");
        return;
      }
      // The main rule groups edit as expressions. Sweeps run on the expr engine
      // (/api/expr/sweep/jobs), holdout evaluation runs the expr backtest over the
      // reserved tail window, and walk-forward routes to the expr engine
      // (/api/expr/walkforward/jobs) via exprReq below. Coded runs keep their
      // structured path throughout.
      // Coded mode: the panel's per-file config (params + risk + exit rules,
      // Task 8) drives the run — entries stay empty (the .py file opens
      // positions itself). This "effective cfg" trick (natives/ATR computed
      // server-side) other tasks reuse, so no other machinery needs to know
      // coded mode exists.
      const EMPTY_GROUP: RuleGroup = { combine: "AND", rules: [] };
      const codedCfg = coded ? loadCodedCfg("backtest", cfg.codedStrategy!) : null;
      const effCfg: BacktestConfig = coded
        ? {
            ...cfg,
            longEntry: EMPTY_GROUP,
            shortEntry: EMPTY_GROUP,
            longExit: codedCfg!.longExit,
            shortExit: codedCfg!.shortExit,
            longRisk: codedCfg!.longRisk,
            shortRisk: codedCfg!.shortRisk,
            longScaling: undefined,
            shortScaling: undefined,
          }
        : cfg;
      // The strategy's declared params schema, so panel-tuned values are
      // clamped/defaulted the same way the Parameters section shows them. A
      // stale schema (file edited since the values were saved) is harmless —
      // the backend re-validates codedParams itself. A FAILED fetch must abort
      // the run (via the catch below), not resolve against an empty schema:
      // that would silently drop every tuned value and run on file defaults.
      const codedParams = coded
        ? resolveParamValues((await fetchStrategies()).find((s) => s.filename === cfg.codedStrategy)?.params ?? [], codedCfg!.params)
        : undefined;
      // The config timeframe overrides the active chart timeframe when set;
      // absent means follow the chart (the historical behavior).
      const runResolution = cfg.range.resolution ?? period.resolution;
      const resSeconds = RESOLUTION_SECONDS[runResolution] ?? 60;
      const now = Date.now();
      const resolved = resolveWindow(cfg, resSeconds, now);
      let windowFromMs = resolved.fromMs;
      let windowToMs = resolved.toMs;
      // Holdout ("lockbox"): reserve the tail pct of the configured range. A
      // normal run or sweep clamps its `to` bound to the training span so the
      // reserved tail is never touched; the explicit Evaluate action instead
      // runs over the reserved tail only. Keyed per strategy context (rules /
      // coded file), identical to sweep memory.
      const holdoutPct = loadHoldout(sweepContext(cfg.mode, cfg.codedStrategy))?.pct ?? null;
      if (holdoutPct) {
        const { trainToMs } = splitHoldout(windowFromMs, windowToMs, holdoutPct);
        if (evaluatingHoldout) {
          // Invariant: evaluation must start strictly after the training span's
          // last tradable second. splitHoldout returns holdoutFromMs === trainToMs
          // (the shared cut), and training trades every bar <= floor(cut/1000)
          // inclusive. Starting the holdout one whole second past that upper
          // second prevents a bar sitting exactly on the boundary from trading in
          // both spans (a one-bar leak of training data into out-of-sample).
          windowFromMs = (Math.floor(trainToMs / 1000) + 1) * 1000;
        } else windowToMs = trainToMs;
      }
      const toSec = Math.floor(windowToMs / 1000);
      const fetchBars = (fromMs: number) =>
        fetchRange(epic, runResolution, Math.floor(Math.max(0, fromMs) / 1000), toSec, priceSide, brokerId);

      // The chart's live panes, read ONCE: a row saying `SLOPE.9 > 0.5`
      // names an output and restates none of the pane's settings, so the pane is
      // the only place both the run's WARM-UP DEPTH (warmupRefs, used by every
      // sizing call below) and the request's `indicators` map (exprIndicators,
      // built further down from this same list) can come from. Read before
      // sizing, not at request-build time, or the history ask would charge a
      // referenced pane zero bars and the run would trade an unwarmed series.
      const live = chart ? liveExprInstances(chart) : [];
      const warmupRefs = {
        instances: exprInstancesFor(live),
        warmupByRef: exprWarmupByRef(live),
      };
      // Warm-up/history depth must size against the config the run actually
      // executes (effCfg): in coded mode that's the file's panel exit rules +
      // risk, not the dormant rules-mode groups sitting in cfg.
      const required = requiredWarmupBars(effCfg, resSeconds, warmupRefs);
      const depth = cfg.range.history ?? "minimal";
      // Temporary phase timing (perf investigation) — logged as [backtest perf].
      const tFetch0 = performance.now();
      progressStageSignal.set("downloading");
      let historyFromMs = resolveHistoryStart(effCfg, windowFromMs, resSeconds, warmupRefs);
      let bars = await fetchBars(historyFromMs);

      // The requested depth can exceed what the broker/account actually serves
      // (e.g. "Full" asking further back than a live account's history limit) —
      // that can come back either completely empty OR a non-empty but too-short
      // history (a broker rejecting only the oldest chunk, or the cache serving
      // whatever it already had). Either way, retry once at the minimal depth
      // (the smallest, most likely-to-succeed ask) rather than only checking for
      // the empty case.
      if (depth !== "minimal" && (bars.length === 0 || warmupBarCount(bars, windowFromMs) < required)) {
        const minimalFromMs = minimalHistoryStart(effCfg, windowFromMs, resSeconds, warmupRefs);
        const retried = await fetchBars(minimalFromMs);
        if (warmupBarCount(retried, windowFromMs) > warmupBarCount(bars, windowFromMs)) {
          bars = retried;
          historyFromMs = minimalFromMs;
        }
      }

      // An indicator's warm-up is a mathematical requirement of the indicator —
      // it isn't bounded by the user's range or by session hours. The asks above
      // are calendar-time conversions of a bar count, so one landing inside a
      // weekend/holiday closure comes back short (see widenedHistoryStart).
      bars = await widenUntilWarm(
        bars,
        historyFromMs,
        {
          windowFromMs,
          resSeconds,
          required,
          floorMs: warmupWalkFloor(effCfg, windowFromMs, resSeconds, warmupRefs),
        },
        fetchBars,
      );

      const tradeFromTime = Math.round(windowFromMs / 1000);
      if (!bars.some((k) => Math.round(k.timestamp / 1000) >= tradeFromTime)) {
        setError("no candles in the selected range");
        return;
      }

      // Insufficient warm-up is a hard failure, not a warning. An indicator seeded
      // from fewer bars than its lookback isn't a less-accurate version of itself —
      // it's a different series, and near the window start it crosses where the
      // real one doesn't. Those phantom crosses become trades, and a result that
      // silently mixes them with real ones is worse than no result: it reports a
      // P&L the strategy never had. The widening walk above already tried to get
      // the bars honestly, so reaching here means they aren't available.
      const warmup = warmupBarCount(bars, windowFromMs);
      if (warmup < required) {
        setError(
          `not enough history: ${warmup} of ${required} warm-up bars before the window. ` +
            `Indicators can't be computed correctly here — start the range later, ` +
            `raise the history depth, or shorten the longest indicator.`,
        );
        return;
      }

      // The backend recomputes every indicator/price/ATR series itself from the
      // rule expressions (and coded mode's strategy-file indicators run in
      // Python), so the browser ships no precomputed series.
      const tSeries0 = performance.now();
      const series: Record<string, Array<number | null>> = {};
      const tSeries1 = performance.now();
      const candles = bars.map((k) => ({
        time: Math.round(k.timestamp / 1000),
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume ?? 0,
      }));

      console.info(
        `[backtest perf] prepare: bars fetch ${(tSeries0 - tFetch0).toFixed(0)}ms (${bars.length} bars), ` +
          `series ${(tSeries1 - tSeries0).toFixed(0)}ms (${Object.keys(series).length} series)`,
      );
      const tRun0 = performance.now();
      // Coded exits are sent as expression rows (baseReq below) and rule-mode
      // runs post whole { expr, enabled }[] groups. Defined here so both the
      // coded baseReq and the rule-mode exprReq/sweep branch can reference it.
      const exprRows = (g: RuleGroup): ExprRow[] =>
        g.rules.map((r) => ({ expr: r.expr ?? "", enabled: r.enabled !== false }));
      // The chart panes these rows reference ("SLOPE.9"), with their LIVE
      // settings — read off the chart rather than storage so a pane retuned a
      // moment ago runs as it looks. Only referenced panes travel; a reference to
      // a pane that is gone ships nothing (the editor already flags it as
      // unknown, and inventing an entry would hide that). Both requests carry it:
      // a coded run still posts THIS panel's exit rules as expressions.
      const exprIndicators = chart
        ? collectExprInstances(
            live,
            [effCfg.longEntry, effCfg.longExit, effCfg.shortEntry, effCfg.shortExit]
              .flatMap(exprRows)
              .map((r) => r.expr),
          )
        : undefined;
      const baseReq: BacktestRequest = {
        epic,
        resolution: runResolution,
        candles,
        series,
        // Coded strategies compute indicators in Python — nothing to precompute.
        codedStrategy: coded ? cfg.codedStrategy : undefined,
        // The backend fetches higher-timeframe candles itself for BOTH coded
        // strategies (ctx.ema(tf=...)) and rule mode (a native indicator on a
        // non-base @tf, incl. sloped operands) — always over the same broker/
        // price side the chart is showing, so its cache/side matches the base
        // candles we shipped. Omitting these in rule mode made the backend fall
        // back to its "capital"/"mid" defaults and fetch the wrong series → an
        // empty HTF set → "no candles for timeframe '…'".
        broker: brokerId,
        priceSide,
        // Panel-tuned ctx.param() overrides for the coded strategy.
        codedParams,
        // Coded exits travel on exprLongExit/exprShortExit (below); the structured
        // rule groups have been removed from the backtest request.
        exprLongExit: exprRows(effCfg.longExit),
        exprShortExit: exprRows(effCfg.shortExit),
        // Coded runs post their exits as expression rows, so those rows can
        // reference a chart pane the same way rule mode does.
        indicators: exprIndicators,
        // `!== false` so a preset predating these flags (undefined) still trades.
        // Coded mode: longEnabled/shortEnabled are rules-mode UI; RuleStrategy
        // gates EXITS on them (rule.py). A coded run must never let a
        // rules-mode toggle silently disable that side's panel exit rules
        // while the .py file still opens positions on it (I1).
        longEnabled: coded ? true : cfg.longEnabled !== false,
        shortEnabled: coded ? true : cfg.shortEnabled !== false,
        // A none/none risk (RiskSection touched then reset) must be
        // indistinguishable from no panel risk at all, or the backend strips
        // the coded file's own sl=/tp= while applying no stop either (C1).
        longRisk: sendableRisk(effCfg.longRisk),
        shortRisk: sendableRisk(effCfg.shortRisk),
        longScaling: effCfg.longScaling,
        shortScaling: effCfg.shortScaling,
        costs: cfg.costs,
        tradeFromTime,
        mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
        // Always-on for single runs: the handler skips it when a sweep is set,
        // so the sweep path below pays nothing.
        costSensitivity: true,
      };

      // Task 13 Stage A: rule-mode runs go through the expression-native engine,
      // posting { expr, enabled }[] groups. This request drives BOTH the plain
      // single run (/api/expr/backtest) and the expr sweep (/api/expr/sweep/jobs)
      // below; coded runs stay on the structured baseReq.
      const exprReq: ExprBacktestRequest = {
        epic,
        resolution: runResolution,
        candles,
        // @tf rows: backend fetches HTF candles itself — over the chart's
        // broker/side, or its "capital"/"mid" defaults would fetch the wrong
        // series (same failure the coded baseReq comment above recounts).
        broker: brokerId,
        priceSide,
        longEntry: exprRows(effCfg.longEntry),
        longExit: exprRows(effCfg.longExit),
        shortEntry: exprRows(effCfg.shortEntry),
        shortExit: exprRows(effCfg.shortExit),
        longEnabled: cfg.longEnabled !== false,
        shortEnabled: cfg.shortEnabled !== false,
        longRisk: sendableRisk(effCfg.longRisk),
        shortRisk: sendableRisk(effCfg.shortRisk),
        longScaling: effCfg.longScaling,
        shortScaling: effCfg.shortScaling,
        costs: cfg.costs,
        tradeFromTime,
        mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
        // The chart panes these rows reference ("SLOPE.9"), with their LIVE
        // settings — read off the chart rather than storage so a pane retuned a
        // moment ago runs as it looks. Only referenced panes travel; a reference
        // to a pane that is gone ships nothing (the editor already flags it).
        indicators: exprIndicators,
      };

      // Walk-forward mode: the modal populated wfoRequestSignal (one-shot,
      // captured + cleared up front) and asked for this same run — submit the
      // whole grid + test schedule as one backend job via runWalkForward,
      // streaming state into wfoStateSignal for the modal's WFO results view.
      // Sibling branch BEFORE the sweep branch: a consumed request takes
      // precedence, and the two never fire together because the modal sets only one.
      if (wfoRequest) {
        const wf = wfoRequest;
        // Managed-host gate, same as the sweep branch below.
        const hostState = computeHostStateSignal.value;
        if (sweepTargetSignal.value === "remote" && (hostState === "stopped" || hostState === "booting")) {
          toast("Compute host is not ready yet. Start it from the toolbar (Host off / Start).");
          return;
        }
        // Take over from any live re-attached (resumed) poll first, so this
        // fresh submission owns the WFO state cleanly.
        stopResumedWfo();
        const ctl = new AbortController();
        const unsub = wfoCancelRequest.subscribe(() => ctl.abort());
        const wfoRunStart = performance.now();
        // Cleared up front, written only on a clean completion below — a cancelled
        // or failed walk-forward shows no duration (mirrors the sweep branch).
        wfoDurationSignal.set(null);
        wfoStateSignal.set({ phase: "grid", done: 0, total: 0, running: true, foldRows: [], result: null, startedAt: Date.now() });
        try {
          progressStageSignal.set(sweepTargetSignal.value === "remote" ? "uploading" : "submitting");
          const result = await runWalkForward(coded ? baseReq : exprReq, wf, {
            signal: ctl.signal,
            target: sweepTargetSignal.value,
            shouldCancelServer: () => wfoCancelServer.value,
            expr: !coded,
            // After an abort (modal closed / Cancel) the state may already be
            // cleared — a late-resolving poll must not resurrect a ghost run.
            // Mirrors the sweep branch's onRows guard + continueResumeWfo.
            onState: (st) => {
              if (ctl.signal.aborted) return;
              progressStageSignal.set(null);
              wfoStateSignal.set(st);
            },
          });
          // Draw the primary scheme's stitched OOS equity + fold bands on the
          // chart. Guarded: `result` is null on a backend-reported cancel, and a
          // run where every fold failed can yield zero schemes. The modal's scheme
          // picker re-renders other schemes off the published wfoStateSignal.result.
          if (result) {
            wfoDurationSignal.set(performance.now() - wfoRunStart);
            const scheme0 = result.schemes[0];
            if (chart && scheme0) renderWfoArtifacts(chart, scheme0);
          }
        } catch (e) {
          // When the modal already tore the state down (detach-close abort),
          // stay torn down instead of resurrecting a cancelled ghost — mirrors
          // the sweep branch's teardown guard below.
          if (!(ctl.signal.aborted && wfoStateSignal.value === null)) {
            wfoStateSignal.set(wfoCatchState(wfoStateSignal.value, ctl.signal.aborted, e));
          }
        } finally {
          unsub();
        }
        return;
      }

      // Sweep mode (Task 10): the modal populated sweepAxesSignal and asked for
      // this same run — chunk through runSweep instead of a single runAndRender.
      // Nothing renders on the chart; results stream into sweepStateSignal for
      // the modal's <SweepResults> to show. Clicking a result applies it, which
      // clears the axes and re-enters this function on the normal path.
      if (sweepAxes.length > 0) {
        // Managed-host gate: a remote sweep can't run while the EC2 host is
        // stopped or still booting. "unknown"/"unconfigured" submit as before
        // (plain remote hosts without lifecycle management keep working). The
        // outer finally resets `running`, so an early return here is clean.
        const hostState = computeHostStateSignal.value;
        if (sweepTargetSignal.value === "remote" && (hostState === "stopped" || hostState === "booting")) {
          toast("Compute host is not ready yet. Start it from the toolbar (Host off / Start).");
          return;
        }
        const ctl = new AbortController();
        const unsubCancel = sweepCancelRequest.subscribe(() => ctl.abort());
        // Take over from any live re-attached (resumed) poll first, so this fresh
        // submission owns the sweep state cleanly instead of racing a resumed one.
        stopResumedSweep();
        sweepStateSignal.set({ rows: [], done: 0, total: 0, running: true, etaSeconds: null, startedAt: runStart });
        // Cleared up front, written only on completion below — a cancelled or
        // failed sweep shows no duration.
        sweepDurationSignal.set(null);
        const windows = robustWindowBounds(windowFromMs, windowToMs, cfg.robustWindows);
        const sweepTarget = sweepTargetSignal.value;
        try {
          const landed: SweepRow[] = [];
          progressStageSignal.set(sweepTarget === "remote" ? "uploading" : "submitting");
          const rows = await runSweep(coded ? baseReq : exprReq, sweepAxes, {
            signal: ctl.signal,
            windows,
            target: sweepTarget,
            // Non-coded (expression) sweeps submit to the expr sweep route.
            expr: !coded,
            // Random search: submit the sampled subset instead of the full grid.
            combosOverride: sweepCombosOverride ?? undefined,
            // A modal-close abort (requestSweepCancel(false)) leaves the server
            // job running for a reload to re-attach; the Cancel button
            // (requestSweepCancel(true)) kills it. Read at abort time.
            shouldCancelServer: () => sweepCancelServer.value,
            onRows: (chunkRows, done, total, etaSeconds) => {
              // After an abort (modal closed / Cancel) the state may already be
              // cleared — a late chunk must not resurrect a ghost sweep.
              if (ctl.signal.aborted) return;
              progressStageSignal.set(null);
              landed.push(...chunkRows);
              sweepStateSignal.set({ rows: landed, done, total, running: true, etaSeconds, startedAt: runStart });
            },
          });
          sweepStateSignal.set({ rows, done: rows.length, total: rows.length, running: false });
          sweepDurationSignal.set(performance.now() - runStart);
          // Only on a real completion with produced rows (never on cancel/empty).
          if (rows.length > 0) {
            // Archive the completed sweep server-side (fire-and-forget) so it can
            // be listed and reopened later. Never blocks the UI path.
            saveSweepArchive({
              epic: baseReq.epic,
              timeframe: baseReq.resolution,
              name: null,
              axes: sweepAxes,
              rows,
              windows: windows ?? null,
            })
              .then(({ id }) => {
                // Bind this freshly-archived sweep to the running cell so it is
                // THIS tab+cell's result on the next mount/reload — not inherited
                // by any other cell showing the same epic.
                if (controller) saveSweepResultId(controller.scope, baseReq.epic, id);
                sweepArchivedSignal.set(sweepArchivedSignal.value + 1);
              })
              .catch((e) => console.warn("sweep archive failed", e));
          }
        } catch (e) {
          // A user Cancel and a real chunk failure both reject the same
          // promise — check the controller's own signal (not the error's
          // message) to tell them apart, so Cancel never renders as an error.
          // When the modal already tore the state down (unmount cancel), stay
          // torn down instead of re-publishing a cancelled ghost.
          if (!(ctl.signal.aborted && sweepStateSignal.value === null)) {
            sweepStateSignal.set(sweepCatchState(sweepStateSignal.value, ctl.signal.aborted, e));
          }
        } finally {
          unsubCancel();
        }
        return;
      }

      progressStageSignal.set("engine");
      // Rule-mode single runs go through the expression-native /api/expr/backtest
      // via the exprReq built above (coded runs stay on baseReq). Sweeps/WFO above
      // use their own routing.
      const res = await runAndRender(
        chart,
        coded ? baseReq : exprReq,
        controller!.scope,
        // Displayed TF, so runAndRender picks native/aggregate/none correctly when
        // the run's base TF (runResolution) differs from what the chart shows.
        period.resolution,
        {
          fromMs: windowFromMs,
          toMs: windowToMs,
          mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
        },
      );
      // The summary chip is driven by the signal subscription above, so just
      // publish the result (rehydrate uses the same publish path).
      backtestResultSignal.set(res);
      // Announce the COMPLETION separately, adjacent to the publish so the
      // pairing stays local. Rehydrate shares the publish path above but must
      // not look like a new run to consumers that record one (PresetsTab), and
      // it cannot be distinguished by object identity — runAndRender returns the
      // copy read back out of storage, so a fresh run is a distinct object from
      // the in-memory result too. Only this site, reached solely by a completed
      // single backtest, bumps the counter.
      backtestRunCompletedSignal.set(backtestRunCompletedSignal.value + 1);
      // The run's range can predate the chart's currently-loaded (recent) bars —
      // runAndRender then culls those fills as out-of-window. Page history back to
      // the RUN'S OWN oldest fill (not the drawings walk: its target is the oldest
      // saved drawing anchor, which can be years older than the run and drag a
      // deep budget-capped page-back into every run), which reanchors the markers
      // onto their real candles. No-op when already covered. Await it so trades
      // predating the loaded window are paged in, then fit the chart to the full
      // traded span. Only on a fresh run: reload/TF-switch go via renderArtifacts.
      const tCover0 = performance.now();
      const oldestFillMs = oldestBacktestAnchorMs(res.markers);
      if (chart && oldestFillMs != null) await coverBacktestHistory(chart, oldestFillMs);
      const tCover1 = performance.now();
      if (chart) fitBacktestTrades(chart, res);
      const tFit1 = performance.now();
      console.info(
        `[backtest perf] land: runAndRender ${(tCover0 - tRun0).toFixed(0)}ms, ` +
          `coverage walk ${(tCover1 - tCover0).toFixed(0)}ms, fit ${(tFit1 - tCover1).toFixed(0)}ms, ` +
          `run total ${(tFit1 - tFetch0).toFixed(0)}ms`,
      );
      backtestDurationSignal.set(performance.now() - runStart);
      saveBacktestLastUsed(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : "backtest failed");
    } finally {
      setRunning(false);
      backtestRunningSignal.set(false);
      progressStageSignal.set(null);
    }
  }

  function clear() {
    // Delete the persisted result too, so it doesn't come back on the next
    // timeframe switch or reload. (summary follows backtestResultSignal.)
    if (chart && controller && epic) clearBacktest(chart, controller.scope, epic);
    backtestResultSignal.set(null);
    setError(null);
  }

  return (
    <div className="backtest">
      <Tooltip content={running ? "Backtest running…" : "Open the backtest panel"}>
        <button
          className={`anchor-btn backtest-toggle${running ? " on" : ""}`}
          onClick={openBacktestSettings}
        >
          {/* Bar chart + play: run a strategy over historical bars. */}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <path d="M4 20v-8M9 20V8" />
            <path d="M13.5 9.5 20 13l-6.5 3.5z" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}
