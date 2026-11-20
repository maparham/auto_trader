# Account history

Capital.com dealing accounts (`capital:demo`, `capital-live:live`) report
closed trades and the cash ledger through `ExecutionBroker.get_history`
(`supports_history`), served by `GET /api/history?account=&days=7|30|90`
with epoch-ms times; other accounts answer `{supported: false}`. Upstream
limits shape `brokers/_capital_history.py`: transactions cap at 100 rows per
call (paged, deduped on `reference`), activity at one day per call (walked
sequentially through the shared rate limiter, past days kept in `DayCache`).
The History tab (`HistoryPane.tsx`) and the chart's closed-trade markers both
read `lib/accountHistory.ts`; on a history account the markers replace the
live journal's exits. The chart draws only the History row selected for that
account, or every trade of the last 30 days while "Show all on chart" is on
(`historyShowAllSignal`, per browser, default off). Clicking a History
marker (entry or exit) toggles that selection like its row. The selected row's trade box is a
locked overlay that is never saved (`lib/historyTradeBox.ts`); it leaves with
the selection. Spec: docs/superpowers/specs/2026-10-21-capital-account-history-design.md.
