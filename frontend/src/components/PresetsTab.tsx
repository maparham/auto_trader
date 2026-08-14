// The backtest panel's Presets tab. Owns one ACTIVE preset: Save updates it in
// place, Save as… creates a new one, Revert throws away the panel's edits. The
// dirty dot compares the live config against the stored one canonically, so a
// reordered state update never reads as an edit.
//
// Below the identity bar sits the library: one row per saved strategy showing
// the summary of its last run, filterable and sortable, with per-row actions
// behind a ⋯ menu. Loading a row while the active preset has unsaved edits is
// gated on an inline three-way answer rather than silently discarding them.
//
// Preset identity deliberately lives here and not in the panel header — the
// header belongs to the overlay/auto-hide work.
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Tooltip from "./Tooltip";
import { backtestConfigEquals, type BacktestConfig } from "../lib/backtestConfig";
import { backtestResultSignal, backtestRunCompletedSignal } from "../lib/signals";
import {
  loadPresets, putPreset, renamePreset, deletePreset, newPreset,
  serializePresets, parsePresets,
  type BacktestPreset,
} from "../lib/backtestPresets";

type SortKey = "name" | "origin" | "netPnl" | "trades" | "winRate" | "maxDd" | "updatedAt";
type SortDir = "asc" | "desc";

// `num` heads sit over right-aligned figures and align right to match, so the
// label stays attached to the column it names.
const COLUMNS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "origin", label: "Symbol/TF" },
  { key: "netPnl", label: "Net P&L", num: true },
  { key: "trades", label: "Trades", num: true },
  { key: "winRate", label: "Win%", num: true },
  { key: "maxDd", label: "Max DD", num: true },
  { key: "updatedAt", label: "Modified" },
];

// Text sorts A→Z on first click; numbers and dates most-significant-first,
// matching BacktestPanel's trade table.
const TEXT_KEYS: SortKey[] = ["name", "origin"];
const defaultDir = (key: SortKey): SortDir => (TEXT_KEYS.includes(key) ? "asc" : "desc");

const DASH = "—";
const fmtMoney = (n: number | undefined): string =>
  n == null ? DASH : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const fmtPct = (n: number | undefined): string =>
  n == null ? DASH : `${Math.round(n * 100)}%`;
const fmtNum = (n: number | undefined): string => (n == null ? DASH : String(n));
const fmtDd = (n: number | undefined): string => (n == null ? DASH : n.toFixed(2));
const fmtDate = (ms: number): string =>
  ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : DASH;
const originLabel = (p: BacktestPreset): string =>
  p.origin ? `${p.origin.symbol} · ${p.origin.timeframe}` : DASH;
/** P&L takes the desk's green/red the way every other readout in the app does
 * (.bt-panel-table, .bt-summary, the live blotter) — it is what makes the
 * library scannable as a comparison rather than a list of names. A preset with
 * no recorded run is toneless, not zero. */
const toneOf = (n: number | undefined): string => (n == null ? "" : n > 0 ? " pos" : n < 0 ? " neg" : "");

/** Own-property lookup. Preset names are user text, so `toString`/`__proto__`
 *  are names a user can type: a plain `presets[name]` inherits from
 *  Object.prototype and reports a collision that does not exist (and hands the
 *  caller a non-preset). Mirrors the write-side hardening in backtestPresets. */
function presetAt(
  all: Record<string, BacktestPreset>,
  name: string,
): BacktestPreset | undefined {
  return Object.prototype.hasOwnProperty.call(all, name) ? all[name] : undefined;
}

function sortValue(p: BacktestPreset, key: SortKey): string | number {
  switch (key) {
    case "name": return p.name.toLowerCase();
    case "origin": return originLabel(p).toLowerCase();
    // Statically a number, but parsePresets only validates `name` and `cfg`, so
    // an imported file can smuggle a string in here. Left alone it would make
    // the DEFAULT sort compare strings against numbers and scramble the view.
    case "updatedAt": return typeof p.updatedAt === "number" ? p.updatedAt : 0;
    // A preset with no recorded run sorts to the bottom of every result column
    // in either direction would be nicer, but it costs a second comparator —
    // -Infinity keeps it at the bottom descending, which is the default view.
    case "netPnl": return p.lastRun?.netPnl ?? -Infinity;
    case "trades": return p.lastRun?.trades ?? -Infinity;
    case "winRate": return p.lastRun?.winRate ?? -Infinity;
    case "maxDd": return p.lastRun?.maxDd ?? -Infinity;
  }
}

// Module-singleton signal — memoize subscribe so useSyncExternalStore doesn't
// resubscribe on every render (same pattern as BacktestPanel).
const subscribeCompleted = (cb: () => void) => backtestRunCompletedSignal.subscribe(cb);

export type PresetsTabProps = {
  cfg: BacktestConfig;
  onLoad: (cfg: BacktestConfig) => void;
  activeName: string | null;
  onActiveChange: (name: string | null) => void;
  chartSymbol: string;
  chartTimeframe: string;
  captureRuns: boolean;
  onGoLive: () => void;
};

export default function PresetsTab({
  cfg, onLoad, activeName, onActiveChange, chartSymbol, chartTimeframe, captureRuns, onGoLive,
}: PresetsTabProps) {
  const [presets, setPresets] = useState<Record<string, BacktestPreset>>(() => loadPresets());
  // One-line result of the last import, so a partially-bad file says what it
  // dropped instead of failing silently.
  const [importNote, setImportNote] = useState<string | null>(null);
  // The tab is always mounted, so a note left up would describe an import the
  // user has long since moved past. Every library mutation goes through
  // refresh(), which makes this the one place that can retire it; importFile
  // refreshes BEFORE setting its own note, so it survives its own call.
  const refresh = () => {
    setPresets(loadPresets());
    setImportNote(null);
  };
  // Naming is inline, never window.prompt: the panel is already a surface, and
  // a browser prompt cannot be styled, tested, or cancelled predictably.
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  // Create and rename share one naming row so the field, placeholder, Enter and
  // Escape handling stay in one place; only the confirm button's label and
  // action differ.
  const [namingMode, setNamingMode] = useState<"create" | "rename">("create");
  const [renameFrom, setRenameFrom] = useState<string | null>(null);
  // Every exit from the naming row goes through here. The tab is always mounted
  // (all tabs render into one scroll container), so a draft left behind by an
  // Escape would survive for the life of the panel and pre-fill the field the
  // next time Save as… opens — a reflexive Enter would then fire an overwrite
  // confirm on a name the user never typed. The mode resets with it, or an
  // abandoned rename would leave the next Save as… labelled "Rename".
  const closeNaming = () => {
    setNaming(false);
    setDraftName("");
    setNamingMode("create");
    setRenameFrom(null);
  };

  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // The panel body is a scroll box, so a menu opened on a row near the bottom
  // is cut off by its edge rather than escaping the panel — and Delete, the
  // last item, is the one that disappears. Flip above the row when the space
  // below cannot hold the menu.
  const [menuUp, setMenuUp] = useState(false);
  const MENU_H = 160; // 5 items + padding; measuring the unmounted menu is not worth a layout pass

  function toggleMenu(name: string, btn: HTMLElement) {
    if (menuFor === name) {
      setMenuFor(null);
      return;
    }
    const scroller = btn.closest(".bt-body");
    const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
    setMenuUp(bottom - btn.getBoundingClientRect().bottom < MENU_H);
    setMenuFor(name);
  }
  // A load blocked on unsaved edits: the target preset, awaiting the user's
  // three-way answer. Null when no such prompt is up.
  const [pendingLoad, setPendingLoad] = useState<string | null>(null);
  // Inline note editor, one preset at a time — same no-window.prompt rule as
  // naming. The draft lives here (not per-row) because only one editor is open.
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");

  // presetAt, not presets[activeName]: activeName is parent-owned and can dangle
  // (the preset was deleted or renamed away). If it dangles on a prototype member
  // name, a plain read yields a function, `active` goes truthy, and the dirty
  // check below dereferences `.cfg` on it.
  const active = activeName ? presetAt(presets, activeName) : undefined;
  const dirty = !!active && !backtestConfigEquals(cfg, active.cfg);
  const origin = { symbol: chartSymbol, timeframe: chartTimeframe };

  // A stored lastRun summarizes the last CLEAN run of the stored cfg, so it must
  // not outlive the cfg it describes — otherwise the library table would credit
  // a strategy with a result that belonged to a superseded version of it.
  function runFor(stored: BacktestPreset, next: BacktestConfig) {
    return backtestConfigEquals(stored.cfg, next) ? stored.lastRun : undefined;
  }

  // The other half of runFor's invariant. runFor DROPS lastRun whenever a write
  // changes the stored cfg; this ATTACHES one only while `dirty` is false, i.e.
  // while the live cfg still equals the stored cfg. Together they guarantee that
  // a stored lastRun always describes the cfg stored beside it.
  //
  // Keyed on the COMPLETION COUNTER, not on backtestResultSignal, because the
  // result signal cannot answer "did a run just happen?". A rehydrate (symbol or
  // timeframe switch — the panel is non-modal and stays mounted across both)
  // republishes a stored result through that same signal, and no comparison on
  // the payload can spot it: object identity fails because even a fresh run
  // publishes the copy read back out of storage, and a value compare fails
  // because a rehydrate of ANOTHER chart's saved result is a genuinely different
  // result that this panel simply did not run. The counter is bumped at exactly
  // one site — BacktestButton, right after a completed single backtest — so it
  // says what we actually need to know.
  const completions = useSyncExternalStore(
    subscribeCompleted,
    () => backtestRunCompletedSignal.value,
  );
  // Seeded from the signal, not 0: this component unmounts with the panel, so a
  // run that finished before it mounted is not ours to record.
  const seen = useRef(backtestRunCompletedSignal.value);

  useEffect(() => {
    if (completions === seen.current) return;
    // Marked BEFORE the guards on purpose, as the brief requires: a run that
    // completes while the config is dirty belongs to the EDITED config, so
    // reverting afterwards must not retroactively attach it.
    seen.current = completions;
    // Read imperatively: the two sets are synchronous and ordered, so the result
    // signal holds exactly the run this bump announced.
    const result = backtestResultSignal.value;
    if (!result) return;
    if (!captureRuns || !active || dirty) return;
    const s = result.summary;
    putPreset({
      ...active,
      // `updatedAt` deliberately unchanged — a run is not an edit, and it is the
      // table's default sort key, so bumping it would reshuffle the library every
      // time a backtest finishes.
      lastRun: {
        at: Date.now(),
        // Provenance: the chart the run actually happened on, which may differ
        // from the preset's `origin` (the chart it was first saved from). Stored
        // for export and future use — the table renders `origin`, not these.
        symbol: chartSymbol,
        timeframe: chartTimeframe,
        netPnl: s.net_pnl,
        trades: s.n_trades,
        winRate: s.win_rate,
        maxDd: s.max_drawdown,
      },
    });
    // The exact case the set-state-in-effect rule exempts, written the other way
    // round: storage is the external system, this effect is the subscription to
    // it, and the row just written has to be re-read for the table to show its
    // numbers. It runs once per completed run, not per render, so there is no
    // cascade. (Covers both setStates inside refresh(): setPresets is the re-read,
    // and setImportNote retires a stale import note the same way every other
    // library mutation does.)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    // `active`/`dirty` are read at completion time on purpose — a later edit must
    // not retroactively attach or detach this run — so they are NOT deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completions]);

  function save() {
    if (!active) return;
    putPreset({ ...active, cfg, updatedAt: Date.now(), lastRun: runFor(active, cfg) });
    refresh();
    // Save from an open naming row would otherwise leave the row hanging.
    closeNaming();
  }

  function createNamed() {
    const name = draftName.trim();
    if (!name) return;
    const existing = presetAt(presets, name);
    if (existing && !window.confirm(`Replace the saved preset "${name}"?`)) return;
    putPreset(
      existing
        ? { ...existing, cfg, updatedAt: Date.now(), origin, lastRun: runFor(existing, cfg) }
        : newPreset(name, cfg, origin, Date.now()),
    );
    refresh();
    closeNaming();
    onActiveChange(name);
  }

  function revert() {
    if (!active || !dirty) return;
    if (!window.confirm(`Discard your changes to "${active.name}"?`)) return;
    onLoad(active.cfg);
  }

  // The <input type="file"> is hidden and driven from a styled button, so the
  // ref is the only way to open the picker.
  const fileRef = useRef<HTMLInputElement | null>(null);

  function download(filename: string, json: string) {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportOne(name: string) {
    const p = presets[name];
    if (!p) return;
    setMenuFor(null);
    download(`${name}.json`, serializePresets([p]));
  }

  // Both export paths read the RENDERED state while importFile deliberately
  // re-reads storage. Not an oversight: import writes based on what it reads, so
  // a stale read there destroys data, whereas export only reads — and exporting
  // rows the user cannot see on screen would be the surprising behaviour, not
  // the safe one. "Export all" means the library as shown.
  function exportAll() {
    download("backtest-presets.json", serializePresets(Object.values(presets)));
  }

  // A partially-bad file imports its good entries and reports the rest: failing
  // the whole file would punish the user for one hand-edited line, and failing
  // silently would hide it. A declined overwrite counts as skipped, not as an
  // error — the user chose it.
  async function importFile(file: File) {
    const { presets: incoming, rejected } = parsePresets(await file.text());
    // Seeded from STORAGE, not from `presets`: this component's copy can be a
    // tick stale, and a missed collision here silently destroys a saved
    // strategy. A Set, not the record itself, so a preset named `__proto__`
    // tests as an ordinary name; and it grows as we go, so a file carrying the
    // same name twice confirms on the second occurrence too instead of counting
    // one silent self-overwrite as two imports.
    const taken = new Set(Object.keys(loadPresets()));
    let added = 0;
    let skipped = rejected;
    // Whether this import replaced the preset the panel is currently editing.
    let clobberedActive = false;
    for (const p of incoming) {
      if (taken.has(p.name) && !window.confirm(`Replace the saved preset "${p.name}"?`)) {
        skipped += 1;
        continue;
      }
      if (p.name === activeName) clobberedActive = true;
      putPreset(p);
      taken.add(p.name);
      added += 1;
    }
    refresh();
    setImportNote(`Imported ${added}${skipped ? ` · Skipped ${skipped}` : ""}`);
    // Same answer commitRename and remove already give: overwriting the ACTIVE
    // preset leaves the panel showing a config that is now stored nowhere.
    // Keeping the pointer would light the dirty dot against the imported cfg for
    // no visible cause, and a reflexive Save would write the panel's config
    // straight back over the file the user just imported.
    if (clobberedActive) onActiveChange(null);
  }

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = Object.values(presets).filter((p) => !q || p.name.toLowerCase().includes(q));
    const dir = sortDir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av === bv) return a.name.localeCompare(b.name);
      return av < bv ? -dir : dir;
    });
  }, [presets, filter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(defaultDir(key)); }
  }

  // `next` overrides the stored cfg for the one caller that has a fresher one:
  // Save & load on the ACTIVE preset writes storage but `presets` here is still
  // the pre-save snapshot, so loading it would hand back — and thereby undo —
  // the edits just saved.
  function doLoad(name: string, next?: BacktestConfig) {
    // Cleared BEFORE the existence guard, not after: the table stays live while
    // the prompt is up, so the target can be deleted out from under it. Bailing
    // first would leave the prompt on screen with two dead buttons — and Save &
    // load would still have written storage on the way in, so a second click
    // would save again against a question that no longer has a subject.
    setPendingLoad(null);
    setMenuFor(null);
    const p = presets[name];
    if (!p) return;
    onLoad(next ?? p.cfg);
    onActiveChange(name);
  }

  function requestLoad(name: string) {
    setMenuFor(null);
    if (dirty) setPendingLoad(name);
    else doLoad(name);
  }

  function duplicate(name: string) {
    const p = presets[name];
    if (!p) return;
    let copy = `${name} copy`;
    for (let i = 2; presets[copy]; i += 1) copy = `${name} copy ${i}`;
    // The cfg is copied unchanged, so lastRun still describes it and rides along.
    putPreset({ ...p, name: copy, createdAt: Date.now(), updatedAt: Date.now() });
    refresh();
    setMenuFor(null);
  }

  function startNote(name: string) {
    setMenuFor(null);
    setNoteFor(name);
    setDraftNote(presetAt(presets, name)?.note ?? "");
  }

  function commitNote() {
    const name = noteFor;
    setNoteFor(null);
    setDraftNote("");
    const p = name ? presetAt(presets, name) : undefined;
    if (!p) return; // deleted out from under the open editor
    const note = draftNote.trim() ? draftNote : undefined;
    // `updatedAt` unchanged on purpose: like a rename, annotating a preset is
    // not an edit of the strategy, and Modified is the table's default sort.
    putPreset({ ...p, note });
    refresh();
  }

  function startRename(name: string) {
    setMenuFor(null);
    setNamingMode("rename");
    setRenameFrom(name);
    setDraftName(name);
    setNaming(true);
  }

  function commitRename() {
    // Captured up front: closeNaming() clears both, and the onActiveChange below
    // has to compare against the name we started from.
    const from = renameFrom;
    const to = draftName.trim();
    if (!from || !to || to === from) { closeNaming(); return; }
    // Declining leaves the row open with the draft intact, as createNamed does.
    if (presetAt(presets, to) && !window.confirm(`Replace the saved preset "${to}"?`)) return;
    renamePreset(from, to);
    refresh();
    closeNaming();
    if (activeName === from) onActiveChange(to);
    // Reaching here with activeName === to means the rename OVERWROTE the preset
    // the user was editing (to !== from, and to existed for the confirm to have
    // fired). The panel still shows that preset's config, which is now stored
    // nowhere — same situation as deleting the active preset, so it gets the
    // same answer. Re-pointing at `to` instead would silently swap the content
    // under a name the user never re-loaded, lighting the dirty dot for no
    // visible cause.
    else if (activeName === to) onActiveChange(null);
  }

  function remove(name: string) {
    setMenuFor(null);
    if (!window.confirm(`Delete the preset "${name}"?`)) return;
    deletePreset(name);
    refresh();
    // A pending load asks a question about this preset. Deleting it answers the
    // question by making it moot, so the prompt goes with its subject rather
    // than waiting for the user to click a button that can no longer do
    // anything.
    if (pendingLoad === name) setPendingLoad(null);
    // An open note editor for the deleted preset would save into nothing.
    if (noteFor === name) { setNoteFor(null); setDraftNote(""); }
    // Otherwise the parent keeps pointing at a preset that no longer exists and
    // the identity bar silently degrades to "Unsaved strategy".
    if (activeName === name) onActiveChange(null);
  }

  return (
    <div className="bt-presets">
      <div className="bt-preset-bar">
        <span className="bt-preset-id">
          {active ? (
            <>
              <span className={`bt-preset-dot${dirty ? " dirty" : ""}`} aria-hidden="true" />
              <span className="bt-preset-name">{active.name}</span>
              {dirty && <span className="bt-preset-edited">edited</span>}
            </>
          ) : (
            <span className="bt-preset-name muted">Unsaved strategy</span>
          )}
        </span>
        <span className="bt-preset-actions">
          <button className="ghost" onClick={save} disabled={!active || !dirty}>
            Save
          </button>
          <button
            className="ghost"
            onClick={() => { setNamingMode("create"); setDraftName(""); setNaming(true); }}
          >
            Save as…
          </button>
          <button className="ghost" onClick={revert} disabled={!dirty}>
            Revert
          </button>
          {/* Go live belongs beside Save/Revert, not in a row of its own: all
              four act on the CURRENT panel config, which is what this bar is
              about. It is separated by a rule because it leaves the panel. */}
          <span className="bt-preset-sep" aria-hidden="true" />
          <Tooltip content="Copy this strategy into the Live panel to trade a demo/live account">
            <button className="ghost bt-golive" onClick={onGoLive}>
              Go live →
            </button>
          </Tooltip>
        </span>
      </div>

      {naming && (
        <div className="bt-preset-naming">
          <input
            autoFocus
            value={draftName}
            placeholder="Strategy name"
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (namingMode === "rename" ? commitRename : createNamed)();
              if (e.key === "Escape") closeNaming();
            }}
          />
          <button
            className="ghost"
            onClick={namingMode === "rename" ? commitRename : createNamed}
            disabled={!draftName.trim()}
          >
            {namingMode === "rename" ? "Rename" : "Create"}
          </button>
          <button className="ghost" onClick={closeNaming}>
            Cancel
          </button>
        </div>
      )}

      {pendingLoad && (
        <div className="bt-preset-prompt">
          <span>
            “{activeName}” has unsaved changes.
          </span>
          <button
            className="ghost"
            onClick={() => { save(); doLoad(pendingLoad, pendingLoad === activeName ? cfg : undefined); }}
          >
            Save &amp; load
          </button>
          <button className="ghost" onClick={() => doLoad(pendingLoad)}>
            Discard &amp; load
          </button>
          <button className="ghost" onClick={() => setPendingLoad(null)}>
            Cancel
          </button>
        </div>
      )}

      <div className="bt-preset-library">
        {/* Filter and the whole-library actions share one row: all three act on
            the library rather than on any preset, and stacking them cost a row
            for no grouping. */}
        <div className="bt-preset-libbar">
          <input
            className="bt-preset-filter"
            value={filter}
            placeholder="Filter…"
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="bt-preset-libbar-actions">
            {importNote && <span className="bt-preset-note">{importNote}</span>}
            <button className="ghost" onClick={() => fileRef.current?.click()}>
              Import JSON…
            </button>
            <button
              className="ghost"
              onClick={exportAll}
              disabled={Object.keys(presets).length === 0}
            >
              Export all
            </button>
            <input
              ref={fileRef}
              className="bt-preset-import-input"
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // re-importing the same file must re-fire change
                if (file) void importFile(file);
              }}
            />
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="bt-preset-empty">
            {Object.keys(presets).length === 0
              ? "No saved strategies yet — configure a strategy and press Save as…"
              : "No preset matches this filter."}
          </div>
        ) : (
          // No role="table"/"row" here or on the rows: the cells are bare spans,
          // so the roles would announce a table with zero columns — worse than
          // the plain text AT reads without them. Real grid semantics (with
          // columnheader/cell) are tracked separately.
          <div className="bt-preset-table">
            <div className="bt-preset-head">
              {COLUMNS.map((c) => (
                <button
                  key={c.key}
                  className={`bt-preset-th${c.num ? " num" : ""}${sortKey === c.key ? " sorted" : ""}`}
                  onClick={() => toggleSort(c.key)}
                >
                  {c.label}
                </button>
              ))}
              <span className="bt-preset-th spacer" />
            </div>
            {rows.map((p) => {
              // Flagged before loading, not after: a preset built on another
              // chart still loads, but its stored result describes that chart.
              const mismatch =
                !!p.origin &&
                (p.origin.symbol !== chartSymbol || p.origin.timeframe !== chartTimeframe);
              const row = (
                <div
                  className={`bt-preset-row${p.name === activeName ? " active" : ""}`}
                >
                  <span className="bt-preset-cell-name">{p.name}</span>
                  <span className={`bt-preset-cell${mismatch ? " bt-preset-mismatch" : ""}`}>
                    {mismatch ? (
                      <Tooltip content="Built on a different chart than the one you're on">
                        <span>{originLabel(p)}</span>
                      </Tooltip>
                    ) : (
                      originLabel(p)
                    )}
                  </span>
                  <span className={`bt-preset-cell num${toneOf(p.lastRun?.netPnl)}`}>
                    {fmtMoney(p.lastRun?.netPnl)}
                  </span>
                  <span className="bt-preset-cell num">{fmtNum(p.lastRun?.trades)}</span>
                  <span className="bt-preset-cell num">{fmtPct(p.lastRun?.winRate)}</span>
                  <span className="bt-preset-cell num">{fmtDd(p.lastRun?.maxDd)}</span>
                  <span className="bt-preset-cell">{fmtDate(p.updatedAt)}</span>
                  <span className="bt-preset-cell actions">
                    <button
                      className="ghost bt-preset-menu-btn"
                      aria-label={`Actions for ${p.name}`}
                      onClick={(e) => toggleMenu(p.name, e.currentTarget)}
                    >
                      ⋯
                    </button>
                    {menuFor === p.name && (
                      <span className={`bt-preset-menu${menuUp ? " up" : ""}`}>
                        <button className="ghost" onClick={() => requestLoad(p.name)}>Load</button>
                        <button className="ghost" onClick={() => duplicate(p.name)}>Duplicate</button>
                        <button className="ghost" onClick={() => startRename(p.name)}>Rename</button>
                        <button className="ghost" onClick={() => startNote(p.name)}>Note…</button>
                        <button className="ghost" onClick={() => exportOne(p.name)}>Export</button>
                        <button className="ghost danger" onClick={() => remove(p.name)}>Delete</button>
                      </span>
                    )}
                  </span>
                </div>
              );
              return (
                <Fragment key={p.name}>
                  {/* The note IS the tooltip: annotated rows explain themselves
                      on hover, bare rows stay inert. */}
                  {p.note ? (
                    <Tooltip content={p.note.split("\n").filter((l) => l.trim())}>
                      {row}
                    </Tooltip>
                  ) : (
                    row
                  )}
                  {noteFor === p.name && (
                    <div className="bt-preset-noterow">
                      <textarea
                        autoFocus
                        value={draftNote}
                        placeholder="Note"
                        rows={3}
                        onChange={(e) => setDraftNote(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") { setNoteFor(null); setDraftNote(""); }
                        }}
                      />
                      <button className="ghost" onClick={commitNote}>Save note</button>
                      <button
                        className="ghost"
                        onClick={() => { setNoteFor(null); setDraftNote(""); }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
}
