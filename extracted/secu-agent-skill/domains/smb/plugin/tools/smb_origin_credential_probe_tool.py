"""Origin-PC credential probe adapter for SMB task workers.

This tool does not create remote execution, proxying, scheduled tasks, services,
or shells. It delegates a bounded read-only probe to an already-approved
source-runner API configured with ``SMB_ORIGIN_PROBE_URL``.
"""
from __future__ import annotations

import json
import os
from typing import Any, ClassVar, Literal
from urllib.parse import urljoin, urlparse

import httpx
from pydantic import BaseModel, Field

from secu_agent.agent.secret_redact import redact_secrets
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)

_TIMEOUT_S = 5.0
_MAX_CONTEXT_CHARS = 120_000

_ProbeKind = Literal["http_safe_probe", "tcp_connect", "smb_tree_list"]


class _ProbeHit(BaseModel):
    category: str = "credential"
    kind: str = "credential"
    masked: str | None = None
    line_no: int = 0
    line_preview: str = Field("", description="마스킹된 credential 주변 라인.")


class SmbOriginCredentialProbeInput(BaseModel):
    origin_host: str = Field(..., min_length=3, max_length=255)
    target: str = Field(
        ...,
        min_length=3,
        max_length=2048,
        description="검증 대상 URL, host:port, 또는 smb://host/share.",
    )
    probe_kind: _ProbeKind = Field(
        "http_safe_probe",
        description="source-runner 가 수행할 read-only probe 종류.",
    )
    credential_context: str = Field(
        "",
        max_length=_MAX_CONTEXT_CHARS,
        description="credential 과 접근점이 같이 있는 최소 본문. output에는 반환하지 않는다.",
    )
    hits: list[_ProbeHit] = Field(
        default_factory=list,
        description="검증 대상 credential hit. raw secret 대신 masked/line_preview 중심.",
    )
    file_id: int | None = Field(
        None,
        description="선택: smb_file.id. 결과 validation 을 해당 파일 hit 에 record-only 적재.",
    )


def _origin_probe_url() -> str:
    return str(os.environ.get("SMB_ORIGIN_PROBE_URL") or "").strip()


def _origin_probe_path() -> str:
    return str(os.environ.get("SMB_ORIGIN_PROBE_PATH") or "/v1/probe/read-only").strip()


def _origin_probe_token() -> str:
    return str(os.environ.get("SMB_ORIGIN_PROBE_TOKEN") or "").strip()


def _verify_tls() -> bool:
    return str(os.environ.get("SMB_ORIGIN_PROBE_VERIFY_TLS") or "true").strip().lower() not in {
        "0", "false", "no",
    }


def _allow_plain_http() -> bool:
    return str(os.environ.get("SMB_ORIGIN_PROBE_ALLOW_HTTP") or "").strip().lower() in {
        "1", "true", "yes",
    }


def _same_origin_scope(origin_host: str, ctx: ToolContext) -> bool:
    expected = str(ctx.metadata.get("smb_host") or "").strip()
    if not expected:
        return True
    return origin_host.strip().lower() == expected.lower()


def _target_allowed(target: str) -> bool:
    value = str(target or "").strip()
    if not value or any(ch.isspace() for ch in value):
        return False
    parsed = urlparse(value)
    if parsed.scheme:
        return parsed.scheme.lower() in {"http", "https", "smb"}
    return ":" in value and "/" not in value


def _sanitize(value: Any) -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            key = str(k)
            low = key.lower()
            if any(s in low for s in ("password", "passwd", "secret", "token", "credential_context")):
                out[key] = "***"
            else:
                out[key] = _sanitize(v)
        return out
    if isinstance(value, list):
        return [_sanitize(v) for v in value[:50]]
    if isinstance(value, str):
        return redact_secrets(value[:4000])
    return value


def _validation_payload(vi: SmbOriginCredentialProbeInput, ctx: ToolContext) -> dict[str, Any]:
    return {
        "kind": "smb_origin_credential_probe",
        "origin_host": vi.origin_host,
        "target": vi.target,
        "probe_kind": vi.probe_kind,
        "credential_context": vi.credential_context,
        "hits": [h.model_dump() for h in vi.hits],
        "charter_ref": str(ctx.metadata.get("charter_ref") or ""),
        "limits": {
            "read_only": True,
            "max_auth_attempts": 1,
            "max_targets": 1,
            "timeout_s": _TIMEOUT_S,
            "max_smb_entries": 10,
            "follow_redirects": False,
            "no_remote_execution": True,
            "no_service_creation": True,
            "no_shell": True,
            "no_proxy_or_tunnel": True,
        },
    }


class SmbOriginCredentialProbeTool(Tool[SmbOriginCredentialProbeInput]):
    name: ClassVar[str] = "smb_origin_credential_probe"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = (
        "smb origin pc credential probe source runner read-only validation"
    )
    description: ClassVar[str] = (
        "credential 이 발견된 PC(origin_host) 관점에서 승인된 source-runner 를 통해 "
        "read-only 도달성 검증을 요청한다. 이 도구 자체는 remote execution, WMI, PsExec, "
        "서비스 생성, shell, proxy/tunnel 을 만들지 않는다. SMB_ORIGIN_PROBE_URL 과 "
        "SMB_ORIGIN_PROBE_TOKEN 이 없으면 fail-closed. origin_host 는 현재 SMB task 대상 "
        "host 와 일치해야 한다."
    )
    prompt_section: ClassVar[str] = (
        "### smb_origin_credential_probe(origin_host, target, probe_kind, credential_context, hits, file_id=None)\n"
        "credential 발견 PC 관점 검증. 승인된 source-runner API로 read-only probe만 위임한다. "
        "env 미설정 또는 source-runner 부재 시 결과를 origin_pc_validation=not_performed 로 기록."
    )
    input_model: ClassVar[type[BaseModel]] = SmbOriginCredentialProbeInput

    async def execute(self, vi: SmbOriginCredentialProbeInput, ctx: ToolContext) -> ToolResult:
        base_url = _origin_probe_url()
        if not base_url:
            return ToolError(
                kind="forbidden",
                message=(
                    "SMB_ORIGIN_PROBE_URL 미설정 — origin PC 관점 검증 불가. "
                    "finding 에 origin_pc_validation=not_performed 로 남겨라."
                ),
            )
        parsed = urlparse(base_url)
        if parsed.scheme != "https" and not _allow_plain_http():
            return ToolError(
                kind="forbidden",
                message=(
                    "SMB_ORIGIN_PROBE_URL 은 기본적으로 https 여야 함. "
                    "격리된 내부 테스트용 http 는 SMB_ORIGIN_PROBE_ALLOW_HTTP=true 로 명시."
                ),
            )
        token = _origin_probe_token()
        if not token:
            return ToolError(
                kind="forbidden",
                message="SMB_ORIGIN_PROBE_TOKEN 미설정 — source-runner 인증 없이는 호출하지 않음.",
            )
        if not _same_origin_scope(vi.origin_host, ctx):
            return ToolError(
                kind="forbidden",
                message=(
                    f"origin_host={vi.origin_host!r} 는 현재 SMB task 대상 "
                    f"{ctx.metadata.get('smb_host')!r} 와 다름."
                ),
            )
        if not _target_allowed(vi.target):
            return ToolError(
                kind="validation",
                message="target 은 http(s) URL, smb://host/share, 또는 host:port 형식만 허용.",
            )
        if not vi.hits:
            return ToolError(kind="validation", message="검증할 credential hit 가 없습니다.")

        payload = _validation_payload(vi, ctx)
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        url = urljoin(base_url.rstrip("/") + "/", _origin_probe_path().lstrip("/"))
        try:
            with httpx.Client(timeout=_TIMEOUT_S, verify=_verify_tls(), trust_env=False) as client:
                response = client.post(url, json=payload, headers=headers)
                response.raise_for_status()
                body = response.json()
        except httpx.HTTPError as e:
            return ToolError(kind="execution", message=f"source-runner 호출 실패: {e!r}")
        except ValueError as e:
            return ToolError(kind="execution", message=f"source-runner JSON 응답 파싱 실패: {e!r}")

        validation = {
            "kind": "origin_pc_credential_reachability",
            "vantage": "origin_pc",
            "origin_host": vi.origin_host,
            "target": vi.target,
            "probe_kind": vi.probe_kind,
            "source_runner": _sanitize(body),
            "limits": payload["limits"],
        }

        persisted = 0
        if vi.file_id is not None:
            try:
                from service import state_domain as state

                state.add_file_hits(
                    int(vi.file_id),
                    [
                        {
                            **h.model_dump(),
                            "validation": validation,
                        }
                        for h in vi.hits
                    ],
                )
                persisted = len(vi.hits)
            except Exception:  # noqa: BLE001
                persisted = 0

        out = {
            "kind": "smb_origin_credential_probe",
            "validated": True,
            "persisted": persisted,
            "validation": validation,
        }
        return ToolSuccess(content=json.dumps(_sanitize(out), ensure_ascii=False))
