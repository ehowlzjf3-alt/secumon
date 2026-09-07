"""github 스캔 워커가 **계약을 읽고 에이전트를 돈다**.

## 왜 이 테스트가 필요한가

2026-08-26 이전, 이 워커는 껍데기였다. 팬아웃 어댑터가 `task_spec.json` 에
`"skill": "github_scan"`, `"skill_resource": "worker.md"` 를 적어 배달하는데
워커는 봉투를 안 뜯고 `_handle_target()`(정규식 스캔 함수)을 직접 불렀다.

**그래도 아무것도 안 깨졌다.** 스캔은 돌고, 타깃은 닫히고, finding 도 쌓였다 —
다만 `judge_task_finding` 을 건너뛰어 category 판정자(PII 소수부 거부 R1)에
닿지 못했고, `kr_phone` 오탐 3,867건이 그대로 통과했다. 정규식이 `0.0706314374`
(CatBoost 손실값)에서 `0706314374` 를 떼어내면 마스킹이 `070-****-4374` 로
**전화번호 모양을 만들어** 냈고, 아무도 그걸 안 봤다.

그래서 "돈다" 를 결과가 아니라 **배선**으로 검사한다. 결과만 보면 예전 상태도 통과한다.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


def _spec(tmp_path: Path, **overrides: Any) -> Path:
    payload = {
        "task_id": "github-scan-7-org/repo",
        "task_type": "github_scan",
        "skill": "github_scan",
        "skill_resource": "worker.md",
        "charter_ref": "SECOPS-TEST",
        "target": {"id": 7, "repo": "org/repo", "default_branch": "main"},
    }
    payload.update(overrides)
    (tmp_path / "task_spec.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return tmp_path


class _Recorder:
    """run_agent 호출 인자를 잡아둔다."""

    def __init__(self, result: dict[str, Any] | None = None) -> None:
        self.kwargs: dict[str, Any] | None = None
        self.result = result or {
            "reason": "end_turn", "saw_terminal": True, "turns": 4,
            "tokens_in": 100, "tokens_out": 20,
            "terminal_calls": [
                {"name": "github_repo_set_status",
                 "input": {"target_ids": [7], "status": "tasked", "finding_count": 3}},
            ],
        }

    async def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.kwargs = kwargs
        return self.result


@pytest.fixture()
def wired(monkeypatch, tmp_path):
    from service.agents import github_scan_worker as mod
    from service.agents import runtime

    rec = _Recorder()
    monkeypatch.setattr(runtime, "run_agent", rec)
    monkeypatch.setattr(runtime, "_ensure_dotenv", lambda: None)
    monkeypatch.setattr(
        runtime, "load_skill_contract",
        lambda skill, resource=None: f"<<{skill}:{resource}>>")
    monkeypatch.setattr(mod, "_record_quality", lambda **kw: None)
    _spec(tmp_path)
    return mod, rec, tmp_path


def test_worker_runs_the_agent_with_the_worker_contract(wired):
    mod, rec, tmp_path = wired

    rc = mod.main([str(tmp_path)])

    assert rc == 0
    assert rec.kwargs is not None, "run_agent 이 호출되지 않았다 — 워커가 다시 껍데기다"
    assert rec.kwargs["skill_body"] == "<<github_scan:worker.md>>", (
        "task_spec 이 지정한 worker.md 계약을 읽어야 한다"
    )


def test_terminal_tool_is_the_repo_status_tool(wired):
    _, rec, tmp_path = wired
    from service.agents import github_scan_worker as mod

    mod.main([str(tmp_path)])

    assert rec.kwargs["terminal_tools"] == {"github_repo_set_status"}
    assert rec.kwargs["require_terminal_tool"] is True, (
        "종료도구를 안 부르면 claim 이 stale reclaim 까지 묶인다"
    )


def test_findings_go_through_the_judged_submit_path(wired):
    """★ 도구셋에 `github_submit_finding` 이 있어야 판정자에 닿는다.

    스캐너가 `finding_upsert` 로 직접 쓰면 `judge_task_finding` 을 건너뛴다.
    """
    _, rec, tmp_path = wired
    from service.agents import github_scan_worker as mod

    mod.main([str(tmp_path)])

    names = {getattr(t, "name", "") for t in rec.kwargs["tool_classes"]}
    assert "github_submit_finding" in names
    assert "github_repo_set_status" in names
    assert "github_task_scan" in names


def test_budgets_are_explicit_and_outlive_a_stalled_request(wired):
    """예산을 물려받지 않는다 — 엔진 기본(idle 120 / wall 300)은 요청 타임아웃과 같다."""
    _, rec, tmp_path = wired
    from service.agents import github_scan_worker as mod

    mod.main([str(tmp_path)])

    assert rec.kwargs["max_idle_sec"] > 300
    assert rec.kwargs["max_wall_clock_sec"] > 600


def test_agent_failure_fails_closed(monkeypatch, tmp_path):
    """★ 에이전트가 실패하면 실패로 닫는다 — 갈 수 있는 다른 길이 없다."""
    from service.agents import github_scan_worker as mod
    from service.agents import runtime

    async def _boom(**kwargs):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(runtime, "run_agent", _boom)
    monkeypatch.setattr(runtime, "_ensure_dotenv", lambda: None)
    monkeypatch.setattr(runtime, "load_skill_contract", lambda *a, **k: "x")
    monkeypatch.setattr(mod, "_record_quality", lambda **kw: None)
    _spec(tmp_path)

    rc = mod.main([str(tmp_path)])

    assert rc == 1, "에이전트 실패는 실패로 닫는다"
    result = json.loads((tmp_path / "worker_result.json").read_text(encoding="utf-8"))
    assert result["status"] == "error_crash"


def test_incomplete_agent_run_is_not_reported_as_ok(monkeypatch, tmp_path):
    """종료도구를 봤어도 max_turns/aborted 면 완주가 아니다."""
    from service.agents import github_scan_worker as mod
    from service.agents import runtime

    rec = _Recorder({"reason": "max_turns", "saw_terminal": True, "turns": 40})
    monkeypatch.setattr(runtime, "run_agent", rec)
    monkeypatch.setattr(runtime, "_ensure_dotenv", lambda: None)
    monkeypatch.setattr(runtime, "load_skill_contract", lambda *a, **k: "x")
    monkeypatch.setattr(mod, "_record_quality", lambda **kw: None)
    _spec(tmp_path)

    assert mod.main([str(tmp_path)]) == 1


def test_there_is_no_way_to_turn_the_agent_off(monkeypatch, tmp_path):
    """★ kill-switch 를 **없앴다** (2026-08-27).

    `SA_GITHUB_SCAN_AGENT=0` 은 결정론 스캔으로 되돌리는 스위치였다. 요구가 바뀌었다:
    **모든 finding 은 등록 전에 LLM 판정을 타야 한다**(사용자 결정). 결정론 경로는
    정의상 그걸 못 하므로, 스위치가 있으면 언젠가 켜지고 켜진 줄도 모른다.

    실제로 그렇게 됐다 — `github.scan` 플래그가 0인데도 08-25 에 뜬 패스가 1.5일째
    안 끝나며 판정 없는 finding 27,414건을 만들었다.
    """
    import inspect

    from service.agents import github_scan_worker as mod

    assert not hasattr(mod, "_agent_enabled"), "kill-switch 가 되살아났다"
    assert not hasattr(mod, "_run_deterministic_scan"), "결정론 우회로가 되살아났다"

    src = inspect.getsource(mod)
    assert "SA_GITHUB_SCAN_AGENT" not in src.split('"""', 2)[2], (
        "스위치 이름이 코드에 남아 있다 — 주석에서 이유를 적는 것은 괜찮다")

    monkeypatch.setenv("SA_GITHUB_SCAN_AGENT", "0")
    _spec(tmp_path)
    # 환경변수가 있어도 분기가 없다: main 은 에이전트 경로 하나뿐이다.
    assert "_run_agent_scan" in inspect.getsource(mod.main)


def test_queue_default_branch_is_passed_as_unverified(wired):
    """큐의 default_branch 는 `or \"main\"` 폴백 오염값일 수 있다 — 그렇게 말해줘야 한다."""
    _, rec, tmp_path = wired
    from service.agents import github_scan_worker as mod

    mod.main([str(tmp_path)])

    text = rec.kwargs["user_text"]
    assert "org/repo" in text
    assert "unverified" in text, "폴백 오염 가능성을 워커에게 알려야 한다"


def test_missing_spec_is_a_crash_not_a_silent_zero(tmp_path):
    from service.agents import github_scan_worker as mod

    assert mod.main([str(tmp_path)]) == 1
    result = json.loads((tmp_path / "worker_result.json").read_text(encoding="utf-8"))
    assert result["status"] == "error_crash"
