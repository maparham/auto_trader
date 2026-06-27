// Manual order entry for the active chart symbol — TradingView-style ticket.
// Paper only.
//
// Layout (matches TV): a Sell/Buy quote strip that SELECTS the side and colours
// the action button; Market / Limit / Stop tabs (Stop disabled for now); a Units
// row with a value readout; a collapsible Exits section with Take-profit / Stop-
// loss toggles (price + % distance, never ticks); an Order info block (margin /
// leverage / trade value / reward, from the paper account — approximate); and one
// big side-coloured action button that commits.
//
// Single source of truth: while composing a LIMIT, `draftOrderSignal` holds
// price/SL/TP — the inputs and the draggable chart lines are both views of it,
// never mirrored into local state (avoids the snap-back bug class). A MARKET
// order has no chart lines, so its SL/TP live in local state and submit instantly.

import { useEffect, useRef, useState } from "react";
import {
  applyLevels,
  fetchQuote,
  placeOrder,
  refreshTrades,
  subscribeTrades,
  tradeLabel,
  type Quote,
  type TradeAccount,
  type TradeView,
} from "./lib/trading";
import {
  draftOrderSignal,
  editTradeSignal,
  pendingEditsSignal,
  type DraftOrder,
  type PendingEdit,
} from "./lib/signals";
import { computeOrderInfo, usedMargin } from "./lib/orderInfo";
import { leverageFor, type TradingSettings } from "./theme";

interface Props {
  epic: string;
  account?: TradeAccount;
  precision?: number;
  instrumentType?: string | null;
  trading: TradingSettings;
}

// Real-money accounts are the live env (key "{broker}:live"); the backend enforces
// the same gate, this just drives the extra client-side confirm.
const isRealMoneyAccount = (account: TradeAccount) => account.endsWith(":live");

const QUOTE_POLL_MS = 1500;
const DEFAULT_BRACKET = 0.005; // seed staged SL/TP / limit offset at ±0.5%
type OrderType = "market" | "limit" | "stop";

export default function OrderTicket({
  epic,
  account = "capital:paper",
  precision = 2,
  instrumentType,
  trading,
}: Props) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [quantity, setQuantity] = useState("1");
  const [exitsOpen, setExitsOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  // Synchronous in-flight guard. `disabled={busy}` only blocks the button after a
  // re-render, so a fast double-click can fire submit() twice (and double-fill)
  // before that lands; this ref is set before the first await and gates the second.
  const submittingRef = useRef(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [draft, setDraft] = useState<DraftOrder | null>(null);
  const [positions, setPositions] = useState<TradeView[]>([]);
  const [editId, setEditId] = useState<string | null>(editTradeSignal.value);
  const flash = useRef<number | undefined>(undefined);

  const isLimit = orderType === "limit";
  const round = (n: number) => Number(n.toFixed(precision));
  const fmt = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(precision));

  useEffect(() => draftOrderSignal.subscribe(setDraft), []);
  useEffect(() => subscribeTrades(setPositions), []);
  useEffect(() => editTradeSignal.subscribe(setEditId), []);
  // Clear the staged draft AND any open edit when the ticket unmounts (panel closed).
  useEffect(
    () => () => {
      draftOrderSignal.set(null);
      editTradeSignal.set(null);
    },
    [],
  );

  // The trade being edited, looked up across ALL epics (not just this chart's
  // symbol) — a clicked row can belong to any instrument. While editing, the
  // ticket swaps its new-order form for an edit form rendered from this trade.
  const editTrade = editId ? positions.find((t) => t.id === editId) ?? null : null;

  // The edited trade can vanish mid-edit (a position hits SL/TP, an order fills or
  // is cancelled elsewhere) — it drops from the poll. Fall back to the new-order
  // form rather than render against stale data.
  useEffect(() => {
    if (editId && !positions.some((t) => t.id === editId)) editTradeSignal.set(null);
  }, [editId, positions]);

  // Entering edit mode clears the new-order draft so its lines disappear; leaving
  // edit re-seeds a fresh draft via the maintenance effect below.
  useEffect(() => {
    if (editId) draftOrderSignal.set(null);
  }, [editId]);

  useEffect(() => {
    let alive = true;
    setQuote(null);
    const tick = () =>
      fetchQuote(epic, account)
        .then((q) => alive && setQuote(q))
        .catch(() => alive && setQuote(null));
    tick();
    const id = setInterval(tick, QUOTE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [epic, account]);

  useEffect(() => {
    if (!msg) return;
    window.clearTimeout(flash.current);
    flash.current = window.setTimeout(() => setMsg(null), 4000);
    return () => window.clearTimeout(flash.current);
  }, [msg]);

  const myDraft = draft && draft.epic === epic ? draft : null;
  const mid = quote?.mid ?? null;

  // The draft is the SINGLE SOURCE OF TRUTH for the on-chart lines (entry for a
  // limit; SL/TP for BOTH order types) and the ticket's level fields — so the
  // chart lines and inputs can't drift. Maintain it for the current epic/side/
  // type: rebuild on those changes (re-bracketing any active SL/TP to the new
  // side), but NOT on a mere quote tick (guarded) so a dragged line isn't stomped.
  useEffect(() => {
    if (editId) return; // editing an existing trade — no new-order draft
    if (mid == null) return;
    const d = myDraft;
    if (d && d.side === side && d.type === orderType) return; // stable — leave it
    const long = side === "buy";
    const entry = isLimit
      ? round(long ? mid * (1 - DEFAULT_BRACKET) : mid * (1 + DEFAULT_BRACKET))
      : null;
    const ref = entry ?? mid;
    const seed = (on: boolean, up: boolean) =>
      on ? round(up ? ref * (1 + DEFAULT_BRACKET) : ref * (1 - DEFAULT_BRACKET)) : null;
    draftOrderSignal.set({
      epic,
      side,
      quantity: Number(quantity) || 1,
      type: isLimit ? "limit" : "market",
      price: entry,
      stop: seed(d?.stop != null, !long),
      takeProfit: seed(d?.takeProfit != null, long),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, orderType, epic, mid, editId]);

  // Keep the draft quantity in sync with the Units field.
  useEffect(() => {
    if (myDraft && myDraft.quantity !== (Number(quantity) || 0)) {
      draftOrderSignal.set({ ...myDraft, quantity: Number(quantity) || 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quantity, myDraft]);

  function patchDraft(p: Partial<DraftOrder>) {
    // Read the LIVE signal (not the closed-over `myDraft`) so consecutive patches
    // in the same tick compose instead of clobbering each other.
    const cur = draftOrderSignal.value;
    if (cur && cur.epic === epic) draftOrderSignal.set({ ...cur, ...p });
  }

  // Current levels + on/off all derive from the draft (both order types).
  const entryPrice = isLimit ? myDraft?.price ?? null : mid;
  const tpVal = myDraft?.takeProfit ?? null;
  const slVal = myDraft?.stop ?? null;
  const tpOn = tpVal != null;
  const slOn = slVal != null;

  function bracket(kind: "tp" | "sl"): number {
    const ref = entryPrice ?? mid ?? 0;
    const long = side === "buy";
    const up = kind === "tp" ? long : !long;
    return round(up ? ref * (1 + DEFAULT_BRACKET) : ref * (1 - DEFAULT_BRACKET));
  }

  function toggleExit(kind: "tp" | "sl", on: boolean) {
    patchDraft(
      kind === "tp"
        ? { takeProfit: on ? bracket("tp") : null }
        : { stop: on ? bracket("sl") : null },
    );
  }

  function setExit(kind: "tp" | "sl", value: string) {
    const n = value === "" ? null : Number(value);
    patchDraft(kind === "tp" ? { takeProfit: n } : { stop: n });
  }

  const pct = (level: number | null) =>
    level != null && entryPrice ? ((level - entryPrice) / entryPrice) * 100 : null;

  const cur = trading.accountCurrency;
  const lev = leverageFor(trading, instrumentType ?? undefined);
  const openPositions = positions.filter((t) => t.kind === "position");
  const info = computeOrderInfo({
    quantity: Number(quantity) || 0,
    price: entryPrice,
    stop: slVal,
    takeProfit: tpVal,
    leverage: lev,
    balance: trading.accountBalance,
    usedMargin: usedMargin(openPositions, trading.defaultLeverage),
  });

  async function submit() {
    if (submittingRef.current) return; // a previous click is still in flight
    const qty = Number(quantity);
    if (!epic || !Number.isFinite(qty) || qty <= 0) {
      setMsg("Enter a valid size.");
      return;
    }
    const realMoney = isRealMoneyAccount(account);
    if (realMoney && !confirm(`Place a REAL-money ${side.toUpperCase()} of ${qty} ${epic}?`))
      return;
    submittingRef.current = true;
    setBusy(true);
    setMsg(null);
    try {
      const result = await placeOrder({
        epic,
        side,
        quantity: qty,
        account,
        type: isLimit ? "limit" : "market",
        limit_level: isLimit ? entryPrice : null,
        stop_level: slVal,
        take_profit_level: tpVal,
        confirm: realMoney,
      });
      if (result.status === "rejected") {
        setMsg(`Rejected — ${result.reason || "unknown"}`);
      } else {
        // Clear the draft (its lines hand off to the new position/order's lines);
        // the maintenance effect re-seeds a fresh draft for the next order.
        draftOrderSignal.set(null);
        if (isLimit) {
          setMsg("Limit order placed");
        } else {
          const px = result.fill_price != null ? result.fill_price.toFixed(precision) : "?";
          setMsg(`Filled ${result.filled_quantity} @ ${px}`);
        }
        refreshTrades();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Order failed.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  }

  const spread =
    quote?.bid != null && quote?.ask != null ? (quote.ask - quote.bid).toFixed(precision) : null;
  const actionWord = side === "buy" ? "Buy" : "Sell";
  const actionDetail = isLimit
    ? `${quantity} ${epic} @ ${fmt(entryPrice)} LIMIT`
    : `${quantity} ${epic} MARKET`;

  if (editTrade) {
    // Keyed by id so switching rows remounts (re-seeds the edit state cleanly).
    return (
      <EditTicket key={editTrade.id} trade={editTrade} account={account} precision={precision} />
    );
  }

  return (
    <div className="ot">
      {/* Sell / Buy quote strip — selects the side. */}
      <div className="ot-strip">
        <button
          className={`ot-strip-side ot-strip-sell${side === "sell" ? " on" : ""}`}
          onClick={() => setSide("sell")}
        >
          <span className="ot-strip-label">Sell</span>
          <span className="ot-strip-px num">{fmt(quote?.bid)}</span>
        </button>
        <span className="ot-strip-spread num">{spread ?? ""}</span>
        <button
          className={`ot-strip-side ot-strip-buy${side === "buy" ? " on" : ""}`}
          onClick={() => setSide("buy")}
        >
          <span className="ot-strip-label">Buy</span>
          <span className="ot-strip-px num">{fmt(quote?.ask)}</span>
        </button>
      </div>

      {/* Order type tabs. */}
      <div className="ot-types">
        {([
          ["market", "Market", false],
          ["limit", "Limit", false],
          ["stop", "Stop", true],
        ] as [OrderType, string, boolean][]).map(([t, label, disabled]) => (
          <button
            key={t}
            className={`ot-type-tab${orderType === t ? " on" : ""}`}
            disabled={disabled}
            title={disabled ? "Coming soon" : undefined}
            onClick={() => setOrderType(t)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Limit price. */}
      {isLimit && (
        <label className="ot-field-block">
          <span className="ot-flabel">Price</span>
          <div className="ot-input-row">
            <input
              className="ot-input num"
              type="number"
              step="any"
              value={entryPrice ?? ""}
              onChange={(e) => patchDraft({ price: e.target.value === "" ? null : Number(e.target.value) })}
            />
            {/* Distance of the limit from the CURRENT market (mid), not from
                itself — a buy-limit below market reads negative, sell-limit above
                positive. (pct() is anchored to entry, which is right for TP/SL.) */}
            <span className="ot-input-aux">
              {mid != null && entryPrice != null
                ? `${(((entryPrice - mid) / mid) * 100).toFixed(2)}%`
                : ""}
            </span>
          </div>
        </label>
      )}

      {/* Units + value. */}
      <label className="ot-field-block">
        <span className="ot-flabel">Units</span>
        <div className="ot-input-row">
          <input
            className="ot-input num"
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
          <span className="ot-input-aux num">
            {info ? `${info.tradeValue.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${cur}` : cur}
          </span>
        </div>
      </label>

      {/* Exits. */}
      <div className="ot-exits">
        <button className="ot-exits-head" onClick={() => setExitsOpen((o) => !o)}>
          <span>Exits</span>
          <span className={`ot-chevron${exitsOpen ? " open" : ""}`}>⌄</span>
        </button>
        {exitsOpen && (
          <>
            <ExitRow
              label="Take profit"
              on={tpOn}
              value={tpVal}
              pct={pct(tpVal)}
              onToggle={(on) => toggleExit("tp", on)}
              onChange={(v) => setExit("tp", v)}
            />
            <ExitRow
              label="Stop loss"
              on={slOn}
              value={slVal}
              pct={pct(slVal)}
              onToggle={(on) => toggleExit("sl", on)}
              onChange={(v) => setExit("sl", v)}
            />
          </>
        )}
      </div>

      {/* Order info (approximate, paper account). */}
      {info && (
        <div className="ot-info">
          <div className="ot-info-row">
            <span>Margin</span>
            <span className="num">
              {info.margin.toLocaleString(undefined, { maximumFractionDigits: 2 })} /{" "}
              {info.available.toLocaleString(undefined, { maximumFractionDigits: 2 })} {cur}
            </span>
          </div>
          <div className="ot-info-bar">
            <div
              className={`ot-info-bar-fill${info.overLeveraged ? " over" : ""}`}
              style={{ width: `${info.marginRatio * 100}%` }}
            />
          </div>
          <div className="ot-info-row">
            <span>Leverage</span>
            <span className="num">{lev}:1</span>
          </div>
          <div className="ot-info-row">
            <span>Trade value</span>
            <span className="num">
              {info.tradeValue.toLocaleString(undefined, { maximumFractionDigits: 2 })} {cur}
            </span>
          </div>
          {info.rewardCash != null && (
            <div className="ot-info-row">
              <span>Reward</span>
              <span className="num">
                {info.rewardPct?.toFixed(2)}% /{" "}
                {info.rewardCash.toLocaleString(undefined, { maximumFractionDigits: 2 })} {cur}
                {info.rr != null ? ` · ${info.rr.toFixed(2)}R` : ""}
              </span>
            </div>
          )}
        </div>
      )}

      <button
        className={`ot-action ot-action-${side}`}
        disabled={busy}
        onClick={submit}
      >
        <span className="ot-action-verb">{actionWord}</span>
        <span className="ot-action-detail">{actionDetail}</span>
      </button>

      <div className={`ot-msg${msg ? " show" : ""}`}>{msg ?? ""}</div>
    </div>
  );
}

// Edit form for an existing position or resting order, shown in place of the
// new-order ticket when a panel row is clicked. Single source of truth is
// `pendingEditsSignal[trade.id]` merged over the trade's server levels — so the
// on-chart lines preview every change live (ChartCore renders the same merge),
// and Update writes the merged levels to the broker. A position edits SL/TP; a
// resting order also reprices its entry.
function EditTicket({
  trade,
  account,
  precision,
}: {
  trade: TradeView;
  account: TradeAccount;
  precision: number;
}) {
  const [pending, setPending] = useState<PendingEdit>(
    () => pendingEditsSignal.value[trade.id] ?? {},
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(
    () => pendingEditsSignal.subscribe((p) => setPending(p[trade.id] ?? {})),
    [trade.id],
  );

  // Discard this trade's un-applied edits when the form goes away (switching to
  // another row, or closing the panel) — only Update commits them. Reads the live
  // signal at teardown so an Update that already cleared it is a harmless no-op.
  useEffect(
    () => () => {
      const cur = { ...pendingEditsSignal.value };
      if (trade.id in cur) {
        delete cur[trade.id];
        pendingEditsSignal.set(cur);
      }
    },
    [trade.id],
  );

  const round = (n: number) => Number(n.toFixed(precision));
  const isOrder = trade.kind === "order";
  const long = trade.side === "buy";

  // Merge pending (present field, incl. null = removed) over the server level.
  const has = (k: keyof PendingEdit) => pending[k] !== undefined;
  const price = (has("price") ? pending.price : trade.priceLevel) ?? null;
  const stop = (has("stop") ? pending.stop : trade.stop) ?? null;
  const tp = (has("takeProfit") ? pending.takeProfit : trade.takeProfit) ?? null;
  // Distance reference: a repriced order measures from its (edited) entry; a
  // position from its fixed open level.
  const ref = isOrder ? price ?? trade.priceLevel : trade.priceLevel;

  function patch(p: PendingEdit) {
    const cur = pendingEditsSignal.value;
    pendingEditsSignal.set({ ...cur, [trade.id]: { ...cur[trade.id], ...p } });
  }
  function clearPending() {
    const cur = { ...pendingEditsSignal.value };
    delete cur[trade.id];
    pendingEditsSignal.set(cur);
  }
  function exit() {
    clearPending();
    editTradeSignal.set(null);
  }

  function bracket(kind: "tp" | "sl"): number {
    const up = kind === "tp" ? long : !long;
    return round(up ? ref * (1 + DEFAULT_BRACKET) : ref * (1 - DEFAULT_BRACKET));
  }
  function toggleExit(kind: "tp" | "sl", on: boolean) {
    patch(
      kind === "tp"
        ? { takeProfit: on ? bracket("tp") : null }
        : { stop: on ? bracket("sl") : null },
    );
  }
  function setExit(kind: "tp" | "sl", value: string) {
    const n = value === "" ? null : Number(value);
    patch(kind === "tp" ? { takeProfit: n } : { stop: n });
  }
  const pct = (level: number | null) =>
    level != null && ref ? ((level - ref) / ref) * 100 : null;

  async function update() {
    setBusy(true);
    setMsg(null);
    try {
      await applyLevels(
        trade,
        {
          limit_level: isOrder ? price : null,
          stop_level: stop,
          take_profit_level: tp,
          // The edit form is the authoritative final state, so a null level here
          // means "remove it" (not "leave unchanged" as in the drag path).
          clear_stop: stop == null,
          clear_take_profit: tp == null,
        },
        account,
      );
      refreshTrades();
      exit();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  const word = tradeLabel(trade.kind, trade.side);

  return (
    <div className="ot ot-edit">
      <div className="ot-edit-head">
        <span className="ot-edit-title">
          Editing <span className={long ? "ot-edit-long" : "ot-edit-short"}>{word}</span>{" "}
          {trade.quantity} {trade.epic}
        </span>
        <button className="ot-edit-x" title="Cancel edit" onClick={exit}>
          ✕
        </button>
      </div>

      {/* Entry price — repriceable for a resting order, fixed for a fill. */}
      <label className="ot-field-block">
        <span className="ot-flabel">{isOrder ? "Limit price" : "Entry"}</span>
        <div className={`ot-input-row${isOrder ? "" : " disabled"}`}>
          <input
            className="ot-input num"
            type="number"
            step="any"
            disabled={!isOrder}
            value={price ?? ""}
            onChange={(e) =>
              patch({ price: e.target.value === "" ? null : Number(e.target.value) })
            }
          />
        </div>
      </label>

      <div className="ot-exits">
        <ExitRow
          label="Take profit"
          on={tp != null}
          value={tp}
          pct={pct(tp)}
          onToggle={(on) => toggleExit("tp", on)}
          onChange={(v) => setExit("tp", v)}
        />
        <ExitRow
          label="Stop loss"
          on={stop != null}
          value={stop}
          pct={pct(stop)}
          onToggle={(on) => toggleExit("sl", on)}
          onChange={(v) => setExit("sl", v)}
        />
      </div>

      <div className="ot-edit-actions">
        <button className="ot-action ot-edit-update" disabled={busy} onClick={update}>
          Update {isOrder ? "order" : "position"}
        </button>
        <button className="ot-edit-cancel" disabled={busy} onClick={exit}>
          Cancel
        </button>
      </div>

      <div className={`ot-msg${msg ? " show" : ""}`}>{msg ?? ""}</div>
    </div>
  );
}

function ExitRow({
  label,
  on,
  value,
  pct,
  onToggle,
  onChange,
}: {
  label: string;
  on: boolean;
  value: number | null;
  pct: number | null;
  onToggle: (on: boolean) => void;
  onChange: (v: string) => void;
}) {
  return (
    <div className="ot-exit">
      <div className="ot-exit-head">
        <span className="ot-flabel">{label}, price</span>
        <button
          className={`ot-switch${on ? " on" : ""}`}
          role="switch"
          aria-checked={on}
          onClick={() => onToggle(!on)}
        >
          <span className="ot-switch-knob" />
        </button>
      </div>
      <div className={`ot-input-row${on ? "" : " disabled"}`}>
        <input
          className="ot-input num"
          type="number"
          step="any"
          disabled={!on}
          value={on && value != null ? value : ""}
          placeholder="—"
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="ot-input-aux num">
          {on && pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : ""}
        </span>
      </div>
    </div>
  );
}
