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

import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import {
  applyEditedLevels,
  mergeTradeLevels,
  clampLevelToPrice,
  clampStopToEntry,
  stopPastEntry,
  breakevenEligible,
  breakevenTargetEligible,
  getLivePrice,
  fetchQuote,
  placeOrder,
  refreshTrades,
  subscribeTrades,
  tradeLabel,
  type AccountSummary,
  type Quote,
  type TradeAccount,
  type TradeView,
} from "./lib/trading";
import {
  draftOrderSignal,
  editTradeSignal,
  pendingEditsSignal,
  setTradeSelected,
  type DraftOrder,
  type PendingEdit,
} from "./lib/signals";
import { computeOrderInfo, usedMargin } from "./lib/orderInfo";
import { leverageFor, type PriceSide, type TradingSettings } from "./theme";
import {
  atrMultiple,
  levelFromAtr,
  normalizeAtrLength,
  useExitAtrPrefs,
  useLatestAtr,
  type ExitAtrPrefs,
  type ExitUnit,
} from "./lib/exitAtr";
import { periodByResolution } from "./lib/feed";
import type { KLineData } from "klinecharts";
import Tooltip from "./components/Tooltip";
import ExpirySelect from "./components/ExpirySelect";
import { expiryToApi, isValidExpiry } from "./lib/expiry";

interface Props {
  epic: string;
  account?: TradeAccount;
  precision?: number;
  instrumentType?: string | null;
  trading: TradingSettings;
  // The active account's real balance/available/currency for a live account
  // (null for paper). When present, the Margin line shows the broker's true
  // figures instead of the configured paper balance.
  accountSummary?: AccountSummary | null;
  // True while the FOCUSED chart cell is inside a chart-replay session. This
  // ticket is the terminus of every chart-side "edit this trade" gesture (see
  // lib/signals setTradeSelected -> tradePanelOpen), and both of the things it
  // does are wrong during a session:
  //
  //  - a replay ledger id is in no account book, so `editTrade` resolves null and
  //    what renders is the LIVE new-order form: a real-money submit one click
  //    from a trade the user placed for practice, at prices with no relationship
  //    to the bars on screen (the same failure lib/chartOrderMenu.ts was lifted
  //    out of ChartCore to prevent for the axis menu), and
  //  - the quote strip polls the broker and prints today's bid/ask for the very
  //    instrument being replayed, which is where price actually ended up.
  //
  // The chart-side gates stop the panel being OPENED by a practice trade; this
  // one is why it cannot show a live quote or a submit button even when the user
  // opens it themselves from the toolbar. Fail closed: a session in progress is
  // worth more than a ticket.
  replaying?: boolean;
  // The focused chart's timeframe, price side and data broker: an exit set in
  // ATRs measures ATR(length) on the same bars the user is looking at.
  resolution?: string;
  priceSide?: PriceSide;
  brokerId?: string;
  // The focused chart's loaded bars (it shows `epic`), read for the ATR so
  // it matches the chart without a fetch.
  chartCandles?: () => KLineData[] | undefined;
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
  accountSummary,
  replaying = false,
  resolution,
  priceSide = "mid",
  brokerId,
  chartCandles,
}: Props) {
  // A chart-staged draft (the price-axis "+" menu's Buy/Sell limit items) is placed
  // on draftOrderSignal BEFORE this ticket mounts; seed local state from it (same-epic
  // only — the signal is app-global) so the maintenance effect honors the clicked
  // side/type/price instead of rebuilding a default market draft over it.
  const seededDraft =
    draftOrderSignal.value?.epic === epic ? draftOrderSignal.value : null;
  const [side, setSide] = useState<"buy" | "sell">(seededDraft?.side ?? "buy");
  const [orderType, setOrderType] = useState<OrderType>(
    seededDraft?.type === "limit" ? "limit" : "market",
  );
  const [quantity, setQuantity] = useState("1");
  const [exitsOpen, setExitsOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  // Synchronous in-flight guard. `disabled={busy}` only blocks the button after a
  // re-render, so a fast double-click can fire submit() twice (and double-fill)
  // before that lands; this ref is set before the first await and gates the second.
  const submittingRef = useRef(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [draft, setDraft] = useState<DraftOrder | null>(draftOrderSignal.value);
  const [positions, setPositions] = useState<TradeView[]>([]);
  const [editId, setEditId] = useState<string | null>(editTradeSignal.value);
  const flash = useRef<number | undefined>(undefined);
  // Real-money confirm is a two-step arm on the action button, NOT window.confirm:
  // the Tauri shell renders in WKWebView (wry), which never shows JS dialogs, so
  // confirm() silently returns false there and the button would look dead.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | undefined>(undefined);
  const disarm = () => {
    window.clearTimeout(armTimer.current);
    setArmed(false);
  };

  // An armed confirm is for one exact order: any change to its shape (or the
  // account it would hit) drops back to the unarmed button.
  useEffect(() => {
    disarm();
    return () => window.clearTimeout(armTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, quantity, epic, orderType, account]);

  const isLimit = orderType === "limit";
  const round = (n: number) => Number(n.toFixed(precision));
  const fmt = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(precision));

  useEffect(
    () =>
      draftOrderSignal.subscribe((d) => {
        setDraft(d);
        // Adopt an externally injected draft's side/type (chart Buy/Sell limit menu,
        // fired while the panel is already open) so the maintenance effect doesn't
        // rebuild over the seeded level. Same-epic only. Loop-safe: the ticket's own
        // draft writes always carry the current side/type, so these setters no-op.
        if (d && d.epic === epic) {
          setSide(d.side);
          setOrderType(d.type === "limit" ? "limit" : "market");
        }
      }),
    [epic],
  );
  // StrictMode's phantom mount→unmount→remount fires the draft-clearing cleanup below
  // ONCE on mount, nulling a draft the chart injected before opening (React state is
  // preserved, so the ticket still renders right — but the on-chart entry line, which
  // the chart draws from the signal, vanishes). Re-assert the seed after mount so the
  // line shows immediately. No-op in production (no phantom unmount) and when unseeded.
  useEffect(() => {
    if (seededDraft) draftOrderSignal.set(seededDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The account book, for the edit lookup below. Not subscribed while replaying:
  // the ticket renders none of it then, and the vanish guard further down would
  // read a ledger id as a trade that disappeared.
  useEffect(() => {
    if (replaying) return;
    return subscribeTrades(setPositions);
  }, [replaying]);
  useEffect(() => editTradeSignal.subscribe(setEditId), []);
  // Clear the staged draft AND any open edit when the ticket unmounts (panel closed).
  useEffect(
    () => () => {
      // Only clear the staged DRAFT here. Deselecting on panel-close is owned by an
      // App effect watching the panel-open flag — doing it in this unmount cleanup
      // misfires under React StrictMode (which runs the cleanup once on mount),
      // wiping the selection the instant the panel opens.
      draftOrderSignal.set(null);
    },
    [],
  );

  // The trade being edited, looked up across ALL epics (not just this chart's
  // symbol) — a clicked row can belong to any instrument. While editing, the
  // ticket swaps its new-order form for an edit form rendered from this trade.
  const editTrade = editId ? positions.find((t) => t.id === editId) ?? null : null;

  // Exits in ATRs (new-order form). The edit form runs its own fetch for the
  // edited trade's epic. Nothing is fetched while replaying (blind session).
  const [atrPrefs, setAtrPrefs] = useExitAtrPrefs();
  const atrValue = useLatestAtr({
    epic,
    resolution,
    length: atrPrefs.length,
    priceSide,
    brokerId,
    enabled: !replaying && !editTrade && (atrPrefs.tp === "atr" || atrPrefs.sl === "atr"),
    chartCandles,
  });

  // The edited trade can vanish mid-edit (a position hits SL/TP, an order fills or
  // is cancelled elsewhere) — it drops from the poll. Fall back to the new-order
  // form rather than render against stale data. Guard on a NON-EMPTY book: when the
  // panel first opens from a chart selection its trades haven't loaded yet (empty
  // list), and firing this then would instantly clear the just-made selection.
  // Never while REPLAYING. A replay ledger id is in no account book by
  // definition, so this guard would read every practice trade as one that
  // vanished and drop the selection the user just made on the chart — taking its
  // pill, which IS the replay trade UI, with it. (The sidebar can be open from
  // the toolbar independently of the chart selection, so this fires even though
  // nothing of the account is rendered.)
  useEffect(() => {
    if (replaying) return;
    if (editId && positions.length > 0 && !positions.some((t) => t.id === editId)) {
      setTradeSelected(null);
    }
  }, [editId, positions, replaying]);

  // Entering edit mode clears the new-order draft so its lines disappear; leaving
  // edit re-seeds a fresh draft via the maintenance effect below.
  useEffect(() => {
    if (editId) draftOrderSignal.set(null);
  }, [editId]);

  useEffect(() => {
    let alive = true;
    setQuote(null);
    // A blind session must not have today's price fetched on its behalf, let
    // alone shown: the poll stays stopped for as long as one is running, and the
    // null it leaves behind is what the render below falls back on.
    if (replaying) return;
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
  }, [epic, account, replaying]);

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
      expiresAt: d?.expiresAt ?? null,
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
    // A row in ATR mode starts 1 ATR out, so the field reads 1.00.
    if (atrPrefs[kind] === "atr" && atrValue != null && ref) {
      return levelFromAtr(ref, 1, atrValue, up, precision);
    }
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

  // A live account shows the broker's true figures; paper falls back to the
  // configured balance/currency (accountSummary is null for the paper sim).
  const cur = accountSummary?.currency ?? trading.accountCurrency;
  const lev = leverageFor(trading, instrumentType ?? undefined);
  const openPositions = positions.filter((t) => t.kind === "position");
  const info = computeOrderInfo({
    quantity: Number(quantity) || 0,
    price: entryPrice,
    stop: slVal,
    takeProfit: tpVal,
    leverage: lev,
    balance: accountSummary?.balance ?? trading.accountBalance,
    usedMargin: usedMargin(openPositions, trading.defaultLeverage),
    available: accountSummary?.available,
  });

  async function submit() {
    if (submittingRef.current) return; // a previous click is still in flight
    const qty = Number(quantity);
    if (!epic || !Number.isFinite(qty) || qty <= 0) {
      setMsg("Enter a valid size.");
      return;
    }
    const expMs = isLimit ? myDraft?.expiresAt ?? null : null;
    if (!isValidExpiry(expMs, Date.now())) {
      setMsg("Expiration must be in the future.");
      return;
    }
    const realMoney = isRealMoneyAccount(account);
    if (realMoney && !armed) {
      setArmed(true);
      window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(false), 5000);
      return;
    }
    disarm();
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
        expires_at: expiryToApi(expMs),
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

  // Replay session on the focused cell: no live quote, no dealing form, and an
  // explanation instead. Refusing outright rather than rendering a disabled
  // ticket, because a greyed-out copy of a real-money form beside a practice
  // chart is exactly the ambiguity that made this a bug in the first place; the
  // session has its own ticket on the chart, and an existing practice trade is
  // edited from its pill. Placed after every hook (rules of hooks) but before
  // BOTH real returns, so neither the edit form nor the new-order form can render.
  if (replaying) {
    return (
      <div className="ot ot-replay-off">
        <p className="ot-replay-title">Replay session running</p>
        <p className="ot-replay-body">
          Live dealing is off while this chart replays past bars, and the live price is
          hidden so the session stays blind.
        </p>
        <p className="ot-replay-body">
          Use the replay ticket on the chart (the session pill's Trade button) to place
          practice orders, and a trade's own pill to move or close it. Exit the session to
          deal on your account again.
        </p>
      </div>
    );
  }

  if (editTrade) {
    // Keyed by id so switching rows remounts (re-seeds the edit state cleanly).
    return (
      <EditTicket
        key={editTrade.id}
        trade={editTrade}
        account={account}
        precision={precision}
        resolution={resolution}
        priceSide={priceSide}
        brokerId={brokerId}
        // Only the focused chart's own symbol can borrow its bars.
        chartCandles={editTrade.epic === epic ? chartCandles : undefined}
      />
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
          <Tooltip key={t} content={disabled ? "Coming soon" : undefined}>
            <button
              className={`ot-type-tab${orderType === t ? " on" : ""}`}
              disabled={disabled}
              onClick={() => setOrderType(t)}
            >
              {label}
            </button>
          </Tooltip>
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

      {isLimit && (
        <ExpirySelect
          value={myDraft?.expiresAt ?? null}
          onChange={(ms) => patchDraft({ expiresAt: ms })}
        />
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
              atr={exitAtrView(atrPrefs, setAtrPrefs, "tp", atrValue, entryPrice, side === "buy", precision, resolution)}
            />
            <ExitRow
              label="Stop loss"
              on={slOn}
              value={slVal}
              pct={pct(slVal)}
              onToggle={(on) => toggleExit("sl", on)}
              onChange={(v) => setExit("sl", v)}
              atr={exitAtrView(atrPrefs, setAtrPrefs, "sl", atrValue, entryPrice, side === "buy", precision, resolution)}
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
        className={`ot-action ot-action-${side}${armed ? " ot-action-armed" : ""}`}
        disabled={busy}
        onClick={submit}
      >
        <span className="ot-action-verb">{armed ? `Confirm ${actionWord}` : actionWord}</span>
        <span className="ot-action-detail">
          {armed ? `real money · ${actionDetail}` : actionDetail}
        </span>
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
  resolution,
  priceSide,
  brokerId,
  chartCandles,
}: {
  trade: TradeView;
  account: TradeAccount;
  precision: number;
  resolution?: string;
  priceSide: PriceSide;
  brokerId?: string;
  chartCandles?: () => KLineData[] | undefined;
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
  const { price, stop, takeProfit: tp } = mergeTradeLevels(trade, pending);
  // Distance reference: a repriced order measures from its (edited) entry; a
  // position from its fixed open level.
  const ref = isOrder ? price ?? trade.priceLevel : trade.priceLevel;

  // Exits in ATRs, measured on the edited trade's own epic (a clicked row can
  // belong to any instrument) at the focused chart's timeframe.
  const [atrPrefs, setAtrPrefs] = useExitAtrPrefs();
  const atrValue = useLatestAtr({
    epic: trade.epic,
    resolution,
    length: atrPrefs.length,
    priceSide,
    brokerId,
    enabled: atrPrefs.tp === "atr" || atrPrefs.sl === "atr",
    chartCandles,
  });

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
    setTradeSelected(null);
  }

  // Default SL/TP when first toggled on: a fixed % away from the reference, then
  // clamped to the valid side of that same reference so it can never start on the
  // wrong side (long SL below / TP above; short reversed) — the rule that bounds
  // dragging. The reference is the order's own LIMIT for a resting order (its SL/TP
  // measure from where it will fill, not from today's market), the LATEST price for
  // an open position (so the bracket starts a sensible distance from the market now).
  function bracket(kind: "tp" | "sl"): number {
    const latest = getLivePrice(trade.epic);
    const reference = isOrder ? ref : latest;
    const base = reference ?? ref;
    const up = kind === "tp" ? long : !long;
    // A row in ATR mode starts 1 ATR from the entry (what its multiple measures
    // from), then takes the same clamps as the % seed.
    let v =
      atrPrefs[kind] === "atr" && atrValue != null
        ? levelFromAtr(ref, 1, atrValue, up, precision)
        : round(up ? base * (1 + DEFAULT_BRACKET) : base * (1 - DEFAULT_BRACKET));
    if (reference != null) {
      const tick = Number((10 ** -precision).toFixed(precision));
      v = round(clampLevelToPrice(kind === "sl" ? "stop" : "tp", trade.side, reference, v, tick));
    }
    // A position in profit measures its default stop from a market that has already
    // run past the fill, so the % offset can land on the profit side — pull it back
    // to the entry, the same bound dragging enforces.
    if (kind === "sl" && !isOrder) v = clampStopToEntry(trade.side, trade.priceLevel, v, precision);
    return v;
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

  // A typed SL/TP must stay on the valid side of the latest price (long: SL below /
  // TP above; short reversed). When set on the wrong side we flag the field red,
  // show why, and block Update — rather than bounce off the broker. Price source: the
  // live stream when available, else the broker's own mark from the positions poll,
  // else the price backed out of the uPnL (so validation still works between live
  // ticks). The mark comes first because a live account's uPnL is in the account
  // currency and may carry swap, so the backed-out price can sit far off. null →
  // can't judge → skip (let the broker have the final say).
  const mark =
    trade.kind === "position" && trade.upnl != null && trade.quantity > 0
      ? trade.priceLevel + (long ? 1 : -1) * (trade.upnl / trade.quantity)
      : null;
  const latest = getLivePrice(trade.epic) ?? trade.mark ?? mark;
  const sideValid = (field: "stop" | "tp", level: number | null): boolean => {
    if (level == null || latest == null) return true;
    const below = field === "stop" ? long : !long;
    return below ? level < latest : level > latest;
  };
  // Second rule for an open position's stop: it may not sit past the ENTRY, where it
  // stops being a stop LOSS (long at or below the fill, short at or above). Dragging
  // clamps to this; a typed value flags red and blocks Update, like the price rule.
  const stopBeyondEntry =
    !isOrder && stop != null && stopPastEntry(trade.side, trade.priceLevel, stop, precision);
  const stopValid = sideValid("stop", stop) && !stopBeyondEntry;
  // "Set to breakeven": stage SL exactly at the fill (rounded to precision). Offered
  // only for an in-profit open position whose rounded entry is a valid stop (see
  // breakevenEligible) — so clicking can never stage a stop the broker would reject.
  const canBreakeven = breakevenEligible(trade, latest, precision);
  const setBreakeven = () => patch({ stop: round(trade.priceLevel) });
  // "Set target to breakeven": stage TP exactly at the fill for a LOSING position, so
  // it exits flat when price recovers to entry. Offered only when the rounded entry is
  // a valid take-profit (see breakevenTargetEligible) — mutually exclusive with the
  // stop-breakeven button (a position can't be both in profit and at a loss).
  const canBreakevenTarget = breakevenTargetEligible(trade, latest, precision);
  const setBreakevenTarget = () => patch({ takeProfit: round(trade.priceLevel) });
  const tpValid = sideValid("tp", tp);
  const levelError = stopBeyondEntry
    ? `Stop loss must be ${long ? "below" : "above"} the entry price (${trade.priceLevel.toFixed(precision)})`
    : latest == null
      ? null
      : !stopValid
        ? `Stop loss must be ${long ? "below" : "above"} the current price (${latest.toFixed(precision)})`
        : !tpValid
          ? `Take profit must be ${long ? "above" : "below"} the current price (${latest.toFixed(precision)})`
          : null;

  // Resolved expiry: the pending edit if the user touched it this session, else
  // carried forward from the order's current value — sent on EVERY update (not
  // just on change) because IG/Capital's amend REPLACES the order, so a
  // level-only edit that omitted expiry would silently downgrade a GTD order
  // back to GTC.
  const mergedExpiry = pending.expiresAt !== undefined ? pending.expiresAt : (trade.expiresAt ?? null);
  const expiryValid = !isOrder || isValidExpiry(mergedExpiry, Date.now());
  const expiryError = expiryValid ? null : "Expiration must be in the future.";

  async function update() {
    if (isOrder && !isValidExpiry(mergedExpiry, Date.now())) {
      setMsg("Expiration must be in the future.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await applyEditedLevels(trade, { price, stop, takeProfit: tp, expiresAt: mergedExpiry }, account);
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
        <Tooltip content="Cancel edit">
          <button className="ot-edit-x" onClick={exit}>
            ✕
          </button>
        </Tooltip>
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

      {isOrder && (
        <ExpirySelect
          value={pending.expiresAt !== undefined ? pending.expiresAt : (trade.expiresAt ?? null)}
          onChange={(ms) => patch({ expiresAt: ms })}
        />
      )}

      <div className="ot-exits">
        <ExitRow
          label="Take profit"
          on={tp != null}
          value={tp}
          pct={pct(tp)}
          invalid={!tpValid}
          onToggle={(on) => toggleExit("tp", on)}
          onChange={(v) => setExit("tp", v)}
          onBreakeven={canBreakevenTarget ? setBreakevenTarget : undefined}
          breakevenTip="Move the take-profit to your entry price, so the trade closes flat if price recovers to entry."
          atr={exitAtrView(atrPrefs, setAtrPrefs, "tp", atrValue, ref, long, precision, resolution)}
        />
        <ExitRow
          label="Stop loss"
          on={stop != null}
          value={stop}
          pct={pct(stop)}
          invalid={!stopValid}
          // A position's stop may not step past its entry (see stopPastEntry); a
          // working order's measures from its own unfilled limit, so no bound.
          min={!isOrder && !long ? round(trade.priceLevel) : undefined}
          max={!isOrder && long ? round(trade.priceLevel) : undefined}
          onToggle={(on) => toggleExit("sl", on)}
          onChange={(v) => setExit("sl", v)}
          onBreakeven={canBreakeven ? setBreakeven : undefined}
          breakevenTip="Move the stop-loss to your entry price, so the trade can't turn into a loss from here."
          atr={exitAtrView(atrPrefs, setAtrPrefs, "sl", atrValue, ref, long, precision, resolution)}
        />
      </div>

      <div className="ot-edit-actions">
        <button
          className="ot-action ot-edit-update"
          disabled={busy || levelError != null || expiryError != null}
          onClick={update}
        >
          Update {isOrder ? "order" : "position"}
        </button>
        <button className="ot-edit-cancel" disabled={busy} onClick={exit}>
          Cancel
        </button>
      </div>

      <div className={`ot-msg${msg || levelError || expiryError ? " show ot-msg-err" : ""}`}>
        {msg ?? levelError ?? expiryError ?? ""}
      </div>
    </div>
  );
}

/** The ATR half of an exit row's props, shared by the new-order and edit forms. */
function exitAtrView(
  prefs: ExitAtrPrefs,
  setPrefs: (p: Partial<ExitAtrPrefs>) => void,
  kind: "tp" | "sl",
  atr: number | null,
  ref: number | null,
  long: boolean,
  precision: number,
  resolution: string | undefined,
): ExitAtrView {
  return {
    unit: prefs[kind],
    onUnit: (u) => setPrefs({ [kind]: u }),
    length: prefs.length,
    onLength: (n) => setPrefs({ length: n }),
    atr,
    ref,
    up: kind === "tp" ? long : !long,
    precision,
    tfLabel: resolution ? periodByResolution(resolution)?.label ?? null : null,
  };
}

// A number input that keeps the user's raw text while it has focus, so a
// derived value (an ATR multiple recomputed from the rounded level, or a length
// that rejects "") can't fight the keystrokes; it resyncs from `value` on blur.
function BufferedNumberInput({
  value,
  format,
  onCommit,
  ...rest
}: {
  value: number | null;
  format: (n: number) => string;
  onCommit: (n: number) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      {...rest}
      type="number"
      value={text ?? (value != null ? format(value) : "")}
      onFocus={(e) => {
        setText(value != null ? format(value) : "");
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        setText(null);
        rest.onBlur?.(e);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n)) onCommit(n);
      }}
    />
  );
}

/** What an exit row needs to show and take its level in ATRs. */
export interface ExitAtrView {
  unit: ExitUnit;
  onUnit: (u: ExitUnit) => void;
  length: number;
  onLength: (n: number) => void;
  atr: number | null; // latest ATR(length); null while loading or unavailable
  ref: number | null; // the price the multiple measures from (entry / limit)
  up: boolean; // the exit's valid side (long TP / short SL sit above ref)
  precision: number;
  tfLabel: string | null; // the timeframe the ATR is computed on
}

function ExitRow({
  label,
  on,
  value,
  pct,
  invalid = false,
  min,
  max,
  onToggle,
  onChange,
  onBreakeven,
  breakevenTip,
  atr,
}: {
  label: string;
  on: boolean;
  value: number | null;
  pct: number | null;
  invalid?: boolean;
  // Hard bounds for the native stepper arrows (a browser refuses to step past
  // them). TYPING can still land outside, which `invalid` + the message below the
  // form catch — this only stops a click from walking the value somewhere the
  // form would then reject.
  min?: number;
  max?: number;
  onToggle: (on: boolean) => void;
  onChange: (v: string) => void;
  // When set, an inline "Set Breakeven" button sits next to the toggle — offered
  // only when moving this level to entry is valid (SL for a winner, TP for a loser).
  onBreakeven?: () => void;
  breakevenTip?: string; // hover text for that button
  atr?: ExitAtrView;
}) {
  const atrMode = atr?.unit === "atr";
  // ATR mode needs a live ATR and a reference price; without them the field is
  // read-only (the level itself is still a valid price, so Update isn't blocked).
  const atrReady = atrMode && atr.atr != null && atr.ref != null;
  const multiple =
    atrReady && value != null ? atrMultiple(value, atr.ref!, atr.atr!, atr.up) : null;
  const pctText = pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "";
  const atrTip = atr
    ? [
        `ATR(${atr.length})${atr.tfLabel ? ` on ${atr.tfLabel}` : ""}: ${
          atr.atr != null ? atr.atr.toFixed(atr.precision) : "n/a"
        }`,
        "Distance from entry in ATRs",
      ]
    : undefined;
  return (
    <div className="ot-exit">
      <div className="ot-exit-head">
        <span className="ot-flabel ot-exit-label">
          {label},{" "}
          {atr ? (
            <>
              <select
                className="ot-unit"
                aria-label={`${label} unit`}
                value={atr.unit}
                onChange={(e) => atr.onUnit(e.target.value as ExitUnit)}
              >
                <option value="price">price</option>
                <option value="atr">ATR</option>
              </select>
              {atrMode && (
                <Tooltip content={atrTip}>
                  <BufferedNumberInput
                    className="ot-atr-len num"
                    aria-label="ATR length"
                    min={1}
                    step={1}
                    value={atr.length}
                    format={String}
                    onCommit={(n) => n >= 1 && atr.onLength(normalizeAtrLength(n))}
                  />
                </Tooltip>
              )}
            </>
          ) : (
            "price"
          )}
        </span>
        <div className="ot-exit-head-actions">
          {onBreakeven && (
            <Tooltip content={breakevenTip}>
              <button className="ot-be-btn" type="button" onClick={onBreakeven}>
                Set Breakeven
              </button>
            </Tooltip>
          )}
          <button
            className={`ot-switch${on ? " on" : ""}`}
            role="switch"
            aria-checked={on}
            onClick={() => onToggle(!on)}
          >
            <span className="ot-switch-knob" />
          </button>
        </div>
      </div>
      <div className={`ot-input-row${on ? "" : " disabled"}${invalid ? " invalid" : ""}`}>
        {atrMode ? (
          <BufferedNumberInput
            className="ot-input num"
            aria-label={`${label} in ATRs`}
            step={0.1}
            disabled={!on || !atrReady}
            value={on ? multiple : null}
            format={(n) => n.toFixed(2)}
            placeholder="—"
            aria-invalid={invalid}
            onCommit={(m) => {
              if (!atrReady || m <= 0) return;
              onChange(String(levelFromAtr(atr.ref!, m, atr.atr!, atr.up, atr.precision)));
            }}
          />
        ) : (
          <input
            className="ot-input num"
            type="number"
            step="any"
            min={min}
            max={max}
            disabled={!on}
            value={on && value != null ? value : ""}
            placeholder="—"
            aria-invalid={invalid}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        <span className="ot-input-aux num">
          {!on
            ? ""
            : atrMode
              ? !atrReady
                ? "ATR n/a"
                : value != null
                  ? `${value.toFixed(atr.precision)} · ${pctText}`
                  : ""
              : pctText}
        </span>
      </div>
    </div>
  );
}
