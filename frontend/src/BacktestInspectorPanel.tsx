// Bar rule inspector (idea 2): when inspect mode is on and the user clicks a bar,
// this panel evaluates every rule group at that bar — each term with its live
// value and pass/fail, the AND/OR verdict — and shows the engine's outcome
// (opened / suppressed + reason) with the gate checks. Reads the session-only
// trace held in backtestInspect; renders the shared signal-popover term styling.

import { useSyncExternalStore } from "react";
import { termLabel, opSymbol } from "./lib/signalGlyphs";
import {
  inspectSelectedBarSignal,
  inspectTraceSignal,
  traceAt,
} from "./lib/backtestInspect";
import type { BarGroupTrace, BarTrace } from "./api";

const fmtVal = (n: number | null): string =>
  n == null ? "—" : Number.isInteger(n) ? String(n) : String(Number(n.toFixed(5)));

const GROUP_LABEL: Record<BarGroupTrace["group"], string> = {
  longEntry: "Long entry",
  shortEntry: "Short entry",
  longExit: "Long exit",
  shortExit: "Short exit",
};

// Exit groups become the salient ones once a position is held on either side.
function orderGroups(trace: BarTrace): BarGroupTrace[] {
  const held = trace.inPositionLong || trace.inPositionShort;
  const rank = (g: BarGroupTrace["group"]): number => {
    const entry = g === "longEntry" || g === "shortEntry";
    return held ? (entry ? 1 : 0) : entry ? 0 : 1;
  };
  return [...trace.groups].sort((a, b) => rank(a.group) - rank(b.group));
}

function GroupCard({ g }: { g: BarGroupTrace }) {
  return (
    <div className="bt-insp-group">
      <div className="bt-insp-group-head">
        <span className="bt-insp-group-name">{GROUP_LABEL[g.group]}</span>
        {g.terms.length > 1 && <span className="bt-insp-combine">{g.combine}</span>}
        <span className={`bt-insp-verdict ${g.passed ? "pass" : "fail"}`}>
          {g.terms.length === 0 ? "no rules" : g.passed ? "TRUE" : "FALSE"}
        </span>
      </div>
      {g.terms.map((t, i) => (
        <div key={i} className="bt-insp-term">
          <span className={`bt-insp-dot ${t.passed ? "pass" : "fail"}`} />
          <span className="bt-insp-expr">
            {termLabel(t.left, t.leftTf)} <span className="bt-insp-num">{fmtVal(t.lval)}</span>{" "}
            <span className="bt-insp-op">{opSymbol(t.op)}</span> {termLabel(t.right, t.rightTf)}{" "}
            <span className="bt-insp-num">{fmtVal(t.rval)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function GatePill({ label, ok }: { label: string; ok: boolean | null }) {
  if (ok == null) return null;
  return (
    <span className={`bt-insp-gate ${ok ? "pass" : "fail"}`}>
      {label} {ok ? "✓" : "✗"}
    </span>
  );
}

export default function BacktestInspectorPanel() {
  const selected = useSyncExternalStore(
    (cb) => inspectSelectedBarSignal.subscribe(cb),
    () => inspectSelectedBarSignal.value,
  );
  // Re-render when the trace map changes (a new run) even if the bar is unchanged.
  useSyncExternalStore(
    (cb) => inspectTraceSignal.subscribe(cb),
    () => inspectTraceSignal.value,
  );

  if (selected == null) {
    return <div className="bt-insp-empty">Click a bar to inspect its rules.</div>;
  }
  const trace = traceAt(selected);
  if (!trace) {
    return <div className="bt-insp-empty">This bar is outside the backtest range.</div>;
  }

  const chip =
    trace.action === "opened"
      ? { cls: "opened", text: "opened" }
      : trace.action === "suppressed"
        ? { cls: "supp", text: "suppressed" }
        : { cls: "none", text: "no signal" };

  return (
    <div className="bt-insp">
      <div className="bt-insp-time">{new Date(trace.time * 1000).toLocaleString()}</div>
      {orderGroups(trace).map((g) => (
        <GroupCard key={g.group} g={g} />
      ))}
      <div className="bt-insp-outcome">
        <span className={`bt-insp-chip ${chip.cls}`}>{chip.text}</span>
        {trace.reason && <span className="bt-insp-reason">{trace.reason}</span>}
      </div>
      <div className="bt-insp-gates">
        <GatePill label="window" ok={trace.windowActive} />
        <GatePill label="flat" ok={!(trace.inPositionLong || trace.inPositionShort)} />
        <GatePill label="warmed" ok={trace.warmedUp} />
        <GatePill label="spacing" ok={trace.spacingOk} />
      </div>
    </div>
  );
}
