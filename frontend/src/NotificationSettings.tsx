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
import QrCode from "./components/QrCode";
import { pushSupported, isSubscribed, subscribePush, unsubscribePush } from "./lib/pushClient";
import {
  getTelegramStatus,
  startTelegramLink,
  unlinkTelegram,
  sendTelegramTest,
  pollTelegramLink,
} from "./lib/telegramClient";

// Backend `_LINK_CODE_TTL_SECONDS` (core/telegram_notify.py): how long a minted
// /start code stays redeemable, and so how long the QR is worth showing.
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

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
  const [tgQrUrl, setTgQrUrl] = useState<string | null>(null);
  const cancelPollRef = useRef<(() => void) | null>(null);
  const testSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The minted deep link, held in a ref as well as state so two clicks in the
  // same tick can't each mint their own code (see `ensureLinkUrl`).
  const linkUrlRef = useRef<string | null>(null);

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

  /** Mint at most ONE link code per connecting session. Both entry points
   *  (open-a-tab and show-a-QR) must show the SAME code, since every
   *  `POST /link` mints a fresh one and a user who clicks both would otherwise
   *  be looking at two live codes with no way to tell which one they scanned. */
  const ensureLinkUrl = async () => {
    if (linkUrlRef.current) return linkUrlRef.current;
    const url = await startTelegramLink();
    linkUrlRef.current = url;
    return url;
  };

  /** Forget the current code and stop waiting on it: on success, on expiry,
   *  and whenever the user dismisses the QR by hand. */
  const endLinkSession = () => {
    cancelPollRef.current?.();
    cancelPollRef.current = null;
    linkUrlRef.current = null;
    setTgQrUrl(null);
    setTgConnecting(false);
  };

  const startLinkPoll = () => {
    if (cancelPollRef.current) return; // already waiting on this code
    setTgConnecting(true);
    cancelPollRef.current = pollTelegramLink(
      (status) => {
        setTgLinked(true);
        setTgEnabled(status.enabled);
        endLinkSession();
      },
      // Match the backend's 10 min link-code TTL: a QR on screen can sit for
      // minutes before someone reaches for their phone, and giving up while
      // the code is still valid would leave a scan silently undetected.
      { timeoutMs: LINK_CODE_TTL_MS, onTimeout: endLinkSession },
    );
  };

  const connectTelegram = async () => {
    setTgBusy(true);
    try {
      window.open(await ensureLinkUrl(), "_blank");
      startLinkPoll();
    } catch {
      // Leave state as-is; the Connect button stays actionable to retry.
    } finally {
      setTgBusy(false);
    }
  };

  const toggleTelegramQr = async () => {
    if (tgQrUrl) {
      endLinkSession();
      return;
    }
    setTgBusy(true);
    try {
      setTgQrUrl(await ensureLinkUrl());
      startLinkPoll();
    } catch {
      // No QR to show; the button stays actionable to retry.
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
            <div className="notif-tg-actions">
              <button
                type="button"
                className="notif-toggle-btn"
                disabled={tgBusy}
                onClick={() => void connectTelegram()}
              >
                Connect Telegram
              </button>
              <button
                type="button"
                className={`notif-toggle-btn${tgQrUrl ? " on" : ""}`}
                disabled={tgBusy}
                onClick={() => void toggleTelegramQr()}
                aria-pressed={tgQrUrl !== null}
              >
                {tgQrUrl ? "Hide QR" : "Show QR"}
              </button>
              {/* Both entry points stay live while we wait: the code is cached,
                  so a user who put the QR up can still click through on this
                  device (and vice versa) without minting a second one. The hint
                  takes its own line so it never squeezes the buttons. */}
              {tgConnecting && (
                <span className="setting-hint notif-tg-waiting">Waiting for Telegram…</span>
              )}
            </div>
          )}
        </div>
      )}
      {tgQrUrl && (
        <div className="notif-tg-qr">
          <QrCode text={tgQrUrl} title="Telegram bot link" />
          <div className="notif-tg-qr-text">
            <div>Scan with your phone camera.</div>
            <div className="setting-hint">
              Opens the Telegram bot and links this account. The code expires in
              10 minutes.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
