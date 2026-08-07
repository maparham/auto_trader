# Remove the structured (operand/modifier) rule model

Date: 2026-07-21

## Goal

The backtest rule editor migrated from a **structured** operand/modifier model
(`EMA(9)` = `{indicator, length, priceField, slope, lookback, scale}` operands
joined by an operator) to a typed **expression** language (`EMA(9) > EMA(21)`).
The four main rule groups (long/short entry/exit) already run on expressions.
This project removes the structured model **completely**.

One path still uses structured rules and blocks a flat delete:
**coded-strategy exits.** A coded strategy module supplies entries; the panel
adds exit rule groups (`longExit`/`shortExit`) that today are structured and are
evaluated by a `RuleStrategy` wrapped in `CodedWithRuleExits`. So the work is two
phases: migrate coded exits to expressions first, then delete the structured
stack.

## Non-goals

- No backward-compat migration of persisted data. Existing saved coded-exit
  configs (`auto-trader.codedCfg.*`) hold structured `RuleGroup`s; on the new
  shape they reset to empty and users re-author exits as expressions. (User
  decision, 2026-07-21.)
- No new expression-language features. Coded exits use the identical operand
  vocabulary the main groups already migrated onto, so there is no new coverage
  gap. `slope`/`highest`/`lowest`/`avg` wrappers already cover slope + lookback.
- No unrelated refactoring of the expr stack.

## Phase 1 — migrate coded-strategy exits to expressions

The coded **run machinery stays**: it already wires ATR-based risk, the ad-hoc
higher-timeframe (`tf=`) fetch loop, and posted `series`. Routing coded through
`/api/expr/backtest` would regress ATR risk (that endpoint rejects ATR risk with
`atr_risk_unsupported` and runs `series={}`). So we keep the coded machinery and
swap **only the exit evaluator**.

> **Superseded (2026-08-08):** the `atr_risk_unsupported` rejection is gone. The
> expr surface now computes its own `ATR_{length}` risk/scaling series from the
> posted candles — see `docs/superpowers/specs/2026-08-08-atr-risk-in-expr-design.md`
> and `backend/auto_trader/api/risk_series.py`. The rest of this section stands.

### Backend

- Add `CodedWithExprExits(Strategy)` in `strategy/coded.py`, parallel to
  `CodedWithRuleExits`: same one-close-per-leg-per-bar merge logic (`_CLOSES`,
  coded close wins), but wrapping an `ExprRuleStrategy` instead of a
  `RuleStrategy`. `ExprRuleStrategy` already supports exit-only (empty entry
  groups never fire) and passes the held side's entry price into each exit row
  so the `entry` operand resolves — no engine change.
- Request schema: coded requests carry **expression** exit rows, not
  `RuleGroupDTO`. Reuse the existing expression row DTO the main groups use
  (`{expr, enabled}` lists). Coded entry groups remain ignored (the module owns
  entries).
- Wire the expr exit evaluator into the **three** coded-exit run sites, each of
  which currently builds `CodedWithRuleExits` + `RuleStrategy` from
  `RuleGroupDTO`:
  1. `POST /api/backtest` — `_run_coded` (`routers/backtest.py`).
  2. The shared sweep / walk-forward job workers (coded jobs).
  3. `POST /api/strategy/evaluate` — the coded live-decision branch
     (`routers/strategy.py:198-217`).
- Exit-series validation for coded runs (`_validate_coded_exit_series`,
  `evaluate_strategy`'s coded branch): the structured `series_name(op)` walk over
  exit operands is replaced by expression compile/validate of the exit rows
  (parse + `validate(is_exit=True)`), mirroring `_compile_expr_group`. ATR-risk
  series validation for coded stays as-is (coded keeps ATR risk).
- Warm-up: coded exit warm-up is computed from the expression rows
  (`warmup_bars`) instead of structured operands.

### Frontend

- `CodedStrategyConfig.longExit/shortExit` change type from structured
  `RuleGroup` to expression rows (the `{expr, enabled}[]` shape). `defaultCodedCfg`
  seeds empty expression groups. `codedCfgsDiffer` (deepEqual) is shape-agnostic
  and needs no change.
- The coded-exit editor renders `editorMode="expr"` — dropping the **last**
  `editorMode="structured"` consumer (`BacktestSettingsModal.tsx:2750`, and the
  `openChartPicker` it passes at ~2762). It reuses the same expr
  `RuleGroupSection` path the main groups use, including the new
  "pick from chart" ◎ button.
- The coded run request builder posts expression exit rows to the coded run
  (arrays, like the expr main groups), matching the backend schema change.

### Phase 1 exit criteria

No surface builds `CodedWithRuleExits` or a `RuleStrategy` anymore; no UI renders
`editorMode="structured"`; coded backtest, sweep, WFO, and live all run coded
exits through `ExprRuleStrategy`. Verified end-to-end by running a coded strategy
with an authored expression exit in backtest and confirming the exit fires.

## Phase 2 — delete the structured stack

Unblocked once Phase 1 lands (nothing live references structured rules).

### Full-file deletions (frontend)

- `ChartOperandPicker.tsx`, `ChartOperandPicker.test.tsx`
- `lib/chartOperand.ts`, `lib/chartOperand.test.ts`
- `lib/chartOperandEnumerate.ts`, `lib/chartOperandEnumerate.test.ts`
- `lib/backtestSeries.ts`, `lib/backtestSeries.test.ts` (structured `SeriesRecipe`
  chart-operand series)

### Full-file deletions (backend)

- `strategy/rule.py`, `strategy/rule_series.py`
- Structured-only tests: `test_rule_series.py`, `test_rule_strategy.py`,
  `test_signal_terms.py`, `test_rule_series_parity.py`,
  `test_coded_rule_exits.py` (verify each is fully structured before deleting;
  keep whatever still exercises live engine code — but after Phase 1 nothing
  should).

### Surgical removals (files stay)

- `lib/backtestConfig.ts` — remove structured types (`IndicatorKind`, `PriceField`,
  `Operator`, `SlopeSpec`, `LookbackSpec`, `ScaleSpec`, `Operand`, `SeriesOperand`,
  recipe types) and functions (`slopeLen`, `lookbackSpec`, `scaleSpec`, `recipeKey`,
  `seriesName`, `collectSeriesOperands`, `operandBaseLen`, `OP_REVERSE`, `swapSides`,
  `invertRule`, `mirrorOperand`, `cloneOperand`, `ruleFromChartOperand`, `LB_TOKEN`,
  `SERIES_LENGTH_TYPES`). `Rule` drops `left`/`op`/`right`, keeps `expr`/`enabled`/`count`.
  `defaultBacktestConfig` stops seeding structured fields.
- `BacktestSettingsModal.tsx` — remove structured imports and components
  (`OpGlyph`, `defaultOperand`, `defaultRule`, `OperatorPicker`, `RuleMenu`,
  `OperandPicker`, `openChartPicker`, `pickerFor`/`pickerSources`,
  `<ChartOperandPicker>`), and the `editorMode="structured"` branches of
  `RuleGroupSection`/`RuleRow`. Drop the `editorMode` prop entirely (expr becomes
  the only path).
- `api.ts` — remove `BacktestRequest` (structured) and `runBacktest`
  (`/api/backtest`); keep `ExprBacktestRequest`/`runExprBacktest`. Coded now runs
  through the expr-shaped request.
- `lib/backtest.ts` — remove the `isExprRequest` dispatch; only the expr run
  remains.
- `BacktestSignalPopover.tsx` + `signalGlyphs.ts` — remove structured term
  rendering (`termLabel`, `opSymbol`) once the backend stops emitting structured
  `TermDTO`s.
- `lib/backtestWindow.ts` — warm-up reads only expr rows.
- `lib/sweep.ts` / `sweepLabels.ts` — drop structured `op:`/`rule:` sweep patch
  targets; keep `lit:` expression targets.
- `lib/liveEngine.ts` / `liveController.ts` / `liveState.ts` / `liveTypes.ts` /
  `riskSync.ts` — remove structured live-decision branches; keep the expr path.
- Backend `api/schemas.py` — remove `OperandDTO`, `RuleDTO`, `RuleGroupDTO`,
  `SlopeDTO`/`LookbackDTO`/`ScaleDTO`, `TermDTO`, and the structured
  `BacktestRequest` fields + `op:`/`rule:` sweep patch support.
- Backend `routers/backtest.py` — remove the structured `POST /api/backtest`
  request path and `_run_rule`; coded + expr are the only runners.
- Backend `routers/strategy.py` — remove the `else` structured branch of
  `evaluate_strategy` and the `exprMode` flag (expr becomes the only non-coded
  path); coded keeps its own branch.
- Backend `sweep_apply.py` / `sweep_worker.py` / `sweep_jobs.py` — remove
  structured `op:`/`rule:` patch application.

### Persistence

- `normalizeBacktestConfig` (persist/defaults) drops structured `Rule` fields on
  load. No converter — structured presets lose their `left/op/right` and keep
  only `expr` (blank for structured-authored rows). Same for coded configs.

## Testing

- Phase 1: a backend test that a coded strategy with an expression exit row fires
  the exit (backtest + live-evaluate). Frontend: coded-exit editor renders the
  expr editor. Manual end-to-end via `/verify`.
- Phase 2: full frontend `vitest` and backend `pytest` green after deletions
  (deleting structured tests alongside their code). `npx tsc -b` shows no *new*
  errors beyond the ~23 pre-existing unrelated ones.

## Sequencing / risk

Phase 1 must land and be verified before Phase 2 — the deletions are only safe
once no runner builds structured rules. The two phases are separate
implementation plans (and separate commits). The uncommitted user WIP in
`lib/overlays.ts` / `lib/overlays.test.ts` is unrelated and must not be touched.
