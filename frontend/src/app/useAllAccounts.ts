// Polling for the dock's "All accounts" tab. The OTHER visible dealing accounts
// are fetched every 30 s while the tab is shown (with their summaries) and every
// 2 min otherwise (positions only, to keep the tab's count current). The active
// account is never fetched here: its entry is the dock's own trades feed and
// summary. Hidden accounts are never fetched. Paused while the page is hidden.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dealingAccounts,
  fetchSnapshot,
  loadHiddenAccounts,
  otherOpenCount,
  saveHiddenAccounts,
  visibleAndHidden,
  type AccountSnapshot,
} from "../lib/allAccounts";
import type { AccountSummary, BrokerAccount, TradeAccount, TradeView } from "../lib/trading";

export const ALL_ACCOUNTS_OPEN_MS = 30_000;
export const ALL_ACCOUNTS_CLOSED_MS = 120_000;

export interface AllAccountsData {
  visible: BrokerAccount[];
  hidden: BrokerAccount[];
  snaps: Record<string, AccountSnapshot>;
  count: number | null;
  updatedAt: number | null;
  refresh(): void;
  setHidden(account: TradeAccount, hide: boolean): void;
  hasAccounts: boolean;
}

export function useAllAccounts(opts: {
  accounts: BrokerAccount[];
  active: TradeAccount;
  activePositions: TradeView[];
  activeSummary: AccountSummary | null;
  open: boolean;
}): AllAccountsData {
  const { accounts, active, activePositions, activeSummary, open } = opts;
  const [hiddenIds, setHiddenIds] = useState<string[]>(loadHiddenAccounts);
  const [fetchedSnaps, setFetchedSnaps] = useState<Record<string, AccountSnapshot>>({});
  const snapsRef = useRef(fetchedSnaps);
  snapsRef.current = fetchedSnaps;
  const inFlight = useRef(new Set<TradeAccount>());

  const dealing = useMemo(() => dealingAccounts(accounts), [accounts]);
  const { visible, hidden } = useMemo(() => visibleAndHidden(dealing, hiddenIds), [dealing, hiddenIds]);
  const targets = useMemo(
    () => visible.filter((a) => a.key !== active).map((a) => a.key),
    [visible, active],
  );
  const targetsKey = targets.join("|");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  const fetchAll = useCallback((withSummary: boolean) => {
    for (const key of targetsRef.current) {
      if (inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      void fetchSnapshot(snapsRef.current[key], key, withSummary)
        .then((s) => setFetchedSnaps((prev) => ({ ...prev, [key]: s })))
        .finally(() => inFlight.current.delete(key));
    }
  }, []);

  useEffect(() => {
    const tick = () => {
      if (!document.hidden) fetchAll(open);
    };
    tick();
    const id = setInterval(tick, open ? ALL_ACCOUNTS_OPEN_MS : ALL_ACCOUNTS_CLOSED_MS);
    const onVis = () => {
      if (!document.hidden) fetchAll(open);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [open, targetsKey, fetchAll]);

  const isDealingActive = dealing.some((a) => a.key === active);
  const snaps = useMemo(() => {
    if (!isDealingActive) return fetchedSnaps;
    const own: AccountSnapshot = {
      account: active,
      positions: activePositions.filter((t) => t.kind === "position"),
      summary: activeSummary,
      error: null,
      fetchedAt: null,
    };
    return { ...fetchedSnaps, [active]: own };
  }, [fetchedSnaps, isDealingActive, active, activePositions, activeSummary]);

  const updatedAt = useMemo(() => {
    let best: number | null = null;
    for (const key of targets) {
      const t = fetchedSnaps[key]?.fetchedAt;
      if (t != null && (best == null || t > best)) best = t;
    }
    return best;
  }, [fetchedSnaps, targets]);

  const setHidden = useCallback((account: TradeAccount, hide: boolean) => {
    setHiddenIds((prev) => {
      const next = hide
        ? prev.includes(account) ? prev : [...prev, account]
        : prev.filter((k) => k !== account);
      saveHiddenAccounts(next);
      return next;
    });
  }, []);

  return {
    visible,
    hidden,
    snaps,
    count: otherOpenCount(snaps, visible, active),
    updatedAt,
    refresh: () => fetchAll(true),
    setHidden,
    hasAccounts: dealing.length > 0,
  };
}
