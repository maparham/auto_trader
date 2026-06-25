// Shared modal-header close control. One inline SVG ✕ so every modal's close button
// is identical, replacing the per-modal "✕" text glyph. Label defaults to "Close";
// modals that treat it as a cancel (settings/drawing/indicator) pass label="Cancel".

interface Props {
  onClick: () => void;
  label?: string;
}

export default function CloseButton({ onClick, label = "Close" }: Props) {
  return (
    <button className="modal-close" onClick={onClick} title={label} aria-label={label}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}
