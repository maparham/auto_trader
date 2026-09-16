// The ONE workspace-level pattern search: the picked range, the request in
// flight and its merged result. Module-level (not per-cell React state) on
// purpose — the results panel must survive tab switches, series changes on the
// chart it was dragged on, even that chart closing. Only the panel's own ✕
// (dismissPatternPanel) destroys a result list; everything else at most hides
// the panel and finds it intact afterwards. Cells call runPatternSearch from
// the drag gesture; App renders the panel from this state and registers the
// workspace's searchable series (setPatternSeriesProvider).
import {
  mergePatternResults,
  searchPatterns,
  type MatchSource,
  type MergedPatternResult,
  type PatternBar,
  type PatternMode,
  type PatternSearchResult,
} from "./patternSearch";
import { listPatternTargets } from "./patternTargets";
import {
  createUserPreset,
  fetchFamilies,
  listUserPresets,
  runPresetScan,
  type PresetFamily,
  type PresetScanResult,
  type UserPreset,
} from "./presetScan";
import { claimSidePanel, registerSidePanel } from "./sidePanels";

const MIN_BARS = 3;
const MAX_BARS = 1024;
const TOP_K = 20;
const DEFAULT_MODE: PatternMode = "shape";
const DEFAULT_FORWARD_BARS = 20;
// A workspace with many tabs can hold twenty-odd distinct series, and the
// first search on each is a cold cache build server-side. A small pool keeps
// the fan-out from hammering them all at once; results still merge as one.
const MAX_CONCURRENT_SEARCHES = 4;

/** What the search covers: the dragged chart's series alone, or every chart in
 *  every open tab (the workspace series App enumerates via the provider). */
export type PatternScope = "cell" | "all";
const DEFAULT_SCOPE: PatternScope = "all";

/** Which half of the panel is showing: the drag-driven Similar search, or the
 *  preset family scan. Both halves of state live in this one store — the
 *  panel is one workspace-level surface with two views. */
export type PatternView = "similar" | "presets";
const DEFAULT_VIEW: PatternView = "similar";

export interface PatternPanelState {
  /** The series the query was dragged on. Null until the first search. */
  origin: MatchSource | null;
  broker: string;
  priceSide: string;
  result: MergedPatternResult | null;
  loading: boolean;
  error: string | null;
  /** The dragged range, for repainting the selection band on the origin chart. */
  range: { fromMs: number; toMs: number } | null;
  /** Bars actually searched when the drag covered more than the cap, else null.
   *  The band spans the WHOLE drag, so the panel must disclose the difference. */
  truncatedTo: number | null;
  mode: PatternMode;
  forwardBars: number;
  scope: PatternScope;
  /** All-charts scope only: restrict the fan-out to charts on the SAME
   *  resolution as the query chart. Off by default (every open chart, every
   *  timeframe, which is what "All charts" meant before this flag). */
  sameResolution: boolean;

  /** Whether the panel is open at all (either view). */
  open: boolean;
  view: PatternView;
  /** The preset-families manifest, fetched on open (and retried on the next
   *  open if that fetch failed). */
  families: PresetFamily[] | null;
  /** Set when the families-manifest fetch fails; cleared on the next
   *  successful fetch. The UI's surface for that failure. */
  familiesError: string | null;
  /** The signed-in user's saved presets, fetched on open (and retried on the
   *  next open if that fetch failed). */
  userPresets: UserPreset[] | null;
  /** Family keys (built-in `family` or `user:<id>`) currently checked. */
  selectedFamilies: string[];
  /** Per-family parameter OVERRIDES only — unset params use the family's
   *  server-side defaults. */
  paramsByFamily: Record<string, Record<string, number>>;
  presetResult: PresetScanResult | null;
  presetLoading: boolean;
  presetError: string | null;
  /** Key of the last-clicked preset hit row, so the selection survives view
   *  switches (the Presets view unmounts entirely). Cleared by a new scan:
   *  the key identifies a row of THIS result set. */
  presetSelectedHit: string | null;
  /** Mirrors the active drag-select controller's armed/disarmed signal so the
   *  Toolbar button can reflect it without holding its own state. */
  selectArmed: boolean;
}

const initial: PatternPanelState = {
  origin: null, broker: "", priceSide: "",
  result: null, loading: false, error: null,
  range: null, truncatedTo: null,
  mode: DEFAULT_MODE, forwardBars: DEFAULT_FORWARD_BARS, scope: DEFAULT_SCOPE,
  sameResolution: false,

  open: false, view: DEFAULT_VIEW,
  families: null, familiesError: null, userPresets: null,
  selectedFamilies: [], paramsByFamily: {},
  presetResult: null, presetLoading: false, presetError: null,
  presetSelectedHit: null,
  selectArmed: false,
};

let state: PatternPanelState = initial;
const listeners = new Set<() => void>();
// Only the newest request may write state: a slow first search must not
// overwrite the result of a second one the user has already seen.
let reqId = 0;
// The last run's inputs, so a control change re-runs the SAME query even after
// the origin chart moved on to another series (the query bars were captured at
// drag time and stay valid on their own).
let lastRun: {
  origin: MatchSource;
  broker: string;
  priceSide: string;
  bars: PatternBar[];
} | null = null;
// Every searchable chart in the workspace (all tabs), as App enumerates them —
// already gated (no synthetic epics, sub-minute or snapshot cells). Called at
// run time so it always reflects the tabs as they are now.
let seriesProvider: () => MatchSource[] = () => [];
// Only the newest preset scan may write state; its own counter so a slow
// Similar search and a slow preset scan never supersede each other.
let presetReqId = 0;
// The families manifest and the user's saved presets are fetched on open.
// This flag guards against a second open re-fetching WHILE the first fetch is
// still in flight (or after it already succeeded); it is reset to false in
// the failure branch of each fetch below, so a fetch that failed IS retried
// on the next open rather than latching the panel into a permanent no-op.
let manifestRequested = false;
// The active drag-select controller (App wires this to whichever chart last
// registered one); armPatternSelect() is a level of indirection so the panel
// need not know which cell that is.
let armProvider: (() => void) | null = null;

function set(patch: Partial<PatternPanelState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function subscribePatternPanel(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stable snapshot for useSyncExternalStore (and plain reads elsewhere). */
export function getPatternPanelState(): PatternPanelState {
  return state;
}

export function setPatternSeriesProvider(fn: () => MatchSource[]): () => void {
  seriesProvider = fn;
  return () => {
    if (seriesProvider === fn) seriesProvider = () => [];
  };
}

/** Resolve the real MatchSource (cellId, tabId, label) for a series by
 *  epic+resolution, reading the workspace's series provider — the same
 *  enumeration runPatternSearch and getPresetScanCharts use. Null when no
 *  open chart (on any tab) shows that series. Preset scan results carry no
 *  cellId of their own (a preset scan spans every open chart, not one
 *  origin), so PresetScanView uses this to tag a hit with a real, jumpable
 *  source instead of a placeholder that breaks cross-tab jumps. */
export function findPatternSource(epic: string, resolution: string): MatchSource | null {
  return seriesProvider().find((s) => s.epic === epic && s.resolution === resolution) ?? null;
}

export interface PatternRunArgs {
  /** The dragging cell's identity; tabId is filled in from the provider when
   *  the workspace enumeration knows this cell. */
  origin: MatchSource;
  broker: string;
  priceSide: string;
  /** The bars inside the dragged range, uncapped — the store slices. */
  bars: PatternBar[];
  range: { fromMs: number; toMs: number };
}

export function runPatternSearch(args: PatternRunArgs): void {
  // A drag-search explicitly surfaces the panel — `open` is the ONE signal
  // WorkspacePatternPanel gates visibility on, so a search that starts while
  // the panel was never toolbar-opened must open it itself, or the toolbar
  // button (lit off `open`) and closePatternPanel (which only flips `open`)
  // both go stale relative to what's actually on screen.
  claimSidePanel("patterns");
  set({ open: true });
  const all = seriesProvider();
  // Prefer the provider's entry: it carries the tab the cell lives on, which
  // a foreign-row jump needs to switch there.
  const origin = all.find((s) => s.cellId === args.origin.cellId) ?? args.origin;
  // A new search retires the bands the previous one left on OTHER cells: the
  // superseded origin's selection band (its band-sync effect keys on its own
  // series, which no longer matches the store, so nothing on the cell's side
  // would ever clear it) and any match bands painted by row jumps. The
  // dragging cell is skipped — its gesture just painted the new band.
  const prev = state.origin;
  for (const t of listPatternTargets()) {
    if (t.cellId === args.origin.cellId) continue;
    t.clearMatchBands();
    if (
      prev &&
      (prev.epic !== origin.epic || prev.resolution !== origin.resolution) &&
      t.epic === prev.epic && t.resolution === prev.resolution
    ) {
      t.clearSelectionBand();
    }
  }
  lastRun = { origin, broker: args.broker, priceSide: args.priceSide, bars: args.bars };
  doRun(args.range);
}

function doRun(range: { fromMs: number; toMs: number }): void {
  const { origin, broker, priceSide, bars } = lastRun!;
  const query = bars.slice(-MAX_BARS);
  const base = {
    origin, broker, priceSide,
    range,
    truncatedTo: bars.length > MAX_BARS ? MAX_BARS : null,
  };
  if (query.length < MIN_BARS) {
    // Supersede anything in flight, exactly as dismiss() does. Without the
    // bump, a valid drag still loading when the user makes a too-short one
    // resolves afterwards and overwrites this error with results for the
    // PREVIOUS range, while the band on the chart shows the new one.
    reqId += 1;
    set({ ...base, result: null, error: `select at least ${MIN_BARS} candles`, loading: false });
    return;
  }
  const id = ++reqId;
  set({ ...base, loading: true, error: null });
  // The series to search: the origin chart first, then in all-charts scope
  // every OTHER series across every tab, deduped — two cells on the same
  // symbol+timeframe would return identical matches twice. broker and
  // priceSide are global, so the series key here is just epic|resolution.
  const seen = new Set([`${origin.epic}|${origin.resolution}`]);
  const sources = [origin];
  if (state.scope === "all") {
    for (const s of seriesProvider()) {
      // Before the dedup below on purpose: a series skipped for its timeframe
      // must not claim its key, or turning the flag back off could find the
      // key already taken by a search that never ran it.
      if (state.sameResolution && s.resolution !== origin.resolution) continue;
      const key = `${s.epic}|${s.resolution}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(s);
    }
  }
  // One request per series, all with the SAME query (the origin chart's
  // drag). Each settles into an outcome so one failed series cannot reject
  // the whole batch; the merge below throws only when every one failed. A
  // small worker pool caps the requests in flight; outcomes land by index,
  // so the merge still sees the origin first.
  const outcomes: { source: MatchSource; result?: PatternSearchResult; error?: string }[] =
    new Array(sources.length);
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const i = next++;
      const source = sources[i];
      outcomes[i] = await searchPatterns({
        epic: source.epic,
        resolution: source.resolution,
        priceSide,
        broker,
        query,
        queryFromTs: query[0].ts,
        queryToTs: query[query.length - 1].ts,
        topK: TOP_K,
        forwardBars: state.forwardBars,
        mode: state.mode,
      }).then(
        (res) => ({ source, result: res }),
        (e: unknown) => ({
          source,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };
  Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_SEARCHES, sources.length) }, worker),
  ).then(() => {
    if (reqId !== id) return;
    try {
      set({ result: mergePatternResults(outcomes, TOP_K), loading: false });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  });
}

// Changing a control re-runs the last query, so the effect is visible without
// dragging the band again. Nothing to re-run before the first drag, and firing
// then would search a range the user never picked.
export function setPatternMode(next: PatternMode): void {
  set({ mode: next });
  if (lastRun && state.range) doRun(state.range);
}

export function setPatternForwardBars(next: number): void {
  set({ forwardBars: next });
  if (lastRun && state.range) doRun(state.range);
}

export function setPatternScope(next: PatternScope): void {
  set({ scope: next });
  if (lastRun && state.range) doRun(state.range);
}

export function setPatternSameResolution(next: boolean): void {
  set({ sameResolution: next });
  if (lastRun && state.range) doRun(state.range);
}

/** The panel's ✕ — the ONE way a result list is destroyed. mode, forwardBars,
 *  scope and sameResolution survive: they are how the user wants to search,
 *  not part of the result being cleared. */
export function dismissPatternPanel(): void {
  reqId += 1;
  lastRun = null;
  set({
    origin: null, result: null, loading: false, error: null,
    range: null, truncatedTo: null,
  });
}

/** Opens the panel (either view). Lazily kicks off the families manifest and
 *  user-presets fetch — a second open (or a toggle back in) does not refetch
 *  while the first fetch is in flight or once it has already succeeded. A
 *  failed fetch un-latches itself so the NEXT open retries it, and leaves its
 *  error visible in state rather than swallowing it. */
export function openPatternPanel(): void {
  // Only one side panel at a time: taking the dock closes whichever other
  // right-docked panel was open (lib/sidePanels.ts).
  claimSidePanel("patterns");
  set({ open: true });
  if (manifestRequested) return;
  manifestRequested = true;
  fetchFamilies().then(
    (families) => set({ families, familiesError: null }),
    (e: unknown) => {
      manifestRequested = false;
      set({ familiesError: e instanceof Error ? e.message : String(e) });
    },
  );
  listUserPresets().then(
    (userPresets) => set({ userPresets }),
    () => {
      manifestRequested = false;
    },
  );
}

/** Just hides the panel; results (Similar and preset) survive so reopening
 *  finds them intact. Only dismissPatternPanel destroys the Similar result. */
export function closePatternPanel(): void {
  set({ open: false });
}
registerSidePanel("patterns", closePatternPanel);

export function togglePatternPanel(): void {
  if (state.open) closePatternPanel();
  else openPatternPanel();
}

export function setPatternView(v: PatternView): void {
  set({ view: v });
}

export function toggleFamily(key: string): void {
  const selectedFamilies = state.selectedFamilies.includes(key)
    ? state.selectedFamilies.filter((k) => k !== key)
    : [...state.selectedFamilies, key];
  set({ selectedFamilies });
}

export function setFamilyParam(family: string, name: string, value: number): void {
  set({
    paramsByFamily: {
      ...state.paramsByFamily,
      [family]: { ...state.paramsByFamily[family], [name]: value },
    },
  });
}

/** Marks a preset hit row as the selected one (sticky: module-level state, so
 *  it survives the Presets view unmounting on a view switch). */
export function setPresetSelectedHit(key: string | null): void {
  set({ presetSelectedHit: key });
}

/** The deduped chart list a preset scan would send — same dedup rule as the
 *  Similar search's fan-out (epic|resolution, first one wins). Exported so
 *  PresetScanView can gate its Scan button on the same set runPresetScanNow
 *  actually uses, rather than approximating it from the mounted-cell registry
 *  (which only covers the ACTIVE tab, while this spans every open tab). Not
 *  reactive on its own — seriesProvider() is a plain function, not a store
 *  field — so it only reflects the current tab layout on the next render the
 *  store already causes (a new tab opening elsewhere won't flip the button
 *  live; acceptable for v1). */
export function getPresetScanCharts(): { epic: string; resolution: string }[] {
  const seen = new Set<string>();
  const charts: { epic: string; resolution: string }[] = [];
  for (const s of seriesProvider()) {
    const key = `${s.epic}|${s.resolution}`;
    if (seen.has(key)) continue;
    seen.add(key);
    charts.push({ epic: s.epic, resolution: s.resolution });
  }
  return charts;
}

export function runPresetScanNow(broker: string, priceSide: string): void {
  // One scan at a time: a second call while the first is still in flight is
  // ignored outright, unlike the Similar search which supersedes.
  if (state.presetLoading) return;
  const charts = getPresetScanCharts();
  const families = state.selectedFamilies.map((family) => ({
    family,
    params: state.paramsByFamily[family] ?? {},
  }));
  const id = ++presetReqId;
  set({ presetLoading: true, presetError: null });
  runPresetScan({ charts, families, broker, priceSide }).then(
    (presetResult) => {
      if (presetReqId !== id) return;
      // A fresh result set retires the old row selection with the rows it
      // pointed into.
      set({ presetResult, presetLoading: false, presetSelectedHit: null });
    },
    (e: unknown) => {
      if (presetReqId !== id) return;
      set({ presetError: e instanceof Error ? e.message : String(e), presetLoading: false });
    },
  );
}

/** Saves the LAST Similar-search query (module-level `lastRun`, captured at
 *  drag time) as a new user preset. Null with presetError set when there is
 *  nothing to save. */
export async function savePresetFromLastRun(name: string): Promise<UserPreset | null> {
  if (!lastRun) {
    set({ presetError: "run a search before saving it as a preset" });
    return null;
  }
  try {
    const preset = await createUserPreset({
      name,
      epic: lastRun.origin.epic,
      resolution: lastRun.origin.resolution,
      bars: lastRun.bars,
    });
    await refreshUserPresets();
    // A prior failed save may have left presetError set; a subsequent
    // successful one must clear it, or the stale message keeps rendering.
    set({ presetError: null });
    return preset;
  } catch (e) {
    // presetError is the panel's only error surface for the preset half of
    // the store — a failed save must land there too, not just reject silently.
    set({ presetError: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function refreshUserPresets(): Promise<void> {
  try {
    const userPresets = await listUserPresets();
    set({ userPresets });
  } catch {
    // The manifest fetch is best-effort on open; a failed refresh here
    // leaves the previous list in place rather than surfacing an error.
  }
}

export function setPatternArmProvider(fn: (() => void) | null): void {
  armProvider = fn;
}

export function armPatternSelect(): void {
  if (armProvider) armProvider();
}

export function setPatternSelectArmed(v: boolean): void {
  set({ selectArmed: v });
}

/** Test hook: the store is deliberately module-level, so suites must reset it. */
export function resetPatternPanel(): void {
  reqId += 1;
  presetReqId += 1;
  lastRun = null;
  seriesProvider = () => [];
  manifestRequested = false;
  armProvider = null;
  // Spread rather than reusing `initial` directly: selectedFamilies and
  // paramsByFamily are reference types, and toggleFamily/setFamilyParam
  // always build fresh objects — but a future mutation elsewhere must not be
  // able to corrupt the shared reset baseline across the whole suite.
  state = { ...initial, selectedFamilies: [], paramsByFamily: {} };
  listeners.clear();
}
