"""콘솔 발송 — 버튼이 눌렀을 때 나가는 길.

2026-08-25 사용자 요청: "직접 발송 버튼 누를 수 있게해줘. 에이전트랑 우선 동일한
화이트리스트 가드 넣어놓으면 되잖아."

★ **동일한 가드**란 곧 `deliver()` 를 거친다는 뜻이다. 같은 날 게이트를 안 타는 발송
라우트를 지웠고(`b0a9aa4`), 이 모듈이 그 자리를 대신하되 이번엔 관문을 통과한다.
"""
from __future__ import annotations

import inspect

import pytest


def test_send_takes_only_a_thread_reference_not_a_message():
    """★ 수신자·제목·본문을 **인자로 받지 않는다.**

    받으면 그게 곧 지운 그 문이다(`/owner-mail-send` 는 요청 본문을 그대로 MCP 로 보냈다).
    서버가 DB 에서 다시 읽어 구성해야 한다.
    """
    from service.services.console_send import send_thread

    params = set(inspect.signature(send_thread).parameters)
    assert params == {"domain", "thread_id", "requested_by"}, params
    for forbidden in ("recipients", "subject", "content", "body", "cc", "sender"):
        assert forbidden not in params, f"{forbidden} 을 받으면 게이트를 우회할 수 있다"


def test_send_goes_through_deliver_not_the_sink():
    """`deliver_sync` 를 부르고 `send_owner_mail`·sink 를 직접 부르지 않는다."""
    import service.services.console_send as m

    src = inspect.getsource(m)
    assert "deliver_sync(" in src
    for direct in ("send_owner_mail(", "call_knox_mail_tool(", ".send("):
        assert direct not in src, f"{direct} 직접 호출 — 게이트를 우회한다"


def test_blocked_is_a_result_not_an_exception(monkeypatch):
    """★ "막혔다" 를 예외로 만들면 화면이 **고장과 정책을 못 가른다.**

    게이트 차단은 `mode="dry_run"` + `reasons` 로 돌아와야 한다.
    """
    from secu_agent.agent.delivery import DeliveryResult

    import service.services.console_send as m

    monkeypatch.setattr(m, "_THREAD_GET", {
        "github": lambda tid: {"id": tid, "finding_id": 1, "repo": "org/repo",
                               "report_html": "<p>x</p>", "owner_recipient": "owner@samsung.com"},
    })
    monkeypatch.setattr(m, "_targets_for",
                        lambda d, o: {"mode": "normal", "recipients": o or ["owner@samsung.com"], "cc": []})
    monkeypatch.setattr(m, "_subject_for", lambda d, t: "제목")
    monkeypatch.setattr(m, "deliver_sync", lambda *a, **k: DeliveryResult(
        sink_id="knox_mail", mode="dry_run", detail="차단",
        reasons=("수신자 allowlist 밖",), scan_hits=(),
    ))
    monkeypatch.setattr(m, "_evidence_dir", lambda: __import__("pathlib").Path("/tmp"))

    out = m.send_thread(domain="github", thread_id=1)
    assert out["mode"] == "dry_run"
    assert out["reasons"] == ["수신자 allowlist 밖"]


def test_no_owner_is_a_failure_not_a_fallback_to_the_team_mailbox(monkeypatch):
    """담당자를 모르면 **발송 실패로 남긴다**(2026-08-24 결정).

    팀함으로 대신 보내면 "담당자에게 통보됨" 이 화면에 남는데 그건 거짓말이다.
    """
    import service.services.console_send as m
    from service.services.console_send import ConsoleSendError

    monkeypatch.setattr(m, "_THREAD_GET", {
        "github": lambda tid: {"id": tid, "finding_id": 1, "repo": "org/repo",
                               "report_html": "<p>x</p>", "owner_recipient": None},
    })
    monkeypatch.setattr(m, "_targets_for", lambda d, o: {"mode": "no_owner", "recipients": [], "cc": []})
    monkeypatch.setattr(m, "_subject_for", lambda d, t: "제목")

    with pytest.raises(ConsoleSendError, match="수신자가 없습니다"):
        m.send_thread(domain="github", thread_id=1)


def test_json_body_is_not_labelled_html(monkeypatch):
    """★ `report_html` 만 보면 세 도메인이 통째로 "본문 없음" 이 된다.

    실측 2026-08-25: github 991중 html 36 / json 991 · confluence 1중 html 0 / json 1 ·
    dev_web 은 html 컬럼 자체가 없고 json 137/137. 처음에 html 만 봐서 그렇게 됐었다.
    그리고 json 을 HTML 이라고 우기면 메일이 깨진다.
    """
    import service.services.console_send as m

    monkeypatch.setattr(m, "_targets_for",
                        lambda d, o: {"mode": "normal", "recipients": ["a@samsung.com"], "cc": []})
    monkeypatch.setattr(m, "_subject_for", lambda d, t: "제목")

    payload, _ = m._stored_payload("dev_web", {
        "finding_id": 1, "report_json": '{"a":1}', "owner_recipient": "a@samsung.com",
    })
    assert payload.body == '{"a":1}'
    assert payload.metadata["content_type"] == "TEXT"

    payload2, _ = m._stored_payload("dev_web", {
        "finding_id": 1, "report_html": "<p>x</p>", "owner_recipient": "a@samsung.com",
    })
    assert payload2.metadata["content_type"] == "HTML"


def test_console_evidence_is_separate_from_worker_evidence():
    """사람이 눌러 나간 것과 워커가 보낸 것은 나중에 반드시 갈라 봐야 한다."""
    from service.services.console_send import _EVIDENCE_DEFAULT, _EVIDENCE_ENV

    assert "console" in _EVIDENCE_DEFAULT
    assert _EVIDENCE_ENV.startswith("SA_")


# ── CLI — control-plane 이 자식 프로세스로 부르는 유일한 진입점 ────────────────
#
# 사용자 결정(2026-08-25): control-plane(Node)이 파이썬을 실행한다.
# ★ 이 방식의 유일한 위험은 **인자 주입**이라 거기에 테스트를 집중한다.

def test_cli_takes_no_message_fields():
    """★ 수신자·제목·본문을 인자로 받지 않는다 — 받으면 그게 곧 지운 `/owner-mail-send` 다."""
    import service.console_send_cli as cli

    assert cli.main(["--domain", "github", "--thread-id", "1",
                     "--recipients", "evil@x.com"]) == 3


def test_cli_rejects_vocabulary_outside_the_four_domains():
    import service.console_send_cli as cli

    assert cli.main(["--domain", "헛소리", "--thread-id", "1"]) == 3
    assert cli.main(["--domain", "smb; rm -rf /", "--thread-id", "1"]) == 3


def test_cli_rejects_non_integer_thread_id():
    """문자열이 그대로 아래로 흐르는 경로를 막는다."""
    import service.console_send_cli as cli

    assert cli.main(["--domain", "github", "--thread-id", "abc"]) == 3
    assert cli.main(["--domain", "github", "--thread-id", "1 OR 1=1"]) == 3
    assert cli.main(["--domain", "github", "--thread-id", "-5"]) == 3


def test_cli_strips_control_chars_from_the_audit_field():
    """★ 감사 문자열로 로그 한 줄을 여러 줄로 위조하지 못하게."""
    from service.console_send_cli import _clean

    assert "\n" not in _clean("shaneee\n2026-01-01 FAKE ENTRY")
    assert "\x00" not in _clean("a\x00b")
    assert len(_clean("x" * 500)) <= 200


def test_cli_exit_code_means_ran_not_sent(monkeypatch, capsys):
    """★ dry-run 은 **오류가 아니다** — 종료코드 0 이고 mode 로 구분한다.

    0이 아닌 코드로 만들면 호출부가 "고장" 과 "정책상 안 나감" 을 못 가른다.
    """
    import service.console_send_cli as cli
    import service.services.console_send as m

    monkeypatch.setattr(m, "send_thread", lambda **kw: {"mode": "dry_run", "reasons": ["막힘"]})
    rc = cli.main(["--domain", "github", "--thread-id", "1"])
    assert rc == 0
    import json as _json
    assert _json.loads(capsys.readouterr().out)["mode"] == "dry_run"


def test_cli_loads_runtime_env_itself():
    """★ 부모 환경에 기대면 안 된다.

    `*_REMEDIATION_MAIL_MODE` 가 없으면 `delivery_targets` 가 담당자 대신 DSSOC 를
    돌려주고 화면엔 "보냈다" 로 남는다. 실측(2026-08-25): 같은 스레드가 env 있을 때
    담당자, 없을 때 DSSOC 였다.
    """
    import inspect

    import service.console_send_cli as cli

    assert "load_runtime_env(" in inspect.getsource(cli.main)


def test_manual_send_stamps_the_ticket_number(monkeypatch):
    """★ 회신을 스레드에 붙이는 **1차 키**는 제목의 티켓번호다.

    2026-08-31 실측: 워커 발송 경로는 찍는데 **수동 발송만 안 찍었다**(4도메인 전부).
    그대로 두면 사람이 손으로 보낸 메일의 답장만 2차 키(제목 태그)로 떨어진다 —
    굳이 약한 쪽으로. `stamp_subject_for_thread` 주석이 "발송 경로는 전부 이걸 쓴다"
    고 말하고 있었는데 사실이 아니었다.
    """
    from secu_agent.agent.delivery import DeliveryResult

    import service.services.console_send as m

    seen: dict[str, str] = {}
    monkeypatch.setattr(m, "_THREAD_GET", {
        "github": lambda tid: {"id": tid, "finding_id": 1, "repo": "org/repo",
                               "report_html": "<p>x</p>", "owner_recipient": "owner@samsung.com"},
    })
    monkeypatch.setattr(m, "_targets_for",
                        lambda d, o: {"mode": "normal", "recipients": o, "cc": []})
    monkeypatch.setattr(m, "_subject_for", lambda d, t: "[GitHub 보안취약점 조치요청](org/repo) 시크릿")
    monkeypatch.setattr(m.state, "stamp_subject_for_thread",
                        lambda subject, dom, tid: subject.replace("조치요청]", "조치요청](GH00007)"))
    monkeypatch.setattr(m, "_evidence_dir", lambda: __import__("pathlib").Path("/tmp"))

    def _capture(sink, payload, **kw):
        seen["subject"] = payload.subject
        return DeliveryResult(sink_id="knox_mail", mode="sent", detail="", reasons=(), scan_hits=())

    monkeypatch.setattr(m, "deliver_sync", _capture)

    m.send_thread(domain="github", thread_id=7)
    assert "(GH00007)" in seen["subject"], "수동 발송 제목에 티켓번호가 없다"


def test_unwritable_evidence_dir_is_a_named_error_not_a_traceback(monkeypatch, tmp_path):
    """★ 만들 수 없는 경로면 **이름 있는 오류**로 말한다.

    2026-08-31: 기본값 `/var/lib/secu-agent/...` 는 root 소유라 mkdir 이 죽었고,
    CLI 가 트레이스백으로 종료해 콘솔엔 "요청 실패 (422) — send_failed" 만 떴다.
    사유가 화면까지 와야 운영자가 고칠 수 있다.
    """
    import service.services.console_send as m
    from service.services.console_send import ConsoleSendError

    monkeypatch.setenv(m._EVIDENCE_ENV, "/proc/1/이건-만들-수-없다")
    with pytest.raises(ConsoleSendError) as e:
        m._evidence_dir()
    assert m._EVIDENCE_ENV in str(e.value), "고칠 방법(환경변수 이름)을 말해야 한다"


def test_a_sent_mail_is_recorded_on_the_thread(monkeypatch):
    """★ 나갔으면 **나갔다고 쓴다.**

    2026-08-31 실측: 수동 발송이 `deliver_sync` 뒤에 아무것도 안 써서, 실제로 나간
    메일 1건이 `mail_message` 0행 · 상태 그대로였다. 화면엔 "통보됨" 이 안 뜨고
    발송 이력에도 없다 — 사람이 "안 갔나?" 하고 **한 번 더 보내게 된다.**
    """
    from secu_agent.agent.delivery import DeliveryResult

    import service.services.console_send as m

    calls: list[str] = []
    monkeypatch.setattr(m, "_THREAD_GET", {
        "github": lambda tid: {"id": tid, "finding_id": 1, "repo": "org/repo",
                               "subject_tag": "[tag]",
                               "report_html": "<p>x</p>", "owner_recipient": "owner@samsung.com"},
    })
    monkeypatch.setattr(m, "_targets_for",
                        lambda d, o: {"mode": "normal", "recipients": o, "cc": ["dssoc@samsung.com"]})
    monkeypatch.setattr(m, "_subject_for", lambda d, t: "제목")
    monkeypatch.setattr(m.state, "stamp_subject_for_thread", lambda s, d, t: s)
    monkeypatch.setattr(m, "_evidence_dir", lambda: __import__("pathlib").Path("/tmp"))
    monkeypatch.setattr(m, "deliver_sync", lambda *a, **k: DeliveryResult(
        sink_id="knox_mail", mode="sent", detail="", reasons=(), scan_hits=()))
    monkeypatch.setattr(m.state, "github_report_thread_set_status",
                        lambda tid, status, **kw: calls.append(f"status:{status}"))
    monkeypatch.setattr(m.state, "service_reply_message_add",
                        lambda **kw: calls.append(f"outbound:{kw.get('agent_verdict')}"))

    m.send_thread(domain="github", thread_id=7)

    assert "status:awaiting_owner" in calls, "통보 상태로 안 옮겼다"
    assert "outbound:sent" in calls, "발송 이력을 안 남겼다"


def test_recording_failure_does_not_look_like_a_send_failure(monkeypatch):
    """★ 메일은 이미 나갔다. 기록에 실패했다고 예외를 내면 화면엔 "발송 실패" 로 뜨고
    사람이 **한 번 더 보낸다.** 메일은 회수 경로가 없다."""
    from secu_agent.agent.delivery import DeliveryResult

    import service.services.console_send as m

    monkeypatch.setattr(m, "_THREAD_GET", {
        "github": lambda tid: {"id": tid, "finding_id": 1, "repo": "org/repo",
                               "report_html": "<p>x</p>", "owner_recipient": "owner@samsung.com"},
    })
    monkeypatch.setattr(m, "_targets_for",
                        lambda d, o: {"mode": "normal", "recipients": o, "cc": []})
    monkeypatch.setattr(m, "_subject_for", lambda d, t: "제목")
    monkeypatch.setattr(m.state, "stamp_subject_for_thread", lambda s, d, t: s)
    monkeypatch.setattr(m, "_evidence_dir", lambda: __import__("pathlib").Path("/tmp"))
    monkeypatch.setattr(m, "deliver_sync", lambda *a, **k: DeliveryResult(
        sink_id="knox_mail", mode="sent", detail="", reasons=(), scan_hits=()))

    def _boom(*a, **k):
        raise RuntimeError("DB 죽음")

    monkeypatch.setattr(m.state, "github_report_thread_set_status", _boom)

    out = m.send_thread(domain="github", thread_id=7)
    assert out["mode"] == "sent", "기록 실패가 발송 결과를 뒤집으면 안 된다"
