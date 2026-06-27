// Our TradingView-style toolbar over the klinecharts-core chart we own:
//  - instrument search   - timeframe bar
//  - SEARCHABLE indicator menu (built-ins + custom VWAP/AVWAP)
//  - drawing tools (klinecharts overlays)   - A/L price-scale toggles
//
// Everything drives the Chart instance directly via its public API.

import { useEffect, useRef, useState } from "react";
import {
  getSupportedIndicators,
  getSupportedOverlays,
  YAxisType,
} from "klinecharts";
import {
  PERIODS,
  PERIOD_GROUPS,
  type Instrument,
  type Period,
} from "./lib/feed";
import { ensureNotifyPermission, primeSound, toast } from "./lib/notify";
import { EQUITY_INDICATOR } from "./lib/backtest";
import {
  alertModalRequest,
  alertsPanelOpen,
  tradePanelOpen,
  symbolSearchRequest,
  drawingSettingsRequest,
} from "./lib/signals";
import {
  saveIndicators,
  loadFavoriteIndicators,
  saveFavoriteIndicators,
  saveSymbolTemplate,
  loadSymbolTemplate,
  deleteSymbolTemplate,
  saveDefaultTemplate,
  loadDefaultTemplate,
  deleteDefaultTemplate,
} from "./lib/persist";
import { addIndicatorInstance } from "./lib/indicators";
import {
  captureSymbolTemplate,
  applySymbolTemplate,
  captureDefaultTemplate,
  applyDefaultTemplate,
} from "./lib/templates";
import { indicatorInfo } from "./lib/indicatorMeta";
import IndicatorRow from "./IndicatorRow";
import type { ChartController } from "./lib/chartController";
import ContextMenu from "./ContextMenu";
import { BellIcon, MenuIcons } from "./lib/menuIcons";
import SymbolIcon from "./SymbolIcon";
import SymbolSearchModal from "./SymbolSearchModal";
import BacktestButton from "./BacktestButton";

interface DrawMenu {
  x: number;
  y: number;
  id: string;
  locked: boolean;
}

interface Props {
  // The FOCUSED cell's controller (its chart + overlays + per-cell signals). The
  // toolbar is a remote control over whichever cell currently has focus.
  controller: ChartController | null;
  // Undefined when no tab/cell is open (blank workspace). All chart-control paths
  // are gated behind a single guard; only the LayoutManager renders in that case.
  symbol?: Instrument;
  period?: Period;
  onSymbol: (s: Instrument) => void;
  onPeriod: (p: Period) => void;
  // Maximized view hides the tab bar; this toggle (the only chrome that survives)
  // flips it back. Backtest also lives here now so it stays reachable when maxed.
  maximized: boolean;
  onToggleMaximize: () => void;
}

// A few friendly labels for the most-used drawing overlays.
const DRAW_TOOLS: { name: string; label: string }[] = [
  { name: "horizontalStraightLine", label: "Horizontal line" },
  { name: "verticalStraightLine", label: "Vertical line" },
  { name: "straightLine", label: "Trend line" },
  { name: "rayLine", label: "Ray" },
  { name: "segment", label: "Segment" },
  { name: "priceLine", label: "Price line" },
  { name: "priceChannelLine", label: "Parallel channel" },
  { name: "fibonacciLine", label: "Fibonacci retracement" },
];

// Shared dropdown caret — the same SVG chevron the symbol chip uses, so every
// toolbar caret renders identically (replacing the plain "▾" text triangles that
// rendered in a different style beside the SVG one).
function Caret({ className }: { className?: string }) {
  return (
    <svg
      className={className ? `tb-caret ${className}` : "tb-caret"}
      viewBox="0 0 24 24" width="11" height="11" fill="none"
      stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export default function Toolbar({
  controller,
  symbol,
  period,
  onSymbol,
  onPeriod,
  maximized,
  onToggleMaximize,
}: Props) {
  // The toolbar drives the focused cell's chart + overlays.
  const chart = controller?.chart ?? null;
  const overlays = controller?.overlays ?? null;

  // instrument search (TV-style modal, opened by clicking the symbol name)
  const [symModalOpen, setSymModalOpen] = useState(false);

  // indicator menu. Add-only (TradingView-style): clicking a type ALWAYS adds a new
  // instance; there's no checkmark/active state anymore (an indicator can appear any
  // number of times). Removal is per-instance via the legend ⋯/trash.
  const [indOpen, setIndOpen] = useState(false);
  const [indFilter, setIndFilter] = useState("");
  // Starred indicator types (global preference), shown in the menu's Favorites
  // section. Seeded from localStorage; toggled by the per-row star.
  const [favIndicators, setFavIndicators] = useState<string[]>(loadFavoriteIndicators);

  // grouped interval menu (TV-style; quick-bar stays fixed)
  const [intervalOpen, setIntervalOpen] = useState(false);

  // per-symbol template menu (Save / Apply / Delete the symbol's default layout)
  const [tmplOpen, setTmplOpen] = useState(false);

  // dropdown wrappers (for outside-click close)
  const indMenuRef = useRef<HTMLDivElement>(null);
  const drawMenuRef = useRef<HTMLDivElement>(null);
  const intervalMenuRef = useRef<HTMLDivElement>(null);
  const tmplMenuRef = useRef<HTMLDivElement>(null);

  // drawing menu
  const [drawOpen, setDrawOpen] = useState(false);
  const [drawMenu, setDrawMenu] = useState<DrawMenu | null>(null);

  // price-scale
  const [log, setLog] = useState(false);
  // "A" auto-scale mode (mirrors the focused cell's signal; on = highlighted).
  const [auto, setAuto] = useState(controller?.autoScale.value ?? true);
  useEffect(() => {
    if (!controller) return;
    setAuto(controller.autoScale.value);
    return controller.autoScale.subscribe(setAuto);
  }, [controller]);
  const [panelOpen, setPanelOpen] = useState(alertsPanelOpen.value);
  useEffect(() => alertsPanelOpen.subscribe(setPanelOpen), []);
  const [tradeOpen, setTradeOpen] = useState(tradePanelOpen.value);
  useEffect(() => tradePanelOpen.subscribe(setTradeOpen), []);

  // App opens a fresh tab → prompt for its symbol (the new tab starts empty).
  useEffect(() => symbolSearchRequest.subscribe(() => setSymModalOpen(true)), []);

  // Legend-driven removals are owned by ChartCore (it updates the focused cell's
  // controller.indicators), and the active-set subscription above reflects them —
  // so the toolbar needs no separate indicatorRemoved listener anymore.

  // Close dropdowns on click outside. The ref wraps button+dropdown, so clicking
  // the toggle stays "inside" and doesn't fight the button's own onClick.
  useEffect(() => {
    if (!indOpen && !drawOpen && !intervalOpen && !tmplOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (indOpen && indMenuRef.current && !indMenuRef.current.contains(t)) setIndOpen(false);
      if (drawOpen && drawMenuRef.current && !drawMenuRef.current.contains(t)) setDrawOpen(false);
      if (intervalOpen && intervalMenuRef.current && !intervalMenuRef.current.contains(t))
        setIntervalOpen(false);
      if (tmplOpen && tmplMenuRef.current && !tmplMenuRef.current.contains(t))
        setTmplOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [indOpen, drawOpen, intervalOpen, tmplOpen]);

  // Right-clicking any overlay (drawn live or rehydrated) opens our context menu.
  // Bound to the FOCUSED cell's overlay manager; re-bind when focus changes.
  useEffect(() => {
    const ov = controller?.overlays;
    if (!ov) return;
    ov.setRightClickHandler((e) =>
      setDrawMenu({
        x: e.pageX ?? 0,
        y: e.pageY ?? 0,
        id: e.overlay.id,
        locked: e.overlay.lock,
      }),
    );
    return () => ov.setRightClickHandler(null);
  }, [controller]);

  // NOTE: indicator HYDRATION moved to ChartCore (each cell hydrates its own saved
  // set on mount, even when not focused). The toolbar only TOGGLES on the focused
  // chart and reflects controller.indicators (see the active-set subscription).

  // Menu lists indicator TYPES (the registered base types), not live instances —
  // per-instance template names (e.g. "EMA#a1b2") also appear in
  // getSupportedIndicators() and must NOT leak into the menu. A type leaks in iff
  // it has no "#": instance ids carry one.
  const allIndicators = getSupportedIndicators()
    .filter((n) => !n.includes("#"))
    .filter((n) => n !== EQUITY_INDICATOR); // driven by the Backtest button
  const matches = (n: string) => {
    const q = indFilter.toLowerCase();
    if (!q) return true;
    const { title } = indicatorInfo(n);
    return n.toLowerCase().includes(q) || title.toLowerCase().includes(q);
  };
  const filtered = allIndicators.filter(matches).sort();
  // Favorites section: starred types still present in the catalogue, in star order,
  // and matching the current search. Starred types ALSO remain in the main list.
  const favSet = new Set(favIndicators);
  const favShown = favIndicators.filter(
    (n) => allIndicators.includes(n) && matches(n),
  );

  // Star/unstar an indicator type (global preference). stopPropagation in the row
  // keeps this off the <li>'s add-indicator click.
  function toggleFavIndicator(type: string) {
    setFavIndicators((prev) => {
      const next = prev.includes(type)
        ? prev.filter((t) => t !== type)
        : [...prev, type];
      saveFavoriteIndicators(next);
      return next;
    });
  }

  // Add a fresh instance of `type` on the FOCUSED cell (TradingView-style: clicking
  // the menu ALWAYS adds another, never toggles off — removal is per-instance via
  // the legend ⋯/trash). Mirrors controller.indicators + persists per the cell's
  // scope. The create mechanics live in lib/indicators so ChartCore's hydration
  // uses the exact same path.
  function addIndicator(type: string) {
    if (!chart || !controller || !symbol) return;
    const inst = addIndicatorInstance(chart, controller.scope, symbol.epic, type);
    if (!inst) return;
    const next = [...controller.indicators.value, inst];
    controller.indicators.set(next);
    saveIndicators(controller.scope, next);
    // A fresh AVWAP is unplaced (no line). Close the menu and enter anchor mode for
    // THIS instance so the user's next chart click places it (TradingView-style).
    if (type === "AVWAP") {
      setIndOpen(false);
      controller.avwapAnchorMode.set(inst.id);
    }
  }

  // --- per-symbol templates (Save / Apply / Delete the symbol's default layout) --
  // All act on the FOCUSED cell's scope + the current symbol's epic. Save snapshots
  // the cell's current layout (overwriting the symbol's single default); Apply
  // replaces the cell's layout with it (clearFirst, since the cell may be populated);
  // Delete removes the symbol's default so fresh charts start blank again.
  function saveTemplate() {
    if (!controller || !symbol) return;
    saveSymbolTemplate(captureSymbolTemplate(controller.scope, symbol.epic));
    setTmplOpen(false);
    toast(`Saved ${symbol.epic} template`);
  }

  function applyTemplate() {
    if (!chart || !controller || !symbol) return;
    const t = loadSymbolTemplate(symbol.epic);
    if (!t) return;
    applySymbolTemplate(chart, controller, controller.scope, symbol.epic, t, {
      clearFirst: true,
    });
    setTmplOpen(false);
    toast(`Applied ${symbol.epic} template`);
  }

  function deleteTemplate() {
    if (!symbol) return;
    deleteSymbolTemplate(symbol.epic);
    setTmplOpen(false);
    toast(`Deleted ${symbol.epic} template`);
  }

  // --- global default template (symbol-agnostic) -------------------------------
  // Saves the focused cell's indicators as THE default applied to every fresh
  // chart (any symbol). Drawings/anchors are stripped at capture (see templates.ts).
  function saveDefault() {
    if (!controller) return;
    saveDefaultTemplate(captureDefaultTemplate(controller.scope));
    setTmplOpen(false);
    toast("Saved default template");
  }

  function applyDefault() {
    if (!chart || !controller || !symbol) return;
    const d = loadDefaultTemplate();
    if (!d) return;
    applyDefaultTemplate(chart, controller, controller.scope, symbol.epic, d, {
      clearFirst: true,
    });
    setTmplOpen(false);
    toast("Applied default template");
  }

  function clearDefault() {
    deleteDefaultTemplate();
    setTmplOpen(false);
    toast("Cleared default template");
  }

  function addDrawing(name: string) {
    overlays?.addDrawing(name);
    setDrawOpen(false);
  }

  function clearDrawings() {
    overlays?.clearDrawings();
    setDrawOpen(false);
  }

  function unlockAll() {
    // Locked overlays stop responding to events, so they can't be unlocked by
    // right-click — this is the escape hatch.
    overlays?.unlockAll();
    setDrawOpen(false);
  }

  // Copy the right-clicked drawing to the system clipboard, in the same tagged
  // envelope ChartCore's Ctrl/Cmd+C uses, so menu-copy and keyboard-copy are
  // interchangeable (and a menu-copied drawing pastes with Ctrl/Cmd+V).
  function copyDrawing(id: string) {
    const d = overlays?.getDrawing(id);
    if (!d) return;
    const payload = {
      __autoTraderDrawing: 1 as const,
      name: d.name,
      points: d.points,
      styles: d.styles,
      visible: d.visible,
      zLevel: d.zLevel,
      extendData: d.extendData,
    };
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  }

  // Clone in place: duplicate the drawing offset a little (the chart-side ⌘-drag
  // clone reuses this via placeDrawing too). Offset by a small price delta only —
  // a menu clone has no drag, so just nudge it so it's visibly distinct.
  function cloneDrawing(id: string) {
    const d = overlays?.getDrawing(id);
    if (!d) return;
    overlays?.placeDrawing({
      name: d.name,
      points: d.points.map((p) => ({
        timestamp: p.timestamp,
        value: p.value != null ? p.value * 0.9975 : p.value,
      })),
      styles: d.styles,
      visible: d.visible,
      zLevel: d.zLevel,
      extendData: d.extendData,
    });
  }

  const drawMenuItems = drawMenu
    ? [
        { label: "Settings", icon: MenuIcons.settings, onClick: () => drawingSettingsRequest.set({ id: drawMenu.id }) },
        { label: "Clone", icon: MenuIcons.clone, onClick: () => cloneDrawing(drawMenu.id) },
        { label: "Copy", icon: MenuIcons.copy, onClick: () => copyDrawing(drawMenu.id) },
        { label: "Bring to front", icon: MenuIcons.bringFront, onClick: () => overlays?.bringToFront(drawMenu.id) },
        { label: "Send to back", icon: MenuIcons.sendBack, onClick: () => overlays?.sendToBack(drawMenu.id) },
        {
          label: drawMenu.locked ? "Unlock" : "Lock",
          icon: drawMenu.locked ? MenuIcons.unlock : MenuIcons.lock,
          onClick: () => overlays?.setLock(drawMenu.id, !drawMenu.locked),
        },
        {
          label: "Delete",
          icon: MenuIcons.remove,
          danger: true,
          onClick: () => overlays?.remove(drawMenu.id),
        },
      ]
    : [];

  function setScale(type: YAxisType) {
    chart?.setStyles({ yAxis: { type } });
    setLog(type === YAxisType.Log);
  }

  function autoFit() {
    // klinecharts auto-fits the price axis to visible bars; re-applying the
    // axis style recomputes the range, clearing any manual zoom ("fit to data").
    chart?.setStyles({ yAxis: { type: log ? YAxisType.Log : YAxisType.Normal } });
    // Re-enter auto mode (TV-style): stays highlighted until the user manually
    // scales the price axis again (ChartCore flips it back off).
    controller?.autoScale.set(true);
  }

  // Blank workspace (no open tab/cell): the chart controls have nothing to act on,
  // so render just the layout manager — the user opens or creates a layout from it.
  // After this guard TypeScript narrows symbol/period to non-undefined, so the
  // full toolbar below reads them without churn. The workspace-level controls
  // (layouts, split, theme, backtest) now live in the tab bar, so a blank
  // workspace simply has no per-chart toolbar.
  if (!symbol || !period) {
    return <header className="toolbar toolbar-empty" />;
  }

  return (
    <header className="toolbar">
      {/* Editable symbol name (TV-style): click to open the symbol-search modal.
          A resting chip + search icon make the clickability obvious at a glance. */}
      <button
        className="sym"
        title="Change symbol"
        onClick={() => setSymModalOpen(true)}
      >
        <SymbolIcon epic={symbol.epic} type={symbol.type} className="sym-logo" />
        <span className="sym-epic">{symbol.epic}</span>
        <svg className="sym-caret" viewBox="0 0 24 24" width="12" height="12" fill="none"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <span className="tb-div" aria-hidden="true" />

      <div className="periods">
        {PERIODS.map((p) => (
          <button
            key={p.resolution}
            className={p.resolution === period.resolution ? "on" : ""}
            title={`${p.label} interval`}
            onClick={() => onPeriod(p)}
          >
            {p.label}
          </button>
        ))}
        {/* When the active interval isn't on the quick-bar (e.g. a seconds TF),
            surface it as a highlighted chip just left of the dropdown toggle. */}
        {PERIODS.every((p) => p.resolution !== period.resolution) && (
          <button
            className="on extra-period"
            title={`${period.label} interval`}
            onClick={() => setIntervalOpen((v) => !v)}
          >
            {period.label}
          </button>
        )}
        {/* TV-style grouped interval menu (adds the live-only seconds group). */}
        <div className="menu interval-menu" ref={intervalMenuRef}>
          <button
            className="interval-toggle"
            title="Chart interval"
            onClick={() => setIntervalOpen((v) => !v)}
          >
            <Caret />
          </button>
          {intervalOpen && (
            <div className="dropdown interval-dropdown">
              {PERIOD_GROUPS.map((g) => (
                <div key={g.label} className="interval-group">
                  <div className="interval-group-label">{g.label}</div>
                  <ul>
                    {g.periods.map((p) => (
                      <li
                        key={p.resolution}
                        className={p.resolution === period.resolution ? "on" : ""}
                        onClick={() => {
                          onPeriod(p);
                          setIntervalOpen(false);
                        }}
                      >
                        {p.label}
                        {p.liveOnly && <span className="live-only">live</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <span className="tb-div" aria-hidden="true" />

      {/* Searchable indicator menu */}
      <div className="menu" ref={indMenuRef}>
        <button
          className={indOpen ? "on" : ""}
          title="Indicators, metrics, and strategies"
          onClick={() => setIndOpen((v) => !v)}
        >
          ƒ Indicators<Caret />
        </button>
        {indOpen && (
          <div className="dropdown dropdown-ind">
            <div className="ind-search">
              <input
                autoFocus
                placeholder="search indicators…"
                title="Search indicators"
                value={indFilter}
                onChange={(e) => setIndFilter(e.target.value)}
              />
              {indFilter && (
                <button
                  className="ind-search-clear"
                  title="Clear"
                  onClick={() => setIndFilter("")}
                >
                  ✕
                </button>
              )}
            </div>
            <ul>
              {favShown.length > 0 && (
                <>
                  <li className="ind-section">Favorites</li>
                  {favShown.map((name) => (
                    <IndicatorRow
                      key={`fav-${name}`}
                      name={name}
                      favorite
                      onAdd={() => addIndicator(name)}
                      onToggleFavorite={() => toggleFavIndicator(name)}
                    />
                  ))}
                  <li className="ind-section">All</li>
                </>
              )}
              {filtered.map((name) => (
                <IndicatorRow
                  key={name}
                  name={name}
                  favorite={favSet.has(name)}
                  onAdd={() => addIndicator(name)}
                  onToggleFavorite={() => toggleFavIndicator(name)}
                />
              ))}
              {filtered.length === 0 && <li className="empty">no match</li>}
            </ul>
          </div>
        )}
      </div>

      {/* Drawing tools */}
      <div className="menu" ref={drawMenuRef}>
        <button
          className={drawOpen ? "on" : ""}
          title="Drawing tools"
          onClick={() => setDrawOpen((v) => !v)}
        >
          ✎ Draw<Caret />
        </button>
        {drawOpen && (
          <div className="dropdown">
            <ul>
              {DRAW_TOOLS.filter((t) => getSupportedOverlays().includes(t.name)).map(
                (t) => (
                  <li key={t.name} onClick={() => addDrawing(t.name)}>
                    {t.label}
                  </li>
                ),
              )}
              <li onClick={unlockAll}>↺ Unlock all drawings</li>
              <li onClick={clearDrawings}>— Clear all drawings —</li>
            </ul>
          </div>
        )}
      </div>

      <span className="tb-div" aria-hidden="true" />

      {/* Open the TV-style alert modal, prefilled with the last price. The bell is
          an inline SVG (currentColor) so it stays monochrome, not a colored emoji. */}
      <button
        className="anchor-btn icon-btn"
        title="Create a price alert"
        onClick={() => {
          // This click is a user gesture: unlock audio so later (programmatic)
          // pings can sound, and request OS-notification permission. Surface the
          // outcome so the user knows whether banners will actually appear.
          primeSound();
          ensureNotifyPermission().then((perm) => {
            if (perm === "denied")
              toast("OS alerts blocked — alerts will show in this tab only");
            else if (perm === "unsupported")
              toast("OS alerts unsupported here — alerts will show in this tab");
          });
          const dl = chart?.getDataList();
          const last = dl && dl.length ? dl[dl.length - 1].close : 0;
          alertModalRequest.set({ price: last });
        }}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <path d="M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        Alert
      </button>

      {/* Price-scale A / L (auto-fit, logarithmic) */}
      <div className="scale">
        <button
          title="Auto (fits data to screen)"
          className={auto ? "on" : ""}
          onClick={autoFit}
        >
          A
        </button>
        <button
          title="Logarithmic scale"
          className={log ? "on" : ""}
          onClick={() => setScale(log ? YAxisType.Normal : YAxisType.Log)}
        >
          L
        </button>
      </div>

      {/* Per-symbol template: save/apply/delete the symbol's default layout. Labels
          carry the live epic so it's clear which symbol they act on (TV-style
          "apply default to <symbol>"). Auto-applies to fresh charts of the symbol.
          First of the right-side cluster (margin-left:auto via .tmpl-menu) so the
          template / backtest / workspace-layouts / layout cluster sits at the far
          right; dropdown right-aligned so it doesn't spill off-screen. */}
      <div className="menu tmpl-menu" ref={tmplMenuRef}>
        <button
          className={tmplOpen ? "on" : ""}
          title={`Save or apply the default layout (indicators + drawings) for ${symbol.epic}`}
          onClick={() => setTmplOpen((v) => !v)}
        >
          <span className="tmpl-ic">{MenuIcons.clone}</span>
          Template
          <Caret className="tmpl-caret" />
        </button>
        {tmplOpen && (
          <div className="dropdown dropdown-right tmpl-dropdown">
            <ul>
              <li onClick={saveTemplate}>
                <span className="tmpl-ic">{MenuIcons.save}</span>
                Save {symbol.epic} template
              </li>
              {loadSymbolTemplate(symbol.epic) ? (
                <>
                  <li onClick={applyTemplate}>
                    <span className="tmpl-ic">{MenuIcons.apply}</span>
                    Apply {symbol.epic} template
                  </li>
                  <li onClick={deleteTemplate}>
                    <span className="tmpl-ic">{MenuIcons.remove}</span>
                    Delete {symbol.epic} template
                  </li>
                </>
              ) : (
                <li className="empty">no saved template</li>
              )}
              <li className="sep" />
              {/* Global default: indicators auto-added to every fresh chart,
                  regardless of symbol (e.g. Volume). The ★ marks it as the
                  symbol-agnostic default. */}
              <li onClick={saveDefault}>
                <span className="tmpl-ic">{MenuIcons.star}</span>
                Save as default template
              </li>
              {loadDefaultTemplate() ? (
                <>
                  <li onClick={applyDefault}>
                    <span className="tmpl-ic">{MenuIcons.apply}</span>
                    Apply default template
                  </li>
                  <li onClick={clearDefault}>
                    <span className="tmpl-ic">{MenuIcons.remove}</span>
                    Clear default template
                  </li>
                </>
              ) : (
                <li className="empty">no default template</li>
              )}
            </ul>
          </div>
        )}
      </div>

      {/* Backtest lives here (moved off the tab bar) so it survives maximized
          view. controller/period/symbol are already in toolbar scope. */}
      <BacktestButton
        controller={controller}
        period={period}
        epic={symbol.epic}
      />

      {/* Alerts panel toggle (bell). */}
      <button
        className={`anchor-btn alerts-toggle${panelOpen ? " on" : ""}`}
        title="Show alerts panel"
        onClick={() => alertsPanelOpen.set(!alertsPanelOpen.value)}
      >
        <BellIcon size={16} />
      </button>

      {/* Trading panel toggle (order ticket + positions). Paper trading. */}
      <button
        className={`anchor-btn trade-toggle${tradeOpen ? " on" : ""}`}
        title="Show trading panel (paper)"
        onClick={() => tradePanelOpen.set(!tradePanelOpen.value)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <path d="M3 17l6-6 4 4 7-7M14 8h5v5" />
        </svg>
      </button>

      {/* Maximize / restore: hides the tab bar to focus the active tab. Icon
          reflects state (expand when normal, compress when maximized). */}
      <button
        className={`anchor-btn maximize-toggle${maximized ? " on" : ""}`}
        title={maximized ? "Exit maximized view (Esc)" : "Maximize view"}
        onClick={onToggleMaximize}
      >
        {maximized ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <path d="M9 9H4m5 0V4m0 5L4 4m11 5h5m-5 0V4m0 5 5-5M9 15H4m5 0v5m0-5-5 5m11-5h5m-5 0v5m0-5 5 5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        )}
      </button>

      {symModalOpen && (
        <SymbolSearchModal
          current={symbol}
          onPick={onSymbol}
          onClose={() => setSymModalOpen(false)}
        />
      )}

      {drawMenu && (
        <ContextMenu
          x={drawMenu.x}
          y={drawMenu.y}
          items={drawMenuItems}
          onClose={() => setDrawMenu(null)}
        />
      )}
    </header>
  );
}
