"""smb_credential_probe — credential 도달성 검증 (record-only, GET/login-form only).

엔진 `safe_probe.enrich_hits_with_safe_probes` 를 그대로 활용한 얇은 래퍼.
URL/host + id/pw/token 조합이 같이 노출된 hit 의 도달성만 read-only 로 확인한다.

KEEP 불변식(요구 3·안전 4):
- GET · login-form POST · healthcheck 한정. PUT/PATCH/DELETE/임의 state-changing 금지
  (safe_probe 가 강제). follow_redirects=False.
- `max_hits=5` · `timeout=2.0s` **하드캡** (이 도구에서 상향 불가).
- relay/재사용/escalation 금지 — credential 은 record-only. 평문 secret 저장 안 함.
- 결과는 smb_file_hit.validation_json 컬럼(존재)에 적재 — finding hit.validation 으로 인용.
"""
from __future__ import annotations

import json
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.safe_probe import enrich_hits_with_safe_probes
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)

# 하드캡 — 도구 인자로 상향 불가 (안전 불변식).
_MAX_HITS = 5
_TIMEOUT_S = 2.0
_MAX_TARGETS_PER_HIT = 2


class _ProbeHit(BaseModel):
    category: str = "credential"
    kind: str = "credential"
    masked: str | None = None
    line_no: int = 0
    line_preview: str = Field("", description="원문 라인 미리보기(마스킹). URL/host + id/pw 동반 라인.")


class SmbCredentialProbeInput(BaseModel):
    text: str = Field(
        ...,
        max_length=200_000,
        description="검증 대상 컨텍스트 본문(파일 본문 일부 — URL/host + credential 라인 포함).",
    )
    hits: list[_ProbeHit] = Field(
        default_factory=list,
        description="검증할 credential 후보 hit(최대 5건 probe). 각 hit 의 line_preview 주변에서 URL/credential 추출.",
    )
    file_id: int | None = Field(
        None, description="선택: smb_file.id — 결과를 그 파일의 hit validation_json 에 적재.",
    )


class SmbCredentialProbeTool(Tool[SmbCredentialProbeInput]):
    name: ClassVar[str] = "smb_credential_probe"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = (
        "smb credential reachability safe probe GET login-form validation record-only"
    )
    description: ClassVar[str] = (
        "노출된 credential 의 도달성을 read-only 로 검증한다(GET·로그인-form POST·헬스체크 "
        "한정, state-changing 금지). URL/host 와 id/pw/token 이 같은 본문에 같이 있을 때만 "
        f"의미. 최대 {_MAX_HITS}건·각 {_TIMEOUT_S}s 하드캡, follow_redirects=False, "
        "relay/재사용 금지(record-only). 결과(credential_reachability)는 finding hit.validation "
        "으로 인용하거나 file_id 주면 smb_file_hit.validation_json 에 적재한다."
    )
    input_model: ClassVar[type[BaseModel]] = SmbCredentialProbeInput
    prompt_section: ClassVar[str] = (
        "### smb_credential_probe(text, hits, file_id=None)\n"
        "credential+접근점(IP/도메인/DB/API) 공노출 시 read-only 도달성 검증. GET·login-form "
        "POST·healthcheck 만(임의 POST/PUT/DELETE 금지). 결과를 finding hit.validation 에 넣어라."
    )

    async def execute(self, vi: SmbCredentialProbeInput, ctx: ToolContext) -> ToolResult:
        if not vi.hits:
            return ToolError(kind="validation", message="검증할 hit 가 없습니다.")
        hit_dicts = [h.model_dump() for h in vi.hits]
        try:
            enriched = enrich_hits_with_safe_probes(
                vi.text, hit_dicts,
                timeout=_TIMEOUT_S,
                max_hits=_MAX_HITS,
                max_targets_per_hit=_MAX_TARGETS_PER_HIT,
            )
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"safe_probe 실패: {e!r}")

        validated = [e for e in enriched if e.get("validation") is not None]

        # file_id 주어지면 그 파일 hit 에 validation_json 적재 (record-only).
        persisted = 0
        if vi.file_id is not None and validated:
            try:
                from service import state_domain as state
                state.add_file_hits(vi.file_id, enriched)
                persisted = len(validated)
            except Exception:  # noqa: BLE001 — 적재 실패가 검증 결과 반환을 막지 않음
                persisted = 0

        return ToolSuccess(content=json.dumps({
            "kind": "smb_credential_probe",
            "probed": len(hit_dicts),
            "validated": len(validated),
            "persisted": persisted,
            "caps": {"max_hits": _MAX_HITS, "timeout_s": _TIMEOUT_S,
                     "methods": "GET/login-form POST/healthcheck only (record-only)"},
            "results": [
                {"kind": e.get("kind"), "validation": e.get("validation")}
                for e in validated
            ],
        }, ensure_ascii=False))
