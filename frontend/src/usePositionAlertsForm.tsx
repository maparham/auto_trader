// SL / TP proximity warnings for one open position: state and Save for the two
// switches (each side has its own ATR multiple; Save creates, patches or deletes
// the side's alert). Shared by PositionAlertModal and the edit ticket's Alerts tab.
import { useEffect, useState, type ReactNode } from "react";
import ProximityWarn from "./components/ProximityWarn";
import {
  addPositionAlert, deletePositionAlert, findPositionAlert, patchPositionAlert, type PositionAlert,
} from "./lib/alertsApi";
import { subscribeTrades, type TradeView } from "./lib/trading";
import { loadSettings } from "./theme";
import type { PositionAlertRequest } from "./lib/signals";

type Side = "sl" | "tp";
interface SideState { on: boolean; mult: number }

function initial(existing: PositionAlert | undefined, dflt: number): SideState {
  return existing ? { on: true, mult: existing.atrMult } : { on: false, mult: dflt };
}
const changed = (st: SideState, ex: PositionAlert | undefined) => st.on !== !!ex || (!!ex && st.mult !== ex.atrMult);

/** State and Save for the two switches. `body` is the switches plus the error. */
export function usePositionAlertsForm({ account, epic, dealId, precision }: PositionAlertRequest): {
  body: ReactNode; save: () => Promise<boolean>; busy: boolean; dirty: boolean;
} {
  const [trade, setTrade] = useState<TradeView | null>(null);
  useEffect(() => subscribeTrades((all) => setTrade(all.find((t) => t.kind === "position" && t.id === dealId) ?? null)), [dealId]);

  const exSl = findPositionAlert(dealId, "sl");
  const exTp = findPositionAlert(dealId, "tp");
  const dflt = loadSettings().proximityAtrMult;
  const [sl, setSl] = useState<SideState>(() => initial(exSl, dflt));
  const [tp, setTp] = useState<SideState>(() => initial(exTp, dflt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Without the live row (another account's position), an existing alert
  // proves its level is set.
  const hasSl = trade ? trade.stop != null : !!exSl;
  const hasTp = trade ? trade.takeProfit != null : !!exTp;
  const trailing = trade?.trailingStop ?? exSl?.trailing ?? false;
  const slReason = trailing ? "Trailing stop: not supported" : !hasSl ? "No SL set" : undefined;
  const tpReason = !hasTp ? "No TP set" : undefined;
  const dirty = (!tpReason && changed(tp, exTp)) || (!slReason && changed(sl, exSl));

  async function apply(side: Side, st: SideState, ex: PositionAlert | undefined, disabled: boolean): Promise<string | null> {
    if (disabled) return null;
    if (st.on && !ex) return addPositionAlert({ account, epic, dealId, side, atrMult: st.mult, precision });
    if (st.on && ex) return st.mult !== ex.atrMult ? patchPositionAlert(ex.id, st.mult) : null;
    if (!st.on && ex) deletePositionAlert(ex.id);
    return null;
  }

  async function save(): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const errs = [
      await apply("tp", tp, exTp, !!tpReason),
      await apply("sl", sl, exSl, !!slReason),
    ].filter((e): e is string => !!e);
    setBusy(false);
    if (errs.length) setError(errs[0]);
    return errs.length === 0;
  }

  const body = (
    <>
      <ProximityWarn
        label="Warn near TP" on={tp.on} mult={tp.mult} disabled={!!tpReason} disabledReason={tpReason}
        onToggle={(on) => setTp((s) => ({ ...s, on }))} onMult={(mult) => setTp((s) => ({ ...s, mult }))}
      />
      <ProximityWarn
        label="Warn near SL" on={sl.on} mult={sl.mult} disabled={!!slReason} disabledReason={slReason}
        onToggle={(on) => setSl((s) => ({ ...s, on }))} onMult={(mult) => setSl((s) => ({ ...s, mult }))}
      />
      {error && <div className="al-error">{error}</div>}
    </>
  );
  return { body, save, busy, dirty };
}
