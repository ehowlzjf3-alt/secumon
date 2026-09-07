"""SMB evidence judge — 구 코어 `evidence_judgment._judge_smb_credential_hit` 원형.

v3.82 U3a 에서 코어 게이트가 등록형(`register_evidence_judge`)으로 전환되면서
이동 (결정 ⑪ — 훅 신설과 동시 이동, 약화 금지). bootstrap.py 가
`register_evidence_judge("smb", judge_smb_credential_hit)` 로 등록한다.

import 부수효과 없음 — 테스트가 직접 import 해 등록/해제할 수 있다.
generic 헬퍼는 코어 evidence_judgment 의 공용 패턴을 재사용한다 (plugin
judge 용으로 재사용 가능함이 코어 모듈에 문서화돼 있다).
"""
from __future__ import annotations

from secu_agent.agent.evidence_judgment import (
    EvidenceJudgment,
    _content_evidence_categories,
    _credential_pair_or_token_in_text,
    _has_direct_credential_value_evidence,
    _has_probe_validation,
    _HTTP_OR_HOST_RE,
    _rejected,
    _suspected,
)

# ── 재시도 절차를 **거부 메시지 안에** 실어 보낸다 ──────────────────────────
# 2026-08-17 실측: smb halt 5건을 페이로드 해시로 비교했더니 워커가 **실제로 수리한**
# 경우에도 죽었다.
#
#     12.56.74.220  제출 2회 · 페이로드 다름(hits 수정, 1093→1101자)  → halt
#     12.56.74.200  제출 2회 · 페이로드 동일                          → halt(정당)
#     12.23.67.40   제출 5회 · 4가지 · 마지막 둘만 동일               → 그때 halt
#
# `repeat_error.py` 의 halt 카운터는 **페이로드가 아니라 오류 메시지**가 연속으로 같은지를
# 센다. 그래서 내용을 고쳐도 판정문이 같으면 두 번째 제출이 곧 halt 다. 살아남는 유일한
# 방법은 두 제출 **사이에 실제 도구 호출을 끼워** 연속 카운터를 리셋하는 것이다.
#
# 그 절차는 worker.md 에도 적혀 있지만 지켜지지 않았다. 거부 시점에 in-context 로 오는
# 이 문장이 규약보다 강하다 — 워커가 그것을 읽는 순간이 바로 결정하는 순간이다.
_RETRY_PROCEDURE = (
    "⚠️ 재제출 전에 반드시 **다른 도구를 한 번 호출**하라(원문 재확인: smb_fetch_scan / "
    "smb_task_python). 도구 호출 없이 곧바로 다시 제출하면 — 내용을 고쳤더라도 — "
    "같은 판정문이 연속 2회로 집계되어 이 태스크가 통째로 죽고 확정한 finding 까지 잃는다. "
    "가져올 증거가 없으면 재제출하지 말고 finding_count=0 으로 닫아라(항상 안전)."
)


def _is_printer_driver_password_field_claim(kind: str, masked: str, preview: str) -> bool:
    """Printer driver INI password-field claims need direct value evidence.

    `value_present=True` plus `<masked,len=N>` is only a model assertion that a
    field was non-empty. It is not enough evidence, and recently caused print$
    driver templates with empty password fields to be submitted as credentials.
    """
    k = (kind or "").strip().lower()
    if "printer_fax_config_password_fields" not in k:
        return False
    m = (masked or "").strip().lower()
    p = (preview or "").strip().lower()
    return (
        "<masked,len=" in m
        or "value_present=true" in p
        or not _has_direct_credential_value_evidence(kind, masked, preview)
    )


def judge_smb_credential_hit(finding, hit) -> EvidenceJudgment | None:
    """SMB hit 심층 판정. None = 비대상 → 코어 generic 계약으로 폴백.

    구 코어 동작 보존: 프린터드라이버 INI 주장 거부는 content 증거 category
    전체(코어 4종 + 등록 분류)에, credential/secret 은 추가로 deep-dive 증거와
    safe_probe 검증을 요구.
    """
    category = str(getattr(hit, "category", "") or "")
    kind = str(getattr(hit, "kind", "") or "")
    masked = str(getattr(hit, "masked", "") or "")
    preview = str(getattr(hit, "preview", "") or "")
    if category in _content_evidence_categories() and \
            _is_printer_driver_password_field_claim(kind, masked, preview):
        return _rejected(
            "printer driver password-field claim lacks direct value evidence — "
            "`value_present=True`/`<masked,len=N>` 만으로는 비밀번호 노출 확정 금지. "
            "원본 라인에서 실제 값이 비어 있지 않은지 read-only 재확인하고, 비어 있으면 "
            "finding 제출 금지.",
            "원본 INI 라인의 password key/value 를 재확인하고 비어 있으면 제외",
            _RETRY_PROCEDURE,
        )
    if category not in {"secret", "credential"}:
        return None
    if not _has_direct_credential_value_evidence(kind, masked, preview):
        return _rejected(
            "SMB credential/secret finding requires deep-dive evidence from the file body — "
            "detector label, field name, or value_present assertion is not enough. "
            "원문 파일을 smb_fetch_file/smb_inspect_pdf/smb_inspect_image 로 읽고, 실제 "
            "값이 있는 key=value/PEM 라인을 마스킹해 preview/masked 에 넣어라.",
            "원문 파일을 다시 읽어 실제 값이 있는 라인만 마스킹해 제출",
            _RETRY_PROCEDURE,
        )
    evidence_text = "\n".join([masked, preview, finding.summary or ""])
    if (
        _HTTP_OR_HOST_RE.search(evidence_text)
        and _credential_pair_or_token_in_text(evidence_text)
        and not _has_probe_validation(hit, finding)
    ):
        return _suspected(
            "SMB credential/secret hit contains a reachable target hint and credential material "
            "but no GET/login-form POST validation result. 크리덴셜쌍이 실제 사용 가능한지 "
            "read-only GET 또는 로그인 endpoint 한정 POST로 확인하고 결과를 validation 또는 "
            "검증 설명에 포함해야 한다.",
            "safe_probe 결과(credential_reachability)를 hit.validation에 넣거나 검증 결과를 risk_narrative에 남겨 재제출",
            _RETRY_PROCEDURE,
        )
    return None
