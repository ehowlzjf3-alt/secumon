"""finding status 어휘를 코드가 실제로 지키는지 — ★ except 가 삼키면 스위트도 못 잡는다.

2026-08-28 실측: `finding_update(status="resolved")` 를 부르는 곳이 3군데 있었는데
엔진 어휘는 `{open, triaged, false_positive, accepted_risk, remediated}` 라
매번 `ValueError: invalid finding status: 'resolved'` 가 났다. 호출부가 전부
`except Exception: pass` 로 감싸고 있어서 **조용히 실패**했고, 그래서 finding 89건이
6주째 전부 `status='open'` 이었다 — 스레드는 remediated 로 닫히는데 finding 은 안 닫혔다.

결정적 증거는 `dev_web_reverify_tool.py` 였다: 바로 윗줄에서 스레드에 `"remediated"` 를
쓰고 다음 줄에서 finding 에만 `"resolved"` 를 썼다. 오타가 아니라 **어휘가 둘로 갈린 것**이다.

이 파일은 두 가지를 고정한다:
  ① 소스에 엔진 어휘 밖 status 리터럴이 없다 (grep 계열 — 실행 안 해도 잡힌다)
  ② 엔진이 정말 그 어휘만 받는다 (계약 — 어휘가 바뀌면 ①의 기준도 같이 바뀌어야 한다)
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_SCAN_DIRS = ("service", "domains", "_shared")

# `finding_update(...)` / `finding_upsert(...)` 호출에 실린 status= 리터럴을 뽑는다.
#
# ⚠️ `[^)]*?` 로 쓰면 안 된다 — 실제 호출이 `finding_update(int(fid), status="...")` 처럼
#    **중첩 괄호**를 품는다. 그러면 인자 안의 `)` 에서 매칭이 끊겨 진짜 버그를 놓친다.
#    (이 파일을 처음 쓸 때 그 실수를 했고, 배선을 되돌려도 테스트가 통과했다.)
#    그래서 괄호를 파싱하지 말고, 호출 이름 뒤 제한 창에서 status= 를 찾는다.
_CALL_NAME_RE = re.compile(r"finding_up(?:date|sert)\s*\(")
_STATUS_RE = re.compile(r"""status\s*=\s*["']([A-Za-z_]+)["']""")
_WINDOW = 400  # 한 호출이 이보다 길면 잡을 수 없다 — 실제 호출은 전부 100자 이내다.


def _status_literals(text: str):
    """(줄번호, 값) — 호출 이름 뒤 창에서 첫 status= 리터럴."""
    for m in _CALL_NAME_RE.finditer(text):
        window = text[m.end(): m.end() + _WINDOW]
        s = _STATUS_RE.search(window)
        if s:
            yield text[: m.start()].count("\n") + 1, s.group(1)


def _engine_statuses() -> set[str]:
    from secu_agent import state as core_state

    return set(core_state._FINDING_STATUSES)


def _sources():
    for d in _SCAN_DIRS:
        for p in (_ROOT / d).rglob("*.py"):
            if "__pycache__" in p.parts or "/tests/" in str(p) or p.name.startswith("test_"):
                continue
            yield p


def test_engine_accepts_exactly_the_known_vocabulary():
    """어휘가 바뀌면 여기서 먼저 깨져서, 아래 테스트의 기준이 낡는 걸 막는다."""
    assert _engine_statuses() == {
        "open", "triaged", "false_positive", "accepted_risk", "remediated",
    }


def test_no_source_passes_a_status_the_engine_would_reject():
    """★ 이게 본체다. 호출부가 예외를 삼켜도 여기서 잡힌다."""
    allowed = _engine_statuses()
    bad: list[str] = []
    for path in _sources():
        text = path.read_text(encoding="utf-8")
        for line, value in _status_literals(text):
            if value not in allowed:
                bad.append(f"{path.relative_to(_ROOT)}:{line} status={value!r}")
    assert not bad, (
        "엔진이 거부하는 finding status 를 넘기는 곳이 있다 — 호출부가 except 로 삼키면 "
        "조용히 실패한다:\n  " + "\n  ".join(bad)
    )


@pytest.mark.parametrize("bogus", ["resolved", "closed", "done", "fixed"])
def test_engine_really_raises_on_the_words_people_reach_for(bogus):
    """사람이 자연스럽게 쓰는 말들이 실제로 거부되는지 — 조용한 실패의 재료다."""
    from secu_agent import state as core_state

    assert bogus not in _engine_statuses()
    with pytest.raises(ValueError, match="invalid finding status"):
        core_state.finding_update(999_999_999, status=bogus)


def test_the_detector_itself_matches_the_real_call_shape():
    """★ 이 파일의 첫 판은 정규식이 `int(fid)` 의 `)` 에서 끊겨 **아무것도 못 잡았다.**

    탐지기가 실제 소스에 있는 호출 모양을 잡는지 직접 고정한다. 이게 없으면
    "테스트가 통과한다"가 "버그가 없다"를 뜻하지 않는다.
    """
    samples = [
        ('_cs.finding_update(int(fid), status="remediated")', "remediated"),
        ('core_state.finding_update(int(t["finding_id"]), status="remediated")', "remediated"),
        ('state.finding_upsert(task_type="x", status="open")', "open"),
        ('finding_update(\n    123,\n    status="triaged",\n)', "triaged"),
    ]
    for code, expected in samples:
        got = [v for _, v in _status_literals(code)]
        assert got == [expected], f"{code!r} → {got}"
