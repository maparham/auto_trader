// Ranked pattern-search results for one chart cell. Presentational: all state
// lives in usePatternSearch, all geometry in lib/patternSearch.
import { useEffect, useMemo, useState } from "react";
import CloseButton from "./CloseButton";
import { CopyPatternIcon } from "./lib/menuIcons";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import { SortHeader } from "./PositionsPanel";
import {
  avgDistance,
  DEFAULT_MATCH_SORT,
  formatForwardPct,
  nextMatchSort,
  previewGeometry,
  sortMatches,
  summarizeMatches,
  outcomeVerdict,
  type MatchSort,
  type MatchSortKey,
  type PatternMatch,
  type PatternMode,
  type PatternSearchResult,
  type SourceOutcome,
} from "./lib/patternSearch";
import type { PatternScope } from "./lib/patternPanelStore";

// The distance columns of the "all" tab, in display order: the four formulas
// plus their plain average. The short labels fit 46px columns; the
// aria-labels carry the full names. `value` reads a row's cell, so the Avg
// column (derived, not sent by the backend) needs no special casing below.
const ALL_COLS: readonly (readonly [
  MatchSortKey,
  string,
  string,
  (m: PatternMatch) => number | null,
])[] = [
  ["shape", "Shape", "Shape distance", (m) => m.distances?.shape ?? null],
  ["ohlc", "Cndl", "Candles distance", (m) => m.distances?.ohlc ?? null],
  ["close", "Close", "Close distance", (m) => m.distances?.close ?? null],
  ["dtw", "DTW", "DTW distance", (m) => m.distances?.dtw ?? null],
  ["avg", "Avg", "Average of the four distances", avgDistance],
] as const;

// A few round numbers rather than a free field: the horizon is a "what happened
// next" question, not a parameter to tune. 0 is left out on purpose, since an
// empty aftermath reports as a complete outcome that says nothing.
const HORIZONS = [5, 10, 20, 50, 100];

interface Props {
  /** `sources` rides along on a layout-wide search (one entry per open chart
   *  searched); absent or single on results parked before the feature. */
  result: (PatternSearchResult & { sources?: SourceOutcome[] }) | null;
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
  /** Copy this match onto the pattern clipboard, so it can be pasted as a
   *  ghost overlay without first jumping there and dragging over it. */
  onCopy: (match: PatternMatch) => void;
  onDismiss: () => void;
  /** What the distance is measured over. Changing it re-runs the last range. */
  mode: PatternMode;
  onModeChange: (mode: PatternMode) => void;
  /** Bars of aftermath measured after each match. Also re-runs on change. */
  forwardBars: number;
  onForwardBarsChange: (bars: number) => void;
  /** Whether the search covers this chart alone or every open chart in the
   *  layout. Changing it re-runs the last range, like the metric. */
  scope: PatternScope;
  onScopeChange: (scope: PatternScope) => void;
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

// Smaller than this and the five-column rows stop being readable.
const MIN_W = 340;
// The chart keeps at least this much width however far the splitter is dragged.
const MIN_CHART_W = 260;

export default function PatternMatchesPanel(props: Props) {
  const { result, loading, error, epic, resolution, broker, priceSide, timezone, onDismiss } = props;

  // User-dragged sidebar width, null until the splitter is used: the CSS
  // defaults (400px / 606px in All mode) stay in charge until then. The panel
  // docks as a full-height column on the cell's right, so width is the only
  // dimension to negotiate — dragging the left-edge splitter out takes space
  // from the chart, which reflows to what remains.
  const [width, setWidth] = useState<number | null>(null);
  const startResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.parentElement!.getBoundingClientRect();
    const sx = e.clientX;
    const onMove = (me: MouseEvent) => {
      setWidth(
        Math.min(
          Math.max(MIN_W, rect.width + (sx - me.clientX)),
          window.innerWidth - MIN_CHART_W,
        ),
      );
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // The close button only, deliberately: no click-away, no Esc. Dismissing
  // destroys the ranked list (and its parked copy), so it must be an explicit
  // act — a stray Esc meant for a tool or a click to pan around a match must
  // not cost the user their results.

  // Only the order is state here. The rank a row shows comes from where the
  // backend put it, so sorting by outcome still reports similarity.
  const [sort, setSort] = useState<MatchSort>(DEFAULT_MATCH_SORT);
  // A mode change redraws the columns, and a sort keyed to a column the new
  // mode does not show would silently order the list by an invisible number.
  useEffect(() => setSort(DEFAULT_MATCH_SORT), [props.mode]);
  // The row whose jump the chart is showing, keyed by the match's start ts so
  // a re-sort moves the highlight with its row. It stays until another row is
  // picked: the user pans around the landed match, and the panel should keep
  // saying which row the chart context belongs to. A new result list clears
  // it — the old pick describes matches that are no longer shown.
  const [jumpedTs, setJumpedTs] = useState<number | null>(null);
  useEffect(() => setJumpedTs(null), [result]);
  const rows = useMemo(
    () => (result ? sortMatches(result.matches, sort) : []),
    [result, sort],
  );
  const onSort = (key: MatchSortKey) => setSort((s) => nextMatchSort(s, key));

  const all = props.mode === "all";
  const stats = useMemo(() => (result ? summarizeMatches(result.matches) : null), [result]);
  const verdict = useMemo(() => (result ? outcomeVerdict(result.matches) : null), [result]);

  // Rows carry a chart tag only when the result actually spans charts: on a
  // one-chart layout (or cell scope) the tag would repeat the footer on every
  // row and say nothing.
  const multiSource = (result?.sources?.length ?? 0) > 1;
  // The per-series footnote lines, folded by default: one line per open chart
  // reads as a wall under the results on a big workspace.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const failedSources = result?.sources?.filter((s) => s.error).length ?? 0;

  // In "all" mode `distance` is a mean rank, not a distance, so there is no
  // "worst shown" figure to report.
  const worst = !all && result?.matches.length
    ? result.matches[result.matches.length - 1].distance
    : null;

  return (
    <div
      className={"pattern-matches" + (all ? " pm-wide" : "")}
      style={width != null ? { width } : undefined}
    >
      {/* The width splitter along the docked panel's left edge. Drag-only
          affordance; sighted-pointer feature like the transport drag, so it
          is hidden from the accessibility tree. */}
      <div className="pm-resize" aria-hidden="true" onMouseDown={startResize} />
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
          {([["shape", "Shape", "Match the overall price shape"],
             ["ohlc", "Candles", "Match whole candles"],
             ["close", "Close", "Match closing prices only"],
             ["dtw", "DTW", "Match with time warping"],
             ["all", "All", "Combine every metric into one ranking"]] as const).map(
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
            "All runs every metric, merges overlapping finds into one row each, and orders by their combined rank.",
          ]}
        />
        <div className="seg pm-seg" role="group" aria-label="Search scope">
          {([["cell", "This chart", "Search only this chart"],
             ["all", "All charts", "Search every chart in every open tab"]] as const).map(
            ([s, label, described]) => (
              <button
                key={s}
                type="button"
                className={props.scope === s ? "seg-on" : ""}
                aria-label={described}
                aria-pressed={props.scope === s}
                onClick={() => props.onScopeChange(s)}
              >
                {label}
              </button>
            ),
          )}
        </div>
        <InfoTip
          title="Search scope"
          text={[
            "All charts also scans every other chart in every open tab, ranking the finds in one list.",
            "Shapes are scale-normalized, so distances compare across symbols and timeframes.",
            "Clicking a row from a chart on another tab switches to that tab and jumps there.",
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

      {result && !loading && !error && stats && (
        <div className="pm-stats">
          {verdict && (
            <span className={`pm-verdict pm-verdict-${verdict.kind}`}>
              {verdict.kind === "up" && "lean: up"}
              {verdict.kind === "down" && "lean: down"}
              {verdict.kind === "mixed" && "mixed — no edge"}
              {verdict.kind === "small" && "sample too small"}
            </span>
          )}
          <span>
            <b>{stats.count}</b> matches
          </span>
          {stats.withOutcome > 0 && (
            <span>
              <b>
                {stats.up}/{stats.withOutcome}
              </b>{" "}
              up ({Math.round((100 * stats.up) / stats.withOutcome)}%)
            </span>
          )}
          {stats.medianPct != null && (
            <span>
              median <b>{formatForwardPct(stats.medianPct)}</b>
            </span>
          )}
          {stats.worstPct != null && stats.bestPct != null && (
            <span>
              range <b>{formatForwardPct(stats.worstPct)}</b> to{" "}
              <b>{formatForwardPct(stats.bestPct)}</b>
            </span>
          )}
          {stats.medianDist != null && (
            <span>
              median dist <b>{stats.medianDist.toFixed(2)}</b>
            </span>
          )}
          <span>
            <b>
              {stats.minLen === stats.maxLen
                ? stats.minLen
                : `${stats.minLen}–${stats.maxLen}`}
            </b>{" "}
            bars
          </span>
          <span>
            {day(stats.oldestTs, timezone)} to {day(stats.newestTs, timezone)}
          </span>
          <InfoTip
            title="Match statistics"
            text={[
              "Computed over the matches shown, excluding your own selection row: its distance of 0 and known aftermath would flatter every number.",
              `Outcome figures cover only rows with aftermath; "up" counts moves of 0% or more over the next ${props.forwardBars} bars.`,
              "The verdict chip calls a lean only when three things hold: at least 8 decisive outcomes, an up/down split a fair coin would rarely produce, and a closest half of the matches whose median moves the same way. Anything less reads as mixed.",
              "It is an indication, not proof: matches from one instrument overlap in market regime and are not independent samples.",
            ]}
          />
        </div>
      )}

      {loading && <div className="pm-msg">Searching. The first search on a symbol is slower.</div>}
      {error && !loading && <div className="pm-msg pm-err">{error}</div>}
      {result && !loading && !error && result.matches.length === 0 && (
        <div className="pm-msg">No similar sequence found in the scanned history.</div>
      )}

      {result && !loading && result.matches.length > 0 && (
        <>
        <div className={"pm-cols" + (all ? " pm-all" : "")}>
          <span className="pm-rank" />
          <SortHeader label="When" col="when" sort={sort} onSort={onSort} />
          {/* The InfoTip sits beside the sort button, never inside it: nesting
              it would put a second control in the button and swallow the
              heading's accessible name. */}
          {all ? (
            ALL_COLS.map(([key, label, described]) => (
              <span key={key} className="pm-dist-h">
                <SortHeader label={label} col={key} sort={sort} onSort={onSort} title={described} />
              </span>
            ))
          ) : (
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
                    : props.mode === "shape"
                      ? [
                          "0 is an identical trajectory, 2 is an exact inversion.",
                          "The overall shape counts most; bar-by-bar detail only breaks ties.",
                        ]
                      : [
                          "0 is an identical shape, 2 is an exact inversion.",
                          "Price level and size are ignored, so the same shape matches at any scale.",
                        ]
                }
              />
            </span>
          )}
          {/* "Preview" when a formula column is already named Shape. */}
          <span>{all ? "Preview" : "Shape"}</span>
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
            <li key={rank} className="pm-row-wrap">
              {/* A SIBLING of the row, not a child: the row is itself a button,
                  and a button inside a button is invalid (and unreachable by
                  keyboard). Shown on the row's hover/focus via CSS. */}
              <Tooltip content="Copy as pattern. Paste it anywhere with the pattern tool.">
                <button
                  type="button"
                  className="pm-copy"
                  aria-label={`Copy pattern from ${stamp(m.ts, timezone)}`}
                  onClick={() => props.onCopy(m)}
                >
                  <CopyPatternIcon />
                </button>
              </Tooltip>
              <button
                type="button"
                className={"pm-row" + (all ? " pm-all" : "") + (m.ts === jumpedTs ? " pm-row-sel" : "")}
                aria-label={`Go to ${stamp(m.ts, timezone)}`}
                aria-current={m.ts === jumpedTs || undefined}
                onClick={() => {
                  setJumpedTs(m.ts);
                  props.onJump(m);
                }}
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
                  {multiSource && m.source && (
                    <span className="pm-src">
                      {m.source.epic} · {m.source.label}
                    </span>
                  )}
                  {m.isSelection && (
                    <Tooltip content="The window you dragged. It is ranked like every other window, so seeing it here at a distance near 0 is the check that the matching works.">
                      <span className="pm-self-flag">your selection</span>
                    </Tooltip>
                  )}
                </span>
                {all ? (
                  // One cell per column. A null is a formula that could not
                  // score this window (flat under its transform).
                  ALL_COLS.map(([key, , , value]) => (
                    <span key={key} className="pm-dist">
                      {value(m)?.toFixed(2) ?? "–"}
                    </span>
                  ))
                ) : (
                  <span className="pm-dist">{m.distance.toFixed(2)}</span>
                )}
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

      {/* Series facts and timings read as a footnote, so they sit BELOW the
          results: the ranked rows are what a search was run for. */}
      {result && (
        <div className="pm-sub">
          {multiSource ? (
            <>
              {/* The per-series lines number one per open chart — on a big
                  workspace they would dwarf the results, so they fold away and
                  start folded. A failed series still surfaces on the summary
                  line: hiding it entirely would let a chart silently
                  contribute nothing. */}
              <button
                type="button"
                className="pm-sub-toggle"
                aria-expanded={sourcesOpen}
                onClick={() => setSourcesOpen((o) => !o)}
              >
                <span className={"pm-sub-chev" + (sourcesOpen ? " open" : "")} aria-hidden="true">
                  ▸
                </span>
                {result.sources!.length} charts on {broker} ({priceSide})
                {!sourcesOpen && failedSources > 0 && (
                  <span className="pm-src-err">
                    {" "}· {failedSources} failed
                  </span>
                )}
              </button>
              {/* One line per searched series: each chart's history depth
                  differs, and a failed series must say so here rather than
                  silently contribute nothing. */}
              {sourcesOpen &&
                result.sources!.map((s) => (
                  <span key={`${s.epic}|${s.resolution}`} className={s.error ? "pm-src-err" : ""}>
                    {s.epic} {s.label}:{" "}
                    {s.error
                      ? s.error
                      : `${s.series!.bars.toLocaleString("en-GB")} bars, ` +
                        `${s.scanned!.toLocaleString("en-GB")} windows ranked`}
                  </span>
                ))}
            </>
          ) : (
            <>
              <span>
                {epic} {resolution} on {broker} ({priceSide})
              </span>
              <span>
                {day(result.series.oldestTs, timezone)} to {day(result.series.newestTs, timezone)},{" "}
                {result.series.bars.toLocaleString("en-GB")} bars
              </span>
              {/* Not the same number as the bar count: windows that are flat or
                  gapped are dropped before ranking, so this is how much history
                  was genuinely compared. */}
              <span>{result.scanned.toLocaleString("en-GB")} windows ranked</span>
            </>
          )}
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
    </div>
  );
}
