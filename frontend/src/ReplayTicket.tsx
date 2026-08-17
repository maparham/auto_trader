// Order entry for a replay session. Deliberately NOT the app's OrderTicket: that
// one submits to a broker account over HTTP at live prices. This writes to the
// cell's replay ledger at the cursor bar's close.
//
// Presentational, like ReplayPill: it holds only the half-typed form, and every
// decision (what a market order fills at, whether trading is open at all) belongs
// to chart/useReplay.ts. It stays open across steps by design, so it is NOT an
// outside-click-dismissed popover: the user clicks the chart to read a price
// mid-ticket, and losing a half-filled ticket to that would be its own bug. The
// explicit ✕ is the only way out.
import { useState } from "react";
import Tooltip from "./components/Tooltip";

interface Props {
  /** Cursor bar close: what a market order fills at. */
  mark: number | null;
  precision: number;
  /** False while the cursor is rewound behind the high-water mark. */
  canTrade: boolean;
  /** Formatted high-water time to return to (already masked when masked). */
  returnTo: string;
  onPlace(a: {
    side: "buy" | "sell";
    quantity: number;
    type: "market" | "limit";
    price: number | null;
    stop: number | null;
    takeProfit: number | null;
  }): void;
  onClose(): void;
}

export default function ReplayTicket({ mark, precision, canTrade, returnTo, onPlace, onClose }: Props) {
  const [type, setType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [stop, setStop] = useState("");
  const [tp, setTp] = useState("");

  // Empty means "no level" and is legitimate everywhere: an absent stop, an
  // absent target, a limit that defaults to the mark. GARBAGE is not, and must
  // never be flattened into either of those. `Number("1,5")` and
  // `Number("1.2.3")` are NaN, which `??` does not catch — so a decimal comma in
  // Limit used to rest an order at NaN (`bar.low <= NaN` is false, so it could
  // never fill) and the same slip in Stop used to leave the position with no stop
  // at all. Silently changing someone's risk is the last thing a tool for
  // practising risk should do, so a field that has text in it but is not a finite
  // number blocks the submit and is marked, rather than being quietly dropped.
  const num = (v: string): number | null => {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const bad = (v: string) => v.trim() !== "" && num(v) === null;
  const invalid = bad(qty) || bad(stop) || bad(tp) || (type === "limit" && bad(price));
  const fieldClass = (v: string) => `rt-input${bad(v) ? " rt-bad" : ""}`;

  const submit = (side: "buy" | "sell") => {
    if (invalid) return;
    onPlace({
      side,
      quantity: Math.max(1, num(qty) ?? 1),
      type,
      price: type === "limit" ? num(price) : null,
      stop: num(stop),
      takeProfit: num(tp),
    });
  };

  return (
    <div className="replay-ticket">
      <div className="rt-head">
        <span>Replay trade</span>
        <button className="rt-close" aria-label="Close ticket" onClick={onClose}>
          ✕
        </button>
      </div>

      {!canTrade && (
        <div className="rt-locked">
          Rewound: step forward to {returnTo} to trade. Trades already taken stand.
        </div>
      )}

      <div className="rt-row">
        <div className="seg rt-seg">
          <button className={type === "market" ? "seg-on" : ""} onClick={() => setType("market")}>
            Market
          </button>
          <button className={type === "limit" ? "seg-on" : ""} onClick={() => setType("limit")}>
            Limit
          </button>
        </div>
        <span className="rt-mark">{mark != null ? mark.toFixed(precision) : "-"}</span>
      </div>

      <div className="rt-row">
        <label className="rt-label">Units</label>
        <input className={fieldClass(qty)} aria-label="Units" value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      {type === "limit" && (
        <div className="rt-row">
          <label className="rt-label">Limit</label>
          <input className={fieldClass(price)} aria-label="Limit" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
      )}
      <div className="rt-row">
        <label className="rt-label">Stop</label>
        <input className={fieldClass(stop)} aria-label="Stop" value={stop} onChange={(e) => setStop(e.target.value)} />
      </div>
      <div className="rt-row">
        <label className="rt-label">Target</label>
        <input className={fieldClass(tp)} aria-label="Target" value={tp} onChange={(e) => setTp(e.target.value)} />
      </div>
      {invalid && <div className="rt-invalid">Check the highlighted field: use a plain number (2451.5).</div>}

      <div className="rt-actions">
        <Tooltip content="Sell at the current replay price">
          <button className="rt-sell" disabled={!canTrade || mark == null || invalid} onClick={() => submit("sell")}>
            Sell
          </button>
        </Tooltip>
        <Tooltip content="Buy at the current replay price">
          <button className="rt-buy" disabled={!canTrade || mark == null || invalid} onClick={() => submit("buy")}>
            Buy
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
