"""GitHub SSO URL 점검 — 검토원 프롬프트·도구셋.

**이 모듈은 러너가 아니다.** 평면 SSO 태스크 레인은 2026-08-28 에 은퇴했다.
`devops_target(service='github')` 큐의 시작점은 `github.lead` 이고, 리드가 target
하나당 검토원 하나를 띄운다. 검토원 서브프로세스는 엔진(`secu_agent.agent`)이지
이 파일이 아니다 — 여기 있던 `main`(팬아웃이 `-m service.agents.github_task_worker`
로 부르던 진입점)·heartbeat·품질계측은 지웠다.

남은 둘은 살아 있는 검토원 경로가 쓴다:

  `_build_user_text`  검토원 지시 (`domains/services/github/plugin/inspect_contract.py:17`)
  `_tool_classes`     github_task 도구셋

되찾으려면 태그 `flat-lane-last`.
"""
from __future__ import annotations

from typing import Any


def _tool_classes():
    """도구셋은 도메인 소유다 — `domains.services.github.plugin.toolsets` 참조."""
    from domains.services.github.plugin.toolsets import github_task_tools

    return github_task_tools()


from domains.services.github.application.url_hints import github_url_api_hint_text as _github_url_api_hint_text


def _build_user_text(spec: dict[str, Any]) -> str:
    target = spec.get("target") or {}
    charter = spec.get("charter_ref", "")
    kind = target.get("kind")
    if kind != "sso_url":
        raise ValueError(f"unknown github worker target kind: {kind!r}")
    target_id = int(target["target_id"])
    url = str(target.get("url") or "")
    api_hint = _github_url_api_hint_text(url)
    return (
        f"[GitHub SSO URL 점검 대상] charter_ref={charter}\n"
        f"target_id={target_id}\n"
        f"url={url}\n\n"
        "이 작업은 승인된 내부 보안 점검이며 대상은 위 GitHub URL 1건으로 제한된다. "
        "web_site_sweep(domain=url)을 먼저 실행해 SSO 직결 화면, 라우트, scan_hits, "
        "coverage를 확인하라. "
        f"{api_hint} "
        "실제 credential, token, secret, private key, 내부 endpoint/API key가 보이는 경우에만 "
        "github_browse(url=해당 blob/파일 URL)로 SSO 로그인 후 실제 파일을 열어 재확인하고 "
        "submit_finding(task_type='github')으로 제출하라. web_fetch(raw/blob)는 SSO 미인증이라 404가 나며, "
        "raw browser_session/browser_action은 이 워커에서 쓰지 않는다(무인 승인거부). "
        "github finding 제출은 github_browse로 대상 host를 연 뒤에만 허용된다(정책 A). "
        "로그인벽, 권한없음, 빈 화면, repo 목록/README/프로필 같은 일반 정보, 이메일/이름만 있는 경우는 finding이 아니다. "
        "완료 시 반드시 devops_target_set_status(target_id=..., status='tasked' 또는 'skipped' 또는 'error', "
        "finding_count=<제출 finding 수>, reason=<짧은 판단>)를 호출하라."
    )
