// The tab chips' badges: the unseen-alert bell (an alert fired for an epic the
// user wasn't looking at) and the market-closed crescent for every tab's lead
// epic, including background tabs whose charts aren't mounted.
import { useEffect, useMemo, useState } from "react";
import { alertFired } from "../lib/signals";
import { fetchMarketMeta } from "../lib/feed";
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
  const mutateUnseen = (mutate: (s: Set<string>) => boolean) => {
    const cur = readUnseen();
    const changed = mutate(cur);
    // Sync state whenever it differs from the (possibly externally-updated)
    // result, not only when the mutation changed storage — otherwise a silently
    // dropped saveLocal (quota) leaves in-memory badges diverged forever.
    const stateDiffers =
      cur.size !== unseenAlertEpics.size || [...cur].some((e) => !unseenAlertEpics.has(e));
    if (!changed && !stateDiffers) return;
    if (changed) saveLocal(UNSEEN_KEY, [...cur]);
    setUnseenAlertEpics(cur);
  };
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
    [active],
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
  }, [active, unseenAlertEpics, visTick]);
  const alertTabIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tabs)
      if (t.id !== active?.id && t.cells.some((c) => unseenAlertEpics.has(c.symbol.epic)))
        ids.add(t.id);
    return ids;
  }, [tabs, active?.id, unseenAlertEpics]);
  return alertTabIds;
}

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
  // ChartCore isn't mounted) still show a closed crescent. Event-driven, NOT
  // polled: fetch each epic once when the tab set / broker changes, then for a
  // CLOSED epic schedule a single re-check exactly at `nextOpen` (rescheduling
  // itself). An open background tab that later closes shows stale until it's
  // activated — at which point the active chart's ChartCore corrects it live from
  // the stream. This trades a little background-badge latency for zero polling.
  useEffect(() => {
    const epics: string[] = leadEpicsKey ? JSON.parse(leadEpicsKey) : [];
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const toEntry = (meta: Awaited<ReturnType<typeof fetchMarketMeta>>) => ({
      closed: meta.closed === true,
      nextOpen: meta.closed === true ? meta.nextOpen : null,
    });

    // Re-check a closed epic exactly when it should reopen — an event, not a poll.
    const scheduleReopen = (epic: string, meta: Awaited<ReturnType<typeof fetchMarketMeta>>) => {
      if (meta.closed !== true || !meta.nextOpen) return;
      const ms = Math.min(Math.max(1000, Date.parse(meta.nextOpen) - Date.now()), 2_000_000_000);
      timers.push(
        setTimeout(async () => {
          const m = await fetchMarketMeta(epic, brokerId).catch(() => null);
          if (cancelled || !m) return;
          setEpicClosed((prev) => ({ ...prev, [epic]: toEntry(m) }));
          scheduleReopen(epic, m);
        }, ms),
      );
    };

    void (async () => {
      const entries = await Promise.all(
        epics.map(async (epic) => [epic, await fetchMarketMeta(epic, brokerId)] as const),
      );
      if (cancelled) return;
      // Replace wholesale (not merge) so epics no longer present are dropped.
      setEpicClosed(Object.fromEntries(entries.map(([e, m]) => [e, toEntry(m)])));
      for (const [epic, meta] of entries) scheduleReopen(epic, meta);
    })();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [leadEpicsKey, brokerId]);
  return epicClosed;
}
