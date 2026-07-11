// Maps our neutral line-style vocabulary ("solid"|"dashed"|"dotted", used by the
// ColorLineStylePicker) onto klinecharts' line-style fields and back.
//
// klinecharts' LineType enum has only Solid and Dashed — "dotted" is expressed as a
// Dashed line with a short on/long off dashedValue. So the round-trip reads the pair
// {style, dashedValue} to recover which of the three the user picked.

import { LineType } from "klinecharts";
import type { LineStyleOpt } from "../ColorLineStylePicker";

// Dash patterns (pixels: [on, off]) per style. Solid ignores the pattern.
export const DASH_DASHED: [number, number] = [5, 4];
export const DASH_DOTTED: [number, number] = [1, 3];

export interface KLineStyleFields {
  style: LineType;
  dashedValue: [number, number];
}

// Our option → klinecharts {style, dashedValue}.
export function toKLineStyle(opt: LineStyleOpt): KLineStyleFields {
  switch (opt) {
    case "solid":
      return { style: LineType.Solid, dashedValue: DASH_DASHED };
    case "dashed":
      return { style: LineType.Dashed, dashedValue: DASH_DASHED };
    case "dotted":
      return { style: LineType.Dashed, dashedValue: DASH_DOTTED };
  }
}

// "#RGB" / "#RRGGBB" / "rgb(...)" / "rgba(...)" + 0..1 alpha → "rgba(r,g,b,a)".
// klinecharts line styles have no separate opacity field, so callers that want a
// translucent line fold the alpha into the color string. Re-alphas an already-rgba(o)
// string too (preserving its hue, dropping its old alpha) rather than passing it
// through unconverted, so re-fading an already-translucent color still lands on the
// requested alpha. Falls back to the original string for any other format (named
// colors, unparseable input, "" to mean "no override") rather than guessing wrong.
export function hexToRgba(hex: string, alpha: number): string {
  if (!hex) return hex;
  // Leading '#' optional so a bare "rrggbb"/"rgb" still converts (the prior home of
  // this helper accepted a bare 6-digit form; requiring '#' would silently pass such
  // a color through unconverted, dropping the alpha and rendering an opaque fill).
  let m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(hex);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((c) => parseInt(c + c, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)$/.exec(hex);
  if (m) {
    return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  }
  return hex;
}

// Inverse of hexToRgba: split a stored color (hex or rgba) into a #RRGGBB hex plus a
// 0..1 alpha, for seeding the color-picker controls (which speak hex + opacity).
export function rgbaToHexAlpha(color: string, fallbackHex = "#2962ff"): { hex: string; alpha: number } {
  if (!color) return { hex: fallbackHex, alpha: 1 };
  let m = /^#?([0-9a-fA-F]{6})$/.exec(color);
  if (m) return { hex: `#${m[1].toLowerCase()}`, alpha: 1 };
  m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(color);
  if (m) return { hex: `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase(), alpha: 1 };
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
  if (m) {
    const hex =
      "#" +
      [m[1], m[2], m[3]]
        .map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, "0"))
        .join("");
    return { hex, alpha: m[4] !== undefined ? Number(m[4]) : 1 };
  }
  return { hex: fallbackHex, alpha: 1 };
}

// Alpha-composite a foreground color over an opaque background, returning an OPAQUE
// `rgb(...)`. Unlike hexToRgba (which yields a translucent color that reveals
// whatever is painted behind it), this bakes the blend in: alpha 0 = the background,
// alpha 1 = the foreground. Both inputs accept #RRGGBB / #RGB; a non-hex fg is
// returned unchanged (nothing sensible to blend).
export function compositeOverHex(fg: string, bg: string, alpha: number): string {
  const parse = (h: string): [number, number, number] | null => {
    let m = /^#?([0-9a-fA-F]{6})$/.exec(h);
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = /^#?([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(h);
    if (m) return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16)];
    return null;
  };
  const f = parse(fg);
  const b = parse(bg);
  if (!f || !b) return fg;
  const a = Math.max(0, Math.min(1, alpha));
  const mix = (i: number) => Math.round(f[i] * a + b[i] * (1 - a));
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

// klinecharts {style, dashedValue} → our option. Solid wins on style; among dashed,
// a short "on" segment (≤2px) reads as dotted, otherwise dashed. `style` is typed
// loosely (it's read straight off persisted/klinecharts styles).
export function fromKLineStyle(
  style: LineType | string | undefined,
  dashedValue: number[] | undefined,
): LineStyleOpt {
  if (style !== LineType.Dashed) return "solid";
  const on = dashedValue?.[0] ?? DASH_DASHED[0];
  return on <= 2 ? "dotted" : "dashed";
}
