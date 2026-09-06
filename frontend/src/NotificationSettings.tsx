// Device-level notification enablement, mounted in Settings' Alerts tab
// alongside the per-alert channel defaults (Notifications row above). Those
// toggles decide which channels a *new alert* uses by default; this section
// decides whether *this device* is registered to receive them at all — for
// push, that means a service-worker registration + a live subscription on
// the backend (Task 8's /api/alerts/push/* endpoints). The Telegram row
// (Task 12) is account-level rather than device-level, but lives here
// alongside Push since both are "does delivery reach me at all" controls.

import { useEffect, useRef, useState } from "react";
import InfoTip from "./components/InfoTip";
import { pushSupported, isSubscribed, subscribePush, unsubscribePush } from "./lib/pushClient";
import {
  getTelegramStatus,
  startTelegramLink,
  unlinkTelegram,
  sendTelegramTest,
  pollTelegramLink,
} from "./lib/telegramClient";

export default function NotificationSettings() {
  const supported = pushSupported();
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const [tgLinked, setTgLinked] = useState(false);
  const [tgEnabled, setTgEnabled] = useState(true);
  const [tgReady, setTgReady] = useState(false);
  const [tgBusy, setTgBusy] = useState(false);
  const [tgConnecting, setTgConnecting] = useState(false);
  const [tgTestSent, setTgTestSent] = useState(false);
  const cancelPollRef = useRef<(() => void) | null>(null);
  const testSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getTelegramStatus().then(
      (v) => {
        if (cancelled) return;
        setTgLinked(v.linked);
        setTgEnabled(v.enabled);
        setTgReady(true);
      },
      () => {
        if (cancelled) return;
        setTgReady(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      cancelPollRef.current?.();
      if (testSentTimerRef.current) clearTimeout(testSentTimerRef.current);
    },
    [],
  );

  const connectTelegram = async () => {
    setTgBusy(true);
    try {
      const url = await startTelegramLink();
      window.open(url, "_blank");
      setTgConnecting(true);
      cancelPollRef.current = pollTelegramLink(
        (status) => {
          setTgLinked(true);
          setTgEnabled(status.enabled);
          setTgConnecting(false);
          cancelPollRef.current = null;
        },
        {
          onTimeout: () => {
            setTgConnecting(false);
            cancelPollRef.current = null;
          },
        },
      );
    } catch {
      // Leave state as-is; the Connect button stays actionable to retry.
    } finally {
      setTgBusy(false);
    }
  };

  const disconnectTelegram = async () => {
    setTgBusy(true);
    try {
      await unlinkTelegram();
      setTgLinked(false);
      setTgTestSent(false);
    } catch {
      // Leave `tgLinked` as-is so the user can retry.
    } finally {
      setTgBusy(false);
    }
  };

  const testTelegram = async () => {
    setTgBusy(true);
    try {
      await sendTelegramTest();
      setTgTestSent(true);
      if (testSentTimerRef.current) clearTimeout(testSentTimerRef.current);
      testSentTimerRef.current = setTimeout(() => setTgTestSent(false), 2000);
    } catch {
      // No lasting state change on failure — button stays actionable.
    } finally {
      setTgBusy(false);
    }
  };

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
      {tgReady && (
        <div className="setting-row">
          <label className="label-info">
            Telegram
            <InfoTip text="Alerts delivered as Telegram DMs from the bot, even when this tab is closed." />
          </label>
          {!tgEnabled ? (
            <span className="setting-hint">
              Set TELEGRAM_BOT_TOKEN on the backend to enable.
            </span>
          ) : tgLinked ? (
            <div className="notif-tg-actions">
              <span className="notif-toggle-btn on notif-toggle-pill">Connected</span>
              <button
                type="button"
                className="notif-toggle-btn"
                disabled={tgBusy}
                onClick={() => void testTelegram()}
              >
                {tgTestSent ? "Sent" : "Send test"}
              </button>
              <button
                type="button"
                className="notif-toggle-btn"
                disabled={tgBusy}
                onClick={() => void disconnectTelegram()}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="notif-toggle-btn"
              disabled={tgBusy || tgConnecting}
              onClick={() => void connectTelegram()}
            >
              {tgConnecting ? "Waiting for Telegram…" : "Connect Telegram"}
            </button>
          )}
        </div>
      )}
    </>
  );
}
