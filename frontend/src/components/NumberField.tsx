// A numeric input that always uses the dot as its decimal separator, no matter
// the browser/OS locale. Native `<input type="number">` follows the locale, so
// on a comma-decimal machine it rejects "0.1" and only accepts "0,1" — this
// uses a text input constrained to digits + a single dot instead, which keeps
// entry consistent everywhere. `inputMode="decimal"` still surfaces the numeric
// keypad on mobile.
//
// It keeps a local draft string while focused so intermediate values like "0."
// or "1." survive a keystroke (a purely controlled number field would round
// them away and wipe the trailing dot). On each valid keystroke it commits the
// parsed number to `onChange`; on blur it drops the draft and, when `floor` is
// given, snaps a non-positive/empty field up to that floor.
import { useState, type ChangeEvent } from "react";

export default function NumberField({
  value,
  onChange,
  floor,
  signed = false,
  className,
}: {
  value: number | undefined;
  onChange: (n: number) => void;
  /** When set, the field can't commit a non-positive value: an empty or ≤0
   *  entry snaps up to `floor` on blur, matching the old min= guard. */
  floor?: number;
  /** Allow a single leading minus so negative thresholds (e.g. a slope < -0.05)
   *  can be entered. Off by default — magnitude/quantity fields stay unsigned. */
  signed?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value ?? 0);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    // Keep digits and dots only — a comma (the decimal key on a comma-locale
    // keyboard) is simply ignored, so it can never act as a separator.
    let raw = e.currentTarget.value.replace(/[^0-9.]/g, "");
    // A single leading minus (signed mode only) — read it off the raw text
    // before the digit-only strip, then re-prepend it below.
    const neg = signed && e.currentTarget.value.trimStart().startsWith("-");
    // Collapse any dots after the first, then strip redundant leading zeros
    // ("05" -> "5") while leaving "0." and "0.x" intact.
    const dot = raw.indexOf(".");
    if (dot !== -1) raw = raw.slice(0, dot + 1) + raw.slice(dot + 1).replace(/\./g, "");
    raw = raw.replace(/^0+(?=\d)/, "");
    if (neg) raw = "-" + raw;
    setDraft(raw);
    if (raw !== "" && raw !== "." && raw !== "-" && raw !== "-.") {
      const n = Number(raw);
      if (Number.isFinite(n)) onChange(n);
    }
  }

  function handleBlur() {
    if (floor != null && !(Number(draft ?? "") > 0)) onChange(floor);
    setDraft(null);
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      value={shown}
      onChange={handleChange}
      onBlur={handleBlur}
    />
  );
}
