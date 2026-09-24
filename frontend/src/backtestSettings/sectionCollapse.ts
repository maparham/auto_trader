import { useState } from "react";

// Remember which sections the user collapsed, keyed by section title, across
// reloads. A shared blob so one key holds every section's state.
const SECTION_COLLAPSE_KEY = "bt-section-collapsed";
function loadCollapsedSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_COLLAPSE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

// Collapse state for one titled section, persisted in the shared blob. Shared
// by <Section> and the risk/scaling blocks, so e.g. collapsing "Stop & take
// profit" on the long side starts the short side (and future modals) collapsed
// too — same key, same title.
export function useSectionCollapse(title: string) {
  const [collapsed, setCollapsed] = useState<boolean>(() => loadCollapsedSections()[title] ?? false);
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        const all = loadCollapsedSections();
        all[title] = next;
        localStorage.setItem(SECTION_COLLAPSE_KEY, JSON.stringify(all));
      } catch {}
      return next;
    });
  };
  return [collapsed, toggle] as const;
}
