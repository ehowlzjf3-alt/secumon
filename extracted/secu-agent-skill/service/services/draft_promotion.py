"""초안 → 조치요청 큐 **승격** — smb·dev_web 한 곳에.

## 왜 이 파일이 있나 (2026-08-31 실측)

두 도메인은 스레드를 먼저 열고(`draft`) 대상 점검이 끝나면 큐로 올린다. 한 대상에서
찾은 것을 **한 통으로 묶어** 보내기 위해서다 — 공유 3개를 따로 보내면 담당자가 같은
PC 로 메일을 세 번 받는다.

그 승격을 **사건(edge)** 에 걸어 뒀던 게 문제였다:

    smb      `inspect_contract._close_queue` 가 "마지막 공유가 닫히는 순간" 한 번
             → 그 순간을 놓친 26/51건이 멈춰 있었다(절반)
    dev_web  `dev_web_report_thread_promote_target` — **호출부가 테스트뿐**이었다
             → 55건 전부 멈춰 있었다. 한 번도 동작한 적이 없다.

⇒ 순간이 아니라 **상태**를 본다. 매 패스마다 "끝났는데 안 올라간 것" 을 줍는다.
  러너가 어댑터의 `sync_threads` 로 부른다. 한 번 놓쳐도 다음 패스가 줍는다.

## 두 도메인이 다른 점

"끝났다" 의 정의만 다르다 — 그것만 각자 알고, 나머지는 같다.

    smb      그 host 의 열린 공유 수 == 0        (`smb_task_host_open_count`)
    dev_web  그 target 이 종료 상태             (`tasked`·`skipped`·`error`)
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

#: dev_web 타깃의 종료 상태 — `domain_reports._TERMINAL_TARGET_STATUSES` 와 같은 어휘.
#: ⚠️ 두 곳이 갈리면 "끝난 걸 안 올린다" 나 "안 끝난 걸 올린다" 중 하나가 된다.
_DEV_WEB_TERMINAL = frozenset({"tasked", "skipped", "error"})


def promote_smb_host_drafts(*, limit: int = 200) -> dict[str, int]:
    """공유 점검이 끝난 host 의 초안을 조치요청 큐로 올린다.

    ⚠️ 주기 필터는 건드리지 않는다. `mail_thread_promote_host_drafts` 는 현재 주기
       초안만 올리는데, 그건 **지난주 스캔 결과를 오늘 사실처럼 보내지 않으려는**
       안전장치다. 넓히려면 신선도를 어떻게 보장할지 먼저 정해야 한다.
    """
    from service import state_domain as state

    try:
        from service.agents.smb_task_agent import _task_session_id

        session_id = _task_session_id()
    except Exception:  # noqa: BLE001 — 세션을 못 얻으면 이번 패스는 건너뛴다
        log.warning("[smb] 초안 승격: 태스크 세션을 못 얻었다", exc_info=True)
        return {"seen": 0, "promoted": 0, "waiting": 0}

    with state.connect() as c:
        # ★ 높음 이상 host 를 먼저 올린다(사용자 결정 2026-08-31). 한 host 에 스레드가
        #   여럿일 수 있으므로 **그 host 의 최고 등급**으로 줄 세운다.
        hosts = [str(r["host"]) for r in c.execute(
            "SELECT host, min(CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 "
            "                               WHEN 'medium' THEN 2 ELSE 3 END) AS rank "
            "FROM mail_thread WHERE status='draft' "
            "  AND host IS NOT NULL AND host <> '' "
            "GROUP BY host ORDER BY rank ASC, host ASC LIMIT ?",
            (int(limit),),
        )]

    # ★ 이미 큐에 살아 있는 스레드가 있는 host 는 건너뛴다.
    #   재스탬프(restamp_cycle)를 켜면서 실제로 당했다: 지난 주기 초안을 올렸는데
    #   같은 host 에 이번 주기 스레드가 이미 있어서 **열린 스레드가 둘**이 됐다
    #   (2026-08-31: 12.36.137.172 · 12.98.64.119). 그대로 두면 담당자가 같은 PC 건으로
    #   메일을 두 번 받는다 — 스레드를 host 로 묶는 이유 자체가 무너진다.
    with state.connect() as c:
        live = {str(r["host"]) for r in c.execute(
            "SELECT DISTINCT host FROM mail_thread "
            "WHERE status NOT IN ('draft','closed','remediated','resolved','false_positive') "
            "  AND host IS NOT NULL"
        )}

    promoted = waiting = skipped = superseded = 0
    cycle_key = state.smb_current_cycle_key()
    for host in hosts:
        if host in live:
            skipped += 1
            # ★ 지난 주기 잔여물은 **닫는다**(사용자 결정 2026-08-31 "지난 주 잔여물은
            #   없애줘라"). 같은 host 를 이번 주기 스레드가 이미 다루고 있으므로 이 초안은
            #   영원히 초안으로 남는다 — 화면엔 "안 나간 높음 N건" 으로 계속 보이는데
            #   사실이 아니다. 이번 주기 초안은 건드리지 않는다(그건 진행 중인 일이다).
            superseded += _close_superseded_drafts(state, host, cycle_key)
            continue
        try:
            if state.smb_task_host_open_count(host, session_id=session_id) != 0:
                waiting += 1
                continue
            # ★ 지난 주기 초안도 올린다(사용자 결정 2026-08-31 "B로"). 높음 이상 8건이
            #   전부 W35 라 구조적으로 영원히 못 나가는 상태였다 — 새 주기엔 새 스레드가
            #   생기므로 옛 스레드는 유기된다. 근거가 지난주 스캔이라는 것은 감수한다.
            #   ⚠️ 위의 "열린 공유 0" 검사는 그대로다 — 절반만 본 host 는 여전히 안 올린다.
            promoted += int(
                state.mail_thread_promote_host_drafts(host, restamp_cycle=True) or 0
            )
        except Exception:  # noqa: BLE001 — host 하나가 패스를 죽이지 않는다
            log.warning("[smb] 초안 승격 실패 host=%s", host, exc_info=True)
    if promoted or skipped:
        log.info("[smb] 초안 승격 %s건 (host %s개 중 대기 %s · 이미 큐에 있음 %s · "
                 "대체된 지난주 초안 정리 %s)",
                 promoted, len(hosts), waiting, skipped, superseded)
    return {"seen": len(hosts), "promoted": promoted, "waiting": waiting,
            "skipped_live": skipped, "superseded_closed": superseded}


def _close_superseded_drafts(state, host: str, cycle_key: str) -> int:
    """이번 주기 스레드가 대체한 **지난 주기** 초안을 없앤다.

    ## 왜 닫지 않고 없애나 (2026-08-31)

    처음엔 `status='closed'` 로 닫았는데 화면에 **"종결"** 로 떴다 — 조치가 끝난 것처럼
    읽힌다. 사용자 지적: "아니 지금 종결로 나오잖아...". 아무것도 조치되지 않았고
    나가지도 않았다. 어휘에 "대체됨" 이 없으므로, 거짓 라벨을 붙이느니 행을 없앤다.

    ## 없애기 전에 finding 을 옮긴다

    ⚠️ 잔여 초안이 든 finding 이 현행 스레드에 **없을 수 있다.** 실측: 12.36.137.172 의
       잔여 초안은 finding 36625(열린 high), 현행 스레드는 37252·37253 — 같은 경로를
       이번 주에 다시 찾은 것이지 같은 행이 아니다. 그냥 지우면 36625 가 스레드를 잃는다.
       그래서 **현행 스레드로 옮기고** 지운다.

    ⚠️ 발송 이력이 있으면 손대지 않는다. 나간 메일의 근거를 지우면 안 된다.
    """
    import json as _json
    import time as _time

    removed = 0
    try:
        with state.connect() as c:
            drafts = [dict(r) for r in c.execute(
                "SELECT id, finding_id, finding_ids FROM mail_thread "
                "WHERE host=? AND status='draft' AND COALESCE(last_cycle_key,'') <> ?",
                (host, cycle_key),
            )]
            if not drafts:
                return 0
            live = c.execute(
                "SELECT id, finding_ids FROM mail_thread WHERE host=? "
                "  AND status NOT IN ('draft','closed','remediated','resolved','false_positive') "
                "ORDER BY updated_at DESC LIMIT 1",
                (host,),
            ).fetchone()
            if live is None:
                return 0
            live_id = int(live["id"])
            try:
                merged = list(_json.loads(str(live["finding_ids"] or "[]")))
            except (TypeError, ValueError):
                merged = []

            for d in drafts:
                sent = c.execute(
                    "SELECT count(*) AS n FROM mail_message WHERE thread_id=? AND direction='out'",
                    (int(d["id"]),),
                ).fetchone()
                if int((sent or {"n": 0})["n"] or 0):
                    continue   # 나간 적 있는 스레드는 건드리지 않는다
                try:
                    ids = list(_json.loads(str(d["finding_ids"] or "[]")))
                except (TypeError, ValueError):
                    ids = []
                if d["finding_id"] is not None:
                    ids.append(int(d["finding_id"]))
                for fid in ids:
                    if int(fid) not in merged:
                        merged.append(int(fid))
                c.execute("DELETE FROM mail_message WHERE thread_id=?", (int(d["id"]),))
                c.execute("DELETE FROM mail_thread WHERE id=?", (int(d["id"]),))
                removed += 1

            if removed:
                c.execute(
                    "UPDATE mail_thread SET finding_ids=?, updated_at=? WHERE id=?",
                    (_json.dumps(sorted(set(merged))), _time.time(), live_id),
                )
        return removed
    except Exception:  # noqa: BLE001 — 정리 실패가 승격 패스를 죽이지 않는다
        log.warning("[smb] 대체된 초안 정리 실패 host=%s", host, exc_info=True)
        return 0


def promote_dev_web_target_drafts(*, limit: int = 200) -> dict[str, int]:
    """점검이 끝난 target 의 초안을 조치요청 큐로 올린다.

    ★ 이 승격은 **한 번도 동작한 적이 없다**(2026-08-31 확인). 함수는 v3.x 부터 있었는데
      호출부가 테스트뿐이었고, 그래서 dev_web 초안 55건이 통째로 멈춰 있었다.
      그중 47건은 target 이 이미 종료 상태였다 — 보낼 수 있는데 큐에 없었다.
    """
    from service import state_domain as state

    with state.connect() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT th.target_id AS target_id, t.status AS target_status "
            "FROM dev_web_report_thread th "
            "  JOIN dev_web_target t ON t.id = th.target_id "
            "WHERE th.status='draft' AND th.target_id IS NOT NULL "
            "ORDER BY th.target_id LIMIT ?",
            (int(limit),),
        )]

    promoted = waiting = 0
    for row in rows:
        if str(row["target_status"] or "") not in _DEV_WEB_TERMINAL:
            waiting += 1
            continue
        try:
            # ★ 주차를 다시 찍고 올린다. dev_web 은 `last_cycle_key` 를 갱신하지 않아
            #   그 필터가 "이번 주 스캔" 이 아니라 "이번 주에 만들어진 스레드" 를 거른다 —
            #   지난주에 열린 스레드는 이번 주에 점검이 끝나도 영영 안 올라갔다
            #   (실측: 끝난 47건 중 44건이 W35 로 막혀 있었다).
            promoted += int(
                state.dev_web_report_thread_promote_target(
                    int(row["target_id"]), restamp_cycle=True,
                ) or 0
            )
        except Exception:  # noqa: BLE001 — 하나가 패스를 죽이지 않는다
            log.warning("[dev_web] 초안 승격 실패 target=%s", row["target_id"], exc_info=True)
    if promoted:
        log.info("[dev_web] 초안 승격 %s건 (대상 %s개 중 대기 %s개)",
                 promoted, len(rows), waiting)
    return {"seen": len(rows), "promoted": promoted, "waiting": waiting}
