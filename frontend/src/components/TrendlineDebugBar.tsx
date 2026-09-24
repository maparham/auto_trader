// The debug strip, bottom-left of the chart: reason counts (a click cycles a
// group sampled, all, hidden; a hidden group is struck through), the "Check a
// line" arm and, with a target set, its near matches and similarity limits.
// Text only.
import InfoTip from "./InfoTip";

export interface StripMatch {
  key: string;
  /** Max deviation from the target, ATR(14). */
  dev: number;
  /** Fraction of the target's span the candidate covers. */
  cover: number;
  /** The candidate's primary reason, as the chart tags it. */
  reason: string;
}

interface Props {
  counts: Array<{ group: string; n: number; shown?: number }>;
  pivots: number;
  hidden: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  overflow: number;
  /** Which point the armed lookup waits for, or null when not armed. */
  armed: "first" | "second" | null;
  message: string | null;
  onToggle: (group: string, n: number) => void;
  onArm: () => void;
  onClearTarget: (() => void) | null;
  /** Undo the last debug Apply, shown here once the popup is closed. */
  onUndo?: (() => void) | null;
  /** Near matches of the target (at most 5 shown), nearest first. */
  matches?: StripMatch[];
  onPickMatch?: (key: string, rect: DOMRect) => void;
  /** Similarity limits, shown while a target is set. */
  sim?: { priceAtr: number; spanPct: number } | null;
  onSim?: (sim: { priceAtr: number; spanPct: number }) => void;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Group names that are plural nouns, and their one-line form. */
const SINGULAR: Record<string, string> = {
  anchors: "anchor", touches: "touch", crossings: "crossing", pivots: "pivot",
};

/** "112 touches (10 shown)" while sampled, "112 touches" once expanded,
 * "1 touch" for one. */
export function groupLabel(g: { group: string; n: number; shown?: number }, expanded: boolean): string {
  const sampled = !expanded && g.shown !== undefined && g.shown < g.n;
  const name = g.n === 1 ? SINGULAR[g.group] ?? g.group : g.group;
  return `${g.n} ${name}${sampled ? ` (${g.shown} shown)` : ""}`;
}

export default function TrendlineDebugBar(p: Props) {
  const items = [...p.counts, ...(p.pivots ? [{ group: "pivots", n: p.pivots }] : [])];
  const num = (v: string, fallback: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : fallback;
  };
  // Your line's row sits ABOVE the reason row: the strip hangs from the
  // chart's foot, so the reason row and its Check a line never move when a
  // line is checked or cleared.
  const hasTarget = !!(p.onClearTarget || p.matches?.length || p.sim);
  const message = p.message ? <span className="tl-dbg-msg">{p.message}</span> : null;
  return (
    <div className="tl-dbg-bar">
      {hasTarget ? (
        <div className="tl-dbg-row">
          <span className="tl-dbg-title">Your line</span>
          {message}
          {p.matches?.slice(0, 5).map((m) => (
            <button
              key={m.key}
              className="tl-dbg-match"
              onClick={(e) => p.onPickMatch?.(m.key, e.currentTarget.getBoundingClientRect())}
            >
              {`${fmt(Number(m.dev.toFixed(1)))} ATR, ${Math.round(m.cover * 100)}%: ${m.reason}`}
            </button>
          ))}
          {p.sim && p.onSim ? (
            <span className="tl-dbg-sim">
              Near within
              <input
                type="number" min={0.1} step={0.1} aria-label="Price limit, ATR"
                value={p.sim.priceAtr}
                onChange={(e) => p.onSim!({ ...p.sim!, priceAtr: num(e.target.value, p.sim!.priceAtr) })}
              />
              ATR, covering
              <input
                type="number" min={1} max={100} step={5} aria-label="Span cover, percent"
                value={Math.round(p.sim.spanPct * 100)}
                onChange={(e) =>
                  p.onSim!({ ...p.sim!, spanPct: Math.min(1, num(e.target.value, p.sim!.spanPct * 100) / 100) })}
              />
              %
              <InfoTip text={["A match stays within this many ATR of your line.", "And spans at least this much of it."]} />
            </span>
          ) : null}
          {p.onClearTarget ? <button onClick={p.onClearTarget}>Clear line</button> : null}
        </div>
      ) : null}
      <div className="tl-dbg-row">
        <span className="tl-dbg-title">Debug</span>
        {items.map((g) =>
          // Drawn lines are the chart's own: the debug layer never paints
          // them, so there is nothing for a toggle to hide.
          g.group === "drawn" ? (
            <span key={g.group} className="tl-dbg-label">{g.n} drawn</span>
          ) : (
            <button
              key={g.group}
              className={p.hidden.has(g.group) ? "is-hidden" : ""}
              aria-pressed={!p.hidden.has(g.group)}
              onClick={() => p.onToggle(g.group, g.group === "pivots" ? 0 : g.n)}
            >
              {groupLabel(g, p.expanded.has(g.group))}
            </button>
          ),
        )}
        <InfoTip
          text={[
            "Big groups show the 10 nearest the price.",
            "Click a group: all, then hidden, then back.",
          ]}
        />
        {p.overflow ? <span>{p.overflow} not shown</span> : null}
        <button className={p.armed ? "is-armed" : ""} onClick={p.onArm}>
          {p.armed === "first" ? "Click the 1st point" : p.armed === "second" ? "Click the 2nd point" : "Check a line"}
        </button>
        <InfoTip text={["Select a trend line drawing, then Check a line.", "Or click two points on the chart.", "Esc cancels."]} />
        {p.onUndo ? <button onClick={p.onUndo}>Undo</button> : null}
        {hasTarget ? null : message}
      </div>
    </div>
  );
}
