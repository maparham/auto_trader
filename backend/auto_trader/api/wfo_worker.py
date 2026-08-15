"""ProcessPool worker for walk-forward jobs. Reuses sweep_worker's init-once
state and engine execution; adds per-train-window sliced metrics (one engine
run per combo, sliced N ways) and exact out-of-sample test runs. Spawn-safe,
zero network, no FastAPI imports."""
from __future__ import annotations

import bisect

from auto_trader.api import baselines as baselines_mod
from auto_trader.api import sweep_apply as sa
from auto_trader.api import sweep_worker
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.engine.metrics import slice_window_metrics

_TRAIN_WINDOWS: list[list[int]] | None = None
_EQUITY_CAP = 500
# kind -> synthesized baseline request, built once per worker. Cleared by
# worker_init: an in-process pool (tests) reuses this module across jobs, so a
# stale entry would silently run the previous job's request.
_BASELINE_REQS: dict[tuple, object] = {}


def worker_init(req_dict, htf_candles, strategies_dir, train_windows, expr_sweep=False) -> None:
    global _TRAIN_WINDOWS
    sweep_worker.worker_init(req_dict, htf_candles, strategies_dir, None, expr_sweep)
    _TRAIN_WINDOWS = train_windows
    _BASELINE_REQS.clear()


def run_grid_combo(combo: dict) -> dict:
    """One full-range engine run, sliced into per-train-window metrics.
    Never raises."""
    s = sweep_worker._STATE
    assert s is not None and _TRAIN_WINDOWS is not None, "worker_init not called"
    try:
        result = sweep_worker.execute_combo(s, s.req, combo)
        res_s = resolution_seconds(s.req.resolution)
        cash = s.req.costs.startingCash
        folds = [
            slice_window_metrics(result.trades, result.equity, w[0], w[1], cash, res_s)
            for w in _TRAIN_WINDOWS
        ]
        return {"combo": combo, "folds": folds, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"combo": combo, "folds": None, "error": str(e)}


def _window_is_clean(trades, wfrom: int, wto: int) -> bool:
    """True when the full-range run over [wfrom, wto) is identical to a real
    flat-start run gated at wfrom, so the window can be sliced directly off the
    full-range trades with no engine work. False (a "boundary" window) when a
    trade crosses either edge, in which case a flat-start run would differ:
      - a position open across wfrom (entered before, still open at/after it);
      - a trade filled exactly at wfrom (its signal fired on the wfrom-1 bar and
        a flat-start run gated at wfrom would suppress it);
      - an in-window entry still open past wto (a flat-start run truncated at wto
        force-closes it at wto, the full-range run lets it run on)."""
    for t in trades:
        e = t.entry_time.timestamp()
        x = t.exit_time.timestamp()
        if e < wfrom <= x:
            return False
        if e == wfrom:
            return False
        if wfrom <= e < wto < x:
            return False
    return True


def _end_index(times: list[float], wto: int) -> int | None:
    """Index of the last candle at or before wto (the bar a flat-start window run
    stops on), or None when no candle falls at/before wto."""
    i = bisect.bisect_right(times, wto) - 1
    return i if i >= 0 else None


def run_grid_combo_exact(combo: dict) -> dict:
    """Exact per-train-window metrics for one combo. Runs the combo's full range
    once, then for each train window either slices the full-range trades directly
    (clean window, zero engine work) or replays a flat-start gated run over the
    combo's reused indicator series (boundary window, exact by construction --
    equivalent to run_test). Same row shape as run_grid_combo. Never raises."""
    s = sweep_worker._STATE
    assert s is not None and _TRAIN_WINDOWS is not None, "worker_init not called"
    try:
        session = sweep_worker.build_combo_session(s, s.req, combo)
        res_s = resolution_seconds(s.req.resolution)
        cash = s.req.costs.startingCash
        times = [c.time.timestamp() for c in session.candles]
        full = session.full
        folds = [
            _exact_window_metrics(session, full, w[0], w[1], times, cash, res_s)
            for w in _TRAIN_WINDOWS
        ]
        return {"combo": combo, "folds": folds, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"combo": combo, "folds": None, "error": str(e)}


def _exact_window_metrics(session, full, wfrom, wto, times, cash, res_s) -> dict:
    if _window_is_clean(full.trades, wfrom, wto):
        return slice_window_metrics(full.trades, full.equity, wfrom, wto, cash, res_s)
    end = _end_index(times, wto)
    if end is None:  # window ends before any candle: empty slice
        return slice_window_metrics([], [], wfrom, wto, cash, res_s)
    win = session.run_window(wfrom, end)
    return slice_window_metrics(win.trades, win.equity, wfrom, wto, cash, res_s)


def _downsample(points: list[list[float]], cap: int) -> list[list[float]]:
    if len(points) <= cap:
        return points
    step = len(points) / cap
    out = [points[int(i * step)] for i in range(cap - 1)]
    out.append(points[-1])
    return out


def run_test(payload: dict) -> dict:
    """Exact flat-start OOS run of one fold winner over its test window, via
    the period env-combo (entries gate at test_from, candles truncate at
    test_to; the warm-up prefix keeps indicators warm). Never raises."""
    s = sweep_worker._STATE
    assert s is not None, "worker_init not called"
    combo = payload["combo"]
    test_from, test_to = payload["test_from"], payload["test_to"]
    try:
        run_combo = {**combo, "period:from": test_from, "period:to": test_to}
        # Flat-start run gated at test_from with metrics sliced to the window:
        # fast-forward past the dead prefix (start_at index survives the
        # period:to truncation — that only cuts the tail).
        result = sweep_worker.execute_combo(
            s, s.req, run_combo,
            start_index=sweep_worker.start_at(s.candles, test_from))
        res_s = resolution_seconds(s.req.resolution)
        cash = s.req.costs.startingCash
        metrics = slice_window_metrics(
            result.trades, result.equity, test_from, test_to, cash, res_s)
        # Rebase equity inside the window to starting cash (same offset rule as
        # slice_window_metrics: last pre-window equity maps to cash).
        e0 = cash
        for pt in result.equity:
            if pt.time.timestamp() >= test_from:
                break
            e0 = pt.equity
        offset = cash - e0
        equity = [[int(pt.time.timestamp()), round(pt.equity + offset, 5)]
                  for pt in result.equity
                  if test_from <= pt.time.timestamp() < test_to]
        trades = [{
            "entry_time": int(t.entry_time.timestamp()),
            "exit_time": int(t.exit_time.timestamp()),
            "pnl": round(t.pnl, 5),
            "side": t.side.value,
        } for t in result.trades if test_from <= t.entry_time.timestamp() < test_to]
        return {"key": payload["key"], "combo": combo, "metrics": metrics,
                "trades": trades, "equity": _downsample(equity, _EQUITY_CAP),
                "error": None}
    except Exception as e:  # noqa: BLE001
        return {"key": payload.get("key"), "combo": combo, "metrics": None,
                "trades": None, "equity": None, "error": str(e)}


def _baseline_req(s, kind: str, leg: str | None, payload: dict):
    """Synthesized request for one baseline pass, cached per worker. Expr jobs
    synthesize from `s.req` directly; coded jobs convert it with
    expr_request_from_structured first (null/hold) or set the request's
    internal reverse flag (reversed — the coded module's real signals can't be
    expressed as an expr request)."""
    cache_key = (kind, leg, payload.get("long_enabled"), payload.get("short_enabled"))
    req = _BASELINE_REQS.get(cache_key)
    if req is None:
        if kind == "reversed" and not getattr(s, "expr", False):
            req = s.req.model_copy(update={
                "reverse": True, "sweep": None, "walkforward": None,
                "progressId": None, "baselines": None})
        else:
            base = s.req
            if not getattr(s, "expr", False):
                base = baselines_mod.expr_request_from_structured(s.req)
            if leg is not None:
                base = baselines_mod.side_request(base, leg)
            synth = {"null": baselines_mod.null_request,
                     "hold": baselines_mod.hold_request,
                     "reversed": baselines_mod.reversed_request}[kind]
            req = synth(base)
        _BASELINE_REQS[cache_key] = req
    return req


def _run_baseline_req(s, req, combo, kind: str):
    """One engine pass for a synthesized baseline request. Baselines are
    flat-start runs gated at the combo's period:from with metrics sliced to the
    test window, so fast-forward past the dead prefix like run_test does."""
    start = sweep_worker.start_at(s.candles, combo.get("period:from"))
    if getattr(s, "expr", False) or kind == "reversed":
        # execute_combo routes by the worker state's mode, which matches
        # the request here: expr jobs carry expr baseline requests, and the
        # coded reversed request goes down the coded path (with s.module).
        return sweep_worker.execute_combo(s, req, combo, start_index=start)
    # The worker state is coded-mode, so execute_combo would route an
    # expr request down the coded path — run the expr pipeline directly
    # with the same period env-combo gating.
    env, _rest = sa.split_env_combo(combo)
    patched, candles = sa.apply_env_combo(req, s.candles, env)
    return sa.run_expr_sync(patched, candles, dict(s.htf), {}, None, None,
                            start_index=start)


def run_baseline(payload: dict) -> dict:
    """Flat-start baseline run(s) over one fold's test window, via the same
    period env-combo gating as run_test. Null and hold run once per active side
    (a both-sides 1==1 baseline is a hedge worth exactly minus the costs — see
    baselines.py) and report metrics as {"long": m|None, "short": m|None};
    reversed is a single whole-strategy run reporting a flat metrics dict.
    Active sides: the request's enabled flags for expr jobs, the sides the
    fold's winner actually traded for coded jobs (payload long/short_enabled —
    see the dispatch site in wfo_jobs for why). Never raises."""
    s = sweep_worker._STATE
    assert s is not None, "worker_init not called"
    kind = payload["kind"]
    test_from, test_to = payload["test_from"], payload["test_to"]
    try:
        combo = {"period:from": test_from, "period:to": test_to}
        res_s = resolution_seconds(s.req.resolution)
        cash = s.req.costs.startingCash

        def window_metrics(result):
            return slice_window_metrics(
                result.trades, result.equity, test_from, test_to, cash, res_s)

        if kind == "reversed":
            req = _baseline_req(s, kind, None, payload)
            metrics = window_metrics(_run_baseline_req(s, req, combo, kind))
        else:
            if getattr(s, "expr", False):
                long_on, short_on = s.req.longEnabled, s.req.shortEnabled
            else:
                long_on = payload["long_enabled"]
                short_on = payload["short_enabled"]
            metrics = {"long": None, "short": None}
            for leg, on in (("long", long_on), ("short", short_on)):
                if not on:
                    continue
                req = _baseline_req(s, kind, leg, payload)
                metrics[leg] = window_metrics(_run_baseline_req(s, req, combo, kind))
        return {"key": payload["key"], "kind": kind, "metrics": metrics,
                "error": None}
    except Exception as e:  # noqa: BLE001
        return {"key": payload.get("key"), "kind": payload.get("kind"),
                "metrics": None, "error": str(e)}
