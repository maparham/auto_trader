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

import { openLive, DEFAULT_BROKER, type LiveHandle } from "./feed";
import {
  loadAlerts,
  loadAlertsRaw,
  deleteStoredAlert,
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

// State-key: epic+id. Alerts are GLOBAL per instrument (no cell scope), so one
// arming/baseline entry exists per alert regardless of how many tabs show the epic.
// Keyed by the alert's stable id (not its content) so a level/condition edit
// MUTATES the alert's state instead of orphaning it.
const stateKey = (epic: string, id: string): string => `${epic}|${id}`;

// Identity of an alert's firing-relevant config. A change here (level moved, or
// condition/trigger edited) means the alert was reconfigured: reset its baseline so
// the new level can't read as a crossing off a stale sample, and re-arm it.
const alertSig = (a: SavedAlert): string => `${a.level}|${a.condition}|${a.trigger}`;

class AlertEngine {
  private feeds = new Map<string, FeedState>(); // epic -> feed
  private armed = new Map<string, boolean>(); // state-key -> armed
  private baseline = new Map<string, number | null>(); // state-key -> prev price sample
  private sig = new Map<string, string>(); // state-key -> last-seen config signature
  private precision = new Map<string, number>(); // epic -> price precision
  // Hot-path cache: epic -> {raw stored JSON, normalized list}. onTick fires per
  // price tick, so reparsing + re-normalizing the alert list every time is pure
  // main-thread garbage. Cache the normalized list and reuse it while the raw stored
  // string is unchanged; any writer (this engine, a peer cell, /ws/state) flips the
  // string and forces a single reparse. Per-tick steady state is getItem + a compare.
  private alertCache = new Map<string, { raw: string; normalized: SavedAlert[] }>();
  // Spread side the alert feeds price against — kept in lockstep with the chart's
  // global setting so an alert fires on the same price the user sees on the chart.
  private priceSide: PriceSide = "mid";
  // Active data broker the alert feeds stream from — kept in lockstep with the
  // chart's active broker (epics are broker-specific). Defaults to "capital".
  private brokerId: string = DEFAULT_BROKER;

  // Apply the active broker. Epics are broker-specific, so a broker change means
  // every open feed is now pointed at the wrong upstream: reopen them against the
  // new broker and drop baselines so the price discontinuity can't read as a
  // crossing (mirrors setPriceSide).
  setBrokerId(brokerId: string): void {
    if (brokerId === this.brokerId) return;
    this.brokerId = brokerId;
    this.baseline.clear();
    for (const epic of [...this.feeds.keys()]) {
      this.feeds.get(epic)!.handle.close();
      this.openFeed(epic); // replaces the map entry with a fresh feed
    }
  }

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

  // Re-sync feeds to the current tabs: one feed per distinct OPEN epic that has ≥1
  // alert; close feeds whose epic no longer needs one. Alerts are global per epic,
  // but we still only feed epics that are on-screen somewhere (a closed symbol has
  // no chart to fire onto). Call whenever tabs change or an alert is added/removed
  // (App bumps it via the alerts signal).
  setTabs(tabs: ChartTab[]): void {
    for (const t of tabs)
      for (const c of t.cells)
        this.precision.set(c.symbol.epic, c.symbol.pricePrecision ?? 2);

    const needed = new Set<string>();
    for (const t of tabs) {
      for (const c of t.cells) {
        if (loadAlerts(c.symbol.epic, this.brokerId).length > 0) needed.add(c.symbol.epic);
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
      this.brokerId,
    );
    this.feeds.set(epic, state);
  }

  // The epic's normalized alert list for this tick, served from cache while the raw
  // stored JSON is unchanged (see alertCache). Only a write — by this engine, a peer
  // cell, or /ws/state — changes the string and triggers a single reparse+normalize.
  private alertsForTick(epic: string): SavedAlert[] {
    const raw = loadAlertsRaw(epic, this.brokerId) ?? "";
    const cached = this.alertCache.get(epic);
    if (cached && cached.raw === raw) return cached.normalized;
    const normalized = loadAlerts(epic, this.brokerId).map((a, i) => normalizeAlert(a, i));
    this.alertCache.set(epic, { raw, normalized });
    return normalized;
  }

  // Evaluate every alert on `epic` against a tick. Alerts are global per epic, so we
  // load the single stored list ONCE (no per-cell loop) — that's also what keeps a
  // "once" alert from firing N times when N tabs show the same epic.
  private onTick(epic: string, price: number): void {
    const feed = this.feeds.get(epic);
    if (!feed) return;
    const now = Date.now();

    const alerts = this.alertsForTick(epic);
    if (!alerts.length) return;

    let firedSound = false;
    // Ids removed this tick (fired "once" / expired). Removed by a by-id delete
    // intent below — never a whole-list saveAlerts(survivors) overwrite, so a
    // concurrent user/peer edit on this epic can't be clobbered by the engine
    // re-writing a stale survivor list. The engine never ADDS alerts.
    const removedIds: string[] = [];

    for (const a of alerts) {
      const key = stateKey(epic, a.id);
      // Expired alerts are pruned WITHOUT firing (client-side enforcement —
      // only checked while a tab is open). Treated like a fired "once".
      if (a.expiresAt != null && now > a.expiresAt) {
        removedIds.push(a.id);
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
        removedIds.push(a.id);
        this.forget(key);
        continue; // removed from storage by id below
      }
      if (r.nextArmed !== armed) this.armed.set(key, r.nextArmed);
    }

    if (removedIds.length) {
      // Remove each fired "once"/expired alert by id (loop if a tick removed more
      // than one); the active cell's overlay reconciles off the alerts signal
      // (drops lines no longer in storage).
      for (const id of removedIds) deleteStoredAlert(epic, id, this.brokerId);
      bumpAlerts();
    }

    if (firedSound) playPing(); // once per tick, regardless of how many tabs show it
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
      alertId: a.id,
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
    this.alertCache.clear();
  }
}

export const alertEngine = new AlertEngine();
