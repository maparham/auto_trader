// Toolbar building blocks shared by the two toolbar variants: the full Toolbar
// (normal charts) and SnapshotToolbar (read-only snapshot views). Each block is
// self-contained — it owns its local state and signal subscriptions — so both
// toolbars compose the exact same DOM for the controls they have in common.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  PERIOD_GROUPS,
  quickBarPeriods,
  DEFAULT_RESOLUTIONS,
  type Instrument,
  type Period,
} from "./lib/feed";
import {
  alertsPanelOpen,
  tradePanelOpen,
  livePanelOpen,
} from "./lib/signals";
import {
  loadFavoriteResolutions,
  saveFavoriteResolutions,
} from "./lib/persist";
import type { ChartController } from "./lib/chartController";
import { BellIcon } from "./lib/menuIcons";
import SymbolIcon from "./SymbolIcon";
import Tooltip from "./components/Tooltip";
import { isSynthetic } from "./lib/syntheticRegistry";

// Shared dropdown caret — the same SVG chevron the symbol chip uses, so every
// toolbar caret renders identically (replacing the plain "▾" text triangles that
// rendered in a different style beside the SVG one).
export function Caret({ className }: { className?: string }) {
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

// The toolbar's symbol chip (TV-style resting chip: logo + epic + chevron).
// The full Toolbar makes it clickable (opens the symbol-search modal); the
// snapshot toolbar renders it disabled (the snapshot is OF this symbol).
export function SymbolChip({
  symbol,
  title,
  disabled,
  onClick,
}: {
  symbol: Instrument;
  title: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Tooltip content={title}>
      <button className="sym" disabled={disabled} onClick={onClick}>
        <SymbolIcon epic={symbol.epic} type={symbol.type} className="sym-logo" />
        <span className="sym-epic">
          {isSynthetic(symbol.epic) ? (symbol.name ?? symbol.epic) : symbol.epic}
        </span>
        <svg className="sym-caret" viewBox="0 0 24 24" width="12" height="12" fill="none"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </Tooltip>
  );
}

// Timeframe controls: the merged quick bar (defaults ∪ pinned favorites) plus the
// TV-style grouped interval dropdown with its per-row favourite stars.
export function IntervalControls({
  period,
  onPeriod,
}: {
  period: Period;
  onPeriod: (p: Period) => void;
}) {
  // Favorite timeframes (global preference), merged with the defaults to form the
  // quick bar. Seeded from localStorage; toggled via the per-row star in the
  // interval dropdown (defaults are always present and have no star).
  const [favResolutions, setFavResolutions] = useState<string[]>(loadFavoriteResolutions);

  // grouped interval menu (TV-style; quick-bar stays fixed)
  const [intervalOpen, setIntervalOpen] = useState(false);
  const intervalMenuRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on click outside. The ref wraps button+dropdown, so
  // clicking the toggle stays "inside" and doesn't fight the button's own onClick.
  useEffect(() => {
    if (!intervalOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (intervalMenuRef.current && !intervalMenuRef.current.contains(t))
        setIntervalOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [intervalOpen]);

  // Pin/unpin a timeframe on the quick bar (global preference). Defaults are never
  // passed here — their buttons/rows offer no context action.
  function toggleFavResolution(resolution: string) {
    setFavResolutions((prev) => {
      const next = prev.includes(resolution)
        ? prev.filter((r) => r !== resolution)
        : [...prev, resolution];
      saveFavoriteResolutions(next);
      return next;
    });
  }

  // Merged quick bar: defaults (1m–1W) ∪ pinned favorites, duration-sorted.
  const quickBar = quickBarPeriods(favResolutions);

  return (
    <div className="periods">
      {quickBar.map((p) => (
        <Tooltip key={p.resolution} content={`${p.label} interval`}>
          <button
            className={p.resolution === period.resolution ? "on" : ""}
            onClick={() => onPeriod(p)}
          >
            {p.label}
          </button>
        </Tooltip>
      ))}
      {/* When the active interval isn't on the quick-bar (e.g. a seconds TF),
          surface it as a highlighted chip just left of the dropdown toggle. */}
      {quickBar.every((p) => p.resolution !== period.resolution) && (
        <Tooltip content={`${period.label} interval`}>
          <button
            className="on extra-period"
            onClick={() => setIntervalOpen((v) => !v)}
          >
            {period.label}
          </button>
        </Tooltip>
      )}
      {/* TV-style grouped interval menu (adds the live-only seconds group). */}
      <div className="menu interval-menu" ref={intervalMenuRef}>
        <Tooltip content="Chart interval">
          <button
            className="interval-toggle"
            onClick={() => setIntervalOpen((v) => !v)}
          >
            <Caret />
          </button>
        </Tooltip>
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
                      <span className="tf-label">
                        {p.label}
                        {p.liveOnly && <span className="live-only">live</span>}
                      </span>
                      {/* Defaults (1m–1W) are always on the quick bar; only the
                          other intervals get a favourite toggle. The star is
                          always visible (not hover-revealed) for discoverability. */}
                      {!DEFAULT_RESOLUTIONS.has(p.resolution) && (
                        <Tooltip
                          content={
                            favResolutions.includes(p.resolution)
                              ? "Remove from quick bar"
                              : "Add to quick bar"
                          }
                        >
                          <button
                            className={
                              "ind-star tf-star" +
                              (favResolutions.includes(p.resolution) ? " on" : "")
                            }
                            aria-label={
                              favResolutions.includes(p.resolution)
                                ? "Remove from quick bar"
                                : "Add to quick bar"
                            }
                            aria-pressed={favResolutions.includes(p.resolution)}
                            onClick={(e) => {
                              e.stopPropagation(); // toggle only; don't switch interval
                              toggleFavResolution(p.resolution);
                            }}
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                              <path d="M12 17.3l-5.4 3.3 1.5-6.2L3 10.2l6.3-.5L12 4l2.7 5.7 6.3.5-5.1 4.2 1.5 6.2z" />
                            </svg>
                          </button>
                        </Tooltip>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Price-scale A / L / I (auto-fit, logarithmic, invert) for the focused cell.
// All three mirror per-cell controller signals, so the buttons reflect the
// FOCUSED cell's axis and survive toolbar remounts (the Toolbar/SnapshotToolbar
// swap) — toolbar-local state here would go stale and autoFit would write the
// stale scale type back onto the chart.
export function ScaleControls({ controller }: { controller: ChartController | null }) {
  const chart = controller?.chart ?? null;

  // "A" auto-scale mode (on = highlighted).
  const subscribeAuto = useCallback(
    (cb: () => void) => controller?.autoScale.subscribe(cb) ?? (() => {}),
    [controller],
  );
  const auto = useSyncExternalStore(
    subscribeAuto,
    () => controller?.autoScale.value ?? true,
  );
  // "L" logarithmic scale (on = highlighted).
  const subscribeLog = useCallback(
    (cb: () => void) => controller?.logScale.subscribe(cb) ?? (() => {}),
    [controller],
  );
  const log = useSyncExternalStore(
    subscribeLog,
    () => controller?.logScale.value ?? false,
  );
  // "I" invert-scale mode (on = highlighted).
  const subscribeInvert = useCallback(
    (cb: () => void) => controller?.invertScale.subscribe(cb) ?? (() => {}),
    [controller],
  );
  const inverted = useSyncExternalStore(
    subscribeInvert,
    () => controller?.invertScale.value ?? false,
  );

  // v10: the y-axis kind (normal/logarithm/percentage) is a registered axis named
  // via overrideYAxis, not a style enum. Swapping the name re-fits the range.
  function setScale(name: "normal" | "logarithm") {
    chart?.overrideYAxis({ paneId: "candle_pane", name });
    controller?.logScale.set(name === "logarithm");
  }

  function autoFit() {
    // klinecharts auto-fits the price axis to visible bars; re-applying the axis
    // (overrideYAxis resets the auto-calc flag) recomputes the range, clearing any
    // manual zoom ("fit to data"). Re-assert the current kind while doing so.
    chart?.overrideYAxis({ paneId: "candle_pane", name: log ? "logarithm" : "normal" });
    // Re-enter auto mode (TV-style): stays highlighted until the user manually
    // scales the price axis again (ChartCore flips it back off).
    controller?.autoScale.set(true);
  }

  return (
    <div className="scale">
      <Tooltip content="Auto (fits data to screen)">
        <button
          className={auto ? "on" : ""}
          onClick={autoFit}
        >
          A
        </button>
      </Tooltip>
      <Tooltip content="Logarithmic scale">
        <button
          className={log ? "on" : ""}
          onClick={() => setScale(log ? "normal" : "logarithm")}
        >
          L
        </button>
      </Tooltip>
      <Tooltip content="Invert scale (Option+I)">
        <button
          className={inverted ? "on" : ""}
          onClick={() => controller?.invertScale.set(!controller.invertScale.value)}
        >
          I
        </button>
      </Tooltip>
    </div>
  );
}

// The app-level panel toggles (live trading / alerts / trading dock) — global
// panels beside the chart, safe in every toolbar variant.
export function PanelToggles({ dataOnly = false }: { dataOnly?: boolean }) {
  const [panelOpen, setPanelOpen] = useState(alertsPanelOpen.value);
  useEffect(() => alertsPanelOpen.subscribe(setPanelOpen), []);
  const [tradeOpen, setTradeOpen] = useState(tradePanelOpen.value);
  useEffect(() => tradePanelOpen.subscribe(setTradeOpen), []);
  const [liveOpen, setLiveOpen] = useState(livePanelOpen.value);
  useEffect(() => livePanelOpen.subscribe(setLiveOpen), []);

  return (
    <>
      {/* Live trading panel toggle — arm rule strategies against a demo/live
          broker account. Hidden for a data-only source (Dukascopy history): there
          is no account to trade or arm against. */}
      {!dataOnly && (
      <Tooltip content="Show live trading panel">
        <button
          className={`anchor-btn live-toggle${liveOpen ? " on" : ""}`}
          onClick={() => livePanelOpen.set(!livePanelOpen.value)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-5.07-2.83 2.83M9.76 14.24l-2.83 2.83m10.14 0-2.83-2.83M9.76 9.76 6.93 6.93" />
          </svg>
        </button>
      </Tooltip>
      )}

      {/* Alerts panel toggle (bell). */}
      <Tooltip content="Show alerts panel">
        <button
          className={`anchor-btn alerts-toggle${panelOpen ? " on" : ""}`}
          onClick={() => alertsPanelOpen.set(!alertsPanelOpen.value)}
        >
          <BellIcon size={16} />
        </button>
      </Tooltip>

      {/* Trading panel toggle (order ticket + positions). Hidden for a data-only
          source: nothing to trade. */}
      {!dataOnly && (
      <Tooltip content="Show trading panel">
        <button
          className={`anchor-btn trade-toggle${tradeOpen ? " on" : ""}`}
          onClick={() => tradePanelOpen.set(!tradePanelOpen.value)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <path d="M3 17l6-6 4 4 7-7M14 8h5v5" />
          </svg>
        </button>
      </Tooltip>
      )}
    </>
  );
}

// Maximize / restore: hides the tab bar to focus the active tab. Icon reflects
// state (expand when normal, compress when maximized).
export function MaximizeToggle({
  maximized,
  onToggleMaximize,
}: {
  maximized: boolean;
  onToggleMaximize: () => void;
}) {
  return (
    <Tooltip content={maximized ? "Exit maximized view (Esc)" : "Maximize view"}>
    <button
      className={`anchor-btn maximize-toggle${maximized ? " on" : ""}`}
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
    </Tooltip>
  );
}
