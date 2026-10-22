// Screener: judge one rule expression on the last closed bar of every symbol
// in a list, docked like the trade list. Saved screens live server-side
// (lib/screens.ts); the last run's result lives here only.
import { useEffect, useMemo, useRef, useState } from "react";
import InfoTip from "./components/InfoTip";
import Tooltip from "./components/Tooltip";
import RuleExpressionInput from "./components/RuleExpressionInput";
import SymbolSearchModal from "./SymbolSearchModal";
import { fetchFavorites } from "./lib/feed/instruments";
import { isImpersonating } from "./lib/impersonation";
import { toast } from "./lib/notify";
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

const RESOLUTIONS: { value: string; label: string }[] = [
  { value: "MINUTE_15", label: "15m" },
  { value: "MINUTE_30", label: "30m" },
  { value: "HOUR", label: "1H" },
  { value: "HOUR_4", label: "4H" },
  { value: "DAY", label: "1D" },
  { value: "WEEK", label: "1W" },
];

const POLL_MS = 500;

function parseSymbols(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

function fmt(v: number | null | undefined): string {
  if (v == null) return "n/a";
  return Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toFixed(2)).toString();
}

interface Props {
  brokerId: string;
  priceSide: string;
  onOpen: (epic: string, resolution: string) => void;
  onClose: () => void;
}

type SortKey = { col: string; desc: boolean };

export default function ScreenerPanel({ brokerId, priceSide, onOpen, onClose }: Props) {
  const [saved, setSaved] = useState<Screen[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [resolution, setResolution] = useState("DAY");
  const [symbolsText, setSymbolsText] = useState("");
  const [expression, setExpression] = useState("");
  const [columns, setColumns] = useState<ScreenColumn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sort, setSort] = useState<SortKey>({ col: "epic", desc: false });
  const jobRef = useRef<string | null>(null);
  const readOnly = isImpersonating();

  const symbols = useMemo(() => parseSymbols(symbolsText), [symbolsText]);
  const draft = { broker: brokerId, resolution, symbols, expression, columns };

  useEffect(() => {
    listScreens()
      .then((all) => setSaved(all.filter((s) => s.broker === brokerId)))
      .catch(() => setSaved([]));
  }, [brokerId]);

  // Stop polling if the panel unmounts mid-run; the server job is cancelled too.
  useEffect(() => () => {
    if (jobRef.current) void cancelScreen(jobRef.current);
    jobRef.current = null;
  }, []);

  const load = (s: Screen | null) => {
    setCurrentId(s?.id ?? null);
    setName(s?.name ?? "");
    setResolution(s?.resolution ?? "DAY");
    setSymbolsText(s ? s.symbols.join(", ") : "");
    setExpression(s?.expression ?? "");
    setColumns(s?.columns ?? []);
    setResult(null);
    setError(null);
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
    setError(null);
    setResult(null);
    try {
      const { jobId, total } = await startScreen(draft, priceSide);
      jobRef.current = jobId;
      setProgress({ done: 0, total });
      for (;;) {
        const st = await pollScreen(jobId);
        if (jobRef.current !== jobId) return; // cancelled or unmounted
        setProgress({ done: st.done, total: st.total });
        if (st.status !== "running") {
          jobRef.current = null;
          setProgress(null);
          if (st.status === "done") setResult(st.result);
          else if (st.status === "error") setError(st.error ?? "Screen failed");
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      jobRef.current = null;
      setProgress(null);
      explain(e);
    }
  };

  const cancel = () => {
    const id = jobRef.current;
    jobRef.current = null;
    setProgress(null);
    if (id) void cancelScreen(id);
  };

  const save = async () => {
    try {
      const row = await saveScreen(name.trim() || "Untitled screen", draft, currentId ?? undefined);
      setSaved((all) => [...all.filter((s) => s.id !== row.id), row]);
      setCurrentId(row.id);
      setName(row.name);
      toast("Screen saved");
    } catch (e) {
      explain(e);
    }
  };

  const remove = async () => {
    if (!currentId) return;
    try {
      await deleteScreen(currentId);
      setSaved((all) => all.filter((s) => s.id !== currentId));
      load(null);
    } catch (e) {
      explain(e);
    }
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

  // The columns shown in the result table: the configured names (in their
  // configured order) plus any key the server actually returned that isn't
  // one of them (defensive: a stale/edited column list shouldn't hide data
  // the run already paid for).
  const colNames = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const c of columns) if (!seen.has(c.name)) { seen.add(c.name); names.push(c.name); }
    for (const m of result?.matches ?? [])
      for (const k of Object.keys(m.columns)) if (!seen.has(k)) { seen.add(k); names.push(k); }
    return names;
  }, [columns, result]);
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
  const canRun = !running && !readOnly && symbols.length > 0 && expression.trim() !== "";

  return (
    <aside className="screener-panel" aria-label="Screener">
      <div className="sc-head">
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
        <div className="sc-row">
          <select
            aria-label="Saved screens"
            value={currentId ?? ""}
            onChange={(e) => load(saved.find((s) => s.id === e.target.value) ?? null)}
          >
            <option value="">New screen</option>
            {saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input aria-label="Screen name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="sc-row">
          <select aria-label="Timeframe" value={resolution} onChange={(e) => setResolution(e.target.value)}>
            {RESOLUTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <button onClick={() => setPicking(true)}>Add symbol</button>
          <button onClick={addFavorites}>Add favorites</button>
        </div>
        <textarea
          aria-label="Symbols"
          className="sc-symbols"
          placeholder="Symbols, separated by commas"
          value={symbolsText}
          onChange={(e) => setSymbolsText(e.target.value)}
        />
        <RuleExpressionInput
          value={expression}
          onChange={setExpression}
          isExit={false}
          placeholder="RSI(14) < 30 and candle.close > EMA(200)"
        />
        {columns.map((c, i) => (
          <div className="sc-row" key={i}>
            <input
              aria-label={`Column ${i + 1} name`}
              value={c.name}
              onChange={(e) => setColumns((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <input
              aria-label={`Column ${i + 1} expression`}
              className="sc-col-expr"
              value={c.expression}
              onChange={(e) => setColumns((cs) => cs.map((x, j) => (j === i ? { ...x, expression: e.target.value } : x)))}
            />
            <Tooltip content="Remove column">
              <button aria-label={`Remove column ${i + 1}`} onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))}>×</button>
            </Tooltip>
          </div>
        ))}
        {columns.length < 8 && (
          <button className="sc-add-col" onClick={() => setColumns((cs) => [...cs, { name: `Col ${cs.length + 1}`, expression: "RSI(14)" }])}>
            Add column
          </button>
        )}
        {error && <p className="sc-error" role="alert">{error}</p>}
        <div className="sc-row sc-actions">
          {running ? (
            <>
              <span className="sc-progress">{progress.done} / {progress.total}</span>
              <button onClick={cancel}>Cancel</button>
            </>
          ) : (
            <button className="sc-run" disabled={!canRun} onClick={run}>Run</button>
          )}
          <button disabled={readOnly || !expression.trim()} onClick={save}>Save</button>
          {currentId && <button disabled={readOnly} onClick={remove}>Delete</button>}
        </div>
      </div>

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
                <tr key={m.epic} onClick={() => onOpen(m.epic, resolution)}>
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
