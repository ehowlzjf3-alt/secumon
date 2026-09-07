"""#1 SMB 점검 — 검토원 프롬프트·도구셋·claim sentinel.

**이 모듈은 러너가 아니다.** 평면 태스크 레인(`run_task_pass`)은 2026-08-28 에
은퇴했고, walked share 큐를 소비하는 주체는 `smb.lead` 다: 리드가 `list_targets`
로 큐를 보고 `open_inspection`/`ask_inspector` 로 share 하나당 검토원 하나를 띄운다.

여기 남은 셋은 그 검토원 경로가 직접 쓴다:

  `_build_user_text`  검토원에게 주는 share 판정 지시 (`domains/smb/plugin/inspect_contract.py:26`)
  `_task_session_id`  share claim sentinel — collector sentinel 과 구분 (`:201`)
  `_tool_classes`     smb_task 워커 도구셋 (도구셋 자체는 `domains.smb.plugin.toolsets` 소유)

적대적 판정의 내용은 그대로다: DB hit/메타 읽기 → 의심 파일 deepdive → 반도체
위험기준 → credential 도달성 검증 → smb_submit_finding. 바뀐 것은 **누가 띄우느냐**
뿐이다.

⚠️ **이 파일을 지우지 마라.** 위 셋이 사라지면 리드가 검토원을 못 띄운다.
⚠️ **진입점(`main`)은 여기 없다.** k8s Deployment 가 부르는 것은
   `domains/smb/runners/task.py` → `smb_task_loop.main` 이고, 그 루프가
   `retired_flat_pass` 로 은퇴 사실을 heartbeat(`phase="disabled"`)에 싣는다.

지운 것(`run_task_pass`·`_task_one_host`·워커 spec writer·재시도 헬퍼 5종·`main`)을
되찾으려면 태그 `flat-lane-last`.
"""
from __future__ import annotations

from typing import Any

from domains.smb.application.contracts import COMPONENT_TASK, SA_SESSION_ID

COMPONENT = COMPONENT_TASK


def _tool_classes() -> list[type]:
    """도구셋은 도메인 소유다 — `domains.smb.plugin.toolsets` 참조."""
    from domains.smb.plugin.toolsets import smb_task_tools

    return smb_task_tools()


def _build_user_text(host_digest: dict[str, Any], *, charter_ref: str) -> str:
    host = host_digest["host"]
    share_ids = [int(s["id"]) for s in (host_digest.get("shares") or []) if s.get("id") is not None]
    shares = host_digest.get("shares") or []
    share_lines = []
    for s in shares:
        share_lines.append(
            f"- share_id={s['id']} \\\\{host}\\{s['share']} "
            f"(read={s.get('share_read')}, write={s.get('share_write')}, "
            f"null={s.get('null_login_ok')}, guest={s.get('guest_login_ok')}, "
            f"auth={s.get('auth_login_ok')}, status={s.get('status')})"
        )
    return (
        f"[SMB 점검 대상] host={host} charter_ref={charter_ref}\n"
        f"이 작업은 승인된 내부 보안 점검이며 대상은 제공된 host/share 범위로 제한된다. "
        f"exploitability, credential reachability, lateral exposure 가능성은 확인 대상이다. "
        f"다만 파괴적 변경, 영구 변경, 서비스 중단, scope 밖 접근은 수행하지 말고 "
        f"상태 변경 가능성이 있으면 운영자 승인이 필요하다고 보고하라.\n\n"
        f"아래 share 1개를 적대적으로 판정하라. "
        f"DB(state) 의 smb_file/smb_file_hit/smb_directory 메타를 먼저 읽고, 의심 파일만 "
        f"smb_fetch_scan/smb_task_python 으로 deepdive 하라. 단, 기존 hit 검색 결과만 "
        f"증거로 삼지 말고 suspicious_only=True 후보와 별도로 전체 파일명/상위폴더 목록"
        f"(suspicious_only=False 페이지)를 훑어 이름상 민감한 후보와 같은 폴더의 주변 파일을 "
        f"추가 선별하라. credential 이 발견되면 "
        f"현재 runner 관점의 read-only 도달성 검증과 credential 발견 PC 관점의 검증 가능성을 "
        f"분리해 기록하라. 발견 PC 관점은 smb_origin_credential_probe 로 시도하되, "
        f"source-runner 가 미설정이면 우회 실행하지 말고 "
        f"origin_pc_validation=not_performed 로 남겨라. 실제 노출만 "
        f"smb_submit_finding(task_type='smb', target='{host}') 로 제출하라. "
        f"이 share 안의 의미 있는 상위 폴더/파일 후보를 끝까지 검토한 뒤 종료하라. "
        f"다른 share 는 별도 worker 가 담당한다.\n\n"
        f"대상 share:\n" + "\n".join(share_lines)
    )


def _task_session_id() -> int:
    # 점검 에이전트 claim sentinel — collector sentinel 과 구분.
    return SA_SESSION_ID
