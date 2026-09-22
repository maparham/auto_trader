import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { computePlacement, type Placed, type Placement } from "./tooltipPosition";
import { WarnTriangleIcon } from "../lib/menuIcons";

interface TooltipProps {
  content: string | string[] | ReactNode;
  title?: string;
  /**
   * A trailing caveat or hint, set smaller and fainter than the description so
   * it reads as secondary rather than as one more line of the explanation.
   * `noteWarn` prefixes the shared amber ⚠ for a caveat ("this isn't saved");
   * leave it off for a neutral hint ("double-click to cycle").
   */
  note?: string;
  noteWarn?: boolean;
  placement?: Placement;
  delay?: number;
  disabled?: boolean;
  /**
   * Attach the hover/focus handlers and the anchor ref to the single child
   * element itself instead of wrapping it in a span. For triggers a wrapper
   * would break: table rows, list items, absolutely positioned buttons, flex
   * children that scripts query with `:scope > .x`. The child's own handlers
   * and ref still run. Avoid it for `disabled` buttons, which may not fire
   * mouse events; keep the wrapper there.
   */
  asChild?: boolean;
  children: ReactNode;
}

type TriggerProps = {
  ref?: Ref<HTMLElement>;
  onMouseEnter?: (e: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: ReactMouseEvent<HTMLElement>) => void;
  onFocus?: (e: ReactFocusEvent<HTMLElement>) => void;
  onBlur?: (e: ReactFocusEvent<HTMLElement>) => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  "aria-describedby"?: string;
};

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as RefObject<T | null>).current = value;
}

// Module-level grace window: after any tooltip hides, the next one shown within
// GRACE_MS skips its delay. This is what makes sweeping across a toolbar snappy —
// you wait once, not on every icon.
const GRACE_MS = 400;
let lastHideAt = -Infinity;
// Whether the most recent pointer on the page was a touch or pen. A tap fires
// a synthetic mouseenter and focus with no mouseleave ever coming, so while
// this is set the hover and focus paths are muted and a trigger opens by tap
// instead (see the trigger's onPointerDown). A real mouse clears it.
let lastPointerTouch = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      lastPointerTouch = e.pointerType !== "mouse";
    },
    true,
  );
}

// Every open tooltip's trigger and hide(). Triggers can nest (a table row with
// a hint, a button inside it with its own), and two bubbles must never stack:
// the innermost open trigger wins, whichever of the two opened first.
const openTips = new Set<{ el: HTMLElement; hide: () => void }>();

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
  note,
  noteWarn,
  placement = "top",
  delay = 100,
  disabled,
  asChild,
  children,
}: TooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false); // toggles .show for the enter transition
  const [placed, setPlaced] = useState<Placed | null>(null);
  const id = useId();

  const off = disabled || isEmpty(content);

  // Going `disabled` (or losing its content) while the bubble is up takes it
  // down, and leaves it down: the paint already gates on `off`, but a stale
  // `open` would pop the bubble straight back the moment it is re-enabled, with
  // the pointer never having moved. This is the adjust-state-during-render
  // pattern (not an effect) so it costs one render, not a second pass.
  const [wasOff, setWasOff] = useState(off);
  if (off !== wasOff) {
    setWasOff(off);
    if (off && open) {
      clearTimer();
      setOpen(false);
      setShown(false);
    }
  }

  function clearTimer() {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function hoverShow() {
    if (off || lastPointerTouch) return;
    clearTimer();
    const instant = delay <= 0 || Date.now() - lastHideAt < GRACE_MS;
    if (instant) setOpen(true);
    else timerRef.current = window.setTimeout(() => setOpen(true), delay);
  }

  function focusShow() {
    if (off || lastPointerTouch) return;
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

  useLayoutEffect(() => {
    const el = triggerRef.current;
    if (!open || off || !el) return;
    for (const other of openTips) {
      if (el.contains(other.el)) {
        hide(); // a nested trigger is already showing its bubble
        return;
      }
    }
    for (const other of openTips) if (other.el.contains(el)) other.hide();
    const entry = { el, hide };
    openTips.add(entry);
    return () => {
      openTips.delete(entry);
    };
  }, [open, off]);

  // Hide on scroll (capture, so nested scrollers count), resize, and Escape.
  useLayoutEffect(() => {
    if (!open) return;
    const onScroll = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    // A touch anywhere outside the trigger takes the bubble down: no
    // mouseleave will. A touch on the trigger itself is the toggle above.
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      const t = e.target;
      if (t instanceof Node && triggerRef.current?.contains(t)) return;
      hide();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  const lines = Array.isArray(content) ? content : [content];

  const describedBy = open ? id : undefined;

  function togglePointer(e: ReactPointerEvent<HTMLElement>) {
    // Touch: a tap toggles the bubble (the ⓘ icons have no hover to
    // give). The window listener below closes it on a tap elsewhere.
    if (e.pointerType === "mouse" || off) return;
    if (open) hide();
    else {
      clearTimer();
      setOpen(true);
    }
  }

  let trigger: ReactNode;
  if (asChild && isValidElement(children)) {
    // The child becomes the trigger: its own handlers run first, then ours,
    // and its own ref (React 19 carries it in props) still gets the node.
    const child = children as ReactElement<TriggerProps>;
    const p = child.props;
    trigger = cloneElement(child, {
      ref: (node: HTMLElement | null) => {
        triggerRef.current = node;
        setRef(p.ref, node);
      },
      onMouseEnter: (e) => {
        p.onMouseEnter?.(e);
        hoverShow();
      },
      onMouseLeave: (e) => {
        p.onMouseLeave?.(e);
        hide();
      },
      onFocus: (e) => {
        p.onFocus?.(e);
        focusShow();
      },
      onBlur: (e) => {
        p.onBlur?.(e);
        hide();
      },
      onPointerDown: (e) => {
        p.onPointerDown?.(e);
        togglePointer(e);
      },
      "aria-describedby": describedBy ?? p["aria-describedby"],
    });
  } else {
    // aria-describedby must live on the element that actually receives focus.
    // The wrapper span is never focused itself (only its child is), so when
    // children is a single element we inject the attribute onto it directly;
    // otherwise fall back to the wrapper as a best effort.
    const describedChildren = isValidElement(children)
      ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, {
          "aria-describedby": describedBy,
        })
      : children;
    trigger = (
      <span
        ref={triggerRef as RefObject<HTMLSpanElement | null>}
        className="tooltip-trigger"
        aria-describedby={isValidElement(children) ? undefined : describedBy}
        onMouseEnter={hoverShow}
        onMouseLeave={hide}
        onFocus={focusShow}
        onBlur={hide}
        onPointerDown={togglePointer}
      >
        {describedChildren}
      </span>
    );
  }

  return (
    <>
      {trigger}
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
            {note && (
              <div className={`tooltip-note${noteWarn ? " warn" : ""}`}>
                {noteWarn && <WarnTriangleIcon size={12} />}
                <span>{note}</span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
