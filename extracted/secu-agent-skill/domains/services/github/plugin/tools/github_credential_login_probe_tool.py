"""github_credential_login_probe — 리포 파일에서 발견한 크리덴셜의 **유효성** 1회 검증(active).

두 클래스:
  - http_token: github/gitlab PAT(ghp_/github_pat_/glpat- 등) → GHE API whoami/rate_limit GET 1회
    (락아웃 없음). base_url = GITHUB_BASE_URL(사내 GHE).
  - db_login: 파일 내 DB 커넥션스트링/URL(mssql/postgres) → 로그인 1회(락아웃 민감·차단기).

안전(코어 service.probes.credential_login_probe 강제): 마스터 스위치 SA_CRED_PROBE +
scope allowlist + 중앙 단발원장 + db halt 차단기 + 평문 격리(닫힌 enum·상수 detail).
원문은 도구가 github.fetch_file_at_ref 로 read-only 재추출 — agent 는 raw 토큰/비번 안 봄.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, ClassVar
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)

# 검증 가능한 토큰 패턴(발견 토큰 → GHE 로 whoami). db-url/커넥션스트링은 공유 파서가 처리.
_TOKEN_RE = re.compile(
    r"\b("
    r"ghp_[A-Za-z0-9]{36}"            # github classic PAT
    r"|github_pat_[A-Za-z0-9_]{22,}"  # github fine-grained
    r"|gh[osur]_[A-Za-z0-9]{36}"      # oauth/server/user/refresh
    r"|glpat-[A-Za-z0-9_-]{20}"       # gitlab PAT
    r")\b"
)


def _ghe_base_and_host() -> tuple[str | None, str | None]:
    base = (os.environ.get("GITHUB_BASE_URL", "") or "").rstrip("/")
    if not base:
        return None, None
    host = urlsplit(base).hostname
    return base, host


class GithubCredentialLoginProbeInput(BaseModel):
    repo: str = Field(..., description="owner/name")
    path: str = Field(..., description="리포 내 파일 경로(크리덴셜 포함)")
    ref: str = Field("HEAD", description="git ref(브랜치/태그/SHA). 기본 HEAD")
    line_no: int | None = Field(None, description="크리덴셜 라인(1-based). 주면 근처 우선 파싱.")
    max_bytes: int = Field(512 * 1024, ge=1, le=4 * 1024 * 1024)


class GithubCredentialLoginProbeTool(Tool[GithubCredentialLoginProbeInput]):
    name: ClassVar[str] = "github_credential_login_probe"
    domain: ClassVar[str] = "github"
    is_read_only: ClassVar[bool] = False  # active
    deferred: ClassVar[bool] = False  # active tool — 직접 노출(발견 신뢰도)
    search_hint: ClassVar[str] = (
        "github credential login validate active pat token db connection string alive"
    )
    description: ClassVar[str] = (
        "리포 파일에서 발견한 크리덴셜의 유효성을 검증한다(active·단발). "
        "PAT(ghp_/github_pat_/glpat-)는 GHE API 로 whoami 1회(락아웃 없음), DB "
        "커넥션스트링/URL(mssql/postgres)은 로그인 1회(즉시종료·쿼리없음). 'secret "
        "exposed'를 'confirmed valid'로 격상. repo/path/line_no 주면 도구가 원문을 "
        "read-only 재추출 후 검증(raw 토큰/비번은 반환/저장 안 함). 마스터 스위치·scope·"
        "중앙 단발원장·차단기로 게이트. authenticated 면 finding hit.validation 에 인용."
    )
    input_model: ClassVar[type[BaseModel]] = GithubCredentialLoginProbeInput
    prompt_section: ClassVar[str] = (
        "### github_credential_login_probe(repo, path, ref='HEAD', line_no=None)\n"
        "PAT/토큰 또는 DB 커넥션스트링 발견 시, 실제 유효한지 1회 검증. 단발·즉시종료. "
        "결과(credential_login_probe: authenticated/auth_failed/…)를 finding hit.validation "
        "에 넣어 심각도 근거로. auth_failed 여도 노출 자체는 유효 finding."
    )

    async def execute(self, vi: GithubCredentialLoginProbeInput, ctx: ToolContext) -> ToolResult:
        from domains.services.github.plugin.agent_types import github as gh
        from service.probes.credential_login_probe import CredentialMaterial
        from service.probes.credential_parse import parse_credentials
        from service.probes.credential_probe_tool import pc_to_material, run_probes

        # read-only 재추출(원문은 도구 내부에서만)
        try:
            body = await asyncio.to_thread(
                gh.fetch_file_at_ref, vi.repo, vi.path, ref=vi.ref, max_bytes=vi.max_bytes,
            )
        except Exception:  # noqa: BLE001 — 예외 표현에 URL/토큰/헤더가 실릴 수 있어 상수 메시지(codex#8)
            return ToolError(kind="execution", message="credential_source_fetch_failed")
        if not body:
            return ToolSuccess(content=json.dumps({
                "kind": "credential_login_probe", "probed": 0,
                "note": "본문 없음/비텍스트 — 파싱 불가.",
            }, ensure_ascii=False))

        materials: list[CredentialMaterial] = []
        # 1) DB 커넥션스트링/URL
        for pc in parse_credentials(body, around_line=vi.line_no):
            if pc.engine in ("mssql", "postgres"):
                materials.append(pc_to_material(pc))
        # 2) PAT/토큰 → GHE whoami
        base, ghe_host = _ghe_base_and_host()
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

        out = run_probes(materials, ctx, domain="github")
        out["source"] = {"repo": vi.repo, "path": vi.path, "ref": vi.ref}
        from secu_agent.agent.secret_redact import redact_secrets
        return ToolSuccess(content=redact_secrets(json.dumps(out, ensure_ascii=False)))
