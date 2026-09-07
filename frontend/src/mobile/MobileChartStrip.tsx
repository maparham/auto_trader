// Horizontally scrollable strip mirroring the desktop's saved layout: one chip
// per desktop chart cell, grouped by tab (divider between tabs). Read-only —
// tapping a chip shows that cell's chart (exact scope, so its drawings and
// indicators) without ever writing the desktop workspace.
import { useSyncExternalStore } from "react";
import {
  mirroredWorkspace,
  flattenCells,
  mobileWorkspaceVersion,
} from "./mobileWorkspace";
import { mobileChartScope, mobilePeriod, setMobileSymbol } from "./mobileChartState";

export default function MobileChartStrip() {
  useSyncExternalStore(
    (fn) => mobileWorkspaceVersion.subscribe(fn),
    () => mobileWorkspaceVersion.value,
  );
  const scope = useSyncExternalStore(
    (fn) => mobileChartScope.subscribe(fn),
    () => mobileChartScope.value,
  );

  const mirror = mirroredWorkspace();
  if (!mirror) return null;
  const cells = flattenCells(mirror.ws);
  if (!cells.length) return null;

  return (
    <div className="m-chart-strip" role="tablist" aria-label={`Layout: ${mirror.name}`}>
      {cells.map((f, i) => {
        const active = scope?.scope === f.cell.scope && scope?.epic === f.cell.symbol.epic;
        const newTab = i > 0 && cells[i - 1].tabIndex !== f.tabIndex;
        return (
          <span key={f.cell.scope + f.cell.symbol.epic} className="m-chart-strip-group">
            {newTab && <span className="m-chart-strip-divider" aria-hidden />}
            <button
              className={"m-chart-strip-chip" + (active ? " active" : "")}
              onClick={() => {
                setMobileSymbol(f.cell.symbol, undefined, f.cell.scope);
                mobilePeriod.set(f.cell.period);
              }}
            >
              {f.cell.symbol.epic} {f.cell.period.label}
            </button>
          </span>
        );
      })}
    </div>
  );
}
