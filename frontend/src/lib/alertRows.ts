// Alert row logic shared by the desktop AlertsSidebar and the mobile Alerts
// tab. Everything here is text and facts, never markup: each screen keeps its
// own layout and CSS, so the two can look different while saying the same
// thing about every alert.

import { useEffect, useState } from "react";
import { alertsChanged } from "./signals";
import { brokerOf } from "./trading";
import {
  accountLabel,
  fmtMetric,
  loadAccountAlerts,
  loadPositionAlerts,
  METRIC_LABELS,
  resyncAlerts,
  triggeredLabel,
  type AccountAlert,
  type PositionAlert,
  type TriggeredAlert,
} from "./alertsApi";

/** How often the alert lists refresh their "x ago" labels and, while account
 * or position alerts exist, re-read the server's figures. */
export const ALERT_TICK_MS = 30_000;

/** `Date.now()`, bumped on every alert change and every ALERT_TICK_MS. The
 * tick also resyncs while account or position alerts exist: their "now"
 * values, fired tiers and monitored flag only arrive with the alerts list
 * (the monitor polls every 30 s too), so a list would otherwise keep showing
 * the boot-time figures. */
export function useAlertTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const bump = () => setNow(Date.now());
    const unsub = alertsChanged.subscribe(bump);
    const id = setInterval(() => {
      bump();
      if (loadAccountAlerts().length > 0 || loadPositionAlerts().length > 0) void resyncAlerts();
    }, ALERT_TICK_MS);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);
  return now;
}

/** Fractional digit count of a level (capped at 8), to format a symbol that
 * has no open chart to supply its precision. */
export function decimalsOf(n: number): number {
  const s = String(n);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : Math.min(8, s.length - dot - 1);
}

export interface HistoryRowView {
  title: string;
  /** The broker id the firing lives on, when it is not the active one. */
  foreignBroker: string | null;
  cond: string;
  precision: number;
  isAccount: boolean;
}

/** One History row. `t.broker` is a broker id on most firings but an account
 * key (`capital:demo`) on position firings, so it is compared through
 * brokerOf; an account firing has no chart, so it is never foreign. */
export function historyRowView(t: TriggeredAlert, activeBroker: string, fallbackPrecision: number): HistoryRowView {
  const precision = t.precision ?? fallbackPrecision;
  const isAccount = t.kind === "account";
  const b = t.broker ? brokerOf(t.broker) : null;
  return {
    title: isAccount ? accountLabel(t.broker ?? "") : t.epic,
    foreignBroker: !isAccount && b != null && b !== activeBroker ? b : null,
    cond: triggeredLabel(t, precision),
    precision,
    isAccount,
  };
}

/** Firings newer than the History "seen" marker. */
export function unseenCount(history: TriggeredAlert[], seen: number): number {
  return history.filter((t) => t.time > seen).length;
}

export interface AccountRowView {
  title: string;
  metric: string;
  /** The current value, formatted, or null before the first poll. */
  now: string | null;
  tiers: { level: number; text: string; label: string; fired: boolean }[];
  /** Why the account is not monitored, or null when it is. */
  unmonitored: string | null;
}

export function accountRowView(a: AccountAlert): AccountRowView {
  const fired = new Set(a.firedTiers ?? []);
  const currency = a.currency ?? null;
  return {
    title: accountLabel(a.account),
    metric: METRIC_LABELS[a.metric],
    now: a.current != null ? fmtMetric(a.metric, a.current, currency) : null,
    tiers: a.tiers.map((t) => ({
      level: t.level,
      text: fmtMetric(a.metric, t.level, currency),
      label: t.label,
      fired: fired.has(t.level),
    })),
    unmonitored: a.monitored === false ? (a.unmonitoredReason ?? "Not monitored") : null,
  };
}

export interface PositionRowView {
  title: string;
  cond: string;
  fired: boolean;
  sideLabel: "SL" | "TP";
}

/** `US100 long` / `SL · 0.5× ATR · now 0.8 ATR`. The long/short word needs the
 * deal in `trades`, which holds only the active account's positions. */
export function positionRowView(a: PositionAlert, trades: { id: string; side: "buy" | "sell" }[]): PositionRowView {
  const trade = trades.find((t) => t.id === a.dealId);
  const dir = trade ? ` ${trade.side === "buy" ? "long" : "short"}` : "";
  const sideLabel = a.side === "sl" ? "SL" : "TP";
  const now = a.distanceAtr == null ? "now n/a" : `now ${Number(a.distanceAtr.toFixed(2))} ATR`;
  return {
    title: `${a.epic}${dir}`,
    cond: `${sideLabel} · ${a.atrMult}× ATR · ${now}`,
    fired: !!a.fired,
    sideLabel,
  };
}
