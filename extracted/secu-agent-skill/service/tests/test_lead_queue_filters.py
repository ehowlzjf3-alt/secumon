"""리드 큐 필터 — stale 임계와 롤링 재점검 (2026-08-28, Q3·Q4).

## 왜 생겼나

평면 태스크 레인을 은퇴시키면서 두 조건이 갈 곳을 잃었다:

  Q4 stale 임계  — 옛 백스톱은 `claimed_at < now-N` 을 보고 claim 을 풀었다. 리드는
                   `claimable_statuses` 에 `in_progress` 를 넣어 다시 집긴 하는데
                   **그 검사가 없어서** 살아 있는 검토원의 타깃까지 다시 위임한다.
                   영구히 잠기진 않지만 LLM 예산을 두 배로 태운다.
  Q3 롤링 재점검 — "7일 지난 triaged_completed 재점검" 은 은퇴한
                   `smb_task_claim_next` 에만 있었다. 주 1회 사이클 설계가
                   코드에서 사라져 있었다.

⚠️ 단건 조회(`limit=1, id=...`)는 이 필터를 **안 탄다** — 상세 화면이 자기 타깃을
   못 찾게 되면 안 된다. 그래서 옵트인 파라미터다.
"""
from __future__ import annotations

import time

import service.state_domain as sd

_STALE = sd.LEAD_INFLIGHT_STALE_SECONDS


def _share(seed, host: str, **fields):
    sid = seed.share(host=host, share="s")
    if fields:
        sd.share_set_status(sid, fields.pop("status", "walked"), **fields)
    return int(sid)


def test_fresh_in_progress_is_hidden_but_stale_is_not(seed):
    """★ 아직 도는 검토원의 타깃은 목록에서 빠지고, 묵은 것은 남는다."""
    now = time.time()
    fresh = _share(seed, "10.0.0.1", status="in_progress", claimed_by=1, claimed_at=now - 60)
    stale = _share(seed, "10.0.0.2", status="in_progress", claimed_by=1, claimed_at=now - _STALE - 60)

    ids = {r["id"] for r in sd.lead_targets_overview(
        "smb_share", limit=50, order_by="id DESC", skip_fresh_claims=True)}
    assert fresh not in ids, "아직 도는 타깃이 다시 위임 후보로 나왔다"
    assert stale in ids, "묵은 claim 이 회수되지 않는다"


def test_skip_fresh_claims_is_opt_in(seed):
    """옵트인이 아니면 단건 조회·기존 호출부가 조용히 바뀐다."""
    now = time.time()
    fresh = _share(seed, "10.0.0.1", status="in_progress", claimed_by=1, claimed_at=now - 60)
    ids = {r["id"] for r in sd.lead_targets_overview("smb_share", limit=50, order_by="id DESC")}
    assert fresh in ids


def test_detail_lookup_still_finds_a_fresh_claim(seed):
    """⚠️ 상세는 필터를 타면 안 된다 — 자기 타깃을 못 찾으면 화면이 깨진다."""
    now = time.time()
    fresh = _share(seed, "10.0.0.1", status="in_progress", claimed_by=1, claimed_at=now - 60)
    assert sd.lead_targets_overview("smb_share", limit=1, id=fresh)


def test_retry_after_in_the_future_is_hidden(seed):
    now = time.time()
    later = _share(seed, "10.0.0.1", status="walked", retry_after=now + 3600)
    ready = _share(seed, "10.0.0.2", status="walked", retry_after=now - 10)

    ids = {r["id"] for r in sd.lead_targets_overview(
        "smb_share", limit=50, order_by="id DESC", respect_retry_after=True)}
    assert later not in ids, "백오프가 안 끝났는데 큐에 올라왔다"
    assert ready in ids


def test_rolling_recheck_keeps_old_completions_and_drops_recent(seed):
    """★ 7일 지난 완료분은 다시 보이고, 방금 끝낸 것은 안 보인다."""
    now = time.time()
    old = _share(seed, "10.0.0.1", status="triaged_completed", processed_at=now - 8 * 86400)
    recent = _share(seed, "10.0.0.2", status="triaged_completed", processed_at=now - 3600)

    ids = {r["id"] for r in sd.lead_targets_overview(
        "smb_share", limit=50, order_by="id DESC",
        recheck_after_seconds=sd.SMB_TASK_RESCAN_SECONDS)}
    assert old in ids, "7일 지난 완료분이 재점검 큐에 안 올라온다"
    assert recent not in ids, "방금 끝낸 것을 또 준다"


def test_every_lead_adapter_passes_the_stale_filter():
    """★ 배선이 빠지면 조용하다 — 필터는 기본값이 False 라 아무 신호도 없다."""
    import inspect

    from domains.dev_web.plugin import lead_adapter as dw
    from domains.services.confluence.plugin import lead_adapter as cf
    from domains.services.github.plugin import lead_adapter as gh
    from domains.smb.plugin import lead_adapter as smb

    for mod in (smb, dw, gh, cf):
        src = inspect.getsource(mod)
        assert "skip_fresh_claims=True" in src, f"{mod.__name__}: stale 필터 미배선"
        assert "respect_retry_after=True" in src, f"{mod.__name__}: retry_after 미배선"
    # 롤링 재점검은 smb 만 (다른 도메인은 자체 cycle_key 로 돈다)
    assert "recheck_after_seconds" in inspect.getsource(smb)


# ── 행정적 제외 축 (2026-08-29, 항목 A) ────────────────────────────────────

def test_marked_rows_are_hidden_from_the_queue_but_not_from_detail(seed):
    """★ print$ 는 설계상 점검 제외다 — 그런데 리드 목록을 그게 다 차지하고 있었다.

    실기동 실측(2026-08-29): smb 큐 2,707행 중 2,463(91%)이 `print$`
    (`excluded_reason='print'`)이고 `last_seen DESC` 상위를 전부 차지해,
    리드의 무필터 목록 200행이 **전부 프린터 공유**였다. 그 결과
    `report_no_targets` 5건이 전부 `accepted=false` 로 막혔고 — 근거가 매번 print$ —
    리드에게 합법적 출구가 원리적으로 없었다. 궁지에 몰린 리드가 프린터 공유에
    `open_inspection` 3회, `set_target_status` 28회(`closed` 4건 포함)를 썼다.

    ⚠️ 상세 조회(`limit=1, id=...`)는 계속 열려야 한다 — 제외된 공유도 사람이 볼 수 있어야
       하고, 웹 노출 목록(`services/shares.py`)은 이 행을 그대로 쓴다.
    """
    keep = _share(seed, "10.0.0.1")
    drop = _share(seed, "10.0.0.2")
    sd.share_mark_excluded(drop, "print", summary="printer share")

    ids = {r["id"] for r in sd.lead_targets_overview(
        "smb_share", limit=50, order_by="id DESC", exclude_marked=True)}
    assert keep in ids
    assert drop not in ids, "행정적 제외 행이 점검 큐에 남았다"

    # 상세는 그대로
    assert sd.lead_targets_overview("smb_share", limit=1, id=drop), "제외 행이 상세에서도 사라졌다"


def test_exclusion_is_opt_in(seed):
    """옵트인이 아니면 단건 조회·기존 호출부가 조용히 바뀐다."""
    drop = _share(seed, "10.0.0.2")
    sd.share_mark_excluded(drop, "print", summary="printer share")
    ids = {r["id"] for r in sd.lead_targets_overview("smb_share", limit=50, order_by="id DESC")}
    assert drop in ids


def test_exclusion_filter_fails_closed_on_unregistered_tables():
    """⚠️ 조용히 넘기면 **fail-open** 이다 — 제외 대상이 그대로 돌아온다.

    `_LEAD_TIME_COLS` 는 컬럼이 없으면 조용히 필터를 안 걸지만(시각 필터는 그래도 안전),
    제외 필터는 반대다. 등록 안 된 테이블에 넘기는 건 배선 실수이므로 소리 내서 죽는다.
    """
    import pytest as _pytest

    for table in ("dev_web_target", "devops_target", "confluence_space_target"):
        with _pytest.raises(ValueError, match="제외 컬럼이 없다"):
            sd.lead_targets_overview(table, limit=1, exclude_marked=True)


def test_every_table_with_an_exclusion_column_is_filtered_by_its_adapter(seed):
    """★ 배선 누락을 **행동으로** 잡는다 — 소스 문자열 검사는 못 잡는다.

    처음엔 `"exclude_marked=True" in inspect.getsource(mod)` 로 썼는데, 배선을
    `# exclude_marked=True,` 로 주석 처리해도 **문자열은 남아 통과했다**(mutation check
    로 발견). 이 레포가 반복해서 데인 자리다 — `.claude/skills/measure-first` 참조:
    grep 은 주석을 소비자로 센다.

    그래서 어댑터를 **실제로 불러** 제외 행이 안 나오는지 본다.
    맵에 등록된 테이블 전부를 도니, 5번째 도메인이 제외 컬럼을 갖게 돼도 잡힌다.
    """
    from domains.smb.plugin.lead_adapter import smb_lead_adapter

    # 테이블 → 그 테이블을 읽는 리드 어댑터 (맵이 늘면 여기도 늘어야 한다)
    BY_TABLE = {"smb_share": smb_lead_adapter}
    missing = set(sd._LEAD_EXCLUDE_COLS) - set(BY_TABLE)
    assert not missing, f"제외 컬럼이 생긴 테이블에 어댑터 매핑이 없다: {missing}"

    for table, factory in BY_TABLE.items():
        keep = _share(seed, "10.9.0.1")
        drop = _share(seed, "10.9.0.2")
        sd.share_mark_excluded(drop, "print", summary="printer share")

        ids = {r["id"] for r in factory().list_targets(status=None, limit=200)}
        assert keep in ids, f"{table}: 정상 타깃이 목록에서 사라졌다"
        assert drop not in ids, (
            f"{table}: 어댑터가 exclude_marked 를 안 넘긴다 — 행정적 제외 행이 점검 큐에 샌다"
        )


def test_exclusion_does_not_hide_the_rolling_recheck_queue(seed):
    """★ 제외 축과 status 축을 섞으면 안 된다.

    claimable 만 남기는 방식(설계안 a)은 `triaged_completed` 를 영구히 숨겨
    7일 롤링 재점검(Q3)을 죽인다. 제외 축으로 거르면 그게 살아 있어야 한다.
    """
    import time
    old = _share(seed, "10.0.0.3", status="triaged_completed",
                 processed_at=time.time() - 8 * 86400)
    ids = {r["id"] for r in sd.lead_targets_overview(
        "smb_share", limit=50, order_by="id DESC", exclude_marked=True,
        recheck_after_seconds=sd.SMB_TASK_RESCAN_SECONDS)}
    assert old in ids, "제외 필터가 롤링 재점검 대상까지 숨겼다"


# ── 항목 C: 이름이 거짓말하던 숫자 (2026-08-29) ────────────────────────────

def test_share_level_count_is_named_for_what_it_actually_is(seed):
    """★ `smb_share.hits_count` 는 탐지 건수가 아니라 **제출된 finding 개수**다.

    `smb_submit_finding_tool.py:442` 가 제출 때 `hits_count = COALESCE(hits_count,0)+1`,
    `lead_adapter._set_status` 가 `fields["hits_count"] = finding_count` 로 덮는다.

    실측 2026-08-29: share 1695 는 이 값이 **1**인데 raw hit 이 **15,500건**이다.
    `hits_count` 라는 이름으로 리드에게 주면 "탐지 0건 = 깨끗한 공유" 로 읽힌다.

    ⚠️ 파일 단위 `smb_file.hits_count` 는 **진짜 hit 수**다(`state_domain.py:2487` 이
       `COUNT(*) FROM smb_file_hit` 로 채운다). 이름이 맞으므로 상세에선 그대로 쓴다.
       같은 이름의 두 컬럼이 서로 다른 것을 뜻한다 — 그래서 리드 목록만 고친다.
    """
    from domains.smb.plugin.lead_adapter import smb_lead_adapter

    sid = _share(seed, "10.7.0.1")
    rows = [r for r in smb_lead_adapter().list_targets(status=None, limit=50)
            if r["id"] == sid]
    assert rows, "시드한 공유가 목록에 없다"
    item = rows[0]
    assert "finding_count" in item, "리드 목록이 여전히 거짓 이름을 쓴다"
    assert "hits_count" not in item, (
        "`hits_count` 라는 이름이 남아 있다 — 탐지 수로 오독된다"
    )


def test_detail_keeps_the_real_per_file_hit_count(seed):
    """파일 단위는 진짜 hit 수라 이름이 맞다 — 같이 바꾸면 안 된다."""
    from domains.smb.plugin.lead_adapter import _target_detail

    sid = seed.share(host="10.7.0.2", share="s")
    fid = seed.file(sid, path="a/b.env")
    seed.hit(fid, category="secret", kind="generic_password_assignment")

    files = (_target_detail(sid) or {}).get("files") or []
    assert files and "hits_count" in files[0], "파일 단위 hit 수가 사라졌다"


def test_started_hosts_come_before_untouched_ones(seed):
    """★ 시작한 host 를 먼저 끝낸다 (사용자 결정 2026-08-31).

    smb 는 host 의 공유를 **다 봐야** 메일 한 통으로 묶어 보낸다. `last_seen DESC` 는
    host 를 섞어서, 141개 host 를 하나씩 찔러 놓고 아무것도 완성하지 못했다 —
    창 200행에 서로 다른 host 122개, draft 스레드 25건이 공유 1~3개만 남기고 멈춤.
    완성이 곧 발송이므로, **이미 스레드가 열린 host** 가 먼저 와야 한다.
    """
    # 손 안 댄 host: 공유 2개
    _share(seed, "10.0.0.1")
    _share(seed, "10.0.0.1")
    # 시작한 host: 공유 1개 남음 + 조치요청 스레드가 draft 로 열려 있다
    started = _share(seed, "10.0.0.2")
    sd.mail_thread_upsert(finding_id=1, host="10.0.0.2", share_id=started,
                          subject_tag="[t](10.0.0.2)", severity="low",
                          recipient=None, status="draft")

    rows = sd.lead_targets_overview("smb_share", status="walked", limit=10,
                                    order_by="started_host_first")

    assert rows, "큐가 비면 아무것도 증명하지 못한다"
    assert rows[0]["host"] == "10.0.0.2", (
        "메일이 걸려 있는 host 가 먼저 와야 한다 — 그 host 를 끝내야 발송된다"
    )


def test_fewer_remaining_shares_first(seed):
    """★ 남은 게 적은 host 부터 — **가장 빨리 메일이 나가는 순서**다."""
    # ⚠️ `_share` 는 공유 이름을 "s" 로 고정한다 — 같은 host 로 여러 번 부르면 upsert 라
    #    **같은 행을 덮어쓴다**(처음에 그렇게 썼다가 3개가 1개였다). 이름을 달리 준다.
    for n in range(3):
        seed.share(host="10.0.0.3", share=f"s{n}")   # 3개 남음
    seed.share(host="10.0.0.4", share="s0")          # 1개 남음

    rows = sd.lead_targets_overview("smb_share", status="walked", limit=10,
                                    order_by="started_host_first")

    assert rows[0]["host"] == "10.0.0.4"


def test_host_ordering_fails_closed_on_other_tables():
    """⚠️ 이 정렬은 상관 서브쿼리라 **smb_share 를 탄다.** 다른 테이블에 걸면 SQL 에러다.

    조용히 다른 정렬로 떨어뜨리면 "왜 순서가 안 바뀌지" 를 며칠 뒤에 묻게 된다.
    """
    import pytest as _pytest

    for table in ("dev_web_target", "devops_target", "confluence_space_target"):
        with _pytest.raises(ValueError, match="전용"):
            sd.lead_targets_overview(table, limit=1, order_by="started_host_first")


def test_dev_web_mail_blocked_targets_come_first(seed):
    """★ dev_web 판 — **메일이 걸린 target 을 먼저 끝낸다**(smb 와 같은 규칙).

    dev_web 은 target 하나가 스레드 하나라 "묶기" 는 없지만, 제출 시점에 스레드가
    draft 로 열리고 target 이 종료돼야 큐로 올라간다. 그 사이에 멈춘 것이 곧 안 나가는
    메일이다(실측 2026-08-31: draft 8건이 target in_progress 로 대기).
    """
    blocked = sd.dev_web_target_upsert(domain="b.example.com", url="https://b.example.com",
                                       source="test", day_bucket="2026-08-31")
    blocked = int(blocked[1] if isinstance(blocked, tuple) else blocked)
    fresh = sd.dev_web_target_upsert(domain="a.example.com", url="https://a.example.com",
                                     source="test", day_bucket="2026-08-31")
    fresh = int(fresh[1] if isinstance(fresh, tuple) else fresh)
    sd.dev_web_report_thread_upsert(
        target_id=blocked, finding_id=1, domain="b.example.com", url="https://b.example.com",
        subject_tag="[t]", severity="low", recipient=None, status="draft",
    )

    rows = sd.lead_targets_overview("dev_web_target", limit=10,
                                    order_by="started_target_first")

    assert rows[0]["id"] == blocked, "메일이 걸린 target 이 먼저 와야 한다"
    assert fresh in [r["id"] for r in rows]


def test_each_ordering_only_runs_on_the_tables_it_knows():
    """⚠️ 상관 서브쿼리는 테이블을 탄다 — 조용히 다른 정렬로 떨어지면 안 된다.

    `started_target_first` 는 대상 테이블 셋(dev_web·github·confluence)에서 유효하고,
    `started_host_first` 는 smb 전용이다(공유가 여럿 달리는 축이 host 라서).
    """
    import pytest as _pytest

    # 대상 축 정렬 — 각자 자기 테이블에서는 돈다.
    for table in ("dev_web_target", "devops_target", "confluence_space_target"):
        sd.lead_targets_overview(table, limit=1, order_by="started_target_first")
    # host 축 테이블에는 안 걸린다.
    with _pytest.raises(ValueError, match="전용"):
        sd.lead_targets_overview("smb_share", limit=1, order_by="started_target_first")
    # 반대도 마찬가지.
    with _pytest.raises(ValueError, match="전용"):
        sd.lead_targets_overview("dev_web_target", limit=1, order_by="started_host_first")


def test_high_severity_shares_come_first(seed):
    """★ 높음 이상을 먼저 본다 (사용자 결정 2026-08-31).

    ⚠️ **NULL 함정.** `severity IN ('critical','high')` 는 severity 가 NULL 이면 NULL 이고,
       postgres 의 `DESC` 는 NULL 을 **먼저** 놓는다. 그래서 처음 구현에서 심각도를
       모르는 공유가 높음을 제치고 맨 위로 올라왔다(실측으로 잡았다).
       점검 전 공유는 대부분 severity 가 비어 있으므로 이 함정이 곧 기본 동작이 된다.
    """
    seed.share(host="10.0.1.1", share="s0")                      # severity 없음
    hi = seed.share(host="10.0.1.2", share="s0")
    sd.share_set_status(hi, "walked", severity="high")

    rows = sd.lead_targets_overview("smb_share", status="walked", limit=10,
                                    order_by="started_host_first")

    assert rows[0]["host"] == "10.0.1.2", "높음이 '모름' 보다 먼저 와야 한다"


def test_report_queue_claims_high_severity_first(tmp_db):
    """★ 보고 큐도 높음 이상을 먼저 집는다. 예전엔 `updated_at ASC` 순수 FIFO 라
    심각 3건·높음 5건이 낮음 21건 뒤에 줄 서 있었다(실측 2026-08-31)."""
    import time

    for host, sev in (("10.0.2.1", "low"), ("10.0.2.2", "critical")):
        sd.mail_thread_upsert(finding_id=hash(host) % 10000, host=host, share_id=None,
                              subject_tag=f"[t]({host})", severity=sev,
                              recipient=None, status="reported")
        time.sleep(0.01)   # 낮음이 **먼저** 들어가게 — FIFO 면 낮음이 이긴다

    claimed = sd.mail_thread_claim_next(session_id=1, status="reported")

    assert claimed is not None
    assert claimed["host"] == "10.0.2.2", "심각이 먼저 나와야 한다(FIFO 로 떨어지면 안 된다)"
