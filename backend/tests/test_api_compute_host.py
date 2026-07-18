"""Lifecycle endpoints: state mapping from mocked boto3 + probe, start call."""
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from auto_trader.api.app import app

client = TestClient(app)


def _ec2_state(state: str) -> MagicMock:
    ec2 = MagicMock()
    ec2.describe_instances.return_value = {
        "Reservations": [{"Instances": [{"State": {"Name": state}}]}]
    }
    # stop_instances echoes the instance's new (transitional) state, as the real
    # AWS API does; _host_state reads it back to report an AWS-confirmed state.
    ec2.stop_instances.return_value = {
        "StoppingInstances": [{"CurrentState": {"Name": "stopping"}}]
    }
    return ec2


def test_host_unconfigured(monkeypatch):
    # Force-empty in os.environ (which wins over the .env fallback) so this
    # asserts "not configured" even when the developer's real .env sets a
    # COMPUTE_EC2_INSTANCE_ID for an actual deployed host.
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "")
    assert client.get("/api/compute/host").json()["state"] == "unconfigured"


def test_host_stopped(monkeypatch):
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "i-abc")
    monkeypatch.setenv("COMPUTE_EC2_REGION", "eu-central-1")
    with patch("auto_trader.api.routers.compute._ec2_client", return_value=_ec2_state("stopped")):
        assert client.get("/api/compute/host").json()["state"] == "stopped"


def test_host_running_probe_fails_is_booting(monkeypatch):
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "i-abc")
    monkeypatch.setenv("COMPUTE_EC2_REGION", "eu-central-1")
    monkeypatch.setenv("COMPUTE_HOST_URL", "http://192.0.2.1:8000")
    monkeypatch.setenv("COMPUTE_HOST_TOKEN", "t")
    with patch("auto_trader.api.routers.compute._ec2_client", return_value=_ec2_state("running")), \
         patch("auto_trader.api.routers.compute._probe_activity", return_value=None):
        assert client.get("/api/compute/host").json()["state"] == "booting"


def test_host_ready(monkeypatch):
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "i-abc")
    monkeypatch.setenv("COMPUTE_EC2_REGION", "eu-central-1")
    with patch("auto_trader.api.routers.compute._ec2_client", return_value=_ec2_state("running")), \
         patch("auto_trader.api.routers.compute._probe_activity", return_value=2):
        body = client.get("/api/compute/host").json()
    assert body["state"] == "ready"
    assert body["activeJobs"] == 2


def test_start_calls_boto(monkeypatch):
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "i-abc")
    monkeypatch.setenv("COMPUTE_EC2_REGION", "eu-central-1")
    ec2 = _ec2_state("stopped")
    with patch("auto_trader.api.routers.compute._ec2_client", return_value=ec2):
        body = client.post("/api/compute/host/start").json()
    ec2.start_instances.assert_called_once_with(InstanceIds=["i-abc"])
    assert body["state"] == "booting"


def test_stop_calls_boto(monkeypatch):
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "i-abc")
    monkeypatch.setenv("COMPUTE_EC2_REGION", "eu-central-1")
    ec2 = _ec2_state("running")
    with patch("auto_trader.api.routers.compute._ec2_client", return_value=ec2):
        body = client.post("/api/compute/host/stop").json()
    ec2.stop_instances.assert_called_once_with(InstanceIds=["i-abc"])
    assert body["state"] == "stopped"


def test_stop_noop_when_already_stopped(monkeypatch):
    monkeypatch.setenv("COMPUTE_EC2_INSTANCE_ID", "i-abc")
    monkeypatch.setenv("COMPUTE_EC2_REGION", "eu-central-1")
    ec2 = _ec2_state("stopped")
    with patch("auto_trader.api.routers.compute._ec2_client", return_value=ec2):
        body = client.post("/api/compute/host/stop").json()
    ec2.stop_instances.assert_not_called()
    assert body["state"] == "stopped"
