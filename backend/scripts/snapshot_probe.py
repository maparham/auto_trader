"""End-to-end probe for the live chart snapshot: renders the heartbeat view
for --epic against the running dev stack and writes snapshot.png.

Usage: cd backend && python3 -m scripts.snapshot_probe --epic US100 \
           [--broker capital] [--user dev] [--level 20000] [--out snapshot.png]
Requires: backend running, frontend dev server running, and the app opened at
least once on that chart (so a heartbeat exists)."""

from __future__ import annotations

import argparse
import asyncio
import sys


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epic", required=True)
    ap.add_argument("--broker", default="capital")
    ap.add_argument("--user", default="dev")
    ap.add_argument("--level", type=float, default=None)
    ap.add_argument("--out", default="snapshot.png")
    args = ap.parse_args()

    from auto_trader.core.chart_snapshot import render_live_chart

    payload = {"broker": args.broker, "epic": args.epic,
               "level": args.level, "price": args.level}
    png = await render_live_chart(args.user, payload)
    if png is None:
        print("render returned None — check: heartbeat exists (open the app on "
              "that chart, wait 3s), frontend dev server up, playwright installed "
              "(python -m playwright install chromium)")
        return 1
    with open(args.out, "wb") as f:
        f.write(png)
    print(f"wrote {args.out} ({len(png)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
