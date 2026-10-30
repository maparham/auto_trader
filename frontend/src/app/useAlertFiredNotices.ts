// Surfacing a fired alert in this tab: the toast, browser notification and
// sound (per the alert's channels), the tab badge mark, and the history bump.
// The firing itself happens in the backend.
import { useEffect } from "react";
import { fmtPrice } from "../lib/priceFormat";
import { notify, playPing, toast } from "../lib/notify";
import { alertFired, alertNavHandler, bumpAlerts, toggleSidePanel } from "../lib/signals";
import { setOnAlertFired } from "../lib/persist";
import {
  accountLabel,
  conditionPhrase,
  levelText,
  setOnAccountMonitor,
  type FiredPayload,
} from "../lib/alertsApi";

// What fired, one string for the toast and the browser notification. A custom
// message wins; a price alert keeps "@ level"; an indicator alert names the
// indicator through the shared conditionPhrase (same wording as the panel).
export function firedDetail(p: FiredPayload, prec: number): string {
  if (p.message) return p.message;
  if (!p.label) return `@ ${fmtPrice(p.level, prec)}`;
  return conditionPhrase(p.label, p.condition, p.target, levelText(p.target ?? "price", p.level, prec));
}

export function useAlertFiredNotices() {
  // Alert FIRING lives in the backend now (it runs with no tab open). All this
  // tab does is surface a firing: the server broadcasts `__alerts__:fired` over
  // /ws/state, persist/core hands it to alertsApi, and alertsApi calls back here.
  // Registered once — the deleted browser engine's fire() relocated, copy verbatim.
  useEffect(() => {
    setOnAlertFired((p) => {
      if (p.kind === "account") {
        // No epic and no chart: the headline IS the message; click opens the
        // trade list, where the account strip shows the live figures.
        const text = p.message ? `${p.headline} \u00b7 ${p.message}` : p.headline ?? "Account alert";
        const open = () => toggleSidePanel("tradeList");
        const key = `account|${p.id}`;
        const icon = p.critical ? "\u{1F6A8}" : "\u{1F514}";
        if (p.notify?.toast ?? true) toast(`${icon} ${text}`, { onClick: open, duration: null, key });
        if (p.notify?.browser ?? true) notify(accountLabel(p.account ?? p.broker), text, open, key);
        if (p.notify?.sound ?? true) playPing();
        bumpAlerts();
        return;
      }
      // Guard against a bad/out-of-range payload (server validates on write,
      // but a stale/mismatched deploy or hand-rolled ws message shouldn't be
      // able to RangeError out of toFixed and kill this handler).
      const prec = Math.min(10, Math.max(0, p.precision ?? 2));
      const now = fmtPrice(p.price, prec);
      // Attribution: always lead with the epic, even for a custom message — the
      // sound alone says nothing about WHERE. One `detail` feeds both surfaces.
      const detail = firedDetail(p, prec);
      const body = `${p.epic} ${p.message ? "\u00b7 " : ""}${detail}`;
      // Click either surface to jump to a chart on this epic and select the line.
      // The broker rides along: a firing on another broker asks before switching.
      const goTo = () => alertNavHandler.current?.(p.epic, p.id, prec, p.broker);
      // Per-alert dedupe key: an "every" alert oscillating around its level
      // coalesces into the existing toast / replaces the banner, never stacks.
      const key = `${p.epic}|${p.id}`;
      if (p.notify?.toast ?? true)
        toast(`\u{1F514} ${body} (now ${now})`, { onClick: goTo, duration: null, key });
      if (p.notify?.browser ?? true) notify(p.epic, `${detail} \u00b7 now ${now}`, goTo, key);
      if (p.notify?.sound ?? true) playPing();
      // Outside the channel gates, like the server-written history: the tab badge
      // is attribution ("something fired here"), not a mutable surface.
      alertFired.set({ epic: p.epic });
      // applyAlertEvent already prepended the firing to the triggered cache but
      // doesn't bump — do it here so the History tab and any once-alert removal
      // re-render.
      bumpAlerts();
    });
    // Account monitor state (session dropped / resumed). No channel gates: the
    // backend only sends a transition, and the user should always see it.
    setOnAccountMonitor((m) => {
      const icon = m.status === "unmonitored" ? "\u26A0\uFE0F" : "\u2705";
      const key = `monitor|${m.broker}`;
      toast(`${icon} ${m.headline}`, { duration: null, key });
      notify(accountLabel(m.broker), m.headline, undefined, key);
      bumpAlerts();
    });
    return () => {
      setOnAlertFired(null);
      setOnAccountMonitor(null);
    };
  }, []);
}
