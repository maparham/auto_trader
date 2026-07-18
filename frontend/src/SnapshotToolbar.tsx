// The toolbar for a READ-ONLY snapshot view (a tab restored from a saved
// snapshot — controller.readOnly). Where the full Toolbar is a blacklist
// nightmare-in-waiting (every mutating control would need a "not in a snapshot"
// gate), this renders a WHITELIST of the safe, view-only controls:
//   - the symbol chip, fixed (disabled — the snapshot is of this symbol)
//   - the timeframe quick bar + interval menu (re-viewing at another TF is fine)
//   - the A/L/I price-scale toggles (view-only)
//   - the global panel toggles (live / alerts / trading — app panels, not cell
//     mutations) and maximize
//   - the broker selector, only when maximized (the tab bar's copy is hidden)
// Everything mutating (indicators, alerts, templates, snapshots, backtest,
// drawing menu, symbol search) simply doesn't exist here. App renders this
// INSTEAD of Toolbar while the focused cell is a snapshot view; Unlock swaps
// the full Toolbar back in.

import { type Instrument, type Period } from "./lib/feed";
import type { ChartController } from "./lib/chartController";
import BrokerSelector from "./BrokerSelector";
import ComputeHostButton from "./ComputeHostButton";
import type { BrokerAccount } from "./lib/trading";
import {
  SymbolChip,
  IntervalControls,
  ScaleControls,
  PanelToggles,
  MaximizeToggle,
} from "./ToolbarControls";

interface Props {
  controller: ChartController | null;
  symbol?: Instrument;
  period?: Period;
  onPeriod: (p: Period) => void;
  brokerId: string;
  accounts: BrokerAccount[];
  onSelectBroker: (broker: string) => void;
  maximized: boolean;
  onToggleMaximize: () => void;
}

export default function SnapshotToolbar({
  controller,
  symbol,
  period,
  onPeriod,
  brokerId,
  accounts,
  onSelectBroker,
  maximized,
  onToggleMaximize,
}: Props) {
  // Same blank-workspace guard as the full Toolbar (shouldn't happen — a
  // snapshot view always has a symbol/period — but keeps the types honest).
  if (!symbol || !period) {
    return <header className="toolbar toolbar-empty" />;
  }

  return (
    <header className="toolbar">
      {/* The symbol chip, non-clickable: a snapshot is OF this symbol. */}
      <SymbolChip
        symbol={symbol}
        title="Symbol is fixed in a snapshot view (Unlock to change)"
        disabled
      />

      <span className="tb-div" aria-hidden="true" />

      <IntervalControls period={period} onPeriod={onPeriod} />

      <span className="tb-div" aria-hidden="true" />

      <ScaleControls controller={controller} />

      {/* Broker selector — ONLY when maximized (the tab bar's copy is hidden
          then), mirroring the full Toolbar. */}
      {maximized && (
        <BrokerSelector
          accounts={accounts}
          activeBroker={brokerId}
          onChange={onSelectBroker}
        />
      )}

      {/* Also here so a running host (its ~$3/hr cost) stays visible and its
          poll keeps running even while viewing a read-only snapshot. Only one
          toolbar mounts at a time (App renders this OR the full Toolbar), so
          there is never a second poller. */}
      <ComputeHostButton />

      <PanelToggles />
      <MaximizeToggle maximized={maximized} onToggleMaximize={onToggleMaximize} />
    </header>
  );
}
