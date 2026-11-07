// Writing drawings to storage and keeping their anchors stable: bar-interval
// math, index <-> timestamp points, older-bar prepends, and persist().
import type { KLineData, Overlay, DeepPartial, OverlayStyle } from "klinecharts";
import { saveDrawings, type SavedOverlay } from "../persist";
import { RESOLUTION_SECONDS } from "../feed";
import { asDrawingExtra, cloneStyles } from "./shared";
import { SNAP_TOOLS, canonicalize, snapDisplayTs, snapsDiffer, type PointSnap } from "./pointSnap";
import { OverlayManagerBase } from "./base";

export abstract class OverlayPersistence extends OverlayManagerBase {
  // The CANONICAL (unfaded) styles for a drawing — `ov.styles` while solid, or the
  // stashed pre-fade value while it's a ghost. `ov.styles` on a ghosted overlay holds
  // the faded rgba, so every reader that copies/persists a drawing's styles (persist,
  // getDrawing, setExtend) MUST go through this, or a clone/extend/save of a currently-
  // ghosted drawing would bake the faded color in as if it were the real one.
  protected canonicalStyles(id: string, ov: Overlay): DeepPartial<OverlayStyle> | null | undefined {
    // While a drawing is picker-hovered its live `ov.styles` carries the transient
    // thick emphasis — never let persist/getDrawing/clone snapshot that. Return the
    // stashed pre-emphasis style instead (same shielding role fadedStyles plays below).
    if (id === this.emphasizedDrawingId) return this.emphasisBase;
    if (this.fadedStyles.has(id)) return this.fadedStyles.get(id);
    // klinecharts mutates `ov.styles` IN PLACE on overrideOverlay (verified empirically —
    // see cloneStyles above), and every caller here (getDrawing, setExtend, persist) wants
    // a snapshot "by value" that a later style edit must not retroactively corrupt. Clone
    // it so callers never alias the live, mutable object.
    return cloneStyles(ov.styles);
  }

  // One bar's width in ms at the current resolution; falls back to the loaded
  // bars' own spacing for resolutions the table doesn't know.
  protected barIntervalMs(): number | null {
    const secs = RESOLUTION_SECONDS[this.resolution];
    if (secs) return secs * 1000;
    const dl = this.chart?.getDataList() ?? [];
    for (let i = dl.length - 1; i > 0; i--) {
      const g = dl[i].timestamp - dl[i - 1].timestamp;
      if (g > 0) return g;
    }
    return null;
  }

  // Storage → chart: rewrite any timestamp beyond the last loaded bar as an
  // extrapolated dataIndex so the anchor keeps its future x-offset.
  protected materializePoints(points?: SavedOverlay["points"]): SavedOverlay["points"] | undefined {
    if (!points) return points;
    const dl = this.chart?.getDataList() ?? [];
    const last = dl[dl.length - 1];
    const interval = this.barIntervalMs();
    if (!last || !interval) return points;
    return points.map((p) =>
      p.timestamp != null && p.timestamp > last.timestamp
        ? { dataIndex: dl.length - 1 + Math.round((p.timestamp - last.timestamp) / interval), value: p.value }
        : p,
    );
  }

  // THE one way to prepend older bars outside klinecharts' own Forward loader.
  // Prepending renumbers every bar's dataIndex. Timestamped points re-resolve at
  // paint time, but a beyond-data point is dataIndex-ONLY (materializePoints
  // strips the timestamp), and a full setBars is an INIT-type change, where
  // klinecharts never shifts but still BACK-FILLS point.timestamp from whatever
  // bar now sits at the stale index, permanently pinning a future anchor onto a
  // historical bar. So the shift MUST run before the data lands: the pre-shifted
  // index stays beyond the data and the back-fill leaves the point
  // timestamp-less. Housing this here (not at the call sites) makes the ordering
  // structural — a new paging consumer can't get it wrong. Native Forward loads
  // (the scroll-back callback) don't come through here; since v10 dropped the
  // internal shift (v9's updatePointPosition), they shift via the facade's
  // onForwardPrepend hook, installed in attach().
  applyOlderBars(merged: KLineData[]): void {
    if (!this.chart || !this.dataFacade) return;
    this.shiftIndexAnchoredPoints(merged.length - this.chart.getDataList().length);
    // This re-serve is an INIT that overwrites klinecharts' load-more flags, so
    // canLoadOlder must stay true or native scroll-back paging is disarmed for
    // the session (the facade owns the v10 flag translation).
    this.dataFacade.setBars(merged, true);
    this.refreshSnapDisplay();
  }

  // Older bars just landed: a magnet-snapped point whose bar was not loaded
  // when its drawing was built sits on that bar's open (the fallback), so
  // re-place every untouched snapped point now that more history is here.
  // Display only: storage already holds the bar open, so nothing persists.
  refreshSnapDisplay(): void {
    if (!this.chart) return;
    const bars = this.chart.getDataList();
    const ms = this.barIntervalMs() ?? 0;
    for (const [id, disp] of this.snapDisplay) {
      const ov = this.byId(id);
      const snaps = asDrawingExtra(ov?.extendData).snaps;
      const pts = ov?.points;
      if (!ov || !snaps || !pts) continue;
      let changed = false;
      const next = pts.map((p, i) => {
        const s = snaps[i];
        const d = disp[i];
        if (!s || d == null || p.timestamp !== d || p.value !== s.v) return p;
        const ts = snapDisplayTs(s, bars, ms);
        if (ts === d) return p;
        disp[i] = ts;
        changed = true;
        return { ...p, timestamp: ts };
      });
      if (!changed) continue;
      // A trade box's stop rides its target's time.
      if (ov.name === "tradeBox" && next.length >= 3 && next[1].timestamp != null)
        next[2] = { ...next[2], timestamp: next[1].timestamp };
      this.chart.overrideOverlay({ id, points: next as Overlay["points"] });
      // An untouched point, moved by us: not a user move.
      this.snapBase.set(id, next.map((p) => ({ timestamp: p.timestamp, dataIndex: p.dataIndex, value: p.value })));
    }
  }

  // The drawing settings' Cancel puts a drawing's points back as they were
  // shown when the modal opened; its snaps must come back with them, or the
  // restored point would read as a fresh placement and snap on THIS timeframe.
  restoreSnaps(id: string, snaps: Array<PointSnap | null> | undefined, shown: ReadonlyArray<{ timestamp?: number; value?: number }>): void {
    const ov = this.byId(id);
    if (!ov || !this.chart || !SNAP_TOOLS.has(ov.name)) return;
    const ext = asDrawingExtra(ov.extendData);
    const next = { ...ext, snaps };
    if (!snaps) delete next.snaps;
    this.chart.overrideOverlay({ id, extendData: next });
    this.snapDisplay.set(
      id,
      shown.map((p, i) => (snaps?.[i] && p.value === snaps[i]!.v && p.timestamp != null ? p.timestamp : null)),
    );
  }

  // Prepending older bars renumbers every bar's dataIndex; dataIndex-only points
  // must shift along to keep their bar-offset past the last candle. (Live APPENDS
  // never renumber existing bars — no shift needed there.) See applyOlderBars.
  shiftIndexAnchoredPoints(delta: number): void {
    if (!this.chart || !(delta > 0)) return;
    // Every kind: alerts are value-only (no dataIndex, so the predicate below
    // skips them naturally) and the transient measure ruler CAN have a beyond-data
    // endpoint — it must shift too or a prepend pins it onto a historical bar.
    for (const id of this.entries.keys()) {
      const ov = this.byId(id);
      const pts = ov?.points;
      if (!pts?.some((p) => p.timestamp == null && p.dataIndex != null)) continue;
      this.chart.overrideOverlay({
        id,
        points: pts.map((p) =>
          p.timestamp == null && p.dataIndex != null
            ? { ...p, dataIndex: p.dataIndex + delta }
            : p,
        ) as Overlay["points"],
      });
    }
  }

  // Chart → storage: stable anchors only. A raw dataIndex is a position into THIS
  // session's loaded window (wrong after any reload), so points that have a
  // timestamp keep just that — but a beyond-data point (no timestamp) must have its
  // dataIndex converted to an extrapolated timestamp, not dropped: dropping it
  // strips the anchor's x entirely and the next rehydrate pins it to the left edge.
  private stablePoints(points: Overlay["points"] | undefined): SavedOverlay["points"] {
    const dl = this.chart?.getDataList() ?? [];
    const lastIdx = dl.length - 1;
    const interval = this.barIntervalMs();
    return (points ?? []).map((p) => {
      let ts = p.timestamp;
      if (ts == null && p.dataIndex != null && lastIdx >= 0 && interval) {
        const idx = Math.round(p.dataIndex);
        if (idx > lastIdx) ts = dl[lastIdx].timestamp + (idx - lastIdx) * interval;
        else if (idx < 0) ts = dl[0].timestamp + idx * interval;
        else ts = dl[idx].timestamp;
      }
      return { timestamp: ts, value: p.value };
    });
  }

  // A multi-anchor drawing (fib, trendline, segment, rectangle…) is DEGENERATE when
  // its anchors collapse onto one x, or one anchor lost its x while another kept it.
  // Both render as a zero-width vertical strip (or pin an endpoint to the left edge)
  // with no clickable body — the user can neither select nor delete it: the "stuck
  // half-drawn tool" bug. Two observed shapes, both caught here:
  //   • fib whose two clicks hit the SAME bar → every point shares one timestamp.
  //   • straight line saved with a second point that has value only, no x anchor.
  // We flag a 2+-point drawing when a point has no value (can't render), when some
  // points carry an x anchor and others don't (inconsistent), or when every point
  // resolves to the same x (collapsed). Symmetric x-less points are NOT flagged —
  // that's the test-fixture shorthand and never a real finished-overlay shape.
  protected static isDegenerateDrawing(
    points: ReadonlyArray<{ timestamp?: number; dataIndex?: number; value?: number }> | undefined,
  ): boolean {
    const pts = points ?? [];
    if (pts.length < 2) return false;
    const xKeys = new Set<string>();
    let anchored = 0;
    for (const p of pts) {
      if (p.value == null) return true; // no y anchor — cannot render
      if (p.timestamp != null) { xKeys.add(`t${p.timestamp}`); anchored++; }
      else if (p.dataIndex != null) { xKeys.add(`d${Math.round(p.dataIndex)}`); anchored++; }
    }
    if (anchored === 0) return false; // symmetric x-less shorthand — leave it alone
    if (anchored < pts.length) return true; // inconsistent: an anchor lost its x
    return xKeys.size < 2; // all anchored on one vertical — zero horizontal extent
  }

  // persist() is DRAWINGS-ONLY. Alerts are never written from the chart's in-memory
  // snapshot — they mutate through the by-id storage intents (addStoredAlert /
  // updateStoredAlert / deleteStoredAlert) at each user-intent site instead. That is
  // the alert-write decoupling: a redraw/rehydrate/drawing action produces no alert
  // write, so it structurally cannot stomp the shared per-epic alert list. See
  // docs/superpowers/specs/2026-07-08-alert-write-decoupling-design.md.
  protected persist(): void {
    if (this.hydrating || !this.chart) return;
    // Guard the symbol-change window: setEpic() advanced this.epic but the old
    // epic's overlays are still in `entries` until rehydrate() rebuilds. Writing now
    // would save the OLD overlays under the NEW epic's drawings key.
    if (this.hydratedEpic !== this.epic) return;
    const drawings: SavedOverlay[] = [];
    for (const [id, kind] of this.entries) {
      // Alerts don't persist here (by-id intents own their writes); transient
      // overlays never persist at all.
      if (kind === "alert" || kind === "measure" || kind === "rangeBand" || kind === "slope") continue;
      const ov = this.byId(id);
      if (!ov) continue;
      // Never write a collapsed/incomplete drawing to storage — it reloads as an
      // unclickable, undeletable strip (see isDegenerateDrawing). Check the LIVE
      // points, not stablePoints(): a valid future anchor keeps its dataIndex here
      // (an anchor), but stablePoints() can't resolve it to a timestamp when no bars
      // are loaded and would make the drawing look degenerate and drop it.
      if (OverlayPersistence.isDegenerateDrawing(ov.points)) continue;
      // Stable anchors only (timestamp/value) — see stablePoints for why a
      // beyond-data anchor's dataIndex becomes an extrapolated timestamp.
      let points = this.stablePoints(ov.points);
      let extendData = ov.extendData;
      // Magnet-snapped points (pointSnap.ts): an untouched one goes back to its
      // own bar open, never the candle it is shown on here, and a point placed
      // or dragged on this chart records its snap afresh.
      if (SNAP_TOOLS.has(ov.name)) {
        const ext = asDrawingExtra(ov.extendData);
        const c = canonicalize(
          ov.name,
          ov.points ?? [],
          points,
          ext.snaps,
          this.snapDisplay.get(id),
          this.chart.getDataList(),
          this.resolution,
          this.snapBase.get(id),
        );
        points = c.points as SavedOverlay["points"];
        this.snapDisplay.set(id, c.display);
        this.snapBase.set(id, (ov.points ?? []).map((p) => ({ timestamp: p.timestamp, dataIndex: p.dataIndex, value: p.value })));
        if (snapsDiffer(ext.snaps, c.snaps)) {
          const next = { ...ext, snaps: c.snaps.some(Boolean) ? c.snaps : undefined };
          if (!next.snaps) delete next.snaps;
          extendData = next;
          this.chart.overrideOverlay({ id, extendData: next });
        }
      }
      drawings.push({
        id,
        name: ov.name,
        points,
        // The stashed canonical style while this id is a ghost (faded interval/
        // auto-hide stub) — ov.styles is the FADED color in that state, and
        // persist() must never write that; see canonicalStyles/fadedStyles.
        styles: this.canonicalStyles(id, ov) ?? undefined,
        lock: this.userLock(id, ov),
        // Persist INTENT, not the live (effective) flag — the overlay's `visible`
        // is interval-filtered, so reading it here would corrupt the user's choice
        // when they save while on a filtered interval. extendData carries intent.
        visible: asDrawingExtra(ov.extendData).userVisible ?? true,
        zLevel: ov.zLevel,
        extendData,
      });
    }
    saveDrawings(this.scope, this.epic, drawings);
  }
}
