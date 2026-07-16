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
} from "./lib/backtest";
import type { ChartController } from "./lib/chartController";
import Tooltip from "./components/Tooltip";
import { fetchRange, RESOLUTION_SECONDS, type Period } from "./lib/feed";
import type { PriceSide } from "./theme";
import { buildChartOperandSeries } from "./lib/backtestSeries";
import { defaultBacktestConfig, activeGroup, type BacktestConfig, type RuleGroup } from "./lib/backtestConfig";
import { resolveMask } from "./lib/backtestSchedule";
import { loadCodedCfg, resolveParamValues, sendableRisk } from "./lib/codedConfig";
import { fetchStrategies, saveSweepArchive } from "./api";
import {
  resolveWindow,
  resolveHistoryStart,
  minimalHistoryStart,
  requiredWarmupBars,
  warmupBarCount,
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
  backtestMessagesSignal,
  backtestPeriodsShownSignal,
  backtestMarkersShownSignal,
  backtestEquityShownSignal,
  backtestRunningSignal,
  sweepAxesSignal,
  sweepStateSignal,
  sweepCancelRequest,
  sweepCancelServer,
  sweepTargetSignal,
  holdoutEvalSignal,
  sweepCombosOverrideSignal,
  sweepArchivedSignal,
} from "./lib/signals";
import { robustWindowBounds, runSweep, sweepCatchState } from "./lib/sweep";
import { recordSweepPace, sweepContext } from "./lib/sweepMemory";
import { loadHoldout, splitHoldout } from "./lib/holdout";
import { stopResumedSweep } from "./lib/sweepResume";
import { inspectModeSignal } from "./lib/backtestInspect";
import type { BacktestRequest, SweepRow } from "./api";

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
  const [warning, setWarning] = useState<string | null>(null);

  // The transient run messages (error / short-warm-up warning) belong to a
  // specific run; drop them when the symbol or timeframe changes. Reset during
  // render on the key change (React's "adjust state on prop change" pattern)
  // rather than in an effect. The result itself is now persisted and rehydrated
  // by ChartCore, so it is NOT cleared here anymore.
  const runKey = `${epic ?? ""}|${period?.resolution ?? ""}`;
  const [msgKey, setMsgKey] = useState(runKey);
  if (msgKey !== runKey) {
    setMsgKey(runKey);
    setError(null);
    setWarning(null);
  }

  // Publish the transient messages so the results pane renders them (they no
  // longer live next to this toolbar button).
  useEffect(() => {
    backtestMessagesSignal.set({ error, warning });
  }, [error, warning]);

  // The results pane's clear (✕) asks for a clear through this signal; the
  // teardown lives here because only this component has the chart/controller.
  useEffect(() => backtestClearRequest.subscribe(() => clear()));

  // The panel's "Run backtest" saves the config as last-used then bumps this
  // signal, which runs the backtest here (run() always reads the latest
  // last-used config, so no config needs to be threaded through). The toolbar
  // button only opens the panel — running lives with the config.
  useEffect(() => backtestRunRequest.subscribe(() => void run()));

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
    // Published imperatively (not via an effect on `running`) so the settings
    // modal's disabled "Run backtest" can never strand: the finally below always
    // resets it, even if this component were unmounted mid-run.
    backtestRunningSignal.set(true);
    setError(null);
    setWarning(null);
    // Captured once up front: the modal publishes the axes (empty in Backtest
    // mode) right before bumping the run request, and nothing may change them
    // mid-run (run() no-ops while running).
    const sweepAxes = sweepAxesSignal.value;
    // Random-search one-shot override: captured + cleared up front (like the
    // holdout flag) so a stale sample can never leak into the next grid sweep.
    const sweepCombosOverride = sweepCombosOverrideSignal.value;
    sweepCombosOverrideSignal.set(null);
    // Single run: drop the previous result from the pane right away — when two
    // runs produce identical numbers, a pane that never visibly changes reads
    // as "the click did nothing". Emptying it (the pane shows its running
    // state) makes every run observable. Chart artifacts are torn down later
    // by runAndRender, once the fresh result is in hand. A sweep leaves the
    // last single-run result alone: it streams into sweepStateSignal, and the
    // modal's mode switch flips between the two coexisting result sets.
    if (sweepAxes.length === 0) backtestResultSignal.set(null);
    try {
      const cfg = loadBacktestLastUsed() ?? defaultBacktestConfig();
      const coded = cfg.mode === "coded";
      if (coded && !cfg.codedStrategy) {
        setError("no coded strategy selected: pick one in the backtest panel");
        return;
      }
      // Coded mode: the panel's per-file config (params + risk + exit rules,
      // Task 8) drives the run — entries stay empty (the .py file opens
      // positions itself). Feeding this into `buildChartOperandSeries`
      // unchanged (empty entry groups ⇒ only exit-rule chart-operand series
      // come out; natives/ATR are computed server-side) is the "effective
      // cfg" trick other tasks reuse, so no other machinery needs to know
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

      const required = requiredWarmupBars(cfg, resSeconds);
      const depth = cfg.range.history ?? "minimal";
      // Temporary phase timing (perf investigation) — logged as [backtest perf].
      const tFetch0 = performance.now();
      let bars = await fetchBars(resolveHistoryStart(cfg, windowFromMs, resSeconds));

      // The requested depth can exceed what the broker/account actually serves
      // (e.g. "Full" asking further back than a live account's history limit) —
      // that can come back either completely empty OR a non-empty but too-short
      // history (a broker rejecting only the oldest chunk, or the cache serving
      // whatever it already had). Either way, retry once at the minimal depth
      // (the smallest, most likely-to-succeed ask) rather than only checking for
      // the empty case.
      if (depth !== "minimal" && (bars.length === 0 || warmupBarCount(bars, windowFromMs) < required)) {
        const retried = await fetchBars(minimalHistoryStart(cfg, windowFromMs, resSeconds));
        if (warmupBarCount(retried, windowFromMs) > warmupBarCount(bars, windowFromMs)) {
          bars = retried;
        }
      }

      const tradeFromTime = Math.round(windowFromMs / 1000);
      if (!bars.some((k) => Math.round(k.timestamp / 1000) >= tradeFromTime)) {
        setError("no candles in the selected range");
        return;
      }

      const warmup = warmupBarCount(bars, windowFromMs);
      if (warmup < required) {
        setWarning(`only ${warmup} of ${required} warm-up bars available, so indicators may be cold at the start of the window`);
      }

      // A chart-operand rule may reference a higher timeframe than the base
      // run; fetch each such timeframe over the same span as the base history
      // so its indicator is warm, then buildChartOperandSeries forward-fills
      // it onto the base bars.
      const htfFromSec = Math.floor(Math.max(0, bars[0].timestamp) / 1000);
      const fetchTimeframe = (resolution: string) =>
        fetchRange(epic, resolution, htfFromSec, toSec, priceSide, brokerId);
      const tSeries0 = performance.now();
      // The backend now recomputes native indicators/price/slope/ATR series
      // itself from the rule config, so the browser only ships kind:"series"
      // chart-operand/drawing series here — the ones the backend can't derive
      // on its own. Coded mode's strategy-file indicators are computed in
      // Python and never touch this series map either way.
      const series = await buildChartOperandSeries(bars, effCfg, runResolution, fetchTimeframe);
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
          `buildChartOperandSeries ${(tSeries1 - tSeries0).toFixed(0)}ms (${Object.keys(series).length} series)`,
      );
      const tRun0 = performance.now();
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
        // Disabled rules are kept in the config but dropped from the run. Coded
        // entries are always the empty group (the .py file opens positions
        // itself); coded exits come from the panel's per-file config.
        longEntry: activeGroup(effCfg.longEntry),
        longExit: activeGroup(effCfg.longExit),
        shortEntry: activeGroup(effCfg.shortEntry),
        shortExit: activeGroup(effCfg.shortExit),
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
        // Ask the backend for the per-bar inspector trace only while inspect mode
        // is on (rule mode only — coded strategies have no rule groups to trace).
        inspect: inspectModeSignal.value && !coded,
        // Always-on for single runs: the handler skips it when a sweep is set,
        // so the sweep path below pays nothing.
        costSensitivity: true,
      };

      // Sweep mode (Task 10): the modal populated sweepAxesSignal and asked for
      // this same run — chunk through runSweep instead of a single runAndRender.
      // Nothing renders on the chart; results stream into sweepStateSignal for
      // the modal's <SweepResults> to show. Clicking a result applies it, which
      // clears the axes and re-enters this function on the normal path.
      if (sweepAxes.length > 0) {
        const ctl = new AbortController();
        const unsubCancel = sweepCancelRequest.subscribe(() => ctl.abort());
        // Take over from any live re-attached (resumed) poll first, so this fresh
        // submission owns the sweep state cleanly instead of racing a resumed one.
        stopResumedSweep();
        sweepStateSignal.set({ rows: [], done: 0, total: 0, running: true });
        const windows = robustWindowBounds(windowFromMs, windowToMs, cfg.robustWindows);
        const sweepTarget = sweepTargetSignal.value;
        const startedAt = Date.now();
        try {
          const landed: SweepRow[] = [];
          const rows = await runSweep(baseReq, sweepAxes, {
            signal: ctl.signal,
            windows,
            target: sweepTarget,
            // Random search: submit the sampled subset instead of the full grid.
            combosOverride: sweepCombosOverride ?? undefined,
            // A modal-close abort (requestSweepCancel(false)) leaves the server
            // job running for a reload to re-attach; the Cancel button
            // (requestSweepCancel(true)) kills it. Read at abort time.
            shouldCancelServer: () => sweepCancelServer.value,
            onRows: (chunkRows, done, total) => {
              // After an abort (modal closed / Cancel) the state may already be
              // cleared — a late chunk must not resurrect a ghost sweep.
              if (ctl.signal.aborted) return;
              landed.push(...chunkRows);
              sweepStateSignal.set({ rows: landed, done, total, running: true });
            },
          });
          sweepStateSignal.set({ rows, done: rows.length, total: rows.length, running: false });
          // Remember how long a combo took on this epic/timeframe/target so the
          // modal footer can turn a combo count into a runtime estimate next time.
          // Only on a real completion with produced rows (never on cancel/empty).
          if (rows.length > 0) {
            recordSweepPace(baseReq.epic, baseReq.resolution, sweepTarget, (Date.now() - startedAt) / rows.length);
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

      const res = await runAndRender(
        chart,
        baseReq,
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
      saveBacktestLastUsed(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : "backtest failed");
    } finally {
      setRunning(false);
      backtestRunningSignal.set(false);
    }
  }

  function clear() {
    // Delete the persisted result too, so it doesn't come back on the next
    // timeframe switch or reload. (summary follows backtestResultSignal.)
    if (chart && controller && epic) clearBacktest(chart, controller.scope, epic);
    backtestResultSignal.set(null);
    setError(null);
    setWarning(null);
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
