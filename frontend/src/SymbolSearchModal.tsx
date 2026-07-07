// TradingView-style "Symbol search" modal. Opened by clicking the editable
// symbol name in the toolbar. Replaces the old always-on inline search input.
//
// Data model: the full instrument catalogue (~4000) is fetched once and cached;
// category chips filter it client-side by instrumentType. The modal opens on the
// RECENT list (recently-opened symbols). Typing runs a live keyword search instead.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addFavorite,
  fetchAllMarkets,
  fetchFavorites,
  removeFavorite,
  searchInstruments,
  type Instrument,
} from "./lib/feed";
import CloseButton from "./CloseButton";
import SymbolIcon from "./SymbolIcon";
import { useCloseOnEscape } from "./lib/useCloseOnEscape";
import { loadRecentSymbols, pushRecentSymbol } from "./lib/persist";
import { brokerLabel } from "./lib/trading";
import { activeSymbolFragment, insertSymbol, isSyntheticExpr, parseSymbols } from "./lib/syntheticExpr";
import { registerSynthetic } from "./lib/syntheticRegistry";

interface Props {
  current: Instrument;
  // Active data broker id ("capital"). The catalogue, search and favourites are
  // all broker-specific, so every call carries it and a change reloads the modal.
  brokerId: string;
  onPick: (s: Instrument) => void;
  onClose: () => void;
}

// Category chips. "favorites"/"all" are special; the rest filter by the market's
// Capital.com instrumentType. Order/labels mirror TradingView.
const CHIPS: { key: string; label: string; type?: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "favorites", label: "Favorites" },
  { key: "all", label: "All" },
  { key: "SHARES", label: "Stocks", type: "SHARES" },
  { key: "CURRENCIES", label: "Forex", type: "CURRENCIES" },
  { key: "CRYPTOCURRENCIES", label: "Crypto", type: "CRYPTOCURRENCIES" },
  { key: "INDICES", label: "Indices", type: "INDICES" },
  { key: "COMMODITIES", label: "Commodities", type: "COMMODITIES" },
];

// Muted type phrase on each row, TradingView-style ("commodity cfd", "stock").
// All Capital.com instruments are CFDs, so the suffix matches their UI.
function typeLabel(type: string | null | undefined): string {
  switch (type) {
    case "SHARES":
      return "stock cfd";
    case "CURRENCIES":
      return "forex cfd";
    case "CRYPTOCURRENCIES":
      return "crypto cfd";
    case "INDICES":
      return "index cfd";
    case "COMMODITIES":
      return "commodity cfd";
    default:
      return type ? `${type.toLowerCase()} cfd` : "cfd";
  }
}

// TradingView-style "spread operators" revealed by the input's toggle. `token` is
// what gets inserted into the box (our combiner grammar: + - * / ( ) and reciprocal
// 1/). Power (^) isn't supported by the backend combiner, so it's intentionally absent.
const SPREAD_OPS: { label: string; token: string; name: string }[] = [
  { label: "÷", token: "/", name: "Divide" },
  { label: "×", token: "*", name: "Multiply" },
  { label: "+", token: "+", name: "Add" },
  { label: "−", token: "-", name: "Subtract" },
  { label: "(", token: "(", name: "Open paren" },
  { label: ")", token: ")", name: "Close paren" },
  { label: "1/", token: "1/", name: "Reciprocal" },
];

export default function SymbolSearchModal({ current, brokerId, onPick, onClose }: Props) {
  const [showOps, setShowOps] = useState(false);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("recent"); // opening view
  const [all, setAll] = useState<Instrument[]>([]);
  const [favorites, setFavorites] = useState<Instrument[]>([]);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [searchHits, setSearchHits] = useState<Instrument[]>([]);
  const [searching, setSearching] = useState(false);
  // Epics of recently-opened symbols, most-recent-first; resolved against `all`.
  const [recentEpics, setRecentEpics] = useState<string[]>(() =>
    loadRecentSymbols(),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against a slow earlier search landing after a newer one.
  const reqId = useRef(0);

  // Epics currently in the FAVORITES watchlist — drives the star fill on every
  // row regardless of which view it appears in. Derived from `favorites`.
  const favEpics = useMemo(
    () => new Set(favorites.map((f) => f.epic)),
    [favorites],
  );

  // Add/remove a symbol to/from favourites, optimistically. The row's own
  // onClick (which selects + closes) is suppressed by the caller's stopPropagation.
  const toggleFavorite = useCallback(
    async (s: Instrument) => {
      const was = favEpics.has(s.epic);
      // Optimistic: update the rendered list immediately, then persist.
      setFavorites((prev) =>
        was ? prev.filter((f) => f.epic !== s.epic) : [...prev, s],
      );
      try {
        if (was) await removeFavorite(s.epic, brokerId);
        else await addFavorite(s.epic, brokerId);
      } catch {
        // Roll back on failure.
        setFavorites((prev) =>
          was ? [...prev, s] : prev.filter((f) => f.epic !== s.epic),
        );
      }
    },
    [favEpics, brokerId],
  );

  useEffect(() => inputRef.current?.focus(), []);

  useCloseOnEscape(onClose);

  // Load the active broker's catalogue + favorites (both cached per broker for the
  // session). Reloads if the broker changes while the modal is open.
  useEffect(() => {
    let alive = true;
    setCatalogueLoading(true);
    void Promise.all([fetchAllMarkets(brokerId), fetchFavorites(brokerId)]).then(
      ([a, f]) => {
        if (!alive) return;
        setAll(a);
        setFavorites(f);
        setCatalogueLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [brokerId]);

  // The active search term: in formula mode (the box holds an operator) it's just
  // the symbol being typed — the text after the last operator — so autocomplete
  // targets the active symbol, not the whole expression.
  const term = (isSyntheticExpr(query) ? activeSymbolFragment(query) : query).trim();

  // Debounced keyword search (broker-side) for the active term.
  useEffect(() => {
    if (!term) {
      setSearchHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      const found = await searchInstruments(term, brokerId);
      if (id !== reqId.current) return; // a newer query superseded this one
      setSearchHits(found);
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [term, brokerId]);

  // What to show. With an active term, merge the broker keyword hits with local
  // catalogue matches by epic/name — the broker search matches display names but
  // NOT the exact epic (typing "OIL_CRUDE" misses "Crude Oil Spot"), so the local
  // match guarantees an exact/prefix epic always appears. Otherwise the active chip
  // filters the cached catalogue.
  const shown = useMemo(() => {
    if (query.trim()) {
      if (!term) return []; // formula mode, empty active symbol → the hint shows
      const t = term.toLowerCase();
      const local = all.filter(
        (m) => m.epic.toLowerCase().includes(t) || m.name.toLowerCase().includes(t),
      );
      const seen = new Set<string>();
      const out: Instrument[] = [];
      for (const m of [...searchHits, ...local]) {
        const key = m.epic.toUpperCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(m);
        }
      }
      return out;
    }
    if (cat === "favorites") return favorites;
    if (cat === "recent") {
      // Map epics → catalogue instruments, preserving MRU order; drop any epic
      // no longer in the catalogue.
      const byEpic = new Map(all.map((m) => [m.epic, m]));
      return recentEpics
        .map((e) => byEpic.get(e))
        .filter((m): m is Instrument => m !== undefined);
    }
    if (cat === "all") return all;
    return all.filter((m) => m.type === cat);
  }, [query, term, searchHits, cat, all, favorites, recentEpics]);

  const loading = term ? searching : catalogueLoading;

  // A typed arithmetic expression (e.g. OIL_CRUDE/DXY) whose symbols all exist in
  // the catalogue becomes a "Create synthetic" row above the results. null when
  // the query isn't an expression, is malformed, or names an unknown symbol.
  const syntheticCandidate = useMemo(() => {
    const q = query.trim();
    if (!q || !isSyntheticExpr(q) || all.length === 0) return null;
    let symbolList: string[];
    try {
      symbolList = parseSymbols(q);
    } catch {
      return null;
    }
    if (symbolList.length === 0) return null;
    const byEpic = new Set(all.map((m) => m.epic.toUpperCase()));
    const missing = symbolList.filter((l) => !byEpic.has(l.toUpperCase()));
    return { expr: q, missing };
  }, [query, all]);

  // When the box holds a single plain symbol (not an expression) that exactly
  // matches a catalogue epic, Enter opens that instrument.
  const singleTarget = useMemo(() => {
    const q = query.trim();
    if (!q || isSyntheticExpr(q)) return null;
    const up = q.toUpperCase();
    return all.find((m) => m.epic.toUpperCase() === up) ?? null;
  }, [query, all]);

  function pick(s: Instrument) {
    pushRecentSymbol(s.epic);
    setRecentEpics(loadRecentSymbols());
    onPick(s);
    onClose();
  }

  // Set the box and keep focus with the caret at the end so composition flows.
  function setQueryFocused(next: string) {
    setQuery(next);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  }

  // While the spread-operators toggle is active (build mode) clicking a result
  // appends its epic as the next symbol and keeps the modal open so the user can keep
  // building. With the toggle off a click opens the chart directly (see the row
  // onClick) — this helper is only reached while building a spread.
  function addSymbol(epic: string) {
    setQueryFocused(insertSymbol(query, epic));
  }

  // Insert a spread operator (from the operators toggle) into the box.
  function insertOp(token: string) {
    const t = query.replace(/\s*$/, "");
    let next: string;
    if (token === "(") next = t ? `${t} (` : "(";
    else if (token === ")") next = `${t})`;
    else if (token === "1/") next = t ? `${t} 1/` : "1/";
    else next = t ? `${t} ${token} ` : `${token} `; // binary operator
    setQueryFocused(next);
  }

  function pickSynthetic(expr: string) {
    const entry = registerSynthetic(expr, brokerId);
    pushRecentSymbol(entry.id);
    setRecentEpics(loadRecentSymbols());
    onPick({
      epic: entry.id,
      name: entry.expression,
      status: "TRADEABLE",
      type: "SYNTHETIC",
    });
    onClose();
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal symsearch" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head symsearch-head">
          <span>
            Symbol search
            <span className="symsearch-broker"> · {brokerLabel(brokerId)}</span>
          </span>
          <CloseButton onClick={onClose} />
        </div>

        <div className="symsearch-input">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            placeholder="Symbol or name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Enter opens the chart: a complete synthetic expression, else a
              // single plain symbol that resolves to a catalogue epic.
              if (syntheticCandidate && syntheticCandidate.missing.length === 0) {
                e.preventDefault();
                pickSynthetic(syntheticCandidate.expr);
              } else if (singleTarget) {
                e.preventDefault();
                pick(singleTarget);
              }
            }}
          />
          {query && (
            <button className="symsearch-clear" title="Clear" onClick={() => setQuery("")}>
              ✕
            </button>
          )}
          {showOps && (
            <div className="symsearch-ops">
              {SPREAD_OPS.map((o) => (
                <button
                  key={o.token}
                  type="button"
                  aria-label={o.name}
                  title={o.name}
                  onClick={() => insertOp(o.token)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <button
            className={"symsearch-ops-toggle" + (showOps ? " on" : "")}
            title={showOps ? "Hide spread operators" : "Show spread operators"}
            aria-label={showOps ? "Hide spread operators" : "Show spread operators"}
            aria-pressed={showOps}
            onClick={() => setShowOps((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M8 9h.01M12 9h.01M16 9h.01M8 13h.01M16 13h.01M8 17h8" />
            </svg>
          </button>
        </div>

        <div className="symsearch-cats">
          {CHIPS.map((c) => (
            <button
              key={c.key}
              className={!query.trim() && cat === c.key ? "on" : ""}
              onClick={() => {
                setCat(c.key);
                setQuery(""); // a chip click leaves search mode
              }}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* A valid expression has no open-row — press Enter to open it. Only an
            unknown symbol surfaces a message, as validation feedback. */}
        {syntheticCandidate && syntheticCandidate.missing.length > 0 && (
          <div className="symsearch-synthetic">
            <div className="symsearch-empty">
              Unknown instrument{syntheticCandidate.missing.length > 1 ? "s" : ""}:{" "}
              {syntheticCandidate.missing.join(", ")}
            </div>
          </div>
        )}

        <ul className="symsearch-results">
          {shown.map((m, i) => (
            <li
              key={`${m.epic}-${i}`}
              className={
                (m.epic === current.epic ? "selected" : "") +
                (m.status !== "TRADEABLE" ? " closed" : "")
              }
              onClick={() => (showOps ? addSymbol(m.epic) : pick(m))}
              title={m.status !== "TRADEABLE" ? "Market closed" : undefined}
            >
              <SymbolIcon epic={m.epic} type={m.type} className="ss-icon" />
              <span className="ss-epic">{m.epic}</span>
              <span className="ss-name">{m.name}</span>
              <span className="ss-type">{typeLabel(m.type)}</span>
              <span className="ss-exch">{brokerLabel(brokerId).toUpperCase()}</span>
              <span className="ss-badge" aria-hidden="true">
                {brokerId.charAt(0).toUpperCase()}
              </span>
              <button
                className={"ss-star" + (favEpics.has(m.epic) ? " on" : "")}
                title={favEpics.has(m.epic) ? "Remove from favorites" : "Add to favorites"}
                aria-label={favEpics.has(m.epic) ? "Remove from favorites" : "Add to favorites"}
                aria-pressed={favEpics.has(m.epic)}
                onClick={(e) => {
                  e.stopPropagation(); // don't select + close the modal
                  void toggleFavorite(m);
                }}
              >
                <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                  <path d="M12 17.3l-5.4 3.3 1.5-6.2L3 10.2l6.3-.5L12 4l2.7 5.7 6.3.5-5.1 4.2 1.5 6.2z" />
                </svg>
              </button>
            </li>
          ))}
          {isSyntheticExpr(query) && activeSymbolFragment(query) === "" ? (
            <li className="symsearch-empty">Type to search the next symbol…</li>
          ) : (
            <>
              {loading && shown.length === 0 && (
                <li className="symsearch-empty">Loading…</li>
              )}
              {!loading && shown.length === 0 && (
                <li className="symsearch-empty">
                  {query.trim()
                    ? `No symbols match “${term}”.`
                    : cat === "favorites"
                      ? "No favorites yet — search above, then tap the ☆ on any symbol."
                      : cat === "recent"
                        ? "No recently opened symbols yet."
                        : "Nothing to browse here — search by name above."}
                </li>
              )}
            </>
          )}
        </ul>
      </div>
    </div>
  );
}
