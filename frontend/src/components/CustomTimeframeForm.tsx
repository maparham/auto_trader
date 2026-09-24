import { useState } from "react";
import { canonicalTf, tfLabel, TF_LIMITS, TF_UNIT_SUFFIX, tfRangeMessage } from "../lib/timeframe";
import Tooltip from "./Tooltip";

type Unit = keyof typeof TF_LIMITS;
const UNITS: Unit[] = ["MINUTE", "HOUR", "DAY", "WEEK", "MONTH"];
const UNIT_NAME: Record<Unit, string> = {
  MINUTE: "minutes", HOUR: "hours", DAY: "days", WEEK: "weeks", MONTH: "months",
};

// What the typed size + unit would add: the canonical resolution, or the
// reason it can't be added. Empty input is neither (nothing to say yet).
function resolve(n: string, unit: Unit): { resolution: string } | { error: string } | null {
  const raw = n.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return { error: "Use a whole number" };
  // Range-check first: a size too long for the grammar's digit cap (100000)
  // would otherwise read as an unknown timeframe instead of naming the range.
  const size = parseInt(raw, 10);
  if (!(size >= 1 && size <= TF_LIMITS[unit])) return { error: tfRangeMessage(unit) };
  return { resolution: canonicalTf(`${unit}_${size}`) };
}

// One compact row: size field and unit segments share a single box, and the
// button below previews what it adds in the app's own labels ("Add 2H" for 120
// minutes), so the rewrite to a canonical timeframe is visible before it happens.
export default function CustomTimeframeForm({ onAdd }: { onAdd: (resolution: string) => void }) {
  const [n, setN] = useState("");
  const [unit, setUnit] = useState<Unit>("MINUTE");
  const result = resolve(n, unit);
  const ready = result != null && "resolution" in result;

  return (
    <form
      className="custom-tf-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onAdd(result.resolution);
        setN("");
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={"custom-tf-field" + (result && "error" in result ? " invalid" : "")}>
        <input
          aria-label="Custom timeframe size"
          inputMode="numeric"
          placeholder="7"
          value={n}
          onChange={(e) => setN(e.target.value)}
        />
        <div className="custom-tf-units" role="radiogroup" aria-label="Custom timeframe unit">
          {UNITS.map((u) => (
            <button
              key={u}
              type="button"
              role="radio"
              aria-checked={u === unit}
              aria-label={UNIT_NAME[u]}
              className={u === unit ? "on" : ""}
              onClick={() => setUnit(u)}
            >
              {TF_UNIT_SUFFIX[u]}
            </button>
          ))}
        </div>
      </div>
      {result && "error" in result ? (
        <div className="custom-tf-error" role="alert">
          {result.error}
        </div>
      ) : (
        <Tooltip
          content={["Bars reset at 00:00 UTC", "Minute sizes not divisible by 5 have about 10 days of history"]}
        >
          <button type="submit" className="custom-tf-add" disabled={!ready}>
            {ready ? `Add ${tfLabel(result.resolution)}` : "Add"}
          </button>
        </Tooltip>
      )}
    </form>
  );
}
