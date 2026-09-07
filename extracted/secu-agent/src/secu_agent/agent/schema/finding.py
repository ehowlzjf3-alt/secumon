"""submit_finding 도구의 입력/출력 스키마."""
from __future__ import annotations

from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

Severity = Literal["informational", "low", "medium", "high", "critical"]

# de-domain (v3.81 T4, 확정 결정 ③): category 는 string — 도메인 분류는
# plugin 이 finding_taxonomy.register_finding_category 로 등록한다
# (task_type 선례와 동일). 코어가 아는 베이스 분류는 아래 7종.
CORE_FINDING_CATEGORIES: tuple[str, ...] = (
    "secret",
    "pii",
    "credential",
    "web_vuln",
    "misconfig",
    "internal_system",
    "attack_surface",
)
FindingCategory = str


class FindingHit(BaseModel):
    category: FindingCategory
    kind: str = Field(
        ...,
        description=(
            "e.g. aws_access_key_id, kr_rrn, exposed_file, "
            "missing_security_header, internal_document"
        ),
    )
    masked: str | None = Field(
        None,
        description="마스킹된 매치값 (secret/pii/credential/internal info). vuln이면 비워둠",
    )
    location: str = Field(..., description="hit 위치 — file path, URL, 또는 'file:<url>:42' 형식")
    preview: str = Field(
        "",
        description=(
            "발견 증거 본문 미리보기 (마스킹). 길이 제한 없음 — 실제 관찰한 필드명/"
            "컬럼/레코드 샘플/화면 텍스트를 필요한 만큼 담아라 (민감값은 마스킹). "
            "짧게 줄이지 말 것."
        ),
    )
    validation: dict[str, Any] | None = Field(
        None,
        description=(
            "선택: credential/secret 검증 결과. URL/host와 id/pw/token 조합이 "
            "같이 확인되면 safe_probe의 credential_reachability 결과를 그대로 넣는다 "
            "(GET 및 로그인-form POST만, 평문 secret 저장 금지)."
        ),
    )


class RiskNarrative(BaseModel):
    """v3.76: 운영팀이 finding 상세에서 읽는 4부 위험내용 (한국어, agent 작성).

    **마스킹 규칙**: 절대 평문 시크릿/토큰/비밀번호/PII 값을 적지 마라. 노출된 것은
    값이 아니라 '유형'(데이터 종류/분류)으로만 서술한다 — 예 'AWS access key'·
    '직원 사번·이름'·'내부 설비 파라미터'. 구체 값이 필요하면 마스킹된 형태만.
    """
    what_is_data: str = Field(
        "",
        description="① 데이터 정체 — 노출된 것이 '무엇'인지 유형/분류로 서술 (평문 값 금지, 마스킹/유형만)",
    )
    how_discovered: str = Field(
        "",
        description="② 발견 방법 — 어떤 경로/도구/관찰로 발견했는지 (인증 없이 접근 가능했는지 포함)",
    )
    exploitation_path: str = Field(
        "",
        description="③ 악용 경로·왜 위험 — 내부 비인가 사용자/탈취 계정/측면이동이 이걸로 무엇을 할 수 있나",
    )
    verification_method: str = Field(
        "",
        description="④ 확인 방법 — 운영팀이 노출/위험을 재현·검증할 구체 절차 (마스킹 유지)",
    )


class EvidenceNote(BaseModel):
    """v3.76: 한 증거 위치(location)에 대한 사람용 해설 — UI per-evidence 렌더용.

    **마스킹 규칙**: sensitive_fields 에는 '필드명/컬럼명/데이터 유형'만 적는다 —
    실제 값(시크릿/PII/비밀번호)을 적지 마라.
    """
    what_this_is: str = Field("", description="이 증거가 무엇인지 한 줄 설명 (유형/정체)")
    sensitive_fields: list[str] = Field(
        default_factory=list,
        description="노출된 민감 필드명/컬럼명/유형만 (값 금지) — 예 ['password_hash','employee_id']",
    )
    context_note: str = Field("", description="이 위치에서 왜 위험한지 부가 맥락 (마스킹 유지)")


class TaskFinding(BaseModel):
    """agent가 submit_finding 으로 제출하는 한 헌트의 최종 보고."""
    # v3.53-17: task_id 는 내부 식별자일 뿐 — 모델이 자주 빠뜨려 validation 실패했음.
    # 안 주면 자동 생성한다 (모델은 hits.location / summary / severity 에만 집중).
    task_id: str = Field(default_factory=lambda: f"task-{uuid4().hex[:8]}")
    # de-domain: 도메인 enum 은 plugin 이 소유 — 코어는 string (readers 전부 string 비교).
    task_type: str = Field("generic", description="이 finding 을 만든 task 의 종류 (plugin 정의)")
    # v3.53-20: target = 이 finding 을 발견할 때 조사 중이던 자산(점검 대상 사이트/호스트/공유).
    # 발견된 hit.location(asset)과 다를 수 있다 — 예: 사이트 A 를 점검하다 그 robots.txt
    # 안에서 내부 호스트 B 참조를 발견하면 target=A, asset=B.
    # 리포트에서 "어느 대상 점검 중 나왔나"(도메인) vs "무엇이 발견됐나"(발견사항)를 구분.
    target: str = Field("", description="점검 대상 — 이 finding 을 발견할 때 조사 중이던 사이트/호스트/공유 (asset 과 다를 수 있음)")
    severity: Severity
    summary: str = Field(
        ...,
        description=(
            "위협 내용 (한국어). **위협모델은 사내(internal)** — 대상은 사내망 전용 자산이다. "
            "'외부 인터넷 노출/외부 공격자' 로 쓰지 마라(틀림). 실제 위협은 **인가받지 않은 "
            "내부 사용자 / 탈취된 사내 계정 / 측면이동(insider)** 이 인증·인가 없이 접근 "
            "가능한가다. '외부에 노출' → '인증/인가 없이 사내망에서 접근 가능' 으로. "
            "**반드시 '어떤 민감자산이 위험한가'를 분류해서 말하라** — "
            "단순 '비인가 접근 가능' 같은 막연한 표현은 금지(위험도가 안 와닿는다). "
            "노출된 것을 다음 분류로 매핑: 개인정보(이름·사번·연락처) / 계정·인증정보"
            "(토큰·세션·로그인) / 기밀 기술정보(설계·공정·장비 데이터) / 경영정보"
            "(매출·단가·계약·고객) / 시스템 장악(DB 직접쿼리·관리기능·코드 실행). "
            "형식: ① 무엇이 인증 없이 노출됐나 ② 그래서 **어떤 분류의 무엇을 탈취/악용** "
            "가능한가(구체적으로) ③ 영향. "
            "예(나쁨): '`/openapi.json` 노출로 비인가 접근 시도 가능'. "
            "예(좋음): '인증 없이 열린 openapi 에 `POST /user/save_message`·`/db/query` 등 "
            "내부 API 전체 노출 → 공격자가 인증 없이 **사용자 메시지(개인정보) 조회·발송**, "
            "**DB 직접 쿼리로 데이터 탈취 및 시스템 장악** 가능.'"
        ),
    )
    asset_count_scanned: int = Field(0, ge=0)
    hits: list[FindingHit] = Field(default_factory=list)
    recommended_actions: list[str] = Field(default_factory=list,
                                           description="자산 owner가 취해야 할 조치")
    # v3.76: agent-writable 4부 위험내용 + 증거 해설 + pivot 해석. 전부 optional →
    # model_dump 로 extra_json 에 자동 적재(DB 마이그 불필요). 못 만드는 항목은 비워둔다
    # (가짜 템플릿 금지). **마스킹**: 평문 시크릿/PII/비밀번호 값을 절대 적지 말고
    # '유형/분류'로만 서술 — 값이 필요하면 마스킹된 형태만.
    risk_narrative: RiskNarrative | None = Field(
        None,
        description=(
            "4부 위험내용(데이터 정체/발견 방법/악용 경로·왜 위험/확인 방법). 한국어. "
            "값 아닌 유형만 — 평문 시크릿/PII 금지, 마스킹 유지. 못 채우는 부분은 비워둠."
        ),
    )
    evidence_notes: dict[str, EvidenceNote] = Field(
        default_factory=dict,
        description=(
            "증거 location → 해설(what_this_is/sensitive_fields[필드명만]/context_note). "
            "sensitive_fields 는 필드명/유형만 — 실제 값(마스킹 안 된 시크릿/PII) 금지."
        ),
    )
    pivot_interpretation: str = Field(
        "",
        description=(
            "pivot probe 결과 해석 — 도달 확인된 내부 표면이 실제로 무엇을 의미/허용하는지. "
            "값 아닌 유형/행위로만 서술(마스킹 유지)."
        ),
    )
