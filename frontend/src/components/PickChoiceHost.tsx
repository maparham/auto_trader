// The "which output?" menu for a pick from chart (lib/pickChoice.ts). It
// opens where the pick click landed: the host remembers the last pointerdown,
// which is the chart or legend click that produced the request. Escape, a
// click outside, or a scroll closes it without inserting anything.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pickChoiceRequest } from "../lib/pickChoice";
import { useSignalValue } from "../lib/signalHooks";

const MENU_W = 220;

export default function PickChoiceHost() {
  const req = useSignalValue(pickChoiceRequest);
  const last = useRef({ x: 0, y: 0 });
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => { last.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  useEffect(() => {
    if (!req) { setAt(null); return; }
    setAt({ ...last.current });
    const close = () => pickChoiceRequest.set(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("wheel", close);
    };
  }, [req]);

  useEffect(() => { if (req) menuRef.current?.querySelector("button")?.focus(); }, [req, at]);

  if (!req || !at) return null;
  const left = Math.max(8, Math.min(at.x, window.innerWidth - MENU_W - 8));
  const top = Math.max(8, Math.min(at.y + 8, window.innerHeight - 40 * req.options.length - 16));
  return createPortal(
    <div ref={menuRef} className="ctxmenu pick-choice" role="menu" aria-label="Insert which output" style={{ left, top, width: MENU_W }}>
      {req.options.map((o) => (
        <button
          key={o.token}
          type="button"
          role="menuitem"
          className="ctx-item"
          onClick={() => {
            pickChoiceRequest.set(null);
            req.onChoose(o.token);
          }}
        >
          <span>{o.label}</span>
          <kbd>{o.token}</kbd>
        </button>
      ))}
    </div>,
    document.body,
  );
}
