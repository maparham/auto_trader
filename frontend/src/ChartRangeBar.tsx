import { useEffect, useRef, useState, type FormEvent } from "react";
import { RANGE_KEYS, TRAILING_KEYS, RANGE_DESCRIPTIONS, type RangeKey } from "./lib/rangeWindow";

export interface ChartRangeBarProps {
  activeKey: RangeKey | null;
  disabled?: boolean;
  onPick(key: RangeKey): void;
  onGoToDate(dateMs: number): void;
}

export default function ChartRangeBar({
  activeKey,
  disabled,
  onPick,
  onGoToDate,
}: ChartRangeBarProps) {
  const [calOpen, setCalOpen] = useState(false);
  const [date, setDate] = useState("");
  // Revealed only when the cursor is near the bottom of the chart cell (like
  // TradingView), not whenever the cursor is anywhere over the chart.
  const [peek, setPeek] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const calBtnRef = useRef<HTMLButtonElement>(null);
  const calPopRef = useRef<HTMLFormElement>(null);

  const closeCalendar = () => {
    setCalOpen(false);
    setDate("");
  };

  // Track pointer proximity to the cell's bottom edge. A pure-CSS :hover on the
  // whole .chart-wrap kept the bar up the entire time the cursor was on the chart;
  // an invisible bottom overlay would instead steal clicks from the time axis. So
  // we listen on the parent and toggle a class when within REVEAL_BAND of the bottom.
  useEffect(() => {
    const wrap = rootRef.current?.closest(".chart-wrap") as HTMLElement | null;
    if (!wrap) return;
    const REVEAL_BAND = 64; // px above the bottom edge that reveals the bar
    const onMove = (e: PointerEvent) => {
      const r = wrap.getBoundingClientRect();
      setPeek(
        e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.bottom - REVEAL_BAND &&
          e.clientY <= r.bottom + 4,
      );
    };
    const onLeave = () => setPeek(false);
    // Capture phase: klinecharts' canvas may stopPropagation on pointermove in the
    // bubble phase, so listen on the way down to stay reliable over the chart.
    wrap.addEventListener("pointermove", onMove, true);
    wrap.addEventListener("pointerleave", onLeave);
    return () => {
      wrap.removeEventListener("pointermove", onMove, true);
      wrap.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  useEffect(() => {
    if (!calOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (calBtnRef.current?.contains(target)) return;
      if (calPopRef.current?.contains(target)) return;
      closeCalendar();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCalendar();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calOpen]);

  const submitDate = (e: FormEvent) => {
    e.preventDefault();
    if (!date) return;
    // <input type=date> value is "YYYY-MM-DD"; parse as UTC midnight.
    const [y, m, d] = date.split("-").map(Number);
    onGoToDate(Date.UTC(y, m - 1, d));
    closeCalendar();
  };

  return (
    <div
      ref={rootRef}
      className={`chart-range-bar${peek ? " peek" : ""}${calOpen ? " cal-open" : ""}`}
      data-testid="chart-range-bar"
    >
      {RANGE_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          className={`crb-btn${k === activeKey ? " active" : ""}`}
          aria-pressed={k === activeKey}
          title={RANGE_DESCRIPTIONS[k]}
          disabled={disabled}
          onClick={() => onPick(k)}
        >
          {k}
        </button>
      ))}
      <span className="crb-sep" />
      {/* Trailing offsets: left edge exactly N back from now (vs the calendar
          period-to-date set above). */}
      {TRAILING_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          className={`crb-btn${k === activeKey ? " active" : ""}`}
          aria-pressed={k === activeKey}
          title={RANGE_DESCRIPTIONS[k]}
          disabled={disabled}
          onClick={() => onPick(k)}
        >
          {k}
        </button>
      ))}
      <span className="crb-sep" />
      <button
        ref={calBtnRef}
        type="button"
        className="crb-btn crb-cal"
        aria-label="Open date picker"
        title="Go to a specific date"
        aria-expanded={calOpen}
        disabled={disabled}
        onClick={() => setCalOpen((o) => !o)}
      >
        {/* simple calendar glyph; matches the screenshot's outline icon */}
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" fill="none" stroke="currentColor" />
          <path d="M1.5 5.5h13M5 1v3M11 1v3" stroke="currentColor" />
        </svg>
      </button>
      {calOpen && (
        <form ref={calPopRef} className="crb-cal-pop" onSubmit={submitDate}>
          <input
            type="date"
            aria-label="Go to date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            autoFocus
          />
          <button type="submit" className="crb-btn">Go</button>
        </form>
      )}
    </div>
  );
}
