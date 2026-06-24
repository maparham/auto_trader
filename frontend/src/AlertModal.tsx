// TradingView-style "Create alert" modal. The single creation/edit path for price
// alerts — opened from the toolbar bell (prefilled with last price) and the chart
// "+" axis menu (prefilled with the cursor price), both via the alertModalRequest
// signal, and from the sidebar/line for editing via alertEditRequest.

import { useEffect, useRef, useState } from "react";
import type { AlertCondition, AlertNotifyChannels, AlertTrigger } from "./lib/persist";
import type { AlertDefaults } from "./theme";
import { useDraggable } from "./lib/useDraggable";
import {
  CONDITIONS,
  expiryOptions,
  matchExpiryOption,
  formatExpiryShort,
  formatExpiryLong,
  localInputToMs,
  msToLocalInput,
  resolveExpiry,
} from "./lib/alertUi";

export interface AlertDraft {
  condition: AlertCondition;
  trigger: AlertTrigger;
  message: string;
  expiresAt: number | null;
  notify: AlertNotifyChannels;
}

interface Props {
  epic: string;
  price: number;
  // "edit" prefills from an existing alert and relabels the modal ("Edit"/"Save").
  mode?: "create" | "edit";
  initial?: {
    condition: AlertCondition;
    trigger: AlertTrigger;
    message: string;
    expiresAt?: number | null;
    notify?: AlertNotifyChannels;
  };
  // Defaults a NEW alert inherits (Settings → Alerts). Ignored in edit mode.
  defaults: AlertDefaults;
  // "now" (ms) used to resolve a default DURATION expiry to a concrete timestamp.
  now: number;
  onCreate: (level: number, cfg: AlertDraft) => void;
  // Edit-mode trash button (matches TV). Absent in create mode.
  onDelete?: () => void;
  onClose: () => void;
}

const ALL_ON: AlertNotifyChannels = { toast: true, browser: true, sound: true };

export default function AlertModal({
  epic,
  price,
  mode = "create",
  initial,
  defaults,
  now,
  onCreate,
  onDelete,
  onClose,
}: Props) {
  const isEdit = mode === "edit";
  const [condition, setCondition] = useState<AlertCondition>(
    initial?.condition ?? defaults.condition,
  );
  const [value, setValue] = useState(price ? String(price) : "");
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
  const drag = useDraggable();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const num = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(num);
  const condLabel = CONDITIONS.find((c) => c.value === condition)?.label ?? "";
  const autoMsg = `${epic} ${condLabel}${valid ? ` ${num}` : ""}`;

  function create() {
    if (!valid) return;
    onCreate(num, { condition, trigger, message: message.trim() || autoMsg, expiresAt, notify });
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal alert-modal" style={drag.style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head" {...drag.handleProps}>
          <span>
            {isEdit ? "Edit alert on " : "Create alert on "}
            <strong>{epic}</strong>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="alert-body">
          {/* Condition block, TradingView-style: source (Price) + operator + value. */}
          <label className="al-row">
            <span>Condition</span>
            <select className="al-source" value="price" disabled>
              <option value="price">Price</option>
            </select>
          </label>

          <label className="al-row">
            <span />
            <select
              value={condition}
              onChange={(e) => setCondition(e.target.value as AlertCondition)}
            >
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="al-row">
            <span>Value</span>
            <input
              type="number"
              step="any"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          </label>

          <div className="al-divider" />

          <label className="al-row">
            <span>Trigger</span>
            <select value={trigger} onChange={(e) => setTrigger(e.target.value as AlertTrigger)}>
              <option value="once">Once only</option>
              <option value="every">Every time</option>
            </select>
          </label>

          <div className="al-row al-row-top">
            <span>Expiration</span>
            <ExpiryField
              expiresAt={expiresAt}
              now={now}
              onChange={setExpiresAt}
            />
          </div>

          <label className="al-row al-row-top">
            <span>Message</span>
            <textarea
              className="al-message"
              rows={2}
              value={message}
              placeholder={autoMsg}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>

          <div className="al-row al-row-top">
            <span>Notifications</span>
            <div className="notify-toggles">
              {(["toast", "browser", "sound"] as const).map((ch) => (
                <label key={ch} className="notify-toggle">
                  <input
                    type="checkbox"
                    checked={notify[ch]}
                    onChange={(e) => setNotify({ ...notify, [ch]: e.target.checked })}
                  />
                  {ch === "toast" ? "App" : ch === "browser" ? "Browser" : "Sound"}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          {isEdit && onDelete && (
            <button className="al-trash" onClick={onDelete} title="Delete alert" aria-label="Delete alert">
              🗑
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button onClick={create} disabled={!valid}>
            {isEdit ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
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
      if (expiresAt == null) onChange(options.find((o) => o.id === "eod")!.expiresAt!);
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
        <span className="al-expiry-caret">⌄</span>
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
                {o.id === "open"
                  ? "Won't expire"
                  : o.id === "custom"
                    ? "📅"
                    : formatExpiryShort(o.expiresAt)}
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
