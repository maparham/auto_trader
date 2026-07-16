// Combined appearance control in the top tab bar (replaces the old ThemeToggle).
// One sun/moon button opens a dropdown holding BOTH the light/dark theme choice
// and the one-click chart-background "moods". The moods are five fixed slots whose
// colors are editable in place (click a slot's swatch to recolor via the shared
// ColorLineStylePicker; click its label to apply). "Theme default" clears the
// override; "Reset colors" restores the default slot colors. All of it flows
// through `settings` (chartBg / chartBgOpacity / bgMoods) — the App effect applies
// the result to the `--chart-bg` CSS variable.

import { useEffect, useRef, useState } from "react";
import type { Settings, Theme } from "./theme";
import ColorLineStylePicker from "./ColorLineStylePicker";
import Tooltip from "./components/Tooltip";
import {
  BG_MOOD_DEFS,
  moodColor,
  activeMoodId,
  applyMood,
  clearBg,
  setMoodColor,
  resetMoods,
  anyMoodCustomised,
} from "./lib/bgMoods";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
}

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "☀️ Light" },
  { value: "dark", label: "🌙 Dark" },
];

export default function AppearanceMenu({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click. The mood swatches use ColorLineStylePicker, whose panel
  // is PORTALED to <body> (outside menuRef) — so a click there must NOT close us.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if ((t as Element).closest?.(".clsp-panel")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = activeMoodId(settings);
  const isDefault = !settings.chartBg;

  return (
    <div className="menu appearance-menu" ref={menuRef}>
      <Tooltip content="Appearance">
      <button
        className={`tabbar-action icon-only appearance-toggle${open ? " on" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        {settings.theme === "dark" ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        )}
      </button>
      </Tooltip>

      {open && (
        <div className="dropdown appearance-dropdown">
          <div className="appr-label">Theme</div>
          <div className="seg appr-theme">
            {THEMES.map((t) => (
              <button
                key={t.value}
                className={settings.theme === t.value ? "seg-on" : ""}
                onClick={() => onChange({ ...settings, theme: t.value })}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="appr-label appr-bg-label">
            <span>Background</span>
            {anyMoodCustomised(settings) && (
              <button className="appr-reset" onClick={() => onChange(resetMoods(settings))}>
                Reset colors
              </button>
            )}
          </div>

          <ul className="appr-moods">
            <li className={`appr-mood${isDefault ? " on" : ""}`}>
              <span className="appr-swatch appr-swatch--default" aria-hidden="true" />
              <button
                className="appr-mood-label"
                onClick={() => onChange(clearBg(settings))}
              >
                Theme default
              </button>
              {isDefault && <span className="appr-check" aria-hidden="true">✓</span>}
            </li>

            {BG_MOOD_DEFS.map((def) => {
              const c = moodColor(settings, def);
              return (
                <li key={def.id} className={`appr-mood${active === def.id ? " on" : ""}`}>
                  <ColorLineStylePicker
                    title={`${def.label} color`}
                    color={c.color}
                    onColor={(hex) => onChange(setMoodColor(settings, def, hex, c.opacity))}
                    opacity={c.opacity}
                    onOpacity={(a) => onChange(setMoodColor(settings, def, c.color, a))}
                  />
                  <button
                    className="appr-mood-label"
                    onClick={() => onChange(applyMood(settings, def))}
                  >
                    {def.label}
                  </button>
                  {active === def.id && <span className="appr-check" aria-hidden="true">✓</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
