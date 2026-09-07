"""스레드 파이프라인 러너 — **4도메인 한 벌**. 조치요청·재검증 큐를 돈다.

## 무엇을 대체하는가 (실측 2026-08-31)

    github      service/agents/github_pipeline_runner.py    208줄
    confluence  service/agents/confluence_pipeline_runner.py 336줄  ← 둘이 240줄 차이
    dev_web     scripts/dev_web_loop.sh                     임시 셸 루프
    smb         (없음)                                       + 임시 셸 루프

같은 일(플래그 보고 큐 한 바퀴)을 넷이 제각각으로 했고, 둘은 아예 셸 루프였다.
그래서 `reply_verify`·`reverify` 플래그를 켜도 **아무도 안 봤다** — 켜고 끄는 게
동작하지 않는 상태였다.

⇒ 배관은 여기 한 벌. 도메인은 `ThreadAdapter` 로 자기 좌표만 낸다
  (`report_component`·`recheck_component`·`claim_next`·`deliver_report`·`deliver_recheck`).

## 통일하지 않은 것

컴포넌트 **이름**은 그대로 둔다 — `mail` · `github.report` · `confluence.report` ·
`dev_web_report`. 이미 사람이 켜고 끄던 `control_flag` 키라, 통일하면 그 조작이
다른 행을 가리킨다. 계약이 차이를 흡수한다(좌표 열 host/repo/space_key/url 과 같은 방식).

## ⚠️ 발송은 여기서 열리지 않는다

이 러너는 큐를 **돌리기만** 한다. 실제로 나가는지는 `owner_recipients` 의 최초 발송
게이트가 정한다(`SA_INITIAL_REPORT_AUTOSEND` 없으면 초안까지만). 러너를 켠다고
메일이 나가지 않는다 — 브레이크가 둘인 이유다(`docs/SEND-TEST-RUNBOOK.md`).
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import time
from typing import Any

from service import state_domain as state
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.thread_pipeline_runner")

DEFAULT_POLL_SECONDS = 60.0
#: 컴포넌트별 기본 주기(초). `control_flag.interval_seconds` 가 있으면 그쪽이 이긴다.
DEFAULT_INTERVAL_SECONDS = 120.0
#: 한 차례에 스레드를 몇 건까지 처리할까. ⚠️ 상한이 없으면 큐가 깊은 도메인이
#: 차례를 독점한다(리드 러너에서 같은 이유로 상한을 뒀다).
MAX_THREADS_ENV = "SA_THREAD_MAX_PER_TURN"
_MAX_THREADS_DEFAULT = 5
#: 스레드 한 건의 처리 상한(초). **없으면 한 건이 영원히 매달린다.**
#:
#: ★ `scripts/dev_web_loop.sh` 가 남긴 실측(2026-08-26): report 패스 하나가
#:   gateway.security.samsungds.net:443 소켓에 붙은 채 **17시간** 살아 있었다
#:   (ep_poll, 송수신 큐 0 — 오지 않을 응답 대기). 루프가 그 자식을 못 놓아
#:   dev_web 이 12시간 굶었는데, `pipeline_run` 엔 status='running' 으로 남아
#:   화면상으론 **일하는 중**이었다 — 죽은 것보다 나쁘다.
#:
#: ⚠️ HTTP 클라이언트 타임아웃이 따로 있어도 이 백스톱은 지우지 마라. 매달리는
#:    지점은 매번 다르고, 러너가 자기 작업을 못 놓는 것 자체가 결함이다.
THREAD_TIMEOUT_ENV = "SA_THREAD_PASS_TIMEOUT_SEC"
_THREAD_TIMEOUT_DEFAULT = 1800.0


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "") or default))
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return max(1.0, float(os.environ.get(name, "") or default))
    except ValueError:
        return default


async def _deliver_with_timeout(deliver: Any, thread: dict[str, Any], *, charter_ref: str,
                                timeout: float) -> Any:
    """한 건 처리에 상한을 건다 — 매달린 소켓이 러너를 통째로 잡지 않게."""
    return await asyncio.wait_for(deliver(thread, charter_ref=charter_ref), timeout=timeout)


def _latest_run_age(component: str) -> float | None:
    """마지막 실행 이후 흐른 초. 없으면 None(= 돌 때가 됐다).

    ⚠️ github 러너와 **같은 계산**을 쓴다 — 두 러너가 같은 컴포넌트를 볼 수 있는데
       주기 판정이 갈리면 하나가 다른 하나를 계속 앞질러 잡는다.
    """
    try:
        rows = state.pipeline_runs_recent(component, limit=1)
    except Exception:  # noqa: BLE001 — 못 재면 "돌 때가 됐다" 로 본다
        return None
    if not rows:
        return None
    ts = rows[0].get("finished_at") or rows[0].get("started_at")
    if not ts:
        return None
    return max(0.0, time.time() - float(ts))


def _should_run(component: str) -> bool:
    """플래그·주기를 보고 이번 차례에 돌릴지 정한다.

    ⚠️ `run_now` 를 **소비**한다(consume). 읽기만 하면 한 번 누른 것이 계속 발동한다.
    """
    flag = state.control_flag_get(component)
    if state.control_flag_consume_run_now(component):
        return True
    if not bool(int(flag.get("enabled", 1))):
        state.heartbeat_upsert(component, phase="disabled",
                               detail="control flag disabled", pid=os.getpid())
        return False
    interval = float(flag.get("interval_seconds") or DEFAULT_INTERVAL_SECONDS)
    age = _latest_run_age(component)
    if age is None or age >= interval:
        return True
    state.heartbeat_upsert(component, phase="idle",
                           detail=f"next due in {round(interval - age, 1)}s", pid=os.getpid())
    return False


def _drive(adapter: Any, *, kind: str, charter_ref: str) -> dict[str, Any]:
    """이 도메인의 큐를 한 차례 돈다. `kind` 는 report | recheck.

    ⚠️ 어댑터가 그 슬롯을 안 가지면 **없다고 말한다** — 조용한 no-op 금지
       (`ThreadAdapter` 머리말의 규칙).
    """
    deliver = adapter.deliver_report if kind == "report" else adapter.deliver_recheck
    if deliver is None:
        return {"skipped": f"{adapter.domain} 에 {kind} 배선이 없다"}

    statuses = adapter.claimable_statuses or ()
    status = statuses[0] if kind == "report" else (statuses[1] if len(statuses) > 1 else None)
    if not status:
        return {"skipped": f"{adapter.domain} 에 {kind} claim 상태가 없다"}

    if kind == "report" and adapter.sync_threads is not None:
        try:
            adapter.sync_threads()
        except Exception as e:  # noqa: BLE001 — 동기화 실패가 큐 처리를 막지 않는다
            log.warning("[thread-runner] %s sync 실패: %r", adapter.domain, e)
    try:
        adapter.reclaim_stale()
    except Exception as e:  # noqa: BLE001
        log.warning("[thread-runner] %s reclaim 실패: %r", adapter.domain, e)

    handled = errors = 0
    cap = _int_env(MAX_THREADS_ENV, _MAX_THREADS_DEFAULT)
    session_id = os.getpid()
    for _ in range(cap):
        try:
            thread = adapter.claim_next(session_id=session_id, status=status)
        except Exception as e:  # noqa: BLE001
            log.exception("[thread-runner] %s claim 실패", adapter.domain)
            return {"handled": handled, "errors": errors + 1, "error": repr(e)[:200]}
        if thread is None:
            break
        handled += 1
        try:
            asyncio.run(_deliver_with_timeout(
                deliver, thread, charter_ref=charter_ref,
                timeout=_float_env(THREAD_TIMEOUT_ENV, _THREAD_TIMEOUT_DEFAULT),
            ))
        except TimeoutError:
            # ⚠️ 조용히 넘기지 않는다. 다음 패스에서 같은 자리에 또 매달린다.
            errors += 1
            log.warning("[thread-runner] %s thread=%s 가 상한을 넘겨 중단됐다 (%ss)",
                        adapter.domain, thread.get("id"),
                        _float_env(THREAD_TIMEOUT_ENV, _THREAD_TIMEOUT_DEFAULT))
            try:
                adapter.bump_attempt(int(thread["id"]), reason="처리 시간 상한 초과")
            except Exception:  # noqa: BLE001
                pass
            continue
        except Exception as e:  # noqa: BLE001 — 한 건 실패가 나머지를 막지 않는다
            errors += 1
            log.exception("[thread-runner] %s thread=%s 처리 실패",
                          adapter.domain, thread.get("id"))
            try:
                adapter.bump_attempt(int(thread["id"]), reason=repr(e)[:200])
            except Exception:  # noqa: BLE001
                pass
    return {"handled": handled, "errors": errors, "status": status}


#: POP3 수집 주기(초). 매 패스마다 200통을 훑을 필요는 없다.
INBOX_POLL_ENV = "SA_INBOX_POLL_SECONDS"
_INBOX_POLL_DEFAULT = 120.0

#: 마지막 수집 시각(프로세스 로컬). 러너가 상주라 이것으로 충분하다.
_last_inbox_poll = 0.0


def _poll_inbox_if_due() -> dict[str, Any] | None:
    """답장을 가져온다 — **큐를 돌기 전에.**

    ## 왜 러너인가 (2026-09-01 실측)

    POP3 수집은 `reply_verify_agent.run_reply_pass` 안에 있었는데, 공용 러너는 그 함수를
    안 부른다(어댑터의 `deliver_recheck` 를 부른다). 그래서 **아무도 수집하지 않았다** —
    사람이 손으로 부를 때만 답장이 들어왔다.

    ★ 더 나쁜 건 순환이다: 수집이 **처리 안에** 있으면, 처리할 게 없으면 수집도 안 하고,
      수집을 안 하니 처리할 것도 안 생긴다. 방아쇠가 자기 자신인 구조다.

    ⇒ 수집은 큐를 돌기 **전에** 한 번. 실패해도 큐 처리를 막지 않는다.
    """
    global _last_inbox_poll

    now = time.time()
    interval = _float_env(INBOX_POLL_ENV, _INBOX_POLL_DEFAULT)
    if now - _last_inbox_poll < interval:
        return None
    _last_inbox_poll = now
    try:
        from service.collector import mail_inbound

        out = mail_inbound.poll_inbox()
        if int(out.get("new") or 0):
            log.info("[thread-runner] 답장 수집 %s건 (훑음 %s)",
                     out.get("new"), out.get("scanned"))
        return out
    except Exception as e:  # noqa: BLE001 — 수집 실패가 큐 처리를 막지 않는다
        log.warning("[thread-runner] 답장 수집 실패: %r", e)
        return {"error": repr(e)[:200]}


def run_once(*, charter_ref: str = "", only: str | None = None) -> dict[str, Any]:
    """켜져 있고 주기가 된 큐를 한 번씩 돈다 — 4도메인."""
    load_runtime_env(load_plugins=True)
    from _shared.thread_adapter import get_thread_adapter, thread_adapter_names

    out: dict[str, Any] = {}
    # ★ 답장부터 가져온다. 이게 없으면 회신 큐가 영원히 비어 있다(수집이 처리 안에 있었다).
    inbox = _poll_inbox_if_due()
    if inbox is not None:
        out["inbox"] = inbox
    for domain in thread_adapter_names():
        if only and domain != only:
            continue
        adapter = get_thread_adapter(domain)
        if adapter is None:
            continue
        for kind, component in (("report", adapter.report_component),
                                ("recheck", adapter.recheck_component)):
            if not component:
                continue
            try:
                if not _should_run(component):
                    continue
                log.info("[thread-runner] running %s", component)
                run_id = state.pipeline_run_start(component)
                state.heartbeat_upsert(component, phase=kind, pid=os.getpid())
                result = _drive(adapter, kind=kind, charter_ref=charter_ref)
                out[component] = result
                state.pipeline_run_finish(
                    run_id, status="ok",
                    detail=f"handled={result.get('handled', 0)} errors={result.get('errors', 0)}",
                )
                # ★ 결과를 로그에도 남긴다. `pipeline_run` 에만 넣으면 로그에는
                #   "running" 만 흘러 무엇을 했는지 DB 를 봐야 안다 — 상주 프로세스를
                #   지켜보는 방법이 로그밖에 없는 순간이 온다.
                log.info("[thread-runner] %s handled=%s errors=%s status=%s", component,
                         result.get("handled", 0), result.get("errors", 0),
                         result.get("status", ""))
            except Exception as e:  # noqa: BLE001
                log.exception("[thread-runner] %s failed", component)
                state.heartbeat_upsert(component, phase="error",
                                       detail=repr(e)[:500], pid=os.getpid())
                out[component] = {"error": repr(e)[:500]}
    return out


_stop = False


def _install_signal_handlers() -> None:
    def _sig(_signum, _frame) -> None:
        global _stop
        _stop = True
    for s in (signal.SIGINT, signal.SIGTERM):
        signal.signal(s, _sig)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="4도메인 스레드 파이프라인 러너")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--only", default=None, help="한 도메인만 (smb|github|confluence|dev_web)")
    parser.add_argument("--poll-sec", type=float, default=DEFAULT_POLL_SECONDS)
    parser.add_argument("--charter", default=os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"))
    args = parser.parse_args(argv)
    logging.basicConfig(level=os.environ.get("SA_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    if args.once:
        log.info("[thread-runner] once: %s", run_once(charter_ref=args.charter, only=args.only))
        return 0
    _install_signal_handlers()
    while not _stop:
        try:
            run_once(charter_ref=args.charter, only=args.only)
        except Exception:  # noqa: BLE001 — 루프는 죽지 않는다
            log.exception("[thread-runner] pass failed")
        waited = 0.0
        while waited < args.poll_sec and not _stop:
            time.sleep(min(1.0, args.poll_sec - waited))
            waited += 1.0
    log.info("[thread-runner] stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
