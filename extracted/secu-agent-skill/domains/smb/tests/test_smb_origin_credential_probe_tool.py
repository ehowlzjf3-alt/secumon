from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


def _ctx(tmp_path: Path, *, host: str = "10.0.0.5") -> ToolContext:
    return ToolContext(
        evidence_dir=tmp_path,
        metadata={"charter_ref": "TH-TEST-001", "smb_host": host},
    )


def _payload(**updates: Any) -> dict[str, Any]:
    data = {
        "origin_host": "10.0.0.5",
        "target": "https://admin.internal/login",
        "probe_kind": "http_safe_probe",
        "credential_context": "url=https://admin.internal/login user=svc password=secret-value",
        "hits": [{
            "category": "credential",
            "kind": "password",
            "masked": "password=***",
            "line_no": 7,
            "line_preview": "url=https://admin.internal/login user=svc password=***",
        }],
    }
    data.update(updates)
    return data


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_origin_credential_probe_fails_closed_without_runner_url(tmp_path, monkeypatch) -> None:
    from domains.smb.plugin.tools.smb_origin_credential_probe_tool import (
        SmbOriginCredentialProbeTool,
    )

    monkeypatch.delenv("SMB_ORIGIN_PROBE_URL", raising=False)
    monkeypatch.setenv("SMB_ORIGIN_PROBE_TOKEN", "token")

    res = _run(SmbOriginCredentialProbeTool(), _payload(), _ctx(tmp_path))

    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
    assert "origin_pc_validation=not_performed" in res.message


def test_origin_credential_probe_requires_same_origin_host(tmp_path, monkeypatch) -> None:
    from domains.smb.plugin.tools.smb_origin_credential_probe_tool import (
        SmbOriginCredentialProbeTool,
    )

    monkeypatch.setenv("SMB_ORIGIN_PROBE_URL", "https://runner.internal")
    monkeypatch.setenv("SMB_ORIGIN_PROBE_TOKEN", "token")

    res = _run(
        SmbOriginCredentialProbeTool(),
        _payload(origin_host="10.0.0.9"),
        _ctx(tmp_path, host="10.0.0.5"),
    )

    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
    assert "현재 SMB task 대상" in res.message


def test_origin_credential_probe_requires_https_by_default(tmp_path, monkeypatch) -> None:
    from domains.smb.plugin.tools.smb_origin_credential_probe_tool import (
        SmbOriginCredentialProbeTool,
    )

    monkeypatch.setenv("SMB_ORIGIN_PROBE_URL", "http://runner.internal")
    monkeypatch.setenv("SMB_ORIGIN_PROBE_TOKEN", "token")
    monkeypatch.delenv("SMB_ORIGIN_PROBE_ALLOW_HTTP", raising=False)

    res = _run(SmbOriginCredentialProbeTool(), _payload(), _ctx(tmp_path))

    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
    assert "https" in res.message


def test_origin_credential_probe_rejects_unsupported_target(tmp_path, monkeypatch) -> None:
    from domains.smb.plugin.tools.smb_origin_credential_probe_tool import (
        SmbOriginCredentialProbeTool,
    )

    monkeypatch.setenv("SMB_ORIGIN_PROBE_URL", "https://runner.internal")
    monkeypatch.setenv("SMB_ORIGIN_PROBE_TOKEN", "token")

    res = _run(
        SmbOriginCredentialProbeTool(),
        _payload(target="powershell.exe -enc AAA"),
        _ctx(tmp_path),
    )

    assert isinstance(res, ToolError)
    assert res.kind == "validation"
    assert "target" in res.message


def test_origin_credential_probe_calls_source_runner_and_redacts(tmp_path, monkeypatch) -> None:
    from domains.smb.plugin.tools import smb_origin_credential_probe_tool as mod

    monkeypatch.setenv("SMB_ORIGIN_PROBE_URL", "https://runner.internal")
    monkeypatch.setenv("SMB_ORIGIN_PROBE_TOKEN", "token")
    calls: list[dict[str, Any]] = []

    class _Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {
                "status": "reachable",
                "method": "login_form",
                "password": "secret-value",
                "token": "raw-token",
                "evidence": "login accepted for svc",
            }

    class _Client:
        def __init__(self, **kwargs: Any) -> None:
            calls.append({"init": kwargs})

        def __enter__(self):
            return self

        def __exit__(self, *_args: Any) -> None:
            return None

        def post(self, url: str, *, json: dict[str, Any], headers: dict[str, str]):
            calls.append({"url": url, "json": json, "headers": headers})
            return _Response()

    monkeypatch.setattr(mod.httpx, "Client", _Client)

    res = _run(
        mod.SmbOriginCredentialProbeTool(),
        _payload(),
        _ctx(tmp_path, host="10.0.0.5"),
    )

    assert isinstance(res, ToolSuccess), res
    assert calls[1]["url"] == "https://runner.internal/v1/probe/read-only"
    assert calls[1]["json"]["origin_host"] == "10.0.0.5"
    assert calls[1]["json"]["limits"]["read_only"] is True
    assert calls[1]["json"]["limits"]["no_remote_execution"] is True
    assert "secret-value" not in res.content
    assert "raw-token" not in res.content
    body = json.loads(res.content)
    assert body["validation"]["kind"] == "origin_pc_credential_reachability"
    assert body["persisted"] == 0
