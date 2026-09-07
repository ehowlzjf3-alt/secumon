from __future__ import annotations

import service.state_domain as sd


def test_draft_mail_thread_promotes_only_after_host_completion(tmp_db):
    action, thread_id = sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="high",
        status="draft",
    )
    assert action == "new"
    assert sd.mail_thread_get(thread_id)["status"] == "draft"
    assert sd.mail_thread_claim_next(session_id=1, status="reported") is None

    assert sd.mail_thread_promote_host_drafts("10.0.0.5") == 1
    claimed = sd.mail_thread_claim_next(session_id=1, status="reported")
    assert claimed is not None
    assert claimed["id"] == thread_id


def test_draft_mail_thread_merges_multiple_findings_by_host(tmp_db):
    sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="medium",
        status="draft",
    )
    action, thread_id = sd.mail_thread_upsert(
        finding_id=11,
        host="10.0.0.5",
        subject_tag="[보안취약점 조치요청](10.0.0.5)",
        severity="critical",
        status="draft",
    )
    assert action == "merged"
    thread = sd.mail_thread_get(thread_id)
    assert thread["status"] == "draft"
    assert thread["severity"] == "critical"
    assert sd.mail_thread_finding_ids(thread_id) == [10, 11]


def test_inbound_match_excludes_draft_and_terminal_threads(tmp_db):
    tag = "[보안취약점 조치요청](10.0.0.5)"
    _, old_id = sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag=tag,
        status="awaiting_reply",
    )
    sd.mail_thread_set_status(old_id, "closed")
    _, draft_id = sd.mail_thread_upsert(
        finding_id=11,
        host="10.0.0.5",
        subject_tag=tag,
        status="draft",
    )

    assert sd.mail_thread_find_inbound_match(tag) is None

    sd.mail_thread_set_status(draft_id, "awaiting_reply")
    assert sd.mail_thread_find_inbound_match(tag)["id"] == draft_id


def test_inbound_match_prefers_latest_outbound_thread_even_when_hitl(tmp_db):
    tag = "[보안취약점 조치요청](10.0.0.5)"
    _, old_id = sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag=tag,
        status="awaiting_reply",
        cycle_key="2026-W25",
    )
    sd.mail_message_add(
        direction="out",
        thread_id=old_id,
        subject=tag,
        agent_verdict="sent",
        received_at=100.0,
    )
    _, current_id = sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.5",
        subject_tag=tag,
        status="reported",
        cycle_key="2026-W27",
    )
    sd.mail_thread_set_status(current_id, "owner_reassignment_review")
    sd.mail_message_add(
        direction="out",
        thread_id=current_id,
        subject=tag,
        agent_verdict="sent",
        received_at=200.0,
    )
    # An old worker touching the stale thread must not make it win.
    with sd.connect() as c:
        c.execute("UPDATE mail_thread SET updated_at=300 WHERE id=?", (old_id,))

    matched = sd.mail_thread_find_inbound_match_at(tag, received_at=250.0)

    assert matched is not None
    assert matched["id"] == current_id


def test_inbound_match_does_not_fall_back_to_stale_cycle_for_old_reply(tmp_db):
    tag = "[보안취약점 조치요청](10.0.0.6)"
    _, old_id = sd.mail_thread_upsert(
        finding_id=20,
        host="10.0.0.6",
        subject_tag=tag,
        status="awaiting_reply",
        cycle_key="2026-W25",
    )
    sd.mail_message_add(
        direction="out",
        thread_id=old_id,
        subject=tag,
        agent_verdict="sent",
        received_at=100.0,
    )
    _, current_id = sd.mail_thread_upsert(
        finding_id=20,
        host="10.0.0.6",
        subject_tag=tag,
        status="reported",
        cycle_key="2026-W27",
    )
    sd.mail_thread_set_status(current_id, "awaiting_reply")
    sd.mail_message_add(
        direction="out",
        thread_id=current_id,
        subject=tag,
        agent_verdict="sent",
        received_at=300.0,
    )

    assert sd.mail_thread_find_inbound_match_at(tag, received_at=250.0) is None


def test_reply_decision_and_reverify_result_are_structured(tmp_db):
    _, thread_id = sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.8",
        subject_tag="[보안취약점 조치요청](10.0.0.8)",
        status="reply_received",
    )
    message_id = sd.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="m-1",
        subject="RE: [보안취약점 조치요청](10.0.0.8)",
        body_excerpt="담당자 변경",
    )
    decision_id = sd.mail_reply_decision_add(
        thread_id=thread_id,
        message_id_pk=message_id,
        decision="owner_changed",
        confidence=0.9,
        reason="담당자 변경",
        extracted_owner={"email": "owner.two@samsung.com"},
        created_by="test",
    )
    result_id = sd.mail_reverify_result_add(
        thread_id=thread_id,
        finding_id=10,
        verdict="still_open",
        share="C$",
        path_prefix="Users",
        access={"auth_read": True},
        files_visible=2,
    )

    assert decision_id > 0
    assert result_id > 0
    assert sd.mail_reply_decision_latest(thread_id)["extracted_owner"]["email"] == "owner.two@samsung.com"
    assert sd.mail_reverify_latest_by_finding(thread_id)[10]["verdict"] == "still_open"


def test_reply_decision_add_is_idempotent_for_same_message_and_decision(tmp_db):
    _, thread_id = sd.mail_thread_upsert(
        finding_id=10,
        host="10.0.0.9",
        subject_tag="[보안취약점 조치요청](10.0.0.9)",
        status="reply_received",
    )
    message_id = sd.mail_message_add(
        direction="in",
        thread_id=thread_id,
        message_id="m-idempotent",
        subject="RE: [보안취약점 조치요청](10.0.0.9)",
        body_excerpt="조치완료했습니다.",
    )

    first_id = sd.mail_reply_decision_add(
        thread_id=thread_id,
        message_id_pk=message_id,
        decision="remediation_claim",
        confidence=0.9,
        reason="first pass",
        created_by="test",
    )
    second_id = sd.mail_reply_decision_add(
        thread_id=thread_id,
        message_id_pk=message_id,
        decision="remediation_claim",
        confidence=0.95,
        reason="retry pass",
        created_by="test",
    )

    decisions = sd.mail_reply_decisions_for_thread(thread_id)
    assert second_id == first_id
    assert [d["decision"] for d in decisions] == ["remediation_claim"]


def test_ready_drafts_are_promoted_by_a_sweep_not_only_at_close(tmp_db, monkeypatch) -> None:
    """★ 승격이 "마지막 작업이 닫히는 순간" 하나에만 걸려 있으면, 그 순간을 놓친
    초안은 영원히 큐에 안 올라간다. 2026-08-31 실측으로 draft 51건 중 26건이
    그 상태였다 — 본문도 다 있는데 아무도 안 보냈다.

    상태를 보는 쓸기가 그걸 줍는다.
    """
    from service import state_domain as sd
    from service.services import smb_draft_report

    sd.mail_thread_upsert(finding_id=1, host="10.0.0.9", share_id=None,
                          subject_tag="[테스트] 10.0.0.9", severity="low",
                          recipient=None, status="draft")
    # 이 host 는 열린 작업이 없다 = 승격 대상.
    monkeypatch.setattr(sd, "smb_task_host_open_count", lambda host, session_id=None: 0)
    monkeypatch.setattr("service.agents.smb_task_agent._task_session_id", lambda: 1)

    out = smb_draft_report.promote_ready_host_drafts()

    assert out["promoted"] == 1
    rows = sd.mail_threads_overview(status="reported", limit=10)
    assert any(str(r["host"]) == "10.0.0.9" for r in rows)


def test_open_host_drafts_are_left_alone(tmp_db, monkeypatch) -> None:
    """아직 훑는 중인 host 는 올리지 않는다 — 절반만 본 결과를 보내면 안 된다."""
    from service import state_domain as sd
    from service.services import smb_draft_report

    sd.mail_thread_upsert(finding_id=2, host="10.0.0.10", share_id=None,
                          subject_tag="[테스트] 10.0.0.10", severity="low",
                          recipient=None, status="draft")
    monkeypatch.setattr(sd, "smb_task_host_open_count", lambda host, session_id=None: 3)
    monkeypatch.setattr("service.agents.smb_task_agent._task_session_id", lambda: 1)

    out = smb_draft_report.promote_ready_host_drafts()

    assert out["promoted"] == 0 and out["waiting"] == 1


def test_smb_adapter_actually_calls_the_sweep(tmp_db, monkeypatch) -> None:
    """★ 함수만 있고 호출부가 0 이면 이 저장소가 반복해서 당한 그 모양이다.
    어댑터의 `sync_threads` 가 진짜로 이걸 부르는지 본다."""
    from service.services import smb_draft_report
    from domains.smb.plugin.thread_adapter import smb_thread_adapter

    called: list[int] = []
    monkeypatch.setattr(smb_draft_report, "promote_ready_host_drafts",
                        lambda **kw: called.append(1) or {"promoted": 0})
    adapter = smb_thread_adapter()
    assert adapter.sync_threads is not None
    adapter.sync_threads()
    assert called == [1]


def test_dev_web_ready_targets_are_promoted_too(tmp_db, monkeypatch) -> None:
    """★ dev_web 은 이 승격이 **한 번도 동작한 적이 없다**(2026-08-31 확인).

    `dev_web_report_thread_promote_target` 은 v3.x 부터 있었는데 호출부가 테스트뿐이라,
    초안 55건이 통째로 멈춰 있었다 — 그중 47건은 target 이 이미 종료 상태였다.
    """
    from service import state_domain as sd
    from service.services import draft_promotion

    tid = sd.dev_web_target_upsert(domain="a.example.com", url="https://a.example.com", source="test", day_bucket="2026-08-31")
    tid = int(tid[1] if isinstance(tid, tuple) else tid)
    _, thread_id = sd.dev_web_report_thread_upsert(
        target_id=tid, finding_id=1, domain="a.example.com", url="https://a.example.com",
        subject_tag="[t]", severity="low", recipient=None, status="draft",
    )
    sd.dev_web_target_set_status(tid, "tasked")   # 점검 끝

    out = draft_promotion.promote_dev_web_target_drafts()

    assert out["promoted"] == 1
    assert sd.dev_web_report_thread_get(int(thread_id))["status"] == "reported"


def test_dev_web_unfinished_targets_are_left_alone(tmp_db) -> None:
    """아직 보는 중인 target 은 올리지 않는다 — 절반만 본 결과를 보내면 안 된다."""
    from service import state_domain as sd
    from service.services import draft_promotion

    tid = sd.dev_web_target_upsert(domain="b.example.com", url="https://b.example.com", source="test", day_bucket="2026-08-31")
    tid = int(tid[1] if isinstance(tid, tuple) else tid)
    sd.dev_web_report_thread_upsert(
        target_id=tid, finding_id=2, domain="b.example.com", url="https://b.example.com",
        subject_tag="[t]", severity="low", recipient=None, status="draft",
    )
    sd.dev_web_target_set_status(tid, "in_progress")

    out = draft_promotion.promote_dev_web_target_drafts()

    assert out["promoted"] == 0 and out["waiting"] == 1


def test_the_parking_spot_is_not_undone_every_pass(tmp_db, monkeypatch) -> None:
    """★ 게이트가 세운 것을 동기화가 되돌리면 **순환**이 된다.

    실측 2026-08-31: dev_web 어댑터의 `sync_threads` 가 `report_ready → reported` 로
    되돌리는 함수였다. 최초 발송 게이트가 스레드를 report_ready 에 세우자 매 패스가
    그걸 되돌렸고, 워커가 LLM 을 다시 태웠다 — 한 스레드 **시도 72회**.
    되돌리는 문은 자율발송을 켜는 날 일부러 여는 것이지 매 패스 도는 게 아니다.
    """
    from domains.dev_web.plugin.thread_adapter import dev_web_thread_adapter
    from service import state_domain as sd

    tid = sd.dev_web_target_upsert(domain="c.example.com", url="https://c.example.com", source="test", day_bucket="2026-08-31")
    tid = int(tid[1] if isinstance(tid, tuple) else tid)
    _, thread_id = sd.dev_web_report_thread_upsert(
        target_id=tid, finding_id=3, domain="c.example.com", url="https://c.example.com",
        subject_tag="[t]", severity="low", recipient=None, status="draft",
    )
    sd.dev_web_report_thread_set_status(int(thread_id), "report_ready")

    adapter = dev_web_thread_adapter()
    assert adapter.sync_threads is not None
    adapter.sync_threads()

    assert sd.dev_web_report_thread_get(int(thread_id))["status"] == "report_ready", (
        "발송 게이트가 세워 둔 스레드를 동기화가 되돌리면 안 된다"
    )


def test_dev_web_last_weeks_thread_is_not_frozen_forever(tmp_db) -> None:
    """★ dev_web 에서 `last_cycle_key` 는 "이번 주 스캔" 이 아니라 **"이번 주에 만들어진
    스레드"** 를 뜻한다 — upsert 가 그 컬럼을 갱신하지 않기 때문이다.

    그래서 지난주에 열린 스레드는 이번 주에 점검이 끝나도 영영 안 올라갔다
    (실측 2026-08-31: 끝난 47건 중 **44건이 W35** 로 막혀 있었다).
    승격이 주차를 다시 찍는다 — `requeue_ready` 가 같은 이유로 하는 일이다.

    ⚠️ smb 의 주기 필터는 건드리지 않는다. 거긴 컬럼이 실제 스캔 주차를 따라간다.
    """
    from service import state_domain as sd
    from service.services import draft_promotion

    tid = sd.dev_web_target_upsert(domain="old.example.com", url="https://old.example.com",
                                   source="test", day_bucket="2026-08-24")
    tid = int(tid[1] if isinstance(tid, tuple) else tid)
    _, thread_id = sd.dev_web_report_thread_upsert(
        target_id=tid, finding_id=9, domain="old.example.com", url="https://old.example.com",
        subject_tag="[t]", severity="low", recipient=None, status="draft",
    )
    # 지난주에 만들어진 스레드로 만든다.
    with sd.connect() as c:
        c.execute("UPDATE dev_web_report_thread SET last_cycle_key='2026-W35' WHERE id=?",
                  (int(thread_id),))
    sd.dev_web_target_set_status(tid, "tasked")

    out = draft_promotion.promote_dev_web_target_drafts()

    assert out["promoted"] == 1, "지난주 스레드가 영영 막히면 안 된다"
    row = sd.dev_web_report_thread_get(int(thread_id))
    assert row["status"] == "reported"
    assert row["last_cycle_key"] == sd.smb_current_cycle_key(), (
        "주차를 안 찍으면 status 만 바뀌고 claim_next 가 여전히 못 집는다"
    )


def test_last_cycle_drafts_are_promoted_with_a_restamp(tmp_db, monkeypatch) -> None:
    """★ 지난 주기 초안도 올린다 (사용자 결정 2026-08-31 "B로").

    실측: 높음 이상 초안 8건이 전부 W35 였고, 승격이 현재 주기만 보므로 **구조적으로
    영원히 못 나가는** 상태였다(새 주기엔 새 스레드가 생겨 옛 스레드는 유기된다).
    근거가 지난주 스캔이라는 것은 감수한다.
    """
    from service import state_domain as sd
    from service.services import draft_promotion

    sd.mail_thread_upsert(finding_id=41, host="10.9.9.1", share_id=None,
                          subject_tag="[t](10.9.9.1)", severity="high",
                          recipient=None, status="draft")
    with sd.connect() as c:
        c.execute("UPDATE mail_thread SET last_cycle_key='2026-W01' WHERE host='10.9.9.1'")
    monkeypatch.setattr(sd, "smb_task_host_open_count", lambda host, session_id=None: 0)
    monkeypatch.setattr("service.agents.smb_task_agent._task_session_id", lambda: 1)

    out = draft_promotion.promote_smb_host_drafts()

    assert out["promoted"] == 1
    row = [r for r in sd.mail_threads_overview(status="reported", limit=20)
           if str(r["host"]) == "10.9.9.1"]
    assert row, "지난 주기 초안이 큐에 올라와야 한다"
    assert row[0]["last_cycle_key"] == sd.smb_current_cycle_key(), (
        "주차를 안 찍으면 claim_next 가 못 집는다"
    )


def test_a_host_that_already_has_a_live_thread_is_skipped(tmp_db, monkeypatch) -> None:
    """★ 같은 host 로 메일이 두 번 나가면 안 된다.

    재스탬프를 켜자마자 실제로 당했다(2026-08-31): 지난 주기 초안을 올렸는데 같은
    host 에 이번 주기 스레드가 이미 있어 **열린 스레드가 둘**이 됐다. 스레드를 host 로
    묶는 이유 자체가 무너진다.
    """
    from service import state_domain as sd
    from service.services import draft_promotion

    # 이미 큐에 있는 스레드
    sd.mail_thread_upsert(finding_id=51, host="10.9.9.2", share_id=None,
                          subject_tag="[t](10.9.9.2)", severity="high",
                          recipient=None, status="reported")
    # 같은 host 의 지난 주기 초안
    with sd.connect() as c:
        c.execute(
            "INSERT INTO mail_thread(finding_id, host, subject_tag, severity, status, "
            "  last_cycle_key, created_at, updated_at) "
            "VALUES(?,?,?,?,'draft','2026-W01',?,?)",
            (52, "10.9.9.2", "[t](10.9.9.2)", "high", 1.0, 1.0),
        )
    monkeypatch.setattr(sd, "smb_task_host_open_count", lambda host, session_id=None: 0)
    monkeypatch.setattr("service.agents.smb_task_agent._task_session_id", lambda: 1)

    out = draft_promotion.promote_smb_host_drafts()

    assert out["promoted"] == 0
    assert out["skipped_live"] == 1
