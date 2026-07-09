// Toolbar building blocks shared by the two toolbar variants: the full Toolbar
// (normal charts) and SnapshotToolbar (read-only snapshot views). Each block is
// self-contained — it owns its local state and signal subscriptions — so both
// toolbars compose the exact same DOM for the controls they have in common.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { YAxisType } from "klinecharts";
import {
  PERIOD_GROUPS,
  quickBarPeriods,
  DEFAULT_RESOLUTIONS,
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
      {quickBar.every((p) => p.resolution !== period.resolution) && (
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
                      <span className="tf-label">
                        {p.label}
                        {p.liveOnly && <span className="live-only">live</span>}
                      </span>
                      {/* Defaults (1m–1W) are always on the quick bar; only the
                          other intervals get a favourite toggle. The star is
                          always visible (not hover-revealed) for discoverability. */}
                      {!DEFAULT_RESOLUTIONS.has(p.resolution) && (
                        <button
                          className={
                            "ind-star tf-star" +
                            (favResolutions.includes(p.resolution) ? " on" : "")
                          }
                          title={
                            favResolutions.includes(p.resolution)
                              ? "Remove from quick bar"
                              : "Add to quick bar"
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
export function ScaleControls({ controller }: { controller: ChartController | null }) {
  const chart = controller?.chart ?? null;

  const [log, setLog] = useState(false);
  // "A" auto-scale mode (mirrors the focused cell's signal; on = highlighted).
  const [auto, setAuto] = useState(controller?.autoScale.value ?? true);
  useEffect(() => {
    if (!controller) return;
    setAuto(controller.autoScale.value);
    return controller.autoScale.subscribe(setAuto);
  }, [controller]);
  // "I" invert-scale mode (mirrors the focused cell's signal; on = highlighted).
  const subscribeInvert = useCallback(
    (cb: () => void) => controller?.invertScale.subscribe(cb) ?? (() => {}),
    [controller],
  );
  const inverted = useSyncExternalStore(
    subscribeInvert,
    () => controller?.invertScale.value ?? false,
  );

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

  return (
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
      <button
        title="Invert scale (Option+I)"
        className={inverted ? "on" : ""}
        onClick={() => controller?.invertScale.set(!controller.invertScale.value)}
      >
        I
      </button>
    </div>
  );
}

// The app-level panel toggles (live trading / alerts / trading dock) — global
// panels beside the chart, safe in every toolbar variant.
export function PanelToggles() {
  const [panelOpen, setPanelOpen] = useState(alertsPanelOpen.value);
  useEffect(() => alertsPanelOpen.subscribe(setPanelOpen), []);
  const [tradeOpen, setTradeOpen] = useState(tradePanelOpen.value);
  useEffect(() => tradePanelOpen.subscribe(setTradeOpen), []);
  const [liveOpen, setLiveOpen] = useState(livePanelOpen.value);
  useEffect(() => livePanelOpen.subscribe(setLiveOpen), []);

  return (
    <>
      {/* Live trading panel toggle — arm rule strategies against a demo/live
          broker account. */}
      <button
        className={`anchor-btn live-toggle${liveOpen ? " on" : ""}`}
        title="Show live trading panel"
        onClick={() => livePanelOpen.set(!livePanelOpen.value)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-5.07-2.83 2.83M9.76 14.24l-2.83 2.83m10.14 0-2.83-2.83M9.76 9.76 6.93 6.93" />
        </svg>
      </button>

      {/* Alerts panel toggle (bell). */}
      <button
        className={`anchor-btn alerts-toggle${panelOpen ? " on" : ""}`}
        title="Show alerts panel"
        onClick={() => alertsPanelOpen.set(!alertsPanelOpen.value)}
      >
        <BellIcon size={16} />
      </button>

      {/* Trading panel toggle (order ticket + positions). */}
      <button
        className={`anchor-btn trade-toggle${tradeOpen ? " on" : ""}`}
        title="Show trading panel"
        onClick={() => tradePanelOpen.set(!tradePanelOpen.value)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <path d="M3 17l6-6 4 4 7-7M14 8h5v5" />
        </svg>
      </button>
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
  );
}
