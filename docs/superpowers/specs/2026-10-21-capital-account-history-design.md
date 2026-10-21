# Capital.com account history

Date: 2026-10-21 (revised after review the same day)

## Goal

Today the positions dock shows only the open book (positions, working
orders). Add the closed side for Capital.com accounts:

- a **History** tab beside Positions / Orders listing closed trades with
  realized P&L, plus a ledger of overnight funding, deposits, withdrawals
  and other cash rows;
- **chart markers** for closed trades (entry and exit) on every chart
  showing a traded epic.

Range picker in the tab: 7d / 30d / 90d chips, 30d default. Markers always
use a fixed 30d range (see Chart markers).

Out of scope: IG (same API lineage, a natural follow-up), MT5, the in-app
paper accounts (`*:paper`), a persistent history cache, CSV export, P&L
charts, scrolling the chart to an old close bar (history page-back is
deferred for markers already, `tradeMarkers.ts` culls anything older than
the oldest loaded bar).

## What the Capital API actually returns

Probed read-only against the live account on 2026-10-21 (docs omit the
detailed shape).

`GET /api/v1/history/transactions?from&to[&type]`

- Newest first, **capped at 100 rows per call** (365d and 30d both returned
  the same 100 rows).
- Fields: `dateUtc` (naive UTC, millisecond precision), `instrumentName`
  (the epic, e.g. `TSLA`), `transactionType` (`TRADE`, `SWAP`, `DEPOSIT`,
  `WITHDRAWAL`, ...), `note` ("Trade closed", "Overnight fee"),
  `reference` (unique per row), `size` (string, signed, account currency),
  `currency`, `status`.
- `TRADE` rows carry `dealId`, equal to the position's dealId. `SWAP` rows
  carry no dealId.

`GET /api/v1/history/activity?from&to&detailed=true&filter=type==POSITION`

- **At most 1 day per call.**
- One row per event: `dateUTC` (naive UTC), `epic`, `dealId`, `source`
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
    side: Literal["buy", "sell"]   # opening side: opposite of the close row's direction
    size: float                     # this close's size (a partial close has its own row)
    entry_price: float              # close row details.openPrice
    exit_price: float               # close row details.level
    opened_at: datetime | None      # entry matching below; None when not found
    closed_at: datetime             # close row dateUTC, tz-aware UTC
    close_source: str               # USER / TP / SL / SYSTEM / CLOSE_OUT / DEALER
    pnl: float | None               # matched TRADE transaction, account currency
    currency: str | None            # account currency of pnl

@dataclass
class LedgerEntry:
    at: datetime                    # tz-aware UTC
    kind: str                       # transactionType verbatim
    epic: str | None                # instrumentName, None for cash rows
    note: str
    amount: float                   # signed, account currency
    currency: str
    reference: str
    deal_id: str | None
```

All Capital timestamps are naive UTC; parsers attach UTC the way
`capital.py`'s `_parse_dt` does. The route serializes every time as
**epoch ms** so the browser never reads a naive ISO string as local time.

**Entry matching.** For each close row, the open is the earliest POSITION
row for the same dealId with no `openPrice` whose `details.level` equals
`openPrice` within 1e-9 relative (both come from the same server, so this
is exact equality with float slack). No match gives `opened_at = None`:
the table shows "before range", the chart draws the exit marker only.
Known gap, accepted: a position opened by a limit/stop fill may log its
open only under `WORKING_ORDER` activity, which the `type==POSITION`
filter skips, so it also gets `opened_at = None`. Activity rows with
`status` other than `ACCEPTED` are skipped entirely (candidate opens and
closes alike), so a rejected fill neither yields a `ClosedTrade` nor gets
picked as another deal's open.

**P&L matching.** TRADE rows are matched to close rows by dealId, then by
nearest timestamp (each TRADE row used once). Partial closes share a
dealId, so dealId alone would hand every partial the same P&L. A close
with no TRADE row left keeps `pnl = None`.

## Backend

**`brokers/base.py`**: new non-abstract members on `ExecutionBroker`
(paper and every other broker inherit the defaults):

```python
supports_history: bool = False
async def get_history(self, since: datetime, until: datetime) -> AccountHistory:
    raise NotImplementedError
```

`AccountHistory = {trades: list[ClosedTrade], ledger: list[LedgerEntry]}`.

**`brokers/_capital_history.py`** (new, keeps `capital.py` from growing):

- Pure parsers: `parse_activity(rows) -> list[ClosedTrade]` (close rows,
  entry matching), `parse_transactions(rows) -> list[LedgerEntry]`,
  `attach_pnl(trades, ledger)` (dealId + nearest time, above).
- `fetch_transactions(request, since, until)`: page newest to oldest. Each
  next call uses `to` = oldest `dateUtc` seen (treated as inclusive), rows
  are deduped on `reference`, and the loop stops when a call returns fewer
  than 100 rows, when a page adds no new reference (100+ rows sharing one
  timestamp, e.g. SWAP rows at rollover), or after 20 pages.
- `fetch_activity(request, since, until)`: one call per **whole UTC day**
  (`from` = day 00:00:00, `to` = next day 00:00:00, confirmed accepted by a
  live probe on 2026-10-21), `filter=type==POSITION`,
  `detailed=true`. Rows from all days are deduped on (dealId, dateUTC,
  source), parsed, then filtered to `[since, until]`. Days are fetched
  **sequentially, never gathered**: the rate limiter (8/s, `capital.py`
  `_MAX_REQUESTS_PER_SEC`) is one FIFO shared by the data feed, the paper
  sim and the dealing executor, so a gathered 90-day burst would queue
  ahead of an order or a confirm. A 90d cold load is ~90 calls, at least
  11 s.
- `DayCache`, one per broker instance: UTC date to raw activity rows. A
  day is cached only if it ended before the moment its fetch **started**,
  so a fetch that crosses midnight cannot freeze a partial day. Today is
  always refetched. Bounded to 120 days. Single-flight per date: a second
  request for a day already in flight awaits the same task (desktop,
  phone and the refresh timer can otherwise start duplicate cold walks).
  The in-flight entry and the cache write settle on the task itself, so a
  cancelled first requester neither orphans the fetch nor lets a later one
  start a duplicate. Transactions are not cached (a few calls per request).

**`brokers/capital.py`**: `CapitalExecutionBroker` sets
`supports_history = True` and implements `get_history` with the module
above. That covers `capital:demo` and `capital-live:live`; paper stays
unsupported.

**`brokers/registry.py`**: `describe()` adds `history:
getattr(broker, "supports_history", False)` to each exec account item.
Frontend `BrokerAccount` (`lib/trading.ts`) gains `history?: boolean`.

**`api/routers/trading.py`**: `GET /api/history?account=...&days=30` on
the existing (admin-gated) trading router, `days: Literal[7, 30, 90]`
(422 otherwise). Unsupported account answers `{supported: false}` with
200, so the frontend hides the content without treating it as an error.
Supported answers `{supported: true, since, until, trades: [...],
ledger: [...], totals: {realized, funding, deposits, withdrawals,
currency}}`, times as epoch ms. Errors map like the positions route:
BrokerReconnecting 503, BrokerBlocked as there, anything else 502.

## Frontend

**`lib/accountHistory.ts`** (new): `fetchAccountHistory(account, days)`
and a store keyed by (account, days), with subscribe/refresh like
`subscribeTrades`. Refetches on: account change, range change, a position
disappearing from the trades book, and a 60 s timer while anything is
subscribed (the History tab or chart markers). The timer is what keeps
`capital:demo` fresh: `isRealMoneyAccount` only matches `:live`, so the
demo account gets no push and a TP/SL close there never empties the book.

**`HistoryTable` module** (new, e.g. `HistoryTable.tsx` +
`lib/historyTable.ts`): its own columns, sort keys and cell formatting.
`lib/positionsTable.tsx` only widens `TableTab` to include `"history"` for
the tab switch; its `SortKey`/`POSITION_COLUMNS` stay tied to open trades.

**History tab** in `PositionsPanel.tsx` and
`mobile/MobilePositionsView.tsx`, shown only when the active account's
`BrokerAccount.history` is true. Inside the tab:

- range chips 7d / 30d / 90d (muted gray active state per house style);
- a sub-toggle **Trades | Ledger**;
- Trades columns: Symbol, Side, Qty, Entry, Exit, Opened, Closed, Closed
  by (TP / SL / Manual / System / Stop-out), P&L. Sortable, default Closed
  desc. Clicking a row focuses that epic's chart (no scroll to the bar);
  on the phone a tap opens it on the chart tab through `showMobileEpic`,
  the positions sheet's "Show on chart" path, with the entry price's
  decimals as the precision guess;
- Ledger columns: Time, Type (Funding / Trade / Deposit / Withdrawal /
  raw type for the rest), Symbol, Note, Amount;
- a totals line over the table: Realized, Funding, Net cash in/out, plus
  "Totals partial" when the response's `ledger_truncated` is true (the
  transactions walk stopped on a full page: the 20-page cap, or 100+ rows
  in one second);
- loading state on a cold walk; an error with Retry if any day fails (one
  failing day fails the request rather than leaving a silent gap; days
  already cached stay cached).

Times use `fmtTime` from `lib/positionsTable.tsx`, the same formatter as
the open-trades table (browser locale and local time), so both tabs read
alike.

**Chart markers** (`lib/tradeMarkers.ts`). Cells have no account of their
own: they get the app-wide broker, and the trades feed tracks one module
level account (`getTradesAccount()` / `setTradesAccount`). So the marker
source is keyed on `getTradesAccount()`:

- When that account has `history: true`, ChartCore subscribes to the
  history store at a fixed **30d** range, independent of whether the
  History tab was ever opened or which range chip it shows.
- Each closed trade gives an **exit** marker keyed
  `hexit:<deal_id>:<closed_at>` (unique across partials).
- Each dealId gives **one** entry marker keyed `hentry:<deal_id>`, deduped
  across its partials, drawn only when `opened_at` is known AND the dealId
  is no longer in `tradesSignal` (while any part is still open, the
  position book's existing `entry:<deal_id>` marker covers it).
- Placement by direction exactly like journal markers. Color from `pnl`;
  when `pnl` is None, from `(exit - entry) * direction`.
- When the trades account has history, **journal exit markers are skipped
  entirely** (the journal has no account field, so this is per active
  account, not per cell). The journal still powers the Live panel's
  metrics and remains the marker source for paper and other brokers.

## Testing

- `tests/test_capital_history.py`, parsers against fixtures built from the
  probed shapes (amounts and ids replaced): open/close pairing, close only
  (open before range), NATURALGAS-style daily SYSTEM rows not mistaken for
  the open, two partials of one dealId with different P&L getting their
  own TRADE rows, a close with no TRADE row, naive timestamps coming out
  UTC.
- Paging: stops under 100; stops when a page repeats only seen references
  (100+ rows on one timestamp); 20-page cap.
- Activity walk: midnight-edge row returned by two days counted once;
  results filtered to `[since, until]`; DayCache never caches today or a
  day whose fetch started before it ended; concurrent requests for one day
  make one upstream call; days fetched sequentially.
- Route: unsupported account gives `supported: false`; `days=14` 422s;
  times are epoch ms.
- Frontend: `tradeMarkers` test for the history source (one entry per
  dealId, entry suppressed while the position is still open, exit per
  partial, journal suppression, None-pnl color); a History table render
  test for totals and the "before range" cell. Only the affected test
  files are run.
- Manual: live account read-only, History tab against Capital's own web
  history for the same range.
