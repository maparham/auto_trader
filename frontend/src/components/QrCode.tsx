// Inline-SVG QR code. Deliberately NOT theme-aware: scanners want dark modules
// on a light ground, so the plate stays white and the modules black in dark
// mode too, the way a printed code would be.

import { qrSvgPath } from "../lib/qr";

export default function QrCode({
  text,
  size = 148,
  title,
}: {
  text: string;
  /** Rendered edge length in px (the module grid scales to fit). */
  size?: number;
  /** Accessible name; the code itself carries no visible text. */
  title?: string;
}) {
  const { size: modules, path } = qrSvgPath(text);
  return (
    <svg
      className="qr-code"
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      role="img"
      aria-label={title ?? "QR code"}
      shapeRendering="crispEdges"
    >
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
