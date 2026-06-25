// Right-side alerts panel (TradingView-style). Two tabs:
//  - Live    : the active price alerts on the CURRENTLY-OPEN symbol. These are
//              the only alerts that actually fire (ChartCore subscribes to one
//              WS stream), so the list is deliberately scoped to `epic` — it
//              never promises monitoring that isn't happening.
//  - History : every alert that has triggered, across all symbols, newest first
//              (persisted + capped in localStorage).
//
// Both lists re-pull their source of truth on the `alertsChanged` signal, which
// overlays bumps on add/delete/drag and ChartCore bumps on a firing.

import { useEffect, useRef, useState } from "react";
import type { ChartController } from "./lib/chartController";
import type { ChartTab } from "./lib/persist";
import { alertsChanged, alertsPanelOpen, alertEditRequest } from "./lib/signals";
import {
  loadTriggered,
  loadAllAlerts,
  clearTriggered,
  loadTriggeredSeen,
  saveTriggeredSeen,
  normalizeAlert,
  CONDITION_LABELS,
  type TriggeredAlert,
  type SavedAlert,
} from "./lib/persist";

interface Props {
  // The focused cell's controller — its overlay manager owns the live alert lines
  // shown here. epic/precision are the focused cell's too.
  controller: ChartController | null;
  epic: string;
  precision: number;
  // All open tabs/cells so we can show alerts across every symbol.
  tabs: ChartTab[];
}

type Tab = "live" | "history";

// Compact "2m ago" / "3h ago" / date for older — keeps rows scannable.
function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ms).toLocaleDateString();
}

export default function AlertsSidebar({ controller, epic, precision, tabs }: Props) {
  const overlays = controller?.overlays ?? null;
  const [tab, setTab] = useState<Tab>("live");
  const [showAll, setShowAll] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);
  useEffect(() => {
    if (!sortOpen) return;
    const close = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node))
        setSortOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sortOpen]);

  type SortKey =
    | "symbol-az" | "symbol-za"
    | "message-az" | "message-za"
    | "created-asc" | "created-desc"
    | "price-asc" | "price-desc";
  const [sortKey, setSortKey] = useState<SortKey>("created-desc");

  const SORT_OPTIONS: { key: SortKey; asc: boolean; label: string }[] = [
    { key: "symbol-az",    asc: true,  label: "Symbol (A to Z)" },
    { key: "symbol-za",    asc: false, label: "Symbol (Z to A)" },
    { key: "message-az",   asc: true,  label: "Message (A to Z)" },
    { key: "message-za",   asc: false, label: "Message (Z to A)" },
    { key: "created-asc",  asc: true,  label: "Date created (oldest first)" },
    { key: "created-desc", asc: false, label: "Date created (newest first)" },
    { key: "price-asc",    asc: true,  label: "Price (lowest first)" },
    { key: "price-desc",   asc: false, label: "Price (highest first)" },
  ];

  function sortAlerts<T extends { message: string; level: number; createdAt?: number }>(
    items: T[], sym: (item: T) => string,
  ): T[] {
    return [...items].sort((a, b) => {
      switch (sortKey) {
        case "symbol-az":    return sym(a).localeCompare(sym(b));
        case "symbol-za":    return sym(b).localeCompare(sym(a));
        case "message-az":   return a.message.localeCompare(b.message);
        case "message-za":   return b.message.localeCompare(a.message);
        case "created-asc":  return (a.createdAt ?? 0) - (b.createdAt ?? 0);
        case "created-desc": return (b.createdAt ?? 0) - (a.createdAt ?? 0);
        case "price-asc":    return a.level - b.level;
        case "price-desc":   return b.level - a.level;
        default:             return 0;
      }
    });
  }
  // `now` doubles as the re-render trigger: bumped on every alertsChanged so the
  // live list re-pulls overlays AND the history "x ago" labels refresh. Computed
  // in an effect (not during render) to stay pure. Also ticks every 30s so the
  // relative times don't go stale while the panel sits open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const bump = () => setNow(Date.now());
    const unsub = alertsChanged.subscribe(bump);
    const id = setInterval(bump, 30_000);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);

  // Live alerts for the open symbol. overlays.getAlerts() reads live overlay
  // levels, so a dragged line shows its current price. Re-pulled each render via
  // the tick above; epic changes (rehydrate) also bump alertsChanged.
  const live = sortAlerts([...(overlays?.getAlerts() ?? [])], () => epic);

  // All-alerts mode: collect saved alerts from every tab/cell. We read from
  // localStorage (the same source the alert engine uses) so we see alerts on
  // symbols not currently on-screen. Re-read on every alertsChanged bump (the
  // `now` tick above handles that). Grouped by epic, sorted price-descending.
  type AllGroup = { epic: string; precision: number; alerts: SavedAlert[] };
  const allGroups: AllGroup[] = (() => {
    if (!showAll) return [];
    // Build a precision map from open cells so we can format prices correctly.
    const precMap = new Map<string, number>();
    for (const t of tabs)
      for (const c of t.cells)
        precMap.set(c.symbol.epic, c.symbol.pricePrecision ?? 2);

    // Alerts are global per epic now — one stored list per symbol, whether or not a
    // chart is open for it. So a single localStorage scan covers everything; no
    // per-cell loop and no cross-source de-dupe.
    const byEpic = new Map<string, Map<string, SavedAlert>>();
    // loadAllAlerts returns RAW stored rows (no normalizeAlert), so legacy alerts can
    // lack id/condition. We normalize before bucketing: keying the dedup Map on a
    // missing id collapses every id-less row onto one entry (they'd vanish from the
    // list and count) and breaks React keys / condition labels. We also drop
    // already-expired alerts — a closed symbol has no engine feed to prune them, so
    // otherwise a past-expiry alert is shown and counted forever. `index` keeps the
    // backfilled legacy id deterministic (matches the engine's own id).
    const addToBucket = (ep: string, raw: SavedAlert[]) => {
      let bucket = byEpic.get(ep);
      if (!bucket) { bucket = new Map(); byEpic.set(ep, bucket); }
      raw.forEach((r, i) => {
        const a = normalizeAlert(r, i);
        if (a.expiresAt != null && now > a.expiresAt) return; // expired: can never fire
        bucket!.set(a.id, a);
      });
    };
    for (const { epic: ep, alerts } of loadAllAlerts()) addToBucket(ep, alerts);

    // Fractional digit count of a level (capped), to format symbols with no open cell.
    const decimalsOf = (n: number): number => {
      const s = String(n);
      const dot = s.indexOf(".");
      return dot === -1 ? 0 : Math.min(8, s.length - dot - 1);
    };
    const groups = [...byEpic.entries()].map(([ep, alertMap]) => {
      const alerts = sortAlerts([...alertMap.values()], () => ep);
      // Off-screen symbols have no open cell in precMap; fall back to inferring the
      // precision from the levels themselves (≥2) rather than the focused cell's, so
      // an FX level like 1.08234 doesn't render as '1.08' under a US100 (prec 2) focus.
      const inferred = Math.max(2, ...alerts.map((a) => decimalsOf(a.level)));
      return { epic: ep, precision: precMap.get(ep) ?? inferred, alerts };
    });
    // Sort groups: symbol sorts apply at group level; others keep alpha order.
    if (sortKey === "symbol-za") groups.sort((a, b) => b.epic.localeCompare(a.epic));
    else groups.sort((a, b) => a.epic.localeCompare(b.epic));
    return groups;
  })();

  const totalAll = allGroups.reduce((s, g) => s + g.alerts.length, 0);
  // History is persisted; re-read on every firing (alertsChanged) and on mount.
  const [historyState, setHistoryState] = useState<TriggeredAlert[]>(loadTriggered);
  useEffect(
    () => alertsChanged.subscribe(() => setHistoryState(loadTriggered())),
    [],
  );

  // "New" (unseen) history count: firings whose time is newer than the last time
  // the History tab was viewed (a persisted marker). Reading the marker each render
  // (cheap localStorage read) keeps the badge correct without mirroring it in state;
  // re-renders are already driven by alertsChanged (new firings) and the tab toggle.
  const seen = loadTriggeredSeen();
  const unseen = historyState.filter((t) => t.time > seen).length;
  // When History is on screen, advance the marker to the newest firing (writing to
  // localStorage is updating an external system — the allowed effect shape). The
  // saveTriggeredSeen call changes what the next render reads, so the badge clears.
  useEffect(() => {
    if (tab !== "history" || historyState.length === 0) return;
    const newest = historyState[0].time; // list is newest-first
    if (newest > seen) saveTriggeredSeen(newest);
  }, [tab, historyState, seen]);

  return (
    <aside className="alerts-panel">
      <div className="ap-head">
        <div className="ap-tabs">
          <button
            className={tab === "live" ? "on" : ""}
            onClick={() => setTab("live")}
          >
            Alerts{showAll
              ? (totalAll ? ` (${totalAll})` : "")
              : (live.length ? ` (${live.length})` : "")}
          </button>
          <button
            className={tab === "history" ? "on" : ""}
            onClick={() => setTab("history")}
          >
            {tab !== "history" && unseen > 0 && (
              <span className="ap-unseen">{unseen > 99 ? "99+" : unseen}</span>
            )}
            History
          </button>
        </div>
        <div className="ap-head-actions">
          {tab === "live" && (
            <>
              {/* Filter: icon button that opens scope dropdown */}
              <div className="ap-menu-wrap" ref={menuRef}>
                <button
                  className={`ap-icon-btn${showAll ? " on" : ""}${menuOpen ? " open" : ""}`}
                  title={showAll ? "Showing all symbols" : `Showing ${epic} only`}
                  onClick={() => { setMenuOpen((v) => !v); setSortOpen(false); }}
                >
                  {/* funnel / filter icon */}
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 3h12M4.5 7h7M7 11h2"/>
                  </svg>
                  {showAll && <span className="ap-icon-dot" />}
                </button>
                {menuOpen && (
                  <div className="ap-menu">
                    <button
                      className={`ap-menu-item${!showAll ? " on" : ""}`}
                      onClick={() => { setShowAll(false); setMenuOpen(false); }}
                    >
                      Current chart ({epic})
                    </button>
                    <button
                      className={`ap-menu-item${showAll ? " on" : ""}`}
                      onClick={() => { setShowAll(true); setMenuOpen(false); }}
                    >
                      All symbols
                    </button>
                  </div>
                )}
              </div>
              {/* Sort: icon button that opens sort dropdown */}
              <div className="ap-menu-wrap" ref={sortRef}>
                <button
                  className={`ap-icon-btn${sortKey !== "created-desc" ? " on" : ""}${sortOpen ? " open" : ""}`}
                  title="Sort alerts"
                  onClick={() => { setSortOpen((v) => !v); setMenuOpen(false); }}
                >
                  {/* A-Z alphabetical sort icon with directional arrow */}
                  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {/* down arrow on the left */}
                    <path d="M3 2.5v10M1 10l2 2.5 2-2.5"/>
                    {/* "A" top, "Z" bottom on the right */}
                    <text x="8" y="6" fontSize="6.5" fill="currentColor" stroke="none" fontWeight="700" fontFamily="sans-serif">A</text>
                    <text x="8" y="14" fontSize="6.5" fill="currentColor" stroke="none" fontWeight="700" fontFamily="sans-serif">Z</text>
                  </svg>
                  {sortKey !== "created-desc" && <span className="ap-icon-dot" />}
                </button>
                {sortOpen && (
                  <div className="ap-menu">
                    {SORT_OPTIONS.map((opt) => (
                      <button
                        key={opt.key}
                        className={`ap-menu-item ap-menu-item-sort${sortKey === opt.key ? " on" : ""}`}
                        onClick={() => { setSortKey(opt.key); setSortOpen(false); }}
                      >
                        <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" className="ap-sort-icon">
                          {opt.asc
                            ? <><path d="M6 1v10M3 8l3 3 3-3"/><path d="M2 3h4M2 6h3" opacity=".45"/></>
                            : <><path d="M6 11V1M3 4l3-3 3 3"/><path d="M2 9h4M2 6h3" opacity=".45"/></>
                          }
                        </svg>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          <button
            className="ap-close"
            title="Close panel"
            onClick={() => alertsPanelOpen.set(false)}
          >
            ✕
          </button>
        </div>
      </div>

      {tab === "live" ? (
        <div className="ap-list">
          {showAll ? (
            // All-symbols mode: grouped by epic, read from persisted store.
            // No hover/select interaction (alerts may not be on-screen).
            allGroups.length === 0 ? (
              <div className="ap-empty">No active alerts across any symbol.</div>
            ) : (
              allGroups.map((g) => (
                <div key={g.epic}>
                  <div className="ap-group-header">{g.epic}</div>
                  {g.alerts.map((a) => (
                    <div key={a.id} className="ap-row">
                      <div className="ap-row-main">
                        <span className="ap-cond">
                          {CONDITION_LABELS[a.condition]} {a.level.toFixed(g.precision)}
                        </span>
                      </div>
                      {a.message && <div className="ap-msg">{a.message}</div>}
                      <div className="ap-row-meta">
                        <span className="ap-badge">
                          {a.trigger === "once" ? "Once" : "Every time"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )
          ) : (
            // Current-chart mode: live overlay levels, supports hover/select.
            live.length === 0 ? (
              <div className="ap-empty">
                No active alerts on <strong>{epic}</strong>.
                <br />
                Use the bell to create one.
              </div>
            ) : (
              live.map((a) => (
                <div
                  key={a.id}
                  className={`ap-row ap-row-clickable${a.selected ? " selected" : ""}${
                    a.hovered ? " hovered" : ""
                  }`}
                  onClick={() => overlays?.selectAlert(a.selected ? null : a.id)}
                  onDoubleClick={() => alertEditRequest.set({ id: a.id })}
                  onMouseEnter={() => overlays?.hoverAlert(a.id)}
                  onMouseLeave={() => overlays?.hoverAlert(null)}
                >
                  <div className="ap-row-main">
                    <span className="ap-sym">{epic}</span>
                    <span className="ap-cond">
                      {CONDITION_LABELS[a.condition]} {a.level.toFixed(precision)}
                    </span>
                  </div>
                  {a.message && <div className="ap-msg">{a.message}</div>}
                  <div className="ap-row-meta">
                    <span className="ap-badge">
                      {a.trigger === "once" ? "Once" : "Every time"}
                    </span>
                    <div className="ap-row-actions">
                      <button
                        className="ap-icon-btn"
                        title="Edit alert"
                        onClick={(e) => {
                          e.stopPropagation();
                          alertEditRequest.set({ id: a.id });
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                          aria-hidden="true">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
                        </svg>
                      </button>
                      <button
                        className="ap-icon-btn"
                        title="Delete alert"
                        onClick={(e) => {
                          e.stopPropagation();
                          overlays?.remove(a.id);
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                          aria-hidden="true">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )
          )}
        </div>
      ) : (
        <div className="ap-list">
          {historyState.length === 0 ? (
            <div className="ap-empty">No alerts have triggered yet.</div>
          ) : (
            <>
              <div className="ap-clear-row">
                <button className="ap-clear" onClick={() => { clearTriggered(); setHistoryState([]); }}>
                  Clear history
                </button>
              </div>
              {historyState.map((t, i) => (
                <div key={`${t.time}-${i}`} className="ap-row ap-row-hist">
                  <div className="ap-row-main">
                    <span className="ap-sym">{t.epic}</span>
                    <span className="ap-time">{ago(t.time, now)}</span>
                  </div>
                  <div className="ap-cond">
                    {/* History is cross-symbol: format with the firing's own
                        precision, falling back to the focused one for old rows. */}
                    {CONDITION_LABELS[t.condition]} {t.level.toFixed(t.precision ?? precision)}
                    <span className="ap-at"> @ {t.price.toFixed(t.precision ?? precision)}</span>
                  </div>
                  {t.message && <div className="ap-msg">{t.message}</div>}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
