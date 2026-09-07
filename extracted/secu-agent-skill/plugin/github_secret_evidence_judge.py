"""github 시크릿 정오탐 게이트의 **submit_finding 경로 배선** — category 축 등록형.

## 왜 필요한가
github finding 생성 경로는 셋인데 게이트는 둘에만 붙어 있었다.

  ① `scanner._persist_scan_findings`              (clone+detector)  → 게이트 O
  ② `service_task_tools._findings_for_scanned`    (github_task_scan) → 게이트 O
  ③ **`submit_finding` → 코어 `judge_task_finding`** (LLM 서술형)     → 게이트 X  ← 여기

③ 의 코어 계약(`_has_hardened_credential_value`)은 **값 형상만** 본다 — 경로 맥락을
전혀 안 본다. 실측(2026-07-30, `source=None` github finding 10건):

  #18788 `tests/test_search_compressor.py`            database_url_with_password
  #18823 `.../ThirdParty/IOS/include/FIROptions.h`    google_api_key (preview 비어 있음)
  #18693 `.env.example`                              database_url_with_password

셋 다 `_STRUCTURED_SECRET_KINDS` 라 값 형상은 진짜처럼 생겼고, 그래서 **게이트가
붙어 있었어도 통과했을 것**이다(구조화 시크릿은 경로 무관 통과였다). 그 계약을
`secret_gate` v3.94 에서 좁게 고쳤고, 이 모듈이 ③ 을 그 규칙에 합류시킨다.

## 계약
- `task_type != "github"` → **None**(코어 계약 폴백). ⚠️ 필수 — `secret_gate` 는
  `.md`/`docs/` 를 코드·문서 경로로 제외하는데 confluence 근거는 위키 본문이라
  전량 사라진다(`secret_gate` 모듈 docstring 의 경고와 같은 이유).
- 통과 → **None**. 거부가 아니라 "이 판정기는 할 말 없음" 이다. 코어의 값-형상 계약이
  이어서 판정하므로 **기존 강도가 그대로 유지**된다(약화 금지).
- 불통과 → `_rejected(사유)`. 코어 `judge_task_finding` 이 blocker 로 집계한다.

## 디스패치 순서 주의
`_TASK_TYPE_JUDGES`(smb) 가 `_CATEGORY_JUDGES` 보다 **먼저** 소비한다
(`evidence_judgment.py:630` vs `:642`). smb finding 은 여기 도달하지 않고, github 은
task_type judge 가 없어 정상 도달한다.

import 부수효과 없음 — bootstrap 이 `register_category_evidence_judge` 로 등록,
테스트는 직접 import 해 등록/해제한다([[pii_evidence_judge]] 와 동형).
"""
from __future__ import annotations

from secu_agent.agent.evidence_judgment import EvidenceJudgment, _rejected


def judge_secret_hit(finding, hit) -> EvidenceJudgment | None:
    """secret hit 정오탐(github 한정). None = 코어 값-형상 계약 폴백."""
    if str(getattr(finding, "task_type", "") or "") != "github":
        return None
    category = str(getattr(hit, "category", "") or "")
    if category != "secret":
        return None

    from domains.services.github.application import secret_gate

    kind = str(getattr(hit, "kind", "") or "")
    masked = str(getattr(hit, "masked", "") or "")
    # submit 경로의 location 은 전체 blob URL — secret_gate 가 내부에서 정규화한다.
    location = str(getattr(hit, "location", "") or "")

    # ⚠️ 스캔 경로용 `is_reportable_secret` 을 쓰면 안 된다 — 그쪽은 detector 의 닫힌 kind
    # 집합을 전제한 화이트리스트라, 모델이 지어낸 kind(`grafana_api_token` 등)가 "미지 →
    # 코드/문서 경로면 제외" 분기로 떨어져 **진짜 유출이 죽는다**(#18866 실증).
    if secret_gate.is_reportable_submitted_secret(kind, masked, location):
        return None

    path = secret_gate.repo_relative_path(location)
    return _rejected(
        f"github secret hit '{kind}' 는 보고 대상이 아니다 — 경로 {path!r} 가 "
        "테스트 픽스처·샘플 설정(.example 류)·벤더링된 서드파티 트리이거나, 값 형상이 "
        "시크릿이 아니라 코드/플레이스홀더다. 남의 SDK 나 테스트 더미 크리덴셜은 "
        "우리 자산의 노출이 아니다.",
        "실제 운영 코드·설정에 있는 노출인지 경로로 확인하고, 픽스처/샘플/서드파티면 "
        "이 hit 를 빼라. 진짜 노출이면 운영 경로의 근거로 재제출",
    )
