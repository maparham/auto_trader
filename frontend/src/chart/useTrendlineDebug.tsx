// Debug mode interactions for TRENDLINES: a click on any line opens the debug
// popup (in debug mode only), the strip arms reverse lookup (two clicks, or the
// selected trend line drawing), and Apply / Undo write the settings through
// the same coordinator path the Settings form uses.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Chart } from "klinecharts";
import type { OverlayManager } from "../lib/overlays";
import { applyTrendlinesTimeframe } from "../lib/mtfCoordinator";
import { loadIndicatorConfigs, saveIndicatorConfig } from "../lib/persist";
import { parseTrendlinesConfig, type TrendlinesConfig } from "../lib/indicators/trendlinesOutputs";
import type { TrendlinesExtend } from "../lib/indicators/trendlines";
import { findTrendlineSegment, type TrendlineHit } from "../lib/indicators/trendlineMarks";
import {
  cycleDebugGroup, debugLookup, debugState, debugTarget, setDebugSim, setDebugTarget, subscribeDebugAny,
} from "../lib/indicators/trendlinesDebugStore";
import { DBG_KEY_PREFIX, reasonTag } from "../lib/indicators/trendlinesDebugDraw";
import { pickTrendline } from "./useTrendlineMenu";
import { findFix, sideEffects, type FixResult, type SettingChange } from "../lib/indicators/trendlinesDebugFix";
import TrendlineDebugPopup from "../components/TrendlineDebugPopup";
import TrendlineDebugBar from "../components/TrendlineDebugBar";

export interface ApplyCtx { chart: Chart; scope: string; epic: string; brokerId: string; paneId: string; name: string }

/** The saved config's calcParams, or null when there is no saved entry. */
export function savedCalcParams(scope: string, name: string): number[] | null {
  const cp = loadIndicatorConfigs(scope)[name]?.calcParams;
  return Array.isArray(cp) ? cp.map(Number) : null;
}

/** Write `changes` (or, for Undo, `restore` verbatim) to the live instance
 * and the saved config. Returns the calcParams it replaced.
 *
 * The base is the SAVED calcParams, not the live instance's: under a pinned
 * timeframe applyTrendlinesTimeframe only overrides the live calcParams after
 * its bar fetch resolves, so a second apply (or an Undo) during that fetch
 * would read a stale live base and drop the first change. saveIndicatorConfig
 * writes synchronously, so the saved copy is always the latest. */
export function applyDebugChanges(ctx: ApplyCtx, changes: SettingChange[] | null, restore?: number[]): number[] {
  const live = ctx.chart.getIndicators({ paneId: ctx.paneId, name: ctx.name })[0] as
    | { calcParams?: unknown[]; extendData?: TrendlinesExtend } | undefined;
  const saved = loadIndicatorConfigs(ctx.scope)[ctx.name] ?? {};
  const prev = savedCalcParams(ctx.scope, ctx.name) ?? ((live?.calcParams ?? []) as unknown[]).map(Number);
  const cfg: TrendlinesConfig = parseTrendlinesConfig(restore ?? prev, live?.extendData);
  if (changes) for (const c of changes) (cfg as unknown as Record<string, number>)[c.field] = c.to;
  const tf = live?.extendData?.mtf?.timeframe ?? null;
  void applyTrendlinesTimeframe(ctx.chart, ctx.epic, ctx.name, ctx.paneId, cfg, tf, ctx.brokerId);
  saveIndicatorConfig(ctx.scope, ctx.name, { ...saved, calcParams: restore ? [...restore] : Object.values(cfg) });
  return prev;
}

const sameParams = (a: readonly number[] | null, b: readonly number[]) =>
  !!a && a.length === b.length && a.every((v, i) => v === b[i]);

interface Args {
  chartRef: React.MutableRefObject<Chart | null>;
  containerRef: React.RefObject<HTMLElement | null>;
  overlays: OverlayManager;
  scope: string;
  epicRef: React.MutableRefObject<string>;
  brokerIdRef: React.MutableRefObject<string>;
}

interface Open { x: number; y: number; paneId: string; name: string; key: string }
/** `wrote` is what our last Apply saved: when the saved calcParams stop
 * matching it (the Settings form, another device) or the epic changes, the
 * snapshot is stale and Undo is dropped. */
interface Undo { paneId: string; name: string; prev: number[]; wrote: number[]; epic: string }

/** First candle-pane TRENDLINES instance with debug on. */
/** Drawing tools whose first two points are a trend line. */
const TREND_LINE_TOOLS = new Set(["segment", "rayLine", "straightLine"]);

function debugInstance(chart: Chart): { paneId: string; name: string } | null {
  for (const ind of chart.getIndicators({ paneId: "candle_pane" }))
    if (ind.visible !== false && (ind.extendData as TrendlinesExtend | undefined)?.debug) return { paneId: "candle_pane", name: ind.name };
  return null;
}


export function useTrendlineDebug({ chartRef, containerRef, overlays, scope, epicRef, brokerIdRef }: Args): {
  openFor: (hit: TrendlineHit, clientX: number, clientY: number) => boolean;
  popup: ReactNode;
  bar: ReactNode;
} {
  const [open, setOpen] = useState<Open | null>(null);
  const [fix, setFix] = useState<FixResult | null>(null);
  const [fixBusy, setFixBusy] = useState(false);
  const [effects, setEffects] = useState<{ added: number; removed: number } | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [armed, setArmed] = useState<{ first: { t: number; p: number } | null } | null>(null);
  // The client point of an arming press, until its release has passed. The
  // menu's pointerup (registered first, on window) still hit tests that
  // release; openFor must not turn a lookup click into a popup.
  const armPressRef = useRef<{ x: number; y: number } | null>(null);
  // Read on every render: the chart is created after this hook first runs,
  // and the store's notify is what re-renders us once it exists.
  const chart = chartRef.current;
  const subscribe = useCallback((fn: () => void) => subscribeDebugAny(fn), []);
  // Re-render on every landed result; the snapshot names the instance too,
  // so a debug toggle between two results still reads as a change. The
  // popup's instance can be a second debug-on one, so it is named as well.
  const openName = open?.name;
  useSyncExternalStore(subscribe, () => {
    const chart = chartRef.current;
    const i = chart ? debugInstance(chart) : null;
    const strip = chart && i ? `${i.name}:${debugState(chart, i.name).rev}` : "";
    return chart && openName ? `${strip}|${openName}:${debugState(chart, openName).rev}` : strip;
  });

  // The strip belongs to the first debug-on instance; the popup to whichever
  // instance the clicked line came from (open.name).
  const inst = chart ? debugInstance(chart) : null;
  const entry = chart && inst ? debugState(chart, inst.name) : null;
  const res = entry?.result ?? null;
  const input = entry?.input ?? null;
  const openOn = !!(chart && open && (chart.getIndicators({ paneId: open.paneId, name: open.name })[0]
    ?.extendData as TrendlinesExtend | undefined)?.debug);
  const pEntry = chart && open && openOn ? debugState(chart, open.name) : null;
  const pRes = pEntry?.result ?? null;
  const pInput = pEntry?.input ?? null;
  const candKey = open
    ? open.key.startsWith(DBG_KEY_PREFIX) ? open.key.slice(DBG_KEY_PREFIX.length) : open.key
    : null;
  const cand = candKey && pRes ? pRes.byKey.get(candKey) : undefined;

  // Timestamps in the popup result's own bar space: the pinned timeframe's
  // bucket starts when one is set (what the keys and findFix read), else the
  // bars.
  const bars = pInput?.bars;
  const starts = pInput?.starts;
  const times = useMemo(
    () => (starts?.length ? starts : bars ? bars.map((b) => b.timestamp) : []),
    [bars, starts],
  );

  const openFor = useCallback((hit: TrendlineHit, clientX: number, clientY: number): boolean => {
    const c = chartRef.current;
    if (!c) return false;
    const ap = armPressRef.current;
    if (ap && Math.abs(ap.x - clientX) <= 12 && Math.abs(ap.y - clientY) <= 12) {
      armPressRef.current = null;
      return false;
    }
    const ind = c.getIndicators({ paneId: hit.paneId, name: hit.name })[0];
    if (!(ind?.extendData as TrendlinesExtend | undefined)?.debug) return false;
    setOpen({ x: clientX, y: clientY, paneId: hit.paneId, name: hit.name, key: hit.seg.key });
    setFix(null);
    setEffects(null);
    return true;
  }, [chartRef]);

  // Fix search for the open candidate: its own line is the target.
  const sim = pEntry?.sim;
  useEffect(() => {
    setFix(null);
    setEffects(null);
    const input = pInput;
    if (!cand || !input || !sim || cand.drawn) {
      setFixBusy(false);
      return;
    }
    const ctl = new AbortController();
    setFixBusy(true);
    const t1 = times[cand.line.i1];
    const t2 = times[cand.line.i2];
    if (typeof t1 !== "number" || typeof t2 !== "number") {
      setFixBusy(false);
      return;
    }
    findFix(input, { t1, p1: cand.line.p1, t2, p2: cand.line.p2 }, sim, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        setFix(r);
        setFixBusy(false);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setFixBusy(false);
      });
    return () => ctl.abort();
    // The run's KEY, not the input object: a re-explain at a new close hands
    // out a new input every tick, and restarting the search on each would
    // never let it finish.
  }, [cand?.key, pEntry?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // "What else changes?": tied to the open popup. A new candidate, a new run
  // or a close aborts it, and a late answer never lands on another popup.
  const effectsCtl = useRef<AbortController | null>(null);
  useEffect(() => () => {
    effectsCtl.current?.abort();
    effectsCtl.current = null;
  }, [open, pEntry?.key]);

  const ctxOf = (o: { paneId: string; name: string }): ApplyCtx | null =>
    chartRef.current
      ? { chart: chartRef.current, scope, epic: epicRef.current, brokerId: brokerIdRef.current, ...o }
      : null;

  // Esc, or a press outside the popup and the strip, closes the popup. A
  // press on another line closes it too; that line's release reopens it.
  const isOpen = !!open;
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(".tl-dbg-pop, .tl-dbg-bar")) return;
      setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [isOpen]);

  // Lookup arming: Esc cancels; two clicks on the chart set the target.
  const instName = inst?.name;
  const instPane = inst?.paneId;
  useEffect(() => {
    if (!armed) return;
    const el = containerRef.current;
    const c = chartRef.current;
    if (!el || !c || !instName || !instPane) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setArmed(null); };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const r = el.getBoundingClientRect();
      const out = c.convertFromPixel([{ x: e.clientX - r.left, y: e.clientY - r.top }], { paneId: "candle_pane", absolute: true });
      const pt = Array.isArray(out) ? out[0] : out;
      if (typeof pt?.timestamp !== "number" || typeof pt.value !== "number") return;
      // The press is the lookup's: no pan, no pick, no drawing under it.
      e.preventDefault();
      e.stopImmediatePropagation();
      armPressRef.current = { x: e.clientX, y: e.clientY };
      // Registered after the menu's own window listener, so it clears the
      // mark only once that listener has seen the release.
      window.addEventListener("pointerup", () => { armPressRef.current = null; }, { capture: true, once: true });
      if (!armed.first) setArmed({ first: { t: pt.timestamp, p: pt.value } });
      else {
        setDebugTarget(c, instPane, instName, { t1: armed.first.t, p1: armed.first.p, t2: pt.timestamp, p2: pt.value });
        setArmed(null);
      }
    };
    window.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onDown, true);
    };
  }, [armed, containerRef, chartRef, instName, instPane]);

  // Debug turned off: nothing stays armed.
  useEffect(() => {
    if (instName) return;
    setArmed(null);
    setOpen(null);
    setUndo(null);
  }, [instName]);

  const arm = () => {
    const c = chartRef.current;
    if (!c || !inst) return;
    if (armed) {
      setArmed(null);
      return;
    }
    const id = overlays.getSelectedDrawingId();
    const d = id ? overlays.getDrawing(id) : null;
    // Only a two-point line is "the user's line"; a rectangle or fib is not.
    const isLine = !!d && TREND_LINE_TOOLS.has(d.name);
    const pts = d?.points ?? [];
    const [a, b] = pts;
    if (isLine && pts.length >= 2 && typeof a.timestamp === "number" && typeof b.timestamp === "number"
        && typeof a.value === "number" && typeof b.value === "number") {
      setDebugTarget(c, inst.paneId, inst.name, { t1: a.timestamp, p1: a.value, t2: b.timestamp, p2: b.value });
      return;
    }
    setArmed({ first: null });
  };

  const undoLive = undo && undo.epic === epicRef.current && sameParams(savedCalcParams(scope, undo.name), undo.wrote)
    ? undo : null;
  useEffect(() => {
    if (undo && !undoLive) setUndo(null);
  });

  const doUndo = () => {
    if (!undoLive) return;
    const undo = undoLive;
    const ctx = ctxOf(undo);
    if (ctx) applyDebugChanges(ctx, null, undo.prev);
    setUndo(null);
  };

  let popup: ReactNode = null;
  if (open && cand && pRes && pInput) {
    const input = pInput;
    const apply = (changes: SettingChange[]) => {
      const ctx = ctxOf(open);
      if (!ctx || !changes.length) return;
      const prev = applyDebugChanges(ctx, changes);
      const wrote = savedCalcParams(scope, open.name) ?? [];
      const epic = epicRef.current;
      // Undo goes back to before the FIRST apply, however many follow.
      setUndo((u) => (u && u.name === open.name && u.paneId === open.paneId
        ? { ...u, wrote }
        : { paneId: open.paneId, name: open.name, prev, wrote, epic }));
    };
    // The stroke as painted becomes a regular drawing, like the menu's To
    // drawing on a drawn line. Off screen there is no segment to copy.
    // Resolved now, so a line that cannot be copied (both ends in one bar)
    // shows no button rather than one that does nothing.
    const seg = chart ? findTrendlineSegment(chart, open.paneId, open.name, open.key) : null;
    const copy = seg?.clone() ?? null;
    const toDrawing = copy
      ? () => {
        if (overlays.placeFreshDrawing(copy.tool, copy.points)) setOpen(null);
      }
      : null;
    popup = (
      <TrendlineDebugPopup
        x={open.x} y={open.y} res={pRes} cand={cand} times={times}
        fix={fix} fixBusy={fixBusy} effects={effects} canUndo={!!undoLive}
        onApply={apply}
        onApplyAll={() => { if (fix?.covered) apply(fix.changes); }}
        onUndo={doUndo}
        onCheckEffects={() => {
          if (!fix?.covered || !fix.changes.length) return;
          const next = { ...input.cfg };
          for (const ch of fix.changes) (next as unknown as Record<string, number>)[ch.field] = ch.to;
          effectsCtl.current?.abort();
          const ctl = new AbortController();
          effectsCtl.current = ctl;
          void sideEffects(input, next, ctl.signal).then((fx) => {
            if (fx && !ctl.signal.aborted) setEffects(fx);
          });
        }}
        onToDrawing={toDrawing}
        onClose={() => setOpen(null)}
      />
    );
  }

  // The draw's own memo (per result, target and limits), not a second lookup.
  const tgt = entry && input ? debugTarget(entry, input)?.tgt : undefined;
  const lk = entry && res && tgt && !("error" in tgt) ? debugLookup(entry, res, tgt) : null;

  // A strip match: select it on the chart and open its popup by the button.
  const pickMatch = (key: string, rect: DOMRect) => {
    const c = chartRef.current;
    if (!c || !inst) return;
    const k = DBG_KEY_PREFIX + key;
    pickTrendline(c, { paneId: inst.paneId, name: inst.name, key: k });
    setOpen({ x: rect.left, y: rect.top, paneId: inst.paneId, name: inst.name, key: k });
    setFix(null);
    setEffects(null);
  };

  let bar: ReactNode = null;
  if (chart && inst && entry) {
    let lookupMessage: string | null = null;
    if (lk) {
      lookupMessage = lk.covered
        ? "Your line is covered."
        : lk.matches.length
          ? `${lk.matches.length} near ${lk.matches.length === 1 ? "match" : "matches"}. Click one for a fix.`
          : "No candidate near your line. Try a smaller Min Length.";
    }
    bar = (
      <TrendlineDebugBar
        counts={res ? res.counts : []} pivots={res?.rejectedPivots.length ?? 0} hidden={entry.hidden}
        expanded={entry.expanded}
        overflow={res?.overflow ?? 0} armed={armed ? (armed.first ? "second" : "first") : null}
        message={lookupMessage ?? entry.targetError ?? (res ? null : "Computing…")}
        onToggle={(g, n) => cycleDebugGroup(chart, inst.paneId, inst.name, g, n)}
        onArm={arm}
        onClearTarget={entry.target ? () => setDebugTarget(chart, inst.paneId, inst.name, null) : null}
        onUndo={undoLive && !popup ? doUndo : null}
        matches={lk && !lk.covered
          ? lk.matches.slice(0, 5).map((m) => ({ key: m.cand.key, dev: m.dev, cover: m.cover, reason: reasonTag(m.cand) }))
          : undefined}
        onPickMatch={pickMatch}
        sim={entry.target ? entry.sim : null}
        onSim={(next) => setDebugSim(chart, inst.paneId, inst.name, next)}
      />
    );
  }
  return { openFor, popup, bar };
}
