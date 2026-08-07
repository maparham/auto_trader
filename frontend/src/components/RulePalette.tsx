// The rule editor's insert palette. It opens as a floating modal off the `+` on
// a rule row (rather than expanding inline under it, which pushed the rest of
// the rules down and squeezed the catalog into the rule card's width).
//
// One pick per opening: `onInsert` then `onClose`. Esc, the ✕, and click-away
// all come from FloatingModal.

import { useMemo, useState } from "react";
import { CANDLE_FIELDS, INDICATORS, WRAPPERS, CROSS_OPS, CROSSES, CONDITIONS, LOGIC, PATTERNS, TIMEFRAMES } from "../lib/expr/catalog";
import type { CatalogEntry } from "../lib/expr/catalog";
import FloatingModal from "./FloatingModal";
import Tooltip from "./Tooltip";

// Every group is flattened to this shape so the filter is one pass over one
// list: `label` is what the button reads, `insert` what lands in the expression,
// and `detail` both the tooltip and extra filter fodder ("moving average" finds
// EMA/SMA/VOLMA).
interface Item {
  key: string;
  label: string;
  insert: string;
  detail?: string;
}

// The infix operators lead the group — they're the preferred spelling; the
// function forms follow for anyone who already writes them.
const CROSS_ITEMS: CatalogEntry[] = [...CROSS_OPS, ...CROSSES];

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: "Candle",
    items: CANDLE_FIELDS.map((field) => ({
      key: `candle.${field}`,
      label: field,
      insert: `candle.${field}`,
    })),
  },
  ...([
    ["Indicators", INDICATORS],
    ["Wrappers", WRAPPERS],
    ["Crosses", CROSS_ITEMS],
    ["Logic", LOGIC],
    ["Conditions", CONDITIONS],
    ["Patterns", PATTERNS],
  ] as const).map(([title, entries]: [string, CatalogEntry[]]) => ({
    title,
    items: entries.map((entry) => ({
      key: entry.name,
      label: entry.signature,
      insert: entry.insert,
      detail: entry.detail,
    })),
  })),
  {
    title: "Timeframes",
    items: TIMEFRAMES.map((tf) => ({
      key: tf.alias,
      label: tf.alias,
      insert: `@${tf.alias}`,
    })),
  },
];

function matches(item: Item, q: string): boolean {
  if (!q) return true;
  return `${item.key} ${item.label} ${item.detail ?? ""}`.toLowerCase().includes(q);
}

export default function RulePalette({
  onInsert,
  onClose,
  title = "Insert",
}: {
  onInsert: (text: string) => void;
  onClose: () => void;
  title?: string;
}) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GROUPS.map((g) => ({ ...g, items: g.items.filter((it) => matches(it, q)) })).filter(
      (g) => g.items.length > 0,
    );
  }, [query]);

  // A pick is terminal: hand the text up, then close.
  function pick(text: string) {
    onInsert(text);
    onClose();
  }

  return (
    <FloatingModal title={title} onClose={onClose} width={420} className="rule-palette">
      <div className="rule-palette-search">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter takes the top match, so a filter that narrows to one item is
            // a two-keystroke insert. It needs a query to mean anything: on an
            // empty filter "the top match" is just the first catalog entry, and
            // a reflex Enter on open would silently insert candle.open.
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (!query.trim()) return;
            const first = groups[0]?.items[0];
            if (first) pick(first.insert);
          }}
          placeholder="Filter…"
          aria-label="Filter palette"
          autoFocus
        />
      </div>
      {groups.length === 0 ? (
        <div className="al-note rule-palette-empty">No matches</div>
      ) : (
        groups.map((group) => (
          <div className="rule-palette-group" key={group.title}>
            <h3>{group.title}</h3>
            <div className="rule-palette-items">
              {group.items.map((item) =>
                item.detail ? (
                  <Tooltip key={item.key} content={item.detail}>
                    <button type="button" onClick={() => pick(item.insert)}>
                      {item.label}
                    </button>
                  </Tooltip>
                ) : (
                  <button type="button" key={item.key} onClick={() => pick(item.insert)}>
                    {item.label}
                  </button>
                ),
              )}
            </div>
          </div>
        ))
      )}
    </FloatingModal>
  );
}
