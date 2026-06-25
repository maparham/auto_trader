// Close a modal/popover when Escape is pressed. Every modal in the app wired its
// own identical keydown effect; this is that effect, factored out.
//
// Usage:
//   useCloseOnEscape(onClose);   // or a `cancel` that reverts state, etc.
//
// The handler is read through a ref so the listener is attached once and never
// re-subscribes on a changing handler identity (modals often pass an inline
// arrow), while still calling the latest handler.

import { useEffect, useRef } from "react";

export function useCloseOnEscape(onEscape: () => void): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
