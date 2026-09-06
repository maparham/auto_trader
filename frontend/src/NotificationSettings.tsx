// Device-level notification enablement, mounted in Settings' Alerts tab
// alongside the per-alert channel defaults (Notifications row above). Those
// toggles decide which channels a *new alert* uses by default; this section
// decides whether *this device* is registered to receive them at all — for
// push, that means a service-worker registration + a live subscription on
// the backend (Task 8's /api/alerts/push/* endpoints).
//
// Telegram is wired in Task 12; its row is a no-op placeholder here.

import { useEffect, useState } from "react";
import InfoTip from "./components/InfoTip";
import { pushSupported, isSubscribed, subscribePush, unsubscribePush } from "./lib/pushClient";

export default function NotificationSettings() {
  const supported = pushSupported();
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void isSubscribed().then((v) => {
      if (cancelled) return;
      setEnabled(v);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const toggle = async () => {
    setBusy(true);
    try {
      if (enabled) {
        await unsubscribePush();
        setEnabled(false);
      } else {
        await subscribePush();
        setEnabled(true);
      }
    } catch {
      // Leave `enabled` as-is (whatever it was before the attempt) — the
      // button stays actionable so the user can just retry.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="setting-sub">Device notifications</div>
      {supported && (
        <div className="setting-row">
          <label className="label-info">
            Push
            <InfoTip text="OS notifications on this device when an alert fires and this tab isn't focused." />
          </label>
          <button
            type="button"
            className={`notif-toggle-btn${enabled ? " on" : ""}`}
            disabled={busy || !ready}
            onClick={() => void toggle()}
          >
            {enabled ? "Disable" : "Enable on this device"}
          </button>
        </div>
      )}
      {/* Telegram: wired in Task 12. */}
    </>
  );
}
