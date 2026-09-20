// Notifications/settings sheet (spec: 2026-09-07-mobile-companion-design.md,
// Task 14): device push toggle (Task 8's web-push plumbing, same
// pushClient.ts the desktop AccountGate/Settings use), the light/dark theme
// choice (mirrors AppearanceMenu.tsx's THEMES — the app only has "dark" |
// "light", no "system" value, so this offers exactly those two), and a
// switch-to-desktop escape hatch for anyone who booted into the mobile shell
// by mistake (MobileBoot.tsx reads the same "auto-trader.mobileBoot" flag).
import { useEffect, useState } from "react";
import Sheet from "./Sheet";
import { pushSupported, isSubscribed, subscribePush, unsubscribePush } from "../lib/pushClient";
import { applyThemeToDocument, loadSettings, saveSettings, type Theme } from "../theme";
import { toast } from "../lib/notify";
import { openSettings } from "../lib/signals";
import { mobileSettingsVersion } from "./mobileChartState";
import { isDemoMode } from "../lib/demoMode";

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// Safari on iOS silently drops web push unless the site is installed to the
// home screen (running in standalone display mode); until then, tapping the
// toggle would just fail, so point the user at the install step instead.
function iosNeedsInstall(): boolean {
  if (typeof navigator === "undefined") return false;
  const standalone =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  return /iPhone|iPad/.test(navigator.userAgent) && !standalone;
}

export default function MobileSettingsSheet({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState(() => loadSettings());
  const supported = pushSupported();
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    isSubscribed().then((v) => {
      if (!cancelled) setSubscribed(v);
    });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  async function togglePush() {
    if (busy) return;
    setBusy(true);
    try {
      if (subscribed) {
        await unsubscribePush();
        setSubscribed(false);
      } else {
        await subscribePush();
        setSubscribed(true);
      }
    } catch (e) {
      // A denied permission prompt (or any other subscribe/unsubscribe
      // failure) would otherwise become an unhandled rejection with no
      // user-visible feedback.
      toast(e instanceof Error ? e.message : "Couldn't update push notifications");
    } finally {
      setBusy(false);
    }
  }

  function setTheme(theme: Theme) {
    const next = { ...settings, theme };
    saveSettings(next);
    applyThemeToDocument(next);
    setSettings(next);
    // Bump so the already-mounted mobile chart (MobileChartView) re-reads
    // loadSettings() and re-themes — ChartCore takes `theme` as a plain prop
    // it doesn't watch reactively.
    mobileSettingsVersion.set(mobileSettingsVersion.value + 1);
  }

  function switchToDesktop() {
    localStorage.setItem("auto-trader.mobileBoot", "0");
    location.assign("/?m=0");
  }

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="m-set-label">Notifications</div>
      {isDemoMode() ? (
        <div className="m-set-hint">
          <a href="/?sign_in=1">Sign up free</a> to get price alerts on this phone.
        </div>
      ) : supported ? (
        <button
          className={`m-set-toggle${subscribed ? " on" : ""}`}
          role="switch"
          aria-checked={subscribed}
          onClick={togglePush}
          disabled={busy}
        >
          Push notifications
        </button>
      ) : (
        <div className="m-set-hint">Push notifications aren't supported on this device.</div>
      )}
      {!isDemoMode() && iosNeedsInstall() && (
        <div className="m-set-hint">
          On iOS, install this app to your home screen (Share → Add to Home Screen) to enable notifications.
        </div>
      )}

      <div className="m-set-label">Theme</div>
      <div className="m-seg m-set-theme">
        {THEMES.map((t) => (
          <button
            key={t.value}
            className={settings.theme === t.value ? "on" : ""}
            onClick={() => setTheme(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Full chart-settings modal (timezone, price side, crosshair, alert and
          trading defaults). The chart context menu's Settings item opens the
          same modal; this row exists because iOS long-press never fires
          contextmenu, so the menu itself may be unreachable there. */}
      <button
        className="m-sheet-row"
        onClick={() => {
          onClose();
          openSettings();
        }}
      >
        Chart settings…
      </button>

      <button className="m-sheet-row m-set-desktop" onClick={switchToDesktop}>
        Switch to desktop
      </button>
    </Sheet>
  );
}
