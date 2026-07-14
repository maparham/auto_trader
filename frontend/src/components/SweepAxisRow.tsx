// One swept numeric axis's from/to/step controls. Rendered inline beneath the
// field it sweeps (param row, risk row, rule row); the field's own input is
// hidden while its axis is on, so this row replaces it.

import type { RangeAxis } from "../lib/sweep";
import NumberField from "./NumberField";

export function SweepAxisRow({
  axis,
  onChange,
}: {
  axis: RangeAxis;
  onChange: (patch: Partial<Pick<RangeAxis, "from" | "to" | "step">>) => void;
}) {
  return (
    <div className="sp-row sweep-axis-row">
      <span className="sp-label">{axis.label} sweep</span>
      <span className="sweep-axis-fields">
        <NumberField value={axis.from} onChange={(n) => onChange({ from: n })} signed className="bt-num" />
        <span>to</span>
        <NumberField value={axis.to} onChange={(n) => onChange({ to: n })} signed className="bt-num" />
        <span>step</span>
        <NumberField value={axis.step} onChange={(n) => onChange({ step: n })} signed className="bt-num" />
      </span>
    </div>
  );
}
