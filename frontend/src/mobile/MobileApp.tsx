// Mobile companion shell (spec: 2026-09-07-mobile-companion-design.md).
// NOTE: klinecharts custom indicators/overlays are registered by App.tsx's
// module-level side effects; main.tsx imports App statically, so they are
// registered before we mount (see lib/moduleInitOrder.test.ts).
import { useEffect, useState, useSyncExternalStore } from "react";
import { hydrateFromBackend, subscribeToBackendUpdates } from "../lib/persist";
import { hydrateAlerts } from "../lib/alertsApi";
import { applyThemeToDocument, loadSettings } from "../theme";
import MobileChartView from "./MobileChartView";
import MobileAlertsView from "./MobileAlertsView";
import MobilePositionsView from "./MobilePositionsView";
import MobileTradeView from "./MobileTradeView";
import MobileModals from "./MobileModals";
import MobileSettingsSheet from "./MobileSettingsSheet";
import { initMobileAccount, mobileTabSignal, type MobileTab } from "./mobileChartState";
import { isWorkspaceKey, bumpMobileWorkspace } from "./mobileWorkspace";
import { initViewMode, mobileViewMode, setChromeHidden } from "./mobileViewMode";
import "./mobile.css";

const TABS: { id: MobileTab; label: string }[] = [
  { id: "chart", label: "Chart" },
  { id: "alerts", label: "Alerts" },
  { id: "positions", label: "Positions" },
  { id: "trade", label: "Trade" },
];

export default function MobileApp() {
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tab = useSyncExternalStore(
    (fn) => mobileTabSignal.subscribe(fn),
    () => mobileTabSignal.value,
  );
  const viewMode = useSyncExternalStore(
    (fn) => mobileViewMode.subscribe(fn),
    () => mobileViewMode.value,
  );

  useEffect(() => {
    hydrateFromBackend()
      .then(() => hydrateAlerts())
      .catch((e) => console.warn("mobile hydrate failed; using local state", e))
      .finally(() => {
        applyThemeToDocument(loadSettings());
        // After hydrate (brokersCache may have been refreshed) and BEFORE any
        // view mounts, so the chart boots on the stored account's broker.
        initMobileAccount();
        setReady(true);
      });
  }, []);

  // App-shell cache SW (Task 13: PWA). Same "/alert-sw.js" path pushClient.ts
  // registers for push; harmless to call again here since a service worker
  // registration for an already-registered scope+script just resolves to the
  // existing registration.
  // Live /ws/state subscription: desktop App dials this in its own effect; the
  // mobile shell must dial it too or it never hears backend pushes after the
  // initial hydrate. Alert events route themselves (registerAlertsRouter runs at
  // alertsApi module load); here we only need to notice workspace changes so the
  // chart strip re-reads the mirrored layout. Other keys' content is picked up
  // by the existing per-surface reads.
  useEffect(() => {
    return subscribeToBackendUpdates((key) => {
      if (isWorkspaceKey(key)) bumpMobileWorkspace();
    });
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/alert-sw.js").catch(() => {});
    }
  }, []);

  // Tears the view mode down when full screen ends outside our control (an
  // Android back gesture, Escape), so the app never strands a landscape flag.
  useEffect(() => initViewMode(), []);

  // Chart-only describes the chart. If something moves the active tab away
  // from "chart" while chrome is hidden (the price-axis menu can stage a
  // draft order and route to Trade even with the chrome hidden), end the mode
  // instead of stranding the user off-chart with no tab bar and no top bar.
  // setChromeHidden(false) already forwards to exit landscape too, which is
  // what we want here.
  useEffect(() => {
    if (tab !== "chart" && mobileViewMode.value.chromeHidden) {
      void setChromeHidden(false);
    }
  }, [tab]);

  // Offline banner: reflect the browser's online/offline signal so a user on
  // a flaky mobile connection knows why data looks stale, instead of the app
  // silently going quiet.
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  // Marker class on <body>: the only way mobile.css can scope FloatingModal's
  // re-hosted panels (AlertModal/IndicatorSettings/DrawingSettings), since
  // FloatingModal portals straight to document.body rather than under
  // ".m-app" — a plain descendant/sibling CSS selector off ".m-app" can never
  // match a body-level portal. Removed on unmount so the class can't outlive
  // the mobile shell (e.g. a future route back to desktop in the same tab).
  useEffect(() => {
    document.body.classList.add("m-mobile");
    return () => document.body.classList.remove("m-mobile");
  }, []);

  if (!ready) return null;

  return (
    <div className="m-app">
      {offline && <div className="m-offline">Offline — reconnecting…</div>}
      <div className={viewMode.chromeHidden ? "m-body m-body--no-tabbar" : "m-body"}>
        {viewMode.chromeHidden && (
          <button
            className="m-chart-restore"
            aria-label="Show controls"
            onClick={() => void setChromeHidden(false)}
          >
            ⤢
          </button>
        )}
        {/* Kept mounted (display:none when inactive) so the chart's websocket
            survives tab switches instead of reconnecting every time. */}
        <div data-tab="chart" style={{ display: tab === "chart" ? undefined : "none", height: "100%" }}>
          <MobileChartView active={tab === "chart"} />
        </div>
        {tab === "alerts" && (
          <div data-tab="alerts" style={{ height: "100%" }}>
            <MobileAlertsView />
          </div>
        )}
        {tab === "positions" && (
          <div data-tab="positions" style={{ height: "100%" }}>
            <MobilePositionsView />
          </div>
        )}
        {tab === "trade" && (
          <div data-tab="trade" style={{ height: "100%" }}>
            <MobileTradeView />
          </div>
        )}
      </div>
      {!viewMode.chromeHidden && (
        <nav className="m-tabbar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => mobileTabSignal.set(t.id)}
            >
              {t.label}
            </button>
          ))}
          <button
            className="m-tabbar-settings"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
        </nav>
      )}
      {settingsOpen && <MobileSettingsSheet onClose={() => setSettingsOpen(false)} />}
      <MobileModals />
    </div>
  );
}
