// The active broker account for this browser tab: the selectable accounts,
// the per-broker last-used memory behind the tab-bar broker switch, the
// trades-feed routing, and the real-money account summary the dock shows.
import { useEffect, useRef, useState } from "react";
import { isDemoMode } from "../lib/demoMode";
import { getDemoSnapshot } from "../lib/demoSnapshot";
import { accountSnapshotFrom, setAccountSnapshot } from "../lib/accountSnapshot";
import { requestConfirm } from "../lib/signals";
import {
  fetchBrokers,
  cachedBrokers,
  setTradesAccount,
  DEFAULT_ACCOUNT,
  brokerOf,
  isRealMoneyAccount,
  fetchAccountSummary,
  loadLastAccountByBroker,
  saveLastAccountByBroker,
  type BrokerAccount,
  type TradeAccount,
  type AccountSummary,
} from "../lib/trading";
import { BrokerBlockedError } from "../lib/http";
import { reportBrokerBlocked, reportBrokerReachable } from "../lib/brokerBlocked";
import { sessionGet, sessionSet } from "../lib/persist";
import type { Settings } from "../theme";

export function useAccounts(isDirty: boolean, tradingSettings: Settings["trading"]) {
  // Active broker / trading account (registry key "{broker}:{env}"). Drives BOTH
  // the chart data feed (epics are broker-specific) and order/position routing.
  // PER BROWSER TAB: sessionStorage is this tab's selection (each app tab can sit
  // on a different broker); the bare localStorage key is only the last-used seed
  // a brand-new tab opens on. The list of selectable accounts comes from GET
  // /api/brokers.
  const [accounts, setAccounts] = useState<BrokerAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<TradeAccount>(
    () =>
      // The public demo is pinned to the published snapshot's credential-free
      // data feed (yfinance for new publishes, dukascopy before the broker
      // field existed); any stored account belongs to a signed-in session and
      // must not leak in. DemoApp resolves the snapshot before App mounts, so
      // the synchronous read is settled here.
      isDemoMode()
        ? `${getDemoSnapshot()?.broker ?? "dukascopy"}:data`
        : (sessionGet("activeAccount") ??
          localStorage.getItem("activeAccount") ??
          DEFAULT_ACCOUNT),
  );
  const brokerId = brokerOf(activeAccount);

  // Remember the last-used account PER broker, so switching brokers in the tab-bar
  // selector returns to the env you were last on for that broker (not always paper).
  // Device-local; a plain {broker: "{broker}:{env}"} map. Updated on every active-
  // account change (effect below); read by selectBroker.
  const lastAccountByBroker = useRef<Record<string, TradeAccount>>(null!);
  if (lastAccountByBroker.current === null) {
    lastAccountByBroker.current = loadLastAccountByBroker();
  }

  // Switch the active BROKER (tab-bar selector). Picks the account to land on within
  // that broker: the last one used there (if still registered), else its paper
  // account, else its first registered account. brokerId is derived from the account,
  // so this is the single lever that drives the per-broker workspace swap.
  const selectBroker = (broker: string) => {
    if (broker === brokerId) return;
    const ofBroker = accounts.filter((a) => a.broker === broker);
    const remembered = lastAccountByBroker.current[broker];
    const next =
      (remembered && ofBroker.some((a) => a.key === remembered) && remembered) ||
      ofBroker.find((a) => a.env === "paper")?.key ||
      ofBroker[0]?.key ||
      `${broker}:paper`;
    // Switching broker swaps the WHOLE workspace (the broker-switch effect reseeds
    // from the incoming broker's saved state), which discards in-memory edits that
    // autosave-off mode deliberately left unsaved. `isDirty` is true ONLY in that
    // case (App's persist effect sets it nowhere else), so confirm before discarding
    // — a silent drop of unsaved named-layout work was the bug. Cancel = stay put
    // (the user can ⌘S first); autosave-on / scratch never reach here (not dirty).
    if (isDirty) {
      requestConfirm({
        message: "You have unsaved changes to this layout. Switch broker and discard them?",
        onConfirm: () => setActiveAccount(next),
      });
    } else {
      setActiveAccount(next);
    }
  };

  // Load the selectable accounts once. If the persisted active account is no longer
  // registered (e.g. config changed), fall back to the first available.
  useEffect(() => {
    let alive = true;
    // Seed from the last-good cache so the selector is populated immediately and
    // survives a transient backend hiccup — a fresh fetch then refreshes it. This
    // is why one broker being down (which can make the live fetch time out behind
    // saturated connections) no longer leaves the account list empty.
    const cached = cachedBrokers();
    if (cached) setAccounts(cached.exec);
    void fetchBrokers()
      .then((info) => {
        if (!alive) return;
        setAccounts(info.exec);
        if (
          !isDemoMode() &&
          info.exec.length &&
          !info.exec.some((a) => a.key === activeAccount)
        ) {
          setActiveAccount(info.exec[0].key);
        }
      })
      .catch(() => {
        /* keep the cached/default accounts; the backend may be momentarily down */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active account and point the shared trades poll at it, so the
  // positions/orders dock follows the selection.
  useEffect(() => {
    // A demo session's pin (`${broker}:data`) must not become the seed a
    // signed-in tab opens on: these keys are NOT workspace-prefixed, so the
    // admin's ?demo=preview tab would otherwise leak them past the preview
    // namespace into the real ones. The pin is derived, never persisted.
    if (!isDemoMode()) {
      sessionSet("activeAccount", activeAccount); // this tab's truth (guarded write)
      localStorage.setItem("activeAccount", activeAccount); // seed for future tabs
    }
    // Always point the trades feed at the current account, INCLUDING a data-only
    // source: setTradesAccount clears the prior broker's trades synchronously, so
    // switching to Dukascopy can't leave a stale (and interactable) position lingering
    // on the chart. Its positions/orders fetch for dukascopy:data 404/422s and is
    // caught, leaving the feed empty (the dock shows a "history only" note).
    setTradesAccount(activeAccount);
    // Remember this as the broker's last-used account (read when the tab-bar selector
    // switches back to this broker). Re-read the map from disk first: sibling tabs
    // write this shared device-local map too, and every write is flushed immediately,
    // so disk is never behind — only this tab's own entry comes from memory.
    if (!isDemoMode()) {
      lastAccountByBroker.current = {
        ...loadLastAccountByBroker(),
        [brokerId]: activeAccount,
      };
      saveLastAccountByBroker(lastAccountByBroker.current);
    }
  }, [activeAccount, brokerId]);

  // Real per-account balance/currency for the dock's stats strip — a LIVE account
  // shows its true figures instead of the global paper balance. Only real-money
  // accounts have a summary (paper → null → dock keeps its paper math). Like the
  // trades feed, real accounts get no server push, so poll (paused when hidden);
  // paper clears it. Refetches on every account switch.
  const [accountSummary, setAccountSummary] = useState<AccountSummary | null>(null);
  useEffect(() => {
    if (!isRealMoneyAccount(activeAccount)) {
      setAccountSummary(null);
      return;
    }
    let alive = true;
    // The first load runs even in a hidden tab (one opened in the background
    // would otherwise show the paper currency and no margin buffer until
    // shown), like the trades feed's first refresh. Only the poll pauses, and
    // showing the tab refreshes at once instead of waiting out the interval.
    const load = (force = false) => {
      if (!force && document.hidden) return;
      fetchAccountSummary(activeAccount)
        .then((s) => {
          if (alive) setAccountSummary(s);
          reportBrokerReachable();
        })
        .catch((e) => {
          // Keep last-known figures on a transient error, but surface a blocked
          // network path (WAF / restricted connection) instead of hiding it.
          if (e instanceof BrokerBlockedError) reportBrokerBlocked(e.message);
        });
    };
    load(true);
    const timer = setInterval(load, 6_000);
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [activeAccount]);

  // Mirror the account onto a module-level snapshot for the trade drawings: their
  // overlay paints synchronously (createPointFigures must never fetch), so it
  // reads the last polled balance/currency from there.
  useEffect(() => {
    setAccountSnapshot(accountSnapshotFrom(accountSummary, tradingSettings));
  }, [accountSummary, tradingSettings]);
  return { accounts, activeAccount, setActiveAccount, brokerId, selectBroker, accountSummary };
}
