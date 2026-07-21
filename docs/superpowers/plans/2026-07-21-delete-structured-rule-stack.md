# Delete the Structured Rule Stack (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the entire structured (operand/modifier) rule model now that coded exits run on expressions (Phase 1), leaving expressions as the only rule engine.

**Architecture:** Topological deletion in 8 ordered stages — leaf UI first, shared core types last — so every commit still builds (`tsc -b` adds no new errors) and every suite (`pytest`, `vitest`) stays green. Deletion tasks are not TDD: each task removes code AND its now-obsolete tests together, then proves zero dangling references (grep), a clean typecheck, and a green suite. Several symbols that LOOK structural must STAY (they are shared with the expr/coded engines) — each stage names them explicitly.

**Tech Stack:** Backend Python (FastAPI, pydantic v2, pytest). Frontend TypeScript (React, vitest).

## Global Constraints

- No em dashes ("—" / "--") in end-user-visible text or copy. Code, tests, comments, commit messages are fine.
- No backward-compat / migration code. Structured data left in persisted configs is ignored on load (expr rows only); do not write converters.
- Commit directly to `main`. Do not create branches unless asked.
- Never `git add -A`/`-u`/`.` and never `git stash/checkout/reset/clean`. Stage only the exact files each task names. The uncommitted WIP `frontend/src/lib/overlays.ts` and `frontend/src/lib/overlays.test.ts` must never be staged or touched (they already fail 3 tests: `overlays.test.ts` x2, `drawTools.test.ts` x1 — that is pre-existing WIP, not this plan's concern).
- `npx tsc --noEmit` is a no-op; typecheck with `cd frontend && npx tsc -b`. There are ~23 pre-existing unrelated tsc errors — add NO new ones. Also pre-existing: `ComputeHostButton.test.tsx` x4 failures (compute-host confirm dialog, unrelated). When a task says "suite green," it means no failures BEYOND that known baseline.
- Backend tests: `cd backend && python -m pytest`. Frontend: `cd frontend && npx vitest run [file]`.
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
  ```

## MUST-NOT-DELETE (shared with expr/coded — verified in the dependency map)

- Frontend `lib/backtestConfig.ts`: `RuleGroup`, `activeGroup`, and `Rule.expr`/`Rule.enabled`/`Rule.count` — the transport shape coded/expr rows travel in. Only `Rule.left`/`op`/`right` and the structured operand types/functions are removed.
- Frontend `api.ts`: `runBacktest` + the `BacktestRequest` interface (coded runs use `/api/backtest`). Only its structured `longEntry/longExit/shortEntry/shortExit` fields are removed (Stage 5).
- Frontend `lib/backtest.ts`: `isExprRequest` + `runAndRender` dispatch (coded→`runBacktest`, non-coded→`runExprBacktest`). The discriminant is re-based off `longEntry` in Stage 5.
- Frontend `lib/backtestSeries.ts`: the ATR-only core (`buildSeries` ATR path, `riskAtrLengths`/`scalingAtrLengths`/`atrSeries`) — coded LIVE needs `ATR_{n}` series. Only structured-operand machinery is removed (Stage 4).
- Frontend `lib/riskSync.ts`, `lib/liveController.ts`, `lib/liveState.ts`: no structured references at all ("structured" hits are `structuredClone`). Do not modify.
- Backend `routers/backtest.py`: the `/api/backtest` endpoint + coded path + shared serializers `_trades_to_dto`/`_result_to_response`/`_bar_traces_dto` (the expr router imports them). Only the non-coded structured branches + `_run_rule` are removed.
- Backend `schemas.py`: `TermDTO`/`MarkerDTO.terms` ride the shared response for BOTH engines — NOT removed in Stages 1-8 (Stage 9 optional only).
- Backend `EvaluateRequest.exprMode` + the exprMode branches; `strategy/rule_series.py htf_timeframes` only if a non-rule caller is confirmed absent.

---

## Stage 1: Delete the chart-operand picker (frontend leaf UI)

**Files:**
- Delete: `frontend/src/ChartOperandPicker.tsx`, `frontend/src/ChartOperandPicker.test.tsx`
- Delete: `frontend/src/lib/chartOperand.ts`, `frontend/src/lib/chartOperand.test.ts`
- Delete: `frontend/src/lib/chartOperandEnumerate.ts`, `frontend/src/lib/chartOperandEnumerate.test.ts`
- Modify: `frontend/src/BacktestSettingsModal.tsx` (remove imports at lines ~9, ~45, ~46; the structured picker helpers `pickerFor` ~1413, `openChartPicker` ~1422, `pickerSources` ~1431; and the `<ChartOperandPicker .../>` render ~3207-3210)

- [ ] **Step 1: Remove the modal's picker usage.** In `BacktestSettingsModal.tsx`, delete the `<ChartOperandPicker>` render block (~3207-3210), the `openChartPicker`/`pickerFor`/`pickerSources` definitions (~1412-1440), and the three imports (`ChartOperandPicker` ~line 9, `enumerateChartOperands` ~line 45, `chartOperand`/`EmphasisTarget` ~line 46). Read each site first; remove only structured-picker code (the expr `editorMode="expr"` rule groups stay).
- [ ] **Step 2: Delete the six files.**
```bash
git rm frontend/src/ChartOperandPicker.tsx frontend/src/ChartOperandPicker.test.tsx frontend/src/lib/chartOperand.ts frontend/src/lib/chartOperand.test.ts frontend/src/lib/chartOperandEnumerate.ts frontend/src/lib/chartOperandEnumerate.test.ts
```
- [ ] **Step 3: Prove no dangling references.**
Run: `cd frontend && grep -rn "ChartOperandPicker\|chartOperandEnumerate\|enumerateChartOperands\|from \"./lib/chartOperand\"\|from \"../lib/chartOperand\"\|openChartPicker\|pickerSources" src/ | grep -v overlays`
Expected: no output (any hit is a dangling ref to fix; ignore `overlays.*`).
- [ ] **Step 4: Typecheck + tests.**
Run: `cd frontend && npx tsc -b 2>&1 | grep -E "BacktestSettingsModal|chartOperand"` → Expected: no NEW errors (the pre-existing `BacktestSettingsModal.test.tsx:975/1193` brokerId + `:2558` RecurrenceMask errors may remain; nothing new at removed lines).
Run: `cd frontend && npx vitest run src/BacktestSettingsModal.expr.test.tsx src/BacktestSettingsModal.exprSweep.test.tsx` → Expected: pass.
- [ ] **Step 5: Commit.**
```bash
git add frontend/src/BacktestSettingsModal.tsx
git commit -m "$(cat <<'EOF'
refactor(rules): delete the chart-operand picker (structured-only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```
(The `git rm` files are already staged by `git rm`; the `git add` stages the modal edit.)

---

## Stage 2: Delete the structured rule editor (modal + live panel)

`RuleGroupSection` is EXPORTED and used by four files, and the `editorMode` prop
defaults to `"structured"`. IMPORTANT correction to the original map: the
`LiveTradingPanel.tsx` NON-CODED entry/exit editors (~262/275) pass NO
`editorMode`, so they ride the structured default today — even though Phase 1's
`liveEngine.ts` already sends non-coded live rules as EXPRESSIONS (`exprMode:true`,
`exprRows(cfg.longEntry)`). That panel is therefore mismatched (structured editor,
expr engine); flipping it to expr both removes the structured editor AND fixes
that latent inconsistency. Dropping the `editorMode` prop entirely requires
updating EVERY call site, including the two expr test files that pass
`editorMode="expr"` (they must drop the now-removed prop or `tsc` breaks).

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` — delete `OpGlyph`, `defaultOperand`, `defaultRule`, `OperatorPicker`, `RuleMenu`, `OperandPicker`; every `editorMode === "structured"` branch inside `RuleGroupSection`/`RuleRow`; and drop the `editorMode` prop from the component signature + its three call sites (2695, 3531, 3548).
- Modify: `frontend/src/LiveTradingPanel.tsx` — drop `editorMode="expr"` from the coded-exit `RuleGroupSection` (~223). The two NON-CODED editors (~262/275) currently pass nothing (structured default); after the prop is removed they render the (now only) expression editor — this is the intended fix. Do NOT change any other LiveTradingPanel behavior.
- Modify: `frontend/src/BacktestSettingsModal.expr.test.tsx` (~20) and `frontend/src/BacktestSettingsModal.exprSweep.test.tsx` (~33/59/92/112) — remove the now-removed `editorMode="expr"` prop from each `RuleGroupSection` usage. These tests keep asserting expr behavior (now the default); do NOT otherwise alter them.
- Modify: `frontend/src/BacktestSettingsModal.test.tsx` — remove the ~19 structured describe/it blocks that use `defaultRule`/`OperandPicker`/`left:` literals (the known 19 failures). Keep non-structured cases.

- [ ] **Step 1: Remove the structured branches and the `editorMode` prop.** Read `RuleGroupSection`/`RuleRow` first. Delete every `editorMode === "structured"` conditional arm (keep the expr arm as the unconditional body), remove the `editorMode` prop from the component signature, and delete the now-unreferenced `OpGlyph`, `defaultOperand`, `defaultRule`, `OperatorPicker`, `RuleMenu`, `OperandPicker` defs + imports. Any `openChartPicker`-guarded structured branches Stage 1 left behind (optional-prop decls, `editorMode==="structured"` arms) are removed here too — after this, `openChartPicker` has zero references.
- [ ] **Step 2: Remove `editorMode="expr"` from all call sites.** In `BacktestSettingsModal.tsx` (2695/3531/3548), `LiveTradingPanel.tsx` (223), and both expr test files (`.expr.test.tsx`, `.exprSweep.test.tsx`). Confirm the LiveTradingPanel non-coded editors (262/275) still pass no `editorMode` — they now render expr, which is correct and intended.
- [ ] **Step 3: Remove structured test cases.** In `BacktestSettingsModal.test.tsx`, delete the describe/it blocks that construct structured rules (`defaultRule`, `OperandPicker`, operand `left/op/right`, "Add from chart", structured operator-sweep). Keep non-structured cases.
- [ ] **Step 4: Prove no dangling references.**
Run: `cd frontend && grep -rn "editorMode\|OperandPicker\|OperatorPicker\|RuleMenu\|defaultRule\|defaultOperand\|OpGlyph\|openChartPicker" src/ | grep -v overlays`
Expected: no output.
- [ ] **Step 5: Typecheck + tests.**
Run: `cd frontend && npx tsc -b 2>&1 | grep -E "BacktestSettingsModal|LiveTradingPanel"` → no NEW errors beyond the known baseline (`BacktestSettingsModal.test.tsx:975/1193` brokerId, `.tsx:2503` RecurrenceMask).
Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx src/BacktestSettingsModal.expr.test.tsx src/BacktestSettingsModal.exprSweep.test.tsx` → Expected: all pass (the 19 structured failures are eliminated, not skipped). If `LiveTradingPanel` has a test file, run it too.
- [ ] **Step 6: Commit.**
```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx frontend/src/LiveTradingPanel.tsx frontend/src/BacktestSettingsModal.expr.test.tsx frontend/src/BacktestSettingsModal.exprSweep.test.tsx
git commit -m "$(cat <<'EOF'
refactor(rules): delete the structured rule editor (modal + live panel expr-only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Stage 3: Remove structured sweep targets/labels

**Files:**
- Modify: `frontend/src/lib/sweep.ts` — `ruleAxisTarget` (~75-87), `opAxisTarget` (~90-93), the `rule:*.value` regex paths (~228, ~241).
- Modify: `frontend/src/lib/sweepLabels.ts` — `ruleLabel` (~95-118), `opLabel`, `operandLabel` (~39), and the `rule:`/`op:` dispatch (~160-170).
- Modify: `frontend/src/lib/sweep.test.ts`, `frontend/src/lib/sweepLabels.test.ts` — drop the `rule:`/`op:` cases; keep `lit:`/`risk:`/`period:`/`timeWindow:`.

- [ ] **Step 1: Remove `rule:`/`op:` builders + label paths.** In `sweep.ts` and `sweepLabels.ts`, delete the functions and dispatch arms handling `op:`/`rule:` sweep targets. Expr sweeps use only `lit:`/`risk:`/`period:`/`timeWindow:` — leave those intact. Read both files first; the structured target strings are the only ones removed.
- [ ] **Step 2: Trim the tests.** Remove `rule:`/`op:` describe/it blocks in both test files.
- [ ] **Step 3: Prove no dangling references.**
Run: `cd frontend && grep -rn "ruleAxisTarget\|opAxisTarget\|ruleLabel\|opLabel\|operandLabel" src/ | grep -v overlays`
Expected: the ONLY remaining hit is a stale CODE COMMENT at `BacktestSettingsModal.tsx:~701` mentioning `ruleAxisTarget` (removed in Stage 4 along with the modal's dead structured-sweep machinery). No live imports/calls of the removed helpers. The modal does NOT import `ruleAxisTarget`/`opAxisTarget` (it builds/receives `rule:`/`op:` target strings itself and uses the `Operator` type), so removing these sweep-lib helpers does not break its compile.
- [ ] **Step 4: Typecheck + tests.**
Run: `cd frontend && npx tsc -b 2>&1 | grep -E "sweep"` → no new errors.
Run: `cd frontend && npx vitest run src/lib/sweep.test.ts src/lib/sweepLabels.test.ts` → pass.
Note: `BacktestSettingsModal.tsx` still contains dead `rule:`/`op:` sweep machinery (`toggleRuleSweepAxis`, `toggleOpSweepAxis`, `tickOpOption`, `opOption`, the `op:`/`rule:` combo-apply, and the `onToggle`/`onToggleOp`/`onTickOp` SidePanel props). It is NOT removed here (it depends on the `Operator` type). It is removed in Stage 4 when that type goes. It compiles fine in the interim (dead but valid).
- [ ] **Step 5: Commit.**
```bash
git add frontend/src/lib/sweep.ts frontend/src/lib/sweepLabels.ts frontend/src/lib/sweep.test.ts frontend/src/lib/sweepLabels.test.ts
git commit -m "$(cat <<'EOF'
refactor(rules): drop structured op:/rule: sweep targets and labels

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Stage 4: Remove structured operand machinery (series, warm-up, config)

**Files:**
- Modify: `frontend/src/lib/backtestSeries.ts` — REDUCE to ATR-only. Keep `buildSeries`'s ATR path (~71-78), `riskAtrLengths`/`scalingAtrLengths`/`atrSeries`. Delete `buildChartOperandSeries`, `collectSeriesOperands`, `derive`, `computeRaw`, `computeIndicatorRecipe`, `slopeOf`/`lookbackOf`, HTF-operand align.
- Modify: `frontend/src/lib/backtestSeries.test.ts` — keep ATR cases (~34 refs), drop structured-operand cases.
- Modify: `frontend/src/lib/backtestWindow.ts` — remove the structured-operand scaling branch (~39-48 `scaled`), keep `exprWarmupBars` (~20) + `riskAtrLengths`/`scalingAtrLengths` paths.
- Modify: `frontend/src/lib/backtestWindow.test.ts` — drop structured-operand warm-up cases; keep expr + ATR.
- Modify: `frontend/src/lib/backtestConfig.ts` — `Rule` (~178) drops `left`/`op`/`right` (keep `expr`/`enabled`/`count`); delete `swapSides` (~209), `mirrorOperand` (~224), `invertRule` (~251), `ruleFromChartOperand` (~257), `cloneOperand` (~276), `seriesName` (~412), `collectSeriesOperands` (~454), `operandBaseLen` (~515), `slopeLen`/`lookbackSpec`/`scaleSpec` (~140/147/154), the `cross()` default-config builder (~592-598, replace with expr-row defaults), types `Operand`/`Operator`/`SeriesOperand`/recipe types/`OP_REVERSE` (~197). Fix `cloneRule` (~270) to stop copying `left`/`right`. KEEP `RuleGroup`, `activeGroup`.
- Modify: `frontend/src/lib/backtestConfig.test.ts` — drop structured cases.
- Modify: `frontend/src/BacktestButton.tsx` — drop the `buildChartOperandSeries` import/call (coded backtest posts no structured series; backend recomputes natives). Keep ATR series building if present.
- Modify: `frontend/src/lib/liveEngine.ts` — reduce the `buildSeries` call to the ATR-only builder (coded live needs `ATR_{n}`); keep the expr branch. Do NOT delete the series call.
- Modify: `frontend/src/BacktestSettingsModal.tsx` — remove the now-DEAD structured-sweep machinery that depends on the `Operator` type being deleted here: `toggleRuleSweepAxis` (~702), `opOption` (~721), `toggleOpSweepAxis` (~726), `tickOpOption` (~740); the `op:`/`rule:` combo-apply block (~945-1007, the `key.startsWith("op:")`/`key.startsWith("rule:")` arms in the combo-apply function — keep the `risk:`/`lit:`/`param:` arms); the `onToggle`/`onToggleOp`/`onTickOp` entries in the `SidePanel` `sweep={{...}}` prop (~2738-2740, keep `onToggleRisk`/`onKindChange`/`onAxisChange`/`axes`/`side`/`editable`); the matching prop declarations threaded through `SidePanel`/`RuleGroupSection` down-chain; the `usesVolume` structured-operand read (~1406, reads `r.left`/`r.right`); and the stale `ruleAxisTarget` comment (~701). Remove now-unused imports (`Operator`, `OPERATORS`, `OP_CELL`, `OP_REVERSE`, `mirrorOperand`, `ruleFromChartOperand`, `seriesName`, etc.) from `backtestConfig`. KEEP all `risk:`/`lit:`/`param:` sweep code and `cloneRule`/`activeGroup`/`RuleGroup` usage.
- Modify: `frontend/src/BacktestSettingsModal.test.tsx` (+ `.expr.test.tsx`/`.exprSweep.test.tsx` only if a removed helper is referenced) — drop any remaining test that exercised the removed structured-sweep toggles.

- [ ] **Step 1: Reduce `backtestSeries.ts` to ATR-only.** Read the file. Keep the ATR risk/scaling series computation; delete the structured-operand series machinery and `buildChartOperandSeries`. Update its test to keep ATR, drop structured cases. Run `npx vitest run src/lib/backtestSeries.test.ts`.
- [ ] **Step 2: Trim `backtestWindow.ts`.** Remove the structured-operand `scaled` lookback branch; keep `exprWarmupBars` + ATR lengths. Update its test. Run it.
- [ ] **Step 3: Strip structured members from `backtestConfig.ts`.** Remove `left/op/right` from `Rule`, delete the listed structured functions/types, fix `cloneRule`, and rewrite the default-config rule builder to seed `{expr:"", enabled:true}` rows instead of `cross()`. Update `backtestConfig.test.ts`. This is the highest-fan-out edit — after it, grep for every removed symbol.
- [ ] **Step 4: Fix the two series consumers.** In `BacktestButton.tsx` drop the `buildChartOperandSeries` usage; in `liveEngine.ts` point the series call at the ATR-only builder. Read both first.
- [ ] **Step 4b: Remove the modal's dead structured-sweep machinery.** In `BacktestSettingsModal.tsx`, delete `toggleRuleSweepAxis`/`opOption`/`toggleOpSweepAxis`/`tickOpOption`, the `op:`/`rule:` arms of the combo-apply function (keep `risk:`/`lit:`/`param:`), the `onToggle`/`onToggleOp`/`onTickOp` entries in the `SidePanel` `sweep={{...}}` prop and their prop declarations down-chain (`SidePanel`/`RuleGroupSection` no longer need them), the `usesVolume` structured read, and the stale `ruleAxisTarget` comment. Remove now-unused `backtestConfig` imports (`Operator`, `OPERATORS`, `OP_CELL`, `OP_REVERSE`, `mirrorOperand`, `ruleFromChartOperand`, `seriesName`). This is what lets the `Operator` type deletion in Step 3 typecheck. Read each site first; keep all `risk:`/`lit:` sweep behavior.
- [ ] **Step 5: Prove no dangling references.**
Run: `cd frontend && grep -rn "buildChartOperandSeries\|collectSeriesOperands\|ruleFromChartOperand\|mirrorOperand\|invertRule\|swapSides\|operandBaseLen\|slopeLen\|lookbackSpec\|scaleSpec\|OP_REVERSE\|toggleRuleSweepAxis\|toggleOpSweepAxis\|tickOpOption\|usesVolume" src/ | grep -iv overlays`
Expected: no output. Then manually scan for `.left`/`.right`/`.op` `Rule`-operand reads (excluding CSS/geometry): `grep -rn "\.left\b\|\.right\b" src/lib/backtestConfig.ts src/BacktestSettingsModal.tsx` should show no `Rule`-operand access.
- [ ] **Step 6: Typecheck + full frontend suite.**
Run: `cd frontend && npx tsc -b 2>&1 | grep -E "backtestSeries|backtestWindow|backtestConfig|BacktestButton|liveEngine|BacktestSettingsModal"` → no new errors beyond the known `RecurrenceMask` baseline.
Run: `cd frontend && npx vitest run` → Expected: no failures beyond the known baseline (`overlays.test.ts` x2, `drawTools.test.ts` x1, `ComputeHostButton.test.tsx` x4 — all pre-existing/WIP).
- [ ] **Step 7: Commit.**
```bash
git add frontend/src/lib/backtestSeries.ts frontend/src/lib/backtestSeries.test.ts frontend/src/lib/backtestWindow.ts frontend/src/lib/backtestWindow.test.ts frontend/src/lib/backtestConfig.ts frontend/src/lib/backtestConfig.test.ts frontend/src/BacktestButton.tsx frontend/src/lib/liveEngine.ts frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "$(cat <<'EOF'
refactor(rules): remove structured operand machinery (series, warm-up, config)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Stage 5: Remove structured request fields (ATOMIC — frontend)

Landmine coordination: `isExprRequest` (`lib/backtest.ts:1069`) discriminates on `Array.isArray(req.longEntry)`. Removing `longEntry` from `BacktestRequest` and switching the discriminant MUST happen in ONE commit or the dispatch misroutes / `tsc` breaks. The backend still accepts absent fields (its only readers are the dead branches removed in Stage 6), so the frontend leads.

**Files:**
- Modify: `frontend/src/api.ts` — drop `longEntry/longExit/shortEntry/shortExit: RuleGroup` (~315-318) from `BacktestRequest` (keep `codedStrategy`, `exprLongExit`/`exprShortExit`, and all else).
- Modify: `frontend/src/lib/liveTypes.ts` — drop `longEntry/longExit/shortEntry/shortExit: RuleGroup` (~30-33) from the evaluate-request type (keep `expr*` + `exprMode`).
- Modify: `frontend/src/BacktestButton.tsx` — stop setting `longEntry/longExit/shortEntry/shortExit` (the `EMPTY_GROUP` sends ~368-373) on `baseReq`.
- Modify: `frontend/src/lib/liveEngine.ts` — stop setting `longEntry/longExit/shortEntry/shortExit` (the `emptyGroup`/`effCfg` sends ~142-146).
- Modify: `frontend/src/lib/backtest.ts` — change `isExprRequest` to discriminate on a field that survives, e.g. `"codedStrategy" in req === false && Array.isArray((req as ExprBacktestRequest).longExit)` OR simplest: `!(req as BacktestRequest).codedStrategy` is not reliable (expr has no codedStrategy either). Use: expr requests are `ExprBacktestRequest` whose `longExit` is `ExprRow[]` (array) while `BacktestRequest` no longer has `longExit` at all — so discriminate on `Array.isArray((req as any).longExit)` still works IF expr keeps `longExit: ExprRow[]`. Confirm `ExprBacktestRequest.longExit` is an array field (it is). Keep the discriminant as `Array.isArray(req.longExit)` and ensure `BacktestRequest` no longer declares `longExit` (so a coded request's `longExit` is `undefined` → not an array → routes to `runBacktest`). Adjust the type guard's property access accordingly.

- [ ] **Step 1: Re-base the discriminant.** In `lib/backtest.ts`, update `isExprRequest` so it no longer reads `req.longEntry` (which is being removed). Use `Array.isArray((req as ExprBacktestRequest).longExit)` — coded `BacktestRequest` will lack `longExit` (undefined → false → `runBacktest`), expr `ExprBacktestRequest.longExit` is `ExprRow[]` (→ true → `runExprBacktest`). Read the current guard and the two request types first to pick the cleanest surviving discriminant; verify both routes still resolve.
- [ ] **Step 2: Drop the fields from the two request types and the two senders,** in the SAME working set: `api.ts` `BacktestRequest`, `liveTypes.ts` evaluate request, `BacktestButton.tsx` `baseReq`, `liveEngine.ts`. Remove `longEntry/longExit/shortEntry/shortExit` and any now-unused `EMPTY_GROUP`/`emptyGroup`/`activeGroup` imports left dangling.
- [ ] **Step 3: Prove no dangling references + discriminant correctness.**
Run: `cd frontend && grep -rn "longEntry\|shortEntry" src/api.ts src/lib/liveTypes.ts src/BacktestButton.tsx src/lib/liveEngine.ts` → Expected: no structured field refs (expr entry fields `exprLongEntry` may remain in liveEngine/liveTypes — those are fine).
- [ ] **Step 4: Typecheck + full frontend suite + a dispatch test.**
Run: `cd frontend && npx tsc -b 2>&1 | grep -E "api.ts|backtest.ts|liveTypes|BacktestButton|liveEngine"` → no new errors.
Run: `cd frontend && npx vitest run src/lib/backtest.test.ts src/lib/liveEngine.test.ts` (if `backtest.test.ts` exists and covers dispatch; otherwise run the full suite) → Expected: pass, and confirm the coded-vs-expr routing test still passes. If no dispatch test exists, add one asserting a coded request (has `codedStrategy`, no `longExit`) routes to `runBacktest` and an expr request routes to `runExprBacktest`.
- [ ] **Step 5: Commit.**
```bash
git add frontend/src/api.ts frontend/src/lib/liveTypes.ts frontend/src/BacktestButton.tsx frontend/src/lib/liveEngine.ts frontend/src/lib/backtest.ts
git commit -m "$(cat <<'EOF'
refactor(rules): remove structured rule-group fields from backtest/evaluate requests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Stage 6: Remove dead structured backend branches

**Files:**
- Modify: `backend/auto_trader/api/routers/strategy.py` — delete the `else` structured branch of `evaluate_strategy` (`RuleStrategy(...)` ~166-172) and the `elif req.codedStrategy is None:` operand-validation branch (~111-116). Keep the exprMode + coded branches and the `if req.exprMode and codedStrategy` guard.
- Modify: `backend/auto_trader/api/routers/backtest.py` — delete `_run_rule` (~108), `_fetch_rule_htf` (~92), the `if req.codedStrategy is None:` single-run validation (~190-204) + `else: _run_rule` (~225-229), the cost-sensitivity `else: _run_rule` (~307-308), the `if not coded:` sweep/WFO series-validation + `_fetch_rule_htf` branches (~706-721, ~772-778, ~970-981, ~1024-1025), and `_validate_combo_targets`'s `else: apply_rule_combo` (~636-637). KEEP the endpoint, coded path, and shared serializers.
- Modify: `backend/auto_trader/api/sweep_worker.py` — delete the `if s.module is None:` structured rule-sweep branch (~93-95). Coded → `run_coded_sync`, non-coded → `run_expr_sync` (both stay).
- Delete: `backend/tests/test_api_strategy_evaluate.py` (entirely structured — the dead `else` branch), `backend/tests/test_api_backtest.py` (single-run rule mode), `backend/tests/test_api_backtest_rule_sweep.py` (rule sweep).

- [ ] **Step 1: Remove the dead branches** in the three router/worker files. Read each site; delete only the non-coded structured arms. After each file, keep the coded + expr arms intact.
- [ ] **Step 2: Delete the three structured test files.**
```bash
git rm backend/tests/test_api_strategy_evaluate.py backend/tests/test_api_backtest.py backend/tests/test_api_backtest_rule_sweep.py
```
- [ ] **Step 3: Prove no dangling references.**
Run: `cd backend && grep -rn "_run_rule\|_fetch_rule_htf\|apply_rule_combo\|run_rule_sync" auto_trader/` → Expected: only definitions in `sweep_apply.py` (removed next stage), no live call sites in routers/worker.
- [ ] **Step 4: Full backend suite.**
Run: `cd backend && python -m pytest -q` → Expected: green (fewer tests, no failures). If a coded/expr test referenced a now-deleted helper, fix it.
- [ ] **Step 5: Commit.**
```bash
git add backend/auto_trader/api/routers/strategy.py backend/auto_trader/api/routers/backtest.py backend/auto_trader/api/sweep_worker.py
git commit -m "$(cat <<'EOF'
refactor(rules): remove dead non-coded structured run branches

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Stage 7: Delete the structured rule engine core

**Files:**
- Modify: `backend/auto_trader/api/sweep_apply.py` — delete `run_rule_sync` (~142), `apply_rule_combo` (~382), `_rule_operands` (~101), `assemble_rule_series_sync` (~118), and drop the `RuleStrategy, series_name` import (~30) IF grep confirms no surviving coded/expr use. KEEP `apply_combo`, `apply_lit_combo`, `run_coded_sync`, `run_expr_sync`, `sweep_row`.
- Delete: `backend/auto_trader/strategy/rule.py` (`RuleStrategy`, `series_name`, `Operand`, `Rule`, `RuleGroup`), `backend/auto_trader/strategy/rule_series.py` (verify `htf_timeframes` has no non-rule caller first).
- Delete: `backend/tests/test_rule_strategy.py`, `test_rule_series.py`, `test_rule_series_parity.py`, `test_rule_run_helpers.py`, `test_backtest_inspector.py`, `test_signal_terms.py` (all structured-only; verify each has 0 coded/expr refs before `git rm`).

- [ ] **Step 1: Confirm `series_name`/`rule_series` have no surviving callers.**
Run: `cd backend && grep -rn "series_name\|from auto_trader.strategy.rule\b\|rule_series\|htf_timeframes\|RuleStrategy" auto_trader/ | grep -v "expr\|test"`
Expected: only the sites being deleted this stage. If a coded/expr module still imports `series_name` or `htf_timeframes`, STOP and report (a landmine — do not delete that symbol).
- [ ] **Step 2: Remove the structured functions from `sweep_apply.py`** and delete the two strategy modules.
```bash
git rm backend/auto_trader/strategy/rule.py backend/auto_trader/strategy/rule_series.py
```
- [ ] **Step 3: Delete the structured test files** (after confirming each is structured-only via `grep -L "coded\|expr" ...`).
```bash
git rm backend/tests/test_rule_strategy.py backend/tests/test_rule_series.py backend/tests/test_rule_series_parity.py backend/tests/test_rule_run_helpers.py backend/tests/test_backtest_inspector.py backend/tests/test_signal_terms.py
```
- [ ] **Step 4: Prove no dangling references + full suite.**
Run: `cd backend && grep -rn "RuleStrategy\|import rule\b\|strategy.rule\b" auto_trader/ | grep -v expr` → Expected: no output.
Run: `cd backend && python -m pytest -q` → Expected: green.
- [ ] **Step 5: Commit.**
```bash
git add backend/auto_trader/api/sweep_apply.py
git commit -m "$(cat <<'EOF'
refactor(rules): delete the structured rule engine (rule.py, rule_series, sweep cores)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Stage 8: Delete the structured DTOs

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` — remove `BacktestRequest.longEntry/longExit/shortEntry/shortExit` (~428-431) and `EvaluateRequest.longEntry/longExit/shortEntry/shortExit` (~740-743); then delete `RuleGroupDTO` (~285), `RuleDTO` (~274), `OperandDTO` (~215), `SlopeDTO` (~200), `LookbackDTO` (~204), `ScaleDTO` (~209). KEEP `TermDTO`, `MarkerDTO`, `ExprRowDTO`, `exprMode`, all expr/coded/sweep/wfo DTOs.
- Modify: `backend/tests/test_schemas.py` — remove the `OperandDTO`/`RuleDTO`/`RuleGroupDTO`/`Slope/Lookback/ScaleDTO` cases; keep the rest.
- Modify: any coded/sweep test that built a `RuleGroupDTO` empty-group payload (`test_api_backtest_coded.py`, `test_coded_rule_exits.py`) — drop the now-removed structured fields from those request bodies (they were sent empty; the field no longer exists).

- [ ] **Step 1: Remove the structured request fields** from `BacktestRequest` and `EvaluateRequest`. Confirm (Stage 5/6 done) nothing reads them.
- [ ] **Step 2: Delete the six DTO classes.** Read each for any lingering import; remove those imports too (e.g. in `routers/*.py`, `sweep_apply.py`).
- [ ] **Step 3: Fix tests that posted structured fields.** In `test_api_backtest_coded.py`/`test_coded_rule_exits.py`, remove `longEntry/longExit/...` keys from request dicts (they were empty groups). Trim `test_schemas.py`.
- [ ] **Step 4: Prove no dangling references + full suite.**
Run: `cd backend && grep -rn "RuleGroupDTO\|RuleDTO\|OperandDTO\|SlopeDTO\|LookbackDTO\|ScaleDTO" auto_trader/ backend/tests 2>/dev/null` (adjust path) → Expected: no output.
Run: `cd backend && python -m pytest -q` → Expected: green.
- [ ] **Step 5: Commit.**
```bash
git add backend/auto_trader/api/schemas.py backend/tests/test_schemas.py backend/tests/test_api_backtest_coded.py backend/tests/test_coded_rule_exits.py
git commit -m "$(cat <<'EOF'
refactor(rules): delete the structured rule DTOs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Stage 9 (OPTIONAL FOLLOW-UP — do NOT execute without explicit approval)

The per-bar rule inspector (`bar_traces`, `InspectorTermDTO`, `BarTraceDTO`, `BarGroupTraceDTO`, `_bar_traces_dto`, `BacktestInspectorPanel.tsx`) and the structured signal-term rendering (`TermDTO`/`MarkerDTO.terms`, `signalGlyphs.ts`, `BacktestSignalPopover.tsx`) are structured-ONLY in practice — `ExprRuleStrategy` has no `inspect_groups`, so traces are always empty and terms never populate for the surviving engines. But they ride the SHARED response serializer (`_result_to_response`, `MarkerDTO`) that expr/coded return, so removing them edits the expr path.

This is both higher-risk (shared serializer) and a PRODUCT decision (the bar inspector is a user-facing feature that silently stopped working after the expr migration — the user may want it rebuilt for expressions rather than deleted). It is intentionally excluded from Stages 1-8. Surface it to the user as a separate decision; if approved, plan it as its own staged removal with its own review.

---

## Self-Review Notes

- **Spec coverage:** the design's Phase 2 "deletions" list maps to Stages 1-8; the design's inspector/term-serializer note maps to the deferred Stage 9. The map's landmines (TermDTO shared, backtestSeries ATR core, required DTO fields, isExprRequest discriminant, series_name shared, RuleGroup/activeGroup kept) are each pinned to the stage that handles them.
- **Order safety:** consumers precede their dependencies — UI (1-2) → sweep labels (3) → series/config (4) → request fields (5, atomic with the discriminant) → dead backend branches (6) → engine core (7) → DTOs (8). Each stage ends with a dangling-ref grep + build + suite gate.
- **Do-not-delete list is enforced per stage;** `RuleGroup`/`activeGroup`/`Rule.expr`/`runBacktest`/`isExprRequest`/`backtestSeries` ATR core/`TermDTO` all survive.
