// Imported trade lists, docked as a workspace sidebar (a flex sibling of
// .chart-cells, same slot as the pattern panel). Every import is saved
// permanently as a NAMED list (file name minus extension, or the sheet's
// label): the panel opens on the library of saved imports, a library row opens
// its trade table, and a table row jumps to the trade's chart with the trade
// sketched as a trade box. Lists rename in place and delete via the shared
// confirm. Workspace-level state — lists span symbols across tabs — persisted
// through the persist helpers (localStorage + backend mirror).
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import CloseButton from "./CloseButton";
import Tooltip from "./components/Tooltip";
import { SortHeader } from "./PositionsPanel";
import { fetchAllMarkets, searchInstruments, type Instrument } from "./lib/feed";
import { requestConfirm } from "./lib/signals";
import {
  addTradeList,
  finalizeCsvImport,
  prepareCsvImport,
  validateMapping,
  TRADE_FIELD_LABELS,
  loadAutoTf,
  loadSameTab,
  saveAutoTf,
  saveSameTab,
  deleteTradeList,
  listTradeLists,
  nameFromFilename,
  parseTradeList,
  renameTradeList,
  applyExclusions,
  type PendingCsvImport,
  type DegenerateReason,
  type SavedTradeList,
  type TradeField,
  type TradeRow,
} from "./lib/tradeList";

interface Props {
  /** Jump to the trade's chart and sketch its box (App owns the navigation). */
  onSelect: (t: TradeRow) => void;
  onClose: () => void;
  /** Active broker, for the review stage's symbol check (epics are broker-
   *  specific). Omitted (tests): the feed layer's default broker. */
  brokerId?: string;
  /** Render nothing — state intact — while a replay session runs (rows carry
   *  the real dates a masked session exists to conceal). Same contract as the
   *  pattern panel's hidden prop; unmounting instead would discard an
   *  in-progress import. */
  hidden?: boolean;
}

/** An import parked between parse and save. CSV needs its column mapping
 *  confirmed first; JSON keys are exact, so it carries only the raw text (kept
 *  as text so a timezone change in the review re-parses it). */
type Pending =
  | { kind: "csv"; csv: PendingCsvImport; name?: string }
  | { kind: "json"; text: string; name?: string };

/** Checkbox wording per flag reason, singular and plural — a group of one is
 *  common enough (one typo'd date in a whole sheet) to be worth reading right. */
const DEGENERATE_LABELS: Record<DegenerateReason, readonly [string, string]> = {
  unparseable: ["unparseable row", "unparseable rows"],
  reversed: ["row exiting before it enters", "rows exiting before they enter"],
  nonPositivePrice: ["row with a non-positive price", "rows with a non-positive price"],
  duplicate: ["duplicate row", "duplicate rows"],
};

const degenerateLabel = (reason: DegenerateReason, count: number) =>
  `${count} ${DEGENERATE_LABELS[reason][count === 1 ? 0 : 1]}`;

// Zones offered for naive import timestamps. UTC first (the default), then the
// major market centres; stamps that encode their own zone ignore this anyway.
const IMPORT_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tehran",
  "Asia/Tokyo",
  "Asia/Hong_Kong",
  "Australia/Sydney",
] as const;

type SortKey =
  | "symbol" | "side" | "entryTs" | "exitTs" | "qty" | "ddPct" | "pctPL" | "dollarPL";
type Sort = { key: SortKey | "none"; dir: "asc" | "desc" };

const dateFmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Timed trades show their full stamp in the list's import timezone — the
 *  sheet's own wall-clock — while date-only trades stay a bare date. */
function stampFmt(ms: number, hasTime: boolean | undefined, tz?: string): string {
  if (!hasTime) return dateFmt(ms);
  const d = new Date(ms);
  const timeZone = tz ?? "UTC";
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return `${date} ${time}`;
}

function money(v: number): string {
  const abs = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-" : ""}$${abs}`;
}

const totalPL = (l: SavedTradeList) => l.trades.reduce((s, t) => s + (t.dollarPL ?? 0), 0);

/** Whether the sheet reports money at all. Sheets carrying only a percent
 *  column (most closed-trades sheets) sum to a $0.00 that reads as "broke
 *  even" rather than "not reported", so those show a dash instead. */
const hasDollars = (l: SavedTradeList) => l.trades.some((t) => t.dollarPL != null);

/** The list's money total, or "—" when the sheet never reported any. */
const totalPLText = (l: SavedTradeList) => (hasDollars(l) ? money(totalPL(l)) : "—");

const MIN_W = 300;
const MIN_CHART_W = 400;

export default function TradeListPanel({ onSelect, onClose, brokerId, hidden }: Props) {
  // Width splitter along the left edge, same as the pattern panel's — the
  // six-column table (full timestamps included) outgrows the default 400px.
  const [width, setWidth] = useState<number | null>(null);
  const startResize = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.parentElement!.getBoundingClientRect();
    const sx = e.clientX;
    const onMove = (me: globalThis.MouseEvent) => {
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

  const [lists, setLists] = useState<SavedTradeList[]>(() => listTradeLists());
  const [openId, setOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>({ key: "none", dir: "desc" });
  const [filter, setFilter] = useState("");
  const [autoTf, setAutoTf] = useState(() => loadAutoTf());
  const [sameTab, setSameTab] = useState(() => loadSameTab());
  // Index (in the list's ORIGINAL trade order, so sorting can't detach it) of
  // the last-clicked row; highlighted until the next click.
  const [selected, setSelected] = useState<number | null>(null);
  const [importTz, setImportTz] = useState<string>("UTC");
  // Every import parks here between parse and save. A CSV additionally carries
  // the guessed column mapping for correction; JSON keys are exact, so it
  // arrives already parsed and only the symbol/flagged checks apply.
  const [pending, setPending] = useState<Pending | null>(null);
  const [mapping, setMapping] = useState<Array<TradeField | null>>([]);
  // Flagged reasons the user chose to KEEP. Everything flagged is excluded by
  // default, so this stays empty unless a box is unticked.
  const [keep, setKeep] = useState<ReadonlySet<DegenerateReason>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => setLists(listTradeLists());

  const saveImport = (parsed: ReturnType<typeof parseTradeList>, name?: string) => {
    const entry = addTradeList(parsed, name);
    refresh();
    setFilter("");
    setSelected(null);
    setOpenId(entry.id); // land straight in the fresh import's table
    setPasteText("");
    setError(null);
    setSort({ key: "none", dir: "desc" });
  };

  const importText = (text: string, name?: string) => {
    try {
      const t = text.trim();
      setKeep(new Set());
      if (t.startsWith("{") || t.startsWith("[")) {
        // JSON keys are exact field names — no mapping to review, but the
        // symbol check and the degenerate-row filter still apply.
        parseTradeList(t, { timezone: importTz }); // validate now, re-parse per timezone below
        setPending({ kind: "json", text: t, name });
        setMapping([]);
      } else {
        const csv = prepareCsvImport(t);
        setPending({ kind: "csv", csv, name });
        setMapping(csv.guesses);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Only a CSV has columns to map; JSON keys are already exact field names.
  const mapProblem = pending?.kind === "csv" ? validateMapping(mapping) : null;

  // Symbol check: the sheet's symbols vs the broker catalogue. Unmatched ones
  // get a remap input (suggestions from instrument search); the result rides
  // the saved list as symbolMap and is applied when a row jumps to its chart.
  const [markets, setMarkets] = useState<Instrument[] | null>(null);
  const [symbolFix, setSymbolFix] = useState<Record<string, string>>({});
  const [suggest, setSuggest] = useState<Record<string, Instrument[]>>({});

  const catalog = useMemo(
    () => (markets ? new Set(markets.map((i) => i.epic.toUpperCase())) : null),
    [markets],
  );
  // The list the review stage is deciding about, re-derived whenever the
  // mapping or timezone changes. Null while a CSV mapping is still invalid —
  // rows can't be classified through columns that aren't assigned yet.
  const reviewParsed = useMemo(() => {
    if (!pending) return null;
    try {
      return pending.kind === "json"
        ? parseTradeList(pending.text, { timezone: importTz })
        : validateMapping(mapping)
          ? null
          : finalizeCsvImport(pending.csv, mapping, { timezone: importTz });
    } catch {
      return null; // a mapping that parses to nothing usable; mapProblem explains
    }
  }, [pending, mapping, importTz]);

  const syms = useMemo(() => {
    const out: string[] = [];
    for (const t of reviewParsed?.trades ?? []) {
      if (!out.includes(t.symbol)) out.push(t.symbol);
    }
    return out;
  }, [reviewParsed]);
  const unmatched = catalog ? syms.filter((sym) => !catalog.has(sym)) : [];

  const flagged = useMemo(() => reviewParsed?.flagged ?? [], [reviewParsed]);
  const excludedReasons = useMemo(
    () => new Set(flagged.map((g) => g.reason).filter((r) => !keep.has(r))),
    [flagged, keep],
  );
  const finalList = reviewParsed && applyExclusions(reviewParsed, excludedReasons);
  const importCount = finalList?.trades.length ?? 0;

  useEffect(() => {
    let dead = false;
    void fetchAllMarkets(brokerId).then((list) => {
      if (!dead) setMarkets(list);
    });
    return () => {
      dead = true;
    };
  }, [brokerId]);

  /** Datalist for one unmatched symbol: while the input is empty, the search
   *  hits for the sheet's own string; once the user types, a live filter of
   *  the broker catalogue by epic or name. */
  const symbolOptions = (sym: string): Instrument[] => {
    const q = (symbolFix[sym] ?? "").trim().toUpperCase();
    if (!q) return suggest[sym] ?? [];
    return (markets ?? [])
      .filter(
        (i) => i.epic.toUpperCase().includes(q) || i.name.toUpperCase().includes(q),
      )
      .slice(0, 8);
  };

  const unmatchedKey = unmatched.join(",");
  useEffect(() => {
    let dead = false;
    for (const sym of unmatchedKey ? unmatchedKey.split(",") : []) {
      if (suggest[sym]) continue;
      void searchInstruments(sym, brokerId).then((found) => {
        if (!dead) setSuggest((m) => ({ ...m, [sym]: found.slice(0, 5) }));
      });
    }
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- suggest is accumulated here
  }, [unmatchedKey, brokerId]);

  const closeReview = () => {
    setPending(null);
    setKeep(new Set());
    setSymbolFix({});
    setSuggest({});
  };

  const finalizeReview = () => {
    if (!pending || !finalList) return;
    try {
      const symbolMap: Record<string, string> = {};
      for (const sym of unmatched) {
        const epic = (symbolFix[sym] ?? "").trim().toUpperCase();
        if (epic && epic !== sym) symbolMap[sym] = epic;
      }
      saveImport(
        Object.keys(symbolMap).length > 0 ? { ...finalList, symbolMap } : finalList,
        pending.name,
      );
      closeReview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const importFile = (f: File | undefined) => {
    if (!f) return;
    void f.text().then((txt) => importText(txt, nameFromFilename(f.name)), (e) => setError(String(e)));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    importFile(e.dataTransfer?.files?.[0]);
  };

  const commitRename = () => {
    if (renamingId) {
      const name = renameText.trim();
      if (name) renameTradeList(renamingId, name);
      refresh();
    }
    setRenamingId(null);
  };
  const onRenameKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") setRenamingId(null);
  };

  const onDelete = (l: SavedTradeList) =>
    requestConfirm({
      title: "Delete trade list",
      message: `Delete "${l.name}" (${l.trades.length} trades)? This is permanent.`,
      onConfirm: () => {
        deleteTradeList(l.id);
        setOpenId((cur) => (cur === l.id ? null : cur));
        refresh();
      },
    });

  const onSort = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));

  const open = openId ? lists.find((l) => l.id === openId) ?? null : null;

  // Sheets vary: qty/drawdown columns only render when the list carries them.
  const hasQty = open != null && open.trades.some((t) => t.qty != null);
  const hasDd = open != null && open.trades.some((t) => t.ddPct != null);

  const rows = (() => {
    if (!open) return [];
    const q = filter.trim().toUpperCase();
    const matching = q
      ? open.trades.filter((t) => t.symbol.includes(q))
      : open.trades;
    if (sort.key === "none") return matching;
    const k = sort.key;
    const mul = sort.dir === "asc" ? 1 : -1;
    return [...matching].sort((a, b) => {
      const av = a[k] ?? 0;
      const bv = b[k] ?? 0;
      return (av < bv ? -1 : av > bv ? 1 : 0) * mul;
    });
  })();

  if (hidden) return null; // after every hook: state survives the blackout

  return (
    <aside
      className="trade-list-panel"
      style={width != null ? { width } : undefined}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="tl-resize" aria-hidden="true" onMouseDown={startResize} />
      <div className="tl-head">
        {open && !pending && (
          <button className="tl-back" onClick={() => setOpenId(null)}>‹ Lists</button>
        )}
        <span className="tl-title">
          {pending ? "Review import" : open ? open.name : "Trade lists"}
        </span>
        <CloseButton onClick={onClose} />
      </div>
      {pending ? (
        <div className="tl-review">
          <p className="tl-hint">
            {pending.kind === "csv"
              ? `Check how the sheet's columns map onto trade fields and correct
                 anything the guess got wrong before importing.`
              : `Check the symbols and any flagged rows before importing.`}
          </p>
          <label className="tl-tz">
            Timestamp timezone
            <select
              aria-label="Timestamp timezone"
              value={importTz}
              onChange={(e) => setImportTz(e.target.value)}
            >
              {IMPORT_TIMEZONES.map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </label>
          <div className="tl-scroll">
            {pending.kind === "csv" && (
            <table className="tl-map-table">
              <thead>
                <tr><th>Column</th><th>Sample values</th><th>Maps to</th></tr>
              </thead>
              <tbody>
                {pending.csv.headers.map((h, i) => (
                  <tr key={i} className={mapping[i] ? "" : "tl-map-ignored"}>
                    <td className="tl-map-col">{h}</td>
                    <td className="tl-map-samples">
                      {pending.csv.samples[i].map((v, j) => (
                        <span key={j}>{v}</span>
                      ))}
                    </td>
                    <td>
                      <select
                        aria-label={`Map column "${h}"`}
                        value={mapping[i] ?? ""}
                        onChange={(e) =>
                          setMapping((m) =>
                            m.map((f, k) =>
                              k === i ? ((e.target.value || null) as TradeField | null) : f,
                            ),
                          )
                        }
                      >
                        <option value="">Ignore</option>
                        {(Object.keys(TRADE_FIELD_LABELS) as TradeField[]).map((f) => (
                          <option key={f} value={f}>{TRADE_FIELD_LABELS[f]}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
            {flagged.length > 0 && (
              <div className="tl-flagged">
                <p className="tl-hint">
                  Flagged rows — ticked ones are left out of the import.
                </p>
                {flagged.map((g) => (
                  <div key={g.reason} className="tl-flag-group">
                    <label>
                      <input
                        type="checkbox"
                        aria-label={degenerateLabel(g.reason, g.labels.length)}
                        checked={!keep.has(g.reason)}
                        onChange={() =>
                          setKeep((k) => {
                            const next = new Set(k);
                            if (next.has(g.reason)) next.delete(g.reason);
                            else next.add(g.reason);
                            return next;
                          })
                        }
                      />
                      {degenerateLabel(g.reason, g.labels.length)}
                    </label>
                    <ul className="tl-flag-rows">
                      {g.labels.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {catalog && syms.length > 0 && (
              <div className="tl-symcheck">
                <p className="tl-hint">
                  {syms.length - unmatched.length} of {syms.length} symbols match a market.
                </p>
                {unmatched.map((sym) => (
                  <label key={sym} className="tl-symfix">
                    <span className="tl-symfix-name">{sym}</span>
                    <input
                      list={`tl-sym-${sym}`}
                      aria-label={`Map symbol "${sym}"`}
                      placeholder="epic… (blank = leave as-is)"
                      value={symbolFix[sym] ?? ""}
                      onChange={(e) =>
                        setSymbolFix((m) => ({ ...m, [sym]: e.target.value }))
                      }
                    />
                    <datalist id={`tl-sym-${sym}`}>
                      {symbolOptions(sym).map((i) => (
                        <option key={i.epic} value={i.epic}>{i.name}</option>
                      ))}
                    </datalist>
                  </label>
                ))}
              </div>
            )}
          </div>
          {mapProblem && <div className="tl-err">{mapProblem}</div>}
          <div className="tl-review-actions">
            <button
              className="tl-review-go"
              disabled={mapProblem != null || importCount === 0}
              onClick={() => finalizeReview()}
            >
              Import {importCount} trade{importCount === 1 ? "" : "s"}
            </button>
            <button onClick={closeReview}>Cancel</button>
          </div>
          {error && <div className="tl-err">{error}</div>}
        </div>
      ) : open ? (
        <>
          <div className="tl-summary">
            <input
              className="tl-filter"
              type="search"
              placeholder="Filter symbol…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {/* Independent on/off pills sharing one seg frame — the app's
                compact-toggle idiom (not mutually exclusive like most segs,
                hence aria-pressed rather than a radio pattern). */}
            <div className="seg tl-modes" role="group" aria-label="Chart follow modes">
              <Tooltip content="Auto timeframe: pick the coarsest interval that keeps a clicked trade's box readable — raise while the box still spans 7+ bars, lower when it would span fewer than 5">
                <button
                  className={autoTf ? "seg-on" : ""}
                  aria-pressed={autoTf}
                  onClick={() => {
                    setAutoTf(!autoTf);
                    saveAutoTf(!autoTf);
                  }}
                >
                  Auto TF
                </button>
              </Tooltip>
              <Tooltip content="Open trades for symbols that aren't already on a chart in ONE reused tab — each new symbol replaces the previous one instead of adding a tab">
                <button
                  className={sameTab ? "seg-on" : ""}
                  aria-pressed={sameTab}
                  onClick={() => {
                    setSameTab(!sameTab);
                    saveSameTab(!sameTab);
                  }}
                >
                  Same tab
                </button>
              </Tooltip>
            </div>
            <div className="tl-stats">
              {open.skipped > 0 && <span className="tl-skipped">{open.skipped} skipped</span>}
              <span className="tl-count">
                {rows.length !== open.trades.length
                  ? `${rows.length} of ${open.trades.length}`
                  : `${open.trades.length} trades`}
              </span>
              <span
                className={
                  "tl-total " +
                  (!hasDollars(open) ? "tl-none" : totalPL(open) < 0 ? "tl-loss" : "tl-win")
                }
              >
                {totalPLText(open)}
              </span>
            </div>
          </div>
          <div className="tl-scroll">
            <table className="tl-table">
              <thead>
                <tr>
                  <th><SortHeader label="Symbol" col="symbol" sort={sort} onSort={onSort} /></th>
                  <th><SortHeader label="Side" col="side" sort={sort} onSort={onSort} /></th>
                  <th><SortHeader label="Entry" col="entryTs" sort={sort} onSort={onSort}
                    title="Entry date / price" /></th>
                  <th><SortHeader label="Exit" col="exitTs" sort={sort} onSort={onSort}
                    title="Exit date / price" /></th>
                  {hasQty && (
                    <th><SortHeader label="Qty" col="qty" sort={sort} onSort={onSort} /></th>
                  )}
                  {hasDd && (
                    <th><SortHeader label="DD %" col="ddPct" sort={sort} onSort={onSort}
                      title="Worst intra-trade drawdown" /></th>
                  )}
                  <th><SortHeader label="% P/L" col="pctPL" sort={sort} onSort={onSort} /></th>
                  <th><SortHeader label="$ P/L" col="dollarPL" sort={sort} onSort={onSort} /></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t, i) => {
                  const win = (t.dollarPL ?? t.pctPL ?? 0) >= 0;
                  const idx = open.trades.indexOf(t);
                  const epic = open.symbolMap?.[t.symbol] ?? t.symbol;
                  // Catalogue still loading: assume the best (rows enable once
                  // it lands and disprove themselves then).
                  const noMarket = catalog != null && !catalog.has(epic.toUpperCase());
                  return (
                    <tr
                      key={`${t.symbol}-${t.entryTs}-${i}`}
                      className={
                        (win ? "tl-win" : "tl-loss") +
                        (idx === selected ? " tl-selected" : "") +
                        (noMarket ? " tl-dead" : "")
                      }
                      onClick={() => {
                        if (noMarket) return;
                        setSelected(idx);
                        onSelect(epic === t.symbol ? t : { ...t, symbol: epic });
                      }}
                    >
                      <td>
                        {noMarket ? (
                          <Tooltip content={`no ${t.symbol} market on the current broker — re-import and map it to an epic`}>
                            <span>{t.symbol}</span>
                          </Tooltip>
                        ) : (
                          t.symbol
                        )}
                      </td>
                      <td>{t.side === "LONG" ? "Long" : "Short"}</td>
                      <td>
                        <span className="tl-date">{stampFmt(t.entryTs, t.hasTime, open.timezone)}</span>
                        <span className="tl-price">{t.entryPrice.toLocaleString("en-US")}</span>
                      </td>
                      <td>
                        <span className="tl-date">{stampFmt(t.exitTs, t.hasTime, open.timezone)}</span>
                        <span className="tl-price">{t.exitPrice.toLocaleString("en-US")}</span>
                      </td>
                      {hasQty && <td>{t.qty != null ? t.qty.toLocaleString("en-US") : "—"}</td>}
                      {hasDd && (
                        <td className="tl-dd">{t.ddPct != null ? `${t.ddPct.toFixed(2)}%` : "—"}</td>
                      )}
                      <td>{t.pctPL != null ? `${t.pctPL.toFixed(2)}%` : "—"}</td>
                      <td>{t.dollarPL != null ? money(t.dollarPL) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="tl-library">
          {lists.map((l) => (
            <div key={l.id} className="tl-list-row">
              {renamingId === l.id ? (
                <input
                  className="tl-rename-input"
                  value={renameText}
                  autoFocus
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={onRenameKey}
                  onBlur={commitRename}
                />
              ) : (
                <button
                  className="tl-list-open"
                  onClick={() => {
                    setFilter("");
                    setSelected(null);
                    setOpenId(l.id);
                  }}
                >
                  <span className="tl-list-name">{l.name}</span>
                  <span className="tl-list-meta">
                    {l.trades.length} trades
                    <span
                      className={
                        !hasDollars(l) ? "tl-none" : totalPL(l) < 0 ? "tl-loss" : "tl-win"
                      }
                    >
                      {" "}
                      {totalPLText(l)}
                    </span>
                    {" · "}
                    {dateFmt(l.createdAt)}
                  </span>
                </button>
              )}
              <Tooltip content="Rename">
                <button
                  className="tl-icon-btn"
                  aria-label="Rename"
                  onClick={() => {
                    setRenamingId(l.id);
                    setRenameText(l.name);
                  }}
                >
                  ✎
                </button>
              </Tooltip>
              <Tooltip content="Delete">
                <button
                  className="tl-icon-btn"
                  aria-label="Delete"
                  onClick={() => onDelete(l)}
                >
                  🗑
                </button>
              </Tooltip>
            </div>
          ))}
          {lists.length === 0 && <p className="tl-hint">No saved imports yet.</p>}
          <div className="tl-import">
            <p className="tl-hint">
              Import a closed-trades sheet (JSON or CSV, auto-detected): drop a file
              here, pick one, or paste the content.
            </p>
            <label className="tl-tz">
              Timestamp timezone
              <select
                aria-label="Timestamp timezone"
                value={importTz}
                onChange={(e) => setImportTz(e.target.value)}
              >
                {IMPORT_TIMEZONES.map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
            </label>
            <button onClick={() => fileRef.current?.click()}>Choose file…</button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.csv,.txt,application/json,text/csv"
              hidden
              onChange={(e) => {
                importFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <textarea
              placeholder="…or paste JSON / CSV here"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={8}
            />
            <button disabled={!pasteText.trim()} onClick={() => importText(pasteText)}>
              Import
            </button>
            {error && <div className="tl-err">{error}</div>}
          </div>
        </div>
      )}
    </aside>
  );
}
