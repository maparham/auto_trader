"""End-to-end probe for the preset pattern scan: fetch the families
manifest, scan the given charts, print per-chart results.

Usage: cd backend && python3 -m scripts.pattern_scan_probe \
  --chart US100:DAY --chart EURUSD:WEEK [--family broadening] [--url URL]
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request


def req(url: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--chart", action="append", required=True,
                    help="EPIC:RESOLUTION, repeatable")
    ap.add_argument("--family", action="append", default=None,
                    help="family key (default: all built-ins)")
    args = ap.parse_args()

    manifest = req(f"{args.url}/api/patterns/families")["families"]
    fams = args.family or [f["family"] for f in manifest]
    print(f"families: {', '.join(fams)}")

    charts = []
    for c in args.chart:
        epic, _, resolution = c.partition(":")
        charts.append({"epic": epic, "resolution": resolution})
    out = req(f"{args.url}/api/patterns/scan", {
        "charts": charts, "families": [{"family": f, "params": {}} for f in fams],
    })
    for chart in out["charts"]:
        head = f"{chart['epic']} {chart['resolution']}: {chart['status']}"
        print(head if chart["status"] == "ok" else head + f" {chart.get('error') or ''}")
        for h in chart.get("hits", []):
            state = "forming" if h["forming"] else "completed"
            print(f"  {h['family']}/{h['variant']} [{state}] "
                  f"ts={h['ts']}..{h['endTs']} dist={h['distance']:.3f}")
    print(f"elapsed {out['elapsedMs']} ms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
