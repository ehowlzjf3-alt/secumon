"""4도메인 공용 스레드 러너 — 플래그를 보고, 상한을 지키고, 발송을 열지 않는다.

## 왜 이 러너가 생겼나 (2026-08-31)

같은 일(플래그 보고 큐 한 바퀴)을 넷이 제각각으로 하고 있었다:

    github      pipeline_runner 208줄
    confluence  pipeline_runner 336줄   ← 둘이 240줄 차이
    dev_web     scripts/dev_web_loop.sh  ← 셸 루프
    smb         (없음)                    ← 그래서 reply_verify·reverify 플래그를
                                            **아무도 안 봤다**(켜고 끄는 게 장식)

배관을 한 벌로 모으고 도메인은 `ThreadAdapter` 로 좌표만 낸다.
"""
from __future__ import annotations

import pytest

from service.agents import thread_pipeline_runner as R


class _FakeAdapter:
    def __init__(self, domain="smb", threads=None, statuses=("reported", "reply_received")):
        self.domain = domain
        self.report_component = f"{domain}.report"
        self.recheck_component = f"{domain}.recheck"
        self.claimable_statuses = statuses
        self.sync_threads = None
        self._queue = list(threads or [])
        self.delivered: list[dict] = []
        self.bumped: list[int] = []

    def reclaim_stale(self):
        return 0

    def claim_next(self, *, session_id, status, **_):
        return self._queue.pop(0) if self._queue else None

    def bump_attempt(self, thread_id, *, reason=None):
        self.bumped.append(thread_id)

    async def deliver_report(self, thread, **_):
        self.delivered.append(thread)
        return {"ok": True}

    deliver_recheck = None


@pytest.fixture(autouse=True)
def _no_pop3(monkeypatch):
    """⚠️ 러너가 매 패스 답장을 수집한다(2026-09-01) — 테스트가 **진짜 POP3 를 치면 안 된다.**
    실제로 한 번 쳤다(200통 훑고 왔다). 여기서 전부 막는다."""
    monkeypatch.setattr("service.collector.mail_inbound.poll_inbox",
                        lambda: {"scanned": 0, "matched": 0, "new": 0})


@pytest.fixture
def gate(monkeypatch):
    """플래그·주기 판정을 대본대로 만든다 — DB 를 안 탄다."""
    def _install(should_run=True):
        monkeypatch.setattr(R, "_should_run", lambda c: should_run)
        monkeypatch.setattr(R.state, "pipeline_run_start", lambda c: 1)
        monkeypatch.setattr(R.state, "pipeline_run_finish", lambda *a, **k: None)
        monkeypatch.setattr(R.state, "heartbeat_upsert", lambda *a, **k: None)
    return _install


def test_drives_the_queue_up_to_the_cap(gate, monkeypatch) -> None:
    """★ 상한이 없으면 큐가 깊은 도메인이 차례를 독점한다."""
    monkeypatch.setenv(R.MAX_THREADS_ENV, "3")
    a = _FakeAdapter(threads=[{"id": i} for i in range(10)])
    out = R._drive(a, kind="report", charter_ref="")
    assert out["handled"] == 3 and len(a.delivered) == 3


def test_stops_when_the_queue_empties(gate) -> None:
    a = _FakeAdapter(threads=[{"id": 1}])
    out = R._drive(a, kind="report", charter_ref="")
    assert out["handled"] == 1


def test_missing_slot_says_so_instead_of_silently_passing(gate) -> None:
    """★ 조용한 no-op 금지 — `ThreadAdapter` 머리말의 규칙."""
    a = _FakeAdapter(threads=[{"id": 1}])
    out = R._drive(a, kind="recheck", charter_ref="")
    assert "배선이 없다" in out["skipped"]


def test_one_failure_does_not_stop_the_rest(gate) -> None:
    """한 건이 터져도 나머지를 처리하고, 그 건은 attempt 를 올린다."""
    a = _FakeAdapter(threads=[{"id": 1}, {"id": 2}])

    async def _boom(thread, **_):
        if thread["id"] == 1:
            raise RuntimeError("boom")
        a.delivered.append(thread)
    a.deliver_report = _boom
    out = R._drive(a, kind="report", charter_ref="")
    assert out["handled"] == 2 and out["errors"] == 1
    assert a.bumped == [1] and len(a.delivered) == 1


def test_disabled_component_is_not_driven(gate, monkeypatch) -> None:
    """플래그가 꺼져 있으면 큐를 건드리지 않는다 — 그게 이 러너의 존재 이유다."""
    import _shared.thread_adapter as ta

    a = _FakeAdapter(threads=[{"id": 1}])
    monkeypatch.setattr(ta, "_ADAPTERS", {"smb": a})
    monkeypatch.setattr(R, "load_runtime_env", lambda **_: None)
    gate(should_run=False)
    out = R.run_once()
    # ⚠️ `inbox` 는 수집 결과다 — 큐를 건드렸는지와 무관하다(2026-09-01 추가).
    #    그래서 "빈 dict" 가 아니라 **큐 축**으로 단정한다.
    assert not a.delivered
    assert {k: v for k, v in out.items() if k != "inbox"} == {}


def test_adapter_without_component_name_is_skipped(gate, monkeypatch) -> None:
    """컴포넌트 이름이 없으면 플래그를 못 보므로 돌리지 않는다."""
    import _shared.thread_adapter as ta

    a = _FakeAdapter(threads=[{"id": 1}])
    a.report_component = None
    a.recheck_component = None
    monkeypatch.setattr(ta, "_ADAPTERS", {"smb": a})
    monkeypatch.setattr(R, "load_runtime_env", lambda **_: None)
    gate(should_run=True)
    assert R.run_once() == {}


def test_답장_수집은_큐를_돌기_전에_한다(tmp_db, monkeypatch) -> None:
    """★ POP3 수집이 `reply_verify_agent.run_reply_pass` **안에** 있었고, 공용 러너는
    그 함수를 안 부른다(어댑터의 `deliver_recheck` 를 부른다). 그래서 **아무도 수집하지
    않았다** — 사람이 손으로 부를 때만 답장이 들어왔다(2026-09-01 실측).

    더 나쁜 건 순환이다: 수집이 처리 안에 있으면 **처리할 게 없으면 수집도 안 하고,
    수집을 안 하니 처리할 것도 안 생긴다.** 방아쇠가 자기 자신인 구조다.
    """
    from service.agents import thread_pipeline_runner as runner

    calls: list[str] = []
    monkeypatch.setattr(runner, "_last_inbox_poll", 0.0, raising=False)
    monkeypatch.setattr("service.collector.mail_inbound.poll_inbox",
                        lambda: calls.append("poll") or {"new": 0, "scanned": 0})   # 자동 스텁 위에 덮어쓴다
    monkeypatch.setattr(runner, "load_runtime_env", lambda load_plugins=True: None)
    monkeypatch.setattr("_shared.thread_adapter.thread_adapter_names", lambda: ())

    runner.run_once()

    assert calls == ["poll"], "큐가 비어 있어도 수집은 돌아야 한다"


def test_수집_실패가_큐_처리를_막지_않는다(tmp_db, monkeypatch) -> None:
    """⚠️ POP3 는 사외 의존이다. 그것 때문에 큐가 멈추면 안 된다."""
    from service.agents import thread_pipeline_runner as runner

    def _boom():
        raise RuntimeError("POP3 죽음")

    monkeypatch.setattr(runner, "_last_inbox_poll", 0.0, raising=False)
    monkeypatch.setattr("service.collector.mail_inbound.poll_inbox", _boom)
    monkeypatch.setattr(runner, "load_runtime_env", lambda load_plugins=True: None)
    monkeypatch.setattr("_shared.thread_adapter.thread_adapter_names", lambda: ())

    out = runner.run_once()   # 예외가 새면 안 된다

    assert "error" in (out.get("inbox") or {})
