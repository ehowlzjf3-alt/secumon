"""skills/__init__.py 에서 적출한 도메인 skill → 기본 unlock 도구 매핑.

재부착 시 plugin 이 `_DEFAULT_UNLOCK_TOOLS_BY_SKILL` 에 등록 — 원형 보존용.
"""

DEFAULT_UNLOCK_TOOLS_BY_SKILL: dict[str, tuple[str, ...]] = {
    # ⚠️ `smb_tasking`/`dev_web_tasking` 은 **로드되지 않는 skill 이름**이다 —
    # SKILL.md 의 `name:` 이 디렉터리 basename(`smb`/`dev_web`)과 달라 load_skills 가
    # 등록하지 않는다(domains/web/tests/test_web_tasking_skill.py 가 그 사실을 고정).
    # 즉 이 두 항목의 unlock 은 **한 번도 발화한 적이 없다.** 원형은 보존하되 더 이상
    # 존재하지 않는 도구는 지운다 — skill 로딩 자체는 Phase 1(검토원 계약)에서 다룬다.
    "smb_tasking": (
        "smb_subnet_sweep",
        "smb_host_sweep",
        "smb_owner_lookup",
    ),
    "dev_web_tasking": (
        "run_dev_web_discovery",
        "dev_web_targets_pending",
        "dev_web_target_set_status",
        "web_site_sweep",
        "browser_session",
        "browser_action",
        "browser_query",
        "web_fetch",
        "web_resource_probe",
        "web_task_scan",
        "dev_web_submit_finding",
        "dev_web_build_report",
        "dev_web_record_reverify_result",
    ),
    # SMB E2E 3 에이전트 — contract layer = skill 단위 (도구 화이트리스트 분리).
    # #1 점검: 메일/POP3 도구 미포함.
    "smb_task": (
        "smb_task_python",
        "smb_fetch_scan",
        "smb_credential_probe",
        "smb_submit_finding",
    ),
    # #2 조치요청: sweep/walk·POP3 미포함.
    "smb_report_mail": (
        "smb_build_remediation_report",
        "smb_report_screenshot",
        "deliver",
    ),
    # #3 답장·재검증: 점검/리포트 미포함.
    "smb_reply_verify": (
        "smb_read_inbox",
        "smb_reverify_walk",
        "deliver",
    ),
    # Confluence E2E worker — API space batch + keyword browser search + SSO URL target.
    "confluence_task": (
        "confluence_task_scan",
        "confluence_space_set_status",
        "confluence_browser_search",
        "confluence_search_set_status",
        "web_site_sweep",
        "browser_session",
        "browser_action",
        "browser_query",
        "confluence_submit_finding",
        "devops_target_set_status",
    ),
    "confluence_report": (),
    "confluence_recheck": (
        "confluence_fetch_page",
        "confluence_fetch_attachment",
        "confluence_list_attachments",
    ),
    # dev_web E2E 3 에이전트 — 기존 web 검사 도구 + dev_web 상태 전이.
    "dev_web_task": (
        "web_site_sweep",
        "browser_session",
        "browser_action",
        "browser_query",
        "web_fetch",
        "web_resource_probe",
        "web_task_scan",
        "dev_web_submit_finding",
        "dev_web_target_set_status",
    ),
    "dev_web_report": (
        "dev_web_build_report",
        "deliver",
    ),
    "dev_web_reply_verify": (
        "web_site_sweep",
        "web_fetch",
        "web_resource_probe",
        "dev_web_record_reverify_result",
    ),
}
