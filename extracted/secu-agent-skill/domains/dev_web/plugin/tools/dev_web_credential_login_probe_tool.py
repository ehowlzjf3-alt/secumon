"""dev_web_credential_login_probe — 노출된 설정/.env/URL 의 크리덴셜 유효성 1회 검증(active).

노출 파일(.env, actuator/env, config)에서 발견한 DB 커넥션스트링/URL(mssql/postgres) →
로그인 1회. github PAT → GHE whoami(GITHUB_BASE_URL 설정 시). 안전봉투는 코어가 강제.
원문은 도구가 read-only GET 재추출(trust_env=False) — agent 는 raw 비번/토큰 안 봄.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import ClassVar
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)

_TOKEN_RE = re.compile(
    r"\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|gh[osur]_[A-Za-z0-9]{36}"
    r"|glpat-[A-Za-z0-9_-]{20})\b"
)
_MAX_BYTES = 512 * 1024


def _fetch_url_text(url: str) -> str | None:
    import httpx
    try:
        with httpx.Client(trust_env=False, verify=False, timeout=8.0,
                          follow_redirects=False) as cx:
            r = cx.get(url, headers={"User-Agent": "cred-probe"})
    except Exception:  # noqa: BLE001
        return None
    if r.status_code != 200:
        return None
    return r.text[:_MAX_BYTES]


class DevWebCredentialLoginProbeInput(BaseModel):
    url: str = Field(..., description="노출 설정/.env/actuator URL(크리덴셜 포함 본문)")
    line_no: int | None = Field(None, description="크리덴셜 라인(1-based). 주면 근처 우선 파싱.")


class DevWebCredentialLoginProbeTool(Tool[DevWebCredentialLoginProbeInput]):
    name: ClassVar[str] = "dev_web_credential_login_probe"
    domain: ClassVar[str] = "dev_web"
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = False  # active tool — 직접 노출(발견 신뢰도)
    search_hint: ClassVar[str] = (
        "dev_web credential login validate active env config db connection pat token alive"
    )
    description: ClassVar[str] = (
        "노출된 .env/설정/actuator 본문에서 발견한 크리덴셜 유효성 검증(active·단발). DB "
        "커넥션스트링/URL은 로그인 1회(즉시종료·쿼리없음), github PAT 는 GHE whoami 1회. "
        "url/line_no 주면 도구가 본문을 read-only GET 재추출 후 검증(raw 비번/토큰 반환·저장 "
        "안 함). 마스터 스위치·scope·중앙 단발원장·차단기로 게이트. authenticated 면 finding "
        "hit.validation 에 인용."
    )
    input_model: ClassVar[type[BaseModel]] = DevWebCredentialLoginProbeInput
    prompt_section: ClassVar[str] = (
        "### dev_web_credential_login_probe(url, line_no=None)\n"
        ".env/actuator/env 등에 DB 커넥션스트링/토큰이 노출됐을 때 실제 유효한지 1회 검증. "
        "결과를 finding hit.validation 에 인용. auth_failed 여도 노출 자체는 유효 finding."
    )

    async def execute(self, vi: DevWebCredentialLoginProbeInput, ctx: ToolContext) -> ToolResult:
        from service.probes.credential_login_probe import CredentialMaterial
        from service.probes.credential_parse import parse_credentials
        from service.probes.credential_probe_tool import pc_to_material, run_probes

        body = await asyncio.to_thread(_fetch_url_text, vi.url)
        if not body:
            return ToolSuccess(content=json.dumps({
                "kind": "credential_login_probe", "probed": 0,
                "note": "본문 없음/비200 — 파싱 불가.",
            }, ensure_ascii=False))

        materials: list[CredentialMaterial] = []
        for pc in parse_credentials(body, around_line=vi.line_no):
            if pc.engine in ("mssql", "postgres"):
                materials.append(pc_to_material(pc))
        base = (os.environ.get("GITHUB_BASE_URL", "") or "").rstrip("/")
        ghe_host = urlsplit(base).hostname if base else None
        if base and ghe_host:
            seen: set[str] = set()
            for mt in _TOKEN_RE.finditer(body):
                tok = mt.group(1)
                if tok in seen:
                    continue
                seen.add(tok)
                materials.append(CredentialMaterial(
                    engine="http_token", host=ghe_host, port=443,
                    kind="github_pat", secret=tok, base_url=base,
                ))

        if not materials:
            return ToolSuccess(content=json.dumps({
                "kind": "credential_login_probe", "probed": 0,
                "note": "검증 가능한 토큰/DB 커넥션스트링 없음.",
            }, ensure_ascii=False))

        out = run_probes(materials, ctx, domain="dev_web")
        out["source"] = {"url": vi.url}
        from secu_agent.agent.secret_redact import redact_secrets
        return ToolSuccess(content=redact_secrets(json.dumps(out, ensure_ascii=False)))
