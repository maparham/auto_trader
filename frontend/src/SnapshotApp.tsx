// Chrome-less single-chart boot for the backend's alert-time screenshot.
// Opened headlessly (core/chart_snapshot.py) as
//   /?snapshot=1&broker=..&epic=..&level=..&price=..&token=..
// Rebuilds the user's last-seen view for the epic (heartbeat descriptor +
// mirrored scope content) with LIVE data, then flags window.__snapshotReady
// for the renderer to screenshot. Every failure sets window.__snapshotError
// instead — the renderer falls back to the matplotlib image.
import { useEffect, useState } from "react";
import type { Chart } from "klinecharts";
import ChartCore from "./ChartCore";
import { applyThemeToDocument, loadSettings } from "./theme";
import { hydrateFromBackend } from "./lib/persist";
import { hydrateAlerts } from "./lib/alertsApi";
import { setTokenGetter } from "./lib/authToken";
import { parseSnapshotParams, resolveDescriptor } from "./lib/snapshotBoot";
import type { ViewDescriptor } from "./lib/viewHeartbeat";
import { periodByResolution } from "./lib/feed";

declare global {
  interface Window {
    __snapshotReady?: boolean;
    __snapshotError?: string;
  }
}

const fail = (msg: string) => {
  window.__snapshotError = msg;
};

export default function SnapshotApp() {
  const [desc, setDesc] = useState<ViewDescriptor | null>(null);
  const params = parseSnapshotParams(window.location.search)!; // main.tsx gates on non-null

  useEffect(() => {
    if (params.token) setTokenGetter(async () => params.token);
    hydrateFromBackend()
      .then(async () => {
        await hydrateAlerts();
        const d = resolveDescriptor(params.broker, params.epic);
        if (!d) return fail("no view heartbeat for epic");
        // Stamp the hydrated theme onto the DOM BEFORE the chart mounts.
        // SnapshotApp renders outside App (whose theme effect normally does
        // this), and index.css defaults to dark — without it a light-theme
        // user's screenshot came out on a dark page background.
        applyThemeToDocument(loadSettings());
        setDesc(d);
      })
      .catch((e) => fail(String(e)));
    // Snapshot boot runs once per page load — params come from the URL and
    // never change for the life of this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!desc) return null;

  const s = loadSettings();
  const period = periodByResolution(desc.resolution) ?? {
    resolution: desc.resolution,
    label: desc.resolution,
  };

  return (
    <div style={{ position: "fixed", inset: 0 }} data-snapshot-chart>
      <ChartCore
        cellId="snapshot"
        tabId="snapshot"
        scope={desc.scope}
        symbol={desc.symbol}
        brokerId={desc.broker}
        period={period}
        theme={s.theme}
        timezone={s.timezone}
        clock={s.clock}
        dateFormat={s.dateFormat}
        showWeekday={s.showWeekday}
        priceSide={s.priceSide}
        bidAsk={s.bidAsk}
        bidAskStyle={s.bidAskStyle}
        crosshair={s.crosshair}
        goLivePillPos={s.goLivePillPos}
        syncCrosshair={false}
        syncTime={false}
        locked={false}
        focused={false}
        onReady={(_id, chart) => armReady(chart, desc, params.level)}
      />
    </div>
  );
}

// `price` from the URL is deliberately unused: see the no-marker comment below.
function armReady(chart: Chart, desc: ViewDescriptor, level: number | null) {
  // Every failure path must end at fail() — Task 5's renderer only advances on
  // __snapshotReady === true or a string __snapshotError, so an uncaught throw
  // here (e.g. from a setTimeout tick) would silently hang it for the full
  // 30s budget instead of falling back fast.
  try {
    try {
      chart.setBarSpace(desc.barSpace);
    } catch {
      /* zoom is best-effort */
    }
    if (level != null) {
      chart.createOverlay({
        name: "horizontalStraightLine",
        points: [{ value: level }],
        lock: true,
        styles: { line: { color: "#d97706", size: 1, style: "dashed" } },
      });
    }
    // Ready = data present and stable for 600ms (candles + indicators settled),
    // or error after 25s (inside the renderer's 30s budget; cold hosted candle
    // fetches through capital-live can take well over 10s).
    const start = performance.now();
    let lastLen = -1;
    let stableSince = performance.now();
    const tick = () => {
      try {
        const len = (chart.getDataList() ?? []).length;
        if (len !== lastLen) {
          lastLen = len;
          stableSince = performance.now();
        }
        // No fired-price marker: klinecharts' simpleAnnotation renders a blue
        // balloon pin that reads as a stray drawing in the screenshot. The
        // level line above plus the hydrated alert overlay (and the fired
        // candle sitting at the live edge) already carry that information.
        if (len > 0 && performance.now() - stableSince >= 600) {
          window.__snapshotReady = true;
          return;
        }
        if (performance.now() - start > 25000) return fail("timed out waiting for data");
        setTimeout(tick, 150);
      } catch (e) {
        fail(String(e));
      }
    };
    tick();
  } catch (e) {
    fail(String(e));
  }
}
