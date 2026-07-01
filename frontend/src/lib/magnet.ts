// TradingView-style "Magnet mode": snap drawing points to the nearest OHLC value
// of the bar they're placed/dragged near. The snapping itself is done natively by
// klinecharts (OverlayView._coordinateToPoint) whenever an overlay's `mode` is
// WeakMagnet/StrongMagnet on the candle pane — so this module owns only the app
// STATE: a single global, persisted setting, plus the mapping to klinecharts'
// OverlayMode. OverlayManager reads currentMagnetMode() when creating drawings and
// subscribes to magnetSignal to keep existing drawings' mode in sync; the Toolbar
// button/dropdown drives it. Magnet is GLOBAL (one setting for every cell, like TV)
// and persisted across sessions.
import { Signal } from "./signals";
import { loadMagnet, saveMagnet } from "./persist";

// klinecharts' OverlayMode is a string enum whose values are these exact strings.
// We use the literals directly instead of importing the runtime enum: the CJS build
// (which vitest resolves) drops the enum export, so importing it as a value breaks
// under test. overlays.ts casts a MagnetMode to OverlayMode at the createOverlay
// boundary (identical at runtime — klinecharts stores the raw string).
export type MagnetMode = "normal" | "weak_magnet" | "strong_magnet";

export type MagnetStrength = "weak" | "strong";
export interface MagnetSetting {
  // Whether snapping is active. `strength` is remembered even while off, so
  // toggling back on restores the last-used strength.
  on: boolean;
  strength: MagnetStrength;
}

export const DEFAULT_MAGNET: MagnetSetting = { on: false, strength: "weak" };

// WeakMagnet proximity threshold in px — the klinecharts default. Not
// user-configurable this iteration; a named constant so it's easy to tune later.
export const MAGNET_SENSITIVITY = 8;

// Map a setting to the klinecharts overlay `mode`.
export function magnetMode(s: MagnetSetting): MagnetMode {
  if (!s.on) return "normal";
  return s.strength === "strong" ? "strong_magnet" : "weak_magnet";
}

// The "hold Ctrl/Cmd" momentary override: flip snapping on↔off while the key is
// held, keeping the chosen strength. Off → snaps at the last strength; on → Normal.
export function invertMode(s: MagnetSetting): MagnetMode {
  return magnetMode({ on: !s.on, strength: s.strength });
}

// Global, persisted magnet setting. Seeded from storage (merged over the default so
// a missing field never yields undefined) so a reload restores the last state.
export const magnetSignal = new Signal<MagnetSetting>({
  ...DEFAULT_MAGNET,
  ...loadMagnet<Partial<MagnetSetting>>({}),
});

// The single writer: update the signal AND persist. Every mutation routes through
// here so storage and the live signal never drift.
export function setMagnet(next: MagnetSetting): void {
  magnetSignal.set(next);
  saveMagnet(next);
}

// Toolbar button click — flip on/off, keeping strength.
export function toggleMagnet(): void {
  setMagnet({ ...magnetSignal.value, on: !magnetSignal.value.on });
}

// Toolbar dropdown — picking a strength selects it AND turns magnet on.
export function setMagnetStrength(strength: MagnetStrength): void {
  setMagnet({ on: true, strength });
}

// Current effective mode with no modifier held.
export function currentMagnetMode(): MagnetMode {
  return magnetMode(magnetSignal.value);
}

// Whether the "hold Ctrl/Cmd" momentary-invert modifier is currently down. NOT
// persisted and NOT part of the toolbar state — a transient input flag. Set by the
// global key listener (installMagnetModifierKeys); OverlayManager mixes it into the
// mode it hands klinecharts so a held modifier flips snapping for the active draw/drag.
export const magnetInvertSignal = new Signal<boolean>(false);

// The mode OverlayManager actually applies: the global setting, inverted while the
// hold-modifier is down.
export function effectiveMagnetMode(): MagnetMode {
  return magnetInvertSignal.value ? invertMode(magnetSignal.value) : magnetMode(magnetSignal.value);
}

// Wire the momentary-invert modifier (Ctrl on Windows/Linux, Cmd on Mac). While the
// modifier is held, magnetInvertSignal is true, so a draw/drag snaps the opposite of
// the toolbar toggle (TV's "hold Ctrl while drawing" behavior). Mirrors the live
// modifier state off every key event (so Ctrl+C etc. also register — harmless, since
// inversion only changes anything during an active draw/drag), and clears on blur so
// a held key can't stick after an alt-tab. Returns a teardown; call once from App.
export function installMagnetModifierKeys(): () => void {
  const sync = (e: KeyboardEvent) => magnetInvertSignal.set(e.ctrlKey || e.metaKey);
  const clear = () => magnetInvertSignal.set(false);
  window.addEventListener("keydown", sync);
  window.addEventListener("keyup", sync);
  window.addEventListener("blur", clear);
  return () => {
    window.removeEventListener("keydown", sync);
    window.removeEventListener("keyup", sync);
    window.removeEventListener("blur", clear);
    clear();
  };
}
