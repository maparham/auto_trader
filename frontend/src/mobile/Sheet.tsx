import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export default function Sheet({
  title,
  onClose,
  children,
}: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="m-sheet-backdrop" onClick={onClose}>
      <div
        className="m-sheet"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div className="m-sheet-title">{title}</div>}
        <div className="m-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
