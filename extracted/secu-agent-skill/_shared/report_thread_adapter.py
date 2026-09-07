"""github·confluence 스레드 어댑터 — **한 벌**로 짓는다.

## 왜 공용인가

2026-08-31 실측: `github_report_agent._handle_thread` 와 `confluence_report_agent.
_handle_thread` 는 34줄 중 **1줄**만 다르다(`state.<도메인>_report_thread_set_status`).
`build_report_for_thread` / `deliver_report_for_thread` / `recheck_thread` /
`sync_report_threads` 도 이름·서명이 같고 모듈만 다르다.

그래서 어댑터를 두 벌 쓰면 쌍둥이가 셋이 된다. 여기서 **좌표 열과 모듈 경로만**
받아 한 벌로 짓는다 — `_shared/thread_adapter` 머리말이 없애려던 그 모양이다.

⚠️ smb·dev_web 은 여기 못 들어온다. 둘은 LLM 워커 한 런이 만들기와 배달을
   융합해서 하고, 상태 어휘도 다르다. 억지로 합치면 계약이 거짓말을 한다.
"""
from __future__ import annotations

from importlib import import_module
from typing import Any

from _shared.thread_adapter import ThreadAdapter, summarize_thread_row


def build_report_thread_adapter(
    *,
    domain: str,
    queue_label: str,
    coord_key: str,
    application_module: str,
    agent_module: str,
    report_component: str,
    recheck_component: str,
) -> ThreadAdapter:
    """`domain` 의 스레드 어댑터를 짓는다.

    coord_key: 좌표 열 이름 — github=`repo`, confluence=`space_key`.
    application_module: `build_report_for_thread` 등이 사는 곳.
    agent_module: `handle_thread_async` 가 사는 곳.

    ⚠️ **전부 지연 import 다.** application 모듈을 최상위에서 끌면 부트스트랩이
       딸려 온다 — 2026-08-28 에 `run_owner_pass` 를 최상위 import 했다가 테스트
       제어 플래그가 전부 발화한 적이 있다. 등록은 부팅 때 일어나므로 여기서
       무거운 모듈을 끌면 안 된다.
    """
    import service.state_domain as state

    prefix = f"{domain}_report_thread_"
    fn = lambda name: getattr(state, prefix + name)  # noqa: E731
    statuses = tuple(sorted(getattr(state, f"_{domain.upper()}_REPORT_THREAD_STATUSES")))
    overview = getattr(state, f"{domain}_report_threads_overview")

    def _app(name: str):
        return getattr(import_module(application_module), name)

    def _list_threads(*, status: str | None = None, limit: int = 100,
                      cycle_key: str | None = None, **kw: Any) -> list[dict[str, Any]]:
        rows = overview(status=status, limit=limit, cycle_key=cycle_key,
                        **{coord_key: kw.get(coord_key)})
        return [summarize_thread_row(domain, r, coord_keys=(coord_key,)) for r in rows]

    def _finding_ids(thread: dict[str, Any]) -> list[int]:
        return fn("finding_ids")(int(thread["id"]))

    async def _deliver_report(thread: dict[str, Any], **kw: Any) -> dict[str, Any]:
        return await getattr(import_module(agent_module), "handle_thread_async")(thread, **kw)

    def _build_report(thread: dict[str, Any]) -> dict[str, Any]:
        return _app("build_report_for_thread")(thread)

    def _recheck(thread: dict[str, Any], **kw: Any) -> dict[str, Any]:
        return _app("recheck_thread")(thread, **kw)

    async def _deliver_recheck(thread: dict[str, Any], result: dict[str, Any], **kw: Any) -> Any:
        return await _app("deliver_recheck_result_for_thread")(thread, result, **kw)

    def _sync_threads() -> Any:
        return _app("sync_report_threads")()

    def _recheck_records(thread_id: int) -> list[dict[str, Any]]:
        return getattr(state, f"{domain}_recheck_results_for_thread")(int(thread_id))

    def _delivery_targets(owner_recipients: Any = None) -> dict[str, Any]:
        return _app(f"{domain}_report_delivery_targets")(owner_recipients)

    return ThreadAdapter(
        domain=domain,
        report_component=report_component,
        recheck_component=recheck_component,
        queue_label=queue_label,
        statuses=statuses,
        list_threads=_list_threads,
        thread_get=fn("get"),
        finding_ids=_finding_ids,
        claim_next=fn("claim_next"),
        set_status=fn("set_status"),
        bump_attempt=fn("bump_attempt"),
        reclaim_stale=fn("reclaim_stale"),
        schedule_retry=fn("schedule_recheck_retry"),
        deliver_report=_deliver_report,
        build_report=_build_report,
        recheck=_recheck,
        deliver_recheck=_deliver_recheck,
        sync_threads=_sync_threads,
        delivery_targets=_delivery_targets,
        recheck_records=_recheck_records,
        # ★ 정본은 러너다 — report 워커는 `reported` 를, recheck 워커는
        #   `recheck_requested` 를 claim 한다(한 테이블 두 단계).
        claimable_statuses=("reported", "recheck_requested"),
    )
