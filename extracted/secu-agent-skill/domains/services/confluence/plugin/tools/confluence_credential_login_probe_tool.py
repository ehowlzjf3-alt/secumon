"""confluence_credential_login_probe — 위키 페이지에서 발견한 크리덴셜 유효성 1회 검증(active).

DB 커넥션스트링/URL(mssql/postgres) → 로그인 1회. github PAT → GHE whoami(GITHUB_BASE_URL 설정 시).
안전봉투는 코어(service.probes.credential_login_probe)가 강제. 원문은 도구가 fetch_page_body 로
read-only 재추출 — agent 는 raw 비번/토큰을 보지 않는다.
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


class ConfluenceCredentialLoginProbeInput(BaseModel):
    page_id: str = Field(..., description="Confluence content id(페이지)")
    line_no: int | None = Field(None, description="크리덴셜 라인(1-based). 주면 근처 우선 파싱.")


class ConfluenceCredentialLoginProbeTool(Tool[ConfluenceCredentialLoginProbeInput]):
    name: ClassVar[str] = "confluence_credential_login_probe"
    domain: ClassVar[str] = "confluence"
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = False  # active tool — 직접 노출(발견 신뢰도)
    search_hint: ClassVar[str] = (
        "confluence credential login validate active db connection string pat token alive"
    )
    description: ClassVar[str] = (
        "위키 페이지에서 발견한 크리덴셜 유효성 검증(active·단발). DB 커넥션스트링/URL은 "
        "로그인 1회(즉시종료·쿼리없음), github PAT 는 GHE whoami 1회. page_id/line_no 주면 "
        "도구가 페이지 본문을 read-only 재추출 후 검증(raw 비번/토큰 반환·저장 안 함). 마스터 "
        "스위치·scope·중앙 단발원장·차단기로 게이트. authenticated 면 finding hit.validation 에 인용."
    )
    input_model: ClassVar[type[BaseModel]] = ConfluenceCredentialLoginProbeInput
    prompt_section: ClassVar[str] = (
        "### confluence_credential_login_probe(page_id, line_no=None)\n"
        "페이지에 DB 커넥션스트링/토큰이 평문 노출됐을 때 실제 유효한지 1회 검증. 결과를 "
        "finding hit.validation 에 인용. auth_failed 여도 노출 자체는 유효 finding."
    )

    async def execute(self, vi: ConfluenceCredentialLoginProbeInput, ctx: ToolContext) -> ToolResult:
        from domains.services.confluence.plugin.agent_types import confluence as cf
        from service.probes.credential_login_probe import CredentialMaterial
        from service.probes.credential_parse import parse_credentials
        from service.probes.credential_probe_tool import pc_to_material, run_probes

        # ★ REST 경로 차단 (2026-08-26). **try 밖**이다 — 안에 두면 아래 except 가
        #   삼켜서 `credential_source_fetch_failed` 로 나가고, 그건 "일시적 조회 실패" 로
        #   읽힌다. 구조적 차단과 일시적 실패는 다른 사실이라 다른 사유를 줘야 한다.
        #
        #   `/rest/api/content` 는 이 인스턴스에서 죽어 있다:
        #       Basic (user+token)  403  "Basic Authentication has been disabled"
        #       Bearer PAT          429  "속도 제한이 초과되었습니다"
        #
        #   ⚠️ 이 도구가 403 을 받으면 **"이 크리덴셜로 로그인 실패"** 로 오독된다.
        #      프로브가 보는 것은 크리덴셜 유효성이지 REST 가용성이 아니다. space 큐
        #      25건이 정확히 같은 오진(권한 없음 ← 사실은 인증 방식 불가)으로 닫혔다.
        #      "확인 못 함" 을 "유효하지 않음" 으로 접으면 살아 있는 크리덴셜이 묻힌다.
        return ToolError(
            kind="forbidden",
            message=("confluence_rest_unavailable: 이 인스턴스는 REST 인증이 막혀 있어"
                     "(Basic 403 / Bearer 429) 원문을 재추출할 수 없다 — 크리덴셜을"
                     " 검증하지 못했다(유효하지 않다는 뜻이 아니다). 브라우저 경로로"
                     " 옮기기 전까지 이 도구는 판정하지 않는다."))

        try:
            body = await asyncio.to_thread(cf.fetch_page_body, vi.page_id)
        except Exception:  # noqa: BLE001 — 예외 표현에 URL/토큰이 실릴 수 있어 상수 메시지(codex#8)
            return ToolError(kind="execution", message="credential_source_fetch_failed")
        if not body:
            return ToolSuccess(content=json.dumps({
                "kind": "credential_login_probe", "probed": 0, "note": "페이지 본문 없음.",
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

        out = run_probes(materials, ctx, domain="confluence")
        out["source"] = {"page_id": vi.page_id}
        from secu_agent.agent.secret_redact import redact_secrets
        return ToolSuccess(content=redact_secrets(json.dumps(out, ensure_ascii=False)))
