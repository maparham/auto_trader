// The tab chips' badges: the unseen-alert bell (an alert fired for an epic the
// user wasn't looking at) and the market-closed crescent for every tab's lead
// epic, including background tabs whose charts aren't mounted.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { alertFired } from "../lib/signals";
import { fetchMarketsStatus } from "../lib/feed";
import { PREFIX, load, saveLocal, type ChartTab } from "../lib/persist";
import { isSynthetic } from "../lib/syntheticRegistry";

// Unseen-alert bell badge storage (device-local; listed in DEVICE_LOCAL_FLAT_KEYS).
const UNSEEN_KEY = `${PREFIX}.alertUnseen`;
const readUnseen = () => new Set(load<string[]>(UNSEEN_KEY, []));

export function useUnseenAlertTabs(tabs: ChartTab[], active: ChartTab | undefined) {
  // Tab bell badges: an alert firing for an epic NOT visibly on the active tab
  // marks that EPIC unseen; every non-active tab holding the epic shows a bell
  // until one of them is visited. Keyed by epic (alerts are global per
  // instrument). localStorage is the SOURCE OF TRUTH: every mutation is a
  // read-modify-write against storage — shared across browser tabs, so two
  // fires in one render frame or another tab's clear can't be stomped by a
  // stale in-memory snapshot — and the storage listener folds other tabs'
  // writes into this tab's state.
  const [unseenAlertEpics, setUnseenAlertEpics] = useState<ReadonlySet<string>>(readUnseen);
  // The alert subscription below outlives renders, so the state comparison
  // must read the latest set, not the one from the render that subscribed.
  const unseenRef = useRef(unseenAlertEpics);
  unseenRef.current = unseenAlertEpics;
  const mutateUnseen = useCallback((mutate: (s: Set<string>) => boolean) => {
    const cur = readUnseen();
    const changed = mutate(cur);
    // Sync state whenever it differs from the (possibly externally-updated)
    // result, not only when the mutation changed storage — otherwise a silently
    // dropped saveLocal (quota) leaves in-memory badges diverged forever.
    const seen = unseenRef.current;
    const stateDiffers = cur.size !== seen.size || [...cur].some((e) => !seen.has(e));
    if (!changed && !stateDiffers) return;
    if (changed) saveLocal(UNSEEN_KEY, [...cur]);
    setUnseenAlertEpics(cur);
  }, []);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      // key === null is localStorage.clear() — the set is gone there too.
      if (e.key === UNSEEN_KEY || e.key === null) setUnseenAlertEpics(readUnseen());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // Re-evaluate "user can see the active chart" when the browser tab is SHOWN
  // — that's the moment the active tab's unseen epics become seen. Hide events
  // don't bump (the mark-seen effect no-ops while hidden anyway), sparing an
  // App re-render per tab switch-away.
  const [visTick, setVisTick] = useState(0);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") setVisTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(
    () =>
      alertFired.subscribe((f) => {
        if (!f) return;
        // A fire for an epic on the ACTIVE tab is seen as it happens — but only
        // when the browser tab is actually visible; a fire behind a hidden tab
        // still deserves a mark (the user may have muted the toast).
        if (
          document.visibilityState === "visible" &&
          active?.cells.some((c) => c.symbol.epic === f.epic)
        )
          return;
        mutateUnseen((s) => (s.has(f.epic) ? false : (s.add(f.epic), true)));
      }),
    [active, mutateUnseen],
  );
  // Viewing a tab (it's active AND the browser tab is visible) marks the epics
  // it shows as seen.
  useEffect(() => {
    if (!active || document.visibilityState !== "visible") return;
    if (!active.cells.some((c) => unseenAlertEpics.has(c.symbol.epic))) return;
    mutateUnseen((s) => {
      let changed = false;
      for (const c of active.cells) changed = s.delete(c.symbol.epic) || changed;
      return changed;
    });
  }, [active, unseenAlertEpics, visTick, mutateUnseen]);
  const alertTabIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tabs)
      if (t.id !== active?.id && t.cells.some((c) => unseenAlertEpics.has(c.symbol.epic)))
        ids.add(t.id);
    return ids;
  }, [tabs, active?.id, unseenAlertEpics]);
  return alertTabIds;
}

// Tab closed-badge refresh cadence: a normal re-check, and a sooner one after
// a lookup failed (upstream error or timeout).
const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 20_000;

export function useMarketClosedBadges(tabs: ChartTab[], brokerId: string) {
  // Market open/closed status (+ next-open time) keyed by EPIC, for the tab
  // closed badge. Polled at the App level (here) for every tab's lead epic, not
  // just the active tab's — only the active tab mounts a ChartGrid/ChartCore, so
  // sourcing the badge from per-cell ChartCore state left background tabs stale
  // (a moon stuck on after a market reopened) or unbadged. Keying by epic also
  // bounds the map to distinct lead symbols and lets us prune it to the tabs that
  // currently exist.
  const [epicClosed, setEpicClosed] = useState<
    Record<string, { closed: boolean; nextOpen: string | null }>
  >({});

  // The distinct lead epics across all tabs (the lead cell is the focused-or-first
  // one, matching how TabBar picks the chip). Joined into a stable string so the
  // poll effect below only re-subscribes when the SET of lead epics changes, not
  // on every unrelated tab edit.
  const leadEpicsKey = useMemo(() => {
    const epics = new Set<string>();
    for (const t of tabs) {
      const lead = t.cells.find((c) => c.id === t.activeCellId) ?? t.cells[0];
      if (lead && !isSynthetic(lead.symbol.epic)) epics.add(lead.symbol.epic);
    }
    // JSON (not a delimiter-joined string) so the key round-trips cleanly back to
    // an array regardless of what characters an epic contains — a comma in an epic
    // would corrupt a comma-joined key.
    return JSON.stringify([...epics].sort());
  }, [tabs]);

  // Open/closed badge for every tab's lead epic, so background tabs (whose
  // ChartCore isn't mounted) still show a closed crescent. One call for all
  // epics, answered from the backend's shared cache (core/market_status.py),
  // so it costs no upstream call per user or reload. Refreshed when the tab
  // set or broker changes, when the earliest known reopen time passes, every
  // REFRESH_MS while the page is visible (catches a market closing), when the
  // page becomes visible again, and soon after a lookup failed.
  useEffect(() => {
    const epics: string[] = leadEpicsKey ? JSON.parse(leadEpicsKey) : [];
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (): Promise<void> => {
      clearTimeout(timer);
      const status = await fetchMarketsStatus(epics, brokerId);
      if (cancelled) return;
      if (status) {
        // Replace wholesale (not merge) so epics no longer present are dropped.
        const next: Record<string, { closed: boolean; nextOpen: string | null }> = {};
        for (const e of epics) {
          const m = status[e];
          next[e] = { closed: m?.closed === true, nextOpen: m?.closed === true ? m.nextOpen : null };
        }
        setEpicClosed(next);
      }
      // Retry soon only after a FAILED lookup: closed: null without error is a
      // broker that never reports open/closed, and polling it fast is waste.
      const failed = !status || epics.some((e) => !status[e] || status[e].error === true);
      let ms = failed ? RETRY_MS : REFRESH_MS;
      for (const m of Object.values(status ?? {})) {
        if (m.closed !== true || !m.nextOpen) continue;
        ms = Math.min(ms, Math.max(1000, Date.parse(m.nextOpen) - Date.now() + 2000));
      }
      clearTimeout(timer); // an overlapping refresh may have armed one
      timer = setTimeout(() => {
        // Hidden: wait for the visibility listener instead of polling.
        if (document.visibilityState === "visible") void refresh();
      }, ms);
    };
    const onVis = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };

    void refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [leadEpicsKey, brokerId]);
  return epicClosed;
}
