from __future__ import annotations

import asyncio

import pytest

from secu_agent.agent.approval_policy import (
    SmartApprovalPolicy,
    deterministic_smart_approval,
    normalize_approval_mode,
    parse_smart_approval_text,
)
from secu_agent.agent.eval.scripted_llm import ScriptedLLMClient, ScriptedTurn
from secu_agent.agent.tools.approval import ApprovalRequest


def _request(tool_name: str, tool_input: dict[str, object]) -> ApprovalRequest:
    return ApprovalRequest(
        invocation_id="approval-1",
        tool_name=tool_name,
        tool_input=tool_input,
        reason="destructive tool",
    )


def _run(coro):
    return asyncio.run(coro)


def test_approval_mode_defaults_to_auto_and_invalid_is_manual():
    assert normalize_approval_mode(None) == "auto"
    assert normalize_approval_mode("") == "auto"
    assert normalize_approval_mode("ask") == "manual"
    assert normalize_approval_mode("smart") == "smart"
    assert normalize_approval_mode("definitely-not-a-mode") == "manual"


def test_deterministic_smart_approval_denies_high_risk_shell():
    outcome = deterministic_smart_approval(
        _request("bash_evidence", {"command": "rm -rf /"}),
    )

    assert outcome is not None
    assert outcome.source == "deterministic"
    assert outcome.decision.behavior == "deny"
    assert "high-risk" in outcome.decision.reason


def test_deterministic_smart_approval_allows_read_only_evidence_command():
    outcome = deterministic_smart_approval(
        _request("bash_evidence", {"command": "rg password ."}),
    )

    assert outcome is not None
    assert outcome.source == "deterministic"
    assert outcome.decision.behavior == "allow"


def test_smart_approval_uses_llm_for_ambiguous_request():
    policy = SmartApprovalPolicy(
        client_factory=lambda: ScriptedLLMClient([
            ScriptedTurn(text='{"decision":"allow","reason":"bounded test action"}'),
        ]),
    )

    outcome = _run(policy.resolve(_request("approval_probe", {"command": "inspect"})))

    assert outcome.source == "llm"
    assert outcome.decision.behavior == "allow"
    assert outcome.decision.reason == "bounded test action"


def test_smart_approval_fails_closed_on_invalid_llm_output():
    policy = SmartApprovalPolicy(
        client_factory=lambda: ScriptedLLMClient([ScriptedTurn(text="not json")]),
    )

    outcome = _run(policy.resolve(_request("approval_probe", {"command": "inspect"})))

    assert outcome.source == "fallback"
    assert outcome.decision.behavior == "deny"


def test_parse_smart_approval_text_accepts_fenced_json():
    decision = parse_smart_approval_text(
        '```json\n{"decision":"deny","reason":"outside scope"}\n```',
    )

    assert decision.behavior == "deny"
    assert decision.reason == "outside scope"


# ── audit #4: read-only 셸 분류기 soundness ─────────────────────────────

def _deterministic(cmd: str):
    return deterministic_smart_approval(_request("bash_evidence", {"command": cmd}))


@pytest.mark.parametrize("cmd", [
    "find . -delete",                    # 삭제 액션
    "find / -exec rm -rf {} +",          # 임의 명령 실행 (세미콜론 없음 → find 가드가 잡음)
    "sed -i 's/a/b/' notes.txt",         # in-place 쓰기
    "awk 'BEGIN{system(\"id\")}' f",     # awk system() 실행
    "cat a.txt; rm -rf ./localdir",      # 셸 체이닝
    "grep foo f | sh",                   # 파이프 to sh
    "sort -o /etc/hosts in.txt",         # sort -o 파일 쓰기
])
def test_deterministic_does_not_auto_allow_unsound_readonly(cmd):
    outcome = _deterministic(cmd)
    # 결정론 auto-allow 로 새면 안 된다 — None(judge 위임) 또는 deny 여야 함.
    assert outcome is None or outcome.decision.behavior == "deny"


@pytest.mark.parametrize("cmd", [
    "rg password .",
    "grep -rn secret src",
    "cat config.yaml",
    "head -50 app.log",
    "find . -name '*.py' -type f",       # 읽기 전용 find 는 여전히 허용
    "sort results.txt",
    "wc -l data.csv",
])
def test_deterministic_still_allows_genuine_readonly(cmd):
    outcome = _deterministic(cmd)
    assert outcome is not None
    assert outcome.source == "deterministic"
    assert outcome.decision.behavior == "allow"


def test_operator_can_extend_readonly_exes(monkeypatch):
    monkeypatch.delenv("SA_SMART_READONLY_EXES", raising=False)
    assert _deterministic("mytool --scan .") is None  # 기본 미허용 → judge
    monkeypatch.setenv("SA_SMART_READONLY_EXES", "mytool, other")
    outcome = _deterministic("mytool --scan .")
    assert outcome is not None and outcome.decision.behavior == "allow"


def test_operator_optin_still_blocks_shell_chaining(monkeypatch):
    monkeypatch.setenv("SA_SMART_READONLY_EXES", "mytool")
    # opt-in 한 exe 라도 셸 체이닝/치환이 붙으면 결정론 auto-allow 안 함.
    outcome = _deterministic("mytool foo; rm -rf ./x")
    assert outcome is None or outcome.decision.behavior != "allow"
