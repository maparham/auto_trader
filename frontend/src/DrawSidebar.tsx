// TV-style left drawing sidebar (one per tab, beside the chart grid). Drives
// the FOCUSED cell's OverlayManager — same contract as Toolbar. Top→bottom:
// favorites zone (starred tools, one-click), family buttons (click = arm the
// family's last-used tool; hover-caret = flyout to pick/star a variant),
// measure + magnet (relocated from the toolbar), then the bulk cluster
// (hide-all eye / lock-all padlock / delete-all).
import { useEffect, useRef, useState } from "react";
import { getSupportedOverlays } from "klinecharts";
import DrawGlyph from "./DrawIcons";
import InfoTip from "./components/InfoTip";
import { DRAW_FAMILIES, toolLabel, type DrawFamily } from "./lib/drawTools";
import {
  loadFavoriteDrawings,
  saveFavoriteDrawings,
  loadLastDrawTools,
  saveLastDrawTools,
} from "./lib/persist";
import { magnetSignal, toggleMagnet, setMagnetStrength } from "./lib/magnet";
import { MagnetIcon, RulerIcon } from "./lib/menuIcons";
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

  // Which family's flyout is open (null = none). Outside-click closes it.
  const [openFly, setOpenFly] = useState<DrawFamily["key"] | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!openFly) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenFly(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openFly]);

  // Starred tools (global, star order) + last-used per family (device-local).
  const [favs, setFavs] = useState<string[]>(loadFavoriteDrawings);
  const [lastUsed, setLastUsed] = useState<Record<string, string>>(loadLastDrawTools);

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

  // Hide-all eye: session state lives on the manager; re-read when focus moves.
  const [hidden, setHidden] = useState(false);
  useEffect(() => setHidden(overlays?.getDrawingsHidden() ?? false), [overlays]);

  // Only tools klinecharts actually supports (same guard the old dropdown had).
  const supported = new Set(getSupportedOverlays());
  const families = DRAW_FAMILIES.map((f) => ({
    ...f,
    tools: f.tools.filter((t) => supported.has(t.name)),
  })).filter((f) => f.tools.length > 0);
  const favShown = favs.filter((n) => supported.has(n));

  function arm(name: string, familyKey: string) {
    overlays?.addDrawing(name);
    const next = { ...lastUsed, [familyKey]: name };
    setLastUsed(next);
    saveLastDrawTools(next);
    setOpenFly(null);
  }

  function toggleFav(name: string) {
    setFavs((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      saveFavoriteDrawings(next);
      return next;
    });
  }

  function toggleHidden() {
    if (!overlays) return;
    const next = !overlays.getDrawingsHidden();
    overlays.setDrawingsHidden(next);
    setHidden(next);
  }

  function toggleLockAll() {
    if (!overlays) return;
    if (overlays.allDrawingsLocked()) overlays.unlockAll();
    else overlays.lockAllDrawings();
  }

  function deleteAll() {
    if (!overlays) return;
    if (window.confirm("Delete all drawings on this chart?")) overlays.clearDrawings();
  }

  return (
    <aside className="draw-sidebar" ref={rootRef}>
      {/* Favorites zone: starred tools as direct buttons, star order. */}
      {favShown.map((name) => (
        <button
          key={name}
          className="ds-btn"
          title={toolLabel(name)}
          onClick={() => {
            const fam = DRAW_FAMILIES.find((f) => f.tools.some((t) => t.name === name));
            arm(name, fam?.key ?? "lines");
          }}
        >
          <DrawGlyph name={name} />
        </button>
      ))}
      {favShown.length > 0 && <span className="ds-div" aria-hidden="true" />}

      {/* Family buttons: icon = the family's last-used tool; caret = flyout. */}
      {families.map((f) => {
        const current =
          f.tools.find((t) => t.name === lastUsed[f.key])?.name ?? f.tools[0].name;
        return (
          <div key={f.key} className="ds-family">
            <button className="ds-btn" title={`${f.label} — ${toolLabel(current)}`}
              onClick={() => arm(current, f.key)}>
              <DrawGlyph name={current} />
            </button>
            <button
              className={"ds-caret" + (openFly === f.key ? " on" : "")}
              title={`${f.label}…`}
              aria-label={`Open ${f.label} menu`}
              onClick={() => setOpenFly((v) => (v === f.key ? null : f.key))}
            >
              <svg viewBox="0 0 24 24" width="8" height="8" fill="none"
                stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
            {openFly === f.key && (
              <div className="ds-flyout">
                <div className="ds-fly-section">{f.label}</div>
                <ul>
                  {f.tools.map((t) => (
                    <li key={t.name} className="ds-row" onClick={() => arm(t.name, f.key)}>
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
      })}

      <span className="ds-div" aria-hidden="true" />

      {/* Measure ruler (moved from the toolbar; same signal contract). */}
      <button
        className={"ds-btn measure-toggle" + (measuring ? " on" : "")}
        title="Measure — click start, then click end (or hold Shift)"
        disabled={!controller?.measureArmed}
        onClick={() => controller?.measureArmed?.set(!controller.measureArmed.value)}
      >
        <RulerIcon />
      </button>

      {/* Magnet (moved from the toolbar): icon toggles, caret picks strength. */}
      <div className="ds-family" ref={magnetRef}>
        <button
          className={"ds-btn magnet-toggle" + (magnet.on ? " on" : "")}
          title="Magnet mode — snap drawings to price bars (hold Ctrl/Cmd to invert)"
          onClick={() => toggleMagnet()}
        >
          <MagnetIcon />
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
                <span className="ds-label">Weak Magnet</span>
                <InfoTip title="Weak Magnet"
                  desc="Snaps a drawing point to the nearest OHLC price only when the cursor is close to a price bar." />
              </li>
              <li className="ds-row magnet-opt"
                onClick={() => { setMagnetStrength("strong"); setMagnetOpen(false); }}>
                <span className="check">{magnet.strength === "strong" ? "✓" : ""}</span>
                <span className="ds-label">Strong Magnet</span>
                <InfoTip title="Strong Magnet"
                  desc="Always snaps a drawing point to the nearest OHLC price of the bar under the cursor." />
              </li>
            </ul>
          </div>
        )}
      </div>

      <span className="ds-spacer" aria-hidden="true" />

      {/* Bulk cluster (focused cell): hide-all eye, lock-all, delete-all. */}
      <button className={"ds-btn ds-eye" + (hidden ? " on" : "")}
        title={hidden ? "Show all drawings" : "Hide all drawings"}
        disabled={!overlays} onClick={toggleHidden}>
        {hidden ? (
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
