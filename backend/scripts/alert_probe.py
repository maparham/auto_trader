"""End-to-end probe for the backend alert engine.

Prereqs: the backend running (uvicorn auto_trader.api.app:app --port 8000).
No frontend tab needed — the alert engine evaluates ticks server-side off its
own broker feed, independent of any open UI. Run:

    cd backend && python3 -m scripts.alert_probe
    cd backend && python3 -m scripts.alert_probe --epic BTCUSD --broker capital-live

Flow: (1) fetch the current quote for --epic via GET /api/market/{epic}/details
(the broker-provided snapshot's bid/offer — same route the chart's instrument
details modal uses, see auto_trader/api/routers/markets.py); (2) POST a
`greater` price_level alert 0.0001 below the bid so the very next tick fires
it immediately (evaluate_alert in alert_eval.py treats "greater"/"less" as
level checks satisfied by the current sample alone, no prior tick needed —
the bid, the lowest of bid/mid/ask, is used because the engine's priceSide
setting is per-user and this probe doesn't know which side it's set to);
(3) poll GET /api/alerts/triggered for the new entry, up to --timeout seconds
(plus a short grace re-check past the deadline, since triggered history is
independent of the alert row and outlives a fire landing just late); (4)
print PASS/FAIL/TIMEOUT and delete the alert either way.

Auth: mirrors scripts/agent_bridge_probe.py — no auth headers are sent. The
dev backend runs with CLERK_JWKS_URL unset, which auth.py treats as local dev
(no verification, fixed "dev" user); hosted mode would need a Bearer token,
which this probe does not attempt to obtain.

A TIMEOUT on a quiet/closed market is not a code failure — it means no tick
arrived in the window, not that the engine is broken. Try a crypto epic
(ticks 24/7) if an index/FX epic times out. Empirically, the `capital-live`
data broker fires reliably for BTCUSD within well under a minute of a fresh
alert; the `capital` (demo) data broker did not fire for BTCUSD in over ten
minutes of observation in this environment — likely a demo-account data
restriction on that symbol rather than an alert-engine bug (see the Task 13
report for detail). Pass --broker capital-live if the default doesn't fire.
"""
from __future__ import annotations

import argparse
import sys
import time
import uuid

import httpx

DEFAULT_URL = "http://localhost:8000"


def _quote(client: httpx.Client, epic: str, broker: str) -> float:
    """Lowest of bid/offer for `epic` from the broker's market-detail snapshot.

    The alert engine samples bid, mid or ask per-user (STATE_STORE's
    `priceSide` setting — see AlertEngine.price_side_for in alert_engine.py),
    and this probe doesn't know which side a given deployment is set to.
    Using the bid (the lowest of the three) rather than the mid keeps the
    "0.0001 below" level below ALL three sides, so a `greater` alert fires
    regardless of priceSide.
    """
    resp = client.get(f"/api/market/{epic}/details", params={"broker": broker})
    resp.raise_for_status()
    snapshot = resp.json().get("snapshot") or {}
    bid, offer = snapshot.get("bid"), snapshot.get("offer")
    if bid is None or offer is None:
        raise RuntimeError(
            f"no bid/offer in snapshot for {broker}:{epic} "
            f"(marketStatus={snapshot.get('marketStatus')!r}) — market likely closed"
        )
    return bid


def main(url: str, epic: str, broker: str, timeout: float) -> int:
    alert_id = f"al-probe-{uuid.uuid4()}"
    with httpx.Client(base_url=url, timeout=10.0) as client:
        print(f"connecting to {url}")

        try:
            bid = _quote(client, epic, broker)
        except (httpx.HTTPError, RuntimeError) as e:
            print(f"FAIL: could not fetch quote for {broker}:{epic}: {e}")
            return 1
        level = bid - 0.0001
        print(f"{broker}:{epic} bid={bid} -> alert level={level} condition=greater")

        body = {
            "id": alert_id,
            "broker": broker,
            "epic": epic,
            "kind": "price_level",
            "params": {"level": level, "condition": "greater", "trigger": "once"},
            "message": "alert_probe e2e check",
        }
        resp = client.post("/api/alerts", json=body)
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            print(f"FAIL: create alert failed: {e}\n{resp.text}")
            return 1
        print(f"created alert {alert_id}")

        result = "TIMEOUT"
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                resp = client.get("/api/alerts/triggered")
                resp.raise_for_status()
                entries = resp.json().get("entries", [])
                # NOTE: triggered-history rows key the alert by `alert_id`,
                # not `id` (unlike the CRUD /api/alerts rows) — see
                # AlertEngine._fire in alert_engine.py.
                if any(e.get("alert_id") == alert_id for e in entries):
                    result = "PASS"
                    break
                time.sleep(1.0)
            if result != "PASS":
                # Grace re-check: triggered history is independent of the
                # alert row (it survives deletion — verified empirically), so
                # a fire landing just past the deadline is still worth
                # catching before reporting a false TIMEOUT.
                time.sleep(2.0)
                resp = client.get("/api/alerts/triggered")
                resp.raise_for_status()
                entries = resp.json().get("entries", [])
                if any(e.get("alert_id") == alert_id for e in entries):
                    result = "PASS"
        finally:
            del_resp = client.delete(f"/api/alerts/{alert_id}")
            if del_resp.status_code not in (204, 404):
                print(f"warning: cleanup delete returned {del_resp.status_code}: {del_resp.text}")
            else:
                print(f"cleaned up alert {alert_id}")

        if result == "PASS":
            print(f"PASS: alert {alert_id} triggered within {timeout:.0f}s")
            return 0
        print(
            f"TIMEOUT/FAIL: alert {alert_id} did not trigger within {timeout:.0f}s. "
            "This can mean a quiet/closed market (no tick arrived) rather than a "
            "code bug — try a 24/7 epic such as BTCUSD before treating this as a "
            "regression."
        )
        return 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=DEFAULT_URL, help=f"backend base URL (default {DEFAULT_URL})")
    ap.add_argument("--epic", default="US100", help="epic to alert on (default US100)")
    ap.add_argument("--broker", default="capital", help="data broker id (default capital)")
    ap.add_argument("--timeout", type=float, default=30.0, help="seconds to wait for the trigger (default 30)")
    ns = ap.parse_args()
    sys.exit(main(ns.url, ns.epic, ns.broker, ns.timeout))
