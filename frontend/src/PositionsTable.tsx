// The shared positions table's header components; the column list, cells and
// sort helpers live in lib/positionsTable.tsx.
import type { ReactNode } from "react";
import Tooltip from "./components/Tooltip";
import { POSITION_COLUMNS, type SortDir, type SortKey, type SortState, type TableTab } from "./lib/positionsTable";

// Header row: one sortable head per column, then any caller-specific trailing
// heads (the dock's action column). `tips` off drops the column tooltips: on
// touch a tap opens the bubble, so every sort tap on the phone would pop one.
export function PositionsHead({
  tab,
  sort,
  onSort,
  trailing,
  tips = true,
}: {
  tab: TableTab;
  sort: SortState;
  onSort: (key: SortKey) => void;
  trailing?: ReactNode;
  tips?: boolean;
}) {
  return (
    <tr>
      {POSITION_COLUMNS.map((c) => (
        <th key={c.key} className={c.cls}>
          <SortHeader label={c.label(tab)} col={c.key} sort={sort} onSort={onSort} title={tips ? c.tip(tab) : undefined} />
        </th>
      ))}
      {trailing}
    </tr>
  );
}

// Clickable column header: click to sort by this column, click again to flip
// direction. A caret marks the active column; inactive heads stay quiet.
// Generic over the key type so other tables (the pattern-search results) can
// reuse it with their own column union. `sort.key` is deliberately the wider
// `string`: inferring K from both `col` and `sort.key` at once gives two
// competing literal candidates at every call site, and neither wins.
export function SortHeader<K extends string>({
  label,
  col,
  sort,
  onSort,
  title,
}: {
  label: string;
  col: K;
  sort: { key: string; dir: SortDir };
  onSort: (key: K) => void;
  title?: string;
}) {
  const active = sort.key === col;
  return (
    <Tooltip content={title}>
      <button
        className={`pp-sort${active ? " on" : ""}`}
        onClick={() => onSort(col)}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <span>{label}</span>
        <span className="pp-sort-caret" aria-hidden="true">
          {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </Tooltip>
  );
}
