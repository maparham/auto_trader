// TV-style left drawing sidebar (one per tab, beside the chart grid). Drives
// the FOCUSED cell's OverlayManager — same contract as Toolbar. Top→bottom:
// favorites zone (starred tools, one-click), the single "Drawing tools"
// button (click = arm the last-used tool; hover-caret = flyout listing all
// 8 tools flat, no groups), measure + magnet (relocated from the toolbar),
// then the bulk cluster (hide-all eye / lock-all padlock / delete-all).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { getSupportedOverlays } from "klinecharts";
import DrawGlyph from "./DrawIcons";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import { DRAW_TOOLS, toolLabel } from "./lib/drawTools";
import {
  loadFavoriteDrawings,
  saveFavoriteDrawings,
  loadLastDrawTools,
  saveLastDrawTools,
} from "./lib/persist";
import { magnetSignal, toggleMagnet, setMagnetStrength } from "./lib/magnet";
import { patternClipboard } from "./lib/signals";
import { MagnetIcon, StrongMagnetIcon, RulerIcon, SlopeIcon, ZoomRangeIcon, SimilarSequenceIcon, CopyPatternIcon, PastePatternIcon, MenuIcons } from "./lib/menuIcons";
import type { ChartController } from "./lib/chartController";

interface Props {
  controller: ChartController | null;
  // "Preserve the centered time across timeframe changes" (global Settings).
  // Off (default) jumps to the latest candle on a timeframe change. Owned by
  // App's settings state so this button and the Settings modal stay in sync.
  preserveCenterOnTf: boolean;
  onTogglePreserveCenterOnTf: () => void;
}

// Shared flyout shell for the three sidebar menus (tools / magnet / eye). The CSS
// anchors it downward from the trigger's top; a menu near the viewport bottom (the
// eye menu lives in the bottom cluster) would crop, so measure once on open — before
// paint, so the down-anchored frame never flashes — and flip it upward (.up) when
// its bottom would leave the screen.
function DsFlyout({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setUp(r.bottom > window.innerHeight - 8);
  }, []);
  return (
    <div ref={ref} className={"ds-flyout" + (up ? " up" : "") + (className ? ` ${className}` : "")}>
      {children}
    </div>
  );
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

export default function DrawSidebar({ controller, preserveCenterOnTf, onTogglePreserveCenterOnTf }: Props) {
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
  // Pattern clipboard menu. Copy and paste were two permanent buttons in the
  // rail; one trigger keeps the rail short and lets each row say what it does.
  const [patternMenuOpen, setPatternMenuOpen] = useState(false);
  const patternMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!magnetOpen) return;
    const close = (e: MouseEvent) => {
      if (!magnetRef.current?.contains(e.target as Node)) setMagnetOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [magnetOpen]);

  useEffect(() => {
    if (!patternMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!patternMenuRef.current?.contains(e.target as Node)) setPatternMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [patternMenuOpen]);
  const [measuring, setMeasuring] = useState(controller?.measureArmed?.value ?? false);
  useEffect(() => {
    if (!controller?.measureArmed) return;
    setMeasuring(controller.measureArmed.value);
    return controller.measureArmed.subscribe(setMeasuring);
  }, [controller]);
  // Slope tool mirror (same optional-chain HMR-safe pattern as measure above).
  const [sloping, setSloping] = useState(controller?.slopeArmed?.value ?? false);
  useEffect(() => {
    if (!controller?.slopeArmed) return;
    setSloping(controller.slopeArmed.value);
    return controller.slopeArmed.subscribe(setSloping);
  }, [controller]);
  // Zoom-to-range tool mirror (same optional-chain HMR-safe pattern as measure).
  const [zooming, setZooming] = useState(controller?.zoomRangeArmed?.value ?? false);
  useEffect(() => {
    if (!controller?.zoomRangeArmed) return;
    setZooming(controller.zoomRangeArmed.value);
    return controller.zoomRangeArmed.subscribe(setZooming);
  }, [controller]);
  // "Find similar" tool mirror, plus whether it applies to this cell at all
  // (ChartCore publishes that: synthetic epics, sub-minute intervals and
  // read-only snapshots have nothing to search).
  const [findingSimilar, setFindingSimilar] = useState(controller?.patternRangeArmed?.value ?? false);
  useEffect(() => {
    if (!controller?.patternRangeArmed) return;
    setFindingSimilar(controller.patternRangeArmed.value);
    return controller.patternRangeArmed.subscribe(setFindingSimilar);
  }, [controller]);
  const [canFindSimilar, setCanFindSimilar] = useState(controller?.patternSearchAvailable?.value ?? false);
  useEffect(() => {
    if (!controller?.patternSearchAvailable) return;
    setCanFindSimilar(controller.patternSearchAvailable.value);
    return controller.patternSearchAvailable.subscribe(setCanFindSimilar);
  }, [controller]);

  // Pattern overlay: copy arms the SAME range drag as Find similar (one signal,
  // one band, one set of guards) with the mode signal saying what the release
  // does. Paste is armed on its own — it is a single click, not a drag.
  const [copyingPattern, setCopyingPattern] = useState(false);
  useEffect(() => {
    const armed = controller?.patternRangeArmed;
    const mode = controller?.patternRangeMode;
    if (!armed || !mode) return;
    const sync = () => setCopyingPattern(armed.value && mode.value === "copy");
    sync();
    const unsubArmed = armed.subscribe(sync);
    const unsubMode = mode.subscribe(sync);
    return () => {
      unsubArmed();
      unsubMode();
    };
  }, [controller]);
  const [pastingPattern, setPastingPattern] = useState(controller?.patternPasteArmed?.value ?? false);
  useEffect(() => {
    if (!controller?.patternPasteArmed) return;
    setPastingPattern(controller.patternPasteArmed.value);
    return controller.patternPasteArmed.subscribe(setPastingPattern);
  }, [controller]);
  // The clipboard is global (copy on one chart, paste on another), so this one
  // is not read off the controller.
  const [copied, setCopied] = useState(patternClipboard.value);
  useEffect(() => patternClipboard.subscribe(setCopied), []);
  const readOnly = useSyncExternalStore(
    useCallback((cb) => controller?.readOnly.subscribe(cb) ?? (() => {}), [controller]),
    () => controller?.readOnly.value ?? false,
  );

  // Paste needs somewhere to paste from, a cell that accepts drawings, and the
  // signal to exist. Computed once: the row reads it for its look, its
  // aria-disabled and its click guard, and those three must not drift apart.
  const pasteDisabled = !controller?.patternPasteArmed || !copied || readOnly;

  // Eye menu: drawings/alerts-hidden live on the manager (existing); indicators/
  // positions are per-cell signals on the controller. Re-sync all four when focus moves, and
  // subscribe to the two signals for external changes (e.g. another surface toggling
  // them later). `eyeOpen` is this flyout's own open state (outside-click closes it,
  // same idiom as the drawing-tools and magnet flyouts).
  const [hidden, setHidden] = useState(false);
  const [alertsHidden, setAlertsHidden] = useState(false);
  const [indicatorsHidden, setIndicatorsHidden] = useState(false);
  const [positionsHidden, setPositionsHidden] = useState(false);
  useEffect(() => {
    setHidden(overlays?.getDrawingsHidden() ?? false);
    setAlertsHidden(overlays?.getAlertsHidden() ?? false);
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
  const anyHidden = hidden || alertsHidden || indicatorsHidden || positionsHidden;

  // Esc closes any open flyout. Document-level because the flyouts never hold
  // focus; the chart's own Esc handling (measure/drawing cancel) lives on the
  // focused .chart-wrap and is unaffected unless focus sits inside the chart.
  useEffect(() => {
    if (!openFly && !magnetOpen && !eyeOpen && !patternMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpenFly(false);
      setMagnetOpen(false);
      setEyeOpen(false);
      setPatternMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openFly, magnetOpen, eyeOpen, patternMenuOpen]);

  // Only tools klinecharts actually supports (same guard the old dropdown had).
  const supported = new Set(getSupportedOverlays());
  const tools = DRAW_TOOLS.filter((t) => supported.has(t.name));
  const favShown = favs.filter((n) => supported.has(n));

  function arm(name: string) {
    // Time Range uses its own press-drag placement (click = one candle, drag =
    // range), driven off a controller signal in ChartCore, not klinecharts'
    // interactive click-to-place. Arm the signal instead of addDrawing.
    if (name === "timeRange") {
      controller?.timeRangeArmed.set(true);
      controller?.focusChart?.();
      const next = { ...lastUsed, tool: name };
      setLastUsed(next);
      saveLastDrawTools(next);
      setOpenFly(false);
      return;
    }
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

  function toggleAlertsHidden() {
    if (!overlays) return;
    const next = !overlays.getAlertsHidden();
    overlays.setAlertsHidden(next);
    setAlertsHidden(next);
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
    // ✓ when all four are already hidden → show all; otherwise hide all four.
    const allHidden = hidden && alertsHidden && indicatorsHidden && positionsHidden;
    const next = !allHidden;
    overlays.setDrawingsHidden(next);
    setHidden(next);
    overlays.setAlertsHidden(next);
    setAlertsHidden(next);
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
              <DsFlyout>
                <div className="ds-fly-section">Drawing tools</div>
                <ul>
                  {tools.map((t) => (
                    <li key={t.name} className="ds-row" onClick={() => arm(t.name)}>
                      <span className="ds-glyph"><DrawGlyph name={t.name} /></span>
                      <span className="ds-label">{t.label}</span>
                      <Tooltip content={favs.includes(t.name) ? "Remove from favorites" : "Add to favorites"}>
                        <button
                          className={"ind-star" + (favs.includes(t.name) ? " on" : "")}
                          aria-pressed={favs.includes(t.name)}
                          onClick={(e) => { e.stopPropagation(); toggleFav(t.name); }}
                        >
                          <Star on={favs.includes(t.name)} />
                        </button>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </DsFlyout>
            )}
          </div>
        );
      })()}

      {/* Favorites: starred tools live directly beneath the Drawing tools
          button (star order) behind a slim collapse toggle, sliding out so
          they read as coming from its flyout. */}
      {favShown.length > 0 && (
        <Tooltip content={favsOpen ? "Hide favorite tools" : "Show favorite tools"} placement="right">
          <button
            className={"ds-fav-toggle" + (favsOpen ? " open" : "")}
            aria-expanded={favsOpen}
            onClick={() => setFavsOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="9" height="9" fill="none"
              stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </Tooltip>
      )}
      {favsOpen && favShown.map((name) => (
        <Tooltip key={name} content={toolLabel(name)} placement="right">
          <button
            className="ds-btn ds-fav"
            onClick={() => arm(name)}
          >
            <DrawGlyph name={name} />
            {/* Star badge: ties the button back to the flyout star that made it. */}
            <svg className="ds-fav-star" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 17.3l-5.4 3.3 1.5-6.2L3 10.2l6.3-.5L12 4l2.7 5.7 6.3.5-5.1 4.2 1.5 6.2z" />
            </svg>
          </button>
        </Tooltip>
      ))}

      <span className="ds-div" aria-hidden="true" />

      {/* Measure ruler (moved from the toolbar; same signal contract). */}
      <Tooltip
        placement="right"
        content={["Measure. Click a start point, then an end point.", "Shift-drag also works."]}
      >
        <button
          className={"ds-btn measure-toggle" + (measuring ? " on" : "")}
          disabled={!controller?.measureArmed}
          onClick={() => controller?.measureArmed?.set(!controller.measureArmed.value)}
        >
          <RulerIcon />
        </button>
      </Tooltip>

      {/* Slope tool: click start, click end, then it stays live (drag ends / middle /
          rotate knob). The tooltip spells out what the angle number means, since it's a
          fixed rate (1%/bar = 45°), not the line's on-screen tilt. */}
      <Tooltip
        placement="right"
        content={[
          "Slope. Click a start point, then an end point.",
          "Then drag either end, drag the middle to slide it, or drag the knob to rotate (hold Shift to snap 15°).",
          "The angle is a fixed rate: 1%/bar = 45°, the same on every symbol and zoom level.",
        ]}
      >
        <button
          className={"ds-btn slope-toggle" + (sloping ? " on" : "")}
          disabled={!controller?.slopeArmed}
          onClick={() => controller?.slopeArmed?.set(!controller.slopeArmed.value)}
        >
          <SlopeIcon />
        </button>
      </Tooltip>

      {/* Zoom to range: drag a band, drop one timeframe lower centered on it. */}
      <Tooltip
        placement="right"
        content={[
          "Zoom to range. Drag across a time range.",
          "On release, drops one timeframe lower centered on it.",
        ]}
      >
        <button
          className={"ds-btn zoom-range-toggle" + (zooming ? " on" : "")}
          disabled={!controller?.zoomRangeArmed}
          onClick={() => controller?.zoomRangeArmed?.set(!controller.zoomRangeArmed.value)}
        >
          <ZoomRangeIcon />
        </button>
      </Tooltip>

      {/* Find similar: drag across candles, get the closest historical matches. */}
      <Tooltip
        placement="right"
        content={[
          "Similarity search. Drag across the candles you want to match.",
          "On release, finds where that shape appeared before.",
        ]}
      >
        <button
          className={"ds-btn pattern-range-toggle" + (findingSimilar && !copyingPattern ? " on" : "")}
          disabled={!controller?.patternRangeArmed || !canFindSimilar}
          onClick={() => {
            // Mode first: arming with a stale "copy" would turn this button into
            // the copy tool.
            controller?.patternRangeMode?.set("search");
            controller?.patternRangeArmed?.set(!controller.patternRangeArmed.value || copyingPattern);
          }}
          aria-label="Similarity search"
        >
          <SimilarSequenceIcon />
        </button>
      </Tooltip>

      {/* Pattern clipboard: one trigger, copy and paste as menu options. Two
          permanent buttons put a rarely-used pair in the rail beside the tools
          people reach for constantly; a menu keeps the rail short and gives each
          action a row that says what it does. */}
      <div className="ds-family" ref={patternMenuRef}>
        <Tooltip
          placement="right"
          // The flyout opens exactly where this bubble sits, so the hover
          // tooltip stands down as soon as the menu is up.
          disabled={patternMenuOpen}
          content={[
            "Pattern clipboard. Copy a shape, paste it on any chart.",
            "Copy takes a drag; paste drops the copied candles as a ghost.",
          ]}
        >
          <button
            className={"ds-btn pattern-clip-toggle" + (copyingPattern || pastingPattern ? " on" : "")}
            disabled={!controller?.patternRangeArmed}
            onClick={() => setPatternMenuOpen((v) => !v)}
            aria-label="Pattern clipboard"
            aria-expanded={patternMenuOpen}
          >
            <CopyPatternIcon />
          </button>
        </Tooltip>
        {patternMenuOpen && (
          <DsFlyout>
            <ul>
              <li
                className={"ds-row pattern-clip-opt" + (copyingPattern ? " is-armed" : "")}
                onClick={() => {
                  const next = !copyingPattern;
                  controller?.patternRangeMode?.set(next ? "copy" : "search");
                  controller?.patternRangeArmed?.set(next);
                  setPatternMenuOpen(false);
                }}
              >
                <span className="ds-glyph"><CopyPatternIcon /></span>
                <span className="ds-label">Copy pattern</span>
                <InfoTip
                  title="Copy pattern"
                  text={[
                    "Drag across the candles you want to keep.",
                    "Paste them anywhere, on any chart, to compare the shape.",
                  ]}
                />
              </li>
              <li
                className={
                  "ds-row pattern-clip-opt" +
                  (pastingPattern ? " is-armed" : "") +
                  (pasteDisabled ? " ds-row-disabled" : "")
                }
                aria-disabled={pasteDisabled}
                onClick={() => {
                  if (pasteDisabled) return;
                  controller?.patternPasteArmed?.set(!controller.patternPasteArmed.value);
                  setPatternMenuOpen(false);
                }}
              >
                <span className="ds-glyph"><PastePatternIcon /></span>
                <span className="ds-label">Paste pattern</span>
                <InfoTip
                  title="Paste pattern"
                  text={
                    copied
                      ? [
                          `${copied.bars.length} candles from ${copied.epic} ${copied.resolution}.`,
                          "Click a candle to drop it there, then drag it around.",
                        ]
                      : ["Copy a pattern first."]
                  }
                />
              </li>
            </ul>
          </DsFlyout>
        )}
      </div>

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
          <DsFlyout>
            <ul>
              <li className="ds-row magnet-opt"
                onClick={() => { setMagnetStrength("weak"); setMagnetOpen(false); }}>
                <span className="check">{magnet.strength === "weak" ? "✓" : ""}</span>
                <span className="ds-glyph"><MagnetIcon size={24} /></span>
                <span className="ds-label">Weak Magnet</span>
                <InfoTip title="Weak Magnet"
                  text="Snaps a drawing point to the nearest OHLC price only when the cursor is close to a price bar." />
              </li>
              <li className="ds-row magnet-opt"
                onClick={() => { setMagnetStrength("strong"); setMagnetOpen(false); }}>
                <span className="check">{magnet.strength === "strong" ? "✓" : ""}</span>
                <span className="ds-glyph"><StrongMagnetIcon size={24} /></span>
                <span className="ds-label">Strong Magnet</span>
                <InfoTip title="Strong Magnet"
                  text="Always snaps a drawing point to the nearest OHLC price of the bar under the cursor." />
              </li>
            </ul>
          </DsFlyout>
        )}
      </div>

      <span className="ds-spacer" aria-hidden="true" />

      {/* Preserve-center-on-timeframe-change toggle (global Settings; mirrors
          the Settings → General switch). On = the centered time stays fixed
          across timeframes (anchored bar marked on the time axis); off
          (default) jumps to the latest candle. */}
      <Tooltip
        placement="right"
        content={
          preserveCenterOnTf
            ? ["Timeframe change keeps the centered time fixed."]
            : [
                "Timeframe change jumps to the latest candle.",
                "Click to keep the centered time fixed instead.",
              ]
        }
      >
        <button
          className={"ds-btn" + (preserveCenterOnTf ? " on" : "")}
          aria-pressed={preserveCenterOnTf}
          onClick={onTogglePreserveCenterOnTf}
        >
          {/* target: circle + crosshair ticks + center dot */}
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="7" />
            <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
            <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </Tooltip>
      <span className="ds-div" aria-hidden="true" />

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
          <DsFlyout className="compact">
            <ul>
              <li className="ds-row" onClick={toggleDrawingsHidden}>
                <span className="ds-glyph">{MenuIcons.pencil}</span>
                <span className="ds-label">Hide drawings</span>
                <span className="check">{hidden ? "✓" : ""}</span>
              </li>
              <li className="ds-row" onClick={toggleIndicatorsHidden}>
                <span className="ds-glyph">{MenuIcons.indicator}</span>
                <span className="ds-label">Hide indicators</span>
                <span className="check">{indicatorsHidden ? "✓" : ""}</span>
              </li>
              <li className="ds-row" onClick={togglePositionsHidden}>
                <span className="ds-glyph">{MenuIcons.positions}</span>
                <span className="ds-label">Hide positions</span>
                <span className="check">{positionsHidden ? "✓" : ""}</span>
              </li>
              <li className="ds-row" onClick={toggleAlertsHidden}>
                <span className="ds-glyph">{MenuIcons.bell}</span>
                <span className="ds-label">Hide alert lines</span>
                <span className="check">{alertsHidden ? "✓" : ""}</span>
              </li>
              <li className="ds-row" onClick={toggleHideAll}>
                <span className="ds-glyph">{MenuIcons.hide}</span>
                <span className="ds-label">Hide all</span>
                <span className="check">{hidden && alertsHidden && indicatorsHidden && positionsHidden ? "✓" : ""}</span>
              </li>
            </ul>
          </DsFlyout>
        )}
      </div>
      <Tooltip content="Lock or unlock all drawings" placement="right">
        <button className="ds-btn"
          disabled={!overlays} onClick={toggleLockAll}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="9" rx="1.5" />
            <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip content="Delete all drawings" placement="right">
        <button className="ds-btn ds-trash"
          disabled={!overlays} onClick={deleteAll}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
          </svg>
        </button>
      </Tooltip>
    </aside>
  );
}
