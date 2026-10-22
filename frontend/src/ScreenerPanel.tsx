// Screener: judge one rule expression on the last closed bar of every symbol
// in a list, docked like the trade list. Saved screens live server-side
// (lib/screens.ts); the draft and last completed result live in memory per
// broker (lib/screenerDraft.ts), so they survive the panel unmounting.
import { useEffect, useMemo, useRef, useState } from "react";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import RuleExpressionInput from "./components/RuleExpressionInput";
import { RadarIcon } from "./lib/menuIcons";
import SymbolSearchModal from "./SymbolSearchModal";
import { fetchFavorites } from "./lib/feed/instruments";
import { isImpersonating } from "./lib/impersonation";
import { toast } from "./lib/notify";
import { requestConfirm } from "./lib/signals";
import { getScreenerDraft, setScreenerDraft, type ScreenerRanSpec, type ScreenerSource } from "./lib/screenerDraft";
import {
  ScreenSpecError,
  cancelScreen,
  deleteScreen,
  listScreens,
  pollScreen,
  saveScreen,
  startScreen,
  type Screen,
  type ScreenColumn,
  type ScreenResult,
} from "./lib/screens";
import type { ChartController } from "./lib/chartController";
import { useExprInstances } from "./backtestSettings/useExprPick";
import { liveExprInstances } from "./lib/indicators";
import { useIndicatorPick } from "./lib/useIndicatorPick";
import {
  editorInstances,
  paneLabels,
  refreshFromChart,
  screenPayload,
  type PaneCopy,
} from "./lib/screenerIndicators";

const RESOLUTIONS: { value: string; label: string }[] = [
  { value: "MINUTE_15", label: "15m" },
  { value: "MINUTE_30", label: "30m" },
  { value: "HOUR", label: "1H" },
  { value: "HOUR_4", label: "4H" },
  { value: "DAY", label: "1D" },
  { value: "WEEK", label: "1W" },
];

const POLL_MS = 500;
const MAX_COL_NAME = 40;

// Fire-and-forget cancel: a failed cancel has nothing to report to the user.
const cancelQuietly = (jobId: string) => {
  cancelScreen(jobId).catch(() => {});
};

/** Column names must be 1 to 40 chars after trim and unique, or the server's
 *  result dict would collide (or 422 with an unreadable list). */
function columnNameError(columns: ScreenColumn[]): string | null {
  const seen = new Set<string>();
  for (let i = 0; i < columns.length; i++) {
    const n = columns[i].name.trim();
    if (!n) return `Column ${i + 1}: give it a name.`;
    if (n.length > MAX_COL_NAME) return `Column ${i + 1}: names are at most ${MAX_COL_NAME} characters.`;
    if (seen.has(n)) return `Column ${i + 1}: another column is already named "${n}".`;
    seen.add(n);
  }
  return null;
}

function parseSymbols(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

function fmt(v: number | null | undefined): string {
  if (v == null) return "n/a";
  return Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toFixed(2)).toString();
}

/** One open chart tab as a symbol source: its cells' epics, in cell order. */
export interface ScreenerTab { id: string; epics: string[] }

const SOURCES: { value: ScreenerSource; label: string; tip: string[] }[] = [
  { value: "list", label: "List", tip: ["Type or pick the symbols"] },
  { value: "allTabs", label: "All tabs", tip: ["Every open chart tab", "Tabs opened later are included"] },
  { value: "tabs", label: "Some tabs", tip: ["Only the tabs you tick"] },
];

interface Props {
  brokerId: string;
  tabs: ScreenerTab[];
  controller: ChartController | null;
  priceSide: string;
  onOpen: (epic: string, resolution: string) => void;
  onClose: () => void;
}

type SortKey = { col: string; desc: boolean };

// Keyed by broker: switching broker remounts the form onto that broker's own
// draft (empty if none), so a screen loaded under one broker can never be
// saved back under another.
export default function ScreenerPanel(props: Props) {
  return <ScreenerForm key={props.brokerId} {...props} />;
}

function ScreenerForm({ brokerId, tabs, controller, priceSide, onOpen, onClose }: Props) {
  // Read once on mount: the in-memory draft for this broker (lib/screenerDraft).
  const [initial] = useState(() => getScreenerDraft(brokerId));
  const [saved, setSaved] = useState<Screen[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(initial.currentId);
  const [name, setName] = useState(initial.name);
  const [resolution, setResolution] = useState(initial.resolution);
  const [symbolsText, setSymbolsText] = useState(initial.symbolsText);
  const [source, setSource] = useState<ScreenerSource>(initial.source);
  const [tabIds, setTabIds] = useState<string[]>(initial.tabIds);
  const [expression, setExpression] = useState(initial.expression);
  const [columns, setColumns] = useState<ScreenColumn[]>(initial.columns);
  // ?? {} covers drafts held in memory from before this change, e.g. across a
  // hot reload during development.
  const [indicators, setIndicators] = useState<PaneCopy>(initial.indicators ?? {});
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ScreenResult | null>(initial.result);
  const [showSkipped, setShowSkipped] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sort, setSort] = useState<SortKey>({ col: "epic", desc: false });
  // True from the Run click until startScreen's POST resolves (or fails):
  // disables Run so a second click during the POST can't fire a second job
  // (the server 409s it, and that catch used to null out the FIRST job's
  // jobRef/progress, orphaning it uncancelled).
  const [starting, setStarting] = useState(false);
  const jobRef = useRef<string | null>(null);
  // The run spec actually submitted to the server, snapshotted at Run time.
  // Headers/cells/row-click navigation read from THIS, not the live form
  // state, so renaming/reordering a column or changing the timeframe after a
  // run can't relabel already-returned data or send a click to a timeframe
  // that was never screened.
  const [ranSpec, setRanSpec] = useState<ScreenerRanSpec | null>(initial.ranSpec);
  // Run-generation counter. run() captures the value at its own start; load(),
  // cancel() and the unmount cleanup each bump it. After every await inside
  // run() (startScreen, each pollScreen), a mismatch means this call has been
  // superseded — by a newer run, a loaded screen, an explicit cancel, or an
  // unmount — so it cancels whatever job it holds and returns without
  // touching state that may now belong to something else. A plain counter
  // (rather than a "disposed" boolean) also survives React StrictMode's
  // mount→cleanup→remount cycle for free: a boolean set true in the cleanup
  // and never reset on remount would wedge every future run, but a counter
  // that only ever increases has nothing to get stuck in.
  const genRef = useRef(0);
  const readOnly = isImpersonating();

  // Tab sources resolve against the tabs open right now, so "All tabs" picks
  // up a tab opened after it was chosen, and a closed picked tab just drops.
  const symbols = useMemo(() => {
    if (source === "list") return parseSymbols(symbolsText);
    const from = source === "allTabs" ? tabs : tabs.filter((t) => tabIds.includes(t.id));
    return [...new Set(from.flatMap((t) => t.epics))];
  }, [source, symbolsText, tabs, tabIds]);
  // Names go out trimmed: the server keys each match's values by them.
  const sentColumns = useMemo(() => columns.map((c) => ({ ...c, name: c.name.trim() })), [columns]);
  const draft = { broker: brokerId, resolution, symbols, expression, columns: sentColumns };

  // The editor's completion/lint list: the copy's own panes first, then
  // whatever the focused chart offers that the copy doesn't already hold.
  const chartEditor = useExprInstances(controller);
  const instances = useMemo(() => editorInstances(indicators, chartEditor), [indicators, chartEditor]);
  // The focused chart's live panes, read fresh (not memoized) so Run/Save/
  // Refresh always see the chart as it is right now rather than a stale copy.
  const chartLive = () => (controller?.chart ? liveExprInstances(controller.chart) : []);
  // The panes this screen's expressions actually reference, as the request's
  // `indicators` map: the copy's settings for ids it already holds, the
  // chart's settings for ids it newly picks up.
  const capture = () => screenPayload(indicators, chartLive(), [expression, ...columns.map((c) => c.expression)]);

  // Mirror the draft and the last completed result into the per-broker store.
  // A run in flight is not kept: the unmount cleanup cancels it.
  useEffect(() => {
    setScreenerDraft(brokerId, { currentId, name, resolution, symbolsText, source, tabIds, expression, columns, indicators, result, ranSpec });
  }, [brokerId, currentId, name, resolution, symbolsText, source, tabIds, expression, columns, indicators, result, ranSpec]);

  useEffect(() => {
    listScreens()
      .then((all) => setSaved(all.filter((s) => s.broker === brokerId)))
      .catch(() => setSaved([]));
  }, [brokerId]);

  // Stop polling if the panel unmounts mid-run; the server job is cancelled too.
  useEffect(() => () => {
    genRef.current++;
    if (jobRef.current) cancelQuietly(jobRef.current);
    jobRef.current = null;
  }, []);

  const load = (s: Screen | null) => {
    // A newly loaded screen must not have an old run's result land under it
    // once this cancel's response (or a still-running poll) arrives late.
    genRef.current++;
    if (jobRef.current) cancelQuietly(jobRef.current);
    jobRef.current = null;
    setStarting(false);
    setProgress(null);
    setCurrentId(s?.id ?? null);
    setName(s?.name ?? "");
    setResolution(s?.resolution ?? "DAY");
    setSymbolsText(s ? s.symbols.join(", ") : "");
    setSource("list");
    setExpression(s?.expression ?? "");
    setColumns(s?.columns ?? []);
    setIndicators(s?.indicators ?? {});
    setResult(null);
    setError(null);
    setRanSpec(null);
    pick?.disarm(); // a stale armed column index must not survive loading a screen
  };

  const explain = (e: unknown) => {
    if (e instanceof ScreenSpecError) {
      const where = e.detail.field === "columns" ? `Column ${e.detail.index + 1}: ` : "";
      setError(where + e.detail.message);
    } else {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async () => {
    if (starting || jobRef.current) return; // already starting or running
    const colErr = columnNameError(columns);
    if (colErr) {
      setError(colErr);
      return;
    }
    const gen = ++genRef.current;
    setStarting(true);
    setError(null);
    setResult(null);
    const spec = { columns: sentColumns, resolution };
    const inds = capture();
    // Sent on every attempt, but only ADOPTED into the copy once the server
    // has accepted it: a 422 (a divergence output turned off, a pinned-pane
    // refusal) must not freeze the bad settings into the copy, or fixing the
    // chart and re-running would keep sending the same stale settings.
    // The server job this call started, once known. If a poll throws, the
    // catch cancels it, or the server would 409 every Run until it ended.
    let heldJob: string | null = null;
    try {
      const { jobId, total } = await startScreen({ ...draft, indicators: inds }, priceSide);
      if (genRef.current !== gen) {
        // Superseded (load/cancel/unmount) while the POST was in flight:
        // jobRef was never set, so nothing else could have cancelled this
        // job server-side yet. Leave all other state untouched.
        cancelQuietly(jobId);
        return;
      }
      setIndicators(inds);
      heldJob = jobId;
      jobRef.current = jobId;
      setRanSpec(spec);
      setStarting(false);
      setProgress({ done: 0, total });
      for (;;) {
        const st = await pollScreen(jobId);
        if (genRef.current !== gen) {
          // Whoever superseded this call already cancelled jobRef's job
          // directly (cancel()/load()/unmount all do); this is belt-and-
          // braces in case this call's own jobId somehow wasn't it.
          cancelQuietly(jobId);
          return;
        }
        setProgress({ done: st.done, total: st.total });
        if (st.status !== "running") {
          heldJob = null;
          jobRef.current = null;
          setProgress(null);
          if (st.status === "done") setResult(st.result);
          else if (st.status === "error") setError(st.error ?? "Screen failed");
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      if (genRef.current !== gen) return; // superseded; nothing left to update
      if (heldJob) cancelQuietly(heldJob);
      setStarting(false);
      jobRef.current = null;
      setProgress(null);
      explain(e);
    }
  };

  const cancel = () => {
    genRef.current++;
    const id = jobRef.current;
    jobRef.current = null;
    setProgress(null);
    if (id) cancelQuietly(id);
  };

  const save = async () => {
    const colErr = columnNameError(columns);
    if (colErr) {
      setError(colErr);
      return;
    }
    try {
      const inds = capture();
      // Adopt the copy only once the server has accepted it, same reasoning
      // as run(): a rejected save must not freeze bad settings into the copy.
      const row = await saveScreen(name.trim() || "Untitled screen", { ...draft, indicators: inds }, currentId ?? undefined);
      setIndicators(inds);
      setSaved((all) => [...all.filter((s) => s.id !== row.id), row]);
      setCurrentId(row.id);
      setName(row.name);
      toast("Screen saved");
    } catch (e) {
      explain(e);
    }
  };

  const remove = () => {
    const id = currentId;
    if (!id) return;
    const label = saved.find((s) => s.id === id)?.name || name.trim() || "this screen";
    requestConfirm({
      title: "Delete screen",
      message: `Delete "${label}"? This cannot be undone.`,
      onConfirm: () => {
        void (async () => {
          try {
            await deleteScreen(id);
            setSaved((all) => all.filter((s) => s.id !== id));
            load(null);
          } catch (e) {
            explain(e);
          }
        })();
      },
    });
  };

  const addFavorites = async () => {
    try {
      const favs = await fetchFavorites(brokerId);
      if (favs.length === 0) {
        toast("This broker has no favorites");
        return;
      }
      setSymbolsText(parseSymbols([symbolsText, ...favs.map((f) => f.epic)].join(",")).join(", "));
    } catch (e) {
      explain(e);
    }
  };

  // "Pick from chart" (◎): arm either the Condition or one column, click an
  // on-chart indicator, and its expression token lands in that field.
  type PickTarget = { kind: "condition" } | { kind: "column"; index: number };
  const pick = useIndicatorPick<PickTarget>(controller, (t, token) => {
    if (t.kind === "condition") setExpression((e) => e + token);
    else setColumns((cs) => cs.map((x, j) => (j === t.index ? { ...x, expression: x.expression + token } : x)));
  });
  const pickToggle = (target: PickTarget, isArmed: boolean) =>
    pick && (
      <Tooltip content={isArmed ? "Click an indicator on the chart, or click here to cancel" : "Pick an indicator from the chart"}>
        <button
          type="button"
          className={`bt-rule-toggle bt-pick-toggle${isArmed ? " on" : ""}`}
          onClick={() => (isArmed ? pick.disarm() : pick.arm(target))}
          aria-label="Pick an indicator from the chart"
          aria-pressed={isArmed}
        >
          ◎
        </button>
      </Tooltip>
    );

  // The columns shown in the result table come from the snapshot taken at
  // Run time (ranSpec), NOT the live `columns` state: renaming, adding or
  // removing a column after a run must not relabel or hide data that run
  // already returned under its original names.
  const colNames = useMemo(() => (ranSpec ?? { columns: [] }).columns.map((c) => c.name), [ranSpec]);
  const rows = useMemo(() => {
    const ms = [...(result?.matches ?? [])];
    ms.sort((a, b) => {
      const av = sort.col === "epic" ? a.epic : a.columns[sort.col] ?? -Infinity;
      const bv = sort.col === "epic" ? b.epic : b.columns[sort.col] ?? -Infinity;
      const c = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.desc ? -c : c;
    });
    return ms;
  }, [result, sort]);
  const toggleSort = (col: string) =>
    setSort((s) => (s.col === col ? { col, desc: !s.desc } : { col, desc: col !== "epic" }));

  const running = progress !== null;
  const canRun = !running && !starting && !readOnly && symbols.length > 0 && expression.trim() !== "";

  return (
    <aside className="screener-panel" aria-label="Screener">
      <div className="sc-head">
        <span className="sc-mark"><RadarIcon size={15} /></span>
        <span className="sc-title">Screener</span>
        <InfoTip title="Screener" text={[
          "Checks a condition on each symbol's last closed bar.",
          "Example: RSI(14) < 30 and candle.close > EMA(200)",
          "Recent fires: count(crossAbove(candle.close, EMA(50)), 5) >= 1",
        ]} />
        <Tooltip content="Close">
          <button className="modal-close" aria-label="Close screener" onClick={onClose}>×</button>
        </Tooltip>
      </div>

      {readOnly && <p className="sc-note">Read-only while viewing as another user.</p>}

      <div className="sc-form">
        <section className="sc-section">
          <div className="sc-label">
            <span className="sc-label-name">Screen<InfoTip title="Screen" text={[
              "Load a saved screen or start a new one.",
              "The name is used when you save.",
            ]} /></span>
          </div>
        <div className="sc-row sc-screen-row">
          <select
            aria-label="Saved screens"
            value={currentId ?? ""}
            onChange={(e) => load(saved.find((s) => s.id === e.target.value) ?? null)}
          >
            <option value="">New screen</option>
            {saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input aria-label="Screen name" placeholder="Name this screen" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        </section>

        <section className="sc-section">
          <div className="sc-label">
            <span className="sc-label-name">Symbols<InfoTip title="Symbols" text={[
              "List: symbols you type or pick.",
              "All tabs: every open chart, new tabs too.",
              "Some tabs: only the tabs you tick.",
              "Up to 500 symbols.",
            ]} />{symbols.length > 0 && <span className="sc-count">{symbols.length}</span>}</span>
            <div className="seg sc-source" role="radiogroup" aria-label="Symbol source">
              {SOURCES.map((o) => (
                <Tooltip key={o.value} content={o.tip}>
                  <button
                    role="radio"
                    aria-checked={source === o.value}
                    className={source === o.value ? "seg-on" : undefined}
                    onClick={() => setSource(o.value)}
                  >
                    {o.label}
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
          {source === "list" && (
            <>
              <textarea
                aria-label="Symbols"
                className="sc-symbols"
                placeholder="AAPL, MSFT, EURUSD"
                value={symbolsText}
                onChange={(e) => setSymbolsText(e.target.value)}
              />
              <div className="sc-sub-actions">
                <button className="sc-link" onClick={() => setPicking(true)}>Add symbol</button>
                <button className="sc-link" onClick={addFavorites}>Add favorites</button>
              </div>
            </>
          )}
          {source === "allTabs" && (
            tabs.length === 0
              ? <p className="sc-hint">No chart tabs are open.</p>
              : (
                <p className="sc-tab-summary">
                  {symbols.join(", ")}
                  <span className="sc-hint"> Tabs you open later are included.</span>
                </p>
              )
          )}
          {source === "tabs" && (
            tabs.length === 0
              ? <p className="sc-hint">No chart tabs are open.</p>
              : (
                <ul className="sc-tab-list">
                  {tabs.map((t, i) => (
                    <li key={t.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={tabIds.includes(t.id)}
                          onChange={(e) => setTabIds((ids) =>
                            e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id))}
                        />
                        <span className="sc-tab-n">Tab {i + 1}</span>
                        <span className="sc-tab-epics">{t.epics.join(", ") || "no symbols"}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )
          )}
        </section>

        <section className="sc-section">
          <div className="sc-label">
            <span className="sc-label-name">Condition<InfoTip title="Condition" text={[
              "Rule checked on each symbol's last closed bar.",
              "Matches are symbols where it is true.",
              "The timeframe sets which bars are used.",
              "Pivot-based outputs see up to 2000 bars, so they can differ from the chart.",
              "Pick a chart indicator with ◎ to use its settings.",
            ]} /></span>
            {pickToggle({ kind: "condition" }, pick?.armed?.kind === "condition")}
            <label className="sc-tf">
              <span>on</span>
              <select aria-label="Timeframe" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                {RESOLUTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <span>bars</span>
            </label>
          </div>
          <RuleExpressionInput
            value={expression}
            onChange={setExpression}
            isExit={false}
            placeholder="RSI(14) < 30 and candle.close > EMA(200)"
            instances={instances}
          />
          {Object.keys(indicators).length > 0 && (
            <div className="sc-inds">
              <span className="sc-label-name">Indicators<InfoTip title="Indicators" text={[
                "Settings copied from the chart on run or save.",
                "The copy is kept with the screen.",
                "Refresh from chart to pick up changes.",
              ]} /></span>
              <span className="sc-inds-list">{paneLabels(indicators).map((l) => <span key={l}>{l}</span>)}</span>
              {controller && (
                <button className="sc-link" onClick={() => setIndicators((c) => refreshFromChart(c, chartLive()))}>
                  Refresh from chart
                </button>
              )}
            </div>
          )}
        </section>

        <section className="sc-section">
          <div className="sc-label">
            <span className="sc-label-name">Columns<InfoTip title="Columns" text={[
              "Extra values shown for each match.",
              "Any value expression, like RSI(14).",
              "Click a header to sort. Up to 8.",
            ]} /></span>
            {columns.length < 8 && (
              <span className="sc-label-actions">
                <button className="sc-link" onClick={() => setColumns((cs) => [...cs, { name: `Col ${cs.length + 1}`, expression: "RSI(14)" }])}>
                  Add column
                </button>
              </span>
            )}
          </div>
          {columns.map((c, i) => (
            <div className="sc-row" key={i}>
              <input
                aria-label={`Column ${i + 1} name`}
                className="sc-col-name"
                value={c.name}
                onChange={(e) => setColumns((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                aria-label={`Column ${i + 1} expression`}
                className="sc-col-expr"
                value={c.expression}
                onChange={(e) => setColumns((cs) => cs.map((x, j) => (j === i ? { ...x, expression: e.target.value } : x)))}
              />
              {pickToggle({ kind: "column", index: i }, pick?.armed?.kind === "column" && pick.armed.index === i)}
              <Tooltip content="Remove column">
                <button
                  className="sc-icon-btn"
                  aria-label={`Remove column ${i + 1}`}
                  onClick={() => {
                    pick?.disarm();
                    setColumns((cs) => cs.filter((_, j) => j !== i));
                  }}
                >×</button>
              </Tooltip>
            </div>
          ))}
        </section>

        {error && <p className="sc-error" role="alert">{error}</p>}
        <div className="sc-row sc-actions">
          {currentId && <button className="sc-btn sc-delete" disabled={readOnly} onClick={remove}>Delete</button>}
          <button className="sc-btn" disabled={readOnly || !expression.trim()} onClick={save}>Save</button>
          {running ? (
            <button className="sc-btn" onClick={cancel}>Cancel</button>
          ) : (
            <button className="sc-btn sc-run" disabled={!canRun} onClick={run}>Run</button>
          )}
        </div>
        {progress && (
          <div className="sc-progress" aria-live="polite">
            <div className="sc-progress-bar">
              <span style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }} />
            </div>
            <span>{progress.done} / {progress.total}</span>
          </div>
        )}
      </div>

      {!result && !running && (
        <p className="sc-empty">Matching symbols show here after a run. Click one to open its chart.</p>
      )}

      {result && (
        <div className="sc-results">
          <div className="sc-summary">
            <span>{result.stats.matched} of {result.stats.symbols} match</span>
            {result.skipped.length > 0 && (
              <button className="sc-skipped-toggle" onClick={() => setShowSkipped((v) => !v)}>
                {result.skipped.length} skipped
              </button>
            )}
          </div>
          {showSkipped && (
            <ul className="sc-skipped">
              {result.skipped.map((s) => <li key={s.epic}>{s.epic}: {s.reason}</li>)}
            </ul>
          )}
          <table className="sc-table">
            <thead>
              <tr>
                <th onClick={() => toggleSort("epic")}>Symbol</th>
                {colNames.map((n) => <th key={n} onClick={() => toggleSort(n)}>{n}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.epic} onClick={() => onOpen(m.epic, ranSpec?.resolution ?? resolution)}>
                  <td>{m.epic}</td>
                  {colNames.map((n) => <td key={n}>{fmt(m.columns[n])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picking && (
        <SymbolSearchModal
          current={null}
          brokerId={brokerId}
          onPick={(s) => {
            setSymbolsText(parseSymbols(`${symbolsText},${s.epic}`).join(", "));
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </aside>
  );
}
