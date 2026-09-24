import { useEffect, useRef, useState } from "react";
import Sheet from "./Sheet";
import CustomTimeframeForm from "../components/CustomTimeframeForm";
import { isBuiltinResolution, periodByResolution, periodGroups, type Period } from "../lib/feed";
import { loadCustomResolutions, saveCustomResolutions } from "../lib/persist";

// The mobile timeframe picker: the desktop dropdown's groups as tap-sized chip
// grids (seconds are left out, as they always were on mobile), then Custom with
// the saved list and the same add form. The current timeframe is always marked,
// including a custom one opened from desktop that this device never saved.
export default function MobilePeriodSheet({
  current,
  onPick,
  onClose,
}: {
  current: Period | null;
  onPick: (p: Period) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState<string[]>(loadCustomResolutions);
  const customRef = useRef<HTMLElement>(null);
  // The on-screen keyboard covers the sheet's bottom, where the add form's
  // button and error sit, and focusing the field only scrolls the field itself
  // into view. Keep the whole Custom section above the keyboard while typing.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const reveal = () => {
      const section = customRef.current;
      if (section && section.contains(document.activeElement)) {
        section.scrollIntoView({ block: "end" });
      }
    };
    vv.addEventListener("resize", reveal);
    return () => vv.removeEventListener("resize", reveal);
  }, []);
  const groups = periodGroups(custom).filter((g) => g.label !== "Seconds");
  const customGroup = groups.find((g) => g.label === "Custom");
  const builtIns = groups.filter((g) => g !== customGroup);
  const customChips = [...(customGroup?.periods ?? [])];
  if (
    current &&
    !isBuiltinResolution(current.resolution) &&
    !customChips.some((p) => p.resolution === current.resolution)
  ) {
    customChips.push(current);
  }

  function add(resolution: string) {
    const period = periodByResolution(resolution);
    if (!period) return;
    if (!isBuiltinResolution(resolution) && !custom.includes(resolution)) {
      const next = [...custom, resolution];
      saveCustomResolutions(next);
      setCustom(next);
    }
    onPick(period);
  }

  const chip = (p: Period) => (
    <button
      key={p.resolution}
      type="button"
      className="m-tf-chip"
      aria-pressed={p.resolution === current?.resolution}
      onClick={() => onPick(p)}
    >
      {p.label}
    </button>
  );

  return (
    <Sheet title="Timeframe" onClose={onClose}>
      <div className="m-tf-sheet">
        {builtIns.map((g) => (
          <section key={g.label} role="group" aria-label={g.label} className="m-tf-group">
            <h3 className="m-tf-group-label">{g.label}</h3>
            <div className="m-tf-grid">{g.periods.map(chip)}</div>
          </section>
        ))}
        <section ref={customRef} role="group" aria-label="Custom" className="m-tf-group">
          <h3 className="m-tf-group-label">Custom</h3>
          {customChips.length > 0 && <div className="m-tf-grid">{customChips.map(chip)}</div>}
          <CustomTimeframeForm onAdd={add} />
        </section>
      </div>
    </Sheet>
  );
}
