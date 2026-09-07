# confluence_task plan contract

skill: confluence_task
domain: confluence

## 살아 있는 것

### sso_task — 평면 팬아웃 (은퇴 대상 아님)

`confluence.sso_task` 는 `lead_agent._LEADS` 에 없다. 대체 리드가 없어 평면 레인 그대로 돈다.

    kind: fanout_phase
    adapter: confluence_sso_task
    target_unit: devops_target URL
    target_source: devops_target where service='confluence'
    claim_function: service.state_domain.devops_target_claim_next
    worker_module: service.agents.confluence_task_worker
    worker_skill_resource: worker.md
    concurrency_env: CONFLUENCE_SSO_PARALLEL (기본 1)
    success_release: worker 가 devops_target_set_status 호출
    failure_release: claim 한 URL 을 cooldown 전진 없이 pending 으로

plans: `confluence_sso_task` · `confluence_task` · `confluence_e2e` ·
`confluence_report` · `confluence_recheck`

### space / keyword_search — 리드 검토원

    kind: lead_inspection            # 2026-08-28: fanout_phase 에서 전환
    space  : lead=confluence.lead          inspect_agent=confluence_inspect
             target_unit=confluence_space_target 1건 (배치 아님)
             delegate kind='space_batch'
    search : lead=confluence_search.lead   inspect_agent=confluence_search_inspect
             target_unit=confluence_search_target 1건
             delegate kind='keyword_search'
    list_function : service.state_domain.lead_targets_overview(...)
    worker_prompt : service.agents.confluence_task_worker._build_user_text
                    (kind 별 분기 — 검토원 계약이 직접 부른다)
    concurrency   : 리드당 워커 2 (`lead_agent._DEFAULT_MAX_SESSIONS`)

⚠️ **검토원 task_type 이 둘인 이유**는 종료 도구 격리다 — `keyword_search` 는
`{confluence_search_set_status}` 만, space 는 `{confluence_space_set_status,
devops_target_set_status}` 만 쥔다. 하나로 합치면 합집합이 되어 "엉뚱한 큐를 ok 로 닫지
못한다" 는 성질이 깨진다. `plugin/inspect_contract.py` 도크스트링 참조.

## 키워드 큐 시드 — ★ 자리를 옮겼다

`confluence_search_target` 에 행을 만드는 **유일한 자동 경로**는
`confluence_discovery_agent.run_search_keyword_sync` 다. space/sso 와 달리 search 에는
전용 discovery 컴포넌트가 없어서, 원래 평면 search_task 레인 머리에 붙여 뒀었다.

2026-08-28 에 그 레인을 은퇴시키면서 **살아 있는 space discovery 스텝 머리**로 옮겼다
(`confluence_pipeline_runner._run_space_discovery_pass`). 같이 지웠으면 큐가 안 채워지고
`confluence_search.lead` 가 영원히 idle 이 됐을 것이다.

## 은퇴한 평면 레인 (참고)

되찾으려면 태그 `flat-lane-last`.

    space_task  : adapter=confluence_space_task
                  claim=confluence_space_target_claim_next (배치 8, CONFLUENCE_SPACE_BATCH)
                  worker=service.agents.confluence_task_worker (+ _preflight_space_batch)
    search_task : adapter=confluence_search_task
                  claim=confluence_search_target_claim_next (배치 8, CONFLUENCE_SEARCH_BATCH)
                  scope 이질 배치 방어 = _group_searches_by_scope

두 방어(`_preflight_space_batch`·`_group_searches_by_scope`)는 **배치 claim 이 있을 때만**
필요했다. 리드는 `delegate_input(target_id: int, ...)` 로 한 건씩 위임해서 깨진 배치도
scope 혼합도 구조적으로 생기지 않는다.

## 부모/오케스트레이터 책임

- 워커 트랜스크립트를 부모 컨텍스트로 끌어오지 않고 `worker_result.json` 만 읽는다.
- 모든 워커 task_spec.json 에 charter_ref 를 보존한다.
- 엔진에 Confluence 분기를 넣지 않는다. 어댑터는 SA_PLUGINS 로 등록한다.
