# Capital.com account history

Date: 2026-10-21

## Goal

Today the positions dock shows only the open book (positions, working
orders). Add the closed side for Capital.com accounts:

- a **History** tab beside Positions / Orders listing closed trades with
  realized P&L, plus a ledger of overnight funding, deposits, withdrawals
  and other cash rows;
- **chart markers** for closed trades (entry and exit) on the focused epic.

Range picker: 7d / 30d / 90d chips, 30d default.

Out of scope: IG (same API lineage, a natural follow-up), MT5, the in-app
paper accounts (`*:paper`), a persistent history cache, CSV export, P&L
charts.

## What the Capital API actually returns

Probed read-only against the live account on 2026-10-21 (docs omit the
detailed shape).

`GET /api/v1/history/transactions?from&to[&type]`

- Newest first, **capped at 100 rows per call** (365d and 30d both returned
  the same 100 rows). Paging: repeat with `to` = oldest `dateUtc` seen until
  a call returns fewer than 100.
- Fields: `dateUtc`, `instrumentName` (the epic, e.g. `TSLA`),
  `transactionType` (`TRADE`, `SWAP`, `DEPOSIT`, `WITHDRAWAL`, ...), `note`
  ("Trade closed", "Overnight fee"), `reference`, `size` (string, signed,
  account currency), `currency`, `status`.
- `TRADE` rows carry `dealId`, equal to the position's dealId. That is the
  join key for realized P&L. `SWAP` rows carry no dealId.

`GET /api/v1/history/activity?from&to&detailed=true&filter=type==POSITION`

- **At most 1 day per call.** N days of markers cost N calls (10 req/s cap,
  shared with all other Capital traffic through `_RateLimiter`).
- One row per event: `dateUTC`, `epic`, `dealId`, `source`
  (`USER`/`TP`/`SL`/`SYSTEM`/`CLOSE_OUT`/`DEALER`), `status`, `details`
  (`direction`, `size`, `level`, `stopLevel`, `profitLevel`, `currency`,
  `openPrice` on closes).
- **Close row**: has `details.openPrice`; `details.level` is the exit
  price; `details.direction` is the closing side (SELL closes a long).
- **Open row**: no `openPrice`; `details.level` is the fill. `SYSTEM` rows
  without `openPrice` also appear daily for some positions (NATURALGAS at
  20:59 each day, likely rollover), so "earliest row without openPrice" is
  not reliably the open.

## Data model

```python
@dataclass
class ClosedTrade:
    deal_id: str
    epic: str
    side: Literal["buy", "sell"]   # the opening side (opposite of the close row's direction)
    size: float
    entry_price: float              # close row details.openPrice
    exit_price: float               # close row details.level
    opened_at: datetime | None      # see entry matching below; None when outside the window
    closed_at: datetime
    close_source: str               # USER / TP / SL / SYSTEM / CLOSE_OUT / DEALER
    pnl: float | None               # TRADE transaction size by dealId, account currency
    currency: str | None            # account currency of pnl

@dataclass
class LedgerEntry:
    at: datetime
    kind: str                       # transactionType verbatim
    epic: str | None                # instrumentName, None for cash rows
    note: str
    amount: float                   # signed, account currency
    currency: str
    reference: str
    deal_id: str | None
```

**Entry matching.** For each close row, the open is the earliest POSITION
row for the same dealId with no `openPrice` whose `level` equals
`openPrice` (within half a tick, i.e. 1e-9 relative is enough since both
come from the same server). No match inside the fetched window gives
`opened_at = None`: the table shows "before range", the chart draws the
exit marker only.

## Backend

**`brokers/base.py`**: new optional method on `ExecutionBroker`:

```python
supports_history: bool = False
async def get_history(self, since: datetime, until: datetime) -> AccountHistory:
    raise NotImplementedError
```

`AccountHistory = {trades: list[ClosedTrade], ledger: list[LedgerEntry]}`.

**`brokers/_capital_history.py`** (new, keeps `capital.py` from growing):

- pure parsers: `parse_activity(rows) -> list[ClosedTrade]` (close rows,
  entry matching), `parse_transactions(rows) -> list[LedgerEntry]`,
  `attach_pnl(trades, ledger)` (TRADE rows by dealId; a trade with no TRADE
  row keeps `pnl = None`);
- fetch walkers taking the broker's `_request`: `fetch_transactions(since,
  until)` (the 100-row paging loop) and `fetch_activity(since, until)`
  (one call per UTC day, `filter=type==POSITION`, `detailed=true`);
- `DayCache`: per broker instance, UTC date → parsed activity rows. Days
  strictly before today (UTC) are immutable and cached for the process
  lifetime; today is always refetched. Bounded to 120 days per instance.
  Transactions are not cached (1-2 calls per request).

**`brokers/capital.py`**: `CapitalExecution` sets `supports_history = True`
and implements `get_history` with the module above. Only the real Capital
accounts (`capital:demo`, `capital-live:live`); paper stays unsupported.

**`api/routers/trading.py`**: `GET /api/history?account=...&days=30`
(`days` in {7, 30, 90}, 422 otherwise). Unsupported account answers
`{supported: false}` with 200, so the frontend hides the tab content
without treating it as an error. Supported answers
`{supported: true, since, until, trades: [...], ledger: [...], totals:
{realized, funding, deposits, withdrawals, currency}}`. Upstream errors map
like the existing positions route.

## Frontend

**`lib/accountHistory.ts`** (new): `fetchAccountHistory(account, days)`, a
per-(account, days) signal store, refetch on: account change, range change,
a position disappearing from the trades book (a close just happened), and
a 60 s timer while the History tab is visible. No polling when hidden.

**History tab** in `PositionsPanel.tsx` and `mobile/MobilePositionsView.tsx`
(shared table module `lib/positionsTable.tsx` gains `TableTab = ... |
"history"`). Shown only when `/api/brokers` reports the account supports
history (new `history: true` flag on the account entry). Inside the tab:

- range chips 7d / 30d / 90d (muted gray active state per house style);
- a sub-toggle **Trades | Ledger**;
- Trades columns: Symbol, Side, Qty, Entry, Exit, Opened, Closed, Closed
  by (TP/SL/Manual/System/Stop-out), P&L. Sortable like the other tabs,
  default Closed desc. Clicking a row focuses that epic's chart and scrolls
  to the close bar;
- Ledger columns: Time, Type (Funding / Trade / Deposit / Withdrawal /
  raw type for the rest), Symbol, Note, Amount;
- a totals line over the table: Realized, Funding, Net cash in/out.

**Chart markers** (`lib/tradeMarkers.ts`): a third source,
`brokerHistorySignal` for the cell's account. Each closed trade gives an
entry marker (when `opened_at` is known) and an exit marker, both keyed by
`deal_id`, placed by direction exactly like journal markers, win/loss
colored by `pnl`. When the cell's account supports history, journal exit
markers are skipped for that cell; the journal still powers the Live
panel's metrics and remains the marker source for paper and other brokers.
An open position and its later closed trade never double up: the entry
marker moves from the position book to history on close, same `deal_id`.

## Errors and edge cases

- 1-day activity cap: walked per day; a single failing day fails the
  request (no partial silent gaps), the tab shows the error with Retry.
- Rate limit: the walker goes through `_request`, which already retries 429
  with backoff. A 90d cold load is ~90 activity calls, about 9 s at the cap.
  The tab shows a loading state; the cache makes reopening instant.
- Partial closes: Capital gives a close row per partial with its own size;
  each becomes its own ClosedTrade row sharing the dealId. Marker keys
  include the close timestamp to stay unique.
- Times are UTC from `dateUTC`/`dateUtc`; the UI formats in the chart's
  time zone like `fmtTime`.

## Testing

- `tests/test_capital_history.py`: parsers against fixtures built from the
  probed shapes (amounts and ids replaced): open/close pairing, close-only
  (open before range), NATURALGAS-style daily SYSTEM rows not mistaken for
  the open, partial close, pnl join and missing TRADE row, transactions
  paging stops under 100, DayCache never caches today.
- Route test: unsupported account gives `supported: false`; bad `days`
  422s.
- Frontend: `tradeMarkers` test for history source + journal suppression;
  a History tab render test for the totals and the "before range" cell.
  Only the affected test files are run.
- Manual: live account read-only, History tab against Capital's own web
  history for the same range.
