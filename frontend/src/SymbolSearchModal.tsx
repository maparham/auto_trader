// TradingView-style "Symbol search" modal. Opened by clicking the editable
// symbol name in the toolbar. Replaces the old always-on inline search input.
//
// Data model: the full instrument catalogue (~4000) is fetched once and cached;
// category chips filter it client-side by instrumentType. The modal opens on the
// account's FAVORITES watchlist. Typing runs a live keyword search instead.

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

interface Props {
  current: Instrument;
  onPick: (s: Instrument) => void;
  onClose: () => void;
}

// Category chips. "favorites"/"all" are special; the rest filter by the market's
// Capital.com instrumentType. Order/labels mirror TradingView.
const CHIPS: { key: string; label: string; type?: string }[] = [
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

export default function SymbolSearchModal({ current, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("favorites"); // opening view
  const [all, setAll] = useState<Instrument[]>([]);
  const [favorites, setFavorites] = useState<Instrument[]>([]);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [searchHits, setSearchHits] = useState<Instrument[]>([]);
  const [searching, setSearching] = useState(false);
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
        if (was) await removeFavorite(s.epic);
        else await addFavorite(s.epic);
      } catch {
        // Roll back on failure.
        setFavorites((prev) =>
          was ? [...prev, s] : prev.filter((f) => f.epic !== s.epic),
        );
      }
    },
    [favEpics],
  );

  useEffect(() => inputRef.current?.focus(), []);

  useCloseOnEscape(onClose);

  // Load the catalogue + favorites once (both cached for the session).
  useEffect(() => {
    let alive = true;
    void Promise.all([fetchAllMarkets(), fetchFavorites()]).then(([a, f]) => {
      if (!alive) return;
      setAll(a);
      setFavorites(f);
      setCatalogueLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Debounced keyword search (broker-side). Only runs when there's a query;
  // with no query `loading` reads catalogueLoading, so `searching` is moot here.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      const found = await searchInstruments(q);
      if (id !== reqId.current) return; // a newer query superseded this one
      setSearchHits(found);
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // What to show: keyword search wins; otherwise the active chip filters the
  // cached catalogue (Favorites/All are special; the rest match by type).
  const shown = useMemo(() => {
    if (query.trim()) return searchHits;
    if (cat === "favorites") return favorites;
    if (cat === "all") return all;
    return all.filter((m) => m.type === cat);
  }, [query, searchHits, cat, all, favorites]);

  const loading = query.trim() ? searching : catalogueLoading;

  function pick(s: Instrument) {
    onPick(s);
    onClose();
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal symsearch" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head symsearch-head">
          <span>Symbol search</span>
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
          />
          {query && (
            <button className="symsearch-clear" title="Clear" onClick={() => setQuery("")}>
              ✕
            </button>
          )}
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

        <ul className="symsearch-results">
          {shown.map((m, i) => (
            <li
              key={`${m.epic}-${i}`}
              className={
                (m.epic === current.epic ? "selected" : "") +
                (m.status !== "TRADEABLE" ? " closed" : "")
              }
              onClick={() => pick(m)}
              title={m.status !== "TRADEABLE" ? "Market closed" : undefined}
            >
              <SymbolIcon epic={m.epic} type={m.type} className="ss-icon" />
              <span className="ss-epic">{m.epic}</span>
              <span className="ss-name">{m.name}</span>
              <span className="ss-type">{typeLabel(m.type)}</span>
              <span className="ss-exch">CAPITAL.COM</span>
              <span className="ss-badge" aria-hidden="true">C</span>
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
          {loading && shown.length === 0 && (
            <li className="symsearch-empty">Loading…</li>
          )}
          {!loading && shown.length === 0 && (
            <li className="symsearch-empty">
              {query.trim()
                ? `No symbols match “${query.trim()}”.`
                : cat === "favorites"
                  ? "No favorites yet — search above, then tap the ☆ on any symbol."
                  : "No symbols in this category."}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
