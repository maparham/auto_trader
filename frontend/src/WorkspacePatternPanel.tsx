// The workspace's ONE pattern-results panel, docked on the right of the whole
// chart area (a flex sibling of .chart-cells inside main.chart). Hosted by App,
// not by a chart cell: the results routinely span every chart in every tab, so
// the panel must survive tab switches, series changes on the origin chart and
// the origin cell closing — nothing but its own ✕ may take it down. It only
// HIDES (state intact) while a replay session is running anywhere: its rows
// carry the real dates a masked session exists to conceal.
import { useSyncExternalStore } from "react";
import PatternMatchesPanel from "./PatternMatchesPanel";
import { toast } from "./lib/notify";
import { capturePattern, MIN_GHOST_BARS } from "./lib/patternGhost";
import { patternClipboard } from "./lib/signals";
import {
  dismissPatternPanel,
  getPatternPanelState,
  setPatternForwardBars,
  setPatternMode,
  setPatternScope,
  subscribePatternPanel,
} from "./lib/patternPanelStore";
import {
  clearPendingPatternJumps,
  getPatternTarget,
  listPatternTargets,
  setPendingPatternJump,
  takePendingPatternJump,
} from "./lib/patternTargets";
import type { PatternMatch } from "./lib/patternSearch";

interface Props {
  timezone: string;
  /** Hide the panel — state intact — rather than render it. App raises this
   *  while a cell on the ACTIVE tab runs a replay session: the rows carry the
   *  real dates a masked session exists to conceal. A session on another tab
   *  does not hide it (nothing it could spoil is on screen). */
  hidden: boolean;
  /** Focus (and flash) the cell, switching to its tab when it lives on another
   *  one. Returns false when no open tab holds the cell any more. */
  onReveal: (cellId: string) => boolean;
}

export default function WorkspacePatternPanel({ timezone, hidden, onReveal }: Props) {
  const st = useSyncExternalStore(subscribePatternPanel, getPatternPanelState);
  if (hidden) return null;
  if (!st.result && !st.loading && !st.error) return null;

  const onJump = (m: PatternMatch) => {
    // Every row jumps through the registry, the origin's included: the panel
    // has no chart of its own. Looked up by series, not just cellId — the cell
    // the match was tagged with may have switched symbol since the search,
    // while another cell still shows the series.
    const src = m.source ?? st.origin;
    if (!src) return;
    const target = [getPatternTarget(src.cellId), ...listPatternTargets()].find(
      (t) => t && t.epic === src.epic && t.resolution === src.resolution,
    );
    if (target) {
      target.showMatch(m);
      onReveal(target.cellId);
      return;
    }
    // The chart lives on another tab (nothing mounted shows the series): park
    // the match and switch there — the cell's mount consumes it. When the cell
    // has left the workspace since the search, take the parked match back.
    setPendingPatternJump(src.cellId, m);
    if (!onReveal(src.cellId)) {
      takePendingPatternJump(src.cellId);
      toast(`no open chart shows ${src.epic} ${src.label} any more`);
    }
  };

  const onCopy = (m: PatternMatch) => {
    // The row already carries the match's bars, so this is capture straight
    // off the result: no jump, no drag, no coverage walk. A row credits the
    // series it was FOUND in.
    const captured = capturePattern(m.bars, {
      epic: m.source?.epic ?? st.origin?.epic ?? "",
      resolution: m.source?.resolution ?? st.origin?.resolution ?? "",
    });
    if (!captured) {
      toast(`a pattern needs at least ${MIN_GHOST_BARS} candles`);
      return;
    }
    patternClipboard.set(captured);
    toast(`copied ${captured.bars.length} candles: paste them anywhere with the pattern tool`);
  };

  const onDismiss = () => {
    const origin = st.origin;
    dismissPatternPanel();
    // The bands this panel had painted: match bands on every cell a row jump
    // reached, the selection band on the cell showing the origin series. Cells
    // on other tabs are unmounted (their charts, bands included, are gone) and
    // simply absent from the registry.
    for (const t of listPatternTargets()) {
      t.clearMatchBands();
      if (origin && t.epic === origin.epic && t.resolution === origin.resolution) {
        t.clearSelectionBand();
      }
    }
    // And any cross-tab jump still waiting for its cell to mount: the results
    // it belongs to are gone.
    clearPendingPatternJumps();
  };

  return (
    <PatternMatchesPanel
      result={st.result}
      loading={st.loading}
      error={st.error}
      epic={st.origin?.epic ?? ""}
      resolution={st.origin?.resolution ?? ""}
      broker={st.broker}
      priceSide={st.priceSide}
      timezone={timezone}
      truncatedTo={st.truncatedTo}
      mode={st.mode}
      onModeChange={setPatternMode}
      forwardBars={st.forwardBars}
      onForwardBarsChange={setPatternForwardBars}
      scope={st.scope}
      onScopeChange={setPatternScope}
      onCopy={onCopy}
      onJump={onJump}
      onDismiss={onDismiss}
    />
  );
}
