"""Benchmark harness for candle-pattern search.

Compares the production matchers against experimental variants (smoothed
candidate scan, multi-resolution refinement, swing-structure penalty) on
cases with by-construction ground truth. Nothing in here is imported by
production code: the experimental metrics live in this package until the
benchmark picks a winner.

Run:  cd backend && python3 -m scripts.pattern_bench            # all cases, all variants
      python3 -m scripts.pattern_bench --variants ohlc,smooth8  # a subset
"""
