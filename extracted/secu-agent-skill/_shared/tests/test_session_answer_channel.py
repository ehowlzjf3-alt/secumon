"""세션 답 채널 — 답이 오는가, 그리고 없으면 없다고 말하는가 (v3.99).

## 무엇을 고치는 것인가

실측(2026-08-22, 리드 게이트 4런): 리드가 던진 질문 **22건 중 17건(77%)이 빈 답**으로
돌아왔다. 원인은 채널이 둘인데 서로 경쟁하는 것이다 — 검토원 계약은 "`report_inspection`
으로 보고하라" 고 시키고, serve 프로토콜은 `text`(모델 산문)를 답으로 읽는다. 워커는
계약을 따라 리포트를 쓰고 산문 없이 끝낸다(세션 stderr 이 턴마다 완전히 공백이었다).

거기에 `inspector_report.json` 은 **덮어쓰기 누적 파일**이라, 갱신이 안 돼도 이전 것이
그대로 읽힌다 — 리드는 지금 받은 리포트가 이번 질문의 답인지 알 방법이 없었다.

## 이 파일이 지키는 사실

1. 산문이 없어도 **신선한** 리포트가 있으면 그게 답이다.
2. 리포트가 안 갱신됐으면 `report_stale` — 이전 답의 잔상이다.
3. 둘 다 없으면 `answer_source="none"` + `no_answer`. **조용히 빈 문자열을 주지 않는다.**
4. 신선도는 mtime 이 아니라 **내용 지문**이다.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from _shared.inspector_channel import (
    InspectorAnswer, SessionChannel, report_fingerprint,
)
from _shared.inspector_report import REPORT_FILENAME


def _write_report(d: Path, narrative: str, verdict: str = "clean") -> None:
    (d / REPORT_FILENAME).write_text(
        json.dumps({"verdict": verdict, "narrative": narrative,
                    "notable": [], "reinspect": []}, ensure_ascii=False),
        encoding="utf-8")


def _channel(tmp_path: Path) -> SessionChannel:
    return SessionChannel(agent="fake_inspect", domain="smb", target_id=7,
                          evidence_dir=tmp_path, spec={}, session_id="s1-abc")


def _answer(ch: SessionChannel, payload: dict, before: str | None) -> InspectorAnswer:
    return ch._answer_from_payload(payload, report_before=before)


# ── 신선도 판정 ────────────────────────────────────────────────────────

def test_fingerprint_is_content_not_mtime(tmp_path):
    """★ mtime 이면 같은 내용을 다시 써도 '갱신됐다' 가 된다 — 그건 거짓 신선도다."""
    _write_report(tmp_path, "같은 내용")
    first = report_fingerprint(tmp_path)
    _write_report(tmp_path, "같은 내용")          # mtime 은 바뀐다
    assert report_fingerprint(tmp_path) == first
    _write_report(tmp_path, "다른 내용")
    assert report_fingerprint(tmp_path) != first


def test_fingerprint_is_none_when_absent(tmp_path):
    assert report_fingerprint(tmp_path) is None


# ── 답 출처 ────────────────────────────────────────────────────────────

def test_fresh_report_is_the_answer_when_there_is_no_prose(tmp_path):
    """실측의 지배적 경우 — 워커가 리포트만 쓰고 산문 없이 끝낸다."""
    ch = _channel(tmp_path)
    before = report_fingerprint(tmp_path)          # None
    _write_report(tmp_path, "tar 18개를 열어봤고 크리덴셜은 없었다")
    ans = _answer(ch, {"text": "", "reason": "end_turn"}, before)
    assert ans.answer_source == "report"
    assert ans.summary == "tar 18개를 열어봤고 크리덴셜은 없었다"
    assert "no_answer" not in ans.notes and "report_stale" not in ans.notes


def test_prose_wins_and_the_report_still_rides_along(tmp_path):
    ch = _channel(tmp_path)
    before = report_fingerprint(tmp_path)
    _write_report(tmp_path, "구조화 보고")
    ans = _answer(ch, {"text": "산문 답", "reason": "end_turn"}, before)
    assert ans.answer_source == "text"
    assert ans.summary == "산문 답"
    assert ans.report and ans.report["narrative"] == "구조화 보고"


def test_stale_report_is_flagged_and_not_used_as_the_answer(tmp_path):
    """★ 파일은 덮어쓰기라 갱신 안 돼도 읽힌다 — 그걸 이번 답으로 읽으면 안 된다."""
    _write_report(tmp_path, "지난 질문의 답")
    ch = _channel(tmp_path)
    before = report_fingerprint(tmp_path)
    ans = _answer(ch, {"text": "", "reason": "end_turn"}, before)
    assert ans.answer_source == "none"
    assert ans.summary == ""
    assert "report_stale" in ans.notes
    assert "no_answer" in ans.notes
    # 리포트 자체는 붙여 준다 — 다만 이전 것이라고 말한다.
    assert ans.report["narrative"] == "지난 질문의 답"


def test_nothing_at_all_says_so(tmp_path):
    ch = _channel(tmp_path)
    ans = _answer(ch, {"text": "", "reason": "end_turn"}, None)
    assert ans.answer_source == "none"
    assert "no_answer" in ans.notes and "report_inspection" in ans.notes["no_answer"]
    assert "report_stale" not in ans.notes, "없는 리포트를 stale 이라고 하면 안 된다"


def test_answer_source_is_in_the_envelope(tmp_path):
    ch = _channel(tmp_path)
    _write_report(tmp_path, "n")
    got = json.loads(_answer(ch, {"text": ""}, None).to_json())
    assert got["answer_source"] == "report"


# ── 끊긴 답은 이어갈 수 있다 ──────────────────────────────────────────

@pytest.mark.parametrize("reason", ["max_turns", "repeat_error_halt",
                                    "repeat_call_halt", "contract_violation"])
def test_interrupted_answers_say_the_session_is_alive(tmp_path, reason):
    """★ 실측 smb 9 asks 중 3건이 `repeat_error_halt` 였고, 리드는 세션이 죽은 줄 알았다."""
    ch = _channel(tmp_path)
    ans = _answer(ch, {"text": "", "reason": reason}, None)
    assert "continuable" in ans.notes, reason
    assert "살아" in ans.notes["continuable"]


def test_repeat_halt_tells_the_lead_not_to_repeat_itself(tmp_path):
    """같은 방법으로 다시 물으면 또 멈춘다 — 그 사실이 지시에 있어야 한다."""
    ch = _channel(tmp_path)
    note = _answer(ch, {"text": "", "reason": "repeat_error_halt"}, None).notes
    assert "또 멈춘" in note["continuable"] or "좁히" in note["continuable"]


def test_clean_end_gets_no_continuable_note(tmp_path):
    ch = _channel(tmp_path)
    _write_report(tmp_path, "n")
    assert "continuable" not in _answer(ch, {"text": "", "reason": "end_turn"},
                                        None).notes


# ── 단발/세션종료 경로는 다르게 센다 ──────────────────────────────────

def test_oneshot_template_summary_is_not_counted_as_a_report(tmp_path):
    """★ 단발의 `summary` 는 코어가 만드는 템플릿이다 — 판단이 아니다(Phase 3 교훈).

    그걸 'report' 로 세면 리드가 판단 재료를 받았다고 착각한다.
    """
    from _shared.inspector_channel import answer_from_evidence

    sub = tmp_path / "sub-x"
    sub.mkdir()
    (sub / "worker_result.json").write_text(json.dumps({
        "rc": 0, "status": "ok",
        "summary": "task smb_file_inspect-1 (smb_file_inspect): reason=end_turn, submit=True",
        "findings_count": 0, "turns_used": 3, "tokens_in": 1, "tokens_out": 1,
        "candidates_seen": 0, "candidates_accounted": 0,
        "completion_reason": "end_turn", "metrics_version": 1, "evidence_paths": [],
    }), encoding="utf-8")
    ans = answer_from_evidence(agent="a", domain="smb", target_id=1, sub_dir=sub,
                               call_failed=False)
    assert ans.answer_source == "text"
    assert "report_missing" in ans.notes


def test_oneshot_with_a_report_says_report(tmp_path):
    from _shared.inspector_channel import answer_from_evidence

    sub = tmp_path / "sub-y"
    sub.mkdir()
    (sub / "worker_result.json").write_text(json.dumps({
        "rc": 0, "status": "ok", "summary": "t", "findings_count": 0,
        "turns_used": 1, "tokens_in": 1, "tokens_out": 1, "candidates_seen": 0,
        "candidates_accounted": 0, "completion_reason": "end_turn",
        "metrics_version": 1, "evidence_paths": [],
    }), encoding="utf-8")
    _write_report(sub, "진짜 판단")
    ans = answer_from_evidence(agent="a", domain="smb", target_id=1, sub_dir=sub,
                               call_failed=False)
    assert ans.answer_source == "report"


def test_oneshot_never_says_continuable(tmp_path):
    """단발도 세션 종료도 **이미 끝났다** — 이어갈 수 있다고 하면 거짓말이다."""
    from _shared.inspector_channel import answer_from_evidence

    sub = tmp_path / "sub-z"
    sub.mkdir()
    (sub / "worker_result.json").write_text(json.dumps({
        "rc": 3, "status": "ok", "summary": "t", "findings_count": 0,
        "turns_used": 8, "tokens_in": 1, "tokens_out": 1, "candidates_seen": 0,
        "candidates_accounted": 0, "completion_reason": "max_turns",
        "metrics_version": 1, "evidence_paths": [],
    }), encoding="utf-8")
    ans = answer_from_evidence(agent="a", domain="smb", target_id=1, sub_dir=sub,
                               call_failed=False)
    assert "continuable" not in ans.notes


# ── ask() 가 질문 **전** 지문을 쓰는지 (구조 고정) ────────────────────

def test_ask_captures_the_fingerprint_before_asking():
    """질문 **후**에 찍으면 항상 stale 이 아니게 되어 판정이 무의미해진다."""
    import inspect

    src = inspect.getsource(SessionChannel.ask)
    before_idx = src.find("report_fingerprint")
    write_idx = src.find("stdin.write")
    assert before_idx != -1 and write_idx != -1
    assert before_idx < write_idx, "지문을 질문 전에 찍어야 한다"


# ── A3: 세션 답 타이밍 안내 ───────────────────────────────────────────
#
# ⚠️ `test_inspect_contract_wiring.py` 에 두지 않는다. 그 파일은 `plugin.bootstrap` 이
#    import 만으로 전역을 바꾸는 것 때문에 **격리 서브프로세스 스냅샷** 규약을 쓴다.
#    여기 테스트는 `secu_agent.agent.cli` 를 import 하는데(계약 상수 참조), 그건 모듈
#    레벨에서 코어 task_contract 를 등록한다 — 그 규약을 깨뜨릴 이유가 없다.


def test_one_shot_prompt_is_byte_identical(monkeypatch):
    """★ Phase 1 동등성 — 단발 검토원 프롬프트는 오늘과 **바이트 동일**해야 한다."""
    from _shared.inspect_contract import _lead_directive, _serve_answer_hint

    monkeypatch.delenv("SA_WORKER_SERVE", raising=False)
    assert _serve_answer_hint() == ""
    runner = _lead_directive({"target": {}})
    led = _lead_directive({"target": {"question": "q", "scope": "s"}})
    monkeypatch.setenv("SA_WORKER_SERVE", "1")
    assert _lead_directive({"target": {}}) == runner + _serve_answer_hint()
    assert _lead_directive({"target": {"question": "q", "scope": "s"}}) == (
        led + _serve_answer_hint())


def test_serve_hint_says_the_report_ends_the_answer(monkeypatch):
    """부르면 끝난다는 사실을 모르면 워커가 너무 일찍 부른다."""
    from _shared.inspect_contract import _serve_answer_hint

    monkeypatch.setenv("SA_WORKER_SERVE", "1")
    hint = _serve_answer_hint()
    assert "종료된다" in hint
    assert "빈 답" in hint


def test_serve_env_name_comes_from_the_core(monkeypatch):
    """★ env 이름을 손으로 옮겨 적으면 코어가 바꿀 때 조용히 안 붙는다."""
    import inspect

    from _shared import inspect_contract

    src = inspect.getsource(inspect_contract._serve_answer_hint)
    assert "from secu_agent.agent.cli import SERVE_MODE_ENV" in src
    assert '"SA_WORKER_SERVE"' not in src


@pytest.mark.parametrize("raw,on", [("1", True), ("true", True), ("on", True),
                                    ("0", False), ("", False), ("no", False)])
def test_serve_hint_flag_parsing(monkeypatch, raw, on):
    from _shared.inspect_contract import _serve_answer_hint

    monkeypatch.setenv("SA_WORKER_SERVE", raw)
    assert bool(_serve_answer_hint()) is on
