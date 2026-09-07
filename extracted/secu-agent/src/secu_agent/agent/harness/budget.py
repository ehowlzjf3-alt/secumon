"""Agent 예산/제한 정의."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AgentBudget:
    """분석 1회분 hard limit. 초과 시 즉시 abort + errored verdict."""

    max_turns: int = 60
    max_tokens_total: int = 130_000  # 100K input + 30K output
    max_wall_clock_sec: int = 300    # 5분
    max_idle_sec: int = 120          # no observable progress
    idle_check_interval_sec: float = 1.0
    max_disk_mb: int = 100           # evidence_dir 누적
    max_tool_results_size: int = 10 * 1024 * 1024  # 10MB / tool call


@dataclass(frozen=True, slots=True)
class AgentLimits:
    """도구별 rate limit + allowlist."""

    web_fetch_per_turn: int = 3
    bash_per_turn: int = 5

    web_fetch_allowlist: tuple[str, ...] = (
        "pypi.org",
        "files.pythonhosted.org",
        "registry.npmjs.org",
        "pypistats.org",
        # 사내 GTI는 운영 단계에서 추가
    )
    bash_allowlist: tuple[str, ...] = (
        # super-narrow — 정적 분석에 필요한 것만
        "head", "tail", "file", "wc", "sha256sum", "strings", "od",
    )

    # bash 자체 제외 권장 (default), 필요 시 운영팀이 enable
    bash_enabled: bool = False


class BudgetExceeded(Exception):
    """예산 초과 — agent 즉시 종료 신호."""

    def __init__(self, kind: str, detail: str = ""):
        self.kind = kind
        self.detail = detail
        super().__init__(f"budget exceeded: {kind} {detail}".strip())
