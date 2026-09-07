// Indicators sheet (spec: 2026-09-07-mobile-companion-design.md, Task 9): the
// active-instance list (Settings/Remove per row) plus an add picker, both
// driven off the focused mobile chart's controller (Task 6). The add/remove
// mechanics mirror Toolbar.tsx's addIndicator/removeIndicatorById flow
// faithfully so mobile and desktop stay byte-identical in what they persist.
import { useState, useSyncExternalStore } from "react";
import { getSupportedIndicators } from "klinecharts";
import Sheet from "./Sheet";
import { mobileChartCtx, mobileSymbol, mobilePeriod } from "./mobileChartState";
import {
  addIndicatorInstance,
  removeIndicatorById,
  getIndicatorsByPane,
  isSubPaneIndicator,
  isInternalIndicator,
  isMintedInstanceId,
} from "../lib/indicators";
import { indicatorInfo } from "../lib/indicatorMeta";
import { saveIndicators } from "../lib/persist";
import { EQUITY_INDICATOR } from "../lib/backtest";
import { indicatorSettingsRequest } from "../lib/signals";

// Resolve the pane an instance lives on (candle pane for overlays, its own
// sub-pane for RSI/MACD/etc.) — mirrors useIndicatorCommands.ts's paneIdOf.
function paneIdOf(chart: Parameters<typeof getIndicatorsByPane>[0] | undefined, name: string): string {
  if (!chart) return "candle_pane";
  const all = getIndicatorsByPane(chart);
  for (const [paneId, inds] of all ?? []) if (inds.has(name)) return paneId;
  return "candle_pane";
}

export default function MobileIndicatorsSheet({ onClose }: { onClose: () => void }) {
  const ctx = useSyncExternalStore(
    (fn) => mobileChartCtx.subscribe(fn),
    () => mobileChartCtx.value,
  );
  const symbol = useSyncExternalStore(
    (fn) => mobileSymbol.subscribe(fn),
    () => mobileSymbol.value,
  );
  const period = useSyncExternalStore(
    (fn) => mobilePeriod.subscribe(fn),
    () => mobilePeriod.value,
  );
  const controller = ctx?.controller ?? null;
  const indicators = useSyncExternalStore(
    (fn) => (controller ? controller.indicators.subscribe(fn) : () => {}),
    () => controller?.indicators.value ?? [],
  );

  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState("");

  function addIndicator(type: string) {
    const chart = ctx?.chart;
    if (!chart || !controller) return;
    const inst = addIndicatorInstance(chart, controller.scope, symbol?.epic ?? "", type, {
      forceHidden: controller.indicatorsHidden.value,
      resolution: period?.resolution,
    });
    if (!inst) return;
    if (controller.subPanesHidden.value && isSubPaneIndicator(type))
      controller.subPanesHidden.set(false);
    const next = [...controller.indicators.value, inst];
    controller.indicators.set(next);
    saveIndicators(controller.scope, next);
    if (type === "AVWAP") {
      setAddOpen(false);
      controller.avwapAnchorMode.set(inst.id);
    }
  }

  function removeIndicator(id: string) {
    const chart = ctx?.chart;
    if (!chart || !controller) return;
    removeIndicatorById(chart, controller.scope, id);
    const next = controller.indicators.value.filter((i) => i.id !== id);
    controller.indicators.set(next);
    saveIndicators(controller.scope, next);
  }

  const allIndicators = getSupportedIndicators()
    .filter((n) => !isMintedInstanceId(n))
    .filter(
      (n) =>
        n !== EQUITY_INDICATOR
        && n !== "SLOPE_ACCEL"
        && n !== "PIVOT_BARS_SINCE"
        && !isInternalIndicator(n),
    );
  const matches = (n: string) => {
    const q = filter.toLowerCase();
    if (!q) return true;
    const { title } = indicatorInfo(n);
    return n.toLowerCase().includes(q) || title.toLowerCase().includes(q);
  };
  const filtered = allIndicators.filter(matches).sort();

  return (
    <Sheet title="Indicators" onClose={onClose}>
      <div className="m-ind-list">
        {indicators.map((inst) => (
          <div className="m-ind-row" key={inst.id}>
            <span className="m-ind-row-title">{indicatorInfo(inst.type).title}</span>
            <button
              className="m-ind-row-btn"
              onClick={() =>
                indicatorSettingsRequest.set({ paneId: paneIdOf(ctx?.chart, inst.id), name: inst.id })
              }
            >
              Settings
            </button>
            <button className="m-ind-row-btn" onClick={() => removeIndicator(inst.id)}>
              Remove
            </button>
          </div>
        ))}
        {indicators.length === 0 && <div className="m-ind-empty">No indicators added</div>}
      </div>
      {!addOpen && (
        <button className="m-sheet-row m-ind-add-toggle" onClick={() => setAddOpen(true)}>
          Add indicator
        </button>
      )}
      {addOpen && (
        <div className="m-ind-add">
          <input
            className="m-ind-filter"
            placeholder="Search indicators…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          {filtered.map((type) => {
            const { title } = indicatorInfo(type);
            return (
              <button key={type} className="m-sheet-row" onClick={() => addIndicator(type)}>
                {title === type ? type : `${title} (${type})`}
              </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}
