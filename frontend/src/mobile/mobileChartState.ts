// Mobile chart tab state (spec: 2026-09-07-mobile-companion-design.md, Task 6).
// The current chart instance/controller, symbol and period the mobile chart
// tab is showing. Other mobile tabs (Task 7+) read these to act on "the
// chart the user is looking at" without owning the chart themselves.
import { Signal, requestSymbolSearch } from "../lib/signals";
import type { Chart } from "klinecharts";
import type { ChartController } from "../lib/chartController";
import { DEFAULT_BROKER, periodByResolution, resolveInstrument, type Instrument, type Period } from "../lib/feed";
import { initialMarket, mobileDrawScope } from "../lib/mobileScope";
import { resolveDescriptor } from "../lib/snapshotBoot";
import {
  DEFAULT_ACCOUNT,
  brokerOf,
  cachedBrokers,
  setTradesAccount,
  type TradeAccount,
} from "../lib/trading";
import { load, saveLocal, setPersistBroker } from "../lib/persist/core";
import { bumpMobileWorkspace, flattenCells, mirroredWorkspace } from "./mobileWorkspace";
import { isDemoMode } from "../lib/demoMode";
import { getDemoSnapshot } from "../lib/demoSnapshot";

export interface MobileChartCtx {
  chart: Chart;
  controller: ChartController;
}
export const mobileChartCtx = new Signal<MobileChartCtx | null>(null);
export const mobileSymbol = new Signal<Instrument | null>(null);
export const mobilePeriod = new Signal<Period | null>(null);

// Which drawings scope the mounted chart should use, resolved ONCE per symbol
// at the symbol-select site (setMobileSymbol below) rather than re-resolved on
// every render — ChartCore's controller useMemo keys on `scope` and assumes it
// never changes while the chart stays mounted, so re-resolving it on a render
// that a live-mirrored heartbeat happens to trigger could recreate the
// controller mid-mount. `epic` records which symbol this scope belongs to so a
// stale value can't be read for a symbol it wasn't resolved for.
export const mobileChartScope = new Signal<{ epic: string; scope: string } | null>(null);

// The only place mobileSymbol should be set from: keeps mobileChartScope
// resolved in lockstep with it so every symbol change (boot, symbol search
// pick) carries a freshly-resolved scope, and nothing re-resolves the scope
// mid-mount for the same symbol.
export function setMobileSymbol(
  symbol: Instrument,
  broker: string = mobileBroker(),
  // Explicit scope: the chart strip mirrors a desktop cell and adopts its exact
  // scope (that cell's drawings/indicators), bypassing heartbeat resolution.
  scope?: string,
): void {
  mobileSymbol.set(symbol);
  mobileChartScope.set({
    epic: symbol.epic,
    scope: scope ?? mobileDrawScope(broker, symbol.epic),
  });
  // Each symbol reopens on the timeframe it was last viewed at, on any device:
  // the view heartbeat (lib/viewHeartbeat.ts) records it per symbol, and the
  // mobile chart writes one too (MobileChartView). A strip chip passes its
  // cell's scope and sets that cell's period itself, so it is left alone.
  if (scope) return;
  const d = resolveDescriptor(broker, symbol.epic);
  if (d) {
    mobilePeriod.set(periodByResolution(d.resolution) ?? { resolution: d.resolution, label: d.resolution });
  } else if (!mobilePeriod.value) {
    mobilePeriod.set(periodByResolution("MINUTE_5")!);
  }
}

// --- broker account -----------------------------------------------------------
//
// Which broker account the mobile shell targets: drives the chart feed, symbol
// search, alerts enumeration, the trade tab (via setTradesAccount) and the
// layout-mirror family (via setPersistBroker). Device-local (never synced),
// mirroring desktop's active-account model — see DEVICE_LOCAL_FLAT_KEYS.
export const MOBILE_ACCOUNT_KEY = "auto-trader.mobileAccount";

export const mobileAccount = new Signal<TradeAccount>(DEFAULT_ACCOUNT);

/** Broker id of the current mobile account ("capital:paper" → "capital"). */
export function mobileBroker(): string {
  const b = brokerOf(mobileAccount.value);
  return b || DEFAULT_BROKER;
}

// Point everything that keys off the account at `account`, WITHOUT rebooting
// the chart — shared by boot-time restore (chart not yet mounted) and the
// user-driven switch (which reboots separately).
function applyMobileAccount(account: TradeAccount): void {
  setPersistBroker(brokerOf(account));
  setTradesAccount(account);
  bumpMobileWorkspace(); // layout strip re-reads the new broker family
}

/** Restore the stored account at shell startup (MobileApp, before views mount).
 * A stored account that's no longer registered (backend config changed) falls
 * back to the default rather than pointing the shell at a dead account. */
export function initMobileAccount(): void {
  // The public demo is pinned to the published snapshot's credential-free
  // feed, the same derivation desktop App uses: a stored account belongs to a
  // signed-in session and must not leak in, and the pin is never persisted
  // (MOBILE_ACCOUNT_KEY is not workspace-prefixed, so a ?demo=preview tab
  // would otherwise seed the admin's real phone with `yfinance:data`).
  if (isDemoMode()) {
    const account: TradeAccount = `${getDemoSnapshot()?.broker ?? "dukascopy"}:data`;
    mobileAccount.set(account);
    applyMobileAccount(account);
    return;
  }
  let account = load<TradeAccount>(MOBILE_ACCOUNT_KEY, DEFAULT_ACCOUNT);
  const known = cachedBrokers()?.exec;
  if (known?.length && !known.some((a) => a.key === account)) account = DEFAULT_ACCOUNT;
  mobileAccount.set(account);
  applyMobileAccount(account);
}

/** Boot (or reboot) the chart on `broker`'s freshest heartbeat → first
 * favorite → symbol search. Shared by MobileChartView's mount effect and the
 * account switch below. */
export async function bootMobileMarket(broker: string): Promise<void> {
  // The public demo opens on the published layout's first cell, the curated
  // view, the way desktop does: it has no heartbeat and no favorites, so the
  // usual chain would land a first-time visitor on symbol search.
  if (isDemoMode() && bootFromLayout()) return;
  const m = await initialMarket(broker);
  // A symbol picked while this fetch was in flight wins over the boot default.
  if (mobileSymbol.value) return;
  if (!m) {
    // No heartbeat, no favorites: a mirrored layout cell still beats search.
    if (!bootFromLayout()) requestSymbolSearch();
    return;
  }
  setMobileSymbol(m.symbol, broker);
  mobilePeriod.set(
    periodByResolution(m.resolution) ?? { resolution: m.resolution, label: m.resolution },
  );
}

/** Open the first cell of the mirrored layout (its exact scope, so its
 * drawings and indicators), as tapping that strip chip would. False when no
 * saved layout exists. */
function bootFromLayout(): boolean {
  const mirror = mirroredWorkspace();
  const first = mirror ? flattenCells(mirror.ws)[0] : undefined;
  if (!first) return false;
  setMobileSymbol(first.cell.symbol, undefined, first.cell.scope);
  mobilePeriod.set(first.cell.period);
  return true;
}

/** Show `epic` on the chart tab (a positions row's "Show on chart"). The
 * chart already on it just gets the tab; a mirrored layout cell showing it
 * is adopted as its strip chip would be (exact scope, so its drawings and
 * indicators, and its timeframe); otherwise the epic resolves through the
 * broker catalogue the way desktop's jumpToEpic does (resolveInstrument) and
 * opens on the last-viewed timeframe. `precision` is the decimals guess for
 * an epic the catalogue has no precision for. */
let showEpicSeq = 0;
export async function showMobileEpic(epic: string, precision = 2): Promise<void> {
  // While this waits on the catalogue, a later call (another row) or a broker
  // switch supersedes it; the checks after the await drop the stale answer.
  const seq = ++showEpicSeq;
  if (mobileSymbol.value?.epic !== epic) {
    const mirror = mirroredWorkspace();
    const hit = mirror ? flattenCells(mirror.ws).find((f) => f.cell.symbol.epic === epic) : undefined;
    if (hit) {
      setMobileSymbol(hit.cell.symbol, undefined, hit.cell.scope);
      mobilePeriod.set(hit.cell.period);
    } else {
      const broker = mobileBroker();
      const symbol = await resolveInstrument(epic, broker, precision);
      if (seq !== showEpicSeq || broker !== mobileBroker()) return;
      setMobileSymbol(symbol);
    }
  }
  mobileTabSignal.set("chart");
}

/** Switch the mobile shell to a different broker account (broker sheet). */
export function setMobileAccount(account: TradeAccount): void {
  if (account === mobileAccount.value) return;
  saveLocal(MOBILE_ACCOUNT_KEY, account);
  mobileAccount.set(account);
  applyMobileAccount(account);
  // Reboot the chart on the new broker: clearing symbol+scope unmounts
  // ChartCore (the view early-returns), then the boot lands the new market.
  mobileSymbol.set(null);
  mobileChartScope.set(null);
  void bootMobileMarket(brokerOf(account));
}

// Bumped by MobileSettingsSheet after saveSettings() so MobileChartView can
// re-read loadSettings() and re-theme the mounted chart. ChartCore/klinecharts
// takes `theme` as a plain prop it doesn't watch reactively, and the settings
// sheet only mutates CSS vars + localStorage today — a signal bump is the
// smallest way to make the already-mounted chart notice, without ChartCore
// itself needing to subscribe to theme changes.
export const mobileSettingsVersion = new Signal(0);

// The active tab in the mobile shell's bottom tab bar (moved out of
// MobileApp.tsx so other modules can import it without pulling in a
// component-only module — see react-refresh/only-export-components).
export type MobileTab = "chart" | "alerts" | "positions" | "trade";
export const mobileTabSignal = new Signal<MobileTab>("chart");
