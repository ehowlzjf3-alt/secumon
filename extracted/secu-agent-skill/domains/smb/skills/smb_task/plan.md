# smb_task plan contract

kind: lead_inspection            # 2026-08-28: fanout_phase 에서 전환
skill: smb_task
lead_component: smb.lead
inspect_agent: smb_file_inspect
target_unit: smb_share
target_source: smb_share.status in walked/listing_reviewed/pending/in_progress
list_function: service.state_domain.lead_targets_overview("smb_share", ...)
worker_prompt: service.agents.smb_task_agent._build_user_text
worker_skill_resource: worker.md
claim_sentinel: service.agents.smb_task_agent._task_session_id
concurrency: 리드당 워커 2 (`lead_agent._DEFAULT_MAX_SESSIONS`)
terminal_success: worker_result.status == ok
success_release: 검토원이 `set_target_status` 로 share 를 닫고, host 의 task-ready share 가 전부 끝난 뒤에만 리포트를 승격한다
failure_release: share 를 walked 로 되돌려 재시도

## 은퇴한 평면 레인 (참고)

`fanout_phase` 시절의 배선은 2026-08-28 에 지웠다. 되찾으려면 태그 `flat-lane-last`.

    adapter: smb_task                      → domains/smb/application/fanout.py:_make_task_adapter
    claim_function: state_domain.smb_task_claim_next
    worker_module: service.agents.smb_task_worker
    concurrency_env: SMB_TASK_PARALLEL (기본 5)

⚠️ **`smb_task_claim_next` 의 조건 셋은 리드 경로에 아직 없다** — 7일 롤링 재점검,
   8h `retry_after` 재개, stale `in_progress` 회수. `lead_targets_overview` 는 status 만
   거른다. 주 1회 사이클·8시간 간격 3회 재시도라는 설계 의도는 현재 그 함수의 주석에만
   남아 있다.

## 부모/오케스트레이터 책임

- 부모 컨텍스트에서 파일 내용을 보지 않는다.
- share 하나당 워커 프로세스 하나. 워커 트랜스크립트를 부모로 끌어오지 않고
  `worker_result.json` 만 읽는다.
- SMB auth lockout 이 감지되면 새 검토원을 띄우지 않는다.
- 모든 워커 task_spec.json 에 charter_ref 를 보존한다.
