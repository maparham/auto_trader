// Chart tab (spec: 2026-09-07-mobile-companion-design.md, Task 6). Boots on
// the freshest heartbeat for the active data broker (falls back to the first
// favorite, then symbol search), then renders a compact top bar (symbol /
// period / indicators) above a full-bleed ChartCore.
import { useEffect, useState, useSyncExternalStore } from "react";
import ChartCore from "../ChartCore";
import MobileDrawBar from "./MobileDrawBar";
import MobileChartStrip from "./MobileChartStrip";
import MobileIndicatorsSheet from "./MobileIndicatorsSheet";
import Sheet from "./Sheet";
import { loadSettings } from "../theme";
import { PERIODS } from "../lib/feed";
import { requestSymbolSearch } from "../lib/signals";
import { brokerLabel } from "../lib/trading";
import { isDemoMode } from "../lib/demoMode";
import MobileBrokerSheet from "./MobileBrokerSheet";
import {
  bootMobileMarket,
  mobileAccount,
  mobileBroker,
  mobileChartCtx,
  mobileChartScope,
  mobilePeriod,
  mobileSettingsVersion,
  mobileSymbol,
} from "./mobileChartState";
import { mobileViewMode, setChromeHidden, setLandscape } from "./mobileViewMode";
import { MaximizeIcon, RestoreIcon, RotateIcon } from "./viewModeIcons";
import { reportView } from "../lib/viewHeartbeat";

export default function MobileChartView({ active = true }: { active?: boolean }) {
  const symbol = useSyncExternalStore(
    (fn) => mobileSymbol.subscribe(fn),
    () => mobileSymbol.value,
  );
  const period = useSyncExternalStore(
    (fn) => mobilePeriod.subscribe(fn),
    () => mobilePeriod.value,
  );
  const [periodSheetOpen, setPeriodSheetOpen] = useState(false);
  const [brokerSheetOpen, setBrokerSheetOpen] = useState(false);
  const [indicatorsSheetOpen, setIndicatorsSheetOpen] = useState(false);
  const scope = useSyncExternalStore(
    (fn) => mobileChartScope.subscribe(fn),
    () => mobileChartScope.value,
  );
  useSyncExternalStore(
    (fn) => mobileAccount.subscribe(fn),
    () => mobileAccount.value,
  );
  const broker = mobileBroker();
  // Re-render (and re-read loadSettings() below) when the settings sheet
  // saves a theme change — ChartCore takes `theme` as a plain prop it
  // doesn't watch reactively, so the mounted chart otherwise keeps its
  // stale theme until something else causes a re-render.
  useSyncExternalStore(
    (fn) => mobileSettingsVersion.subscribe(fn),
    () => mobileSettingsVersion.value,
  );
  const viewMode = useSyncExternalStore(
    (fn) => mobileViewMode.subscribe(fn),
    () => mobileViewMode.value,
  );
  const ctx = useSyncExternalStore(
    (fn) => mobileChartCtx.subscribe(fn),
    () => mobileChartCtx.value,
  );
  // The same per-symbol view heartbeat the desktop writes, so a timeframe
  // picked here is what this symbol reopens on next time (setMobileSymbol
  // restores it) and the alert snapshot sees what the phone saw. Debounced
  // inside reportView; fires on the identity changes only, never on scroll.
  useEffect(() => {
    if (!ctx || !symbol || !period || !scope || scope.epic !== symbol.epic) return;
    const el = ctx.chart.getDom?.() ?? null;
    reportView({
      scope: scope.scope,
      epic: symbol.epic,
      broker,
      resolution: period.resolution,
      symbol,
      barSpace: ctx.chart.getBarSpace?.().bar ?? 8,
      width: el?.clientWidth ?? 390,
      height: el?.clientHeight ?? 500,
    });
  }, [ctx, symbol, period, scope, broker]);

  // Returning from display:none (tab switch back to Chart): klinecharts
  // measured a zero-size container while hidden, which mispositions axis
  // labels (the last-price badge rendered as a full-width banner). Kick a
  // resize once the tab is visible again so the chart re-measures.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      try {
        mobileChartCtx.value?.chart.resize();
      } catch {
        /* chart may be mid-teardown on a symbol remount */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  useEffect(() => {
    if (mobileSymbol.value) return; // already booted (e.g. remount on tab switch)
    void bootMobileMarket(mobileBroker());
    // Boot once per mount — a symbol change afterward comes from user action
    // (setMobileAccount owns the reboot on a broker switch).
  }, []);

  // A broker with no heartbeat and no favorites boots to no market. The top
  // bar must still render then — it holds the broker chip and symbol search,
  // the only ways OUT of that state.
  const booted = !!symbol && !!period && scope?.epic === symbol.epic;

  const s = loadSettings();

  return (
    <div className="m-chart-view">
      {!viewMode.chromeHidden && (
        <div className="m-chart-topbar">
          {/* Demo visitors are pinned to the published feed: the chip names
              it but opens nothing. */}
          <button
            className="m-chart-broker"
            disabled={isDemoMode()}
            onClick={() => setBrokerSheetOpen(true)}
          >
            {brokerLabel(broker)}
            {!isDemoMode() && " ▾"}
          </button>
          <button className="m-chart-symbol" onClick={() => requestSymbolSearch()}>
            {symbol?.name ?? "Select market…"}
          </button>
          {booted && (
            <button className="m-chart-period" onClick={() => setPeriodSheetOpen(true)}>
              {period!.label}
            </button>
          )}
          {booted && (
            <button className="m-chart-indicators" onClick={() => setIndicatorsSheetOpen(true)}>
              Indicators
            </button>
          )}
          {booted && (
            <button
              className="m-chart-viewmode"
              aria-label="Landscape"
              onClick={() => void setLandscape(true)}
            >
              <RotateIcon />
            </button>
          )}
        </div>
      )}
      {!viewMode.chromeHidden && <MobileChartStrip />}
      <div className="m-chart-body">
        {/* One control, one spot: top of the price axis, where no candle,
            legend or drawing lives. Its icon names what the tap does next:
            maximize, restore, or (rotated) turn back to portrait, since
            leaving landscape is what setChromeHidden(false) does first. */}
        {booted && (
          <button
            className="m-chart-restore"
            aria-label={
              viewMode.landscape ? "Back to portrait" : viewMode.chromeHidden ? "Show controls" : "Chart only"
            }
            onClick={() => void setChromeHidden(!viewMode.chromeHidden)}
          >
            {viewMode.landscape ? <RotateIcon /> : viewMode.chromeHidden ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
        )}
        {booted && (
          <ChartCore
            key={broker + ":" + scope!.scope + ":" + symbol!.epic}
            cellId="mobile"
            tabId="mobile"
            scope={scope!.scope}
            symbol={symbol!}
            brokerId={broker}
            period={period!}
            theme={s.theme}
            timezone={s.timezone}
            clock={s.clock}
            dateFormat={s.dateFormat}
            showWeekday={s.showWeekday}
            priceSide={s.priceSide}
            bidAsk={s.bidAsk}
            bidAskStyle={s.bidAskStyle}
            crosshair={s.crosshair}
            // topRight parks the pill at the chart's top edge, where the OHLC
            // legend spans the full width on a phone — force those users onto
            // the axis corner, which is always clear here.
            goLivePillPos={s.goLivePillPos === "topRight" ? "axis" : s.goLivePillPos}
            compact
            focused={active}
            syncCrosshair={false}
            syncTime={false}
            locked={false}
            onReady={(_id, chart, controller) => mobileChartCtx.set({ chart, controller })}
            onPeriod={(_id, p) => {
              if (p.resolution !== mobilePeriod.value?.resolution) mobilePeriod.set(p);
            }}
          />
        )}
        {booted && <MobileDrawBar />}
      </div>
      {periodSheetOpen && (
        <Sheet title="Period" onClose={() => setPeriodSheetOpen(false)}>
          {PERIODS.map((p) => (
            <button
              key={p.resolution}
              className={`m-sheet-row${p.resolution === period?.resolution ? " m-sheet-row-on" : ""}`}
              onClick={() => {
                mobilePeriod.set(p);
                setPeriodSheetOpen(false);
              }}
            >
              {p.label}
            </button>
          ))}
        </Sheet>
      )}
      {indicatorsSheetOpen && (
        <MobileIndicatorsSheet onClose={() => setIndicatorsSheetOpen(false)} />
      )}
      {brokerSheetOpen && <MobileBrokerSheet onClose={() => setBrokerSheetOpen(false)} />}
    </div>
  );
}
