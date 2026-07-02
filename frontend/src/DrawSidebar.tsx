// TV-style left drawing sidebar (one per tab, beside the chart grid). Drives
// the FOCUSED cell's OverlayManager — same contract as Toolbar. Top→bottom:
// favorites zone (starred tools, one-click), the single "Drawing tools"
// button (click = arm the last-used tool; hover-caret = flyout listing all
// 8 tools flat, no groups), measure + magnet (relocated from the toolbar),
// then the bulk cluster (hide-all eye / lock-all padlock / delete-all).
import { useEffect, useRef, useState } from "react";
import { getSupportedOverlays } from "klinecharts";
import DrawGlyph from "./DrawIcons";
import InfoTip from "./components/InfoTip";
import { DRAW_TOOLS, toolLabel } from "./lib/drawTools";
import {
  loadFavoriteDrawings,
  saveFavoriteDrawings,
  loadLastDrawTools,
  saveLastDrawTools,
} from "./lib/persist";
import { magnetSignal, toggleMagnet, setMagnetStrength } from "./lib/magnet";
import { MagnetIcon, StrongMagnetIcon, RulerIcon } from "./lib/menuIcons";
import type { ChartController } from "./lib/chartController";

interface Props {
  controller: ChartController | null;
}

// Star (filled when on) — same path as IndicatorRow's.
function Star({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
      fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5">
      <path d="M12 17.3l-5.4 3.3 1.5-6.2L3 10.2l6.3-.5L12 4l2.7 5.7 6.3.5-5.1 4.2 1.5 6.2z" />
    </svg>
  );
}

export default function DrawSidebar({ controller }: Props) {
  const overlays = controller?.overlays ?? null;

  // Whether the drawing-tools flyout is open. Outside-click closes it.
  const [openFly, setOpenFly] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!openFly) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenFly(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openFly]);

  // Starred tools (global, star order) + last-used tool (device-local).
  const [favs, setFavs] = useState<string[]>(loadFavoriteDrawings);
  const [lastUsed, setLastUsed] = useState<Record<string, string>>(loadLastDrawTools);
  // Favorites strip expanded/collapsed (session-only; default expanded).
  const [favsOpen, setFavsOpen] = useState(true);

  // Magnet (global signal) + measure (focused controller's signal) mirrors —
  // moved verbatim from Toolbar.
  const [magnet, setMagnet] = useState(magnetSignal.value);
  useEffect(() => magnetSignal.subscribe(setMagnet), []);
  const [magnetOpen, setMagnetOpen] = useState(false);
  const magnetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!magnetOpen) return;
    const close = (e: MouseEvent) => {
      if (!magnetRef.current?.contains(e.target as Node)) setMagnetOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [magnetOpen]);
  const [measuring, setMeasuring] = useState(controller?.measureArmed?.value ?? false);
  useEffect(() => {
    if (!controller?.measureArmed) return;
    setMeasuring(controller.measureArmed.value);
    return controller.measureArmed.subscribe(setMeasuring);
  }, [controller]);

  // Eye menu: drawings-hidden lives on the manager (existing); indicators/positions
  // are per-cell signals on the controller. Re-sync all three when focus moves, and
  // subscribe to the two signals for external changes (e.g. another surface toggling
  // them later). `eyeOpen` is this flyout's own open state (outside-click closes it,
  // same idiom as the drawing-tools and magnet flyouts).
  const [hidden, setHidden] = useState(false);
  const [indicatorsHidden, setIndicatorsHidden] = useState(false);
  const [positionsHidden, setPositionsHidden] = useState(false);
  useEffect(() => {
    setHidden(overlays?.getDrawingsHidden() ?? false);
    setIndicatorsHidden(controller?.indicatorsHidden.value ?? false);
    setPositionsHidden(controller?.positionsHidden.value ?? false);
    if (!controller) return;
    const unsubInd = controller.indicatorsHidden.subscribe(setIndicatorsHidden);
    const unsubPos = controller.positionsHidden.subscribe(setPositionsHidden);
    return () => {
      unsubInd();
      unsubPos();
    };
  }, [overlays, controller]);
  const [eyeOpen, setEyeOpen] = useState(false);
  const eyeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!eyeOpen) return;
    const close = (e: MouseEvent) => {
      if (!eyeRef.current?.contains(e.target as Node)) setEyeOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [eyeOpen]);
  const anyHidden = hidden || indicatorsHidden || positionsHidden;

  // Esc closes any open flyout. Document-level because the flyouts never hold
  // focus; the chart's own Esc handling (measure/drawing cancel) lives on the
  // focused .chart-wrap and is unaffected unless focus sits inside the chart.
  useEffect(() => {
    if (!openFly && !magnetOpen && !eyeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpenFly(false);
      setMagnetOpen(false);
      setEyeOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openFly, magnetOpen, eyeOpen]);

  // Only tools klinecharts actually supports (same guard the old dropdown had).
  const supported = new Set(getSupportedOverlays());
  const tools = DRAW_TOOLS.filter((t) => supported.has(t.name));
  const favShown = favs.filter((n) => supported.has(n));

  function arm(name: string) {
    overlays?.addDrawing(name);
    // Hand keyboard focus to the chart so Esc cancels the armed tool immediately —
    // without this the sidebar button keeps focus and the chart's Esc handler
    // never sees the key (same move the measure arm makes in ChartCore).
    controller?.focusChart?.();
    const next = { ...lastUsed, tool: name };
    setLastUsed(next);
    saveLastDrawTools(next);
    setOpenFly(false);
  }

  function toggleFav(name: string) {
    setFavs((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      saveFavoriteDrawings(next);
      return next;
    });
  }

  function toggleDrawingsHidden() {
    if (!overlays) return;
    const next = !overlays.getDrawingsHidden();
    overlays.setDrawingsHidden(next);
    setHidden(next);
  }

  function toggleIndicatorsHidden() {
    if (!controller) return;
    controller.indicatorsHidden.set(!controller.indicatorsHidden.value);
  }

  function togglePositionsHidden() {
    if (!controller) return;
    controller.positionsHidden.set(!controller.positionsHidden.value);
  }

  function toggleHideAll() {
    if (!overlays || !controller) return;
    // ✓ when all three are already hidden → show all; otherwise hide all three.
    const allHidden = hidden && indicatorsHidden && positionsHidden;
    const next = !allHidden;
    overlays.setDrawingsHidden(next);
    setHidden(next);
    controller.indicatorsHidden.set(next);
    controller.positionsHidden.set(next);
  }

  function toggleLockAll() {
    if (!overlays) return;
    // ANY locked → unlock all (keeps the one-click escape hatch for a drawing
    // locked via right-click); none locked → lock all.
    if (overlays.anyDrawingsLocked()) overlays.unlockAll();
    else overlays.lockAllDrawings();
  }

  function deleteAll() {
    if (!overlays) return;
    if (window.confirm("Delete all drawings on this chart?")) overlays.clearDrawings();
  }

  return (
    <aside className="draw-sidebar" ref={rootRef}>
      {/* Single "Drawing tools" button: icon = the last-used tool; caret = flyout. */}
      {tools.length > 0 && (() => {
        const current =
          tools.find((t) => t.name === lastUsed.tool)?.name ?? tools[0].name;
        return (
          <div className="ds-family">
            <button className="ds-btn" title={`Drawing tools · ${toolLabel(current)}`}
              onClick={() => arm(current)}>
              <DrawGlyph name={current} />
            </button>
            <button
              className={"ds-caret" + (openFly ? " on" : "")}
              title="Drawing tools…"
              aria-label="Open drawing tools menu"
              onClick={() => setOpenFly((v) => !v)}
            >
              <svg viewBox="0 0 24 24" width="8" height="8" fill="none"
                stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
            {openFly && (
              <div className="ds-flyout">
                <div className="ds-fly-section">Drawing tools</div>
                <ul>
                  {tools.map((t) => (
                    <li key={t.name} className="ds-row" onClick={() => arm(t.name)}>
                      <span className="ds-glyph"><DrawGlyph name={t.name} /></span>
                      <span className="ds-label">{t.label}</span>
                      <button
                        className={"ind-star" + (favs.includes(t.name) ? " on" : "")}
                        title={favs.includes(t.name) ? "Remove from favorites" : "Add to favorites"}
                        aria-pressed={favs.includes(t.name)}
                        onClick={(e) => { e.stopPropagation(); toggleFav(t.name); }}
                      >
                        <Star on={favs.includes(t.name)} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })()}

      {/* Favorites: starred tools live directly beneath the Drawing tools
          button (star order) behind a slim collapse toggle, sliding out so
          they read as coming from its flyout. */}
      {favShown.length > 0 && (
        <button
          className={"ds-fav-toggle" + (favsOpen ? " open" : "")}
          title={favsOpen ? "Hide favorite tools" : "Show favorite tools"}
          aria-expanded={favsOpen}
          onClick={() => setFavsOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="9" height="9" fill="none"
            stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}
      {favsOpen && favShown.map((name) => (
        <button
          key={name}
          className="ds-btn ds-fav"
          title={toolLabel(name)}
          onClick={() => arm(name)}
        >
          <DrawGlyph name={name} />
          {/* Star badge: ties the button back to the flyout star that made it. */}
          <svg className="ds-fav-star" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 17.3l-5.4 3.3 1.5-6.2L3 10.2l6.3-.5L12 4l2.7 5.7 6.3.5-5.1 4.2 1.5 6.2z" />
          </svg>
        </button>
      ))}

      <span className="ds-div" aria-hidden="true" />

      {/* Measure ruler (moved from the toolbar; same signal contract). */}
      <button
        className={"ds-btn measure-toggle" + (measuring ? " on" : "")}
        title="Measure. Click start, then click end. Shift-drag also works."
        disabled={!controller?.measureArmed}
        onClick={() => controller?.measureArmed?.set(!controller.measureArmed.value)}
      >
        <RulerIcon />
      </button>

      {/* Magnet (moved from the toolbar): icon toggles, caret picks strength. */}
      <div className="ds-family" ref={magnetRef}>
        <button
          className={"ds-btn magnet-toggle" + (magnet.on ? " on" : "")}
          title="Magnet mode. Snaps drawings to bar prices. Hold Ctrl/Cmd to invert."
          onClick={() => toggleMagnet()}
        >
          <MagnetIcon size={22} />
        </button>
        <button
          className={"ds-caret" + (magnetOpen ? " on" : "")}
          title="Magnet strength"
          onClick={() => setMagnetOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="8" height="8" fill="none"
            stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
        {magnetOpen && (
          <div className="ds-flyout">
            <ul>
              <li className="ds-row magnet-opt"
                onClick={() => { setMagnetStrength("weak"); setMagnetOpen(false); }}>
                <span className="check">{magnet.strength === "weak" ? "✓" : ""}</span>
                <span className="ds-glyph"><MagnetIcon size={24} /></span>
                <span className="ds-label">Weak Magnet</span>
                <InfoTip title="Weak Magnet"
                  desc="Snaps a drawing point to the nearest OHLC price only when the cursor is close to a price bar." />
              </li>
              <li className="ds-row magnet-opt"
                onClick={() => { setMagnetStrength("strong"); setMagnetOpen(false); }}>
                <span className="check">{magnet.strength === "strong" ? "✓" : ""}</span>
                <span className="ds-glyph"><StrongMagnetIcon size={24} /></span>
                <span className="ds-label">Strong Magnet</span>
                <InfoTip title="Strong Magnet"
                  desc="Always snaps a drawing point to the nearest OHLC price of the bar under the cursor." />
              </li>
            </ul>
          </div>
        )}
      </div>

      <span className="ds-spacer" aria-hidden="true" />

      {/* Bulk cluster (focused cell): eye menu, lock-all, delete-all. */}
      <div className="ds-family" ref={eyeRef}>
        <button className={"ds-btn ds-eye" + (anyHidden ? " on" : "")}
          title="Hide…"
          aria-label="Open hide menu"
          disabled={!overlays} onClick={() => setEyeOpen((v) => !v)}>
          {anyHidden ? (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l18 18M10.6 10.7a2.5 2.5 0 0 0 3.5 3.5M7.4 7.5C4.9 8.9 3 12 3 12s3.5 6 9 6c1.6 0 3-.4 4.3-1.1M12 6c5.5 0 9 6 9 6s-.7 1.2-2 2.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
          )}
        </button>
        {eyeOpen && (
          <div className="ds-flyout">
            <ul>
              <li className="ds-row" onClick={toggleDrawingsHidden}>
                <span className="check">{hidden ? "✓" : ""}</span>
                <span className="ds-label">Hide drawings</span>
              </li>
              <li className="ds-row" onClick={toggleIndicatorsHidden}>
                <span className="check">{indicatorsHidden ? "✓" : ""}</span>
                <span className="ds-label">Hide indicators</span>
              </li>
              <li className="ds-row" onClick={togglePositionsHidden}>
                <span className="check">{positionsHidden ? "✓" : ""}</span>
                <span className="ds-label">Hide positions and orders</span>
              </li>
              <li className="ds-row" onClick={toggleHideAll}>
                <span className="check">{hidden && indicatorsHidden && positionsHidden ? "✓" : ""}</span>
                <span className="ds-label">Hide all</span>
              </li>
            </ul>
          </div>
        )}
      </div>
      <button className="ds-btn" title="Lock / unlock all drawings"
        disabled={!overlays} onClick={toggleLockAll}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <rect x="5" y="11" width="14" height="9" rx="1.5" />
          <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
        </svg>
      </button>
      <button className="ds-btn ds-trash" title="Delete all drawings"
        disabled={!overlays} onClick={deleteAll}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
        </svg>
      </button>
    </aside>
  );
}
