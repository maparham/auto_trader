// Surfacing a fired alert in this tab: the toast, browser notification and
// sound (per the alert's channels), the tab badge mark, and the history bump.
// The firing itself happens in the backend.
import { useEffect } from "react";
import { fmtPrice } from "../lib/priceFormat";
import { notify, playPing, toast } from "../lib/notify";
import { alertFired, alertNavHandler, bumpAlerts } from "../lib/signals";
import { setOnAlertFired } from "../lib/persist";

export function useAlertFiredNotices() {
  // Alert FIRING lives in the backend now (it runs with no tab open). All this
  // tab does is surface a firing: the server broadcasts `__alerts__:fired` over
  // /ws/state, persist/core hands it to alertsApi, and alertsApi calls back here.
  // Registered once — the deleted browser engine's fire() relocated, copy verbatim.
  useEffect(() => {
    setOnAlertFired((p) => {
      // Guard against a bad/out-of-range payload (server validates on write,
      // but a stale/mismatched deploy or hand-rolled ws message shouldn't be
      // able to RangeError out of toFixed and kill this handler).
      const prec = Math.min(10, Math.max(0, p.precision ?? 2));
      const now = fmtPrice(p.price, prec);
      // Attribution: always lead with the epic, even for a custom message — the
      // sound alone says nothing about WHERE. One `detail` feeds both surfaces.
      const detail = p.message || `@ ${fmtPrice(p.level, prec)}`;
      const body = `${p.epic} ${p.message ? "\u00b7 " : ""}${detail}`;
      // Click either surface to jump to a chart on this epic and select the line.
      const goTo = () => alertNavHandler.current?.(p.epic, p.id, prec);
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
    return () => setOnAlertFired(null);
  }, []);
}
