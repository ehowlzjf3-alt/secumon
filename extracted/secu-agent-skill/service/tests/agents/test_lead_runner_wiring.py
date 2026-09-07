"""리드 러너 배선 — 등록만 돼 있던 층에 심장을 달았다 (2026-08-26).

## 여기서 막는 것

리드 층은 2026-08-21 에 완성됐는데 **기동하는 코드가 없었다.** 그걸 붙이면서 새로
생긴 위험은 "안 도는 것" 이 아니라 **"의도치 않게 도는 것"** 이다:

1. `state.control_flag_get()` 은 없는 행을 **`enabled=1` 로 자동 생성**한다
   (`state_domain.py:6196`). 리드 플래그를 그냥 조회하면 5개가 라이브 큐에서 켜진다.
2. 리드는 `list_targets` 로 큐를 보되 **claim 을 걸지 않는다.** 평면 워커와 동시에
   켜지면 같은 타깃을 둘이 보고, 늦게 닫는 쪽이 이긴다 — 에러 없이 조용히 틀린다.
3. 서브프로세스 rc 로 성공을 판정하면 안 된다. 리드가 큐를 안 닫고 끝나도 rc 는
   계약이 정하고(`_on_no_submit` → 3), 반대로 죽어도 0 이 나올 수 있다.
"""
from __future__ import annotations

import json

import pytest

from service.agents import lead_agent, lead_pipeline_runner


# ── ① 플래그는 켜진 채로 태어나면 안 된다 ────────────────────────────────

def test_every_lead_declares_the_flat_component_it_retired():
    """리드마다 '자기가 가져간 평면 컴포넌트'가 선언돼 있어야 한다.

    빠지면 그 평면 패스가 계속 돌아 리드가 보기로 한 타깃을 가로챈다.
    """
    for domain, pair in lead_agent._LEADS.items():
        component, retired_flat = pair
        assert component.endswith(".lead"), f"{domain}: 컴포넌트 이름 규칙 위반"
        assert retired_flat, f"{domain}: 은퇴 평면 컴포넌트가 비어 있다"


def test_seeding_inserts_flags_disabled(monkeypatch):
    """★ 없는 리드 플래그는 **off 로** 심어야 한다.

    `control_flag_get` 을 먼저 부르면 enabled=1 로 태어난다. 그래서 seeding 은
    조회 전에, 직접 INSERT 로 한다.
    """
    inserted: list[tuple] = []

    class _Conn:
        def execute(self, sql, args=()):
            if sql.lstrip().upper().startswith("SELECT"):
                return _Cur(None)
            inserted.append((sql, args))
            return _Cur(None)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class _Cur:
        def __init__(self, row):
            self._row = row

        def fetchone(self):
            return self._row

    import service.state_domain as state

    monkeypatch.setattr(state, "connect", lambda *a, **k: _Conn())
    seeded = lead_pipeline_runner.ensure_flags_default_off()

    assert set(seeded) == {c for c, _ in lead_agent._LEADS.values()}
    for sql, args in inserted:
        assert "INSERT INTO control_flag" in sql
        # enabled 자리에 리터럴 0 이 박혀 있어야 한다.
        assert "enabled, run_now" in sql and "VALUES (?, 0, 0," in sql, (
            f"리드 플래그가 off 로 심어지지 않는다: {sql!r}")


def test_seeding_never_touches_an_existing_flag(monkeypatch):
    """사람이 켜 둔 값을 되돌리지 않는다 — 심는 것과 끄는 것은 다르다."""
    writes: list[str] = []

    class _Cur:
        def fetchone(self):
            return {"component": "있음"}

    class _Conn:
        def execute(self, sql, args=()):
            if not sql.lstrip().upper().startswith("SELECT"):
                writes.append(sql)
            return _Cur()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    import service.state_domain as state

    monkeypatch.setattr(state, "connect", lambda *a, **k: _Conn())
    assert lead_pipeline_runner.ensure_flags_default_off() == []
    assert writes == [], "이미 있는 플래그에 쓰기가 일어났다"


# ── ② 시작점은 리드다 — 평면 태스크 레인은 은퇴했다 ──────────────────────

@pytest.mark.parametrize("component", sorted(lead_agent._RETIRED_FLAT))
def test_every_flat_task_component_is_retired(component, monkeypatch):
    """★ 태스크 큐의 진입점은 리드 하나다.

    검토원과 평면 워커는 **같은 워커**다(같은 스킬·도구셋). 달랐던 건 누가 띄우느냐
    뿐이고, 러너가 미리 claim 해서 워커를 뿌리면 리드가 보기로 한 타깃을 가로챈다.
    """
    import service.state_domain as state

    monkeypatch.setattr(state, "heartbeat_upsert", lambda *a, **k: None)
    got = lead_agent.retired_flat_pass(component)
    assert got is not None and got["status"] == "retired"
    assert got["lead_component"].endswith(".lead")


@pytest.mark.parametrize("component", [
    "github.discovery", "github.report", "github.recheck",
    "confluence.report", "confluence.recheck", "mail", "reply_verify",
])
def test_non_task_lanes_are_untouched(component, monkeypatch):
    """★ 은퇴한 것은 **태스크 레인뿐**이다.

    discovery·report·recheck·mail 은 타깃 큐가 아니라 스레드/메일 큐라 "어디를 볼지
    정한다" 가 없다 — 리드로 대체되지 않는다. 여기가 넓어지면 파이프라인이 통째로 선다.
    """
    import service.state_domain as state

    monkeypatch.setattr(state, "heartbeat_upsert", lambda *a, **k: None)
    assert lead_agent.retired_flat_pass(component) is None


def test_retirement_is_not_silent(monkeypatch):
    """★ 조용히 멈추면 러너가 죽은 것으로 보인다 — heartbeat 로 이유를 남긴다."""
    beats: list = []
    import service.state_domain as state

    monkeypatch.setattr(state, "heartbeat_upsert",
                        lambda c, **k: beats.append((c, k.get("phase"), k.get("detail"))))
    lead_agent.retired_flat_pass("task")
    assert beats, "은퇴하면서 아무 흔적도 안 남겼다"          # ← 이 테스트의 본론
    component, phase, detail = beats[0]
    assert component == "task"
    # ⚠️ phase 는 "retired" 가 아니라 "disabled" 다 (2026-08-28).
    #    콘솔의 phase 판정은 allowlist 가 아니라 denylist 라, idle/disabled 집합에
    #    없는 문자열은 전부 **active** 로 읽힌다(gateway runtime_components.py:67-77).
    #    "retired" 를 쓰면 은퇴한 레인이 콘솔에서 돌고 있는 것처럼 보였다 —
    #    이 함수가 막으려던 것과 정확히 반대다. 실측: dev_web_task 가 33시간째
    #    phase=retired 로 얼어 있는 유령 카드였다. 은퇴 사실은 detail 이 나른다.
    assert phase == "disabled"
    assert "smb.lead" in (detail or ""), "무엇으로 넘어갔는지 안 적혀 있다"


def test_lead_never_yields_to_a_stale_flat_flag(monkeypatch, tmp_path):
    """★ 리드는 물러나지 않는다.

    한때 "평면이 켜져 있으면 리드가 건너뛴다" 로 짰다가 뒤집었다(2026-08-26) — 그건
    시작점을 워커에 두는 것이라 방향이 반대였다. 은퇴한 플래그가 아직 켜져 있는 것은
    운영 잔재일 뿐이고, 리드는 그대로 돈다(다만 잔재라고 말은 한다).
    """
    monkeypatch.setattr(lead_agent, "_int_env", lambda n, d: d)
    monkeypatch.setattr(lead_agent, "_flag_on", lambda c: True)   # 평면 플래그 잔재
    _stub_evidence_dir(monkeypatch, tmp_path)
    _stub_run(monkeypatch, rc=0, worker_result={"status": "ok", "turns_used": 5})
    monkeypatch.setattr(lead_agent, "_flag_on", lambda c: True)

    out = lead_agent.run_lead_pass("smb")
    assert out["status"] == "ok", "은퇴한 평면 플래그 때문에 리드가 물러났다"
    assert out.get("stale_flat_flag") == "task", "잔재 플래그를 말하지 않았다"


def test_empty_queue_does_not_spawn_an_llm_run(monkeypatch):
    """pending 0 이면 리드를 안 띄운다 — 빈 큐에 LLM 런을 태우지 않는다."""
    spawned: list = []
    monkeypatch.setattr(lead_agent, "load_runtime_env", lambda **k: None)
    monkeypatch.setattr(lead_agent, "_flag_on", lambda c: False)
    monkeypatch.setattr(lead_agent, "_pending_count", lambda *a, **k: 0)
    monkeypatch.setattr(lead_agent.subprocess, "run",
                        lambda *a, **k: spawned.append(a) or None)

    import service.state_domain as state

    monkeypatch.setattr(state, "heartbeat_upsert", lambda *a, **k: None)
    monkeypatch.setattr(state, "pipeline_run_start", lambda *a, **k: 1)
    monkeypatch.setattr(state, "pipeline_run_finish", lambda *a, **k: None)

    from _shared import lead_adapter as la

    monkeypatch.setattr(la, "get_lead_adapter", lambda d: object())
    out = lead_agent.run_lead_pass("smb")
    assert out["status"] == "idle" and out["pending"] == 0
    assert spawned == []


def test_unreadable_queue_is_not_read_as_empty(monkeypatch):
    """★ '못 셌다'(-1)와 '0건'은 다르다 — 뭉개면 큐가 빈 것으로 조용히 읽힌다."""
    class _Boom:
        domain = "smb"

        def list_targets(self, **k):
            raise RuntimeError("DB 안 됨")

    assert lead_agent._pending_count(_Boom(), limit=1) == -1


# ── ③ 성공 판정은 worker_result.json 으로만 ─────────────────────────────

def _stub_evidence_dir(monkeypatch, tmp_path):
    from service.agents import runtime

    def _mk(label: str):
        d = tmp_path / label
        d.mkdir(parents=True, exist_ok=True)
        return d

    monkeypatch.setattr(runtime, "make_evidence_dir", _mk)


def _stub_run(monkeypatch, *, rc: int, worker_result: dict | None):
    monkeypatch.setattr(lead_agent, "load_runtime_env", lambda **k: None)
    monkeypatch.setattr(lead_agent, "_flag_on", lambda c: False)
    monkeypatch.setattr(lead_agent, "_pending_count", lambda *a, **k: 3)

    from _shared import lead_adapter as la

    monkeypatch.setattr(la, "get_lead_adapter", lambda d: object())

    import service.state_domain as state

    monkeypatch.setattr(state, "heartbeat_upsert", lambda *a, **k: None)
    monkeypatch.setattr(state, "pipeline_run_start", lambda *a, **k: 1)
    monkeypatch.setattr(state, "pipeline_run_finish", lambda *a, **k: None)

    class _Proc:
        returncode = rc

    def _fake_run(argv, **kw):
        ev = argv[3]
        if worker_result is not None:
            (__import__("pathlib").Path(ev) / "worker_result.json").write_text(
                json.dumps(worker_result, ensure_ascii=False), encoding="utf-8")
        return _Proc()

    monkeypatch.setattr(lead_agent.subprocess, "run", _fake_run)


def test_missing_worker_result_is_a_crash_even_when_rc_is_zero(monkeypatch, tmp_path):
    """★ rc=0 인데 결과 파일이 없으면 **성공이 아니다.**"""
    monkeypatch.setattr(lead_agent, "_int_env", lambda n, d: d)
    _stub_evidence_dir(monkeypatch, tmp_path)
    _stub_run(monkeypatch, rc=0, worker_result=None)
    out = lead_agent.run_lead_pass("smb")
    assert out["status"] == "error_crash"


def test_worker_result_status_wins_over_rc(monkeypatch, tmp_path):
    """계약이 큐 미종료에 rc=3 을 주지만, 판정은 worker_result 가 한다."""
    monkeypatch.setattr(lead_agent, "_int_env", lambda n, d: d)
    _stub_evidence_dir(monkeypatch, tmp_path)
    _stub_run(monkeypatch, rc=3, worker_result={
        "status": "error_budget", "turns_used": 3,
        "summary": "reason=max_turns", "completion_reason": "max_turns"})
    out = lead_agent.run_lead_pass("smb")
    assert out["status"] == "error_budget" and out["completion_reason"] == "max_turns"
    assert out["rc"] == 3


# ── ④ 예산·타임아웃 불변식 ───────────────────────────────────────────────

def test_subprocess_timeout_exceeds_the_contract_wall_clock(monkeypatch, tmp_path):
    """★ 러너 타임아웃이 계약 wall-clock 보다 **커야** 한다.

    같거나 작으면 예산이 자기 일(정상 종료 + 열린 검토원 세션 정리)을 하기 전에 러너가
    먼저 죽인다 — 그러면 `on_no_submit` 훅이 못 돌아 검토원 프로세스가 남는다.
    같은 종류의 동점(예산 == 요청 타임아웃)으로 메일 워커가 43% 죽은 적이 있다.
    """
    monkeypatch.delenv("SA_LEAD_MAX_WALL_SEC", raising=False)
    monkeypatch.delenv("SA_LEAD_SUBPROCESS_TIMEOUT_SEC", raising=False)
    seen: dict = {}

    _stub_evidence_dir(monkeypatch, tmp_path)
    _stub_run(monkeypatch, rc=0, worker_result={"status": "ok", "turns_used": 1})

    real_run = lead_agent.subprocess.run

    def _capture(argv, **kw):
        seen["timeout"] = kw.get("timeout")
        return real_run(argv, **kw)

    monkeypatch.setattr(lead_agent.subprocess, "run", _capture)
    lead_agent.run_lead_pass("smb")

    wall = 1800   # 계약 기본값 (`build_lead_contract(default_wall_sec=1800)`)
    assert seen["timeout"] > wall, (
        f"러너 타임아웃 {seen['timeout']}s 가 계약 wall-clock {wall}s 보다 크지 않다")


def test_default_session_cap_matches_the_standing_decision():
    """사용자 결정: '리드당 워커는 2개씩으로.'"""
    assert lead_agent._DEFAULT_MAX_SESSIONS == 2


def test_worker_env_carries_engine_src_and_skill_repo(monkeypatch, tmp_path):
    """검토원 스폰이 되려면 리드 프로세스가 엔진과 스킬을 둘 다 import 할 수 있어야 한다."""
    monkeypatch.delenv("SA_LEAD_MAX_SESSIONS", raising=False)
    env = lead_agent._worker_env(tmp_path)
    assert str(tmp_path) in env["PYTHONPATH"]
    assert "secu-agent/src" in env["PYTHONPATH"] or "/src" in env["PYTHONPATH"]
    assert env["SA_LEAD_MAX_SESSIONS"] == str(lead_agent._DEFAULT_MAX_SESSIONS)
    assert env["SA_PLUGINS"].endswith("plugin/bootstrap.py") or "SA_PLUGINS" in env


def test_spec_does_not_preselect_targets():
    """★ 어디를 볼지 고르는 것이 리드의 일이다 — 러너가 골라 주면 전달자가 된다."""
    spec = lead_agent._build_spec("smb", charter_ref="C", goal="g")
    assert spec["task_type"] == "smb_lead"
    assert "target_ids" not in spec["target"]
    assert spec["target"]["goal"] == "g"


def test_runner_domains_match_the_registered_adapters():
    """★ 러너가 아는 도메인 == 어댑터가 실제로 선언하는 도메인.

    어긋나면 두 방향으로 조용히 틀린다: 러너에만 있으면 `run_lead_pass` 가 "어댑터
    미등록" 으로 죽고, 어댑터에만 있으면 그 큐의 리드는 **영원히 안 돈다**(지금까지
    5개 전부가 그 상태였다).

    ⚠️ `plugin.bootstrap` 을 in-process 로 부르지 않는다 — 전역 레지스트리를 오염시켜
    다른 테스트 결과가 바뀐다(bootstrap 이 직접 그 경고를 낸다). 어댑터 팩토리를 바로 읽는다.
    """
    from domains.dev_web.plugin.lead_adapter import dev_web_lead_adapter
    from domains.services.confluence.plugin.lead_adapter import (
        confluence_lead_adapter, confluence_search_lead_adapter,
    )
    from domains.services.github.plugin.lead_adapter import github_lead_adapter
    from domains.smb.plugin.lead_adapter import smb_lead_adapter

    declared = {f().domain for f in (
        smb_lead_adapter, dev_web_lead_adapter, github_lead_adapter,
        confluence_lead_adapter, confluence_search_lead_adapter)}
    assert set(lead_agent._LEADS) == declared


# ── ⑤ 큐 판정은 어댑터가 한다 (2026-08-26 컷오버가 잡은 것) ───────────────

def test_every_adapter_declares_claimable_statuses():
    """★ 러너가 상태를 통일하면 안 된다.

    처음엔 `status="pending"` 하나로 물었다. smb 의 판정대기는 `walked`/
    `listing_reviewed` 라(`smb_task_claim_next`: "수집기가 채운 walked/
    listing_reviewed(판정 대기)") 리드가 **영원히 idle** 이었다 — 큐에 일이 있는데
    "깨끗함" 으로 읽혔다. 컷오버 첫 사이클에서 잡혔다.
    """
    # ⚠️ `plugin.bootstrap` 을 부르지 않는다 — in-process 로드는 전역 레지스트리를
    #    오염시켜 다른 테스트 결과를 바꾼다(bootstrap 이 직접 그 경고를 낸다).
    #    팩토리를 바로 부르면 등록 없이도 어댑터를 볼 수 있다.
    from domains.dev_web.plugin.lead_adapter import dev_web_lead_adapter
    from domains.services.confluence.plugin.lead_adapter import (
        confluence_lead_adapter, confluence_search_lead_adapter,
    )
    from domains.services.github.plugin.lead_adapter import github_lead_adapter
    from domains.smb.plugin.lead_adapter import smb_lead_adapter

    for factory in (smb_lead_adapter, dev_web_lead_adapter, github_lead_adapter,
                    confluence_lead_adapter, confluence_search_lead_adapter):
        a = factory()
        assert a.claimable_statuses, f"{a.domain}: claimable_statuses 가 비어 있다"
        unknown = set(a.claimable_statuses) - set(a.statuses)
        assert not unknown, f"{a.domain}: 큐 어휘에 없는 상태 {unknown}"


def test_smb_claimable_covers_the_walked_queue():
    """★ smb 만 어휘가 다르다 — 여기가 틀리면 리드가 조용히 아무것도 안 한다."""
    from domains.smb.plugin.lead_adapter import smb_lead_adapter

    got = set(smb_lead_adapter().claimable_statuses)
    assert {"walked", "listing_reviewed"} <= got, (
        "smb 판정대기 상태가 빠졌다 — pending 만 보면 영원히 idle 이다")


def test_probe_distinguishes_unreadable_from_empty():
    """'못 셌다'(-1)와 '0건'은 다르다 — 뭉개면 빈 큐로 조용히 읽힌다."""
    class _Boom:
        domain = "x"
        claimable_statuses = ("pending",)

        def list_targets(self, **k):
            raise RuntimeError("DB 안 됨")

    class _Empty:
        domain = "x"
        claimable_statuses = ("pending", "tasked")

        def list_targets(self, **k):
            return []

    assert lead_agent._pending_count(_Boom(), limit=5) == -1
    assert lead_agent._pending_count(_Empty(), limit=5) == 0


def test_probe_sums_across_declared_statuses():
    """여러 상태를 선언하면 합산해야 한다 — 첫 상태가 0이라고 멈추면 안 된다."""
    class _A:
        domain = "x"
        claimable_statuses = ("pending", "walked")

        def list_targets(self, *, status=None, limit=20):
            return [] if status == "pending" else [{"id": 1}]

    assert lead_agent._pending_count(_A(), limit=5) == 1


# ── ⑥ 공유 큐 격리 (2026-08-28 평면 레인 은퇴 때 옮겨 온 불변식) ───────────

def test_github_lead_refuses_a_confluence_target(tmp_db) -> None:
    """★ `devops_target` 은 github 과 confluence 가 **같이 쓰는 큐**다.

    한쪽 레인이 다른 쪽 행을 건드리면 남의 진행을 지운다. 평면 SSO 레인 시절에는
    `GithubStateGateway.reset_sso_target` 의 SQL 이 `AND service='github'` 로 막았고,
    `test_github_fanout.py` 가 그걸 지켰다. 그 게이트웨이가 은퇴하면서 불변식의
    자리가 리드로 옮겼다 — `lead_adapter._get_scoped` 가 service 를 검사한다.

    ⚠️ 여기가 뚫리면 조용히 깨진다: 상태가 바뀐 뒤에야 다른 도메인 행이었다는 걸 안다.
    """
    import service.state_domain as sd
    from domains.services.github.plugin.lead_adapter import github_lead_adapter

    target_id = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/GITHUB-GUARD",
        service="confluence",
        source="proxy",
        day_bucket="2026-08-28",
        access_count=77,
    )
    sd.devops_target_set_status(
        target_id, "in_progress",
        claimed_by=999_301, last_reason="owned by confluence lane",
    )

    adapter = github_lead_adapter()
    with pytest.raises(RuntimeError, match="devops_target"):
        adapter.set_status(target_id, "tasked", finding_count=0, reason="forged")

    row = sd.devops_target_get(target_id)
    assert row["service"] == "confluence"
    assert row["status"] == "in_progress"
    assert row["claimed_by"] == 999_301
    assert row["last_reason"] == "owned by confluence lane"


def test_github_lead_list_targets_never_returns_confluence_rows(tmp_db) -> None:
    """조회도 같은 경계를 지켜야 한다 — 목록이 새면 리드가 남의 큐를 일감으로 본다."""
    import service.state_domain as sd
    from domains.services.github.plugin.lead_adapter import github_lead_adapter

    sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/OPS", service="confluence",
        source="proxy", day_bucket="2026-08-28", access_count=100,
    )
    wanted = sd.devops_target_upsert(
        "https://github.samsungds.net/o/r", service="github",
        source="proxy", day_bucket="2026-08-28", access_count=5,
    )

    rows = github_lead_adapter().list_targets(status=None, limit=50)
    assert [r["id"] for r in rows] == [wanted]
