"""은퇴 가드는 콘솔이 **꺼졌다고 읽는** phase 를 써야 한다.

## 왜 (2026-08-28 실측)

`retired_flat_pass` 의 주석은 "콘솔에 보이게 한다" 는 의도를 명시하는데, 쓰던
phase 문자열이 `retired` 였다. 그런데 콘솔의 phase 판정은 allowlist 가 아니라
**denylist** 다:

    digisecu-employee/gateway/src/digisecu_gateway/runtime_components.py:67-77
    "heartbeat phase → active/idle/disabled/unknown.
     idle/disabled만 명시, 그 외 non-empty phase = active."

즉 `retired` 는 **`active`** 로 읽힌다 — 은퇴한 레인이 돌고 있는 것처럼 보인다.
이 함수가 막으려던 것과 정확히 반대다. 4개 도메인 투영도 같은 구조다
(`h["phase"] not in (None,"idle","poll","disabled")` → active).

실측: `dev_web_task` 가 `phase=retired` 로 33시간째 얼어 있는 유령 카드였다.

⚠️ 게이트웨이는 **다른 저장소**라 여기서 import 하지 않는다. 대신 그쪽 어휘를
   리터럴로 고정해 계약을 이 저장소에서 지킨다 — 저장소 2개 배포 순서를
   만들지 않으려는 의식적 선택이다.
"""
from __future__ import annotations

from service.agents import lead_agent as m

#: `runtime_components.py:57` `_DISABLED_PHASES` 의 사본. 저쪽이 바뀌면 이게 먼저 깨진다.
_CONSOLE_DISABLED_PHASES = {"disabled", "stopped", "off"}


class _Recorder:
    def __init__(self):
        self.beats: list[tuple] = []
        self.flag_reads: list[str] = []

    def heartbeat_upsert(self, component, *, phase=None, detail=None, pid=None):
        self.beats.append((component, phase, detail))

    def control_flag_get(self, component):
        self.flag_reads.append(component)
        return {"enabled": 1}


def _run(monkeypatch, component):
    from service import state_domain as state

    rec = _Recorder()
    monkeypatch.setattr(state, "heartbeat_upsert", rec.heartbeat_upsert)
    monkeypatch.setattr(state, "control_flag_get", rec.control_flag_get)
    return m.retired_flat_pass(component), rec


def test_every_retired_component_reports_a_console_disabled_phase(monkeypatch):
    """★ 은퇴 5개 전부 — 콘솔이 'active' 로 읽으면 안 된다."""
    assert m._RETIRED_FLAT, "은퇴 목록이 비었다"
    for component in m._RETIRED_FLAT:
        out, rec = _run(monkeypatch, component)
        assert out is not None and out["status"] == "retired", component
        assert rec.beats, f"{component}: heartbeat 를 안 남겼다 — 죽은 것처럼 보인다"
        _c, phase, _d = rec.beats[-1]
        assert phase in _CONSOLE_DISABLED_PHASES, (
            f"{component}: phase={phase!r} 는 콘솔에서 active 로 읽힌다"
        )


def test_detail_names_the_lead_that_took_the_queue(monkeypatch):
    """phase 로 '은퇴'를 표현하지 않는 대신 detail 이 그 사실을 나른다."""
    for component, domain in m._RETIRED_FLAT.items():
        out, rec = _run(monkeypatch, component)
        lead = m._LEADS[domain][0]
        assert lead in out["detail"], component
        assert lead in (rec.beats[-1][2] or ""), component
        assert "enabled=1" in out["detail"], "되살리는 법이 있어야 한다"


def test_the_guard_never_reads_control_flag(monkeypatch):
    """★ `control_flag_get` 은 행이 없으면 enabled=1 로 **만들어서** 돌려준다.

    은퇴 가드가 그걸 부르면 지운 레인을 되살리는 부작용이 생긴다. 판정 근거는
    `_RETIRED_FLAT` 하나면 충분하다.
    """
    for component in m._RETIRED_FLAT:
        _out, rec = _run(monkeypatch, component)
        assert rec.flag_reads == [], f"{component}: 가드가 control_flag 를 읽었다"


def test_a_live_lane_is_not_retired(monkeypatch):
    """리드 컴포넌트나 은퇴 목록 밖은 None 이어야 한다 — 가드가 새면 리드가 죽는다."""
    for component in ("smb.lead", "dev_web.lead", "confluence.sso_task", "무관"):
        out, rec = _run(monkeypatch, component)
        assert out is None, f"{component} 가 은퇴로 잡혔다"
        assert rec.beats == []


def test_confluence_sso_task_is_not_in_the_retired_set():
    """★ 가장 죽기 쉬운 것 — `github.sso_task` 와 라벨·시각이 같은데 대체 리드가 없다.

    실측 2026-08-28 control_flag:
        github.sso_task      0  fullsweep-pause  2026-08-16 15:50:57.083948
        confluence.sso_task  0  fullsweep-pause  2026-08-16 15:50:57.341245

    같은 초에 같은 이유로 꺼졌지만 `_LEADS` 에는 github 것만 있다 — confluence 쪽은
    "은퇴"가 아니라 "일시정지"다. 은퇴 목록에 넣으면 되살릴 길이 막힌다.
    """
    assert "confluence.sso_task" not in m._RETIRED_FLAT
    assert "github.sso_task" in m._RETIRED_FLAT
