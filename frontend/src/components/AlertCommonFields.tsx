// Fields shared by every alert modal (price AlertModal, indicator
// IndicatorAlertModal): Trigger + Expiration, Message, Notifications. Moved
// out of AlertModal.tsx verbatim so the indicator dialog (Task 13) reads
// identically to the price one instead of re-implementing these controls.

import { useEffect, useRef, useState } from "react";
import Tooltip from "./Tooltip";
import InfoTip from "./InfoTip";
import type { AlertNotifyChannels, AlertTrigger } from "../lib/persist";
import { TRIGGER_LABELS } from "../lib/alertsApi";
import { openSettings } from "../lib/signals";
import type { AlertDefaults } from "../theme";
import {
  expiryOptions,
  matchExpiryOption,
  formatExpiryShort,
  formatExpiryLong,
  localInputToMs,
  msToLocalInput,
  resolveExpiry,
  type ExpiryOption,
} from "../lib/alertUi";

export const ALL_ON: AlertNotifyChannels = {
  toast: true,
  browser: true,
  sound: true,
  push: true,
  telegram: true,
};

// Channel order + labels, shared with Settings' alert defaults. "App"/"Browser"/
// "Sound" fire in THIS tab; Push and Telegram are delivered by the BACKEND, so
// they arrive with no tab open.
export const CHANNELS = [
  ["toast", "App"],
  ["browser", "Browser"],
  ["sound", "Sound"],
  ["push", "Push"],
  ["telegram", "Telegram"],
] as const;

export interface AlertCommonState {
  trigger: AlertTrigger;
  setTrigger: (t: AlertTrigger) => void;
  expiresAt: number | null;
  setExpiresAt: (ms: number | null) => void;
  message: string;
  setMessage: (m: string) => void;
  notify: AlertNotifyChannels;
  setNotify: (n: AlertNotifyChannels) => void;
}

export function useAlertCommonState(
  initial:
    | { trigger: AlertTrigger; message: string; expiresAt?: number | null; notify?: AlertNotifyChannels }
    | undefined,
  defaults: AlertDefaults,
  now: number,
  isEdit: boolean,
): AlertCommonState {
  const [trigger, setTrigger] = useState<AlertTrigger>(initial?.trigger ?? defaults.trigger);
  const [message, setMessage] = useState(initial?.message ?? "");
  // Expiry as a concrete timestamp (ms) or null for open-ended. New alerts resolve
  // the default intent (duration → now+ms); edits keep the stored expiresAt.
  const [expiresAt, setExpiresAt] = useState<number | null>(
    isEdit ? initial?.expiresAt ?? null : resolveExpiry(defaults.expiry, now),
  );
  const [notify, setNotify] = useState<AlertNotifyChannels>(
    initial?.notify ?? (isEdit ? ALL_ON : defaults.notify),
  );
  return { trigger, setTrigger, expiresAt, setExpiresAt, message, setMessage, notify, setNotify };
}

export default function AlertCommonFields({
  state,
  now,
  autoMsg,
}: {
  state: AlertCommonState;
  now: number;
  autoMsg: string;
}) {
  return (
    <>
      {/* Trigger + Expiration share a row — each field stacks its own label
          above its own control, so the label doesn't crowd the control. */}
      <div className="al-row al-pair">
        <div className="al-pair-field">
          <span>Trigger</span>
          <div className="al-trigger-row">
            <select
              aria-label="Trigger"
              value={state.trigger}
              onChange={(e) => state.setTrigger(e.target.value as AlertTrigger)}
            >
              <option value="once">{TRIGGER_LABELS.once}</option>
              <option value="every">{TRIGGER_LABELS.every}</option>
            </select>
            <InfoTip
              title="Once per bar"
              text={["Fires at most once per candle", "Uses the alert's timeframe"]}
            />
          </div>
        </div>
        <div className="al-pair-field">
          <span>Expiration</span>
          <ExpiryField
            expiresAt={state.expiresAt}
            now={now}
            onChange={state.setExpiresAt}
          />
        </div>
      </div>

      <label className="al-field">
        <span>Message</span>
        <textarea
          className="al-message"
          rows={2}
          value={state.message}
          placeholder={autoMsg}
          onChange={(e) => state.setMessage(e.target.value)}
        />
      </label>

      <div className="al-field">
        <span>Notifications</span>
        <div className="al-notify-toggles">
          {CHANNELS.map(([ch, label]) => (
            <label key={ch} className="al-notify-chip">
              <input
                type="checkbox"
                checked={state.notify[ch] ?? true}
                onChange={(e) => state.setNotify({ ...state.notify, [ch]: e.target.checked })}
              />
              {label}
              {/* Deep link to Settings → Alerts, where Telegram gets
                  linked (and Push enabled). Settings stacks above this
                  modal (backdrop z 2000 vs 1500), so the draft survives. */}
              {ch === "telegram" && (
                <Tooltip content={["Notification settings", "Connect Telegram"]}>
                  <button
                    type="button"
                    className="al-settings-link"
                    onClick={(e) => { e.preventDefault(); openSettings("alerts"); }}
                  >
                    ⚙
                  </button>
                </Tooltip>
              )}
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

// Per-alert expiration, TradingView-style: a custom dropdown whose button shows the
// resolved time ("July 22, 2026 at 19:05") and whose menu lists each option with its
// concrete time dimmed on the right. "Custom date" reveals a datetime picker. The
// stored value is always an absolute timestamp (or null), independent of render time.
function ExpiryField({
  expiresAt,
  now,
  onChange,
}: {
  expiresAt: number | null;
  now: number;
  onChange: (ms: number | null) => void;
}) {
  const options = expiryOptions(now);
  // Once the user picks "Custom date" we keep that mode even if the chosen time
  // happens to match a preset (matches TradingView). Default to custom when editing
  // an alert whose expiry isn't one of the presets.
  const [custom, setCustom] = useState(matchExpiryOption(expiresAt, now) === "custom");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = custom ? "custom" : matchExpiryOption(expiresAt, now);

  useEffect(() => {
    if (!open) return;
    // Capture phase: the modal body calls stopPropagation on mousedown, which would
    // otherwise stop this from ever firing on clicks elsewhere inside the modal.
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  function pick(id: string) {
    const opt = options.find((o) => o.id === id);
    if (!opt || opt.id === "custom") {
      setCustom(true);
      // Seed the custom picker from the current value, or end of day if open-ended.
      if (expiresAt == null) {
        const eod = options.find(
          (o): o is Extract<ExpiryOption, { expiresAt: number }> => o.id === "eod",
        )!;
        onChange(eod.expiresAt);
      }
    } else {
      setCustom(false);
      onChange("expiresAt" in opt ? opt.expiresAt : null);
    }
    setOpen(false);
  }

  return (
    <div className="al-expiry" ref={ref}>
      <button
        type="button"
        className={`al-expiry-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{formatExpiryLong(expiresAt)}</span>
        <svg className="al-expiry-caret" viewBox="0 0 24 24" width="11" height="11" fill="none"
          stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="al-expiry-menu">
          {options.map((o) => (
            <button
              type="button"
              key={o.id}
              className={`al-expiry-opt${active === o.id ? " sel" : ""}${
                o.id === "custom" ? " custom" : ""
              }`}
              onClick={() => pick(o.id)}
            >
              <span className="al-expiry-opt-label">{o.label}</span>
              <span className="al-expiry-opt-time">
                {o.id === "open" ? (
                  "Won't expire"
                ) : o.id === "custom" ? (
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4.5" width="18" height="16" rx="2" />
                    <line x1="3" y1="9.5" x2="21" y2="9.5" />
                    <line x1="8" y1="2.5" x2="8" y2="6" />
                    <line x1="16" y1="2.5" x2="16" y2="6" />
                  </svg>
                ) : (
                  formatExpiryShort(o.expiresAt)
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      {active === "custom" && (
        <input
          type="datetime-local"
          className="al-datetime"
          value={expiresAt != null ? msToLocalInput(expiresAt) : ""}
          onChange={(e) => onChange(localInputToMs(e.target.value))}
        />
      )}
    </div>
  );
}
