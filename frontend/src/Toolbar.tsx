// Our TradingView-style toolbar over the klinecharts-core chart we own:
//  - instrument search   - timeframe bar
//  - SEARCHABLE indicator menu (built-ins + custom VWAP/AVWAP)
//  - A/L price-scale toggles
//
// Drawing tools, magnet, and measure now live in DrawSidebar; this toolbar
// still owns the right-click drawing context menu (Lock/Settings/Delete).
// Everything drives the Chart instance directly via its public API.

import { useEffect, useRef, useState } from "react";
import { getSupportedIndicators } from "klinecharts";
import { type Instrument, type Period } from "./lib/feed";
import type { PriceSide } from "./theme";
import { ensureNotifyPermission, primeSound, toast } from "./lib/notify";
import { EQUITY_INDICATOR } from "./lib/backtest";
import {
  alertModalRequest,
  symbolSearchRequest,
  drawingSettingsRequest,
  saveDefaultTemplateRequest,
  snapshotsGalleryOpen,
} from "./lib/signals";
import {
  saveIndicators,
  loadFavoriteIndicators,
  saveFavoriteIndicators,
  loadSymbolTemplate,
  saveDefaultTemplate,
  loadDefaultTemplate,
  deleteDefaultTemplate,
  loadIndicators,
  loadIndicatorConfigs,
} from "./lib/persist";
import { saveSnapshotOfChart } from "./lib/snapshotSave";
import Snackbar from "./Snackbar";
import { addIndicatorInstance, isSubPaneIndicator, isInternalIndicator } from "./lib/indicators";
import {
  applySymbolTemplate,
  captureDefaultTemplate,
  applyDefaultTemplate,
} from "./lib/templates";
import { indicatorInfo } from "./lib/indicatorMeta";
import IndicatorRow from "./IndicatorRow";
import type { ChartController } from "./lib/chartController";
import ContextMenu from "./ContextMenu";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import { MenuIcons } from "./lib/menuIcons";
import {
  Caret,
  SymbolChip,
  IntervalControls,
  ScaleControls,
  PanelToggles,
  MaximizeToggle,
} from "./ToolbarControls";
import SymbolSearchModal from "./SymbolSearchModal";
import BacktestButton from "./BacktestButton";
import BrokerSelector from "./BrokerSelector";
import { isDataOnlyBroker, type BrokerAccount } from "./lib/trading";
import { isSynthetic } from "./lib/syntheticRegistry";

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
  // Active data broker id ("capital"), derived from the active account. Passed to
  // the symbol-search modal so it browses the right broker's catalogue. The broker
  // SELECTOR normally lives in the tab bar (switching broker swaps the whole
  // workspace — a tab-bar/workspace-scope action), but the tab bar is hidden when
  // maximized, so we ALSO render the selector here in that case (see below) so the
  // broker stays switchable. `accounts` + `onSelectBroker` feed that fallback.
  brokerId: string;
  // The chart's active price side — forwarded to the backtest so it fetches the
  // same candle series the chart displays (the cache is per side).
  priceSide: PriceSide;
  accounts: BrokerAccount[];
  onSelectBroker: (broker: string) => void;
  // Maximized view hides the tab bar; this toggle (the only chrome that survives)
  // flips it back. Backtest also lives here now so it stays reachable when maxed.
  maximized: boolean;
  onToggleMaximize: () => void;
}

export default function Toolbar({
  controller,
  symbol,
  period,
  onSymbol,
  onPeriod,
  brokerId,
  priceSide,
  accounts,
  onSelectBroker,
  maximized,
  onToggleMaximize,
}: Props) {
  // The toolbar drives the focused cell's chart + overlays. (A cell restored
  // FROM a snapshot never reaches this component — App renders SnapshotToolbar
  // instead while controller.readOnly is set — so nothing here needs a
  // read-only gate.)
  const chart = controller?.chart ?? null;
  const overlays = controller?.overlays ?? null;

  // instrument search (TV-style modal, opened by clicking the symbol name)
  const [symModalOpen, setSymModalOpen] = useState(false);

  // indicator menu. Add-only (TradingView-style): clicking a type ALWAYS adds a new
  // instance; there's no checkmark/active state anymore (an indicator can appear any
  // number of times). Removal is per-instance via the legend ⋯/trash.
  const [indOpen, setIndOpen] = useState(false);
  const [snapSavedName, setSnapSavedName] = useState<string | null>(null);
  const [indFilter, setIndFilter] = useState("");
  // Starred indicator types (global preference), shown in the menu's Favorites
  // section. Seeded from localStorage; toggled by the per-row star.
  const [favIndicators, setFavIndicators] = useState<string[]>(loadFavoriteIndicators);

  // per-symbol template menu (Save / Apply / Delete the symbol's default layout)
  const [tmplOpen, setTmplOpen] = useState(false);

  // dropdown wrappers (for outside-click close)
  const indMenuRef = useRef<HTMLDivElement>(null);
  const tmplMenuRef = useRef<HTMLDivElement>(null);

  // drawing right-click context menu (Lock/Settings/Delete etc — the tools that
  // CREATE drawings now live in DrawSidebar; this menu still fires from the chart).
  const [drawMenu, setDrawMenu] = useState<DrawMenu | null>(null);

  // App opens a fresh tab → prompt for its symbol (the new tab starts empty).
  useEffect(() => symbolSearchRequest.subscribe(() => setSymModalOpen(true)), []);

  // Legend-driven removals are owned by ChartCore (it updates the focused cell's
  // controller.indicators), and the active-set subscription above reflects them —
  // so the toolbar needs no separate indicatorRemoved listener anymore.

  // Close dropdowns on click outside. The ref wraps button+dropdown, so clicking
  // the toggle stays "inside" and doesn't fight the button's own onClick.
  useEffect(() => {
    if (!indOpen && !tmplOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (indOpen && indMenuRef.current && !indMenuRef.current.contains(t)) setIndOpen(false);
      if (tmplOpen && tmplMenuRef.current && !tmplMenuRef.current.contains(t))
        setTmplOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [indOpen, tmplOpen]);

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
  // Internal names are excluded: EQUITY (driven by the Backtest button), the
  // SLOPE_ACCEL base type and its "<parent>__accel" companion instances (driven
  // by the Slope's "Show acceleration pane" toggle, never added directly).
  const allIndicators = getSupportedIndicators()
    .filter((n) => !n.includes("#"))
    .filter((n) => n !== EQUITY_INDICATOR && n !== "SLOPE_ACCEL" && !isInternalIndicator(n));
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
    const inst = addIndicatorInstance(chart, controller.scope, symbol.epic, type, {
      forceHidden: controller.indicatorsHidden.value,
    });
    if (!inst) return;
    // Adding a sub-pane indicator while the bottom panes are collapsed (double-click
    // "hide sub-panes") auto-expands them — you'd otherwise add an oscillator and see
    // nothing. Also keeps collapse-capture honest (it must run from an expanded state).
    if (controller.subPanesHidden.value && isSubPaneIndicator(type))
      controller.subPanesHidden.set(false);
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
  // MERGES it into the cell — adds what's missing, skips equivalents, never touches existing work;
  // Delete removes the symbol's default so fresh charts start blank again.
  function applyTemplate() {
    if (!chart || !controller || !symbol) return;
    const t = loadSymbolTemplate(symbol.epic);
    if (!t) return;
    applySymbolTemplate(chart, controller, controller.scope, symbol.epic, t);
    setTmplOpen(false);
    toast(`Applied ${symbol.epic} template`);
  }

  // --- global default template (symbol-agnostic) -------------------------------
  // Opens the selectable picker: the user checks which of this chart's
  // symbol-agnostic indicators become THE default applied to every fresh chart
  // (any symbol). Drawings/anchors are stripped at capture (see templates.ts).
  function saveDefault() {
    if (!controller) return;
    const scope = controller.scope;
    const configs = loadIndicatorConfigs(scope);
    const candidates = loadIndicators(scope)
      .filter((inst) => inst.type !== "AVWAP")
      .map((inst) => {
        const params = (configs[inst.id]?.calcParams ?? []) as unknown[];
        return {
          id: inst.id,
          label: inst.type,
          params: params.length ? params.join(", ") : "—",
        };
      });
    setTmplOpen(false);
    saveDefaultTemplateRequest.set({
      candidates,
      onConfirm: (ids) => {
        saveDefaultTemplate(captureDefaultTemplate(scope, new Set(ids)));
        toast("Saved default template");
      },
    });
  }

  function applyDefault() {
    if (!chart || !controller || !symbol) return;
    const d = loadDefaultTemplate();
    if (!d) return;
    applyDefaultTemplate(chart, controller, controller.scope, symbol.epic, d);
    setTmplOpen(false);
    toast("Applied default template");
  }

  function clearDefault() {
    deleteDefaultTemplate();
    setTmplOpen(false);
    toast("Cleared default template");
  }

  // --- snapshots: instant capture of the focused cell's state ------------------
  // Camera saves immediately (no dialog); a snackbar anchored under the control
  // confirms and offers "View" (opens the gallery).
  const saveSnapshot_ = async () => {
    if (!chart || !controller || !symbol || !period) return;
    const snap = await saveSnapshotOfChart(chart, controller.scope, symbol, period);
    if (!snap) {
      toast("Chart not ready — nothing to snapshot");
      return;
    }
    setSnapSavedName(snap.name);
  };

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
      <SymbolChip
        symbol={symbol}
        title="Change symbol"
        onClick={() => setSymModalOpen(true)}
      />

      <span className="tb-div" aria-hidden="true" />

      <IntervalControls period={period} onPeriod={onPeriod} />

      <span className="tb-div" aria-hidden="true" />

      {/* Searchable indicator menu. */}
      <div className="menu" ref={indMenuRef}>
        <Tooltip content="Indicators, metrics, and strategies">
          <button
            className={indOpen ? "on" : ""}
            onClick={() => setIndOpen((v) => !v)}
          >
            ƒ Indicators<Caret />
          </button>
        </Tooltip>
        {indOpen && (
          <div className="dropdown dropdown-ind">
            <div className="ind-search">
              <Tooltip content="Search indicators">
                <input
                  autoFocus
                  placeholder="search indicators…"
                  value={indFilter}
                  onChange={(e) => setIndFilter(e.target.value)}
                />
              </Tooltip>
              {indFilter && (
                <Tooltip content="Clear">
                  <button
                    className="ind-search-clear"
                    onClick={() => setIndFilter("")}
                  >
                    ✕
                  </button>
                </Tooltip>
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

      {/* Synthetic charts are alert-free: history-only, so a price alert on them
          would never fire. Hide the divider along with the button so no orphan
          separator remains. */}
      {!isSynthetic(symbol.epic) && (
        <>
          <span className="tb-div" aria-hidden="true" />

          {/* Open the TV-style alert modal, prefilled with the last price. The bell is
              an inline SVG (currentColor) so it stays monochrome, not a colored emoji. */}
          <Tooltip content="Create a price alert">
          <button
            className="anchor-btn icon-btn"
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
          </Tooltip>
        </>
      )}

      {/* Price-scale A / L / I (auto-fit, logarithmic, invert) */}
      <ScaleControls controller={controller} />

      {/* Snapshots: ONE split control. The camera face saves instantly; the
          slim caret on its right edge opens the gallery. Sits just before the
          Template menu in the right-side cluster. */}
      <div className="snap-split">
        <Tooltip content="Save a snapshot of this chart: state, drawings, indicators">
          <button
            className="anchor-btn snap-save"
            disabled={!chart || !symbol || !period}
            onClick={() => void saveSnapshot_()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip content="Browse saved snapshots">
          <button
            className="anchor-btn snap-gallery"
            onClick={() => snapshotsGalleryOpen.set(true)}
          >
            <Caret />
          </button>
        </Tooltip>
      </div>
      {snapSavedName && (
        <Snackbar
          message={`Snapshot saved — ${snapSavedName}`}
          actionLabel="View"
          onAction={() => {
            setSnapSavedName(null);
            snapshotsGalleryOpen.set(true);
          }}
          onDismiss={() => setSnapSavedName(null)}
          duration={5000}
          anchorSelector=".snap-split"
        />
      )}

      {/* Per-symbol template: save/apply/delete the symbol's default layout. Labels
          carry the live epic so it's clear which symbol they act on (TV-style
          "apply default to <symbol>"). Auto-applies to fresh charts of the symbol.
          Dropdown right-aligned so it doesn't spill off-screen. */}
      <div className="menu tmpl-menu" ref={tmplMenuRef}>
        <Tooltip content={`Save or apply the default layout (indicators, drawings) for ${symbol.epic}`}>
          <button
            className={tmplOpen ? "on" : ""}
            onClick={() => setTmplOpen((v) => !v)}
          >
            <span className="tmpl-ic">{MenuIcons.clone}</span>
            Template
            <Caret className="tmpl-caret" />
          </button>
        </Tooltip>
        {tmplOpen && (
          <div className="dropdown dropdown-right tmpl-dropdown">
            <ul>
              {loadSymbolTemplate(symbol.epic) ? (
                <li onClick={applyTemplate}>
                  <span className="tmpl-ic">{MenuIcons.apply}</span>
                  <span className="ind-name">Apply {symbol.epic} template</span>
                  <InfoTip
                    title={`Apply ${symbol.epic} template`}
                    text="Adds the template's indicators and drawings that are missing from this chart. What's already here is never changed or removed."
                  />
                </li>
              ) : (
                <li className="empty">no saved template</li>
              )}
              <li className="sep" />
              {/* Global default: indicators auto-added to every fresh chart,
                  regardless of symbol (e.g. Volume). The ★ marks it as the
                  symbol-agnostic default. */}
              <li onClick={saveDefault}>
                <span className="tmpl-ic">{MenuIcons.star}</span>
                <span className="ind-name">Save as default template</span>
                <InfoTip
                  title="Save as default template"
                  text="Saves this chart's indicators (drawings and AVWAPs excluded) as the default for every symbol. Fresh charts without their own template start with it."
                />
              </li>
              {loadDefaultTemplate() ? (
                <>
                  <li onClick={applyDefault}>
                    <span className="tmpl-ic">{MenuIcons.apply}</span>
                    <span className="ind-name">Apply default template</span>
                    <InfoTip
                      title="Apply default template"
                      text="Adds the default indicators that are missing from this chart. Existing indicators and drawings are untouched."
                    />
                  </li>
                  <li onClick={clearDefault}>
                    <span className="tmpl-ic">{MenuIcons.remove}</span>
                    <span className="ind-name">Clear default template</span>
                    <InfoTip
                      title="Clear default template"
                      text="Removes the shared default. Fresh charts start blank unless their symbol has its own template."
                    />
                  </li>
                </>
              ) : (
                <li className="empty">no default template</li>
              )}
            </ul>
          </div>
        )}
      </div>

      {/* Broker selector — ONLY when maximized. It normally lives in the tab bar
          (a workspace-scope control), but maximizing hides the tab bar, so we
          surface it here (the surviving chrome) so the broker stays switchable.
          Omitted in normal view to avoid two selectors. */}
      {maximized && (
        <BrokerSelector
          accounts={accounts}
          activeBroker={brokerId}
          onChange={onSelectBroker}
        />
      )}

      {/* Backtest + Live sit together here (kept off the tab bar so they survive
          maximized view): backtest a rule strategy, then arm the same strategy
          live against a broker account. controller/period/symbol are in scope. */}
      <BacktestButton
        controller={controller}
        period={period}
        epic={symbol.epic}
        brokerId={brokerId}
        priceSide={priceSide}
      />

      <PanelToggles dataOnly={isDataOnlyBroker(brokerId)} />
      <MaximizeToggle maximized={maximized} onToggleMaximize={onToggleMaximize} />

      {symModalOpen && (
        <SymbolSearchModal
          current={symbol}
          brokerId={brokerId}
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
