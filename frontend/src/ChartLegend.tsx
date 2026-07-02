// TradingView-style top-left chart legend, rendered as DOM (not klinecharts'
// canvas legend, whose text was blurry vs TV). It layers over the candle pane:
// row 0 is the symbol · interval · source + O/H/L/C + change; each row below is a
// candle-pane indicator with its name(params), figure values in their plot color,
// and the eye/gear/trash action icons.
//
// Performance: which ROWS exist is React state (driven by ChartCore, gated on a
// shallow signature so it only re-renders on add/remove/visibility change). The
// VALUES update imperatively via refs (textContent) on every crosshair move and
// live tick — like ChartCore's live-price pill — so React doesn't re-render per
// crosshair pixel. ChartCore subscribes OnCrosshairChange and calls our
// updateValues(dataIndex|null); null = no crosshair → fall back to the last bar.

import { useEffect, useImperativeHandle, useRef, type Ref, type RefObject } from "react";
import { DomPosition, type Chart, type Indicator, type KLineData } from "klinecharts";
import type { ChartController } from "./lib/chartController";
import InfoTip from "./InfoTip";
import {
  indTypeOf,
  prevHlDegenerateInfo,
  prevHlLegendSummary,
  type PrevHlExtend,
} from "./lib/customIndicators";
// Sub-pane indicators that are app-internal (not user-added) and so get NO legend
// card — the user must not be able to remove/edit them via a card. Shared with the
// reorder engine so the legend's card index and the engine's reorderable order stay
// in lockstep (see INTERNAL_INDICATORS in ./lib/indicators).
import { INTERNAL_INDICATORS } from "./lib/indicators";

const UP = "#26a69a";
const DOWN = "#ef5350";

// One candle-pane indicator figure shown in the legend (a "title value" pair).
interface LegendFigure {
  key: string; // result key, for the imperative value lookup
  title: string; // e.g. "EMA: " / "Value: "
  color: string; // plot color (line figures) or the legend text color
}

// One indicator row. `sig` is the shallow signature ChartCore diffs on to decide
// whether the row list changed (so we only setState on real structural changes).
export interface LegendRow {
  name: string;
  shortName: string;
  calcParamsText: string; // "(9)" etc., already formatted (AVWAP hides its anchor)
  visible: boolean;
  hideValue: boolean; // "show value in legend" toggle off
  figures: LegendFigure[];
  // A ⚠ badge tooltip when some of the indicator's lines draw nothing at the current
  // timeframe (PREV_HL degenerate boundaries). Absent = no badge.
  warn?: string;
  // A dimmed summary shown after the name (PREV_HL lookbacks, e.g. "1 day, since …").
  // Absent when off or empty.
  summary?: string;
}

// One sub-pane's legend: its paneId, its indicator rows, and the y-pixel (relative
// to the chart root) where that pane's main area begins — so ChartCore can position
// a DOM card at the top-left of the pane, the same place klinecharts drew its canvas
// legend. `sig` folds in the rows' signature AND the top, so a separator drag (which
// only moves `top`) still re-renders the card to the new position.
export interface SubPaneLegendData {
  paneId: string;
  top: number;
  rows: LegendRow[];
}

interface LegendCtx {
  symbol: string;
  period: string;
  precision: number;
  live: boolean;
  broker: string; // display name of the data source ("Capital.com", "IG (demo)")
}

// Imperative handle ChartCore drives on the live tick / crosshair change.
export interface ChartLegendHandle {
  updateValues: (dataIndex: number | null) => void;
}

export interface Props {
  getChart: () => Chart | null;
  // The owning cell's controller — for its per-cell legend-hover signals (these
  // were module globals; per-cell so two cells don't share a crosshair-hide).
  controller: ChartController;
  ctx: LegendCtx;
  rows: LegendRow[];
  // TV-style chevron: collapsed hides the candle-pane indicator rows (the symbol/
  // OHLC row stays). The chevron itself hover-reveals while expanded and stays
  // visible while collapsed (it's the only way back).
  collapsed: boolean;
  onToggleCollapsed: () => void;
  // Sub-pane indicator legends (Volume/MACD/RSI…), one per pane below the chart.
  // Rendered here (not in ChartCore) so they share this component's figureValuesRef
  // and hover signal — their values fill on the same imperative crosshair/tick path.
  subPanes: SubPaneLegendData[];
  // Name of the selected indicator (drives the blue row highlight) — its name is
  // unique across panes, so one prop covers the candle legend AND the sub-panes.
  // A prop, not the signal, so React re-renders the highlight on selection change.
  selectedName: string | null;
  // Name of the indicator whose CURVE the cursor is over (any pane), or null. Drives
  // the same highlighted look as a row hover, so hovering a curve lights its card.
  highlightedName: string | null;
  // Action-icon handlers (mirror ChartCore's OnTooltipIconClick routing). Each takes
  // the indicator name; ChartCore resolves the owning pane (name is globally unique).
  onToggleVisible: (name: string) => void;
  onOpenSettings: (name: string) => void;
  onRemove: (name: string) => void;
  // Click a row body to select the indicator (TradingView-style), like a curve click.
  onSelectRow: (name: string) => void;
  // Click the ⓘ button to open the instrument-details modal (TradingView-style).
  onOpenDetails: () => void;
  // Click the symbol name itself to change the instrument on this chart (opens the
  // symbol-search modal, TradingView-style).
  onChangeSymbol: () => void;
  // Candle-cache stats badge (coverage/hit-rate/freshness at a glance) — null
  // hides the badge entirely (e.g. before the first stats poll resolves).
  cacheBadge: {
    label: string;
    title: string;
    state: "fresh" | "stale" | "none";
  } | null;
  // Click the cache badge to open the cache-stats popover.
  onOpenCacheStats: () => void;
  // Open the indicator context menu (anchored at the ⋯ button) — TradingView's
  // "more" affordance at the end of the legend row.
  onOpenMenu: (name: string, x: number, y: number) => void;
  // Sub-pane reorder: move a pane to a new slot (Task 2's engine) and start a
  // drag-to-reorder session from the legend card's grip handle.
  onMove: (name: string, targetIndex: number) => void;
  onStartReorder: (paneId: string, name: string) => void;
  handleRef?: Ref<ChartLegendHandle>;
}

function fmtNum(v: number, precision: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

const ICON_EYE = "\uE8F4"; // visibility
const ICON_EYE_OFF = "\uE8F5"; // visibility_off (crossed eye)
const ICON_GEAR = "\uE8B8"; // settings
const ICON_TRASH = "\uE872"; // delete

const ICON_ARROW_UP = (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path d="M12 19V6M6 12l6-6 6 6" />
  </svg>
);
const ICON_ARROW_DOWN = (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path d="M12 5v13M6 12l6 6 6-6" />
  </svg>
);
// Collapse chevron (up = "hide the rows"). The collapsed state renders the SAME
// icon rotated 180° via CSS (.cl-collapse.cl-collapsed svg) — one path, no
// hand-maintained mirror twin.
const ICON_CHEVRON_UP = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 15l6-6 6 6" />
  </svg>
);

export default function ChartLegend({
  getChart,
  controller,
  ctx,
  rows,
  collapsed,
  onToggleCollapsed,
  subPanes,
  selectedName,
  highlightedName,
  onToggleVisible,
  onOpenSettings,
  onRemove,
  onSelectRow,
  onOpenMenu,
  onOpenDetails,
  onChangeSymbol,
  cacheBadge,
  onOpenCacheStats,
  onMove,
  onStartReorder,
  handleRef,
}: Props) {
  const { legendHovered, legendHoverName } = controller;
  // Imperative value targets, keyed so updateValues can find them without React.
  // OHLC + change live on the candle row; each indicator figure has its own span.
  const ohlcRef = useRef<Record<"O" | "H" | "L" | "C", HTMLSpanElement | null>>({
    O: null,
    H: null,
    L: null,
    C: null,
  });
  const changeRef = useRef<HTMLSpanElement | null>(null);
  // figureValues[`${name}|${key}`] -> the span showing that figure's value.
  const figureValuesRef = useRef<Map<string, HTMLSpanElement>>(new Map());

  // Imperatively set the displayed values for the bar at dataIndex (or the last
  // bar when null/out of range). Mirrors candleLegend's old formula: change is vs
  // the PREVIOUS close (TV convention), falling back to this bar's open.
  const updateValues = (dataIndex: number | null) => {
    const chart = getChart();
    if (!chart) return;
    const dl = chart.getDataList();
    if (!dl.length) return;
    const idx =
      dataIndex != null && dataIndex >= 0 && dataIndex < dl.length
        ? dataIndex
        : dl.length - 1;
    const cur = dl[idx];
    const prev = idx > 0 ? dl[idx - 1] : undefined;
    const prec = ctx.precision;

    const o = ohlcRef.current;
    if (o.O) o.O.textContent = fmtNum(cur.open, prec);
    if (o.H) o.H.textContent = fmtNum(cur.high, prec);
    if (o.L) o.L.textContent = fmtNum(cur.low, prec);
    if (o.C) o.C.textContent = fmtNum(cur.close, prec);
    const bodyColor = cur.close >= cur.open ? UP : DOWN;
    for (const k of ["O", "H", "L", "C"] as const) {
      if (o[k]) o[k]!.style.color = bodyColor;
    }
    if (changeRef.current) {
      const ref = prev?.close ?? cur.open;
      const change = cur.close - ref;
      const pct = ref !== 0 ? (change / ref) * 100 : 0;
      const sign = change >= 0 ? "+" : "";
      changeRef.current.textContent = `${sign}${fmtNum(change, prec)} (${sign}${pct.toFixed(2)}%)`;
      changeRef.current.style.color = change > 0 ? UP : change < 0 ? DOWN : "var(--text)";
    }

    // Indicator figure values for this bar, in each figure's plot color. Covers
    // EVERY pane (candle + sub-panes like Volume/MACD/RSI): the value spans are
    // keyed by the indicator's unique instance name, which never collides across
    // panes, so one flat loop over all panes fills both legends' values.
    const allPanes = chart.getIndicatorByPaneId() as
      | Map<string, Map<string, Indicator>>
      | null
      | undefined;
    for (const inds of allPanes?.values() ?? []) {
      for (const [name, ind] of inds) {
        const result = ind.result as Array<Record<string, number | undefined>> | undefined;
        const row = result?.[idx];
        for (const fig of ind.figures) {
          const span = figureValuesRef.current.get(`${name}|${fig.key}`);
          if (!span) continue;
          const v = row?.[fig.key];
          span.textContent =
            typeof v === "number" && Number.isFinite(v)
              ? fmtNum(v, ind.precision ?? prec)
              : "n/a";
        }
      }
    }
  };

  useImperativeHandle(handleRef, () => ({ updateValues }));

  // Refresh values whenever the row set changes (a newly-added indicator needs its
  // initial values painted; ChartCore also calls updateValues on tick/crosshair).
  useEffect(() => {
    updateValues(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, subPanes, ctx.symbol, ctx.precision, collapsed]);

  // Hovering a row drives BOTH the gray border + icon reveal (CSS, via this
  // signal) so they appear together on the exact row (matches the old behavior).
  const setRowHover = (name: string | null) => {
    if (legendHoverName.value !== name) legendHoverName.set(name);
  };
  // Entering/leaving the whole legend strip hides the crosshair (TV-style).
  const setBandHover = (over: boolean) => {
    if (legendHovered.value !== over) {
      legendHovered.set(over);
      getChart()?.setStyles({ crosshair: { show: !over } });
    }
  };

  return (
    <>
    <div
      className="chart-legend"
      onMouseEnter={() => setBandHover(true)}
      onMouseLeave={() => {
        setBandHover(false);
        setRowHover(null);
      }}
    >
      {/* Row 0: symbol · interval · source + OHLC + change. */}
      <div className="cl-row cl-ohlc">
        {/* Live "ping" dot — signals streaming without overloading the symbol with the
            UP/green color (green on a down bar reads as a mixed signal). */}
        {ctx.live && <span className="cl-live-dot" title="Live" aria-hidden="true" />}
        <span
          className="cl-sym cl-sym-clickable"
          title="Change instrument"
          onClick={(e) => {
            e.stopPropagation();
            onChangeSymbol();
          }}
        >
          {ctx.symbol}
        </span>
        {/* The symbol name now changes the instrument (symbol search); the ⓘ button
            is the affordance for the instrument-details modal. */}
        <button
          className="cl-info"
          aria-label="Instrument details"
          title="Instrument details"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDetails();
          }}
        >
          {/* A rounded-square accent chip with a serif "i" — non-round so it never
              competes with the circular chart markers, and avoids the old "bullseye"
              (a ringed ⓘ glyph inside a ringed circle). */}
          <span aria-hidden="true">i</span>
        </button>
        <span className="cl-meta">
          · {ctx.period} · {ctx.broker}
        </span>
        {(["O", "H", "L", "C"] as const).map((k) => (
          <span className="cl-ohlc-item" key={k}>
            <span className="cl-ohlc-label">{k}</span>
            <span
              className="cl-ohlc-val"
              ref={(el) => {
                ohlcRef.current[k] = el;
              }}
            />
          </span>
        ))}
        <span
          className="cl-change"
          ref={(el) => {
            changeRef.current = el;
          }}
        />
      </div>

      {/* One row per candle-pane indicator (hidden entirely while collapsed). */}
      {!collapsed &&
        rows.map((row) => (
          <IndicatorRow
            key={row.name}
            row={row}
            selected={selectedName === row.name}
            highlighted={highlightedName === row.name}
            figureValuesRef={figureValuesRef}
            setRowHover={setRowHover}
            onSelectRow={onSelectRow}
            onToggleVisible={onToggleVisible}
            onOpenSettings={onOpenSettings}
            onRemove={onRemove}
            onOpenMenu={onOpenMenu}
          />
        ))}

      {/* TV-style collapse chevron: its own mini-row under the indicator rows.
          Hover-revealed while expanded (CSS); always visible while collapsed. Only
          rendered when there are rows to collapse. */}
      {rows.length > 0 && (
        <div className="cl-row cl-collapse-row">
          <button
            className={`cl-icon cl-icon-svg cl-icon-stroke cl-collapse${
              collapsed ? " cl-collapsed" : ""
            }`}
            title={collapsed ? "Show indicator legend" : "Hide indicator legend"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapsed();
            }}
          >
            {ICON_CHEVRON_UP}
          </button>
        </div>
      )}

      {/* Candle-cache stats badge — last legend row at the top-LEFT. It used to
          dock at the pane's top-right, but that corner now belongs to the cell
          controls (detach/maximize), which would cover it while hovered. */}
      {cacheBadge && (
        <button
          className="cl-cache-corner-badge"
          title={cacheBadge.title}
          onClick={(e) => {
            e.stopPropagation();
            onOpenCacheStats();
          }}
        >
          <span className={`cl-cache-dot cl-cache-${cacheBadge.state}`} aria-hidden="true" />
          {cacheBadge.label}
        </button>
      )}
    </div>

    {/* One DOM legend card per sub-pane (Volume/MACD/RSI…), positioned by ChartCore
        at the top-left of each pane. Outside the candle-legend strip so each can
        sit at its own `top`; they share figureValuesRef/setRowHover so values fill
        on the same imperative path and hovering reveals the same gray card. */}
    {subPanes.map((sp, i) => (
      <SubPaneLegend
        key={sp.paneId}
        data={sp}
        index={i}
        count={subPanes.length}
        selectedName={selectedName}
        highlightedName={highlightedName}
        figureValuesRef={figureValuesRef}
        setRowHover={setRowHover}
        onSelectRow={onSelectRow}
        onToggleVisible={onToggleVisible}
        onOpenSettings={onOpenSettings}
        onRemove={onRemove}
        onOpenMenu={onOpenMenu}
        onMove={onMove}
        onStartReorder={onStartReorder}
      />
    ))}
    </>
  );
}

// A single interactive indicator legend row (name(params) · figure values · the
// eye/gear/trash/⋯ action icons). Shared by the candle-pane <ChartLegend> and the
// per-pane <SubPaneLegend>, so both cards look and behave identically. The figure
// value spans register into figureValuesRef so updateValues can fill them without
// a React re-render (same imperative path as the OHLC row).
function IndicatorRow({
  row,
  selected,
  highlighted,
  figureValuesRef,
  setRowHover,
  onSelectRow,
  onToggleVisible,
  onOpenSettings,
  onRemove,
  onOpenMenu,
  onMoveUp,
  onMoveDown,
}: {
  row: LegendRow;
  selected: boolean;
  highlighted: boolean;
  figureValuesRef: RefObject<Map<string, HTMLSpanElement>>;
  setRowHover: (name: string | null) => void;
  onSelectRow: (name: string) => void;
  onToggleVisible: (name: string) => void;
  onOpenSettings: (name: string) => void;
  onRemove: (name: string) => void;
  onOpenMenu: (name: string, x: number, y: number) => void;
  // Sub-pane reorder arrows. Present only for sub-pane rows; undefined for candle-pane
  // rows (no arrows) and omitted individually at the top/bottom ends.
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  return (
    <div
      className={`cl-row cl-ind${selected ? " cl-selected" : ""}${
        highlighted ? " cl-curve-hover" : ""
      }${row.visible ? "" : " cl-hidden"}`}
      onMouseEnter={() => setRowHover(row.name)}
      onMouseLeave={() => setRowHover(null)}
      onClick={() => onSelectRow(row.name)}
      onDoubleClick={() => onOpenSettings(row.name)}
    >
      <span className="cl-name">
        {row.shortName}
        {row.calcParamsText}
      </span>
      {row.warn && (
        <InfoTip text={row.warn} className="cl-warn">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path d="M12 3.2 22 20.5H2L12 3.2z" />
            <line x1="12" y1="10" x2="12" y2="15" />
            <circle cx="12" cy="17.5" r="0.7" fill="currentColor" stroke="none" />
          </svg>
        </InfoTip>
      )}
      {row.summary && <span className="cl-summary">{row.summary}</span>}
      {!row.hideValue &&
        row.figures.map((fig) =>
          fig.title ? (
            <span className="cl-fig" key={fig.key} style={{ color: fig.color }}>
              <span className="cl-fig-title">{fig.title}</span>
              <span
                className="cl-fig-val"
                ref={(el) => {
                  const map = figureValuesRef.current;
                  const mapKey = `${row.name}|${fig.key}`;
                  if (el) map.set(mapKey, el);
                  else map.delete(mapKey);
                }}
              />
            </span>
          ) : null,
        )}
      {/* Action icons. A hidden indicator always keeps its unhide eye even when
          idle; the rest reveal on row hover/selection (CSS .cl-icons). */}
      <span
        className={`cl-icons${row.visible ? "" : " cl-icons-hidden-eye"}`}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button
          className="cl-icon"
          title={row.visible ? "Hide" : "Show"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisible(row.name);
          }}
        >
          {row.visible ? ICON_EYE : ICON_EYE_OFF}
        </button>
        <button
          className="cl-icon"
          title="Settings"
          onClick={(e) => {
            e.stopPropagation();
            onOpenSettings(row.name);
          }}
        >
          {ICON_GEAR}
        </button>
        <button
          className="cl-icon"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(row.name);
          }}
        >
          {ICON_TRASH}
        </button>
        {/* TradingView-style "more" (⋯): opens the context menu, anchored
            just below the button. SVG (not the Material Symbols subset, which
            doesn't include more_horiz) so it's crisp without re-subsetting. */}
        <button
          className="cl-icon cl-icon-svg"
          title="More"
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenMenu(row.name, r.left, r.bottom + 4);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        {onMoveUp && (
          <button
            className="cl-icon cl-icon-svg cl-icon-stroke sp-move-up"
            title="Move up"
            onClick={(e) => {
              e.stopPropagation();
              onMoveUp();
            }}
          >
            {ICON_ARROW_UP}
          </button>
        )}
        {onMoveDown && (
          <button
            className="cl-icon cl-icon-svg cl-icon-stroke sp-move-down"
            title="Move down"
            onClick={(e) => {
              e.stopPropagation();
              onMoveDown();
            }}
          >
            {ICON_ARROW_DOWN}
          </button>
        )}
      </span>
    </div>
  );
}

// A sub-pane indicator legend: the rows for ONE pane below the chart (Volume, MACD,
// RSI…), positioned by ChartCore at the top-left of that pane (where klinecharts
// used to draw its blurry canvas legend). No symbol/OHLC row — just the indicator
// rows, reusing <IndicatorRow> so the look/behavior matches the candle legend.
// Values fill imperatively through the SAME figureValuesRef as the candle legend
// (the parent <ChartLegend>'s handle loops all panes), so these stay live on the
// crosshair/tick with no extra wiring. selectedName drives the same blue highlight.
function SubPaneLegend({
  data,
  index,
  count,
  selectedName,
  highlightedName,
  figureValuesRef,
  setRowHover,
  onSelectRow,
  onToggleVisible,
  onOpenSettings,
  onRemove,
  onOpenMenu,
  onMove,
  onStartReorder,
}: {
  data: SubPaneLegendData;
  index: number; // this pane's position within the reorderable sub-pane list
  count: number; // total reorderable sub-panes
  selectedName: string | null;
  highlightedName: string | null;
  figureValuesRef: RefObject<Map<string, HTMLSpanElement>>;
  setRowHover: (name: string | null) => void;
  onSelectRow: (name: string) => void;
  onToggleVisible: (name: string) => void;
  onOpenSettings: (name: string) => void;
  onRemove: (name: string) => void;
  onOpenMenu: (name: string, x: number, y: number) => void;
  onMove: (name: string, targetIndex: number) => void;
  onStartReorder: (paneId: string, name: string) => void;
}) {
  return (
    <div className="chart-legend sub-pane-legend" style={{ top: data.top }}>
      <button
        className="sp-drag-handle"
        title="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          if (e.button !== 0) return; // primary button only — no right-click drags
          e.stopPropagation();
          e.preventDefault();
          onStartReorder(data.paneId, data.rows[0]?.name ?? "");
        }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
          <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
          <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
        </svg>
      </button>
      {/* Rows in their own column so the grip sits to their LEFT (the card lays out
          as a row: [grip | rows]), not stacked above the first row. */}
      <div className="sp-rows">
        {data.rows.map((row) => (
          <IndicatorRow
            key={row.name}
            row={row}
            selected={selectedName === row.name}
            highlighted={highlightedName === row.name}
            figureValuesRef={figureValuesRef}
            setRowHover={setRowHover}
            onSelectRow={onSelectRow}
            onToggleVisible={onToggleVisible}
            onOpenSettings={onOpenSettings}
            onRemove={onRemove}
            onOpenMenu={onOpenMenu}
            onMoveUp={index > 0 ? () => onMove(row.name, index - 1) : undefined}
            onMoveDown={index < count - 1 ? () => onMove(row.name, index + 1) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

// Build the LegendRow list for ONE pane's indicator map. Figure colors resolve from
// per-line style overrides, falling back to the theme's line palette — the same
// resolution the selection-dot cache uses. Shared by the candle pane and sub-panes.
function rowsForPane(
  inds: Map<string, Indicator> | null | undefined,
  lineStyles: { color: string }[],
  legendTextColor: string,
  dataList?: KLineData[],
  tfLabel?: string,
): LegendRow[] {
  const rows: LegendRow[] = [];
  for (const [name, ind] of inds ?? []) {
    const hideValue =
      (ind.extendData as { hideLegendValue?: boolean } | undefined)?.hideLegendValue ?? false;
    const calcParamsText =
      indTypeOf(ind) === "AVWAP"
        ? ""
        : ind.calcParams?.length
          ? `(${ind.calcParams.join(",")})`
          : "";
    let lineIdx = 0;
    const figures: LegendFigure[] = [];
    for (const fig of ind.figures) {
      const isLine = fig.type === "line";
      const color = isLine
        ? ind.styles?.lines?.[lineIdx]?.color ??
          lineStyles[lineIdx % lineStyles.length]?.color ??
          legendTextColor
        : legendTextColor;
      if (isLine) lineIdx++;
      if (typeof fig.title !== "string" || fig.title === "") continue;
      figures.push({ key: fig.key, title: fig.title, color });
    }
    // PREV_HL: warn when an active boundary draws nothing at this timeframe (its
    // window is shorter than one bar). The fix is the same for any boundary — make
    // the lookback at least one bar — so the message states that minimum.
    let warn: string | undefined;
    let summary: string | undefined;
    if (indTypeOf(ind) === "PREV_HL") {
      const ext = (ind.extendData ?? {}) as PrevHlExtend;
      if (dataList?.length) {
        const { degenerate, minDuration } = prevHlDegenerateInfo(dataList, ext);
        if (degenerate) {
          const inTf = tfLabel ? ` in the ${tfLabel} timeframe` : "";
          warn = `Lookback must be at least ${minDuration}${inTf}.`;
        }
      }
      // The lookback summary (e.g. "1 day, since …"), gated by the "Show lookback in
      // legend" toggle (hideLegendValue). Empty when no boundary is active.
      if (!hideValue) summary = prevHlLegendSummary(ext) || undefined;
    }
    rows.push({
      name,
      shortName: ind.shortName ?? ind.name,
      calcParamsText,
      visible: ind.visible !== false,
      hideValue,
      figures,
      warn,
      summary,
    });
  }
  return rows;
}

// Shallow signature ChartCore diffs to decide whether a row list changed (so it
// only setState's on real structural changes — add/remove/visibility/recolor).
function rowsSig(rows: LegendRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.name}${r.calcParamsText}:${r.visible ? 1 : 0}:${r.hideValue ? 1 : 0}:${
          r.warn ?? ""
        }:${r.summary ?? ""}:${r.figures.map((f) => f.key + f.color).join(",")}`,
    )
    .join("|");
}

// Build the candle-pane LegendRow list + its signature. ChartCore calls this on the
// 1s tick / indicatorRemoved and only setState's when the signature changes.
export function buildLegendRows(chart: Chart, tfLabel?: string): { rows: LegendRow[]; sig: string } {
  const panes = chart.getIndicatorByPaneId("candle_pane") as
    | Map<string, Indicator>
    | null
    | undefined;
  const lineStyles = chart.getStyles().indicator.lines;
  const legendTextColor = chart.getStyles().indicator.tooltip.text.color;
  const rows = rowsForPane(panes, lineStyles, legendTextColor, chart.getDataList(), tfLabel);
  return { rows, sig: rowsSig(rows) };
}

// Build the sub-pane legend list (every pane EXCEPT candle_pane), each positioned at
// its pane's main-area top via getSize. Returns the data array + a combined signature
// that folds in each pane's rows AND its `top` — so a separator drag (which only
// moves `top`) still re-renders the cards to their new positions, not just on
// add/remove. ChartCore gates setState on this signature like the candle rows.
export function buildSubPaneLegends(chart: Chart): {
  subPanes: SubPaneLegendData[];
  sig: string;
} {
  const all = chart.getIndicatorByPaneId() as
    | Map<string, Map<string, Indicator>>
    | null
    | undefined;
  const lineStyles = chart.getStyles().indicator.lines;
  const legendTextColor = chart.getStyles().indicator.tooltip.text.color;
  const subPanes: SubPaneLegendData[] = [];
  for (const [paneId, inds] of all ?? []) {
    if (paneId === "candle_pane") continue;
    const rows = rowsForPane(inds, lineStyles, legendTextColor).filter(
      (r) => !INTERNAL_INDICATORS.has(r.name),
    );
    // No card for a pane holding only internal indicators (e.g. the backtest equity
    // curve) — it would otherwise get a removable/editable card it shouldn't have,
    // and its canvas legend (which we don't blank for internals) would duplicate.
    if (!rows.length) continue;
    // getSize(paneId, "main").top is the pane's main-area y relative to the chart
    // root — exactly where klinecharts drew its canvas legend. Round to whole pixels
    // so the card text lands on the pixel grid (crisp, no half-pixel blur).
    const size = chart.getSize(paneId, DomPosition.Main);
    const top = Math.round(size?.top ?? 0);
    subPanes.push({ paneId, top, rows });
  }
  const sig = subPanes.map((sp) => `${sp.paneId}@${sp.top}#${rowsSig(sp.rows)}`).join("||");
  return { subPanes, sig };
}
