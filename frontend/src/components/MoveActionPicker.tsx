// "Then" row of the indicator and line alert modals: notify only, or move one
// open position's SL or TP once the alert fires. Admin only, since move rules
// are admin-only on the server.
import { useEffect, useMemo, useState } from "react";
import InfoTip from "./InfoTip";
import NumberField from "./NumberField";
import Tooltip from "./Tooltip";
import { accountLabel, type MoveTarget } from "../lib/alertsApi";
import { getTradesAccount, isAdminAccount, subscribeTrades, type TradeView } from "../lib/trading";

export interface MovePick {
  field: "sl" | "tp";
  /** "" until a position is chosen. */
  dealId: string;
  account: string;
  target: MoveTarget;
}

interface Props {
  epic: string;
  value: MovePick | null;
  onChange: (v: MovePick | null) => void;
  precision?: number;
  /** Edit mode of a saved rule: the position and field stay, only the target changes. */
  locked?: boolean;
}

const TIP = [
  "Moves the level once, when this alert fires.",
  "Only tightens. Never loosens your SL or TP.",
];
const TRAILING_TIP = "Trailing stop: SL can't be moved";

/** Open positions on `epic` from the shared trades feed. */
export function useEpicPositions(epic: string): TradeView[] {
  const [trades, setTrades] = useState<TradeView[]>([]);
  useEffect(() => subscribeTrades(setTrades), []);
  return useMemo(() => trades.filter((t) => t.kind === "position" && t.epic === epic), [trades, epic]);
}

/** True when an admin has at least one open position on `epic` (trades feed snapshot). */
export function hasMovablePosition(trades: TradeView[], epic: string): boolean {
  return isAdminAccount() && trades.some((t) => t.kind === "position" && t.epic === epic);
}

export function positionText(account: string, t: TradeView, precision?: number): string {
  const entry = precision != null ? t.priceLevel.toFixed(precision) : String(t.priceLevel);
  return `${accountLabel(account)} ${t.side === "buy" ? "Long" : "Short"} ${t.quantity} @ ${entry}`;
}

export default function MoveActionPicker({ epic, value, onChange, precision, locked = false }: Props) {
  const positions = useEpicPositions(epic);
  const account = getTradesAccount();
  const field = value?.field ?? null;
  const eligible = (t: TradeView, f: "sl" | "tp") => !(f === "sl" && t.trailingStop);

  useEffect(() => {
    // A move chosen before a position (the Trendlines menu preselect): take the first fit.
    if (!value || value.dealId || locked) return;
    const first = positions.find((t) => eligible(t, value.field));
    if (first) onChange({ ...value, dealId: first.id, account });
  }, [value, positions, account, locked, onChange]);

  if (!isAdminAccount() && !locked) return null;

  const step = precision != null ? 10 ** -precision : undefined;
  const chosen = value ? positions.find((t) => t.id === value.dealId) : undefined;
  const hasTrailing = field === "sl" && positions.some((t) => t.trailingStop);

  function pickField(next: string) {
    if (next === "notify") return onChange(null);
    const f = next as "sl" | "tp";
    const keep = value && positions.find((t) => t.id === value.dealId && eligible(t, f));
    onChange({
      field: f, dealId: keep ? keep.id : "", account: keep ? value!.account : account,
      target: value?.target ?? { type: "breakeven", offset: 0 },
    });
  }

  return (
    <div className="al-field">
      <span>Then</span>
      <div className="al-cond al-sentence">
        <select className="al-operator" aria-label="Then" value={field ?? "notify"} disabled={locked}
          onChange={(e) => pickField(e.target.value)}>
          <option value="notify">Notify</option>
          <option value="sl">Move SL</option>
          <option value="tp">Move TP</option>
        </select>
        {value && (
          <>
            {locked ? (
              <span className="al-subject">
                {chosen ? positionText(value.account, chosen, precision) : `Position ${value.dealId}`}
              </span>
            ) : (
              <select className="al-operator" aria-label="Position" value={value.dealId}
                onChange={(e) => onChange({ ...value, dealId: e.target.value, account })}>
                {!value.dealId && <option value="">Choose a position</option>}
                {positions.map((t) => (
                  <option key={t.id} value={t.id} disabled={!eligible(t, value.field)}>
                    {positionText(account, t, precision)}{eligible(t, value.field) ? "" : " (trailing)"}
                  </option>
                ))}
              </select>
            )}
            <select className="al-operator" aria-label="Move target" value={value.target.type}
              onChange={(e) => onChange({
                ...value,
                target: e.target.value === "price"
                  ? { type: "price", value: chosen?.priceLevel ?? 0 }
                  : { type: "breakeven", offset: 0 },
              })}>
              <option value="breakeven">Breakeven</option>
              <option value="price">Price</option>
            </select>
            {value.target.type === "breakeven" ? (
              <>
                <span className="al-subject">Offset</span>
                <NumberField className="al-value" ariaLabel="Move offset" value={value.target.offset} step={step}
                  onChange={(n) => onChange({ ...value, target: { type: "breakeven", offset: Math.max(0, n) } })} />
              </>
            ) : (
              <NumberField className="al-value" ariaLabel="Move price" value={value.target.value} step={step}
                onChange={(n) => onChange({ ...value, target: { type: "price", value: n } })} />
            )}
          </>
        )}
        <InfoTip title="Then" text={TIP} />
      </div>
      {hasTrailing && (
        <Tooltip content={TRAILING_TIP}>
          <span className="al-note">Trailing stop positions are disabled</span>
        </Tooltip>
      )}
    </div>
  );
}
