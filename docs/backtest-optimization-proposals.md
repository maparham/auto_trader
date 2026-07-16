# Backtesting and parameter optimization: research and design proposals

Date: 2026-07-16. Status: exploration and design only, nothing here is implemented.

This document answers `docs/backtest-sweep-reviewer-brief.md`. It is grounded in a code-level
survey of the current engine (`backend/auto_trader/engine/`), the sweep pipeline
(`frontend/src/lib/sweep.ts`, `backend/auto_trader/api/routers/backtest.py`), the run store
(`backend/auto_trader/core/run_store.py`), and the analysis stack (`engine/analysis.py`,
`engine/whatif.py`, `engine/context_features.py`), plus external research on professional
platforms (StrategyQuant X, TradeStation, Build Alpha, vectorbt PRO, MetaTrader) and the
academic literature (Bailey and Lopez de Prado on the Deflated Sharpe Ratio and the Probability
of Backtest Overfitting, White's Reality Check, Hansen's SPA test, Pardo on walk-forward,
Walton's System Parameter Permutation).

It assumes the parallel-sweep-jobs plan
(`docs/superpowers/plans/2026-07-16-parallel-sweep-jobs-remote-compute.md`) lands: sweeps become
server-side jobs on a process pool with an optional remote compute host, and the 1000-combo cap
becomes a soft warning. That plan is the enabling substrate for almost everything below. Every
expensive feature here should be "another job type on the same job API," not a new execution
path.

## Where the platform already stands

Honest assessment first, because it changes the priorities. The simulation core is already
better than most retail platforms: next-bar fills, pessimistic intra-bar resolution, no-lookahead
MTF, per-trade MAE/MFE and context enrichment, counterfactual replay, bar-level rule traces, and
backtest/live sharing the same decision code. Few commercial retail products have the what-if
suite or the bar inspector at all.

The real gaps, in order of how badly they can hurt a user's account:

1. **Nothing stops the user from fooling themselves.** The sweep is a machine for finding the
   luckiest combination of parameters in one historical sample, and the UI then offers a
   one-click "apply best" into the live config. The robustness window columns help, but there is
   no held-out data, no true walk-forward selection, no neighborhood check, no accounting for how
   many combinations were tried. This is the classic selection-bias trap the entire overfitting
   literature warns about.
2. **No risk-adjusted metrics.** There is no Sharpe, Sortino, or any volatility-normalized
   return anywhere in `engine/metrics.py`. Everything downstream (deflated metrics, comparison,
   confidence scoring) needs these.
3. **Costs are optimistic for held positions.** Fixed slippage and per-side commission exist,
   but spread is only "which price side the candles were fetched at," and overnight financing is
   absent entirely. For CFD swing strategies financing is first-order, not a rounding error.
4. **Comparison is manual.** Runs archive individually; there is no side-by-side view, no
   stitched picture across markets or timeframes, and sweep results evaporate with the session.
5. **The backtest-to-live handoff is trust-by-construction.** Shared decision code is genuinely
   strong, but there is no pre-arm report, no expectation band for live results, and no
   reconciliation of live fills against backtest assumptions.

The proposals are grouped by the brief's six areas. Each has the fields the brief asked for. A
combined ROI ranking, must-have list, skip list, and phased roadmap close the document.

Effort scale used throughout: S is roughly a day or two, M is up to a week, L is multiple weeks.
Complexity is conceptual/architectural risk, which is not the same thing as effort.

---

## 0. Foundation

### F0. Risk-adjusted and time-based metrics (Sharpe, Sortino, Calmar, SQN, CAGR)

- **Description:** Compute a daily (or per-bar, annualized) return series from the equity curve
  and derive Sharpe, Sortino, Calmar (CAGR over max drawdown percent), SQN (Van Tharp's
  expectancy over R stdev times sqrt(n)), and exposure percent. Add them to `compute_metrics`,
  the sweep row, the run store summary, and as sortable sweep columns.
- **Problem it solves:** Net PnL and profit factor reward volatile lucky strategies. Every
  serious statistic in this document (deflated Sharpe, PBO, confidence scoring, comparison)
  consumes a risk-adjusted number that does not exist today.
- **Value:** High. It is also table stakes: users coming from any other platform expect Sharpe.
- **Complexity:** Low. **Effort:** S.
- **UI:** New columns and stat cards; a metric picker for the sweep sort and heatmap color.
- **Computational cost:** Negligible.
- **Drawbacks:** Sharpe on small trade counts is noisy; display trade count next to it and grey
  it out under a threshold (say 30 trades).
- **Prior art:** Universal (every platform, every paper).
- **Verdict:** Must-have, and a prerequisite for F5/F6.

---

## 1. Overfitting defenses

### F1. Holdout period (train/test split with lockbox semantics)

- **Description:** A date-range split on the backtest config: sweep and iterate on the training
  window only; the holdout tail is untouched. A separate explicit action ("Evaluate on holdout")
  runs the currently selected combo once on the held-out period and stamps the result on the run
  and on the readiness report (L1). The UI counts how many times a holdout has been consumed for
  this strategy and warns when it stops being out-of-sample (after a handful of peeks it is just
  more training data).
- **Problem it solves:** Today the sweep optimizes over the full selected range and the best row
  is applied directly. There is zero out-of-sample evidence anywhere in the workflow.
- **Value:** Very high. This is the single cheapest honest-signal feature available.
- **Complexity:** Low. The backend already supports `period:from`/`period:to` patching
  (`_apply_env_combo`), so a holdout is one more window with UI discipline around it.
- **Effort:** S to M (most of the work is the UX: shading the holdout on the chart, the peek
  counter, keeping sweeps from touching it silently).
- **UI:** A "Reserve last X% / last N months as holdout" control in the backtest settings; chart
  shading in a distinct color; a badge on results that were selected without holdout evidence.
- **Computational cost:** One extra backtest per evaluation.
- **Drawbacks:** Shortens the training sample; users can defeat it by peeking repeatedly (hence
  the counter, which is a nudge, not a jail).
- **Prior art:** Universal quant practice; StrategyQuant's In-Sample/Out-of-Sample split;
  standard train/validation/test methodology.
- **Verdict:** Must-have.

### F2. True walk-forward optimization (select in-sample, evaluate out-of-sample, stitch)

- **Description:** Distinct from the existing period axis, which just slices the range and shows
  per-period results for every combo. True WFO: split the range into rolling (or anchored)
  train/test windows; in each window pick the best combo on the train segment only (by a chosen
  objective), evaluate it on the following test segment, and stitch the test segments into one
  out-of-sample equity curve. Report Walk-Forward Efficiency (OOS performance over IS
  performance), per-window chosen parameters, and parameter drift across windows. Optionally a
  small walk-forward matrix (grid of window count x OOS fraction) as a robustness view, which is
  StrategyQuant's signature tool.
- **Problem it solves:** The current "walk-forward axis" answers "how did each combo do per
  period" but never simulates the real decision process (re-picking parameters on past data
  only). Stitched OOS equity is the closest thing to a truthful preview of live behavior that
  historical data can give.
- **Value:** Very high. Widely considered the gold standard of retail strategy validation.
- **Complexity:** Medium. It is a meta-job: N sweeps plus N evaluations, ordered. The job API
  and `sweep_apply` cores make this a composition, not new engine work.
- **Effort:** M (backend job type) plus M (results UI: stitched curve, per-window table,
  parameter-drift strip). The WF matrix adds S on top.
- **UI:** A "Walk-forward" mode in the sweep modal (window count, anchored/rolling, OOS
  fraction, objective metric); results view with the stitched OOS equity, WFE number, and a
  per-window parameter table. Parameter drift is itself diagnostic: erratic per-window winners
  mean the strategy is noise-fitting.
- **Computational cost:** Roughly windows x sweep cost. With the process pool and remote host
  this is exactly what the new infrastructure is for.
- **Drawbacks:** Needs enough data (each test window should hold 20+ trades or the per-window
  stats are noise); users must pick the window scheme before seeing results, not after, or WFO
  itself becomes another overfitting axis (the matrix view mitigates this by showing all schemes
  at once).
- **Prior art:** Pardo (The Evaluation and Optimization of Trading Strategies), TradeStation
  Walk-Forward Optimizer, StrategyQuant Walk-Forward Matrix, Build Alpha, vectorbt PRO splitters.
- **Verdict:** Must-have; the flagship overfitting feature.

### F3. Parameter plateau detection (neighborhood robustness on the existing grid)

- **Description:** For every sweep row, compute neighborhood statistics over adjacent grid cells
  (one step in each numeric axis): neighbor median of the objective, worst neighbor,
  peak-to-neighbor ratio. Flag isolated spikes (great cell, poor neighbors) and rank a
  "plateau score" alongside raw performance. Offer "sort by neighborhood median" as the default
  sort, and let apply-back pick the plateau center instead of the raw best. This is a cheap
  cousin of Walton's System Parameter Permutation, which evaluates the whole neighborhood
  distribution rather than the point estimate.
- **Problem it solves:** The best cell in a grid is, by selection, the luckiest cell. Real edges
  live on plateaus; single-cell peaks are noise. Today the UI actively points users at the peak.
- **Value:** High, and it improves the existing workflow rather than adding a new one.
- **Complexity:** Low. Pure post-processing on rows already in memory; the grid structure is
  known from the axes.
- **Effort:** S to M (scoring is S; the heatmap overlay and apply-the-plateau UX is the M part).
- **UI:** A "robust" badge or halo on plateau cells in the heatmap, a plateau-score column, and
  a second apply action: "Apply plateau center." A small 1D slice sparkline per axis (objective
  vs this parameter, others held at the selection) is the most intuitive visualization of
  stability and is cheap once rows exist.
- **Computational cost:** Negligible (arithmetic over existing rows).
- **Drawbacks:** Only meaningful for numeric axes with 3+ steps; list axes have no neighborhood.
  Neighborhood distance needs per-axis normalization.
- **Prior art:** StrategyQuant SPP and optimization profile, Build Alpha parameter stability
  views, the standard "pick the plateau, not the peak" doctrine.
- **Verdict:** Must-have. Best ROI in the whole document given rows already exist.

### F4. Monte Carlo trade resampling (bootstrap the trade list)

- **Description:** Resample the completed trade list of a run (shuffle order, bootstrap with
  replacement, optionally drop a random 10 to 20% of trades) a few thousand times. Report
  distributions instead of point estimates: 5th/50th/95th percentile ending equity, max drawdown
  distribution, probability of hitting an X% drawdown before a Y% gain, longest losing streak
  distribution, and a fan chart around the equity curve. Include a "risk of ruin at this
  position size" readout.
- **Problem it solves:** One historical trade sequence is one draw from a distribution. Users
  size positions off the single observed max drawdown, which is an underestimate of what the
  same edge can produce in a different ordering.
- **Value:** Very high, especially for position sizing and expectation setting. Also feeds the
  live expectation bands in L2.
- **Complexity:** Low. Operates on the stored trade list; no engine involvement. Caveat to
  surface in the UI: reshuffling assumes trades are roughly independent, which understates risk
  for strategies with serially correlated trades (dense overlapping entries).
- **Effort:** M (S for the math, the rest for a good distribution UI).
- **UI:** A "Monte Carlo" section in the Analysis tab: fan chart, drawdown histogram with the
  actual run marked, percentile table, and a position-size slider that re-scales the
  distributions live.
- **Computational cost:** Trivial (thousands of permutations of a few hundred floats; well under
  a second in numpy).
- **Drawbacks:** Independence assumption above; can create false comfort if costs are
  understated upstream (which is why R1 to R3 matter).
- **Prior art:** StrategyQuant Monte Carlo trades manipulation, Build Alpha, Amibroker,
  standard practice in every prop-firm evaluation.
- **Verdict:** Must-have.

### F5. Monte Carlo robustness retests (perturb the world, re-run the backtest)

- **Description:** A second Monte Carlo family that re-runs the simulation N times under random
  perturbations: jitter numeric parameters within a few percent, randomize slippage/spread
  within a band, randomly skip a fraction of signals, offset the data start by random amounts,
  optionally add small price noise. Report the distribution of outcomes and the fraction of
  perturbed runs that remain profitable. Include a random-entry baseline as one mode: same exit
  logic, random entries, to show how much of the PnL the entries actually contribute (a cheap
  form of a permutation test).
- **Problem it solves:** F4 tests luck of ordering; this tests fragility of the strategy itself
  to execution and environment noise, which is what actually differs live.
- **Value:** High. "87% of perturbed runs profitable" is a genuinely decision-grade number.
- **Complexity:** Medium (needs engine hooks for perturbation, and reproducible seeding).
- **Effort:** M, mostly plumbing perturbation options through `sweep_apply` as synthetic combos,
  which reuses the entire job machinery.
- **UI:** A "Stress test" action on a run: pick perturbation types, N; results as a histogram
  plus a pass-rate headline. Feeds a line in the readiness report (L1).
- **Computational cost:** N full backtests (N of 100 to 500 is typical). Fine on the process
  pool, ideal for the remote host.
- **Drawbacks:** Choice of perturbation magnitudes is a judgment call; defaults must be sane
  (tie slippage band to observed ATR, parameter jitter to axis step).
- **Prior art:** StrategyQuant's 9+ Monte Carlo retest methods are exactly this; Forex Tester
  and MT5 articles on randomized robustness; academic permutation-test literature (MCPT).
- **Verdict:** Worth building after F1 to F4; a phase-2 item.

### F6. Deflated Sharpe Ratio and trial accounting

- **Description:** Track the number of effective trials behind a selected result (sweep combos
  tried for this strategy, cumulative across sessions, via the run/sweep archive). Compute the
  Deflated Sharpe Ratio: the probability that the observed Sharpe exceeds what the best of N
  random trials would produce, correcting for non-normal returns (skew, kurtosis) and sample
  length. Display it as a plain-language verdict: "After accounting for the 640 combinations you
  tried, the chance this Sharpe is above chance is 71%."
- **Problem it solves:** A Sharpe of 1.5 selected from 1000 combos is worth far less than a
  Sharpe of 1.5 from a single hypothesis. Nothing in the product (or in most retail products)
  encodes that.
- **Value:** High conceptually; medium practically, because it needs honest trial counting and
  a return series (F0). Even an approximate deflator changes user behavior: it makes bigger
  sweeps visibly more expensive in credibility.
- **Complexity:** Medium. The formula is closed-form (Bailey and Lopez de Prado 2014); the hard
  part is the bookkeeping: per-strategy cumulative trial counts, and estimating the variance of
  Sharpe across trials (available directly from sweep rows).
- **Effort:** M.
- **UI:** One number with an InfoTip on the run summary and readiness report; a per-strategy
  "trials so far" counter (itself educational).
- **Computational cost:** Negligible given sweep rows.
- **Drawbacks:** Trial counting is gameable (delete archive, new strategy name); treat the
  number as advisory. Needs at least F0 and archived sweeps (C4) to be meaningful.
- **Prior art:** Bailey and Lopez de Prado, "The Deflated Sharpe Ratio" (Journal of Portfolio
  Management 2014); implemented in mlfinlab and QuantStats-style tooling.
- **Verdict:** Worth building in phase 2, in the simplified closed-form version.

### F7. Probability of Backtest Overfitting (CSCV) over sweep results

- **Description:** After a sweep, build the combo-by-window performance matrix (M combos x S
  time slices), then run combinatorially symmetric cross-validation: for each way of splitting
  the S slices into half in-sample/half out-of-sample, pick the best combo in-sample and record
  its out-of-sample rank. PBO is the fraction of splits where the in-sample winner lands in the
  bottom half out-of-sample. Report one number per sweep: "Probability this sweep's selection
  process is overfit: 43%."
- **Problem it solves:** Rates the sweep as a selection process rather than rating one combo.
  Directly answers "should I trust picking the best row from this table at all."
- **Value:** High and unusually cheap here, because `window_metrics` already slices every
  combo's trades into the same sub-windows: the required matrix is nearly a byproduct of the
  existing robustness columns.
- **Complexity:** Medium (the statistic is subtle to explain; the code is not).
- **Effort:** M (S for the math on the existing matrix, rest for explanation UX: this number
  needs an InfoTip that teaches).
- **UI:** A headline chip on sweep results ("Sweep PBO: 43%, high risk of overfit selection")
  with a distribution plot of OOS ranks behind a click.
- **Computational cost:** Combinatorial in window count; with S = 12 to 16 windows it is
  thousands of cheap rank operations, sub-second.
- **Drawbacks:** Sensitive to window count and to sparse windows (combos with few trades per
  window); should gate on minimum trades. Windows are time-contiguous slices of one market, so
  it detects selection overfit, not regime dependence.
- **Prior art:** Bailey, Borwein, Lopez de Prado, Zhu, "The Probability of Backtest
  Overfitting" (Journal of Computational Finance 2017); vectorbt PRO CSCV support; mlfinlab.
- **Verdict:** Worth building in phase 2; a distinctive feature almost no retail product has,
  at unusually low cost given the existing window machinery.

### F8. White's Reality Check / Hansen's SPA test

- **Description:** Bootstrap-based joint hypothesis tests that the best rule in a family beats a
  benchmark after accounting for the full search.
- **Problem it solves:** Same family as F6/F7 (data snooping).
- **Value:** Low incremental over F6+F7 for this audience.
- **Complexity:** High (stationary bootstrap over full per-bar return series for every combo,
  benchmark choice, heavy explanation burden). **Effort:** L.
- **Computational cost:** High (needs per-combo return series retained, B bootstrap resamples).
- **Drawbacks:** Conservative, hard to explain, duplicates the decision value of DSR + PBO.
- **Prior art:** White (2000), Hansen (2005); used in academic technical-analysis literature
  (Hsu and Kuan).
- **Verdict:** Academically interesting, not worth building. DSR + PBO cover the need.

---

## 2. Parameter optimization

### O1. Refine-around-best (coarse-to-fine grid) and random search

- **Description:** Two additions to the existing grid flow. (a) Refine: after a sweep, one
  click re-sweeps a tighter grid centered on a selected cell or plateau (halve the steps, span
  one coarse step in each direction), pre-filling the axes; results append to the same result
  set. (b) Random search mode: instead of the cartesian product, sample N random points from the
  axis ranges. For high-dimensional spaces random search finds near-optimal regions with far
  fewer evaluations than a grid (Bergstra and Bengio 2012), and it composes with the plateau
  scoring (F3) via nearest-neighbor density instead of grid adjacency.
- **Problem it solves:** The grid wastes its budget on uniform coverage; with 4+ axes users
  must choose between coarse steps everywhere or an enormous sweep. Refine-around-best is
  already an agreed next idea in the project notes.
- **Value:** High, immediate quality-of-life for existing users.
- **Complexity:** Low. **Effort:** S for refine, S to M for random mode.
- **UI:** "Refine around this" in the row/heatmap context menu; a Grid/Random toggle plus an N
  input in the sweep modal.
- **Computational cost:** User-controlled; typically reduces total compute.
- **Drawbacks:** Refinement inherits the selection bias of the first pass (mitigate: refine
  around the plateau, not the peak; count refined trials in F6's ledger).
- **Prior art:** Every optimizer UI (MT5, StrategyQuant); Bergstra and Bengio, "Random Search
  for Hyper-Parameter Optimization" (JMLR 2012).
- **Verdict:** Must-have.

### O2. Bayesian optimization (TPE) as a job type

- **Description:** A "Smart search" sweep mode: give it the axes and a budget of N evaluations;
  a sequential model-based optimizer (TPE, as in Optuna) proposes combos, learns from results,
  and concentrates evaluations in promising regions. Runs as a job with the same streaming rows;
  the optimizer loop lives in the job thread and feeds the process pool in small batches.
  Objective is a picker (Sharpe, net, or the robust composite from F3/mean-minus-sigma).
- **Problem it solves:** Coded strategies can expose many parameters; grids explode
  combinatorially. Bayesian search typically matches a large grid's best result at 5 to 10% of
  the evaluations.
- **Value:** Medium-high, mainly for coded-strategy power users; less critical while most sweeps
  are 2 to 3 axes.
- **Complexity:** Medium (batch-parallel proposals, categorical axes, seeding, reproducibility).
- **Effort:** M with an off-the-shelf optimizer library on the backend; the job architecture
  already fits the ask-tell loop.
- **UI:** Mode toggle plus budget; a convergence sparkline (best-so-far vs evaluations). Rows
  appear in the same table/heatmap (heatmap cells will be sparse; show sampled points as dots).
- **Computational cost:** N backtests, but N is small by construction.
- **Drawbacks:** Converges to peaks by design, which fights the plateau doctrine: mitigate by
  optimizing the robust objective and always following with a local F3-style neighborhood probe
  of the winner. Less transparent to users than a grid.
- **Prior art:** Optuna/TPE (Akiba et al. 2019), scikit-optimize; vectorbt PRO parameterized
  optimization; hyperopt.
- **Verdict:** Worth building in phase 2/3, after O1 and the robustness layer exist, so the
  smart search optimizes the right objective.

### O3. Early stopping / successive halving of combos

- **Description:** Evaluate all combos on a fraction of the date range (say the first 40%),
  keep the top half by objective, re-run survivors on more data, repeat (ASHA/Hyperband
  style).
- **Problem it solves:** Sweep wall-clock on huge grids.
- **Value:** Medium, and shrinking: the process pool plus remote host attacks the same problem
  with hardware, and per-combo cost for retail bar counts is small.
- **Complexity:** Medium. **Effort:** M.
- **Drawbacks:** Partial-period performance is a biased filter for exactly the regime-dependent
  strategies users trade; risks pruning combos that shine later. Statistical care needed.
- **Prior art:** Hyperband (Li et al. 2017), ASHA; common in ML tuning, rare in trading UIs.
- **Verdict:** Skip for now; revisit only if sweep sizes outgrow the remote host.

### O4. Multi-objective view and Pareto front

- **Description:** Treat the sweep result set as multi-objective (return vs max drawdown vs
  robustness score vs trade count). Compute the non-dominated (Pareto) set, badge those rows,
  and add a scatter view (any two metrics on the axes, Pareto frontier drawn, click to apply).
  Optionally a weighted composite score with user sliders as the sort key.
- **Problem it solves:** Sorting by a single column hides the tradeoff structure; the best-net
  combo is rarely the best-drawdown or most-robust combo, and users currently discover this by
  re-sorting repeatedly.
- **Value:** High for decision quality relative to its cost; pairs naturally with F3.
- **Complexity:** Low (Pareto on a few hundred rows is trivial). **Effort:** S to M (the
  scatter view is most of it).
- **UI:** "Frontier" badge column; a Table/Heatmap/Scatter view switcher on sweep results.
- **Computational cost:** Negligible.
- **Drawbacks:** More UI surface; needs sane default axes to avoid choice paralysis.
- **Prior art:** NSGA-II literature for the concept; StrategyQuant and Build Alpha expose
  multi-metric ranking; portfolio tools show risk/return scatters universally.
- **Verdict:** Must-have (the scatter plus frontier badge, not a genetic multi-objective
  optimizer).

---

## 3. Simulation realism

### R0. Cost sensitivity report

- **Description:** Every backtest (or a one-click action) re-runs at 0x, 1x, 2x, 3x the
  configured costs (slippage plus commission plus, once R1/R3 exist, spread and financing) and
  reports the breakeven cost multiple: "This strategy stops being profitable at 1.8x your
  assumed costs."
- **Problem it solves:** Cost assumptions are guesses; the user needs to know whether the edge
  survives being wrong about them. High-frequency scalping strategies routinely die at 2x.
- **Value:** High, and it is the cheapest realism feature possible: it needs no new market
  modeling at all.
- **Complexity:** Low. **Effort:** S (three extra engine runs plus a stat line).
- **UI:** One line in the run summary and readiness report, with a tiny cost-vs-net sparkline.
- **Computational cost:** 3 extra backtests.
- **Drawbacks:** None meaningful.
- **Prior art:** Standard prop-desk practice; recommended in essentially all backtesting
  best-practice literature.
- **Verdict:** Must-have.

### R1. Real spread modeling (bid/ask aware fills)

- **Description:** Fetch both price sides where the broker provides them (Capital.com and IG
  serve bid and ask candles) and fill honestly: buys at ask, sells at bid, stops evaluated on
  the correct side. Where only one side or mid exists, apply a configurable per-instrument
  spread (with an optional session multiplier: wider at rollover/news hours, e.g. a simple
  hourly spread profile learned from recent live quotes the platform already streams).
- **Problem it solves:** Today spread is implicit in which single price stream was fetched, so
  every round trip underpays the spread on one leg. For tight-stop intraday strategies on CFDs
  the spread is the dominant cost and can flip a backtest's sign.
- **Value:** Very high for intraday users; the single biggest realism gap.
- **Complexity:** Medium (double candle streams through the engine, stop/target evaluation per
  side, cache implications; the request/DTO surface grows).
- **Effort:** M to L.
- **UI:** Mostly invisible: a "Costs" section per instrument showing the spread model in use,
  plus which model a run used stamped in its config.
- **Computational cost:** Roughly 2x candle data per run; engine cost unchanged.
- **Drawbacks:** Historical bid/ask availability varies by broker and depth; the fallback
  fixed-spread mode must be honest about being a model. Doubles some cache storage.
- **Prior art:** Forex Tester and MT5 real-tick modes; Dukascopy bid/ask data; every
  institutional simulator.
- **Verdict:** Must-have for a CFD/FX product, staged: fixed per-instrument spread first
  (cheap), true dual-side fills second.

### R2. Volatility-scaled slippage

- **Description:** Replace the fixed slippage scalar with a model: slippage = base + k x
  ATR(bar) (or k x spread), optionally widened during configured news/rollover hours. Keep the
  fixed mode as an option.
- **Problem it solves:** A constant understates slippage exactly when it matters (fast markets,
  which is when stops execute).
- **Value:** Medium-high; pairs with the stress test (F5) which randomizes within the band.
- **Complexity:** Low (the engine already computes fills per bar and ATR exists in the
  indicator stack). **Effort:** S.
- **UI:** A slippage-model picker in Trading/backtest settings.
- **Computational cost:** Negligible.
- **Drawbacks:** k is still a guess until live fill data calibrates it (see L2, which closes
  the loop by measuring actual live slippage).
- **Prior art:** Standard in institutional simulators; recommended in the backtest-realism
  literature.
- **Verdict:** Worth building, phase 2; trivially small once R1's cost section exists.

### R3. Overnight financing and weekend costs

- **Description:** Apply per-night financing to held CFD/FX positions (long/short rates
  configurable per instrument, triple-swap day handled), sourced from broker data where the API
  exposes it (IG and Capital.com publish overnight fees in market details, which the market-info
  popover already fetches) and manual otherwise. Show financing as a separate PnL component per
  trade and in totals.
- **Problem it solves:** Swing strategies that hold for days are silently subsidized today;
  financing on leveraged CFDs commonly eats 30 to 100% of a marginal edge.
- **Value:** Very high for anyone holding overnight; zero for pure intraday (so make the run
  summary say which regime the strategy is in).
- **Complexity:** Low-Medium (a per-bar accrual on held positions plus rate plumbing).
- **Effort:** M (mostly rate sourcing per broker).
- **UI:** Financing line in trade rows and run totals; per-instrument rate editor with
  broker-fetched defaults.
- **Computational cost:** Negligible.
- **Drawbacks:** Historical rates are not archived by brokers; using current rates for past
  simulation is an approximation (state it).
- **Prior art:** MT5 swap modeling, Forex Tester, broker trade simulators.
- **Verdict:** Must-have for the swing use case.

### R4. Margin and leverage constraints

- **Description:** Simulate account margin: position notional against configurable leverage,
  reject entries that would exceed available margin, optionally simulate margin-call
  liquidation. The platform already computes live margin from broker data (leverage, notional,
  FX conversion), so the model exists; the backtest just does not apply it.
- **Problem it solves:** Multi-position strategies (max_concurrent > 1, scaling) can backtest
  positions the account could never hold.
- **Value:** Medium (high for scaling/pyramiding users, irrelevant for single-position ones).
- **Complexity:** Low-Medium. **Effort:** M.
- **UI:** Account-size and leverage inputs on the backtest config (account size may already be
  implied by sizing); rejected-for-margin shows up as a suppression reason in the bar inspector.
- **Drawbacks:** Another config surface; defaults must not silently change existing results
  (default off).
- **Prior art:** MT5 tester models margin fully; academic RL-trading environments treat
  leverage constraints as first-order.
- **Verdict:** Worth building, phase 3.

### R5. Partial fills, latency simulation, exchange microstructure

- **Description:** Order-book style fill modeling, order latency, queue position, venue rules.
- **Value:** Low for this product: retail CFD/FX market orders at retail size fill completely,
  and the platform's strategies act on closed bars, not ticks.
- **Verdict:** Not worth building. The honest next-bar-open fill plus R1/R2 dominates. Listed
  for completeness because the brief asked; latency matters below the bar timescale this
  platform trades.

---

## 4. Comparison workflows

### C1. Run comparison view (plus persisted equity curves)

- **Description:** Select 2 to 4 archived runs and compare: metric table side by side with
  best-per-row highlighting, overlaid normalized equity curves, R-distribution overlays, and a
  config diff (only the settings that differ). Requires persisting a downsampled equity curve
  (the frontend already downsamples to 2000 points for its render cache) and the metrics
  snapshot in the run store.
- **Problem it solves:** The archive is currently a list of one-at-a-time reopenable runs;
  every comparison is manual and from memory. Iterating on a strategy is inherently
  comparative.
- **Value:** Very high; probably the most-used feature in this whole document day to day.
- **Complexity:** Low-Medium. **Effort:** M (store change is S; the comparison UI is the work).
- **UI:** Checkboxes in the runs list plus a Compare drawer/panel. Config diff needs careful
  rendering (the sweep-label grammar in `sweepLabels.ts` already humanizes most keys).
- **Computational cost:** None.
- **Drawbacks:** Run-store rows grow by a few KB each (bounded: 2000-point curve x 200 runs).
- **Prior art:** QuantConnect run comparison, TradingView deep backtesting side-by-sides,
  MLflow-style experiment tracking (the pattern this really is).
- **Verdict:** Must-have.

### C2. Cross-market / cross-timeframe validation matrix

- **Description:** One click: run the current strategy unchanged across a user-defined basket
  of instruments and/or a set of timeframes, as one job. Results as a compact matrix
  (instrument x timeframe, colored by objective) with per-cell drill-in. Explicitly framed as a
  robustness test, not a shopping trip: the headline is "profitable on 7 of 10 related markets,"
  and the anti-pattern (picking the single best foreign market, which reintroduces selection
  bias) is called out in the UI copy.
- **Problem it solves:** A real edge usually generalizes to related markets; an overfit one is
  market-specific. Today testing this means many manual runs.
- **Value:** High; also one of StrategyQuant's core cross-checks.
- **Complexity:** Medium (per-instrument candle fetching inside a job; cost/precision configs
  differ per instrument). **Effort:** M.
- **UI:** Basket picker (persistable lists like "FX majors"); matrix view; a line in the
  readiness report ("tested on N other markets, profitable on K").
- **Computational cost:** Basket size x backtest; embarrassingly parallel, fits the job pool.
- **Drawbacks:** Data availability varies per broker/instrument; needs per-instrument cost
  settings to be honest (ties into R1/R3).
- **Prior art:** StrategyQuant additional-markets cross-check; standard multi-market validation
  doctrine.
- **Verdict:** Must-have (phase 2).

### C3. Strategy fingerprint card

- **Description:** A compact, standardized card per run: trade frequency, average hold, long/
  short split, R histogram thumbnail, win rate vs avg win/loss position on a scatter, regime
  exposure (share of trades per vol/trend regime from the existing context features), monthly
  PnL strip. Rendered identically everywhere (runs list, comparison view, readiness report) so
  strategies become visually recognizable and comparable at a glance.
- **Problem it solves:** "What kind of strategy is this" currently requires opening the full
  Analysis tab; comparisons happen across incommensurate views.
- **Value:** Medium; a strong multiplier on C1/C2 rather than standalone.
- **Complexity:** Low (all inputs already computed by `analysis.py`). **Effort:** S to M.
- **UI:** A card component; most of the work is design restraint.
- **Drawbacks:** None significant.
- **Prior art:** QuantStats tear sheets, fund fact sheets.
- **Verdict:** Worth building alongside C1.

### C4. Sweep archive (persist sweep jobs like runs)

- **Description:** Persist completed sweep jobs (axes, combos, rows, windows, objective) in the
  run store's sibling table, reopenable into the full results UI. Currently results are
  session-only and a closed tab discards possibly hours of compute.
- **Problem it solves:** Lost compute; no longitudinal view of what has been tried; F6's trial
  accounting and any sweep-level statistics (F7) need this to persist.
- **Value:** High as an enabler; medium standalone.
- **Complexity:** Low (rows are already DTOs; the job object is nearly the archive record).
- **Effort:** S to M.
- **UI:** A "Sweeps" tab next to Runs; reopen restores the table/heatmap/scatter.
- **Computational cost:** Storage only (a 1000-row sweep is well under 1 MB).
- **Drawbacks:** Pruning policy needed, like runs' cap of 200.
- **Verdict:** Must-have (cheap, enables F6/F7 and protects expensive remote jobs).

---

## 5. Backtest-to-live validation

### L1. Live readiness report (pre-arm gate)

- **Description:** A generated report when the user moves to arm a strategy (or on demand),
  with traffic-light checks and a plain-language summary. Checks, roughly in order of power:
  sample size (trades in backtest, greyed metrics below thresholds), out-of-sample evidence
  (holdout result F1, walk-forward efficiency F2), selection risk (trials count and DSR F6,
  sweep PBO F7 if from a sweep), parameter plateau status (F3), cost realism (which cost model
  was used, breakeven cost multiple R0), stress pass rate (F5), cross-market generalization
  (C2), Monte Carlo drawdown percentile vs configured account size (F4), data span vs strategy
  hold time, and config diffs between the backtested config and the config actually being
  armed. Each check links to the tool that would fix it. It is a gate with an override, not a
  wall: the user can arm anyway, and the report is stamped on the armed snapshot.
- **Problem it solves:** The product currently has a one-click path from "best row in a sweep"
  to "armed with real money" with no friction and no summary of the evidence quality. This
  report is the keystone that makes every other feature in this document actionable at the
  moment that matters.
- **Value:** Very high; arguably the differentiating feature of the whole program of work.
- **Complexity:** Medium (it is an aggregator; each line is cheap once its source feature
  exists; the craft is in honest thresholds and non-patronizing copy).
- **Effort:** M for the framework plus S per check as sources land. Build the skeleton early
  with the checks that already have data (sample size, config diff, robustness columns) and let
  it grow.
- **UI:** A report panel from the Live arm flow; compact traffic-light summary plus expandable
  detail per check; the armed snapshot stores the report.
- **Computational cost:** Reuses stored results; optionally triggers missing checks as jobs.
- **Drawbacks:** Threshold calibration is opinionated; make thresholds visible and editable to
  keep trust. Danger of ritual compliance (users clicking through), mitigated by the summary
  sentence being genuinely informative rather than a score.
- **Prior art:** No mainstream retail platform does this well, which is the opportunity;
  closest are prop-firm evaluation criteria and institutional model-validation checklists
  (SR 11-7 style, radically simplified).
- **Verdict:** Must-have; the integration point for phases 1 to 3.

### L2. Live-vs-backtest reconciliation (shadow backtest)

- **Description:** For an armed strategy, continuously (or on demand) run the backtest engine
  over the exact live period with the armed config and diff against the live journal: signal
  parity (did live and sim fire the same entries), fill quality (live fill vs next-bar-open
  assumption, i.e. measured slippage), cost drift (actual spread/financing vs modeled), and PnL
  attribution of the gap (signals vs fills vs costs). Also plot live equity against the Monte
  Carlo expectation fan from F4: "live is at the 34th percentile of backtest expectations,
  within normal range."
- **Problem it solves:** "Backtest and live share code" guarantees decision parity, not outcome
  parity. Users abandon working strategies during normal drawdowns and keep broken ones because
  they cannot tell drift from noise. Measured live slippage/spread also calibrates R1/R2, and
  the fan-chart framing directly answers "is this still working."
- **Value:** Very high; it closes the loop the whole platform is built around.
- **Complexity:** Medium-High (aligning live journal trades to sim trades, partial periods,
  config drift between arm-time and now).
- **Effort:** L.
- **UI:** A "vs backtest" section in the Live panel: parity table, slippage stats, expectation
  fan with the live curve overlaid, and drift alerts.
- **Computational cost:** One backtest over the live span per refresh; trivial.
- **Drawbacks:** Short live histories make everything wide-intervalled; the UI must resist
  drawing conclusions from 8 trades (show the interval, not a verdict).
- **Prior art:** Institutional standard (paper/live reconciliation); QuantConnect live
  deployment vs backtest overlays; no retail CFD product does the attribution part.
- **Verdict:** Must-have (phase 3; needs nothing academic, just careful engineering).

### L3. Incubation mode

- **Description:** A formal paper/demo stage between backtest and real money: arm on demo with
  a target (N trades or M weeks), auto-track against the F4 expectation bands, and graduate (or
  flag) when the sample is in. Essentially L2 packaged as a workflow with a finish line.
- **Value:** Medium-high; mostly workflow glue over L2.
- **Complexity:** Low once L2 exists. **Effort:** S to M.
- **Prior art:** Prop-firm evaluations; "incubation" is standard fund practice.
- **Verdict:** Worth building right after L2.

---

## 6. Analysis improvements

### A1. Regime performance breakdown and edge-decay view

- **Description:** Two additions to the Analysis tab. (a) Regime breakdown: performance table
  sliced by the existing context features (vol regime, trend state, session), with expectancy
  and trade count per slice and a significance guard (grey out slices with under ~20 trades).
  (b) Edge decay: rolling expectancy and rolling win rate over the run's timeline (and across
  archived runs of the same strategy), answering "is this edge stable, seasonal, or fading."
- **Problem it solves:** compute_analysis already computes per-feature stats but the story
  ("this strategy only works in high-vol trending sessions") is left for the user to assemble;
  and nothing shows performance drift over time within a run.
- **Value:** High; converts existing data into the WHY diagnosis the brief asks for.
- **Complexity:** Low (data exists). **Effort:** S to M.
- **UI:** Two new Analysis sections; regime slices link to filtered trade lists.
- **Drawbacks:** Multiple-comparison temptation: with 7 features x 3 buckets someone will
  always find a shiny slice. Label it exploratory; if a user then wants to add a regime filter
  to the strategy, that is a new hypothesis to re-test (the UI can say exactly that).
- **Prior art:** Build Alpha regime analysis; standard quant tear sheets.
- **Verdict:** Must-have (cheapest of the analysis items, data already computed).

### A2. Loss autopsy (failure clustering)

- **Description:** An automated pass over the losing tail: group losers by shared context
  (feature combinations, time clusters, consecutive-loss episodes) and by mechanics (stopped
  within N bars, gapped through stop, reversed after exit per the existing what-if stamps).
  Output a ranked list of loss patterns in plain language: "41% of losses: shorts opened in the
  Asia session in a low-vol regime, median minus 1.0R" with click-through to those trades and,
  where a pattern maps to an addressable rule (session filter, regime filter), a one-click
  counterfactual: re-run without those trades to show the ceiling of fixing it.
- **Problem it solves:** The Analysis tab describes distributions; users still eyeball trade
  lists to find what is killing them. This is the "why does it fail" diagnostic in the brief.
- **Value:** High; very sticky feature.
- **Complexity:** Medium (simple rule mining over small trade sets: frequent feature
  combinations among losers vs winners; no ML needed at these sample sizes, and interpretability
  beats sophistication here).
- **Effort:** M.
- **UI:** A "Loss patterns" section in Analysis with ranked cards.
- **Drawbacks:** Same multiple-comparison caveat as A1, stronger (it actively searches).
  Present patterns as hypotheses with counts and let the counterfactual re-run, walk-forward,
  and holdout do the confirming.
- **Prior art:** Build Alpha's "what hurts" style reports; TSSB feature analysis; standard
  post-trade analytics at desks.
- **Verdict:** Worth building (phase 2/3).

### A3. Feature importance on trade outcomes

- **Description:** Fit a small interpretable model (shallow decision tree or logistic
  regression on the context features) predicting trade outcome, and report which features
  actually separate winners from losers, with permutation importance.
- **Value:** Medium; overlaps heavily with A1/A2 which are more direct.
- **Complexity:** Medium; sample sizes (dozens to a few hundred trades) are marginal for even
  small models, and the output invites overconfidence.
- **Verdict:** Academically interesting, probably not worth building as a separate feature.
  A1's conditional expectancy table plus A2's pattern mining deliver the same insight in a more
  honest form at these sample sizes.

### A4. Trade clustering (unsupervised)

- **Description:** k-means/embedding clustering of trades on shape features (MAE/MFE path,
  duration, context) to discover trade archetypes.
- **Verdict:** Not worth building. Same information surfaces through A1/A2 with labels users
  understand; unsupervised clusters on under 500 trades are unstable and need a data scientist
  to interpret. Listed because the brief asked.

---

## ROI ranking

Value per unit of effort, considering dependencies. Effort letters as above.

| Rank | Feature | Value | Effort | Note |
|---|---|---|---|---|
| 1 | F3 Parameter plateau scoring | High | S-M | Pure post-processing on existing rows |
| 2 | F0 Risk-adjusted metrics | High | S | Prerequisite for half the list |
| 3 | R0 Cost sensitivity report | High | S | Three re-runs, one killer stat |
| 4 | O1 Refine-around-best + random search | High | S-M | Already an agreed idea |
| 5 | F1 Holdout period | Very high | S-M | Cheapest honest OOS signal |
| 6 | C4 Sweep archive | High | S-M | Protects compute, enables F6/F7 |
| 7 | A1 Regime breakdown + edge decay | High | S-M | Data already computed |
| 8 | F4 Monte Carlo trade resampling | Very high | M | Position sizing truth |
| 9 | O4 Pareto front + scatter view | High | S-M | Decision quality on existing rows |
| 10 | C1 Run comparison view | Very high | M | Daily-use feature |
| 11 | F2 True walk-forward optimization | Very high | M-L | Flagship; composition of existing parts |
| 12 | L1 Live readiness report | Very high | M+ | Keystone aggregator, grows with the rest |
| 13 | R3 Overnight financing | Very high* | M | *for swing strategies specifically |
| 14 | R1 Spread modeling | Very high* | M-L | *for intraday; stage fixed-spread first |
| 15 | F7 PBO / CSCV | High | M | Unusually cheap here; window matrix nearly exists |
| 16 | C2 Cross-market matrix | High | M | Embarrassingly parallel job |
| 17 | F5 Monte Carlo perturbation retests | High | M | After F4 and the job infra |
| 18 | F6 Deflated Sharpe + trial ledger | Medium-high | M | Needs F0, C4 |
| 19 | R2 Volatility-scaled slippage | Medium-high | S | Rides on R1's settings surface |
| 20 | C3 Fingerprint card | Medium | S-M | Multiplier on C1/C2 |
| 21 | L2 Live reconciliation | Very high | L | Highest absolute value in the L group |
| 22 | A2 Loss autopsy | High | M | After A1 |
| 23 | O2 Bayesian optimization | Medium-high | M | After robust objectives exist |
| 24 | L3 Incubation mode | Medium-high | S-M | Rides on L2 |
| 25 | R4 Margin constraints | Medium | M | Scaling users only |

## Must-haves

If only eight things get built: **F0, F1, F2, F3, F4, R0, C1, L1.** Together they change the
core workflow from "find the luckiest cell and arm it" to "find a plateau, verify it out of
sample, know the drawdown distribution, know the cost sensitivity, and see the evidence
summarized at arm time." Everything else is amplification.

## Academically interesting, probably not worth building

- **F8 White's Reality Check / Hansen's SPA:** heavyweight, conservative, hard to explain;
  DSR (F6) + PBO (F7) deliver the same decision at a fraction of the cost.
- **R5 Partial fills / latency / microstructure:** below the timescale of a closed-bar CFD
  platform; the honest next-bar model plus spread/slippage realism dominates.
- **A3 Feature-importance models / A4 trade clustering:** sample sizes are too small for the
  outputs to deserve the confidence they project; A1/A2 give the same insight interpretably.
- **O3 Successive halving:** solves a compute problem the process pool and remote host already
  solve, at the cost of a statistical bias.
- **Full genetic/NSGA-II optimizers:** the Pareto *view* (O4) captures the user value; evolving
  strategies wholesale (StrategyQuant's builder) is a different product.

## Phased roadmap

**Phase 1 (short term): honest numbers on the existing workflow.**
F0 metrics, F3 plateau scoring, R0 cost sensitivity, O1 refine + random search, F1 holdout,
C4 sweep archive, A1 regime breakdown. All small, all compounding, none blocked on the jobs
plan (though C4 becomes nicer with it). Also start the L1 report skeleton with the checks that
already have data (sample size, robustness columns, config diff): it creates the place where
later phases surface.

**Phase 2 (medium term): out-of-sample machinery and distributions.**
Requires the sweep-jobs infrastructure. F2 walk-forward optimization (plus the matrix view),
F4 Monte Carlo resampling, O4 Pareto/scatter, C1 run comparison (+C3 card), F7 PBO on sweep
results, R1 spread staging (fixed per-instrument first) and R2 slippage model, R3 financing.
L1 grows the corresponding checks.

**Phase 3 (long term): the live loop and deep diagnostics.**
L2 live-vs-backtest reconciliation with slippage calibration feeding back into R1/R2, L3
incubation mode, C2 cross-market matrix, F5 perturbation stress tests, F6 deflated Sharpe with
the trial ledger, A2 loss autopsy, O2 Bayesian search, R4 margin. L1 reaches its full form and
becomes the product's signature: no other retail platform ships an evidence-graded "should you
arm this" report.

## Sources

Academic:
- Bailey, Lopez de Prado, [The Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) (JPM 2014); [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551)
- Bailey, Borwein, Lopez de Prado, Zhu, [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) (J. Computational Finance 2017)
- Hsu, Kuan, [Re-Examining the Profitability of Technical Analysis with White's Reality Check and Hansen's SPA Test](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=685361)
- [Backtest overfitting in the ML era: comparison of OOS testing methods](https://www.sciencedirect.com/science/article/abs/pii/S0950705124011110) (Knowledge-Based Systems 2024)
- [The GT-Score: a robust objective function for reducing overfitting](https://arxiv.org/pdf/2602.00080) (arXiv 2026)
- Palomar, [Portfolio Optimization, ch. 8.3: The Dangers of Backtesting](https://portfoliooptimizationbook.com/book/8.3-dangers-backtesting.html)

Platforms and practice:
- StrategyQuant: [cross checks](https://strategyquant.com/doc/strategyquant/cross-checks-automated-strategy-robustness-tests/), [robustness test types](https://strategyquant.com/doc/strategyquant/types-of-robustness-tests-in-sqx/), [Walk-Forward Matrix](https://strategyquant.com/doc/strategyquant/walk-forward-matrix/)
- [vectorbt PRO optimization and purged/combinatorial CV](https://vectorbt.pro/features/optimization/)
- [TradeStation Walk-Forward Optimizer](https://help.tradestation.com/09_01/tswfo/topics/about_wfo.htm)
- [Build Alpha on walk-forward optimization](https://www.buildalpha.com/walk-forward-optimization/)
- [Unger Academy: how to use walk-forward analysis](https://ungeracademy.com/posts/how-to-use-walk-forward-analysis-you-may-be-doing-it-wrong)
- [MQL5: unified validation pipeline against backtest overfitting](https://www.mql5.com/en/articles/21603)
- [Anchored vs rolling walk-forward windows](https://www.susanpotter.net/quant/walk-forward-optimization/)
