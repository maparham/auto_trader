// Background price-alert engine — the SINGLE firing authority for ALL tabs,
// active and inactive alike. It lives at module scope (App drives it), OUTSIDE
// the ChartCore subtree that remounts on tab switch, so it owns one continuous
// arming state per alert and a `once` alert can never fire twice.
//
// Why it exists: ChartCore only renders the ACTIVE tab, so before this, alerts on
// background tabs never fired. The engine opens one live feed per DISTINCT epic
// across all tabs (deduped), evaluates every tab's saved alerts on each tick via
// the shared pure evaluator, and fires (toast / OS notification / triggered
// history). When it disarms or removes an alert it writes the change back to that
// tab's storage and bumps the alerts signal so the on-chart overlay (active tab)
// can reconcile.
//
// Arming + crossing-baseline state is engine-owned, in-memory, and ID-keyed
// (scope+epic+SavedAlert.id) — NOT content-keyed. Keying by the stable id is what
// lets the engine tell "the same alert moved to a new level" from "a different
// alert": on a move the id is unchanged but the level changes, so we reset that
// alert's baseline (and re-arm it) instead of treating it as a brand-new, armed
// alert evaluated against a stale baseline — the bug that silently deleted dragged
// "once" alerts (see frontend/docs/alert-identity-redesign.md). Move detection is
// done by the engine itself, by diffing a per-id signature each tick, rather than
// by a typed overlay→engine event: alerts also sync between tabs/devices by writing
// storage directly (via /ws/state), and only a storage-diff catches those moves.
//
// Arming is a debounce for "every" alerts (stops micro-jitter at the level re-
// firing); "once" never disarms-without-removing. The crossing baseline is the
// previous price sample for THAT alert (crossings need two). Neither is persisted
// (tick-state doesn't belong in localStorage); on reload every alert starts armed
// with an empty baseline (its first tick re-seeds, so it can't fire on a jump).

import { openLive, type LiveHandle } from "./feed";
import {
  loadAlerts,
  saveAlerts,
  pushTriggered,
  normalizeAlert,
  type ChartTab,
  type SavedAlert,
} from "./persist";
import { evaluateAlert } from "./alertEval";
import { notify, playPing, toast } from "./notify";
import { bumpAlerts } from "./signals";
import type { PriceSide } from "../theme";

// Resolution for the background price feed. Alerts are price-level crossings,
// independent of candle interval, so one fast interval per epic suffices
// regardless of each tab's display timeframe (one feed per epic, not per interval).
const FEED_RESOLUTION = "MINUTE";

interface FeedState {
  handle: LiveHandle;
}

// State-key: scope+epic+id. Keyed by the cell SCOPE (not tab id) so two cells in
// the same tab arm independently; keyed by the alert's stable id (not its content)
// so a level/condition edit MUTATES the alert's state instead of orphaning it.
const stateKey = (scope: string, epic: string, id: string): string =>
  `${scope}|${epic}|${id}`;

// Identity of an alert's firing-relevant config. A change here (level moved, or
// condition/trigger edited) means the alert was reconfigured: reset its baseline so
// the new level can't read as a crossing off a stale sample, and re-arm it.
const alertSig = (a: SavedAlert): string => `${a.level}|${a.condition}|${a.trigger}`;

class AlertEngine {
  private tabs: ChartTab[] = [];
  private feeds = new Map<string, FeedState>(); // epic -> feed
  private armed = new Map<string, boolean>(); // state-key -> armed
  private baseline = new Map<string, number | null>(); // state-key -> prev price sample
  private sig = new Map<string, string>(); // state-key -> last-seen config signature
  private precision = new Map<string, number>(); // epic -> price precision
  // Spread side the alert feeds price against — kept in lockstep with the chart's
  // global setting so an alert fires on the same price the user sees on the chart.
  private priceSide: PriceSide = "mid";

  // Apply the global bid/mid/ask setting. Changing the side shifts every price by
  // ~half a spread, so reopen the feeds AND drop every alert's baseline — the next
  // tick re-seeds each one against the new side, so the jump itself can't read as a
  // crossing. (Baselines are per-alert now, so reopening the feed no longer resets
  // them; clear them explicitly.)
  setPriceSide(side: PriceSide): void {
    if (side === this.priceSide) return;
    this.priceSide = side;
    this.baseline.clear();
    for (const epic of [...this.feeds.keys()]) {
      this.feeds.get(epic)!.handle.close();
      this.openFeed(epic); // replaces the map entry with a fresh feed
    }
  }

  // Re-sync feeds to the current tabs: one feed per distinct epic that has ≥1
  // alert (deduped across ALL cells of ALL tabs); close feeds whose epic no longer
  // needs one. Call whenever tabs change or an alert is added/removed (App bumps it
  // via the alerts signal).
  setTabs(tabs: ChartTab[]): void {
    this.tabs = tabs;
    for (const t of tabs)
      for (const c of t.cells)
        this.precision.set(c.symbol.epic, c.symbol.pricePrecision ?? 2);

    const needed = new Set<string>();
    for (const t of tabs) {
      for (const c of t.cells) {
        if (loadAlerts(c.scope, c.symbol.epic).length > 0) needed.add(c.symbol.epic);
      }
    }
    for (const epic of needed) {
      if (!this.feeds.has(epic)) this.openFeed(epic);
    }
    for (const epic of [...this.feeds.keys()]) {
      if (!needed.has(epic)) {
        this.feeds.get(epic)!.handle.close();
        this.feeds.delete(epic);
      }
    }
  }

  private openFeed(epic: string): void {
    const state: FeedState = { handle: { close: () => {} } };
    state.handle = openLive(
      epic,
      FEED_RESOLUTION,
      (k) => this.onTick(epic, k.close),
      undefined,
      this.priceSide,
    );
    this.feeds.set(epic, state);
  }

  // Evaluate every alert on `epic` (across all tabs showing it) against a tick.
  private onTick(epic: string, price: number): void {
    const feed = this.feeds.get(epic);
    if (!feed) return;
    const now = Date.now();

    // One ping per tick, not per cell: N cells showing the same epic would otherwise
    // each fire playPing() for the same tick, stacking N simultaneous sounds.
    let firedSound = false;

    for (const tab of this.tabs) {
      for (const cell of tab.cells) {
        if (cell.symbol.epic !== epic) continue;
        const alerts = loadAlerts(cell.scope, epic).map(normalizeAlert);
        if (!alerts.length) continue;

        const survivors: SavedAlert[] = [];
        let removed = false;

        for (const a of alerts) {
          const key = stateKey(cell.scope, epic, a.id);
          // Expired alerts are pruned WITHOUT firing (client-side enforcement —
          // only checked while a tab is open). Treated like a fired "once".
          if (a.expiresAt != null && now > a.expiresAt) {
            removed = true;
            this.forget(key);
            continue;
          }
          // Moved / reconfigured? Same id, changed level|condition|trigger. Reset
          // the baseline (so the relocated level needs two fresh samples before it
          // can read as a crossing — no spurious fire off the stale sample) and
          // re-arm (an edited alert may fire again). A first sighting (no prior
          // signature) is NOT a move — it's a new alert, already armed with an
          // empty baseline, which the same two-sample guard already protects.
          const sig = alertSig(a);
          const prevSig = this.sig.get(key);
          if (prevSig !== undefined && prevSig !== sig) {
            this.baseline.set(key, null);
            this.armed.set(key, true);
          }
          this.sig.set(key, sig);

          // Per-alert prev sample (the crossing baseline), advanced every tick.
          const prev = this.baseline.get(key) ?? null;
          this.baseline.set(key, price);

          const armed = this.armed.get(key) ?? true;
          const r = evaluateAlert(prev, price, a.level, {
            condition: a.condition,
            trigger: a.trigger,
            armed,
          });
          if (r.fired) {
            if (a.notify?.sound ?? true) firedSound = true;
            this.fire(epic, a, price);
          }
          if (r.remove) {
            removed = true;
            this.forget(key);
            continue; // dropped from survivors → removed from storage below
          }
          if (r.nextArmed !== armed) this.armed.set(key, r.nextArmed);
          survivors.push(a);
        }

        if (removed) {
          // Persist removal of fired "once" alerts; the active cell's overlay
          // reconciles off the alerts signal (drops lines no longer in storage).
          saveAlerts(cell.scope, epic, survivors);
          bumpAlerts();
        }
      }
    }

    if (firedSound) playPing(); // once, after every cell on this epic is evaluated
  }

  private fire(epic: string, a: SavedAlert, price: number): void {
    const prec = this.precision.get(epic) ?? 2;
    const body = a.message || `${epic} @ ${a.level.toFixed(prec)}`;
    // Per-alert notification channels (absent = all on). The triggered HISTORY
    // below is the record of the firing and is always written, independent of which
    // surfaces the user muted. (Sound is fired by the caller, gated the same way.)
    if (a.notify?.toast ?? true) toast(`🔔 ${body} (now ${price.toFixed(prec)})`);
    if (a.notify?.browser ?? true) notify("Price alert", `${body} — now ${price.toFixed(prec)}`);
    pushTriggered({
      time: Date.now(),
      epic,
      condition: a.condition,
      level: a.level,
      price,
      message: a.message,
      precision: prec,
    });
  }

  // Drop all per-alert state for a key (fired "once", expired, or removed).
  private forget(key: string): void {
    this.armed.delete(key);
    this.baseline.delete(key);
    this.sig.delete(key);
  }

  // Tear everything down (app unmount / HMR dispose).
  stop(): void {
    for (const f of this.feeds.values()) f.handle.close();
    this.feeds.clear();
    this.armed.clear();
    this.baseline.clear();
    this.sig.clear();
  }
}

export const alertEngine = new AlertEngine();
