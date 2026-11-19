# All Accounts Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 4th dock tab, "All accounts", that shows every dealing account's open positions without switching broker, and opens a position (switching account after a confirm) on row click.

**Architecture:** Frontend only. A pure module (`lib/allAccounts.ts`) holds the account filter, figures, ordering, count, SL/TP distance, hidden-account storage, the per-account fetch and `waitForTrade`. A hook (`app/useAllAccounts.ts`) owns the two polls. A pane (`AllAccountsPane.tsx`) renders it inside `PositionsPanel`. `App.tsx` gets `openAccountPosition`, which reuses the cross-broker alert jump and then selects the trade once the new account's trades feed holds it.

**Tech Stack:** React + TypeScript, vitest + @testing-library/react, existing `lib/trading.ts` fetchers and `lib/accountStats.ts`.

**Spec:** `docs/superpowers/specs/2026-11-19-all-accounts-tab-design.md`

## Global Constraints

- No backend change. Use `GET /api/positions?account=` and `GET /api/account?account=` only.
- Dealing accounts = `exec` accounts with `env !== "paper"` and not `dataOnly`.
- Poll intervals: 30 s while the tab is shown (dock not collapsed): other visible accounts, positions + summary. 2 min otherwise: other visible accounts, positions only. Both pause while `document.hidden`; refetch once on becoming visible. The ACTIVE account is never polled by this feature: its section reads the dock's own `positions` prop (fed by the 6 s trades feed) and the existing `accountSummary`.
- Hidden accounts are never fetched and never counted.
- Background failures stay in the pane: do NOT call `reportBrokerOutage` / `reportBrokerBlocked`.
- A data-only active broker (Dukascopy, Yahoo) keeps its current "history only" dock with no tab (spec updated in Task 5).
- UI text: plain words, no em dashes, no `--`. Tooltips via `Tooltip`/`InfoTip`, never `title=`.
- Tests: run only the affected test files (never the full frontend suite). Typecheck with `npx tsc -b` from `frontend/`. Existing `PositionsPanel` tests must mock `useAllAccounts` so they make no real fetches.
- Commit to `main`, staging by explicit path (shared worktree: never stash/clean/restore).

## Review Focus

1. Position closed between the click and the switch landing: chart opens, no selection, no hang (Task 4: `waitForTrade` resolves null after the timeout).
2. Same-broker switch where the trades feed flips account a render later: `waitForTrade` must not give up at once (Task 1 test "signal flips later").
3. One broker always down: N still shows, counting the accounts that did load (Task 1 `otherOpenCount` test); its section shows the error.
4. One broker hangs: other sections render, and a tick does not start a second fetch for an account still in flight (Task 2).
5. Missing numbers: `mark` null, a level null, or mark 0 show "-", never NaN or Infinity (Task 1 `slTpDistancePct`).

---

### Task 1: Pure helpers (`lib/allAccounts.ts`)

**Files:**
- Create: `frontend/src/lib/allAccounts.ts`
- Test: `frontend/src/lib/allAccounts.test.ts`

**Interfaces:**
- Consumes: `BrokerAccount`, `TradeView`, `AccountSummary`, `TradeAccount`, `fetchOpenPositions`, `fetchAccountSummary`, `tradesAccountSignal` from `lib/trading.ts`; `tradesSignal` from `lib/signals.ts`; `accountStats` from `lib/accountStats.ts`; `PREFIX` from `lib/workspaceKeys.ts`; `TradingSettings` from `theme`.
- Produces:
  ```ts
  export interface AccountSnapshot {
    account: TradeAccount;
    positions: TradeView[] | null;   // null = never loaded
    summary: AccountSummary | null;  // null = 404 or not fetched
    error: string | null;            // last fetch error, cleared on success
    fetchedAt: number | null;        // epoch ms of last success
  }
  export interface SectionFigures { pnl: number; equity: number | null; marginLevel: number | null; currency: string | null; }
  export function dealingAccounts(accounts: BrokerAccount[]): BrokerAccount[];
  export function visibleAndHidden(accounts: BrokerAccount[], hidden: string[]): { visible: BrokerAccount[]; hidden: BrokerAccount[] };
  export function otherOpenCount(snaps: Record<string, AccountSnapshot>, visible: BrokerAccount[], active: TradeAccount): number | null;
  export function orderSections(visible: BrokerAccount[], snaps: Record<string, AccountSnapshot>, active: TradeAccount): BrokerAccount[];
  export function sectionFigures(snap: AccountSnapshot, acct: BrokerAccount, trading: TradingSettings): SectionFigures;
  export function slTpDistancePct(t: TradeView): { sl: number | null; tp: number | null };
  export function loadHiddenAccounts(): string[];
  export function saveHiddenAccounts(ids: string[]): void;   // key `${PREFIX}.allAccounts.hidden`
  export async function fetchSnapshot(prev: AccountSnapshot | undefined, account: TradeAccount, withSummary: boolean): Promise<AccountSnapshot>;
  export function waitForTrade(account: TradeAccount, dealId: string, timeoutMs?: number): Promise<string | null>; // default 15_000
  ```

- [ ] **Step 1: Write the failing tests** in `lib/allAccounts.test.ts`:
  - `dealingAccounts` drops `env: "paper"` and `dataOnly: true`, keeps demo and live in input order.
  - `visibleAndHidden(accts, ["ig-live:live", "gone:live"])` puts `ig-live:live` in `hidden` and ignores `gone:live`.
  - `otherOpenCount`: active excluded; `null` while no other visible account has been tried yet (`fetchedAt` and `error` both null); once tried, sums `positions?.length ?? 0` over the others, so an account that only ever errored counts 0 and does not block N; an errored account with earlier positions still counts them.
  - `orderSections`: accounts with positions first, then the rest; within each group the active account first; otherwise registry order.
  - `slTpDistancePct`: mark 100, stop 99.6, tp 102 gives `{sl: 0.4, tp: 2}` (abs percent of mark, `toBeCloseTo`); mark null, a level null, or mark 0 give null for that side.
  - `sectionFigures` with `summary: null`: `pnl` = sum of `upnl` (nulls as 0), `equity`, `marginLevel`, `currency` null. With a summary: `pnl`/`equity`/`marginLevel` equal `accountStats({positions, orders: [], summary, trading, broker: acct.broker, isLive: acct.isRealMoney, livePrice: () => undefined})`, `currency` = `summary.currency`. (A demo account gets real figures here while the dock shows paper ones for it, since the dock fetches summaries only for `:live`. Expected.)
  - `fetchSnapshot` (fetchers mocked): success sets positions, summary, `fetchedAt`, clears `error`; a rejected positions fetch keeps `prev.positions`, sets `error` to the message; `withSummary: false` keeps `prev.summary` and does not call `fetchAccountSummary`.
  - `loadHiddenAccounts` returns `[]` on missing or corrupt JSON; round-trips with `saveHiddenAccounts`.
  - `waitForTrade` (fake timers, set the two signals directly): resolves the id at once when `tradesAccountSignal === account` and `tradesSignal` holds it; resolves when a later `tradesSignal.set` adds it; **signal flips later**: starts while `tradesAccountSignal` is still the old account, then flips to `account`, then the trade arrives, resolves the id; resolves `null` after 15 s; resolves `null` when `tradesAccountSignal` changes to a third account (neither the start value nor `account`), or leaves `account` after having equalled it.

- [ ] **Step 2: Run to verify they fail**
  Run: `cd frontend && npx vitest run src/lib/allAccounts.test.ts`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/allAccounts.ts`** to the signatures above. `fetchSnapshot` runs `fetchOpenPositions(account)` and `fetchAccountSummary(account)` (404 already maps to null) in parallel and catches its own errors. `livePrice: () => undefined` because the chart price cache belongs to the active broker.

- [ ] **Step 4: Run to verify they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add frontend/src/lib/allAccounts.ts frontend/src/lib/allAccounts.test.ts
  git commit -m "feat(dock): all-accounts helpers"
  ```

### Task 2: Polling hook (`app/useAllAccounts.ts`)

**Files:**
- Create: `frontend/src/app/useAllAccounts.ts`
- Test: `frontend/src/app/useAllAccounts.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  export const ALL_ACCOUNTS_OPEN_MS = 30_000;
  export const ALL_ACCOUNTS_CLOSED_MS = 120_000;
  export function useAllAccounts(opts: {
    accounts: BrokerAccount[];
    active: TradeAccount;
    activePositions: TradeView[];          // the dock's own feed
    activeSummary: AccountSummary | null;  // the dock's own summary
    open: boolean;                         // shownTab === "accounts" && !collapsed
  }): {
    visible: BrokerAccount[];
    hidden: BrokerAccount[];
    snaps: Record<string, AccountSnapshot>; // active account's entry built from activePositions/activeSummary
    count: number | null;                   // otherOpenCount
    updatedAt: number | null;               // newest fetchedAt among other visible accounts
    refresh(): void;                        // fetch others now (with summary)
    setHidden(account: TradeAccount, hide: boolean): void;
    hasAccounts: boolean;                   // dealingAccounts(accounts).length > 0
  };
  ```

- [ ] **Step 1: Failing tests** (fake timers, `fetchSnapshot` mocked):
  - `open: false`: fetches only non-active visible accounts with `withSummary: false` on mount and again after 120 s, not at 30 s.
  - `open: true`: same accounts with `withSummary: true` on mount and every 30 s.
  - `open` false to true fetches at once.
  - The active account is never passed to `fetchSnapshot`; its `snaps` entry reflects `activePositions`.
  - Hidden accounts are never fetched; `setHidden(x, true)` persists via `saveHiddenAccounts` and stops fetching x.
  - With `document.hidden` true, ticks fetch nothing; a `visibilitychange` to visible fetches once.
  - An account whose fetch is still pending is not fetched again on the next tick; the others are.
  - Re-render with a new `active`: the old active account starts being polled, the new one stops, and `count` excludes the new one.
- [ ] **Step 2: Run** `npx vitest run src/app/useAllAccounts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** One interval for the current mode; an in-flight `Set<TradeAccount>` ref guards overlap; snapshots merge by account key.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dock): all-accounts polling hook`.

### Task 3: Pane and dock tab

**Files:**
- Create: `frontend/src/AllAccountsPane.tsx`
- Modify: `frontend/src/PositionsPanel.tsx` (local `type DockTab = TableTab | "accounts"` for `tab`; tab button after History ~line 608; render branch next to `HistoryPane` ~line 637; new prop). Do NOT change `TableTab` in `lib/positionsTable.tsx` (it drives column labels and the mobile view).
- Modify: the dock CSS file that holds `.pp-tabs` (add `.aa-*` rules)
- Test: `frontend/src/AllAccountsPane.test.tsx`, `frontend/src/PositionsPanel.allAccounts.test.tsx`

**Interfaces:**
- Consumes: Task 1, Task 2, `brokerLabel`, `Tooltip`.
- Produces: `PositionsPanel` prop `onOpenAccountPosition?: (account: TradeAccount, epic: string, dealId: string) => void`. `AllAccountsPane` props: `{ data: ReturnType<typeof useAllAccounts>; active: TradeAccount; trading: TradingSettings; onOpen: (account: TradeAccount, epic: string, dealId: string) => void }`.

`PositionsPanel` wiring:
- Call `useAllAccounts({accounts, active: account, activePositions: positions, activeSummary: accountSummary, open: shownTab === "accounts" && !collapsed})` before the `dataOnly` early return (hooks order); in the data-only branch nothing changes.
- `shownTab` falls back to `"positions"` when `tab === "accounts" && !data.hasAccounts`, like History.
- Branch for `"accounts"` before the `rows` / `rows.length === 0` logic so it never takes the orders path.
- Tab button: `<TabButton label="All accounts" count={data.count ?? 0} ...>` shown only when `data.hasAccounts`.

Pane behavior:
- Expanded state per account: decided the first time that account's `positions` becomes non-null (expanded if non-empty), then left to the user.
- A 5 s tick while mounted re-renders the "Updated" line.

Copy (exact): section mark `current`; refresh tooltip `Refresh now`; updated line `Updated {n} s ago`, from 60 s `Updated {n} min ago`; eye tooltips `Hide this account` / `Show this account`; footer `Hidden ({n})`; empty account `No open positions`; distance cell `SL 0.4%` / `TP 2.0%` (one decimal); missing value `-`.

- [ ] **Step 1: Failing tests.** `AllAccountsPane.test.tsx`:
  - One section per visible account, `brokerLabel` as the name, `current` only on the active one.
  - An account that loads with positions renders expanded; one that loads empty is collapsed and shows `No open positions` when expanded; an account still loading does not lock in collapsed.
  - A row shows symbol, side, size, entry, mark, P&L, SL, TP, `SL 0.4%`, and `-` for missing values.
  - A section with `error` shows the error text and its last positions.
  - Row click calls `onOpen("ig-live:live", "US100", "D1")`.
  - Eye calls `data.setHidden(account, true)`; `Hidden (1)` lists it and its eye calls `setHidden(account, false)`.
  - Refresh button calls `data.refresh`.
  `PositionsPanel.allAccounts.test.tsx` (mock `useAllAccounts`): tab absent when `hasAccounts` is false; label shows the count; selecting it renders the pane, not the orders table; collapsing the dock passes `open: false`.
- [ ] **Step 2: Run** `npx vitest run src/AllAccountsPane.test.tsx src/PositionsPanel.allAccounts.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** No action buttons on rows. Prices use the decimals of the position's `priceLevel`. Add the `useAllAccounts` mock to existing `PositionsPanel*.test.tsx` files that render the panel with dealing accounts.
- [ ] **Step 4: Run** the two new files plus the existing `PositionsPanel*.test.tsx` files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dock): All accounts tab`.

### Task 4: Row click opens and selects, switching after a confirm

**Files:**
- Modify: `frontend/src/App.tsx` (`pendingBrokerNavRef` ~line 561, its landing effect ~line 610, `<PositionsPanel>` ~line 1231)

**Interfaces:**
- Consumes: `waitForTrade` (Task 1), `onOpenAccountPosition` (Task 3), `setActiveAccount` (already returned by `useAccounts`; sets the exact account), `setTradeSelected` (`lib/signals.ts:439`), `jumpToEpic`, `requestConfirm`, `isDirty`, `brokerLabel`, `brokerOf`.

- [ ] **Step 1: Widen the ref type** to
  ```ts
  { broker: string; fromBroker: string; tabsBefore: ChartTab[]; epic: string; precision: number;
    target?: AlertNavTarget; account?: TradeAccount; dealId?: string }
  ```
  `openAlert` keeps setting `target`; its landing call passes `p.target!`.
- [ ] **Step 2: Add `openAccountPosition(account, epic, dealId)`**:
  - `account === activeAccount`: `await jumpToEpic(epic)`, then `setTradeSelected(dealId)`.
  - Otherwise `requestConfirm({ title: "Switch account?", message: \`This position is on ${brokerLabel(brokerOf(account))}. Switch from ${brokerLabel(brokerId)} to open ${epic}?\`, confirmLabel: "Switch", onConfirm })`, appending ` Unsaved changes to this layout will be discarded.` only when the broker differs and `isDirty`.
  - `onConfirm`, same broker (paper to dealing): `setActiveAccount(account)`, `await jumpToEpic(epic)`, then `const id = await waitForTrade(account, dealId); if (id) setTradeSelected(id)`.
  - `onConfirm`, other broker: set `pendingBrokerNavRef.current = { broker: brokerOf(account), fromBroker: brokerId, tabsBefore: tabsRef.current, epic, precision: 2, account, dealId }`, then `setActiveAccount(account)`.
- [ ] **Step 3: Landing effect.** Keep all existing guards unchanged (same broker with changed tabs drops; third broker drops; wait while `tabs === p.tabsBefore`). At the point it now calls `openAlert`, branch: when `p.dealId` is set, run `await jumpToEpic(p.epic)` on the new tabs, then `waitForTrade(p.account!, p.dealId)` and `setTradeSelected` on a non-null result; otherwise call `openAlert(p.epic, p.target!, p.precision)` as today.
- [ ] **Step 4: Pass** `onOpenAccountPosition={openAccountPosition}` to `<PositionsPanel>`.
- [ ] **Step 5: Verify:** `cd frontend && npx tsc -b` and `npx eslint src/App.tsx src/AllAccountsPane.tsx src/PositionsPanel.tsx src/lib/allAccounts.ts src/app/useAllAccounts.ts`. Expected: zero errors.
- [ ] **Step 6: Manual check in local dev** (backend with at least two dealing accounts): open the tab and see other accounts load; click a position on another broker, confirm, land on that account with the trade selected in the ticket; click one from a paper account of the same broker, no workspace swap; Cancel leaves everything as it was.
- [ ] **Step 7: Commit** `feat(dock): open a position from All accounts`.

### Task 5: Docs

**Files:**
- Modify: `CLAUDE.md` (short "All accounts tab" section under Account history: where the code lives, the two poll intervals, the active account read from the dock feed, view-only rows, row click flow).
- Modify: `docs/superpowers/specs/2026-11-19-all-accounts-tab-design.md` ("When the tab exists": a data-only active broker shows no tab; the current section reads the dock's own feed).

- [ ] **Step 1:** Write both edits (no em dashes).
- [ ] **Step 2: Commit** `docs: All accounts tab`.
