# Slim the Ten Largest Modules — Implementation Plan

> **Addendum 2026-07-10 — codebase re-survey.** Tasks 1–3 (persist, customIndicators,
> api/app.py) are done and committed. All line numbers below are stale — locate
> symbols by name. Per-task drift found by a fresh survey:
>
> - **Task 4 (BacktestSettingsModal, now 2,482 lines, +59%):** grew via the sweep
>   feature + coded-strategies panel. All four planned extractions still map, BUT
>   `RiskSection` and `RuleGroupSection` are now **exported and imported by
>   `LiveTradingPanel.tsx`** — extract them to files both can import (the planned
>   `RuleBuilder.tsx` / `RiskScalingSections.tsx` work; update LiveTradingPanel's
>   imports in the same commit). `RiskSection` also gained an optional sweep prop.
>   New: `SweepAxisRow` (small) belongs with RiskScalingSections.
> - **Task 5 (IndicatorSettings, now 2,590 lines):** plan applies as-is. Two NEW
>   families since the plan — SESSIONS and TIME_HIGHLIGHT — follow the same
>   pattern; add `SessionsPanels.tsx` + `TimeHighlightPanels.tsx` extractions (or
>   fold into one `TimePanels.tsx`) after the planned five.
> - **Task 6 (capital/ig dedup):** valid as written EXCEPT Step 3's `_parse_prices`
>   dedup — the bodies differ (capital parses `snapshotTimeUTC` only; IG falls back
>   to local `snapshotTime`, no resolution param). Keep both; extract only the
>   genuinely shared helpers. **mt5.py (1,245 lines) is NOT a SessionAuthBroker
>   candidate** — SDK-based auth, no duplication with capital/ig; leave it alone.
> - **Task 7 (overlays.ts, now 2,184 lines):** plan applies cleanly; no new method
>   groups; 4 importers now (was 3).
> - **Task 8 (App.tsx, now 1,876 lines):** plan applies; ~10 modal subscriptions
>   now (sweep + live added, same pattern). New orthogonal UI state
>   (`maximized`/`dockMaximized`/`maximizedCellId`) can stay in App.
> - **Task 9 (ChartCore, now 5,951 lines, +961 since plan):** core extractions all
>   still valid. Adjustments: ChartHandle needs the newer refs
>   (`aggMarkersRef`, `exitAggMarkersRef`, `paintBracketRef`, `paintSeparatorRef`, …);
>   Step 13's `useLineDrag` must decide whether it owns the NEW slope-tool handle
>   drag (~130 lines, recommend: yes, same engine); add a NEW extraction
>   **`useTradeMarkers.ts`** (trade markers + exit clustering + aggregate pills,
>   ~200 lines) distinct from the position-pill system; TradePills needs a state
>   hook (positioning/hover state stays in ChartCore or a `useTradePills`).
>
> **New candidates found (not in the original ten) — appended as Tasks 10–11:**
> - **Task 10: `lib/backtest.ts` (1,477 lines, 47 importers)** — extract overlay
>   factories (~250 lines), artifacts lifecycle (~200), marker drawing (~140)
>   behind a barrel. Strongest new candidate.
> - **Task 11: `lib/feed.ts` (680 lines, 22 importers)** — resolution tables / API
>   fetch / metadata / WebSocket are separable; barrel keeps importers stable.
> - Assessed and rejected: PositionsPanel, OrderTicket, positionLines,
>   customOverlays, ChartLegend (cohesive); Toolbar, trading.ts (marginal, defer);
>   paper_exec, capital_stream, schemas, coded.py, routers (backend fine).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the ten oversized modules in `auto_trader` into focused files with one responsibility each, changing zero behavior.

**Architecture:** Every split follows a seam that already exists (a registry loop, a per-indicator tab, a domain-grouped route list, two parallel broker classes). For heavily-imported `lib/` modules we keep the original file as a **barrel re-export** so no call site changes. For components we move in-file sub-components into their own files and let the parent import them. Backend routes become `APIRouter` modules; the two broker adapters get a shared session base so neither imports the other.

**Tech Stack:** React 18 + TypeScript + Vite (frontend), FastAPI + Pydantic v2 (backend). Tests: Vitest (unit), Playwright (e2e), pytest (backend).

## Global Constraints

- **No behavior change.** These are pure relocations + thin seams. If a diff changes runtime logic, it is out of scope for this plan.
- **No backward-compat/migration code** without asking (project rule: single user, no old data). Barrel re-exports are allowed and expected as a *transitional import shim*, not migration code.
- **Work on `main`.** Do not create feature branches (project rule). Commit directly to `main` after each green task.
- **Keep public import paths stable** wherever a module has multiple importers — use a barrel re-export from the original path.
- **Follow existing conventions:** shared `Tooltip`/`InfoTip` for tooltips; light theme is canonical; no shadows.
- **Line numbers** reference the working tree as of 2026-07-05 (branch `main`); re-locate symbols by name if line numbers have drifted.

## Verification Loop (applies to every task)

Because each task only relocates code, the loop is:

1. **Establish baseline green** (once, Task 0): all suites pass before touching anything.
2. **Extract** one cohesive chunk into its new file.
3. **Rewire**: original file imports/re-exports the moved symbols; fix any now-broken relative import paths in the moved code.
4. **Verify green** with the exact commands per task (typecheck + relevant tests).
5. **Commit.**

Never batch two extractions into one commit — one extraction per commit so any regression bisects cleanly.

**Canonical commands:**
- Frontend typecheck + build: `cd frontend && npm run build`
- Frontend unit tests: `cd frontend && npm run test:unit`
- Frontend lint: `cd frontend && npm run lint`
- Frontend e2e (only where a task touches chart interaction): `cd frontend && npx playwright test <spec>`
- Backend tests: `cd backend && .venv/bin/pytest -q`

---

## Task 0: Baseline green + safety net

**Files:** none (verification only)

**Interfaces:**
- Produces: a confirmed-green starting point. Every later task compares against this.

- [ ] **Step 1: Confirm working tree is committed or stashed**

Run: `git status --short`
Expected: note any pre-existing unstaged changes (there are several modified files per the repo snapshot). Commit or stash unrelated work so refactor commits stay isolated. Ask the user if unsure what to do with pre-existing edits.

- [ ] **Step 2: Frontend builds clean**

Run: `cd frontend && npm run build`
Expected: exit 0, no TS errors.

- [ ] **Step 3: Frontend unit tests pass**

Run: `cd frontend && npm run test:unit`
Expected: all pass. Record the count.

- [ ] **Step 4: Backend tests pass**

Run: `cd backend && .venv/bin/pytest -q`
Expected: all pass. Record the count.

- [ ] **Step 5: Smoke the e2e suite once (baseline)**

Run: `cd frontend && npx playwright test --reporter=line`
Expected: record pass/fail baseline. If some specs are already flaky/red before refactoring, note them — a task is "green" if it doesn't make a previously-green spec red.

---

## Task 1: Split `lib/persist.ts` (1,723 → barrel + 5 domain files)

**Rationale:** cleanly sectioned, 18 importers → barrel keeps them all working. Lowest risk, biggest tree shrink. Do first.

**Files:**
- Create: `frontend/src/lib/persist/core.ts`
- Create: `frontend/src/lib/persist/workspace.ts`
- Create: `frontend/src/lib/persist/alerts.ts`
- Create: `frontend/src/lib/persist/defaults.ts`
- Create: `frontend/src/lib/persist/artifacts.ts`
- Modify: `frontend/src/lib/persist.ts` (becomes a barrel re-export)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `frontend/src/lib/persist.ts` continues to export **every** currently-exported symbol (via `export * from './persist/*'`). No public signature changes.

- [ ] **Step 1: Create `persist/core.ts` — the storage + backend-mirror engine**

Move lines 49–475 of `persist.ts` (keying: `setPersistBroker`/`getPersistBroker`/`isCapitalBroker`/`root`/`brokerRoot`/`familyRoot`/`ns`/`isDeviceLocalKey`; storage core: `mirrorSet`/`mirrorDelete`/`load`/`save`/`saveLocal`/`removeLocal`/`loadSettingsRaw`/`loadMagnet`/`hydrateFromBackend`/`seedBackendFromLocal`/`StateMessage`/`onTradesDirty`/`subscribeToBackendUpdates`) into `persist/core.ts`. Fix relative imports (add one `../` level: `./x` → `../x`). Export everything that was exported before.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: fails only inside `persist.ts` (symbols now missing) — that's expected mid-extraction; the barrel step fixes it. If any *other* file errors, a symbol was missed.

- [ ] **Step 3: Create `persist/workspace.ts` — tabs, layouts, workspaces**

Move lines 475–888 (`LayoutKind`/`ChartCell`/`ChartTab`, tab migration, `loadTabs`/`saveTabs`/`canMergeTabs`/`mergeTabInto`/`unmergeScopes`; `LayoutMeta`/`Workspace`, `loadLayouts`/`loadLayout`/`saveLayout`/`renameLayout`/`deleteLayout`, default/active/scratch/autosave, `cloneWorkspace`/`copyScopeContent`). Import needed core helpers from `./core`. Fix relative imports.

- [ ] **Step 4: Create `persist/alerts.ts` — alerts + triggered history**

Move lines 1368–1680 (`AlertCondition`/`SavedAlert`, `normalizeAlert`, stored-alert load/save/update/delete, `loadAllAlerts`, `pruneLegacyGlobalWorkspace`; `TriggeredAlert`, load/push/seen). Import from `./core`.

- [ ] **Step 5: Create `persist/defaults.ts` — indicator/drawing defaults, presets, templates**

Move lines 1074–1308 (defaults/presets 1074–1165, backtest config/presets/split 1165–1236, symbol & default templates 1237–1308, indicator config records 1309–1367). Import from `./core`.

- [ ] **Step 6: Create `persist/artifacts.ts` — per-chart artifacts + favorites/recents + AVWAP anchors**

Move lines 890–1073 + 1683–1723 (drawings/backtest/indicators/scalePriceOnly/legendCollapsed; favorites/recents; AVWAP anchors + scope purge). Import from `./core`.

- [ ] **Step 7: Rewrite `persist.ts` as a barrel**

Replace the file body with:

```ts
export * from './persist/core'
export * from './persist/workspace'
export * from './persist/alerts'
export * from './persist/defaults'
export * from './persist/artifacts'
```

- [ ] **Step 8: Typecheck + build**

Run: `cd frontend && npm run build`
Expected: exit 0. If a symbol is "declared in two files" (duplicate export), it was moved to two places — pick one home.

- [ ] **Step 9: Unit tests**

Run: `cd frontend && npm run test:unit`
Expected: same pass count as Task 0.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/persist.ts frontend/src/lib/persist/
git commit -m "refactor(persist): split storage god-module into core + 4 domain files behind a barrel"
```

---

## Task 2: Split `lib/customIndicators.ts` (1,880 → barrel + per-indicator files)

**Rationale:** `BASE_TEMPLATES` registry loop already exists; each entry references only its own helpers. 7 importers → barrel.

**Files:**
- Create: `frontend/src/lib/indicators/shared.ts`
- Create: `frontend/src/lib/indicators/ma.ts`
- Create: `frontend/src/lib/indicators/lr.ts`
- Create: `frontend/src/lib/indicators/vwap.ts`
- Create: `frontend/src/lib/indicators/prevHl.ts`
- Create: `frontend/src/lib/indicators/rsi.ts`
- Create: `frontend/src/lib/indicators/curveLabels.ts`
- Modify: `frontend/src/lib/customIndicators.ts` (assembles `BASE_TEMPLATES` from partials; stays the barrel + registration point)

**Interfaces:**
- Consumes: nothing.
- Produces: `customIndicators.ts` keeps exporting `CustomIndicatorType`, `BASE_TEMPLATES`, `registerCustomIndicators`, `OVERLAY_INDICATORS`, and all the per-indicator types/helpers currently exported (re-exported from partials). `registerCustomIndicators()` remains the single registration entry point.

- [ ] **Step 1: Create `indicators/shared.ts`**

Move `indTypeOf` (41), `legendTooltipSource` (48), `fullLine` helper (in 56–184 block), and re-export `priceOf`/`hexToRgba` sources. Fix imports (`./x` → `../x`).

- [ ] **Step 2: Create `indicators/ma.ts`**

Move MA point/figures/styles (186–223), `MaExtend` (198), `computeMa` (in 1036–1081), and the EMA + MA template *bodies* (the `Omit<IndicatorTemplate,"name">` objects at 1739, 1749) — export them as `EMA_TEMPLATE`, `MA_TEMPLATE`. Import shared helpers from `./shared`.

- [ ] **Step 3: Create `indicators/lr.ts`**

Move Linear Regression Channel (`computeLr`, types, styles 225–301) and the LR template body (1762) as `LR_TEMPLATE`.

- [ ] **Step 4: Create `indicators/vwap.ts`**

Move VWAP/AVWAP math (`vwapFrom`, band styles 56–184), `BandMode`/`BandSetting`/`AvwapExtend`/`AVWAP_DEFAULT_BANDS` (71–87), and the VWAP + AVWAP template bodies (1781, 1788) as `VWAP_TEMPLATE`, `AVWAP_TEMPLATE`.

- [ ] **Step 5: Create `indicators/prevHl.ts` — carries the module-level tz state**

Move the whole Previous High/Low block (303–823 + default styles 1036–1052): types, `zoneFormatter`/`tzOffsetMs`/`resolvePrevHlZone`/`setIndicatorTimezone`, `computeBucketed`/`computeRolling`/`computeAnchor`/`computePrevHl`, `prevHlAnchorToInput`/`prevHlInputToAnchor`/`prevHlDegenerateInfo`/`prevHlLegendSummary`, `PrevHlAgg`/`PrevHlExtend`, and the PREV_HL template body (1824) as `PREV_HL_TEMPLATE`. **Critical:** the module-level mutable `indicatorTz` (396) + `tzFormatters` cache (407) mutated by the exported `setIndicatorTimezone` must move *with* this file (ChartCore calls `setIndicatorTimezone` — keep it re-exported from the barrel).

- [ ] **Step 6: Create `indicators/rsi.ts` — cleanest big lift**

Move the RSI block (1083–1725): `RsiPoint`/`RsiSmoothing`/`RsiDivergenceConfig`/`RSI_*_DEFAULTS`, `detectDivergences`, `smoothSeries`/`computeRsi`, `RsiStyle`/`RsiElement`, all `drawRsi*` canvas routines, `divVisual`, and the RSI template body (1845) as `RSI_TEMPLATE`. Import `priceOf`/`hexToRgba` from `./shared`.

- [ ] **Step 7: Create `indicators/curveLabels.ts`**

Move curve-end labels (825–1034): `CurveLabelSide/Align/Pos/ResolvedCurveLabels`, `curveLabelConfig`, `curveLabelPosFor`, `curveLabel` switch + per-type `*CurveLabel` helpers. The `curveLabel` switch (907–940) is the one cross-type point — keep it here as the central labeler.

- [ ] **Step 8: Rewrite `customIndicators.ts` as assembler + barrel**

```ts
export * from './indicators/shared'
export * from './indicators/ma'
export * from './indicators/lr'
export * from './indicators/vwap'
export * from './indicators/prevHl'
export * from './indicators/rsi'
export * from './indicators/curveLabels'

import { EMA_TEMPLATE, MA_TEMPLATE } from './indicators/ma'
import { LR_TEMPLATE } from './indicators/lr'
import { VWAP_TEMPLATE, AVWAP_TEMPLATE } from './indicators/vwap'
import { PREV_HL_TEMPLATE } from './indicators/prevHl'
import { RSI_TEMPLATE } from './indicators/rsi'
// ...assemble BASE_TEMPLATES exactly as before, keep CustomIndicatorType,
// registerCustomIndicators(), and OVERLAY_INDICATORS here.
```

Keep `BASE_TEMPLATES`, `CustomIndicatorType`, `registerCustomIndicators`, `OVERLAY_INDICATORS` defined/exported from this file.

- [ ] **Step 9: Build + unit tests**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0, unit pass count unchanged.

- [ ] **Step 10: e2e — indicators actually render**

Run: `cd frontend && npx playwright test higher-timeframes drawing-defaults --reporter=line`
Expected: same as baseline. (These specs exercise indicator add/hydrate paths.)

- [ ] **Step 11: Commit**

```bash
git add frontend/src/lib/customIndicators.ts frontend/src/lib/indicators/
git commit -m "refactor(indicators): one file per indicator behind BASE_TEMPLATES assembler"
```

---

## Task 3: Split `api/app.py` (1,488 → routers + deps + schemas)

**Rationale:** ~28 routes group cleanly by domain with near-zero cross-talk. The one coupling is the `_registry` module global (used 16×).

**Files:**
- Create: `backend/auto_trader/api/deps.py`
- Create: `backend/auto_trader/api/schemas.py`
- Create: `backend/auto_trader/api/routers/__init__.py`
- Create: `backend/auto_trader/api/routers/markets.py`
- Create: `backend/auto_trader/api/routers/trading.py`
- Create: `backend/auto_trader/api/routers/state.py`
- Create: `backend/auto_trader/api/routers/charts.py`
- Create: `backend/auto_trader/api/routers/backtest.py`
- Create: `backend/auto_trader/api/routers/stream.py`
- Modify: `backend/auto_trader/api/app.py` (thin assembler)

**Interfaces:**
- Consumes: nothing.
- Produces: `deps.py` exposes `get_data()`, `get_exec()`, `guarded()`, `BROKER_HEALTH`, and a registry accessor `get_registry()` that routers import instead of the module global. `app.py` keeps `app = FastAPI(...)` and `lifespan` and mounts every router — **all URL paths and response shapes stay byte-identical.**

- [ ] **Step 1: Create `deps.py` — lift shared infra**

Move `_registry` (77), `get_data` (80), `BROKER_HEALTH` (89), `guarded` (94), `get_exec` (127) into `deps.py`. Add `def get_registry(): return _registry`. Move `_run_paper_triggers` (148) too (it's infra, used by lifespan). Keep the singletons module-level in `deps.py`.

- [ ] **Step 2: Create `schemas.py` — all DTOs**

Move every Pydantic model (226–482, 620–680, 756–783, 911–915) and their `to_*` converters into `schemas.py`. This is ~30 classes including the large backtest request models. Import from `schemas` where used.

- [ ] **Step 3: Backend tests still import-safe**

Run: `cd backend && .venv/bin/pytest -q tests/test_api_backtest.py`
Expected: PASS (DTO move didn't change behavior). If import errors, a model referenced a helper left in `app.py` — move that helper too.

- [ ] **Step 4: Create `routers/markets.py`**

`router = APIRouter()`. Move health (510), brokers (515), markets (523/534), market meta/detail (545/568), favorites list+write (583/593/605). Route decorators become `@router.get(...)`. Replace `_registry` refs with `Depends(get_registry)` or `get_registry()`.

- [ ] **Step 5: Create `routers/trading.py`**

Move the 9 trading routes (709, 762, 785, 799, 811, 827, 861, 873, 894) + their mappers `_order_result_dto`/`_position_dto`/`_working_order_dto`. Import DTOs from `schemas`, infra from `deps`.

- [ ] **Step 6: Create `routers/state.py`**

Move state routes (949, 964, 974) + `/ws/state` (982) + `_broadcast_state` (928) + the `_state_subscribers` set. Keep the pub-sub state module-level in this router file.

- [ ] **Step 7: Create `routers/charts.py`**

Move `_fetch_leg_candles` (999), `_candle_dto`/`_ts`/`_parse_resolution` (484–508), candles/synthetic/cache-stats routes (1116, 1144, 1181, 1212).

- [ ] **Step 8: Create `routers/backtest.py`**

Move `_candle_from_dto` (1219) + `POST /api/backtest` (1226). Request DTOs come from `schemas`.

- [ ] **Step 9: Create `routers/stream.py`**

Move `/ws/candles` (1332–1489) + `_fetch_leg_candles` usage (import from `charts` or a shared `_candles.py` if both need it — if shared, extract `_fetch_leg_candles` into `deps.py` or a `_candles.py` and import in both).

- [ ] **Step 10: Rewrite `app.py` as assembler**

Keep imports, `_configure_logging`, `lifespan` (184), `app = FastAPI(..., lifespan=lifespan)` (215), CORS middleware (215–223). Then:

```python
from .routers import markets, trading, state, charts, backtest, stream
app.include_router(markets.router)
app.include_router(trading.router)
app.include_router(state.router)
app.include_router(charts.router)
app.include_router(backtest.router)
app.include_router(stream.router)
```

- [ ] **Step 11: Full backend suite**

Run: `cd backend && .venv/bin/pytest -q`
Expected: same pass count as Task 0. The API tests hit real paths — if a route 404s, its prefix changed (routers must mount at the same paths, no prefix unless the original had one).

- [ ] **Step 12: Commit**

```bash
git add backend/auto_trader/api/
git commit -m "refactor(api): split monolithic app.py into domain routers + deps + schemas"
```

---

## Task 4: Split `BacktestSettingsModal.tsx` (1,557 → shell + 4 files)

**Rationale:** 11 sub-components already defined in-file, communicating only via `cfg`/`setCfg`. Move them out — low tangle.

**Files:**
- Create: `frontend/src/backtest/rangeUtils.ts`
- Create: `frontend/src/backtest/WindowTimeline.tsx`
- Create: `frontend/src/backtest/RuleBuilder.tsx`
- Create: `frontend/src/backtest/RiskScalingSections.tsx`
- Modify: `frontend/src/BacktestSettingsModal.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `rangeUtils.ts` exports the pure helpers (`maskTz`, `toggle`, `minToTime`, `timeToMin`, `withStart`, `withEnd`, `formatDateRange`, `rangeDateLabel`, `estimateWindowBars`, `defaultOperand`, `defaultRule`) with identical signatures. `RuleBuilder.tsx` exports `RuleGroupSection` (+ its internal `OperatorPicker`/`RuleMenu`/`OperandPicker`). `RiskScalingSections.tsx` exports `RiskSection`, `ScalingSection`, `SidePanel`. The modal imports and renders them exactly where they were.

- [ ] **Step 1: Create `backtest/rangeUtils.ts`**

Move pure helpers + data tables the helpers depend on (time/window/date math, `defaultOperand`/`defaultRule`, and the const tables at 49–157 that these use). Export each.

- [ ] **Step 2: Create `backtest/WindowTimeline.tsx`**

Move `WindowTimeline` (230–258) + `CrossGlyph`/`OpGlyph` (158–186) if only used by the timeline; otherwise leave glyphs where the rule builder needs them. Import helpers from `./rangeUtils`.

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: errors only in `BacktestSettingsModal.tsx` (moved symbols) — fixed when the modal imports them back.

- [ ] **Step 4: Create `backtest/RuleBuilder.tsx`**

Move `OperatorPicker` (1170), `RuleMenu` (1282), `RuleGroupSection` (1366), `OperandPicker` (1466) + `KebabIcon`/`EyeIcon` + `isCrossOp` + rule glyphs/consts (1162–1575). Export `RuleGroupSection` (the entry point the modal renders); keep the others module-private. Import from `./rangeUtils`.

- [ ] **Step 5: Create `backtest/RiskScalingSections.tsx`**

Move `RiskSection` (935–1003), `ScalingSection` (1004–1051), `SidePanel` (1052–1138), `SectionTitle` (1139), `Section` (1148). Export the three sections (+ `Section`/`SectionTitle` if the modal body still uses them; if so export them, else keep private).

- [ ] **Step 6: Rewire the modal**

In `BacktestSettingsModal.tsx`, add imports:

```ts
import { WindowTimeline } from './backtest/WindowTimeline'
import { RuleGroupSection } from './backtest/RuleBuilder'
import { RiskSection, ScalingSection, SidePanel } from './backtest/RiskScalingSections'
import { /* helpers used inline */ } from './backtest/rangeUtils'
```

Delete the now-moved definitions. The four scroll sections (period/strategy/costs/presets) stay in the modal for now.

- [ ] **Step 7: Build + unit**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0, unchanged pass count.

- [ ] **Step 8: e2e — backtest config still works**

Run: `cd frontend && npx playwright test --grep -i backtest --reporter=line`
Expected: same as baseline (falls back to running all specs if grep matches none — check the spec list; if there's a dedicated backtest spec, name it).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/backtest/
git commit -m "refactor(backtest): extract rule-builder, risk/scaling sections, range utils from modal"
```

---

## Task 5: Split `IndicatorSettings.tsx` (2,254 → shell + per-family panels)

**Rationale:** each indicator appears 4× (state, writer, serialization, panel). Move each family's four parts together into a sub-component; the shell dispatches on `type`. Higher tangle — three shared seams (`lines`/`LineDraft` model, mega persistence `useEffect`, `currentConfig()`). Do the low-tangle `DefaultsMenu` first to prove the seam.

**Files:**
- Create: `frontend/src/indicatorSettings/shared.ts`
- Create: `frontend/src/indicatorSettings/DefaultsMenu.tsx`
- Create: `frontend/src/indicatorSettings/RsiPanels.tsx`
- Create: `frontend/src/indicatorSettings/PrevHlPanels.tsx`
- Create: `frontend/src/indicatorSettings/MaAvwapPanels.tsx`
- Modify: `frontend/src/IndicatorSettings.tsx`

**Interfaces:**
- Consumes: `customIndicators` per-indicator types (from Task 2 — unchanged import path).
- Produces: `shared.ts` exports `parseColor`, `toColor`, `IntInput`, the line-style model types (`LineDraft`), and the static config tables (`DEFAULT_LINE_PALETTE`, `CURVE_LABEL_TYPES`, `RSI_*`, `PREV_HL_*`). Each `*Panels.tsx` exports a component taking `{ type, extendData, overrideIndicator, currentConfig, ... }` props (the exact prop set is whatever state+callbacks that family currently reads — thread them explicitly). `IndicatorSettings` becomes a tab/modal shell that renders the right panel by `type`.

- [ ] **Step 1: Create `indicatorSettings/shared.ts`**

Move `parseColor` (203–211), `toColor` (212–218), `IntInput` (224–254), `LineDraft` (256–264), and the static tables (88–195). Export all. Fix imports.

- [ ] **Step 2: Typecheck (expect only IndicatorSettings errors)**

Run: `cd frontend && npx tsc -b`
Expected: missing-symbol errors only in `IndicatorSettings.tsx`.

- [ ] **Step 3: Import shared back into the modal, verify green**

Add `import { parseColor, toColor, IntInput, ... } from './indicatorSettings/shared'` and delete the moved defs.

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0.

- [ ] **Step 4: Commit the low-risk shared extraction**

```bash
git add frontend/src/IndicatorSettings.tsx frontend/src/indicatorSettings/shared.ts
git commit -m "refactor(indicator-settings): extract shared helpers + config tables"
```

- [ ] **Step 5: Create `indicatorSettings/DefaultsMenu.tsx`**

Move the presets/set-as-default footer JSX (2172–2250) + its logic `applyConfigToOpenInstance`/`saveAsDefault`/`resetToDefault`/`commitPreset`/`applyPreset`/`removePreset` (1014–1080). Props: `{ type, currentConfig, recreate }`. Render `<DefaultsMenu .../>` where the footer was.

- [ ] **Step 6: Build + unit + commit**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0.

```bash
git add frontend/src/IndicatorSettings.tsx frontend/src/indicatorSettings/DefaultsMenu.tsx
git commit -m "refactor(indicator-settings): extract defaults/presets menu"
```

- [ ] **Step 7: Create `indicatorSettings/RsiPanels.tsx`**

Move the RSI Input panel (1410–1503), Divergence tab (1505–1666), RSI Style block (1998–2124), the `rsi*` state (subset of 303–546), and the `setRsi*` writers (332–397). The component owns this state and takes the shared seams as props: `{ extendData, overrideIndicator, lines, setLine, registerConfig }` — thread exactly what these panels read. The parent's `currentConfig()` RSI branch delegates to a `rsiConfig()` exported from this file.

- [ ] **Step 8: Build + unit + RSI e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0. Manually verify (or e2e if a spec exists) that opening RSI settings shows all three tabs.

```bash
git add frontend/src/IndicatorSettings.tsx frontend/src/indicatorSettings/RsiPanels.tsx
git commit -m "refactor(indicator-settings): extract RSI panels + state"
```

- [ ] **Step 9: Create `indicatorSettings/PrevHlPanels.tsx`**

Move PREV_HL Inputs (1708–1887), style pairs (1908–1944), `prevHl*` state (429–454), `setPrevHl*` writers (561–639), `boundaryActive`/`setBoundaryVisible`. Delegate `currentConfig()`'s PREV_HL branch (749–765) to a `prevHlConfig()` export.

- [ ] **Step 10: Build + unit + commit**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0.

```bash
git add frontend/src/IndicatorSettings.tsx frontend/src/indicatorSettings/PrevHlPanels.tsx
git commit -m "refactor(indicator-settings): extract PREV_HL panels + state"
```

- [ ] **Step 11: Create `indicatorSettings/MaAvwapPanels.tsx`**

Move MA/EMA panel (1233–1340) + `applyMa` (819–847), AVWAP panel (1342–1408) + `applyAvwap` + the `bands.map`. Delegate their `currentConfig()` branches.

- [ ] **Step 12: Build + unit + e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test drawing-defaults higher-timeframes --reporter=line`
Expected: same as baseline.

```bash
git add frontend/src/IndicatorSettings.tsx frontend/src/indicatorSettings/MaAvwapPanels.tsx
git commit -m "refactor(indicator-settings): extract MA/AVWAP panels; shell now dispatches by type"
```

---

## Task 6: Dedup `capital.py` + `ig.py` (shared session base + neutral helpers)

**Rationale:** `ig.py` imports 7 helpers from `capital.py` today. Extract neutral modules so neither broker depends on the other, and collapse near-verbatim auth into a base class. This is dedup, not just splitting — verify heavily against `test_capital.py`, `test_ig.py`, `test_capital_exec.py`.

**Files:**
- Create: `backend/auto_trader/brokers/_market_hours.py`
- Create: `backend/auto_trader/brokers/_prices.py`
- Create: `backend/auto_trader/brokers/_session.py`
- Create: `backend/auto_trader/brokers/_ig_dealing.py`
- Modify: `backend/auto_trader/brokers/capital.py`
- Modify: `backend/auto_trader/brokers/ig.py`

**Interfaces:**
- Consumes: existing `AsyncConfirmExecutionBroker` from `_dealing.py`.
- Produces: `_market_hours.py` exports `_minute_of_day`, `_market_hours_state`, `_OH_DAYS`. `_prices.py` exports `_RateLimiter`, `pick_side`, `PriceSide`, `_mid`, `_price_precision`, `_to_utc`, `_parse_utc`, `_parse_prices`. `_session.py` exports `SessionAuthBroker` with overridable seams `_login_headers()`, `_capture_login(resp)`, `_auth_headers()`. `_ig_dealing.py` exports IG's marketable-limit helpers. Both brokers keep their public class names (`CapitalComBroker`, `CapitalExecutionBroker`, `IGBroker`, `IGExecutionBroker`) and `register`/`register_live` functions unchanged.

- [ ] **Step 1: Create `_market_hours.py` (pure, no behavior change)**

Move `_minute_of_day` (capital 150), `_market_hours_state` (164), `_OH_DAYS` (147) verbatim. In `capital.py` replace the definitions with `from ._market_hours import _minute_of_day, _market_hours_state`. In `ig.py` change its import from `.capital` to `._market_hours`.

- [ ] **Step 2: Backend broker tests**

Run: `cd backend && .venv/bin/pytest -q tests/test_capital.py tests/test_ig.py`
Expected: PASS.

- [ ] **Step 3: Create `_prices.py`**

Move `_RateLimiter` (capital 72), `pick_side` (101)/`PriceSide` (98), `_mid` (119), `_price_precision` (126), `_to_utc` (1203)/`_parse_utc` (1209), and the two brokers' `_parse_prices` (dedup capital 1175 + ig 868 into one — confirm the two bodies are identical first; if they differ, keep both temporarily and note the diff for the user). Rewire both brokers to import from `._prices`.

- [ ] **Step 4: Broker tests**

Run: `cd backend && .venv/bin/pytest -q tests/test_capital.py tests/test_ig.py tests/test_capital_stream.py`
Expected: PASS. (`capital_stream.py` imports from capital — confirm its imports still resolve.)

- [ ] **Step 5: Commit the neutral-helper extraction**

```bash
git add backend/auto_trader/brokers/_market_hours.py backend/auto_trader/brokers/_prices.py backend/auto_trader/brokers/capital.py backend/auto_trader/brokers/ig.py
git commit -m "refactor(brokers): move shared helpers to neutral modules; ig no longer imports capital"
```

- [ ] **Step 6: Create `_session.py` — `SessionAuthBroker` base**

Write a base class capturing the shared auth lifecycle: `_session_valid` (capital 304 / ig 140), `_ensure_session` with session-429 retry (capital 311 / ig 147), and the 401-reauth loop inside `_request` (capital 374 / ig 195). Expose seams:
- `_login_headers(self) -> dict` — per-broker (`X-CAP-API-KEY` vs `X-IG-API-KEY`, `Version`, etc.)
- `_capture_login(self, resp)` — capture broker-specific login fields (CST/security tokens vs IG-ACCOUNT-ID)
- `_auth_headers(self) -> dict` — per-request auth headers

Diff the two auth bodies line-by-line first; only the header names / captured fields should differ. If logic differs beyond that, stop and surface it — do not force a merge.

- [ ] **Step 7: Make `CapitalComBroker` extend `SessionAuthBroker`**

Replace its auth block (302–397) with the three seam overrides. Keep ctor host/env detection.

- [ ] **Step 8: Capital tests**

Run: `cd backend && .venv/bin/pytest -q tests/test_capital.py tests/test_capital_exec.py`
Expected: PASS. The 429/401 retry paths are covered — if they fail, the base's retry loop diverged from the original.

- [ ] **Step 9: Make `IGBroker` extend `SessionAuthBroker`**

Replace its auth block (138–233) with seam overrides (add `Version` + `IG-ACCOUNT-ID` header handling).

- [ ] **Step 10: IG tests**

Run: `cd backend && .venv/bin/pytest -q tests/test_ig.py`
Expected: PASS.

- [ ] **Step 11: Commit the session base**

```bash
git add backend/auto_trader/brokers/_session.py backend/auto_trader/brokers/capital.py backend/auto_trader/brokers/ig.py
git commit -m "refactor(brokers): shared SessionAuthBroker base collapses duplicated auth"
```

- [ ] **Step 12: Create `_ig_dealing.py` — IG-only marketable-limit helpers**

Move `_market_open_body` (728), `_close_body` (760), `_marketable_level` (780), `_snapshot_precision` (806), `_quantize_level` (815), `_first_affected` (825), `_currency_from_raw` (719). `ig.py` imports them.

- [ ] **Step 13: Full backend suite + commit**

Run: `cd backend && .venv/bin/pytest -q`
Expected: same pass count as Task 0.

```bash
git add backend/auto_trader/brokers/_ig_dealing.py backend/auto_trader/brokers/ig.py
git commit -m "refactor(brokers): extract IG marketable-limit dealing helpers"
```

---

## Task 7: Split `lib/overlays.ts` (1,833 → core + by-kind modules)

**Rationale:** one class conflates 4 overlay kinds + styles + persistence, sharing `entries` map + `create()` event pump. Only 3 importers. Higher tangle — extract in dependency order: styles → tools → drawingDisplay → hydration → alerts. Because `OverlayManager` is a class, use **class-augmentation via mixins or delegate objects**, not a barrel.

**Files:**
- Create: `frontend/src/lib/overlays/styles.ts`
- Create: `frontend/src/lib/overlays/tools.ts`
- Create: `frontend/src/lib/overlays/drawingDisplay.ts`
- Create: `frontend/src/lib/overlays/hydration.ts`
- Create: `frontend/src/lib/overlays/alerts.ts`
- Modify: `frontend/src/lib/overlays.ts` (keeps `OverlayManager` class + `create()` pump; delegates to the modules)

**Interfaces:**
- Consumes: nothing.
- Produces: `overlays.ts` keeps exporting `OverlayManager`, `AlertConfig`, `DrawingExtra`, `asDrawingExtra`, `cloneStyles` with identical signatures. Extracted modules export **free functions** that take `(mgr, ...)` or take the raw `chart`/`entries` they need — the class methods become thin wrappers calling these. Method names on `OverlayManager` do not change (3 importers call them).

- [ ] **Step 1: Create `overlays/styles.ts` (trivial, pure)**

Move `mergeStyles` (49), `cloneStyles` (75), `AlertConfig` (79), `DrawingExtra` (99), `asDrawingExtra` (112), `sameAlertCfg` (120). Re-export the public ones (`cloneStyles`, `AlertConfig`, `DrawingExtra`, `asDrawingExtra`) from `overlays.ts`.

- [ ] **Step 2: Build + unit + commit**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0.

```bash
git add frontend/src/lib/overlays.ts frontend/src/lib/overlays/styles.ts
git commit -m "refactor(overlays): extract style helpers + config types"
```

- [ ] **Step 3: Create `overlays/tools.ts` — measure + rangeBand (nearly standalone)**

Move `startMeasureDraw`/`clearMeasure`/`hasMeasure`/`isMeasureDrawing` (836–870) and `startRangePick`/`updateRangePick`/`finishRangePick`/`clearRangePick` (872–922) as free functions taking the manager (or its `chart` + measure/rangeBand state). The `OverlayManager` methods delegate: `startMeasureDraw() { return startMeasureDraw(this) }`.

- [ ] **Step 4: Build + unit + measure e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0. If a `measure` e2e spec exists, run it.

```bash
git add frontend/src/lib/overlays.ts frontend/src/lib/overlays/tools.ts
git commit -m "refactor(overlays): extract measure + range-band tools"
```

- [ ] **Step 5: Create `overlays/drawingDisplay.ts` — visibility/fade model**

Move the display/visibility methods (1025–1360: `effectiveVisible`, `applyDisplay`, `fade`/`unfade`, `setVisible`/`setVisibilityModel`/`setPriceLabels`/`setText`/`setShowMiddle`, `setResolution`, `setLock`, `updatePoints`, `getDrawingConfig`/`applyDrawingConfig`, `bringToFront`/`sendToBack`/`setExtend`) as free functions over `(mgr, ...)`. Delegate from the class.

- [ ] **Step 6: Build + unit + drawing e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test drawing-defaults draw-sidebar --reporter=line`
Expected: same as baseline.

```bash
git add frontend/src/lib/overlays.ts frontend/src/lib/overlays/drawingDisplay.ts
git commit -m "refactor(overlays): extract drawing visibility/fade model"
```

- [ ] **Step 7: Create `overlays/hydration.ts`**

Move `rehydrate`, `barIntervalMs`, `materializePoints`, `applyOlderBars`, `shiftIndexAnchoredPoints`, `stablePoints`, `persist` (1607–1833). Delegate from the class.

- [ ] **Step 8: Build + unit + hydration e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test drawing-anchor-timeframes --reporter=line`

(If that spec name doesn't exist, run the full suite.) Expected: baseline.

```bash
git add frontend/src/lib/overlays.ts frontend/src/lib/overlays/hydration.ts
git commit -m "refactor(overlays): extract rehydrate + persist"
```

- [ ] **Step 9: Create `overlays/alerts.ts` (last — most shared state)**

Move alert selection/hover/drag (`beginAlertDrag`/`dragAlertTo`/`endAlertDrag`), `getAlerts`, `findAlertOverlayId*`, `toggleAlertTrigger`, `addAlert`/`updateAlert`/`getAlert`, `reconcileAlerts`, `cfgFromSaved`/`materializeSavedAlert` (341–500, 560–657, 1361–1495, 1572–1606) as free functions. They share `entries`, `alertCfg`/`alertIds`/`alertCreatedAt` maps — pass the manager instance so they read its fields. **Leave `create()` (657–835) in `overlays.ts`** — it's the shared pump.

- [ ] **Step 10: Build + unit + alert e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test alert-crosshair alert-pill-axis --reporter=line`
Expected: same as baseline.

```bash
git add frontend/src/lib/overlays.ts frontend/src/lib/overlays/alerts.ts
git commit -m "refactor(overlays): extract alert interaction/reconcile into its own module"
```

---

## Task 8: Split `App.tsx` (1,778 → shell + domain hooks)

**Rationale:** god-component, 28 state / 35 effects, ~6 domains. Extract each domain into a hook. Start with the largest self-contained one (`useWorkspaceLayout`).

**Files:**
- Create: `frontend/src/hooks/useWorkspaceLayout.ts`
- Create: `frontend/src/hooks/useAccounts.ts`
- Create: `frontend/src/hooks/useChartCells.ts`
- Create: `frontend/src/hooks/useBackendSync.ts`
- Create: `frontend/src/hooks/useModalRequests.ts`
- Create: `frontend/src/hooks/useGlobalShortcuts.ts`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `persist` (Task 1 barrel path unchanged).
- Produces: each hook returns exactly the state + callbacks `App`'s JSX currently reads for that domain (e.g. `useWorkspaceLayout()` returns `{ tabs, activeId, setLayout, addTab, detachCell, closeCell, mergeTabs, undoMerge, reorderTab, closeTab, switchLayout, saveActiveLayout, saveLayoutAs, removeLayout, toggleAutosave, ... }`). `App` composes the hooks and renders. No prop-drilling change to child components — the same values reach them.

- [ ] **Step 1: Create `hooks/useModalRequests.ts` (smallest, prove the seam)**

Move the 8 pub-sub `Request` subscriptions + their local state (244–263: `alertReq`, `alertEdit`, `alertGlobalEdit`, `confirm`, `indSettings`, `drawSettings`, plus `showBacktestCfg` trigger). Return `{ alertReq, alertEdit, ..., clear fns }`. `App` calls `const modals = useModalRequests()`.

- [ ] **Step 2: Build + unit + commit**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0.

```bash
git add frontend/src/App.tsx frontend/src/hooks/useModalRequests.ts
git commit -m "refactor(app): extract modal-request subscriptions into useModalRequests"
```

- [ ] **Step 3: Create `hooks/useGlobalShortcuts.ts`**

Move the two keydown listeners (269–283, 1340–1366) + magnet-key handling (1354–1358). Takes the callbacks it needs to fire (e.g. `onToggleSettings`, `onMagnet`) as params.

- [ ] **Step 4: Build + unit + commit**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0.

```bash
git add frontend/src/App.tsx frontend/src/hooks/useGlobalShortcuts.ts
git commit -m "refactor(app): extract global keyboard shortcuts hook"
```

- [ ] **Step 5: Create `hooks/useAccounts.ts`**

Move account/broker state (334–421: `accounts`, `activeAccount`, `accountSummary`, `lastAccountByBroker` ref, `prevBrokerRef`) + `selectBroker` (353) + account `load` (428). Return `{ accounts, activeAccount, accountSummary, selectBroker }`.

- [ ] **Step 6: Build + unit + commit**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0.

```bash
git add frontend/src/App.tsx frontend/src/hooks/useAccounts.ts
git commit -m "refactor(app): extract accounts/broker state into useAccounts"
```

- [ ] **Step 7: Create `hooks/useBackendSync.ts`**

Move hydration + backend push + settings mirror (380–560: `subscribeToBackendUpdates` wiring, `reseedFromLocal` 456, `onBackendPush` 508, `syncSettingsFromLocal` 524, `hydrateEpoch`). Return `{ hydrateEpoch }` + wires side effects internally.

- [ ] **Step 8: Build + unit + commit**

Run: `cd frontend && npm run build && npm run test:unit`
Expected: exit 0.

```bash
git add frontend/src/App.tsx frontend/src/hooks/useBackendSync.ts
git commit -m "refactor(app): extract backend hydration/sync into useBackendSync"
```

- [ ] **Step 9: Create `hooks/useChartCells.ts`**

Move cell registry/focus/jump/select (578–735: `readyRef`, `onCellReady` 614, `onCellFocus` 735, `jumpToEpic` 627, `openAlert` 655, `resolvePendingSelect` 594, `pendingSelectRef`, epic-reopen 694–735). Return the callbacks + `epicClosed`.

- [ ] **Step 10: Build + unit + cell e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test close-cell detach-cell --reporter=line`
Expected: same as baseline.

```bash
git add frontend/src/App.tsx frontend/src/hooks/useChartCells.ts
git commit -m "refactor(app): extract chart-cell registry/focus into useChartCells"
```

- [ ] **Step 11: Create `hooks/useWorkspaceLayout.ts` (largest)**

Move tab/layout management (876–1341: `setLayout`, `setCellSizes`, `toggleSync`, `toggleLock`, `addTab`, `detachCell`, `closeCell`, `swapCells`, `mergeTabs`, `undoMerge`, `reorderTab`, `closeTab`, `switchLayout`, `saveActiveLayout`, `saveLayoutAs`, `removeLayout`, `toggleAutosave`) + workspace state (289–318: `tabs`, `activeId`, `activeLayoutId`, `layoutRev`, `autosave`, `isDirty`, `pendingUndo`, `workspaceRef`, `activeLayoutIdRef`). Return everything the JSX + `TabBar`/`ChartGrid` read.

- [ ] **Step 12: Build + unit + full-ish e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test detach-cell close-cell --reporter=line`
Expected: same as baseline. This is the riskiest App extraction — if tab drag/merge/undo breaks, the returned callbacks lost a closure dependency.

```bash
git add frontend/src/App.tsx frontend/src/hooks/useWorkspaceLayout.ts
git commit -m "refactor(app): extract tab/layout management into useWorkspaceLayout"
```

---

## Task 9: Split `ChartCore.tsx` (5,095 → orchestrator + hooks) — LAST, highest risk

**Rationale:** the `*Ref`-mirror pattern exists so the one-time init effect can call functions defined later. **Extract the shared imperative-handle object first**, then peel off hooks. Do this behind the full e2e suite; commit + run e2e after every single extraction.

**Files:**
- Create: `frontend/src/chart/chartGeometry.ts`
- Create: `frontend/src/chart/chartPainters.ts`
- Create: `frontend/src/chart/useLiveMarketData.ts`
- Create: `frontend/src/chart/useRangeNavigation.ts`
- Create: `frontend/src/chart/useChartPaint.ts`
- Create: `frontend/src/chart/useIndicatorCommands.ts`
- Create: `frontend/src/chart/useLineDrag.ts`
- Create: `frontend/src/chart/usePointerCrosshair.ts`
- Create: `frontend/src/chart/AlertTags.tsx`
- Create: `frontend/src/chart/TradePills.tsx`
- Modify: `frontend/src/ChartCore.tsx`

**Interfaces:**
- Consumes: existing `lib/*` modules (unchanged).
- Produces: a shared `ChartHandle` type (an object holding `chartRef`, `overlays`, `redrawRef`, `posLinesRef`, `tradesRef`, `pendingRef`, `resRef`, `crosshairRef`, controller signals) passed into every extracted hook. Each hook takes `(handle, deps)` and wires its own effects. `ChartCore` shrinks to a ~600-line component that builds the handle, composes hooks, and renders JSX. No prop change to `ChartCore`'s own `Props`.

- [ ] **Step 1: Extract pure helpers first (zero shared state)**

Move module-level helpers (141–448) into `chartGeometry.ts` (`distToSegment`, `buildLineCache`, `hitTestCache`, `interface LineCache`, `avwapAnchorPixel`, `selectedAvwapId`, constants `HIT_TOLERANCE_PX`/`ALERT_SNAP_PX`/`DOT_RADIUS`/`ANCHOR_HANDLE_R`) and `chartPainters.ts` (`paintSelectionDots`, `buildCurveLabelPills`, `paintAnchorHandle`, `fmtCountdown`, `browserTimezone`, `first`, `synthPrecision`). Import both into `ChartCore`.

- [ ] **Step 2: Build + unit + FULL e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test --reporter=line`
Expected: full suite at baseline.

```bash
git add frontend/src/ChartCore.tsx frontend/src/chart/chartGeometry.ts frontend/src/chart/chartPainters.ts
git commit -m "refactor(chart): extract pure geometry + painter helpers"
```

- [ ] **Step 3: Define the shared `ChartHandle` (the key move)**

In `ChartCore`, collect the refs the init effect + later callbacks share (`chartRef`, `overlays`, `redrawRef`, `posLinesRef`, `tradesRef`, `pendingRef`, `draftRef`, `tradeUiRef`, `posDrawRef`, `resRef`, `crosshairRef`, controller signals) into one `const handle = useMemo(() => ({ ...refs }), [])` object. Replace scattered `redrawRef.current()` etc. with `handle.redrawRef.current()`. **No file created yet** — this is an in-place reshape that makes later extractions mechanical.

- [ ] **Step 4: Build + unit + FULL e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test --reporter=line`
Expected: baseline. This commit changes no logic, only ref access shape — if e2e breaks here, a ref was aliased wrong.

```bash
git add frontend/src/ChartCore.tsx
git commit -m "refactor(chart): consolidate shared refs into a single ChartHandle"
```

- [ ] **Step 5: Extract `useLiveMarketData.ts` (most self-contained)**

Move the data-load + live-stream effect (2870–3110): async history fetch, `openLive`, per-tick candle apply, reconnection. Signature `useLiveMarketData(handle, { symbol, brokerId, priceSide, period, setStatus, setLastPrice, setHasData })`.

- [ ] **Step 6: Build + unit + FULL e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test --reporter=line`
Expected: baseline.

```bash
git add frontend/src/ChartCore.tsx frontend/src/chart/useLiveMarketData.ts
git commit -m "refactor(chart): extract live market data + stream hook"
```

- [ ] **Step 7: Extract `useRangeNavigation.ts`**

Move `ensureCoverageAndFit` (603), `ensureDrawingAnchorCoverage` (691), `onRangePick` (764), `onGoToDate` (805) + range-request refs (550–589). Signature `useRangeNavigation(handle, { pageHistoryBack })`, returns `{ onRangePick, onGoToDate }`.

- [ ] **Step 8: Build + unit + range e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test higher-timeframes --reporter=line`
Expected: baseline.

```bash
git add frontend/src/ChartCore.tsx frontend/src/chart/useRangeNavigation.ts
git commit -m "refactor(chart): extract range navigation hook"
```

- [ ] **Step 9: Extract `useChartPaint.ts` (the redraw loop)**

Move `redraw` (3394–3807) + `paintBracket` (3176–3286) + `paintSeparator`/`fmtSeparatorLabel` (3287–3393). Signature `useChartPaint(handle, { setPriceTag, setAlertTags, setTradePills, setBidTag, setAskTag, setLegendRows, precision, status })`. It writes `handle.redrawRef.current = redraw` so init-effect callers keep working.

- [ ] **Step 10: Build + unit + FULL e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test --reporter=line`
Expected: baseline. Paint changes are visually load-bearing — if pills/tags/lines vanish, a setter dep was dropped.

```bash
git add frontend/src/ChartCore.tsx frontend/src/chart/useChartPaint.ts
git commit -m "refactor(chart): extract master redraw + bracket/separator painters"
```

- [ ] **Step 11: Extract `useIndicatorCommands.ts`**

Move legend/indicator/drawing command callbacks (4041–4428): `paneIdOf`, `onLegendToggleVisible/OpenSettings/Remove/SelectRow`, `copyIndicator`/`pasteIndicator`, drawing clipboard copy/paste/delete, `toggleVisibleOn`/`removeOn`, `reorderPaneByName`/`startPaneReorderDrag`, `indicatorMenuItems`, `onLegendOpenMenu`. Returns the callbacks the JSX + `ChartLegend` need.

- [ ] **Step 12: Build + unit + legend e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test curve-hover-legend --reporter=line`
Expected: baseline.

```bash
git add frontend/src/ChartCore.tsx frontend/src/chart/useIndicatorCommands.ts
git commit -m "refactor(chart): extract legend/indicator/drawing command callbacks"
```

- [ ] **Step 13: Extract `useLineDrag.ts` + `usePointerCrosshair.ts` from the init effect**

Split the mega init effect (1298–2717): `useLineDrag` gets the horizontal-line drag engine (1667–1875) + AVWAP anchor drag (1589–1666); `usePointerCrosshair` gets `onMove`/`onLeave` (2083–2338). Each attaches its own listeners in its own effect, reading `handle`. The remaining init effect keeps chart bootstrap + teardown + signal subscriptions.

- [ ] **Step 14: Build + unit + FULL e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test --reporter=line`
Expected: baseline. Highest-risk step — drag + crosshair are pointer-event heavy. If a drag stops working, the listener attach/detach order changed.

```bash
git add frontend/src/ChartCore.tsx frontend/src/chart/useLineDrag.ts frontend/src/chart/usePointerCrosshair.ts
git commit -m "refactor(chart): extract line-drag + pointer-crosshair hooks from init effect"
```

- [ ] **Step 15: Extract `AlertTags.tsx` + `TradePills.tsx` presentational blocks**

Move the JSX map blocks (4753–5095): `alertTags.map` → `<AlertTags tags={...} onX={...}/>`, `tradePills.map` → `<TradePills pills={...} onRemoveLevel={...} onConfirm={...}/>`. Pure props-in, no state.

- [ ] **Step 16: Build + unit + FULL e2e + commit**

Run: `cd frontend && npm run build && npm run test:unit && npx playwright test --reporter=line`
Expected: baseline.

```bash
git add frontend/src/ChartCore.tsx frontend/src/chart/AlertTags.tsx frontend/src/chart/TradePills.tsx
git commit -m "refactor(chart): extract AlertTags + TradePills presentational components"
```

- [ ] **Step 17: Final verification — whole app**

Run:
```bash
cd frontend && npm run build && npm run lint && npm run test:unit && npx playwright test --reporter=line
cd ../backend && .venv/bin/pytest -q
```
Expected: everything at Task 0 baseline. Confirm `ChartCore.tsx` is now ~600 lines (`wc -l frontend/src/ChartCore.tsx`).

---

## Self-Review Notes

- **Spec coverage:** all ten modules from the artifact are covered (Tasks 1–9; capital+ig share Task 6). ✅
- **Ordering:** low-risk pure-data (persist, customIndicators, app.py) → medium (backtest modal, indicator settings, broker dedup) → high tangle (overlays, App, ChartCore). Each task is independently shippable and green.
- **No new failing tests by design:** these are behavior-preserving refactors; the existing vitest/playwright/pytest suites are the guardrail (Task 0 establishes the baseline). This is the honest verification model for pure relocation — do not fabricate new unit tests for moved code.
- **Barrel strategy** keeps 18 persist + 7 customIndicators importers untouched; overlays uses class-delegation (3 importers, method names unchanged); App/ChartCore use internal hooks (no external importers of their internals).
- **Escape hatch:** in Task 6 Step 3 and Step 6, if the two brokers' bodies differ beyond header names, STOP and surface to the user rather than forcing a merge — that would be a behavior change, out of scope.
