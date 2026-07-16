# Walk-Forward Matrix (StrategyQuant)

Source: https://strategyquant.com/doc/strategyquant/walk-forward-matrix/
Saved as text on 2026-07-16 (page blocked headless PDF rendering).

Last updated on 6. 5. 2015 by Mark Fric

Walk-Forward Matrix is a powerful, unique feature in the StrategyQuant platform. It can help
you with two things:

1. Verify strategy robustness: if the strategy passes the Walk-Forward Matrix test it means
   that with the help of parameter reoptimization it is adaptable to a big range of market
   conditions.
2. Find the optimal period for strategy reoptimization: it will help you identify the best
   optimization frequency.

Standard Walk-Forward Optimization tests the strategy results with periodic reoptimization,
say every 300 days. But how do we know what is the best reoptimization period? We can only
guess, unless we use a Walk-Forward Matrix that tests various combinations of reoptimization
periods.

## What is Walk-Forward Matrix?

It is simply a set of Walk-Forward optimizations performed with different numbers of
reoptimization periods (runs) and different Out of Sample percentages. The result shows the
total result plus the ideal reoptimization period, and a 3D chart of scores (robustness
results) for all combinations of OOS / runs performed in the matrix.

## Process

1. **Loading a strategy for optimization**: switch to the Optimizer window, load the strategy,
   switch to Walk-Forward Matrix mode. The matrix performs a series of single Walk-Forward
   optimizations, so you configure which numbers of periods (runs) and OOS % it goes through
   using Start, Stop, and Increment fields. Example: runs 5, 7, 9, 11, 13, 15 and OOS % of
   20, 30, 40. Note: computation is very time-consuming because it runs a full Walk-Forward
   optimization for every combination in the matrix.
2. **Setting optimization values** and
3. **Configuring walk-forward runs**: same as ordinary Walk-Forward Optimization.
4. **Checking the results**: the matrix result in the databank shows the best net profit from
   all performed Walk-Forward optimizations. The details show the final robustness test result
   (pass/fail) and a configurable 3D chart displaying results for all matrix combinations. The
   equity chart for a selected combination shows the reoptimized strategy against the original
   non-optimized strategy.

## Interpreting the results

### Using the Walk-Forward matrix as a robustness check

Optimizing with various walk-forward parameters shows whether the strategy "survives" across
different reoptimization periods and different history lengths. The Score 3D chart shows the
robustness result for every parameter combination; it is a great tool for identifying and
avoiding over-optimization (curve-fitting). Robust strategies appear to have gradual, rather
than abrupt, changes in the surface plot.

What we are looking for is that as many WF combinations as possible are successful. As the
minimum, look for a cluster of at least 3x3 combinations where there are more successes than
failures (for example at least 7 of 9 single Walk-Forward tests successful). If just one such
3x3 group is found in the matrix, the strategy can be considered robust: it not only benefits
from reoptimization but keeps its profitability across different reoptimization periods, which
is a sign of robustness.

### What determines the success of a single Walk-Forward optimization?

A customizable Robustness score is computed for every single Walk-Forward optimization: a set
of score components with boundary values, plus a threshold for how many components must pass
for the WF result to be considered successful. For example, a combination fails if only 4 of 6
score components pass (66%) when the required threshold is 80%. Always look at the failed
combinations and the reason for their failure; if all combinations fail, the success criteria
may be too tight.

### Using the Walk-Forward Matrix to find the optimal reoptimization period

The natural extension of the robustness check: having found a 3x3 group of successful single
Walk-Forward optimizations, select the combination in the middle of it. The strategy should be
robust to reoptimization settings too, so the exact reoptimization date shouldn't matter, as
long as the reoptimization and history periods are kept roughly as tested.

### Advanced 3D charts

3D charts of all the Walk-Forward combinations performed: net profit, drawdown, stagnation,
profit factor, stability, or any other value, as a surface, bar chart, or heatmap. Robust
strategies show gradual changes in the surface plot.
