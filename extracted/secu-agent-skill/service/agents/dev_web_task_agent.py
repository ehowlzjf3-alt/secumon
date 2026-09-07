"""dev_web #1 점검 — 검토원 프롬프트·도구셋·deep-dive 판정.

**이 모듈은 러너가 아니다.** 평면 태스크 레인(`run_task_pass`)은 2026-08-28 에
은퇴했고, `dev_web_target` 큐를 소비하는 주체는 `dev_web.lead` 다 — 리드가 target
하나당 검토원 하나를 띄운다. `main` 은 은퇴 사실을 heartbeat 에 싣는 스텁이다.

검토원 경로가 쓰는 것: `_build_user_text`(검토원 지시) ·
`_tool_classes`(도구셋). `_has_post_sweep_browser_deep_dive` 는 호출부가 없다 —
아래 ⚠️ 참조.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from domains.dev_web.application.contracts import COMPONENT_TASK
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.dev_web_task")

COMPONENT = COMPONENT_TASK
_DEEP_DIVE_TOOLS = {"browser_action", "browser_query", "dev_web_browse"}


def _has_post_sweep_browser_deep_dive(result: dict[str, Any]) -> bool:
    saw_sweep = False
    for call in result.get("tool_calls") or []:
        name = str(call.get("name") or "")
        if name == "web_site_sweep" and call.get("success"):
            saw_sweep = True
            continue
        if saw_sweep and name in _DEEP_DIVE_TOOLS and call.get("success"):
            return True
    return False


def _terminal_requested_tasked(result: dict[str, Any]) -> bool:
    for call in result.get("terminal_calls") or []:
        if call.get("name") == "dev_web_submit_finding":
            return True
        if call.get("name") != "dev_web_target_set_status":
            continue
        tool_input = call.get("input") if isinstance(call.get("input"), dict) else {}
        if str(tool_input.get("status") or "").lower() == "tasked":
            return True
    return False


def _tool_classes():
    """도구셋은 도메인 소유다 — `domains.dev_web.plugin.toolsets` 참조."""
    from domains.dev_web.plugin.toolsets import dev_web_task_tools

    return dev_web_task_tools()


def _build_user_text(target: dict[str, Any], *, charter_ref: str) -> str:
    return (
        f"[dev_web 점검 대상] target_id={target['id']} domain={target.get('domain')} "
        f"url={target.get('url')} charter_ref={charter_ref}\n"
        "승인된 내부 dev/stage/test 웹 점검이다. 대상 URL/동일 origin만 검사한다. "
        "read-only로 수행하고 저장/삭제/전송/권한상승/로그인 우회는 금지한다.\n\n"
        "필수 순서:\n"
        "1. web_site_sweep(domain='<url>')로 루트, 주요 라우트, 표준 endpoint, API 샘플을 점검한다.\n"
        "2. dev_web_browse(url='<url>')로 실제 화면을 열고(세션 자동 확보) 상단/좌측 메뉴, 목록, "
        "상세, 설정, 관리자, API/토큰, 다운로드/export 화면을 read-only로 훑는다. 다른 화면은 "
        "dev_web_browse(다른 same-origin path)로 이어서 열고, 픽셀 확인이 필요하면 browser_query(screenshot). "
        "raw browser_session/browser_action은 이 워커에서 쓰지 않는다(무인 승인거부). "
        "**dev_web_submit_finding은 sweep 후 dev_web_browse/browser_query로 실제 화면을 본 뒤에만 허용된다.**\n"
        "3. digest의 pages/probes/api_samples/dynamic_responses 및 브라우저 화면/XHR에서 "
        "크리덴셜, 개인정보/인사정보 대량 노출, 경영진/사업 회의록, 중요 공정정보, "
        "무인증 기능/API 문서/debug endpoint가 보이는지 판단한다.\n"
        "4. 의심 항목은 web_fetch 또는 web_resource_probe로 대표 2~3개만 추가 확인한다. "
        "키워드/엔트로피/파일명만으로 제출하지 말고, 실제 화면 또는 응답 증거와 업무 맥락을 함께 검증한다.\n"
        "5. 확정된 항목만 dev_web_submit_finding(target_id=<id>, finding={...})으로 제출한다. "
        "task_type은 반드시 dev_web, asset/target은 검사 중인 URL이다.\n"
        "6. 끝나면 dev_web_target_set_status(target_id=<id>, status='tasked'|'skipped'|'error', "
        "finding_count=N, reason=...)를 호출한다."
    )

# ══════════════════════════════════════════════════════════════════════════
# 평면 태스크 레인은 **은퇴했다** (2026-08-28) — 이 파일은 헬퍼 모듈이다.
#
# 이 큐의 시작점은 `dev_web.lead` 다. 리드가 target 하나당 검토원 하나를 띄운다
# (`open_inspection`/`ask_inspector`), 워커 프롬프트는 아래 `_build_user_text` 가
# 그대로 만든다(`domains/dev_web/plugin/inspect_contract.py:13`).
# 지운 것: `_task_one_target` · `run_task_pass` · `dev_web_task_worker.py` ·
# 팬아웃 task 어댑터. 되찾으려면 태그 `flat-lane-last`.
#
# ⚠️ **`_has_post_sweep_browser_deep_dive` 는 지금 호출부가 없다.**
#    유일한 호출부가 지운 `_task_one_target` 이었다. 이 게이트는 "sweep 만 하고 실제
#    브라우저 deep-dive 없이 target 을 tasked 로 닫는 것"을 막았는데, 검토원 계약
#    (`dev_web_inspect_contract`)에는 대응물이 없다 — `on_submit`/`on_no_submit` 훅은
#    `(evidence_dir, spec)` 만 받아 `tool_calls` 를 볼 수 없어 그대로 옮길 수도 없다.
#
#    남는 구멍은 좁다: **finding 을 제출하는 경로는 코어의 브라우저 검증 게이트가
#    여전히 막는다**(`submit_finding.py`). 구멍은 "제출 0건으로 tasked 종료" 하나다.
#    함수는 남긴다 — 게이트를 검토원 쪽에 다시 세울 때 판정 로직이 여기 있다.


def main(argv: "list[str] | None" = None) -> int:
    """은퇴한 평면 레인의 진입점 — 아무 target 도 claim 하지 않고 사유만 남긴다.

    `domains/dev_web/runners/task.py` 가 이 함수를 import 하고,
    `tests/test_k8s_manifests.py` 가 그 진입점을 단언한다. 셸 루프
    (`scripts/dev_web_loop.sh`)의 task 블록은 지웠지만, 수동 CLI 로 부르는 경로가
    남아 있어 여기서도 은퇴 사실을 heartbeat 에 싣는다.
    """
    del argv
    logging.basicConfig(level=os.environ.get("DEV_WEB_AGENT_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    load_runtime_env(load_plugins=False)
    from service.agents.lead_agent import retired_flat_pass

    retired = retired_flat_pass(COMPONENT)
    if retired is not None:
        log.info("[dev_web_task] %s", retired.get("detail"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
