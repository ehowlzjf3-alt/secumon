from __future__ import annotations


def test_confluence_pipeline_runner_consumes_only_confluence_control_flags(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_RECHECK,
        COMPONENT_CONFLUENCE_REPORT,
        COMPONENT_CONFLUENCE_SEARCH_TASK,
        COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
        COMPONENT_CONFLUENCE_SPACE_TASK,
        COMPONENT_CONFLUENCE_SSO_DISCOVERY,
        COMPONENT_CONFLUENCE_SSO_TASK,
    )
    from domains.services.github.application.contracts import COMPONENT_GITHUB_SCAN
    from service import state_domain as sd
    from service.agents import confluence_pipeline_runner as runner

    called: list[tuple[str, str | None, int | None]] = []
    monkeypatch.setenv("CONFLUENCE_SSO_DISCOVERY_MAX_URLS", "11")
    monkeypatch.setattr(runner, "load_runtime_env", lambda load_plugins=True: None)
    monkeypatch.setattr(
        runner,
        "run_space_discovery_pass",
        lambda max_spaces=None, space_type=None: (
            called.append((COMPONENT_CONFLUENCE_SPACE_DISCOVERY, space_type, max_spaces))
            or {"ok": "space_discovery"}
        ),
    )
    monkeypatch.setattr(
        runner,
        "run_sso_discovery_pass",
        lambda earliest=None, latest=None, day_bucket=None, max_urls=None: (
            called.append((COMPONENT_CONFLUENCE_SSO_DISCOVERY, None, max_urls))
            or {"ok": "sso_discovery"}
        ),
    )
    monkeypatch.setattr(
        runner,
        "_run_plan_pass",
        lambda *, component, plan_name, max_targets=None: (
            called.append((component, plan_name, max_targets)) or {"ok": component}
        ),
    )
    for component in (
        COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
        COMPONENT_CONFLUENCE_SPACE_TASK,
        COMPONENT_CONFLUENCE_SEARCH_TASK,
        COMPONENT_CONFLUENCE_SSO_DISCOVERY,
        COMPONENT_CONFLUENCE_SSO_TASK,
        COMPONENT_CONFLUENCE_REPORT,
        COMPONENT_CONFLUENCE_RECHECK,
    ):
        sd.control_flag_set(component, enabled=False, run_now=False)
    sd.control_flag_set("task", enabled=True, run_now=True)
    # ★ 메일 큐(리포트·재검증)는 2026-08-31 부터 **공용 러너**가 돈다
    #   (`service/agents/thread_pipeline_runner.py`). 켜져 있고 지금 돌라고 해도
    #   이 러너는 손대면 안 된다 — 여기서 다시 돌리면 두 러너가 같은 스레드를 잡는다.
    for mail_component in (COMPONENT_CONFLUENCE_REPORT, COMPONENT_CONFLUENCE_RECHECK):
        sd.control_flag_set(mail_component, enabled=True, run_now=True)
    sd.control_flag_set(COMPONENT_GITHUB_SCAN, enabled=False, run_now=True)
    sd.control_flag_set(COMPONENT_CONFLUENCE_SSO_DISCOVERY, enabled=False, run_now=True)

    result = runner.run_once()

    assert called == [(COMPONENT_CONFLUENCE_SSO_DISCOVERY, None, 11)]
    assert result == {COMPONENT_CONFLUENCE_SSO_DISCOVERY: {"ok": "sso_discovery"}}
    assert sd.control_flag_get(COMPONENT_CONFLUENCE_SSO_DISCOVERY)["run_now"] == 0
    assert sd.control_flag_get(COMPONENT_GITHUB_SCAN)["run_now"] == 1
    assert sd.control_flag_get("task")["run_now"] == 1
    # 켜 뒀는데도 소비되지 않았다 = 이 러너의 손이 안 닿았다.
    assert sd.control_flag_get(COMPONENT_CONFLUENCE_REPORT)["run_now"] == 1
    assert sd.control_flag_get(COMPONENT_CONFLUENCE_RECHECK)["run_now"] == 1


def test_confluence_runner_keeps_api_search_and_detail_task_before_sso(
    tmp_db,
    monkeypatch,
) -> None:
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_RECHECK,
        COMPONENT_CONFLUENCE_REPORT,
        COMPONENT_CONFLUENCE_SEARCH_TASK,
        COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
        COMPONENT_CONFLUENCE_SPACE_TASK,
        COMPONENT_CONFLUENCE_SSO_DISCOVERY,
        COMPONENT_CONFLUENCE_SSO_TASK,
    )
    from service.agents import confluence_pipeline_runner as runner

    order: list[str] = []
    monkeypatch.setattr(runner, "load_runtime_env", lambda load_plugins=True: None)
    monkeypatch.setattr(runner, "run_search_keyword_sync", lambda: {"ok": "search_seed"})
    monkeypatch.setattr(
        runner,
        "run_space_discovery_pass",
        lambda max_spaces=None, space_type=None: order.append(COMPONENT_CONFLUENCE_SPACE_DISCOVERY)
        or {"ok": "space_discovery"},
    )
    monkeypatch.setattr(
        runner,
        "run_sso_discovery_pass",
        lambda earliest=None, latest=None, day_bucket=None, max_urls=None: (
            order.append(COMPONENT_CONFLUENCE_SSO_DISCOVERY) or {"ok": "sso_discovery"}
        ),
    )
    monkeypatch.setattr(
        runner,
        "_run_plan_pass",
        lambda *, component, plan_name, max_targets=None: order.append(component)
        or {"ok": component},
    )

    result = runner.run_once()

    # space_task·search_task 는 빠졌다 — 평면 레인 은퇴(2026-08-28).
    # 리포트·재검증도 빠졌다 — 공용 러너로 이관(2026-08-31).
    # 남은 순서 불변식(발견 → sso 발견 → sso 태스크)은 그대로다.
    assert order == [
        COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
        COMPONENT_CONFLUENCE_SSO_DISCOVERY,
        COMPONENT_CONFLUENCE_SSO_TASK,
    ]
    assert COMPONENT_CONFLUENCE_REPORT not in order
    assert COMPONENT_CONFLUENCE_RECHECK not in order
    assert COMPONENT_CONFLUENCE_SPACE_TASK not in order
    assert COMPONENT_CONFLUENCE_SEARCH_TASK not in order
    assert list(result) == order


def test_space_discovery_pass_seeds_keywords_first(tmp_db, monkeypatch) -> None:
    """★ 키워드 시드는 `confluence_search_target` 큐의 **유일한 자동 생산자**다.

    `confluence_search_target_upsert` 의 비-테스트 호출부는 `run_search_keyword_sync`
    하나뿐이고, 그걸 자동으로 부르는 곳은 파이프라인 러너뿐이다
    (`confluence_discovery_agent --search-sync` 는 수동 CLI 라 자동 경로가 아니다).

    ⚠️ 원래는 평면 search_task 레인 머리에 붙어 있었다. 2026-08-28 에 그 레인을 은퇴시키면서
       시드까지 같이 지웠다면 큐가 안 채워지고 `confluence_search.lead` 가 영원히 idle 이
       됐다 — space/sso 와 달리 search 에는 전용 discovery 컴포넌트가 없기 때문이다.
       그래서 살아 있는 space discovery 스텝 머리로 옮겼다. 이 테스트가 그 자리를 고정한다.
    """
    from service.agents import confluence_pipeline_runner as runner

    calls: list[str] = []
    monkeypatch.setattr(runner, "run_search_keyword_sync", lambda: calls.append("seed") or {"total": 15})
    monkeypatch.setattr(
        runner, "run_space_discovery_pass",
        lambda **kw: calls.append("space_discovery") or {"ok": "space"},
    )

    result = runner._run_space_discovery_pass(max_spaces=3, space_type=None)

    assert calls == ["seed", "space_discovery"], "시드가 discovery 보다 먼저여야 한다"
    assert result == {"ok": "space"}


def test_space_discovery_pass_seed_failure_still_runs_discovery(tmp_db, monkeypatch) -> None:
    """시드 실패는 best-effort — 뒤따르는 space discovery 를 막지 않는다."""
    from service.agents import confluence_pipeline_runner as runner

    def _boom() -> dict:
        raise RuntimeError("seed boom")

    ran: list[str] = []
    monkeypatch.setattr(runner, "run_search_keyword_sync", _boom)
    monkeypatch.setattr(runner, "run_space_discovery_pass", lambda **kw: ran.append("space") or {"ok": "space"})

    assert runner._run_space_discovery_pass() == {"ok": "space"}
    assert ran == ["space"]


def test_keyword_seed_is_wired_into_a_live_step(tmp_db, monkeypatch) -> None:
    """★ 시드가 **실제로 도는 스텝**에 물려 있는지 — 함수만 있고 호출부 0 이면 큐가 굶는다.

    `run_once` 를 통째로 돌려서, 시드가 파이프라인 경로에서 실제로 불리는지 본다.
    (레인 은퇴 때 이 배선이 조용히 빠지는 것이 이 파일이 막는 사고다.)
    """
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
    )
    from service import state_domain as sd
    from service.agents import confluence_pipeline_runner as runner

    seeded: list[str] = []
    monkeypatch.setattr(runner, "load_runtime_env", lambda load_plugins=True: None)
    monkeypatch.setattr(runner, "run_search_keyword_sync", lambda: seeded.append("seed") or {"total": 15})
    monkeypatch.setattr(runner, "run_space_discovery_pass", lambda **kw: {"ok": "space"})
    for name in ("_run_plan_pass",):
        monkeypatch.setattr(runner, name, lambda **kw: {"ok": kw.get("component")})
    for name in ("run_sso_discovery_pass",):
        monkeypatch.setattr(runner, name, lambda **kw: {"ok": name})

    # space discovery 만 due 로 만든다.
    for component in runner.DEFAULT_INTERVALS:
        sd.control_flag_set(component, enabled=(component == COMPONENT_CONFLUENCE_SPACE_DISCOVERY),
                            run_now=(component == COMPONENT_CONFLUENCE_SPACE_DISCOVERY))

    runner.run_once()

    assert seeded == ["seed"], "space discovery 스텝이 돌았는데 키워드 시드가 안 불렸다"


def test_confluence_runner_sso_plan_pass_records_taskplan_summary(
    tmp_db,
    monkeypatch,
) -> None:
    """★ `_run_plan_pass`·`_cap_single_phase_plan` 의 **유일한 실제 실행 테스트**다.

    원래 은퇴한 space_task 플랜에 걸려 있었다. 2026-08-28 에 space/search 레인을 지우면서
    이 테스트도 같이 지웠으면, **살아남는 공용 기계가 테스트 0** 이 됐을 것이다 —
    두 함수는 `confluence.sso_task` 스텝이 계속 쓴다(github 은 sso 가 유일 사용자여서
    함께 지웠지만, confluence 의 sso 레인은 은퇴 대상이 아니다).

    그래서 지우지 않고 **살아 있는 sso 플랜으로 재조준**했다. 검사하는 것은 그대로다:
    `max_targets` 캡이 phase 에 실제로 반영되는가(`observed_max_targets == [5]`),
    PhaseCompleted/PlanCompleted 집계가 결과로 나오는가.
    """
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_SSO_TASK,
        CONFLUENCE_SSO_TASK_PLAN,
        PHASE_CONFLUENCE_SSO_TASK,
    )
    from service import state_domain as sd
    from service.agents import confluence_pipeline_runner as runner
    from secu_agent.agent.events import PhaseCompleted, PhaseStarted, PlanCompleted
    from secu_agent.agent.fanout import FanoutReport
    import secu_agent.agent.task_plan as hp
    from secu_agent.agent.task_plan import TaskPlan, Phase, PlanResult

    base_plan = TaskPlan(
        name=CONFLUENCE_SSO_TASK_PLAN,
        phases=(Phase(name=PHASE_CONFLUENCE_SSO_TASK, adapter="fake.sso", k=2),),
    )
    observed_max_targets: list[int | None] = []

    async def fake_run_plan(plan):
        observed_max_targets.append(plan.phases[0].max_targets)
        yield PhaseStarted(
            plan=plan.name,
            phase=PHASE_CONFLUENCE_SSO_TASK,
            adapter="fake.sso",
            k=2,
            canary=False,
        )
        report = FanoutReport(
            adapter="fake.sso",
            claimed=2,
            succeeded=1,
            failed=1,
            findings_count=3,
        )
        yield PhaseCompleted(plan=plan.name, phase=PHASE_CONFLUENCE_SSO_TASK, report=report)
        result = PlanResult(plan_name=plan.name)
        result.add(PHASE_CONFLUENCE_SSO_TASK, report)
        yield PlanCompleted(
            plan=plan.name,
            result=result,
            aborted=False,
            cancelled=False,
            reason="exhausted",
        )

    monkeypatch.setattr(hp, "get_task_plan", lambda name: base_plan if name == CONFLUENCE_SSO_TASK_PLAN else None)
    monkeypatch.setattr(hp, "run_plan", fake_run_plan)

    result = runner._run_plan_pass(
        component=COMPONENT_CONFLUENCE_SSO_TASK,
        plan_name=CONFLUENCE_SSO_TASK_PLAN,
        max_targets=5,
    )

    assert observed_max_targets == [5]
    assert result["claimed"] == 2
    assert result["succeeded"] == 1
    assert result["failed"] == 1
    assert result["findings"] == 3
    latest = sd.pipeline_runs_recent(COMPONENT_CONFLUENCE_SSO_TASK, limit=1)[0]
    assert latest["status"] == "ok"
    assert "claimed=2 ok=1 fail=1 findings=3" in latest["detail"]
