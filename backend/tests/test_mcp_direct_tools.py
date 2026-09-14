import pytest
from fastapi import FastAPI, HTTPException, Request
from starlette.responses import JSONResponse

from auto_trader.api import mcp_server
from auto_trader.api.guard import API_TOKEN_ENV


@pytest.fixture(autouse=True)
def _restore_asgi_app():
    """configure_direct_tools mutates the module-global _ASGI_APP; restore it
    so these tests never leak a tiny test app into whatever ran before/after
    them in the same process."""
    saved = mcp_server._ASGI_APP
    yield
    mcp_server._ASGI_APP = saved


def tiny_app():
    app = FastAPI()

    @app.get("/api/candles")
    async def candles(epic: str, resolution: str, bars: int):
        return [{"timestamp": 1, "open": 1, "high": 2, "low": 0.5, "close": 1.5}]

    @app.get("/api/indicators/series")
    async def series(epic: str, indicator: str, resolution: str, bars: int):
        if indicator == "WOMBAT":
            raise HTTPException(422, "unknown indicator: WOMBAT (one of ATR, RSI)")
        return {"epic": epic, "indicator": indicator, "timestamps": [1], "outputs": {"rsi": [None]}}

    return app


def echo_app():
    """Echoes the received query params so tests can assert what _api_get
    actually sent (in particular, that None values are dropped)."""
    app = FastAPI()

    @app.get("/api/candles")
    async def candles(request: Request):
        return dict(request.query_params)

    return app


def auth_gated_app(expected_token: str):
    """A tiny app with its own gate middleware (independent of the real
    guard.py) that 401s unless Authorization carries the expected token, and
    otherwise echoes the header back so tests can also assert its absence."""
    app = FastAPI()

    @app.middleware("http")
    async def _gate(request: Request, call_next):
        auth = request.headers.get("authorization", "")
        if auth != f"Bearer {expected_token}":
            return JSONResponse(status_code=401, content={"detail": "unauthorized"})
        return await call_next(request)

    @app.get("/api/candles")
    async def candles(request: Request):
        return {"authorization": request.headers.get("authorization", "")}

    return app


@pytest.mark.anyio
async def test_ta_candles_roundtrip():
    mcp_server.configure_direct_tools(tiny_app())
    rows = await mcp_server.ta_candles(epic="US100", resolution="HOUR", bars=10)
    assert rows[0]["close"] == 1.5


@pytest.mark.anyio
async def test_ta_indicator_series_error_carries_body():
    mcp_server.configure_direct_tools(tiny_app())
    with pytest.raises(RuntimeError, match="unknown indicator: WOMBAT"):
        await mcp_server.ta_indicator_series(epic="US100", indicator="WOMBAT")


@pytest.mark.anyio
async def test_error_body_that_is_a_json_list_does_not_crash():
    """FastAPI's own 422 validation errors return a list under 'detail'
    (actually a dict with a list value), but a raw non-dict JSON body (e.g. a
    proxy returning `["boom"]`) must not raise AttributeError from .get()."""
    app = FastAPI()

    @app.get("/api/candles")
    async def candles(epic: str, resolution: str, bars: int):
        return JSONResponse(status_code=500, content=["boom", "boom again"])

    mcp_server.configure_direct_tools(app)
    with pytest.raises(RuntimeError, match=r"\['boom', 'boom again'\]"):
        await mcp_server.ta_candles(epic="US100", resolution="HOUR", bars=10)


@pytest.mark.anyio
async def test_none_params_are_dropped_from_the_request():
    mcp_server.configure_direct_tools(echo_app())
    echoed = await mcp_server.ta_candles(epic="US100", resolution="HOUR", bars=10)
    assert "broker" not in echoed
    assert "from_ts" not in echoed
    assert "to_ts" not in echoed
    assert echoed["epic"] == "US100"


@pytest.mark.anyio
async def test_unconfigured_raises_runtime_error():
    mcp_server._ASGI_APP = None
    with pytest.raises(RuntimeError, match="direct tools not configured"):
        await mcp_server.ta_candles(epic="US100")


@pytest.mark.anyio
async def test_auth_header_attached_when_token_configured(monkeypatch):
    monkeypatch.setenv(API_TOKEN_ENV, "s3cr3t")
    mcp_server.configure_direct_tools(auth_gated_app("s3cr3t"))
    rows = await mcp_server.ta_candles(epic="US100")
    assert rows["authorization"] == "Bearer s3cr3t"


@pytest.mark.anyio
async def test_no_auth_header_when_no_token_configured(monkeypatch):
    monkeypatch.delenv(API_TOKEN_ENV, raising=False)
    app = FastAPI()

    @app.get("/api/candles")
    async def candles(request: Request):
        return {"authorization": request.headers.get("authorization", "")}

    mcp_server.configure_direct_tools(app)
    rows = await mcp_server.ta_candles(epic="US100")
    assert rows["authorization"] == ""


@pytest.mark.anyio
async def test_ta_pattern_search_posts_body():
    app = tiny_app()

    @app.post("/api/patterns/search")
    async def search(body: dict):
        return {"matches": [], "echo": body["mode"]}

    mcp_server.configure_direct_tools(app)
    res = await mcp_server.ta_pattern_search(body={"mode": "shape"})
    assert res["echo"] == "shape"


@pytest.mark.anyio
async def test_ta_pattern_search_422_surfaces_validation():
    app = tiny_app()

    @app.post("/api/patterns/search")
    async def search():
        raise HTTPException(422, [{"loc": ["body", "mode"], "msg": "field required"}])

    mcp_server.configure_direct_tools(app)
    with pytest.raises(RuntimeError, match="field required"):
        await mcp_server.ta_pattern_search(body={})


@pytest.mark.anyio
async def test_ta_pattern_scan_posts_body():
    app = tiny_app()

    @app.post("/api/patterns/scan")
    async def scan(body: dict):
        return {"results": [], "echo": body["family"]}

    mcp_server.configure_direct_tools(app)
    res = await mcp_server.ta_pattern_scan(body={"family": "flags"})
    assert res["echo"] == "flags"


@pytest.mark.anyio
async def test_ta_pattern_families_roundtrip():
    app = tiny_app()

    @app.get("/api/patterns/families")
    async def families():
        return {"families": ["flag", "wedge"]}

    mcp_server.configure_direct_tools(app)
    res = await mcp_server.ta_pattern_families()
    assert res["families"] == ["flag", "wedge"]


@pytest.mark.anyio
async def test_wf_run_and_status():
    app = tiny_app()

    @app.post("/api/backtest/walkforward/jobs")
    async def submit(body: dict):
        return {"job_id": "wf1"}

    @app.get("/api/backtest/walkforward/jobs/{job_id}")
    async def status(job_id: str, cursor: int = 0):
        return {"job_id": job_id, "state": "running", "cursor": cursor}

    mcp_server.configure_direct_tools(app)
    sub = await mcp_server.wf_run(body={"epic": "US100"})
    assert sub["job_id"] == "wf1"
    st = await mcp_server.wf_status(job_id="wf1", cursor=3)
    assert st["state"] == "running" and st["cursor"] == 3


@pytest.mark.anyio
async def test_wf_cancel_and_fold():
    app = tiny_app()

    @app.post("/api/backtest/walkforward/jobs/{job_id}/cancel")
    async def cancel(job_id: str):
        return {"ok": True, "job_id": job_id}

    @app.get("/api/backtest/walkforward/jobs/{job_id}/fold")
    async def fold(job_id: str, key: str):
        return {"job_id": job_id, "key": key}

    mcp_server.configure_direct_tools(app)
    res = await mcp_server.wf_cancel(job_id="wf1")
    assert res["ok"] is True
    fld = await mcp_server.wf_fold(job_id="wf1", key="fold-1")
    assert fld["key"] == "fold-1"


@pytest.mark.anyio
async def test_runs_list_kinds():
    app = tiny_app()

    @app.get("/api/backtest/walkforward/archive")
    async def arch(limit: int = 50, epic: str | None = None):
        return [{"id": "w1"}]

    mcp_server.configure_direct_tools(app)
    rows = await mcp_server.runs_list(kind="walkforward")
    assert rows == [{"id": "w1"}]
    with pytest.raises(ValueError, match="backtest, sweep, walkforward"):
        await mcp_server.runs_list(kind="wombat")


@pytest.mark.anyio
async def test_runs_list_backtest_and_sweep_paths():
    app = tiny_app()

    @app.get("/api/backtest/runs")
    async def runs(limit: int = 50, epic: str | None = None):
        return [{"id": "b1"}]

    @app.get("/api/backtest/sweeps")
    async def sweeps(limit: int = 50, epic: str | None = None):
        return [{"id": "s1"}]

    mcp_server.configure_direct_tools(app)
    assert await mcp_server.runs_list(kind="backtest") == [{"id": "b1"}]
    assert await mcp_server.runs_list(kind="sweep") == [{"id": "s1"}]


@pytest.mark.anyio
async def test_run_get_by_kind():
    app = tiny_app()

    @app.get("/api/backtest/runs/{run_id}")
    async def run(run_id: str):
        return {"id": run_id, "kind": "backtest"}

    @app.get("/api/backtest/walkforward/archive/{run_id}")
    async def wf(run_id: str):
        return {"id": run_id, "kind": "walkforward"}

    mcp_server.configure_direct_tools(app)
    rec = await mcp_server.run_get(kind="backtest", run_id="b1")
    assert rec == {"id": "b1", "kind": "backtest"}
    rec2 = await mcp_server.run_get(kind="walkforward", run_id="w1")
    assert rec2 == {"id": "w1", "kind": "walkforward"}
    with pytest.raises(ValueError, match="backtest, sweep, walkforward"):
        await mcp_server.run_get(kind="wombat", run_id="x")


def test_path_id_accepts_real_id_shapes():
    """Every run_id/job_id in this codebase is uuid.uuid4().hex; the fixture
    ids used elsewhere in this file ("wf1", "b1", "fold-1") must also pass."""
    import uuid

    for ok in ("wf1", "b1", "w1", "fold-1", uuid.uuid4().hex):
        assert mcp_server._path_id(ok) == ok


@pytest.mark.parametrize("bad", [
    "../../../admin/users#",
    "../../../../api/orders#",
    "..",
    "a/b",
    "a\\b",
    "a?x=1",
    "a#frag",
    "with space",
    "",
])
def test_path_id_rejects_traversal_and_unsafe_chars(bad):
    with pytest.raises(ValueError):
        mcp_server._path_id(bad)


@pytest.mark.anyio
async def test_wf_status_rejects_path_traversal_job_id():
    app = tiny_app()

    @app.get("/api/admin/users")
    async def admin_users():
        raise AssertionError("must never be reached: path traversal escaped the intended route")

    mcp_server.configure_direct_tools(app)
    with pytest.raises(ValueError):
        await mcp_server.wf_status(job_id="../../../admin/users#")


@pytest.mark.anyio
async def test_wf_cancel_rejects_path_traversal_job_id():
    app = tiny_app()

    @app.post("/api/orders")
    async def orders():
        raise AssertionError("must never be reached: path traversal reached a dealing route")

    mcp_server.configure_direct_tools(app)
    with pytest.raises(ValueError):
        await mcp_server.wf_cancel(job_id="../../../../api/orders#")


@pytest.mark.anyio
async def test_wf_fold_rejects_path_traversal_job_id():
    mcp_server.configure_direct_tools(tiny_app())
    with pytest.raises(ValueError):
        await mcp_server.wf_fold(job_id="../../../admin/users#", key="k")


@pytest.mark.anyio
async def test_run_get_rejects_path_traversal_run_id():
    mcp_server.configure_direct_tools(tiny_app())
    with pytest.raises(ValueError):
        await mcp_server.run_get(kind="backtest", run_id="../../../admin/users#")
