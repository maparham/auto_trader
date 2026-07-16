# Cross checks: automated strategy robustness tests (StrategyQuant)

Source: https://strategyquant.com/doc/strategyquant/cross-checks-automated-strategy-robustness-tests/
Saved as text on 2026-07-16 (page blocked headless PDF rendering).

Last updated on 26. 2. 2019 by Kornel Mazur

The biggest danger of strategies generated using any machine learning process is overfitting
(or curve-fitting) the strategy to the historical data on which it was built.

During or after developing a new strategy you should make sure your strategy is robust, which
should increase the probability that it will work also in the future.

## What is robustness?

It is simply the property of a strategy of being able to cope with changing conditions:

- First of all, the strategy should work on unknown data (if the market characteristics didn't
  change) either with or without periodic parameter re-optimization.
- It should not break apart if some trades are missed.
- A robust strategy should not be too sensitive to input parameters: it should work even if you
  slightly change the input parameter values, such as indicator period or some constant, or if
  historical data are slightly changed (spread or slippage is increased, and so on).

The most basic test for robustness is testing the strategy on unknown (Out of Sample) data.

If you run genetic evolution, the strategy is evolved only on the In Sample part of data. The
Out of Sample part is "unknown" to the strategy, so it can be used to determine if the strategy
performs also on the unknown part of data. A strategy that performs well on OOS data may have a
real edge; a strategy that fails on the unknown data is almost certain to be curve fitted.

## Automatic cross checks for robustness in SQ X

Cross checks are optional additional methods that can be applied to every strategy after it is
generated and passes the first filters.

Cross checks can verify strategy robustness from more points of view: by trading it on
additional markets, or by using Monte Carlo methods to simulate hundreds of different equity
curves, or even using Walk-Forward optimization or Matrix.

The important thing is that you can use cross check filters to dismiss the strategy if it
doesn't pass the cross-check test. This allows you to create funnels, where a strategy is
scrutinized by increasingly advanced (and more time demanding) methods, and a strategy that
fails is automatically dropped.

It is up to you how many cross checks you employ and how you configure their filters.

Cross checks are divided into three groups (Basic, Standard, Extensive) depending on how time
consuming they are. They are applied from the simple ones to the more complicated ones: if a
strategy doesn't pass Cross check 1, it is dismissed and not tested by Cross check 2.

Note that running cross checks on a strategy can take significant time. Some cross-check
methods make complicated simulations and hundreds or even thousands of backtests of the
strategy with different parameters, taking thousands of times more time than the initial
strategy generation and initial backtest. A strategy without any cross-check can be generated
in 0.2 second, but with some cross checks applied it could easily take 10 to 200 seconds per
strategy. Cross checks can also be used in Retester (without filtering).

## Possible usage of cross-checks

One possible cross-check application could be to use:

1. Cross check "Retest with higher precision"
2. Cross check "Monte Carlo trades manipulation"
3. Cross check "Retest on additional markets"
4. Optionally cross check "Monte Carlo retest methods"

StrategyQuant will then perform the following steps for every generated strategy:

1. Strategy is randomly generated and tested with the fastest "Selected timeframe" precision.
2. Strategy is automatically filtered and dismissed if it doesn't pass your global filters,
   for example if it doesn't have enough trades or Net Profit is too low.
3. "Retest with higher precision" retests the strategy with minute or even real tick precision,
   to make sure the strategy was reliably backtested using the basic precision. If the strategy
   doesn't pass this first cross-check, it is dismissed.
4. "Monte Carlo trades manipulation" runs a number of simulations of different equity curves by
   manipulating the existing trades, to ensure the original equity curve wasn't achieved by
   luck. Strategies that don't pass this Monte Carlo test are filtered out.
5. "Retest on additional markets" tests the strategy on additional markets or timeframes. If it
   isn't profitable on other markets it is filtered out.
6. Optional "Monte Carlo retest methods" runs a number of simulations where each simulation is
   a new backtest of the strategy using small variations in strategy indicator parameters,
   trading options such as spread and slippage, or in history data. Every such simulation is an
   independent backtest: if one backtest takes 0.2 seconds, 100 Monte Carlo simulations take
   20 seconds for this one strategy.

If the strategy passes these cross-checks it is saved into the databank with good confidence
that it is robust enough.
