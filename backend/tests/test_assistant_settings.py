from __future__ import annotations

import json

from auto_trader.config import AssistantSettings, DEFAULT_ASSISTANT_BASE_URL


def _settings(monkeypatch, tmp_path, file_body=None, **env):
    for k in ("ASSISTANT_API_KEY", "ASSISTANT_BASE_URL", "ASSISTANT_DISABLED", "ASSISTANT_MODEL"):
        monkeypatch.delenv(k, raising=False)
    path = tmp_path / "client.json"
    if file_body is not None:
        path.write_text(file_body)
    monkeypatch.setenv("ASSISTANT_KEY_FILE", str(path))
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return AssistantSettings(_env_file=None).resolved()


def test_reads_key_and_url_from_file(monkeypatch, tmp_path):
    cfg = _settings(monkeypatch, tmp_path, json.dumps({"key": "sk-file", "url": "https://gw.example"}))
    assert cfg.api_key == "sk-file"
    assert cfg.base_url == "https://gw.example"
    assert cfg.model == "claude-opus-5-5"
    assert cfg.configured


def test_env_overrides_file(monkeypatch, tmp_path):
    cfg = _settings(
        monkeypatch, tmp_path, json.dumps({"key": "sk-file", "url": "https://gw.example"}),
        ASSISTANT_API_KEY="sk-env", ASSISTANT_BASE_URL="https://env.example",
    )
    assert cfg.api_key == "sk-env"
    assert cfg.base_url == "https://env.example"


def test_missing_file_is_not_configured(monkeypatch, tmp_path):
    cfg = _settings(monkeypatch, tmp_path, None)
    assert cfg.api_key == ""
    assert cfg.base_url == DEFAULT_ASSISTANT_BASE_URL
    assert not cfg.configured


def test_unreadable_file_is_not_configured(monkeypatch, tmp_path):
    cfg = _settings(monkeypatch, tmp_path, "{not json")
    assert not cfg.configured


def test_disabled_wins(monkeypatch, tmp_path):
    cfg = _settings(monkeypatch, tmp_path, json.dumps({"key": "sk-file"}), ASSISTANT_DISABLED="1")
    assert not cfg.configured


def test_trailing_slash_trimmed(monkeypatch, tmp_path):
    cfg = _settings(monkeypatch, tmp_path, json.dumps({"key": "k", "url": "https://gw.example/"}))
    assert cfg.base_url == "https://gw.example"
