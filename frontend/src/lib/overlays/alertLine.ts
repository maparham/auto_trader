// The one way an alert line is drawn, for price alerts (OverlayAlerts) and
// indicator value alerts (IndicatorAlertLines): same overlay template, same
// dashed amber style, same selected weight.
import type { Chart } from "klinecharts";
import { ALERT_LINE_STYLE, ALERT_LINE_SELECTED_SIZE, ALERT_LINE_SIZE } from "./shared";

export const ALERT_OVERLAY = "alertPriceLine";

export function alertLineStyles(selected: boolean) {
  return {
    ...ALERT_LINE_STYLE,
    line: { ...ALERT_LINE_STYLE.line, size: selected ? ALERT_LINE_SELECTED_SIZE : ALERT_LINE_SIZE },
  };
}

export function createAlertLine(
  chart: Chart,
  o: { id: string; paneId?: string; value: number; visible: boolean; extendData?: unknown },
): string | null {
  const id = chart.createOverlay({
    id: o.id,
    name: ALERT_OVERLAY,
    points: [{ value: o.value }],
    styles: alertLineStyles(false),
    visible: o.visible,
    extendData: o.extendData,
    mode: "normal",
    needDefaultYAxisFigure: false,
    // The alert template's OWN default is needDefaultXAxisFigure: true
    // (shared.ts); the shared `OverlayManager.create()` path suppresses it
    // for kind "alert" (klinecharts would stamp the selected line's start
    // timestamp under it). This path bypasses create(), so it repeats the
    // suppression itself.
    needDefaultXAxisFigure: false,
    // Locked: this line's VALUE is moved by the app's own indAlertDrag (hit-
    // tested in pixel space, chart/useLineDrag.ts), not by klinecharts'
    // native point-drag.
    lock: true,
    // v10 contract: returning a value from onRightClick no longer suppresses
    // the library's default "delete the overlay on right-click"; only
    // e.preventDefault() does (see lib/overlays.ts's own onRightClick for the
    // same fix on price alert lines).
    onRightClick: (e: { preventDefault?: () => void }) => {
      e.preventDefault?.();
      return true;
    },
    ...(o.paneId ? { paneId: o.paneId } : {}),
  } as never);
  return typeof id === "string" ? id : null;
}
