"""smb_credential_login_probe — 발견된 DB 크리덴셜의 **유효성**을 1회 검증(active).

recon→active 경계. `smb_credential_probe`(도달성/HTTP-only)와 달리 이 도구는 파일에서
발견한 DB 커넥션스트링으로 **실제 로그인 1회**를 시도해 크리덴셜이 살아있는지 확인한다.
"노출+:1433 도달"을 "노출+유효 확인"으로 격상.

안전(코어 service.probes.credential_login_probe 가 강제):
  - 마스터 스위치 SA_CRED_PROBE + scope allowlist SA_CRED_PROBE_SCOPE(빈값=거부).
  - 중앙 영속 단발원장(교차프로세스/크래시 단발) + LOGIN 이후 실패 시 프로세스 db 로그인 전면 halt.
  - LOGIN 1회·쿼리/배치 0·즉시 close·database=None·라우팅/재시도/풀 비활성·IP 핀.
  - 평문 격리: raw 비번은 이 도구·코어 지역변수로만. 결과는 닫힌 enum + 에러코드 파생 상수뿐.

입력: share/path(워커가 보는 파일) + line_no(커넥션스트링 위치) + file_id(선택). 원문은
도구가 host(=워커 담당 smb_host)에서 read-only 재-fetch 하며, **agent 는 raw 비번을 보지 않는다.**
로그인 타깃(host:port)은 파일 내 커넥션스트링에서 파생되며 scope allowlist 로 게이트된다.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


def _smb_mod():
    from domains.smb.plugin.agent_types import smb
    return smb


class SmbCredentialLoginProbeInput(BaseModel):
    share: str = Field(..., description="파일이 있는 SMB share 이름")
    path: str = Field(..., description="share-root 기준 파일 경로(커넥션스트링 포함 파일)")
    line_no: int | None = Field(
        None, description="커넥션스트링이 있는 라인(1-based). 주면 그 근처 우선 파싱.")
    file_id: int | None = Field(None, description="선택: smb_file.id — 감사 상관용")
    max_bytes: int = Field(512 * 1024, ge=1, le=4 * 1024 * 1024)


class SmbCredentialLoginProbeTool(Tool[SmbCredentialLoginProbeInput]):
    name: ClassVar[str] = "smb_credential_login_probe"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = False  # active — 실제 로그인 시도(경계 넘음)
    deferred: ClassVar[bool] = False  # active tool — 직접 노출(발견 신뢰도)
    search_hint: ClassVar[str] = (
        "smb db credential login validate active mssql postgres connection string alive"
    )
    description: ClassVar[str] = (
        "발견한 DB 커넥션스트링(mssql/postgres)으로 **로그인 1회**를 시도해 크리덴셜 "
        "유효성을 검증한다(active·단발·쿼리없음·즉시종료). smb_credential_probe(도달성)와 "
        "달리 실제 인증까지 확인 — 'credential exposed'를 'confirmed valid'로 격상. "
        "share/path/line_no 를 주면 도구가 원문을 read-only 재-fetch 후 커넥션스트링을 "
        "인메모리 파싱해 검증한다(raw 비번은 반환/저장 안 함). 마스터 스위치·scope "
        "allowlist·중앙 단발원장·락아웃 차단기로 게이트. authenticated 면 finding "
        "hit.validation 에 결과를 인용하라."
    )
    input_model: ClassVar[type[BaseModel]] = SmbCredentialLoginProbeInput
    prompt_section: ClassVar[str] = (
        "### smb_credential_login_probe(share, path, line_no=None, file_id=None)\n"
        "DB 커넥션스트링(User ID/Password/Data Source 또는 db URL) 발견 시, 노출이 실제로 "
        "악용가능한지 **로그인 1회**로 검증. 단발·쿼리없음. 결과(credential_login_probe: "
        "authenticated/auth_failed/…)를 finding hit.validation 에 넣어 심각도 근거로 삼아라. "
        "auth_failed 여도 평문노출 자체는 유효 finding."
    )

    async def execute(self, vi: SmbCredentialLoginProbeInput, ctx: ToolContext) -> ToolResult:
        from service.probes.credential_parse import parse_credentials
        from service.probes.credential_probe_tool import pc_to_material, run_probes

        smb = _smb_mod()
        host = str((getattr(ctx, "metadata", {}) or {}).get("smb_host") or "")
        if not host:
            return ToolError(kind="validation",
                             message="smb_host 미상 — #1 점검 워커 컨텍스트에서만 사용 가능.")
        if smb._AUTH_DISABLED_REASON:
            return ToolError(kind="forbidden",
                             message=f"SMB auth locked out — 차단. reason: {smb._AUTH_DISABLED_REASON}")

        # read-only 재-fetch (원문은 도구 내부에서만; agent 에 반환 안 함)
        try:
            status, body = await asyncio.to_thread(
                smb.fetch_file, host, vi.share, vi.path, max_bytes=vi.max_bytes,
            )
        except Exception:  # noqa: BLE001 — 예외 표현에 크리덴셜/경로가 실릴 수 있어 상수 메시지(codex#8)
            return ToolError(kind="execution", message="credential_source_fetch_failed")
        if status != "text":
            return ToolSuccess(content=json.dumps({
                "kind": "credential_login_probe", "probed": 0,
                "note": f"본문 텍스트 아님({status}) — 커넥션스트링 파싱 불가.",
            }, ensure_ascii=False))

        parsed = parse_credentials(body, around_line=vi.line_no)
        db_mats = [pc_to_material(pc) for pc in parsed if pc.engine in ("mssql", "postgres")]
        if not db_mats:
            return ToolSuccess(content=json.dumps({
                "kind": "credential_login_probe", "probed": 0,
                "note": "검증 가능한 mssql/postgres 커넥션스트링 없음(mysql/oracle 등은 미지원).",
            }, ensure_ascii=False))

        out = run_probes(db_mats, ctx, domain="smb")
        out["source"] = {"share": vi.share, "path": vi.path, "file_id": vi.file_id}

        # 결정론적 영속: 검증 결과를 hit.validation 에 직접 붙인다(LLM 인용에 의존하지 않음).
        # finding/리포트가 "노출"이 아니라 "악용 가능(확인됨)"으로 읽히게 하는 근거.
        # 라인 귀속은 **파서가 찾은 실제 라인**(입력 hint 가 아니라)을 쓴다.
        persisted = await asyncio.to_thread(
            _persist_validation, host, vi.share, vi.path, vi.file_id, out,
            [pc for pc in parsed if pc.engine in ("mssql", "postgres")],
        )
        out["validation_persisted"] = persisted

        from secu_agent.agent.secret_redact import redact_secrets
        return ToolSuccess(content=redact_secrets(json.dumps(out, ensure_ascii=False)))


# 로그인 사실을 담은(=영속 가치가 있는) 결과. 그 외(skipped_*/not_performed/error/
# unreachable)는 크리덴셜 유효성에 대해 아무것도 말하지 않으므로 영속하지 않는다
# — 특히 재호출 시 `skipped_repeat` 가 기존 authenticated 를 덮어쓰는 것을 막는다(codex#6).
_INFORMATIVE = frozenset({
    "authenticated", "auth_failed", "account_locked",
    "credential_expired", "session_denied",
})


def _mask_principal(user: str | None) -> str:
    """사용자명 마스킹 — username 이 비밀번호와 같은 경우의 우회 누수 차단(codex#2)."""
    u = str(user or "")
    if not u:
        return ""
    if len(u) <= 2:
        return "*" * len(u)
    return u[0] + "*" * (len(u) - 2) + u[-1]


def _persist_validation(host: str, share: str, path: str, file_id: int | None,
                        out: dict[str, Any], creds: list[Any]) -> int:
    """프로브 결과를 해당 **라인의** hit.validation 에 병합. 평문 없음. 실패는 무해(0).

    - file_id 는 항상 (host, share, path) 에서 재도출한다(입력값은 일치 확인용) —
      호출자가 남의 file_id 를 넘겨 오귀속시키는 confused-deputy 차단(codex#4).
    - 라인은 파서가 기록한 **실제 라인**을 쓴다(입력 hint 아님, codex#5).
    """
    try:
        from service import state_domain as state
        from domains.smb.plugin.tools.smb_tools import _find_file_id
        fid = _find_file_id(host, share, path)
        if fid is None:
            return 0
        if file_id is not None and int(file_id) != int(fid):
            return 0  # 입력 file_id 가 실제 경로와 불일치 → 영속 거부(오귀속 방지)
        results = [r for r in (out.get("results") or []) if isinstance(r, dict)]
        if not results:
            return 0
        total = 0
        for idx, rep in enumerate(results):
            if rep.get("result") not in _INFORMATIVE:
                continue
            src_line = None
            if idx < len(creds):
                src_line = getattr(creds[idx], "line_no", None)
            validation = {
                "kind": "credential_login_probe",
                "result": rep.get("result"),
                "proves_validity": rep.get("proves_validity") is True,
                "engine": rep.get("engine"),
                "endpoint_host": rep.get("host"),
                "endpoint_port": rep.get("port"),
                "principal_masked": _mask_principal(rep.get("user")),
                "credential_kind": rep.get("credential_kind"),
                "detail": rep.get("detail"),
                "single_attempt": rep.get("single_attempt"),
                "elapsed_ms": rep.get("elapsed_ms"),
                "policy": "single login attempt; no query/batch; ledgered; scope-gated",
            }
            # 실제 라인을 모르면(멀티라인 join 등) 귀속하지 않는다 — 파일 전체 부착은
            # 다른 크리덴셜/다른 hit 오귀속을 만든다(codex#3/#5).
            if src_line is None:
                continue
            total += state.file_hit_attach_validation(fid, validation, line_no=src_line)
        return total
    except Exception:  # noqa: BLE001 — 영속 실패가 검증 결과 반환을 막지 않는다.
        return 0
