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

// "#RRGGBB" + 0..1 alpha → "rgba(r,g,b,a)". klinecharts line styles have no
// separate opacity field, so callers that want a translucent line fold the alpha
// into the color string. Passes anything that isn't a 6-digit hex straight through
// (e.g. an already-rgba string, or "" to mean "no override").
export function hexToRgba(hex: string, alpha: number): string {
  // Leading '#' optional so a bare "rrggbb" still converts (the prior home of this
  // helper accepted it; requiring '#' would silently pass such a color through
  // unconverted, dropping the alpha and rendering an opaque fill).
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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
