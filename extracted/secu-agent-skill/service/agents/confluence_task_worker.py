"""Confluence E2E task worker entrypoint.

The fanout adapter spawns this worker with one evidence directory containing
`task_spec.json`. The target is either:

- `space_batch`: a claimed batch of `confluence_space_target` rows for API scan
- `sso_url`: one claimed `devops_target` Confluence URL for browser SSO review

The worker runs one skill contract and writes `worker_result.json` for the core
WorkerPool summary path.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from pathlib import Path
from typing import Any

from domains.services.confluence.application.contracts import (
    COMPONENT_CONFLUENCE_SEARCH_TASK,
    COMPONENT_CONFLUENCE_SPACE_TASK,
    COMPONENT_CONFLUENCE_SSO_TASK,
    CONFLUENCE_TASK_SKILL,
)
from service.agents import quality_events as _quality

_INCOMPLETE_REASONS = {
    "stream_error", "no_completion", "aborted", "max_turns",
    "max_tokens", "contract_violation",
}


def _record_quality(
    component: str,
    worker_type: str,
    *,
    status: str,
    reason: str | None,
    c_seen: int | None,
    c_acct: int | None,
    findings: int | None,
) -> None:
    """skill_quality worker_result 이벤트 — best-effort(내부에서 예외 삼킴), #1 눈 v1."""
    _quality.record_worker_result(
        domain="confluence", worker_type=worker_type, component=component,
        execution_status=status, reason_code=reason,
        ledger_enforced=_quality.ledger_enforced_from_env(),
        candidates_seen=c_seen, candidates_accounted=c_acct,
        worker_reported_findings_count=findings,
    )


from service.agents.worker_result import write_worker_result as _write_worker_result


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _start_heartbeat(component: str, detail: str) -> threading.Event:
    from service import state_domain as state

    stop = threading.Event()

    def beat() -> None:
        while not stop.is_set():
            try:
                state.heartbeat_upsert(component, phase="task", detail=detail, pid=os.getpid())
            except Exception:
                pass
            stop.wait(30)

    threading.Thread(
        target=beat,
        name=f"{component}-heartbeat",
        daemon=True,
    ).start()
    return stop


def _tool_classes(kind: str | None = None):
    """도구셋은 도메인 소유다 — `domains.services.confluence.plugin.toolsets` 참조."""
    from domains.services.confluence.plugin.toolsets import confluence_task_tools

    return confluence_task_tools(kind)


from domains.services.confluence.application.url_hints import confluence_url_api_hint_text as _confluence_url_api_hint_text


def _build_user_text(spec: dict[str, Any]) -> str:
    target = spec.get("target") or {}
    charter = spec.get("charter_ref", "")
    kind = target.get("kind")
    if kind == "space_batch":
        ids = [int(x) for x in (target.get("target_ids") or [])]
        keys = [str(x) for x in (target.get("space_keys") or [])]
        return (
            f"[Confluence API space 점검 대상] charter_ref={charter}\n"
            f"target_ids={ids}\n"
            f"space_keys={keys}\n\n"
            "이 작업은 승인된 내부 보안 점검이며 대상은 위 Confluence space batch로 제한된다. "
            "먼저 confluence_task_scan(space_keys=..., api_search_first=True, "
            "scan_comments=True, scan_history=True)를 호출해 CQL 검색 후보 page를 선별한 뒤 "
            "page/comment/version/텍스트 첨부를 상세 조회하라. 결과 JSON의 finding_count, "
            "recommended_target_status, status_reason을 확인하라. recommended_target_status가 "
            "'error' 또는 'skipped'이면 반드시 그 status와 reason으로 confluence_space_set_status를 "
            "호출하고, 그 외 성공 시에만 status='tasked'로 닫아라. API 오류, 접근불가, "
            "검색 후보가 있는데 상세조회가 전부 누락된 경우는 error/skipped reason을 남겨라. raw secret이나 "
            "전체 페이지 본문을 출력하지 말고 마스킹 증거와 위치만 기록하라."
        )
    if kind == "sso_url":
        target_id = int(target["target_id"])
        url = str(target.get("url") or "")
        api_hints = _confluence_url_api_hint_text(url)
        return (
            f"[Confluence SSO URL 점검 대상] charter_ref={charter}\n"
            f"target_id={target_id}\n"
            f"url={url}\n\n"
            "이 작업은 승인된 내부 보안 점검이며 대상은 위 Confluence URL 1건으로 제한된다. "
            "web_site_sweep(domain=url)을 먼저 실행해 SSO 직결 화면, 라우트, scan_hits, "
            "coverage를 확인하라. 그 다음 URL 또는 digest에서 확인되는 Confluence "
            "space/page 후보는 반드시 API 검색/상세조회로 먼저 정밀 확인하라:\n"
            f"{api_hints}\n"
            "API 검색 후보가 page/comment/version/첨부 상세조회로 실제 증거를 보강한 뒤에만 "
            "브라우저/웹 도구를 사용한다. 실제 민감 페이지/첨부/credential이 보이는 경우에만 "
            "browser_action/browser_query 또는 web_fetch로 본문을 재확인한 뒤 "
            "submit_finding(task_type='confluence')으로 제출하라. 단순 이메일/이름/사번만 있거나 "
            "권한없음/로그인벽/빈 화면이면 finding이 아니다. 완료 시 반드시 "
            "devops_target_set_status(target_id=..., status='tasked' 또는 'skipped' 또는 'error', "
            "finding_count=<제출 finding 수>, reason=<짧은 판단>)를 호출하라."
        )
    if kind == "keyword_search":
        all_ids = [int(x) for x in (target.get("target_ids") or [])]
        searches = target.get("searches") or []
        lines: list[str] = []
        for i, s in enumerate(searches, start=1):
            kws = [str(x) for x in (s.get("keywords") or [])]
            scope = s.get("scope_space_keys")
            scope_txt = f", scope_space_keys={[str(x) for x in scope]}" if scope else " (scope 없음=접근가능 전 space)"
            lines.append(f"  검색그룹{i}: confluence_browser_search(keywords={kws}{scope_txt})")
        groups = "\n".join(lines) or "  (검색 대상 없음)"
        return (
            f"[Confluence 키워드 검색 점검 대상] charter_ref={charter}\n"
            f"target_ids={all_ids}\n\n"
            "이 인스턴스는 REST API(confluence_task_scan)가 정책상 영구 차단(rate-limit 0)이라 "
            "**confluence_browser_search 도구만** 쓴다. 이 도구가 내부에서 SSO 로그인(1회)·검색창"
            "(dosearchsite) 검색·접근가능 page 방문·scan_text 마스킹까지 처리한다. web_site_sweep/"
            "browser_session/browser_action/confluence_task_scan 은 이 kind 에서 쓰지 않는다. "
            "승인된 내부 보안 점검이며 read-only — 편집/댓글/저장/권한변경/삭제 금지.\n\n"
            "필수 순서:\n"
            "1. 아래 각 검색그룹마다 confluence_browser_search 를 한 번씩 호출한다(SSO 로그인은 첫 호출에서 "
            "1회, 세션은 이후 호출에 재사용된다). 그룹별 keywords/scope 를 그대로 넘긴다:\n"
            f"{groups}\n"
            "2. 반환 JSON 의 login_ok 가 false 면 인증 실패다 — 그 즉시 아래 상태전이를 status='error', "
            "reason=login_msg 로 호출하고 종료한다(재로그인/재시도 금지 — AD lockout 방지).\n"
            "3. candidates 는 이미 마스킹된 hit 만 담고 있다. 각 후보 page 의 hits(category/kind/"
            "masked_preview)와 title/url 을 근거로 **실제 부적절 노출인지** 판단한다: 크리덴셜/시크릿, "
            "개인정보·인사정보 대량 노출, 경영진/사업 회의록, 중요 공정정보(recipe/wafer/yield/설비), "
            "무인증 노출 문서. 단순 이메일/이름/사번, placeholder/sample/changeme, 키워드·파일명·엔트로피 "
            "단독 매칭은 finding 이 아니다.\n"
            "4. 확정된 실제 노출만 submit_finding(task_type='confluence', ...)으로 제출한다. asset/target 은 "
            "해당 page url(마스킹된 값 그대로), hit.location 은 발견 위치다. 원문 전체/평문 시크릿은 인용하지 "
            "말고 마스킹 증거만 남긴다. Confluence asset 은 domain report 가 space 기준 dedup 하도록 "
            "page url 형태로 남긴다.\n"
            "5. 끝나면 **정확히 한 번** confluence_search_set_status(target_ids=<target.target_ids 전체>, "
            "status='tasked'|'skipped'|'error', finding_count=<제출한 finding 총수>, reason=<짧은 판단>)를 "
            "호출한다. 정상 검색 완료=tasked(제출 0건이어도 tasked, finding_count=0), 로그인/권한 전부 불가"
            "=skipped, 검색 자체 실패=error. confluence_space_set_status/devops_target_set_status 는 이 "
            "kind 에서 쓰지 않는다."
        )
    raise ValueError(f"unknown confluence worker target kind: {kind!r}")


def _component_for(spec: dict[str, Any]) -> str:
    kind = (spec.get("target") or {}).get("kind")
    if kind == "space_batch":
        return COMPONENT_CONFLUENCE_SPACE_TASK
    if kind == "keyword_search":
        return COMPONENT_CONFLUENCE_SEARCH_TASK
    if kind == "sso_url":
        return COMPONENT_CONFLUENCE_SSO_TASK
    return "confluence.unknown"


def _terminal_tools_for(kind: str | None) -> set[str]:
    """kind별 terminal 도구(fail-closed). keyword_search 는 검색상태툴만 완료로 인정 —
    에이전트가 실수로 space/devops setter 를 불러도 완료 처리되지 않아 엉뚱한 큐를 'ok'로 닫지 못한다."""
    if kind == "keyword_search":
        return {"confluence_search_set_status"}
    return {"confluence_space_set_status", "devops_target_set_status"}


def _detail_for(spec: dict[str, Any]) -> str:
    target = spec.get("target") or {}
    if target.get("kind") == "space_batch":
        return ",".join(str(x) for x in (target.get("space_keys") or []))[:200]
    if target.get("kind") == "keyword_search":
        kws: list[str] = []
        for s in (target.get("searches") or []):
            kws.extend(str(x) for x in (s.get("keywords") or []))
        return ",".join(kws)[:200]
    return str(target.get("url") or target.get("target_id") or "")[:200]


def _finding_count(result: dict[str, Any]) -> int:
    total = 0
    for call in result.get("terminal_calls") or []:
        inp = call.get("input") or {}
        try:
            total += int(inp.get("finding_count") or 0)
        except (TypeError, ValueError):
            continue
    return total


# ── space_batch 프리플라이트는 은퇴했다 (2026-08-28) ───────────────────────
# `_preflight_space_batch`(+`_write_preflight_evidence`)는 평면 러너가 **배치로** claim 한
# space 행이 깨져 있을 때(target_ids 누락·space_keys 길이 불일치·빈 space_key) 에이전트를
# 띄우지 않고 결정론적으로 닫는 fail-closed 방어였다.
#
# 배치 claim 자체가 사라져서 그 세 모양이 만들어질 수 없다. 리드는
# `_space_delegate_input(target_id: int, ...)` 로 **한 건씩** 위임하고,
# `confluence_space_target.space_key` 는 DDL 이 `TEXT NOT NULL UNIQUE` 로 막는다.
# 되찾으려면 태그 `flat-lane-last`.


def main(argv: "list[str] | None" = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print("usage: confluence_task_worker <evidence_dir>", file=sys.stderr)
        return 2
    evidence_dir = Path(args[0]).resolve()
    spec_path = evidence_dir / "task_spec.json"
    if not spec_path.exists():
        _write_worker_result(evidence_dir, status="error_crash", summary="task_spec.json 없음", rc=1)
        return 1
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        user_text = _build_user_text(spec)
    except Exception as exc:
        _write_worker_result(
            evidence_dir,
            status="error_crash",
            summary=f"invalid task_spec.json: {exc!r}",
            rc=1,
        )
        return 1

    from service.agents import runtime
    runtime._ensure_dotenv()

    component = _component_for(spec)
    kind = (spec.get("target") or {}).get("kind")
    worker_type = f"confluence_{kind}" if kind else "confluence_task"
    heartbeat_stop = _start_heartbeat(component, _detail_for(spec))
    try:
        result: dict[str, Any] = asyncio.run(runtime.run_agent(
            tool_classes=_tool_classes(kind),
            skill_body=runtime.load_skill_contract(CONFLUENCE_TASK_SKILL, resource="worker.md"),
            user_text=user_text,
            label=str(spec.get("task_id") or "confluence-task"),
            terminal_tools=_terminal_tools_for(kind),
            charter_ref=str(spec.get("charter_ref") or ""),
            max_turns=_int_env("CONFLUENCE_TASK_MAX_TURNS", 40),
            max_wall_clock_sec=_int_env("CONFLUENCE_TASK_MAX_WALL_SEC", 1500),
            max_idle_sec=_int_env("CONFLUENCE_TASK_MAX_IDLE_SEC", 300),
            max_tokens_total=_int_env("CONFLUENCE_TASK_MAX_TOKENS_TOTAL", 500_000),
            evidence_dir=evidence_dir,
            extra_metadata={"confluence_target": spec.get("target") or {}},
            candidate_ledger_enforce=True,
            # 종료도구(confluence_*_set_status)가 findings 유무와 무관하게 필수 — gauss 가
            # 종료를 텍스트로만 내고 끝내던 것(CORE-ASK ④)을 엔진 리마인더로 되돌린다.
            require_terminal_tool=True,
        ))
        incomplete = result.get("reason") in _INCOMPLETE_REASONS
        c_seen = int(result.get("candidates_seen") or 0)
        c_acct = int(result.get("candidates_accounted") or 0)
        # 후보 침묵은 worker_result.candidates_* 로 **가시화만** — 자동 재점검(비-ok
        # 강제)은 무한 재큐 위험(codex 2R #8)이라 하지 않는다. 부모/오케스트레이터 판정.
        if result.get("error") or incomplete or not result.get("saw_terminal"):
            _write_worker_result(
                evidence_dir,
                status="error_crash",
                summary=(
                    f"reason={result.get('reason')} terminal={result.get('saw_terminal')} "
                    f"error={result.get('error')}"
                ),
                rc=1,
                turns=int(result.get("turns") or 0),
                tokens_in=int(result.get("tokens_in") or 0),
                tokens_out=int(result.get("tokens_out") or 0),
                candidates_seen=c_seen,
                candidates_accounted=c_acct,
            )
            _record_quality(component, worker_type, status="error_crash",
                            reason=str(result.get("reason") or "unknown"),
                            c_seen=c_seen, c_acct=c_acct, findings=None)
            return 1
        findings = _finding_count(result)
        _write_worker_result(
            evidence_dir,
            status="ok",
            summary=f"reason={result.get('reason')} terminal={result.get('saw_terminal')}",
            findings=findings,
            turns=int(result.get("turns") or 0),
            tokens_in=int(result.get("tokens_in") or 0),
            tokens_out=int(result.get("tokens_out") or 0),
            candidates_seen=c_seen,
            candidates_accounted=c_acct,
        )
        _record_quality(component, worker_type, status="ok",
                        reason=str(result.get("reason") or "unknown"),
                        c_seen=c_seen, c_acct=c_acct, findings=findings)
        return 0
    except Exception as exc:
        _write_worker_result(
            evidence_dir,
            status="error_crash",
            summary=f"confluence worker crash: {exc!r}",
            rc=1,
        )
        # 크래시는 candidates 미상(unknown) — 0 으로 위장 금지
        _record_quality(component, worker_type, status="error_crash",
                        reason="crash", c_seen=None, c_acct=None, findings=None)
        return 1
    finally:
        heartbeat_stop.set()


if __name__ == "__main__":
    raise SystemExit(main())
