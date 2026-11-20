# Mobile "All accounts" tab (short design)

**Why:** the Android app should come close to the desktop app. The desktop
dock has an "All accounts" tab (open positions of every dealing account,
without switching account); the phone's Positions view does not.

**Goal:** the same tab in `mobile/MobilePositionsView.tsx`, next to
Positions / Orders / History.

**Approaches considered**
1. Reuse the desktop `AllAccountsPane` and `app/useAllAccounts.ts` as they
   are (picked: one implementation, same polling rules, same hidden-account
   list per browser).
2. A phone-only card list: nicer on a narrow screen, but a second copy of the
   section math and polling to keep in step.

**Design**
- Tab "All accounts" with `data.count` as its count. Shown only when the
  active broker is not data-only and there are at least two dealing accounts
  (with one, the tab repeats the Positions tab).
- Polling: `useAllAccounts({accounts, active, activePositions, activeSummary,
  open: tab shown, enabled})`, so 30 s while shown, 2 min otherwise.
- A row tap: the active account opens the chart at once
  (`showMobileEpic`); another account asks "Switch account?" first, then
  switches (`setMobileAccount`) and opens the epic. A switch to another
  broker uses the same jump guard as the alert History row
  (`openMobileAccountPosition` in `mobileChartState.ts`).
- Styles: `aa-*` come from App.css (loaded on mobile too); mobile.css only
  lets the pane fill the view and wraps the header figures.

**Non-goals:** selecting the tapped position on the chart; closing or
editing other accounts' positions (rows stay view-only, as on desktop).
