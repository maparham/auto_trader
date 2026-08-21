"""Run the pattern-search benchmark: every case against every variant (or a
--variants / --cases subset), one row per variant with per-case detail on -v.

Usage, from backend/:
    python3 -m scripts.pattern_bench
    python3 -m scripts.pattern_bench --variants ohlc,smooth-m8+mres -v
"""

from __future__ import annotations

import argparse
import time

from .cases import ALL_CASES
from .metrics import CaseScore, score_case
from .variants import VARIANTS, run_variant


def main() -> None:
    ap = argparse.ArgumentParser(description="candle-pattern search benchmark")
    ap.add_argument("--variants", help="comma-separated variant keys (default: all)")
    ap.add_argument("--cases", help="comma-separated case names (default: all)")
    ap.add_argument("-v", "--verbose", action="store_true", help="per-case rows")
    args = ap.parse_args()

    variant_keys = args.variants.split(",") if args.variants else list(VARIANTS)
    unknown = [k for k in variant_keys if k not in VARIANTS]
    if unknown:
        ap.error(f"unknown variants: {unknown}; have {list(VARIANTS)}")

    print("building cases...", flush=True)
    cases = [f() for f in ALL_CASES]
    if args.cases:
        wanted = set(args.cases.split(","))
        cases = [c for c in cases if c.name in wanted]
    for c in cases:
        print(f"  {c.name}: {len(c.ohlc)} bars, {len(c.expected)} good, {len(c.known_bad)} bad")

    header = f"{'variant':<24} {'meanrank':>8} {'p@10':>6} {'r@10':>6} {'bad@10':>7} {'found':>7} {'ms':>6}"
    print()
    print(header)
    print("-" * len(header))
    for key in variant_keys:
        variant = VARIANTS[key]
        scores: list[CaseScore] = []
        t0 = time.perf_counter()
        rows = []
        for case in cases:
            hits = run_variant(variant, case.ohlc, case.ts, case.query_bars, case.query_span)
            s = score_case(hits, case.query, case.expected, case.known_bad)
            scores.append(s)
            rows.append((case.name, s))
        ms = int((time.perf_counter() - t0) * 1000)

        found = sum(1 for s in scores for r in s.ranks if r is not None)
        total = sum(len(s.ranks) for s in scores)
        with_rank = [s.mean_rank for s in scores if s.mean_rank is not None]
        mean_rank = sum(with_rank) / len(with_rank) if with_rank else float("nan")
        p10 = sum(s.precision_at_10 for s in scores) / len(scores)
        r10 = sum(s.recall_at_10 for s in scores) / len(scores)
        bad10 = sum(s.bad_at_10 for s in scores)
        print(f"{key:<24} {mean_rank:>8.2f} {p10:>6.2f} {r10:>6.2f} {bad10:>7d} {found:>4d}/{total:<2d} {ms:>6d}")
        if args.verbose:
            for name, s in rows:
                ranks = ",".join("-" if r is None else str(r) for r in s.ranks)
                print(f"    {name:<20} ranks=[{ranks}] p@10={s.precision_at_10:.2f} r@10={s.recall_at_10:.2f} bad@10={s.bad_at_10}")


if __name__ == "__main__":
    main()
