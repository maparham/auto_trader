# All accounts tab

The dock's "All accounts" tab (`AllAccountsPane.tsx`) shows the open positions
of every dealing account (not paper, not data-only) without switching broker.
`app/useAllAccounts.ts` polls the OTHER visible accounts every 30 s while the
tab is shown and the dock is open (with `/api/account` summaries), and every
2 min otherwise (positions only, for the count on the tab); both pause while
the page is hidden. The active account is never polled: its section reads the
dock's own trades feed. Accounts hidden with the eye toggle are never fetched
(`${PREFIX}.allAccounts.hidden`, per browser). Fetch errors stay in their
section, never the app-wide outage banners. Header figures come from
`lib/allAccounts.ts` `sectionFigures` (accountStats without orders margin).
Rows are view-only. A row click goes through App's `openAccountPosition`:
the active account opens and selects at once; another account confirms
first, and another broker parks the request in `pendingBrokerNavRef` until
the workspace swap lands; `waitForTrade` selects the deal once the new
account's feed holds it (gone meanwhile: chart only). A data-only active
broker keeps its read-only dock with no tab. Spec:
docs/superpowers/specs/2026-11-19-all-accounts-tab-design.md.
