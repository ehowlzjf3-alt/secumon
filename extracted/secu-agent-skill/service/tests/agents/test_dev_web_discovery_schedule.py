"""discovery 가 **불리기는 하는가** — 그리고 스스로 주기를 지키는가.

## 왜 (2026-08-28 실측)

`dev_web_target` 의 마지막 `discovered_at` 은 2026-08-24 다. 그동안 소스
(`index=hq_escort sourcetype=escort_web_access`)에는 하루 1,400만 건이 쌓였고
`dev_web_target.pending` 은 0 이었다 — **고갈이 아니라 미공급**이었다.

원인: github·confluence 는 `*_pipeline_runner.py` 가 discovery 를
`control_flag.interval_seconds` 로 하루 한 번 돌린다. dev_web 은 그 러너가 없고
스케줄이 `scripts/dev_web_loop.sh` 인데, 거기엔 task·report 자리만 있었다.
`git log -S"runners.discovery" -- scripts/` 가 **0건** — 한 번도 들어간 적이 없다.

★ 그런데 `control_flag` 의 `dev_web_discovery` 는 **이미 enabled=1** 이었다.
  누군가 켰고, 그걸 존중할 코드가 없었다. 「배선 없는 배선」의 가장 순수한 형태다.
"""
from __future__ import annotations

import pathlib

from service.agents import dev_web_discovery_agent as m


def test_the_loop_actually_calls_discovery():
    """★ 이 항목의 전부 — 부르는 곳이 없었다."""
    loop = (pathlib.Path(__file__).resolve().parents[3]
            / "scripts" / "dev_web_loop.sh").read_text(encoding="utf-8")
    assert "runners.discovery" in loop, "루프가 discovery 를 안 부른다"
    assert "flag_enabled dev_web_discovery" in loop, "형제 도메인처럼 플래그로 게이트해야 한다"
    assert "--if-due" in loop, "매 틱 도는 루프라 스스로 주기를 지켜야 한다"


def test_run_now_wins_over_the_interval(monkeypatch):
    from service import state_domain as state

    monkeypatch.setattr(state, "control_flag_get", lambda _c: {"enabled": 1})
    monkeypatch.setattr(state, "control_flag_consume_run_now", lambda _c: True)
    monkeypatch.setattr(m, "_latest_run_age", lambda: 1.0)
    ok, why = m.due_now()
    assert ok and why == "run_now"


def test_disabled_flag_stops_it(monkeypatch):
    from service import state_domain as state

    monkeypatch.setattr(state, "control_flag_get", lambda _c: {"enabled": 0})
    monkeypatch.setattr(state, "control_flag_consume_run_now", lambda _c: False)
    ok, why = m.due_now()
    assert not ok and "disabled" in why


def test_a_recent_run_is_skipped(monkeypatch):
    from service import state_domain as state

    monkeypatch.setattr(state, "control_flag_get",
                        lambda _c: {"enabled": 1, "interval_seconds": 86400})
    monkeypatch.setattr(state, "control_flag_consume_run_now", lambda _c: False)
    monkeypatch.setattr(m, "_latest_run_age", lambda: 60.0)
    ok, why = m.due_now()
    assert not ok and "next due in" in why


def test_never_run_is_due(monkeypatch):
    """기록이 없으면 돈다 — 처음 켰을 때 하루를 기다리지 않는다."""
    from service import state_domain as state

    monkeypatch.setattr(state, "control_flag_get", lambda _c: {"enabled": 1})
    monkeypatch.setattr(state, "control_flag_consume_run_now", lambda _c: False)
    monkeypatch.setattr(m, "_latest_run_age", lambda: None)
    ok, _why = m.due_now()
    assert ok


def test_an_unreadable_flag_does_not_run(monkeypatch):
    """모르면 안 돈다(fail-closed) — 플래그를 못 읽는 채로 Splunk 를 때리지 않는다."""
    from service import state_domain as state

    def _boom(_c):
        raise RuntimeError("DB 안 됨")

    monkeypatch.setattr(state, "control_flag_get", _boom)
    ok, why = m.due_now()
    assert not ok and "못 읽었다" in why


def test_the_default_interval_matches_the_sibling_domains():
    """confluence.space_discovery 와 같은 86400 — 새 숫자를 만들지 않는다."""
    assert m._DEFAULT_INTERVAL_SECONDS == 86400.0
