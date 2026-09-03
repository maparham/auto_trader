// Range calendar popover: a month grid + 24h time strip that edits the
// backtest span and its recurrence mask in one visual. Controlled view — all
// model writes go through onSpan/onMaskPatch; the component owns only the
// displayed month, the armed span-start, and the in-progress strip drag.
//
// Interaction rules (pinned by the tests):
// - Click OUTSIDE the current span arms a new span start; the second click
//   completes it (either order) with whole-day bounds in `tz`.
// - A plain click INSIDE the current span toggles that date in excludeDates.
// - Weekday headers (Mon…Sun) toggle daysOfWeek; "Weekends" toggles Sat+Sun
//   as a pair.
// - Pointer-drag on the time strip writes timeOfDay snapped to 30 minutes;
//   end<start is allowed (wrap) and renders as two segments.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { DayTimeWindow, RecurrenceMask } from "./lib/backtestConfig";
import { minToTime, tzDateString, tzOffsetMs } from "./lib/backtestSchedule";

export interface RangeCalendarProps {
  fromMs?: number;             // current span (whole-day bounds not assumed)
  toMs?: number;
  mask: RecurrenceMask | undefined;
  tz: string;                  // chartTimezone — days render/write in this zone
  timeStripDisabled: boolean;  // resSeconds >= 86400
  // Writers — the host maps these onto setRange/setMask:
  onSpan: (fromMs: number, toMs: number) => void;          // whole-day bounds in tz
  onMaskPatch: (patch: Partial<RecurrenceMask>) => void;
  onClose: () => void;
  anchor: { top: number; left: number };                   // fixed-position origin
  // Skip closing when the dismissal pointerdown lands inside this element —
  // typically the trigger button, whose own onClick toggles the popover open
  // state. Without it the capture-phase close fires first, then the button's
  // click toggles the now-false state back open.
  ignoreRef?: React.RefObject<HTMLElement | null>;
}

const pad = (n: number) => String(n).padStart(2, "0");

// Header order Mon…Sun; `day` is the JS getDay value each column toggles.
const WEEKDAY_HEADERS = [
  { label: "Mon", day: 1 }, { label: "Tue", day: 2 }, { label: "Wed", day: 3 },
  { label: "Thu", day: 4 }, { label: "Fri", day: 5 }, { label: "Sat", day: 6 },
  { label: "Sun", day: 0 },
];

// The UTC instant of tz-local midnight on (y, m, d) — the windowUtcMs
// guess-correct idiom (DST-safe; day overflow like d=32 rolls via Date.UTC).
function dayStartUtcMs(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  return guess - tzOffsetMs(tz, guess);
}

function parseYmd(ds: string): { y: number; m: number; d: number } {
  const [y, m, d] = ds.split("-").map(Number);
  return { y, m, d };
}

export default function RangeCalendarPopover({
  fromMs, toMs, mask, tz, timeStripDisabled, onSpan, onMaskPatch, onClose, anchor, ignoreRef,
}: RangeCalendarProps) {
  const popRef = useRef<HTMLDivElement>(null);

  // Stable identity for the dismissal effect below — the host typically
  // passes an inline arrow, which would otherwise re-bind the listeners on
  // every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Displayed month, seeded from the span start (or today) in tz.
  const [cursor, setCursor] = useState<{ y: number; m: number }>(() => {
    const { y, m } = parseYmd(tzDateString(fromMs ?? Date.now(), tz));
    return { y, m };
  });
  // First click of a new span selection ("YYYY-MM-DD"), awaiting the second.
  const [armed, setArmed] = useState<string | null>(null);
  // In-progress strip drag (previews live; committed on pointerup).
  const dragStartRef = useRef<number | null>(null);
  const [dragWin, setDragWin] = useState<DayTimeWindow | null>(null);

  // Dismissal — SessionFillMenu's idiom (pointerdown per the popover's tests).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (ignoreRef?.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Consume the Escape here: the host modal's useCloseOnEscape listens at
      // window bubble phase, so without this one press would close both.
      e.stopPropagation();
      onCloseRef.current();
    };
    const close = () => onCloseRef.current();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close, true);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close, true);
      window.removeEventListener("scroll", close, true);
    };
  }, [ignoreRef]);

  // --- day / span helpers -------------------------------------------------
  const fromDs = fromMs != null ? tzDateString(fromMs, tz) : null;
  // toMs is treated as exclusive; the ms before it belongs to the last day.
  const toDs = toMs != null ? tzDateString(toMs - 1, tz) : null;
  const todayDs = tzDateString(Date.now(), tz);
  const inSpan = (ds: string) => fromDs != null && toDs != null && fromDs <= ds && ds <= toDs;

  // daysOfWeek: absent/empty = every day on (wire convention).
  const dows = mask?.daysOfWeek?.length ? mask.daysOfWeek : [0, 1, 2, 3, 4, 5, 6];

  // Any gesture that writes to the mask must also enable it — otherwise the
  // write lands on a disabled/absent mask that isActive/is_active ignores,
  // and the cell renders struck-through while the run silently trades it.
  function maskPatch(patch: Partial<RecurrenceMask>) {
    onMaskPatch(mask?.enabled ? patch : { enabled: true, ...patch });
  }

  function cellClick(ds: string) {
    if (armed != null) {
      const [a, b] = armed <= ds ? [armed, ds] : [ds, armed];
      const A = parseYmd(a);
      const B = parseYmd(b);
      onSpan(dayStartUtcMs(A.y, A.m, A.d, tz), dayStartUtcMs(B.y, B.m, B.d + 1, tz));
      if (!mask?.enabled) {
        const patch: Partial<RecurrenceMask> = { enabled: true };
        if (!mask?.daysOfWeek?.length) patch.daysOfWeek = [1, 2, 3, 4, 5];
        onMaskPatch(patch);
      }
      setArmed(null);
    } else if (inSpan(ds)) {
      // Inside the current span: toggle the date as a holiday.
      const ex = mask?.excludeDates ?? [];
      maskPatch({ excludeDates: ex.includes(ds) ? ex.filter((x) => x !== ds) : [...ex, ds] });
    } else {
      setArmed(ds);
    }
  }

  function toggleDow(day: number) {
    const next = dows.includes(day) ? dows.filter((d) => d !== day) : [...dows, day].sort((a, b) => a - b);
    maskPatch({ daysOfWeek: next });
  }

  function toggleWeekends() {
    const on = dows.includes(6) && dows.includes(0);
    const next = on ? dows.filter((d) => d !== 0 && d !== 6) : [...new Set([...dows, 0, 6])].sort((a, b) => a - b);
    maskPatch({ daysOfWeek: next });
  }

  // --- month grid ---------------------------------------------------------
  const { y, m } = cursor;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const leadBlanks = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Mon-first column
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(Date.UTC(y, m - 1, 1));
  const page = (delta: number) =>
    setCursor(({ y, m }) => {
      const t = new Date(Date.UTC(y, m - 1 + delta, 1));
      return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 };
    });

  // --- time strip ---------------------------------------------------------
  const stripRef = useRef<HTMLDivElement>(null);
  function clientXToMin(clientX: number): number {
    const r = stripRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round((frac * 1440) / 30) * 30; // snap to 30-min increments
  }
  function stripDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (timeStripDisabled) return;
    const min = clientXToMin(e.clientX);
    dragStartRef.current = min;
    setDragWin({ startMin: min, endMin: min });
    // jsdom has no pointer capture; a real browser keeps the drag on the strip.
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* jsdom */ }
  }
  function stripMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragStartRef.current == null) return;
    setDragWin({ startMin: dragStartRef.current, endMin: clientXToMin(e.clientX) });
  }
  function stripUp(e: ReactPointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current;
    if (start == null) return;
    dragStartRef.current = null;
    setDragWin(null);
    const end = clientXToMin(e.clientX);
    if (end !== start) maskPatch({ timeOfDay: { startMin: start, endMin: end } });
  }
  const win = dragWin ?? mask?.timeOfDay;
  // end<start wraps past midnight → two filled segments.
  const segs: Array<{ startMin: number; endMin: number }> = !win
    ? []
    : win.endMin >= win.startMin
      ? [win]
      : [{ startMin: win.startMin, endMin: 1440 }, { startMin: 0, endMin: win.endMin }];

  return createPortal(
    <div
      ref={popRef}
      className="dropdown bt-calendar-pop"
      style={{ position: "fixed", top: anchor.top, left: anchor.left }}
    >
      <div className="bt-cal-head">
        <button type="button" aria-label="Previous month" onClick={() => page(-1)}>‹</button>
        <span className="bt-cal-title">{monthLabel}</span>
        <button type="button" aria-label="Next month" onClick={() => page(1)}>›</button>
      </div>
      <div className="bt-cal-grid">
        {WEEKDAY_HEADERS.map(({ label, day }) => (
          <button
            key={label}
            type="button"
            className={`bt-cal-dow${dows.includes(day) ? " on" : ""}`}
            onClick={() => toggleDow(day)}
          >
            {label}
          </button>
        ))}
        {Array.from({ length: leadBlanks }, (_, i) => (
          <span key={`blank${i}`} className="bt-cal-blank" aria-hidden="true" />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const d = i + 1;
          const ds = `${y}-${pad(m)}-${pad(d)}`;
          const within = inSpan(ds);
          const off = within &&
            ((mask?.excludeDates?.includes(ds) ?? false) ||
              !dows.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay()));
          const cls = ["bt-cal-cell"];
          if (within) cls.push("in-span");
          if (off) cls.push("off");
          if (ds === todayDs) cls.push("today");
          if (ds === armed) cls.push("armed");
          return (
            <button key={ds} type="button" className={cls.join(" ")} data-date={ds} onClick={() => cellClick(ds)}>
              {d}
            </button>
          );
        })}
      </div>
      <div className="bt-cal-foot">
        <button type="button" className="bt-chip" onClick={toggleWeekends}>Weekends</button>
        <span className="bt-cal-timelabel">
          {win ? `${minToTime(win.startMin)} – ${minToTime(win.endMin)}` : "00:00 – 24:00"}
        </span>
      </div>
      <div
        ref={stripRef}
        data-testid="bt-timestrip"
        className={`bt-timestrip${timeStripDisabled ? " is-off" : ""}`}
        inert={timeStripDisabled}
        onPointerDown={stripDown}
        onPointerMove={stripMove}
        onPointerUp={stripUp}
      >
        {segs.map((s, i) => (
          <div
            key={i}
            className="win"
            style={{ left: `${(s.startMin / 1440) * 100}%`, width: `${((s.endMin - s.startMin) / 1440) * 100}%` }}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}
