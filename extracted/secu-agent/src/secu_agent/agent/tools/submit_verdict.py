"""submit_verdict — agent의 최종 출력. schema 검증 후 verdict.json 저장."""
from __future__ import annotations

import json
from typing import ClassVar, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator

from secu_agent.agent.schema.verdict import (
    AttackChainStep,
    DependencyContext,
    ObservedBehavior,
    ReputationSummary,
    ScenarioEvidence,
    Verdict,
)
# 약모델 arg 보정 헬퍼 — submit_finding 과 공유하려 _arg_coercion 으로 승격
# (구현·계약 동일). 이 모듈 네임스페이스에도 종전 이름으로 남는다(back-compat).
from secu_agent.agent.tools._arg_coercion import (
    _coerce_json_container,
    _coerce_str_list,
)
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess

_ACTIVE_SCENARIO_SIGNALS = {
    "external_dns_lookup",
    "shell_spawn_from_lang",
    "network_connect",
    "http_request",
}
_ACTIVE_BEHAVIOR_CATEGORIES = {"network", "process"}


class IOCsInput(BaseModel):
    domains: list[str] = Field(default_factory=list)
    hashes: list[str] = Field(default_factory=list)
    urls: list[str] = Field(default_factory=list)
    ips: list[str] = Field(default_factory=list)


class SubmitVerdictInput(BaseModel):
    risk_level: Literal["benign", "suspicious", "malicious", "errored"]
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: list[str] = Field(
        min_length=1,
        description="단계별 판정 근거 (한국어로 작성. 파일경로/시그널명/도메인/해시/MITRE ID는 원문 유지).",
    )
    evidence_paths: list[str] = Field(
        default_factory=list,
        description="참조한 파일 (result_dir 기준 상대경로, 'path:line' 형식 가능)",
    )
    iocs: IOCsInput = Field(default_factory=IOCsInput)
    mitre_attack: list[str] = Field(
        default_factory=list,
        max_length=5,
        description=(
            "핵심 MITRE ATT&CK 기법 ID, 3~5개로 압축. "
            "각 ID는 evidence_paths의 한 항목에 의해 직접 뒷받침되어야 한다."
        ),
    )
    observed_behavior: list[ObservedBehavior] = Field(
        default_factory=list,
        description="실제 evidence에서 관찰된 행위. 정적 추론과 동적 관찰을 구분해 적는다.",
    )
    triggered_scenarios: list[ScenarioEvidence] = Field(
        default_factory=list,
        description="추가 동적 scenario 중 signal/IOC가 발생한 항목.",
    )
    untriggered_scenarios: list[ScenarioEvidence] = Field(
        default_factory=list,
        description="실행됐지만 무의미했거나 skip/error된 추가 scenario.",
    )
    attack_chain: list[AttackChainStep] = Field(
        default_factory=list,
        description="timeline 기준의 근거 있는 attack-flow 단계.",
    )
    dependency_context: DependencyContext = Field(
        default_factory=DependencyContext,
        description="metadata-only dependency 요약. dependency 실행 증거와 혼동하지 않는다.",
    )
    reputation_summary: ReputationSummary = Field(
        default_factory=ReputationSummary,
        description="GTI 등 평판 조회 상태와 결과 요약. not_configured는 benign 근거가 아니다.",
    )
    limitations: list[str] = Field(
        default_factory=list,
        description="분석 한계, 비활성 평판조회, 미실행 분기, 미설치 dependency 등.",
    )

    # list[str] 필드: 파싱 불가여도 단일 원소로 감싸 절대 검증 실패시키지 않는다.
    _coerce_str_lists = field_validator(
        "reasoning", "evidence_paths", "mitre_attack", "limitations",
        mode="before",
    )(staticmethod(_coerce_str_list))

    # list[obj]/obj 필드: 문자열화된 JSON이면 복원, 아니면 그대로(검증은 pydantic).
    _coerce_containers = field_validator(
        "iocs", "observed_behavior", "triggered_scenarios",
        "untriggered_scenarios", "attack_chain", "dependency_context",
        "reputation_summary",
        mode="before",
    )(staticmethod(_coerce_json_container))


def _benign_conflict_reasons(verdict: Verdict) -> list[str]:
    if verdict.risk_level != "benign":
        return []

    reasons: list[str] = []
    if verdict.iocs.domains or verdict.iocs.urls or verdict.iocs.ips:
        reasons.append("benign 판정이 IOC(domain/url/ip)와 충돌합니다")

    for scenario in verdict.triggered_scenarios:
        signal_types = set(scenario.signal_types)
        if scenario.network_domains or scenario.network_urls or (signal_types & _ACTIVE_SCENARIO_SIGNALS):
            reasons.append(
                "benign 판정이 active triggered_scenarios "
                f"({scenario.scenario_id})와 충돌합니다"
            )

    for behavior in verdict.observed_behavior:
        if behavior.scenario_id and behavior.category in _ACTIVE_BEHAVIOR_CATEGORIES:
            reasons.append(
                "benign 판정이 scenario 기반 observed_behavior "
                f"({behavior.category}: {behavior.scenario_id})와 충돌합니다"
            )

    return reasons


class SubmitVerdictTool(Tool[SubmitVerdictInput]):
    name: ClassVar[str] = "submit_verdict"
    description: ClassVar[str] = (
        "최종 판정을 제출한다. 이 도구가 성공 호출되면 agent 종료.\n"
        "Usage: 모든 의심 시그널 검증 후 한 번 호출. 스키마 위반 시 ToolError → 다시 호출 가능.\n"
        "When to use: 분석 마치고 결론 낼 때만. 중도 abort는 risk_level='errored'.\n"
        "reasoning/evidence_paths와 함께 observed_behavior, scenarios, attack_chain, "
        "dependency_context, reputation_summary, limitations를 구조화한다."
    )
    input_model: ClassVar[type[BaseModel]] = SubmitVerdictInput
    search_hint: ClassVar[str] = "submit verdict finalize result"
    is_read_only: ClassVar[bool] = False

    async def execute(
        self, validated_input: SubmitVerdictInput, context: ToolContext,
    ) -> ToolResult:
        try:
            verdict = Verdict.model_validate(validated_input.model_dump())
        except ValidationError as e:
            return ToolError(
                kind="validation",
                message=f"verdict schema 위반:\n{e}\n\n다시 시도하세요.",
            )

        conflicts = _benign_conflict_reasons(verdict)
        if conflicts:
            return ToolError(
                kind="validation",
                message=(
                    "verdict consistency 위반:\n"
                    + "\n".join(f"- {reason}" for reason in conflicts)
                    + "\n\n활성 scenario에서 네트워크/프로세스/IOC가 관찰됐다면 "
                    "risk_level을 suspicious 또는 malicious로 재검토하세요."
                ),
            )

        out_path = context.evidence_dir / "verdict.json"
        out_path.write_text(
            json.dumps(verdict.model_dump(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

        return ToolSuccess(
            content=(
                f"verdict 저장됨: {out_path}\n"
                f"risk_level={verdict.risk_level}, confidence={verdict.confidence}\n"
                "agent 종료."
            )
        )
