"""도메인 tool 공유 오케스트레이션 — probe 루프·마스킹·charter/scope 추출.

각 도메인 tool 은 원문을 재-fetch → parse_credentials 로 재료를 뽑은 뒤
`run_probes(materials, ctx, domain=...)` 를 호출한다. 이 모듈은 결과에 평문을
절대 담지 않으며(닫힌 dict), 안전봉투(단발원장·scope·차단기)는 코어가 처리한다.
"""
from __future__ import annotations

import os
from typing import Any

from service.probes.credential_login_probe import (
    CredentialMaterial,
    probe_credential,
)
from service.probes.credential_parse import ParsedCred

# 한 tool 호출당 검증 상한(코어의 사이클 상한과 별개 — tool 레벨 방어).
_MAX_PROBE_PER_CALL = 3


def pc_to_material(pc: ParsedCred, *, base_url: str | None = None) -> CredentialMaterial:
    return CredentialMaterial(
        engine=pc.engine, host=pc.host, port=pc.port, kind=pc.kind,
        secret=pc.secret, user=pc.user, database=pc.database, base_url=base_url,
    )


def _charter_of(ctx: Any) -> str:
    md = getattr(ctx, "metadata", {}) or {}
    return str(md.get("charter_ref") or os.environ.get("DEFAULT_CHARTER_REF") or "")


def _scope_hosts_of(ctx: Any) -> set[str] | None:
    md = getattr(ctx, "metadata", {}) or {}
    raw = md.get("cred_probe_scope_hosts")
    if isinstance(raw, (set, list, tuple)):
        return {str(x) for x in raw}
    return None


def run_probes(materials: list[CredentialMaterial], ctx: Any, *, domain: str,
               max_probe: int = _MAX_PROBE_PER_CALL) -> dict[str, Any]:
    """재료들을 안전봉투 안에서 순차 검증. 반환은 마스킹된 결과 dict 뿐(평문 없음)."""
    charter = _charter_of(ctx)
    scope_hosts = _scope_hosts_of(ctx)
    results: list[dict[str, Any]] = []
    for m in materials[:max_probe]:
        r = probe_credential(m, charter_ref=charter, domain=domain, scope_hosts=scope_hosts)
        results.append(r.to_public_dict())
    return {
        "kind": "credential_login_probe",
        "domain": domain,
        "probed": len(results),
        "results": results,
        "note": ("단발(중앙원장)·쿼리/배치 없음·평문 무저장. "
                 "result=authenticated → 인증 수락(세션 즉시 종료). "
                 "auth_failed 여도 노출 finding 은 유지."),
    }
