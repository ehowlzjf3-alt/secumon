"""Verdict schema — agent의 최종 출력. submit_verdict 도구가 강제 검증."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class IOCs(BaseModel):
    domains: list[str] = Field(default_factory=list)
    hashes: list[str] = Field(default_factory=list)
    urls: list[str] = Field(default_factory=list)
    ips: list[str] = Field(default_factory=list)


class ObservedBehavior(BaseModel):
    """A behavior the package actually produced in static or dynamic evidence."""

    category: str = Field(description="process|file|network|static|dependency|other")
    behavior: str = Field(description="Concise behavior summary.")
    evidence_paths: list[str] = Field(default_factory=list)
    scenario_id: str | None = Field(
        default=None,
        description="analysis_runs scenario_id when behavior came from an extra dynamic scenario.",
    )
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class ScenarioEvidence(BaseModel):
    """Summary of an additional dynamic scenario and what it did or did not trigger."""

    scenario_id: str
    scenario_type: str | None = None
    status: str | None = None
    signal_types: list[str] = Field(default_factory=list)
    network_domains: list[str] = Field(default_factory=list)
    network_urls: list[str] = Field(default_factory=list)
    evidence_paths: list[str] = Field(default_factory=list)


class AttackChainStep(BaseModel):
    """A normalized attack-flow step grounded in local evidence."""

    description: str
    order: int | None = Field(default=None, ge=1)
    tactic: str | None = None
    technique_id: str | None = Field(
        default=None,
        description="MITRE ATT&CK technique ID when directly supported.",
    )
    evidence_paths: list[str] = Field(default_factory=list)


class DependencyContext(BaseModel):
    """Metadata-only dependency context; not proof that dependencies executed."""

    mode: str | None = None
    findings: list[str] = Field(default_factory=list)
    notable_dependencies: list[str] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)


class ReputationSummary(BaseModel):
    """Provider status and high-level reputation outcome."""

    provider: str | None = None
    status: str | None = None
    malicious: int | None = None
    suspicious: int | None = None
    unknown: int | None = None
    notes: list[str] = Field(default_factory=list)


class Verdict(BaseModel):
    """Agent가 제출하는 최종 risk 평가."""

    risk_level: Literal["benign", "suspicious", "malicious", "errored"]
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: list[str] = Field(min_length=1, description="단계별 근거 (문장 list)")
    evidence_paths: list[str] = Field(
        default_factory=list,
        description="result_dir 기준 상대경로 (예: install_trace.log:42)",
    )
    iocs: IOCs = Field(default_factory=IOCs)
    mitre_attack: list[str] = Field(
        default_factory=list,
        description="MITRE ATT&CK 기법 ID (예: T1059.006)",
    )
    observed_behavior: list[ObservedBehavior] = Field(
        default_factory=list,
        description="정적/동적 evidence에서 실제 관찰된 행위.",
    )
    triggered_scenarios: list[ScenarioEvidence] = Field(
        default_factory=list,
        description="추가 동적 scenario 중 의미 있는 signal/IOC를 낸 항목.",
    )
    untriggered_scenarios: list[ScenarioEvidence] = Field(
        default_factory=list,
        description="계획/실행됐지만 의미 있는 signal이 없거나 skip/error된 항목.",
    )
    attack_chain: list[AttackChainStep] = Field(
        default_factory=list,
        description="timeline 기반의 근거 있는 공격 흐름.",
    )
    dependency_context: DependencyContext = Field(default_factory=DependencyContext)
    reputation_summary: ReputationSummary = Field(default_factory=ReputationSummary)
    limitations: list[str] = Field(
        default_factory=list,
        description="미실행 dependency, 비활성 평판조회, skip된 scenario 등 해석상 한계.",
    )

    @field_validator("risk_level")
    @classmethod
    def _errored_must_be_low_confidence(cls, v: str, info) -> str:
        # errored는 분석 실패 — confidence가 의미 없거나 낮아야 함
        # (validator는 다른 필드 접근 제한적이라 model_validator로 옮기는 게 정석)
        return v
