// The fixed chart-background "mood" presets for the one-click switcher in the tab
// bar (AppearanceMenu.tsx). Five fixed slots with fixed names; only each slot's
// COLOR is customisable (stored per-slot in settings.bgMoods, synced across
// devices). A mood is just a target for the existing chartBg / chartBgOpacity
// settings — the App effect turns them into the `--chart-bg` CSS variable via
// compositeOverHex, so a mood composites over the active theme background exactly
// like a hand-picked color.
//
// Default colors are tuned as light-theme washes (the default theme): a
// bright→dim / cool→warm progression. In dark theme they still read sensibly — the
// same color composited over the dark background nudges it lighter.

import type { Settings } from "../theme";

export interface BgMoodDef {
  id: string;
  label: string;
  defaultColor: string;
  defaultOpacity: number;
}

export const BG_MOOD_DEFS: BgMoodDef[] = [
  { id: "bright", label: "Morning bright", defaultColor: "#fbfaf7", defaultOpacity: 1 },
  { id: "lessblue", label: "Less blue", defaultColor: "#f4efe6", defaultOpacity: 1 },
  { id: "paper", label: "Paper", defaultColor: "#ece3d0", defaultOpacity: 1 },
  { id: "dimgrey", label: "Dim grey", defaultColor: "#c7ccd4", defaultOpacity: 1 },
  { id: "dusk", label: "Dusk", defaultColor: "#9aa1ab", defaultOpacity: 1 },
];

// The effective (possibly user-customised) color + opacity for a mood slot.
export function moodColor(
  s: Pick<Settings, "bgMoods">,
  def: BgMoodDef,
): { color: string; opacity: number } {
  const o = s.bgMoods?.[def.id];
  return {
    color: o?.color ?? def.defaultColor,
    opacity: o?.opacity ?? def.defaultOpacity,
  };
}

// True when a slot's color has been customised away from its default.
export function isMoodCustomised(s: Pick<Settings, "bgMoods">, def: BgMoodDef): boolean {
  const o = s.bgMoods?.[def.id];
  return !!o && (o.color.toLowerCase() !== def.defaultColor.toLowerCase() ||
    (o.opacity ?? def.defaultOpacity) !== def.defaultOpacity);
}

// Whether any slot has been customised (drives the "Reset colors" affordance).
export function anyMoodCustomised(s: Pick<Settings, "bgMoods">): boolean {
  return BG_MOOD_DEFS.some((d) => isMoodCustomised(s, d));
}

// The mood currently applied, or null when the background is the theme default
// (no override) or a one-off custom color that matches no slot.
export function activeMoodId(
  s: Pick<Settings, "chartBg" | "chartBgOpacity" | "bgMoods">,
): string | null {
  if (!s.chartBg) return null;
  const op = s.chartBgOpacity ?? 1;
  const hit = BG_MOOD_DEFS.find((d) => {
    const c = moodColor(s, d);
    return c.color.toLowerCase() === s.chartBg!.toLowerCase() && c.opacity === op;
  });
  return hit ? hit.id : null;
}

// Fold a mood into a Settings object (applies its effective color + opacity).
export function applyMood(s: Settings, def: BgMoodDef): Settings {
  const c = moodColor(s, def);
  return { ...s, chartBg: c.color, chartBgOpacity: c.opacity };
}

// Clear the override entirely → pure theme background.
export function clearBg(s: Settings): Settings {
  return { ...s, chartBg: undefined, chartBgOpacity: undefined };
}

// Recolor a slot; when that slot is the active mood, apply the new color live too.
export function setMoodColor(
  s: Settings,
  def: BgMoodDef,
  color: string,
  opacity: number,
): Settings {
  const bgMoods = { ...(s.bgMoods ?? {}), [def.id]: { color, opacity } };
  const wasActive = activeMoodId(s) === def.id;
  return {
    ...s,
    bgMoods,
    ...(wasActive ? { chartBg: color, chartBgOpacity: opacity } : {}),
  };
}

// Reset all slot colors to their defaults (and drop a now-stale active override
// so the chart doesn't keep a customised color that no longer exists as a slot).
export function resetMoods(s: Settings): Settings {
  const wasCustomActive = BG_MOOD_DEFS.some(
    (d) => activeMoodId(s) === d.id && isMoodCustomised(s, d),
  );
  return {
    ...s,
    bgMoods: undefined,
    ...(wasCustomActive ? { chartBg: undefined, chartBgOpacity: undefined } : {}),
  };
}
