// Ranked pattern-search results for one chart cell. Presentational: all state
// lives in usePatternSearch, all geometry in lib/patternSearch.
import { useEffect, useMemo, useState } from "react";
import CloseButton from "./CloseButton";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import { SortHeader } from "./PositionsPanel";
import {
  DEFAULT_MATCH_SORT,
  formatForwardPct,
  nextMatchSort,
  previewGeometry,
  sortMatches,
  type MatchSort,
  type MatchSortKey,
  type PatternMatch,
  type PatternMode,
  type PatternSearchResult,
} from "./lib/patternSearch";

// A few round numbers rather than a free field: the horizon is a "what happened
// next" question, not a parameter to tune. 0 is left out on purpose, since an
// empty aftermath reports as a complete outcome that says nothing.
const HORIZONS = [5, 10, 20, 50, 100];

interface Props {
  result: PatternSearchResult | null;
  loading: boolean;
  error: string | null;
  epic: string;
  resolution: string;
  broker: string;
  priceSide: string;
  timezone: string;
  /** Bars searched when the drag covered more than the query cap, else null.
   *  The band on the chart still spans the whole drag, so this is the only
   *  disclosure that the search used less than it shows. */
  truncatedTo?: number | null;
  /** The whole match, not just its two ends: the caller also paints the forward
   *  window the row previews, which it reads off match.forward. */
  onJump: (match: PatternMatch) => void;
  onDismiss: () => void;
  /** What the distance is measured over. Changing it re-runs the last range. */
  mode: PatternMode;
  onModeChange: (mode: PatternMode) => void;
  /** Bars of aftermath measured after each match. Also re-runs on change. */
  forwardBars: number;
  onForwardBarsChange: (bars: number) => void;
}

function stamp(ts: number, timezone: string): string {
  return new Date(ts * 1000).toLocaleString("en-GB", {
    timeZone: timezone || "UTC",
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function day(ts: number, timezone: string): string {
  return new Date(ts * 1000).toLocaleDateString("en-GB", {
    timeZone: timezone || "UTC", year: "numeric", month: "short", day: "2-digit",
  });
}

/** No aftermath is not a gain. `(pct ?? 0) < 0` would paint a null outcome in
 *  the positive colour, which reads as "this one went up" for a match we have
 *  no data after. */
function pctClass(pct: number | null): string {
  if (pct == null) return " pm-none";
  return pct < 0 ? " neg" : "";
}

function Preview({ match }: { match: PatternMatch }) {
  const { candles, dividerX } = previewGeometry(match);
  return (
    <svg className="pm-preview" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line x1={dividerX} x2={dividerX} y1={0} y2={100} className="pm-divider" />
      {candles.map((c, i) => (
        <g key={i} className={(c.up ? "pm-up" : "pm-down") + (c.forward ? " pm-fwd" : "")}>
          <line x1={c.x} x2={c.x} y1={c.wickTop} y2={c.wickTop + c.wickH} />
          <rect x={c.x - c.w / 2} y={c.bodyTop} width={c.w} height={c.bodyH} />
        </g>
      ))}
    </svg>
  );
}

export default function PatternMatchesPanel(props: Props) {
  const { result, loading, error, epic, resolution, broker, priceSide, timezone, onDismiss } = props;

  // Close button and Esc only, deliberately. Dismissing also clears the band on
  // the chart, so a click-away would destroy the ranked list the moment the user
  // clicked a match and panned to read the context around it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // onDismiss, not props: `props` is a fresh object every render, so depending
    // on it re-subscribes the listener on every parent repaint.
  }, [onDismiss]);

  // Only the order is state here. The rank a row shows comes from where the
  // backend put it, so sorting by outcome still reports similarity.
  const [sort, setSort] = useState<MatchSort>(DEFAULT_MATCH_SORT);
  const rows = useMemo(
    () => (result ? sortMatches(result.matches, sort) : []),
    [result, sort],
  );
  const onSort = (key: MatchSortKey) => setSort((s) => nextMatchSort(s, key));

  const worst = result?.matches.length
    ? result.matches[result.matches.length - 1].distance
    : null;

  return (
    <div className="pattern-matches">
      <div className="pm-head">
        <span className="pm-title">Similarity search</span>
        <InfoTip
          title="Similarity search"
          text={[
            "Windows of the same length whose candles are shaped like your selection, ranked by distance (0 is identical).",
            "Price level and volatility are normalized away, so the same shape matches at any size.",
          ]}
        />
        <CloseButton onClick={props.onDismiss} />
      </div>

      <div className="pm-controls">
        {/* Spelled-out aria labels, not the visible word: "Close" alone reads
            identically to the panel's own close button. */}
        <div className="seg pm-seg" role="group" aria-label="Metric">
          {([["ohlc", "Candles", "Match whole candles"],
             ["close", "Close", "Match closing prices only"],
             ["dtw", "DTW", "Match with time warping"]] as const).map(
            ([m, label, described]) => (
              <button
                key={m}
                type="button"
                className={props.mode === m ? "seg-on" : ""}
                aria-label={described}
                aria-pressed={props.mode === m}
                onClick={() => props.onModeChange(m)}
              >
                {label}
              </button>
            ),
          )}
        </div>
        <InfoTip
          title="Metric"
          text={[
            "Candles matches body, wick and colour, so the shape of each bar counts.",
            "Close matches only the path of closing prices, ignoring the wicks.",
            "DTW lets time flex, so a pattern that ran fast early and slow late still matches.",
          ]}
        />
        <label className="pm-horizon">
          Next
          <select
            value={props.forwardBars}
            aria-label="Bars of aftermath measured"
            onChange={(e) => props.onForwardBarsChange(Number(e.target.value))}
          >
            {HORIZONS.map((n) => (
              <option key={n} value={n}>
                {n} bars
              </option>
            ))}
          </select>
        </label>
        <InfoTip
          title="Aftermath"
          text="Bars measured after each match, which sets the outcome shown on the right of every row."
        />
      </div>

      {result && (
        <div className="pm-sub">
          <span>
            {epic} {resolution} on {broker} ({priceSide})
          </span>
          <span>
            {day(result.series.oldestTs, timezone)} to {day(result.series.newestTs, timezone)},{" "}
            {result.series.bars.toLocaleString("en-GB")} bars
          </span>
          {/* Not the same number as the bar count: windows that are flat or
              gapped are dropped before ranking, so this is how much history was
              genuinely compared. */}
          <span>{result.scanned.toLocaleString("en-GB")} windows ranked</span>
          <span>
            {result.elapsedMs} ms{result.cold ? " (first search)" : ""}
            {worst != null ? `, worst shown ${worst.toFixed(2)}` : ""}
          </span>
          {props.truncatedTo != null && (
            <span className="pm-trunc">
              Matched on the last {props.truncatedTo} candles of your selection.
            </span>
          )}
        </div>
      )}

      {loading && <div className="pm-msg">Searching. The first search on a symbol is slower.</div>}
      {error && !loading && <div className="pm-msg pm-err">{error}</div>}
      {result && !loading && !error && result.matches.length === 0 && (
        <div className="pm-msg">No similar sequence found in the scanned history.</div>
      )}

      {result && !loading && result.matches.length > 0 && (
        <>
        <div className="pm-cols">
          <span className="pm-rank" />
          <SortHeader label="When" col="when" sort={sort} onSort={onSort} />
          {/* The InfoTip sits beside the sort button, never inside it: nesting
              it would put a second control in the button and swallow the
              heading's accessible name. */}
          <span className="pm-dist-h">
            <SortHeader label="Dist" col="dist" sort={sort} onSort={onSort} />
            <InfoTip
              title="Distance"
              text={
                props.mode === "dtw"
                  ? [
                      "0 is an identical shape after the best time warp; near 2 is an inversion.",
                      "Price level, size and uneven tempo are all forgiven, only the shape counts.",
                    ]
                  : [
                      "0 is an identical shape, 2 is an exact inversion.",
                      "Price level and size are ignored, so the same shape matches at any scale.",
                    ]
              }
            />
          </span>
          <span>Shape</span>
          {/* Names the horizon rather than saying "outcome": the number is
              meaningless without knowing how many bars it covers, and this
              tracks the Next control so it can never disagree with it. */}
          <span className="pm-pct-h">
            <SortHeader
              label={`Next ${props.forwardBars}`}
              col="outcome"
              sort={sort}
              onSort={onSort}
            />
            <InfoTip
              title={`Next ${props.forwardBars} bars`}
              text={[
                `Price change over the ${props.forwardBars} bars after the window ended.`,
                "On your own selection that is what actually followed it.",
              ]}
            />
          </span>
        </div>
        <ol className="pm-list">
          {rows.map(({ match: m, rank }) => {
            // No reachability pre-check any more: the jump covers the gap in
            // concurrent windows (see goToRange), so a match from 2018 on 15m
            // lands in a couple of seconds. If a match really does predate the
            // broker's series, the jump itself says so once it knows.
            // Keyed on the similarity rank, not the view position, so a
            // re-sort moves rows instead of remounting them.
            return (
            <li key={rank}>
              <button
                type="button"
                className="pm-row"
                aria-label={`Go to ${stamp(m.ts, timezone)}`}
                onClick={() => props.onJump(m)}
              >
                {/* The similarity rank, NOT the row's position after sorting:
                    a "7" while sorted by outcome is the finding, since it says
                    the best analogue was only the 7th most similar. */}
                <span className="pm-rank">{rank}</span>
                {/* The marker sits INSIDE the date cell: .pm-row is a fixed
                    five-column grid, and a sixth child would add a column and
                    shift every other row's alignment. */}
                <span className="pm-when">
                  {stamp(m.ts, timezone)}
                  {/* Scales make lengths differ per row, so each row says how
                      many bars its window covers. */}
                  <span className="pm-len">{m.bars.length} bars</span>
                  {m.isSelection && (
                    <Tooltip content="The window you dragged. It is ranked like every other window, so seeing it here at a distance near 0 is the check that the matching works.">
                      <span className="pm-self-flag">your selection</span>
                    </Tooltip>
                  )}
                </span>
                <span className="pm-dist">{m.distance.toFixed(2)}</span>
                <Preview match={m} />
                <span className={"pm-pct" + pctClass(m.forwardPct)}>
                  {formatForwardPct(m.forwardPct)}
                  {!m.forwardComplete && m.forwardPct != null && (
                    <em className="pm-partial"> (partial)</em>
                  )}
                </span>
              </button>
            </li>
            );
          })}
        </ol>
        </>
      )}
    </div>
  );
}
