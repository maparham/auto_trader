# All Accounts Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 4th dock tab, "All accounts", that shows every dealing account's open positions without switching broker, and opens a position (switching account after a confirm) on row click.

**Architecture:** Frontend only. A pure module (`lib/allAccounts.ts`) holds the account filter, figures, ordering, count, SL/TP distance, hidden-account storage and the per-account fetch. A hook (`app/useAllAccounts.ts`) owns the two polls. A pane (`AllAccountsPane.tsx`) renders it inside `PositionsPanel`. `App.tsx` gets `openAccountPosition`, which reuses the cross-broker alert jump and then selects the trade once the new account's trades feed holds it.

**Tech Stack:** React + TypeScript, vitest + @testing-library/react, existing `lib/trading.ts` fetchers and `lib/accountStats.ts`.

**Spec:** `docs/superpowers/specs/2026-11-19-all-accounts-tab-design.md`

## Global Constraints

- No backend change. Use `GET /api/positions?account=` and `GET /api/account?account=` only.
- Dealing accounts = `exec` accounts with `env !== "paper"` and not `dataOnly`.
- Poll intervals: 30 s while the tab is open (all visible accounts, positions + summary); 2 min while closed (other visible accounts, positions only). Both pause while `document.hidden`; refetch once on becoming visible.
- Hidden accounts are never fetched and never counted.
- Background failures stay in the pane: do NOT call `reportBrokerOutage` / `reportBrokerBlocked`.
- UI text: plain words, no em dashes, no `--`. Tooltips via `Tooltip`/`InfoTip`, never `title=`.
- Tests: run only the affected test files (never the full frontend suite). Typecheck with `npx tsc -b` from `frontend/`.
- Commit to `main`, staging by explicit path (shared worktree: never stash/clean/restore).

## Review Focus

1. Position closed between the click and the switch landing: chart opens, no selection, no hang (test in Task 4: `waitForTrade` resolves null after the timeout).
2. Active account changes while the tab is open: the "current" mark, ordering and count follow it (test in Task 1: `otherOpenCount`/`orderSections` take `active` as input; Task 3 hook test re-renders with a new `active`).
3. One broker hangs: the other sections render, and a new poll tick does not start a second fetch for an account still in flight (test in Task 3).
4. Hidden list holds an account that no longer exists: ignored, not shown in "Hidden (N)" (test in Task 1: `visibleAndHidden`).
5. Missing numbers: `mark` null, a level null, or mark 0 show "-", never NaN or Infinity (test in Task 1: `slTpDistancePct`).

---

### Task 1: Pure helpers (`lib/allAccounts.ts`)

**Files:**
- Create: `frontend/src/lib/allAccounts.ts`
- Test: `frontend/src/lib/allAccounts.test.ts`

**Interfaces:**
- Consumes: `BrokerAccount`, `TradeView`, `AccountSummary`, `TradeAccount`, `fetchOpenPositions`, `fetchAccountSummary` from `lib/trading.ts`; `accountStats` from `lib/accountStats.ts`; `PREFIX` from `lib/workspaceKeys.ts`; `TradingSettings` from `theme`.
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
  export function otherOpenCount(snaps: Record<string, AccountSnapshot>, visible: BrokerAccount[], active: TradeAccount): number | null; // null until every other visible account has loaded once
  export function orderSections(visible: BrokerAccount[], snaps: Record<string, AccountSnapshot>, active: TradeAccount): BrokerAccount[];
  export function sectionFigures(snap: AccountSnapshot, acct: BrokerAccount, trading: TradingSettings): SectionFigures;
  export function slTpDistancePct(t: TradeView): { sl: number | null; tp: number | null };
  export function loadHiddenAccounts(): string[];
  export function saveHiddenAccounts(ids: string[]): void;   // key `${PREFIX}.allAccounts.hidden`
  export async function fetchSnapshot(prev: AccountSnapshot | undefined, account: TradeAccount, withSummary: boolean): Promise<AccountSnapshot>;
  ```

- [ ] **Step 1: Write the failing tests** in `lib/allAccounts.test.ts`:
  - `dealingAccounts` drops `env: "paper"` and `dataOnly: true`, keeps demo and live in input order.
  - `visibleAndHidden(accts, ["ig-live:live", "gone:live"])` puts `ig-live:live` in `hidden` and ignores `gone:live`.
  - `otherOpenCount`: active excluded; returns `null` while any other visible account has `positions: null`; sums the others' lengths once all loaded; an errored account with `positions` from an earlier load still counts its last positions.
  - `orderSections`: accounts with positions first, then the rest; within each group the active account first; otherwise registry order.
  - `slTpDistancePct`: long, mark 100, stop 99.6, tp 102 gives `{sl: 0.4, tp: 2}` (abs percent of mark, `toBeCloseTo`); mark null, stop null, or mark 0 give null for that side.
  - `sectionFigures` with `summary: null`: `pnl` = sum of `upnl` (nulls as 0), `equity` and `marginLevel` null, `currency` null. With a summary: same values as `accountStats({positions, orders: [], summary, trading, broker: acct.broker, isLive: acct.isRealMoney, livePrice: () => undefined})` for `pnl`/`equity`/`marginLevel`, and `summary.currency`.
  - `fetchSnapshot` with mocked fetchers: success sets positions, summary, `fetchedAt`, clears `error`; a rejected positions fetch keeps `prev.positions` and sets `error` to the message; `withSummary: false` keeps `prev.summary` and does not call `fetchAccountSummary`.
  - `loadHiddenAccounts` returns `[]` on missing or corrupt JSON; round-trips with `saveHiddenAccounts`.

- [ ] **Step 2: Run to verify they fail**
  Run: `cd frontend && npx vitest run src/lib/allAccounts.test.ts`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/allAccounts.ts`** to the signatures above. `fetchSnapshot` uses `fetchOpenPositions(account)` and `fetchAccountSummary(account)` (404 already maps to null) in parallel, catching errors itself so nothing reaches the app-wide outage banners. `livePrice: () => undefined` because the chart price cache belongs to the active broker.

- [ ] **Step 4: Run to verify they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add frontend/src/lib/allAccounts.ts frontend/src/lib/allAccounts.test.ts
  git commit -m "feat(dock): all-accounts helpers"
  ```

### Task 2: Exact-account switch in `useAccounts`

**Files:**
- Modify: `frontend/src/app/useAccounts.ts` (next to `switchBrokerConfirmed`, ~line 77)
- Test: `frontend/src/app/useAccounts.test.ts` (create if missing)

**Interfaces:**
- Produces: `switchAccountConfirmed(account: TradeAccount): void` returned from `useAccounts` beside `switchBrokerConfirmed`. Sets that exact account active (no-op when already active). It still updates `lastAccountByBroker` through the existing effect.

- [ ] **Step 1: Failing test** with `renderHook`: accounts `[capital:paper, capital:demo, ig-live:live]` (mock `fetchBrokers`/`cachedBrokers`), active `capital:paper`; `switchAccountConfirmed("ig-live:live")` makes `activeAccount === "ig-live:live"` even when `lastAccountByBroker` remembers another ig account.
- [ ] **Step 2: Run** `npx vitest run src/app/useAccounts.test.ts`. Expected: FAIL (`switchAccountConfirmed` is not a function).
- [ ] **Step 3: Implement** and return it from the hook.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(accounts): switch to an exact account`.

### Task 3: Polling hook (`app/useAllAccounts.ts`)

**Files:**
- Create: `frontend/src/app/useAllAccounts.ts`
- Test: `frontend/src/app/useAllAccounts.test.ts`

**Interfaces:**
- Consumes: Task 1 (`dealingAccounts`, `visibleAndHidden`, `fetchSnapshot`, `otherOpenCount`, `loadHiddenAccounts`, `saveHiddenAccounts`).
- Produces:
  ```ts
  export const ALL_ACCOUNTS_OPEN_MS = 30_000;
  export const ALL_ACCOUNTS_CLOSED_MS = 120_000;
  export function useAllAccounts(opts: { accounts: BrokerAccount[]; active: TradeAccount; open: boolean }): {
    visible: BrokerAccount[];
    hidden: BrokerAccount[];
    snaps: Record<string, AccountSnapshot>;
    count: number | null;          // otherOpenCount
    updatedAt: number | null;      // newest fetchedAt among visible
    refresh(): void;               // open-mode fetch now
    setHidden(account: TradeAccount, hide: boolean): void;
    hasAccounts: boolean;          // dealingAccounts(accounts).length > 0
  };
  ```

- [ ] **Step 1: Failing tests** (vi fake timers, `fetchSnapshot` mocked):
  - `open: false`: fetches only the non-active visible accounts with `withSummary: false` on mount, again after 120 s, not at 30 s.
  - `open: true`: fetches all visible accounts with `withSummary: true` on mount and every 30 s.
  - Switching `open` false to true fetches at once.
  - Hidden accounts are never fetched; `setHidden(x, true)` persists through `saveHiddenAccounts` and stops fetching x.
  - With `document.hidden` true, ticks fetch nothing; a `visibilitychange` to visible fetches once.
  - An account whose fetch is still pending is not fetched again on the next tick; the other accounts are.
  - Re-render with a new `active`: `count` excludes the new active account.
- [ ] **Step 2: Run** `npx vitest run src/app/useAllAccounts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** One interval per mode; an in-flight `Set<TradeAccount>` ref guards overlap; snapshots merge by account key.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dock): all-accounts polling hook`.

### Task 4: Pane and dock tab

**Files:**
- Create: `frontend/src/AllAccountsPane.tsx`
- Modify: `frontend/src/lib/positionsTable.tsx:14` (`TableTab` gains `"accounts"`)
- Modify: `frontend/src/PositionsPanel.tsx` (tab button after History ~line 608; render branch next to `HistoryPane` ~line 637; new prop)
- Modify: dock CSS file that holds `.pp-tabs` (add `.aa-*` rules)
- Test: `frontend/src/AllAccountsPane.test.tsx`

**Interfaces:**
- Consumes: Task 1, Task 3, `brokerLabel`, `Tooltip`.
- Produces: `PositionsPanel` prop `onOpenAccountPosition?: (account: TradeAccount, epic: string, dealId: string) => void`. `AllAccountsPane` props: `{ data: ReturnType<typeof useAllAccounts>; active: TradeAccount; trading: TradingSettings; onOpen: (account, epic, dealId) => void }`. `PositionsPanel` calls `useAllAccounts({accounts, active: account, open: shownTab === "accounts"})` itself so the count runs while the tab is closed.

Copy (exact): tab label `All accounts` with count; section mark `current`; refresh tooltip `Refresh now`; updated line `Updated {n} s ago` (minutes past 60 s: `Updated {n} min ago`); eye tooltips `Hide this account` / `Show this account`; footer `Hidden ({n})`; empty account `No open positions`; distance cell `SL 0.4%` / `TP 2.0%` (one decimal); missing value `-`.

- [ ] **Step 1: Failing tests** in `AllAccountsPane.test.tsx`:
  - Renders one section per visible account, `brokerLabel` as the name, `current` only on the active one.
  - A section with positions is expanded; an empty one is collapsed and shows `No open positions` when expanded.
  - A row shows symbol, side, size, entry, mark, P&L, SL, TP, `SL 0.4%`, and `-` for missing values.
  - A section with `error` shows the error text and still shows its last positions.
  - Clicking a row calls `onOpen("ig-live:live", "US100", "D1")`.
  - Clicking the eye calls `data.setHidden(account, true)`; `Hidden (1)` lists it and its eye calls `setHidden(account, false)`.
  - Refresh button calls `data.refresh`.
  - In `PositionsPanel` (extend an existing PositionsPanel test file or add `PositionsPanel.allAccounts.test.tsx`): tab hidden when `hasAccounts` is false; label shows the count when not null.
- [ ] **Step 2: Run** `npx vitest run src/AllAccountsPane.test.tsx src/PositionsPanel.allAccounts.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** pane, tab, prop. No action buttons on rows. Prices formatted with the decimals of the position's `priceLevel`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dock): All accounts tab`.

### Task 5: Row click opens and selects, switching after a confirm

**Files:**
- Modify: `frontend/src/lib/allAccounts.ts` (add `waitForTrade`)
- Modify: `frontend/src/App.tsx` (`pendingBrokerNavRef` ~line 561 and its effect ~line 610; `<PositionsPanel>` ~line 1231)
- Test: `frontend/src/lib/allAccounts.test.ts` (extend)

**Interfaces:**
- Consumes: `switchAccountConfirmed` (Task 2), `onOpenAccountPosition` (Task 4), `tradesSignal`/`tradesAccountSignal`, `setTradeSelected` (`lib/signals.ts:439`), `jumpToEpic`, `requestConfirm`, `isDirty`.
- Produces:
  ```ts
  export function waitForTrade(account: TradeAccount, dealId: string, timeoutMs = 15_000): Promise<string | null>;
  ```
  Resolves `dealId` once `tradesAccountSignal.value === account` and `tradesSignal.value` holds a position with that id; resolves `null` on timeout or if `tradesAccountSignal` moves to a different account first.

- [ ] **Step 1: Failing tests** for `waitForTrade`: resolves at once when already present; resolves when a later `tradesSignal.set` adds it; resolves `null` after 15 s (fake timers); resolves `null` when the account signal changes to another account.
- [ ] **Step 2: Run** `npx vitest run src/lib/allAccounts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `waitForTrade`**, then in `App.tsx` add `openAccountPosition(account, epic, dealId)`:
  - `account === activeAccount`: `await jumpToEpic(epic)`, then `setTradeSelected(dealId)`.
  - Otherwise `requestConfirm({ title: "Switch account?", message: "This position is on {brokerLabel(target broker)}. Switch from {brokerLabel(current broker)} to open {epic}?", confirmLabel: "Switch" })`, appending ` Unsaved changes to this layout will be discarded.` only when the broker differs and `isDirty`.
  - On confirm, same broker (paper to dealing): `switchAccountConfirmed(account)`, `await jumpToEpic(epic)`, then `const id = await waitForTrade(account, dealId); if (id) setTradeSelected(id)`.
  - On confirm, other broker: park `{ broker, fromBroker, tabsBefore, epic, account, dealId }` in `pendingBrokerNavRef` (widen its type: `target` becomes optional, `account`/`dealId` optional), call `switchAccountConfirmed(account)`. In the landing effect, when the request carries `dealId`, run the same jump + `waitForTrade` + select instead of `openAlert`.
  - Pass `onOpenAccountPosition={openAccountPosition}` to `<PositionsPanel>`.
- [ ] **Step 4: Run** the test file, then `cd frontend && npx tsc -b` and `npx eslint src/App.tsx src/AllAccountsPane.tsx src/PositionsPanel.tsx src/lib/allAccounts.ts src/app/useAllAccounts.ts src/app/useAccounts.ts`. Expected: PASS, zero errors.
- [ ] **Step 5: Manual check in local dev** (backend with at least two dealing accounts): open the tab, see other accounts load; click a position on another broker, confirm, land on that account with the trade selected in the ticket; Cancel leaves everything as it was.
- [ ] **Step 6: Commit** `feat(dock): open a position from All accounts`.

### Task 6: Docs

**Files:**
- Modify: `CLAUDE.md` (short "All accounts tab" section under Account history: where the code lives, the two poll intervals, view-only rows, row click flow).

- [ ] **Step 1:** Write the section (5 to 8 lines, no em dashes).
- [ ] **Step 2: Commit** `docs: All accounts tab`.
