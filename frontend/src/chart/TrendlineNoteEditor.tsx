// The note box for one Trendlines line (useTrendlineMenu's Add / Edit note).
import { useEffect, useRef } from "react";
import { TL_NOTE_MAX } from "../lib/indicators/trendlineMarks";

/** The note box: one input where the menu stood. Enter saves (empty clears),
 * Escape or a press outside cancels. */
export default function TrendlineNoteEditor({ x, y, initial, onSave, onClose }: {
  x: number;
  y: number;
  initial: string;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown, true);
    };
  }, [onClose]);
  return (
    <input
      ref={ref}
      className="tl-note-input"
      style={{ left: Math.min(x, window.innerWidth - 240), top: Math.min(y, window.innerHeight - 40) }}
      defaultValue={initial}
      maxLength={TL_NOTE_MAX}
      placeholder="Note on this line"
      aria-label="Line note"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          onSave(e.currentTarget.value);
          onClose();
        } else if (e.key === "Escape") onClose();
      }}
    />
  );
}
