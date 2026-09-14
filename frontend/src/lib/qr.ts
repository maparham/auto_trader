// QR encoding for the Telegram link deep link (NotificationSettings' "Show QR"
// button): turns a URL into an SVG path so the caller can render it inline
// rather than as a canvas or a data-URL image. Inline SVG keeps it crisp at any
// size, testable under jsdom (the path string is the assertion), and free of a
// second network/bitmap hop.
//
// `qrcode-generator` does the encoding (Reed-Solomon, mask selection); we only
// walk its module matrix. Error-correction level M is the usual default: ~15%
// recovery, small enough that a ~50 char t.me URL still fits a version-3 grid.

import qrcode from "qrcode-generator";

export type QrPath = {
  /** Side length of the viewBox in modules, margin included. */
  size: number;
  /** SVG path data: one 1x1 square per dark module. */
  path: string;
};

const QUIET_ZONE_MODULES = 2;

/**
 * Encode `text` as a QR code and return its geometry as SVG path data in
 * module units, so the caller sets the pixel size purely via width/height.
 *
 * `margin` is the quiet zone in modules (default 2). The spec asks for 4, but
 * the rendered card already sits on its own white plate, so 2 scans reliably
 * while wasting less of the box.
 */
export function qrSvgPath(text: string, margin = QUIET_ZONE_MODULES): QrPath {
  // typeNumber 0 = pick the smallest version that fits the data.
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) parts.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    }
  }
  return { size: count + margin * 2, path: parts.join("") };
}
