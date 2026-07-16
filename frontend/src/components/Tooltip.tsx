import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { computePlacement, type Placed, type Placement } from "./tooltipPosition";

interface TooltipProps {
  content: string | string[] | ReactNode;
  title?: string;
  placement?: Placement;
  delay?: number;
  disabled?: boolean;
  children: ReactNode;
}

// Module-level grace window: after any tooltip hides, the next one shown within
// GRACE_MS skips its delay. This is what makes sweeping across a toolbar snappy —
// you wait once, not on every icon.
const GRACE_MS = 400;
let lastHideAt = -Infinity;

function isEmpty(content: TooltipProps["content"]): boolean {
  return (
    content == null ||
    content === "" ||
    (Array.isArray(content) && content.length === 0)
  );
}

export default function Tooltip({
  content,
  title,
  placement = "top",
  delay = 100,
  disabled,
  children,
}: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false); // toggles .show for the enter transition
  const [placed, setPlaced] = useState<Placed | null>(null);
  const id = useId();

  const off = disabled || isEmpty(content);

  function clearTimer() {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function hoverShow() {
    if (off) return;
    clearTimer();
    const instant = delay <= 0 || Date.now() - lastHideAt < GRACE_MS;
    if (instant) setOpen(true);
    else timerRef.current = window.setTimeout(() => setOpen(true), delay);
  }

  function focusShow() {
    if (off) return;
    clearTimer();
    setOpen(true); // keyboard focus is always instant
  }

  function hide() {
    clearTimer();
    setOpen((wasOpen) => {
      if (wasOpen) lastHideAt = Date.now();
      return false;
    });
    setShown(false);
  }

  // Guard against a pending delay firing setOpen after this instance unmounts.
  useEffect(() => () => clearTimer(), []);

  // Measure + position once the bubble is in the DOM, then flip on .show next frame.
  useLayoutEffect(() => {
    if (!open) return;
    const tr = triggerRef.current?.getBoundingClientRect();
    const b = bubbleRef.current;
    if (!tr || !b) return;
    const p = computePlacement(
      { left: tr.left, top: tr.top, width: tr.width, height: tr.height },
      { width: b.offsetWidth, height: b.offsetHeight },
      placement,
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPlaced(p);
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [open, placement, content, title]);

  // Hide on scroll (capture, so nested scrollers count), resize, and Escape.
  useLayoutEffect(() => {
    if (!open) return;
    const onScroll = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const lines = Array.isArray(content) ? content : [content];

  // aria-describedby must live on the element that actually receives focus.
  // The wrapper span is never focused itself (only its child is), so when
  // children is a single element we inject the attribute onto it directly;
  // otherwise fall back to the wrapper as a best effort.
  const describedBy = open ? id : undefined;
  const describedChildren = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, {
        "aria-describedby": describedBy,
      })
    : children;

  return (
    <>
      <span
        ref={triggerRef}
        className="tooltip-trigger"
        aria-describedby={isValidElement(children) ? undefined : describedBy}
        onMouseEnter={hoverShow}
        onMouseLeave={hide}
        onFocus={focusShow}
        onBlur={hide}
      >
        {describedChildren}
      </span>
      {open &&
        !off &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className={`tooltip${shown ? " show" : ""}`}
            data-side={placed?.side ?? placement}
            style={{ left: placed?.left ?? 0, top: placed?.top ?? 0 }}
          >
            {title && <div className="tooltip-title">{title}</div>}
            {lines.map((line, i) =>
              // Array content is a list of description lines (each gets the
              // tooltip-desc spacing), whether the line is a string or a node
              // (e.g. a line with a bold word). A lone non-array node is a
              // custom block (e.g. WindowStrip) and stays unstyled.
              Array.isArray(content) || typeof line === "string" || typeof line === "number" ? (
                <div className="tooltip-desc" key={i}>
                  {line}
                </div>
              ) : (
                <div key={i}>{line}</div>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
