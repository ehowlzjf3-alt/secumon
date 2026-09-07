# P3-01 MCP rate-limit 대기와 명시 재개: runtime 검토

2026-09-06. [실행 모드 계약](/Users/seunghanee/Documents/secumon/design/11-execution-modes.md), [도구 오류·긴 작업 계약](/Users/seunghanee/Documents/secumon/design/09-tools-memory-methods.md)과 현재 domain/application/storage/presentation 경로를 읽었다. 제품·시험·dist 변경, 빌드·시험·서비스 실행은 하지 않았다. 이 문서만 저장했다. 아래는 구현 전 제안이며 현재 cooldown 기능이 동작한다는 검증 결과가 아니다.

권고는 **원 수집 checkpoint를 대기 근거로 유지하고 기존 retryWakeAt/runnable/Control.wait를 재사용**하는 것이다. 별도 timer job ledger나 MCP 전용 실행기를 추가할 필요는 없다. 다만 기존 retryWakeAt와 일반 failure backoff만으로 source가 요구한 대기와 원 collection identity를 보존할 수는 없다.

## 현재 재사용점과 그대로 쓰면 안 되는 부분

| 경로 | 현재 의미 | 이번 연결에 필요한 구분 |
| --- | --- | --- |
| [domain/control.ts](/Users/seunghanee/Documents/secumon/runtime/src/domain/control.ts) | received 채택·만료 attempt 복구가 새 배정보다 먼저다. 완료·효과 의무·기한·기타 의무 이후 allocationGate를 호출한다. readProgress가 생긴 옛 task는 자동 재시도하지 않는다. | 이 정산 우선순위와 unknown write 차단을 유지하고, source cooldown은 새 model/tool 배정 gate로 연결한다. 정상 완료를 대기 상태로 되돌리거나 stored result 채택을 막지 않는다. |
| [execution-decision.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-decision.ts), [work-progress.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/work-progress.ts) | 일반 실패 키, 고정 backoff, 최초 retry window, no-progress/repeated-failure 한도를 판정한다. | taskFailureKey는 taskDigest의 readResume(parent attempt/head)를 포함하므로 successor마다 달라진다. operation 전체 cooldown의 identity를 이 키에 대신 맡기면 안 된다. 일반 progress 정책의 nextEligibleAt는 고정 backoff 식으로 검증되므로 서버 시간을 직접 덮어쓰지 않는다. |
| WorkState.retryWakeAt | execution.step은 `retry_backoff` wait만 저장한다. model gate도 이 필드를 쓴다. pause/goal/reserve 등이 null로 지운다. | 권한 근거가 아닌 스케줄용 요약값이다. 원본 checkpoint의 절대 notBefore에서 다시 도출할 수 있어야 한다. 새 reason을 도입하면 step의 저장 조건도 함께 수정해야 한다. |
| Obligation.dueAt/wakeKey | pending dueAt 도달은 `obligation_overdue` 차단이다. 일반 response/evidence 의무는 사용자 resolve가 가능하다. | cooldown 해제 시각을 dueAt로 넣으면 도래하자마자 실패한다. response 의무로 만들면 사용자가 resolve하여 우회할 수 있다. 첫 단위는 새 의무 종류 없이 기존 collection의 배정 제약으로 표현하는 편이 작다. |
| 세 StateRepository.runnable(now) | waiting 상태의 retryWakeAt·work deadline·의무 dueAt, received/expired 실행을 조회한다. | 현재 제품 코드에 이 목록을 소비하는 상시 scheduler가 없다. 저장된 wake 후보 검색과 실제 자동 실행을 구분한다. |
| [WorkflowRuntime.run](/Users/seunghanee/Documents/secumon/runtime/src/application/workflow-runtime.ts) | wait를 반환하면 현재 run이 끝난다. 다음 호출에서 다시 정본을 읽는다. | due 전 반복 run은 wait/조회만, 모델·도구 진입 0이어야 한다. due 도래가 곧 자동 새 attempt 생성 또는 실제 서버 해제 확인은 아니다. |
| [ReadCollections.publish](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collections.ts) | 원 intent/응답 head CAS, 첫 child head와 parent.successorAttemptId를 같은 CAS로 게시한다. parent query/contract/limits/goal/policy/generation을 검사한다. | 이 장부와 단일 successor 규칙을 재사용한다. `phase=partial`의 대기 상태를 새 job으로 복제하거나 옛 attempt/owner/lease를 다시 실행하지 않는다. |

## 최소 영속 계약 제안

1. **MCP 해석은 어댑터에 둔다.** 검토된 한 가지 rate-limit 응답 형식만 지원하고 retryable 이유·지연 값·원 응답 ref·원 request identity를 검증한다. 문자열 `rate_limited` 또는 isError만 보고 임의 cooldown을 추정하지 않는다. HTTP Retry-After 일반 지원은 별도 범위다. 기존 tool 전체 isError는 rejected call이고 normalized ReadPage가 없으므로, 그 경로의 wait를 지원하려면 원 response receipt를 인증하는 typed metadata가 필요하다. item-error를 지원한다면 accepted 개별 page의 원본에서 retry 조건을 재생성한다. 실패를 성공 page/EOF로 변환하지 않는다.
2. **시간의 정본은 기존 checkpoint/call/page 원본이다.** 선택 필드로 host가 계산한 절대 `notBefore`와 해당 원 요청/응답의 결합을 보존하는 정도가 적절하다. 정확한 필드명은 root 계약에서 정한다. 계산 기준은 최초로 저장한 host receivedAt/recordedAt이며, 재조회·compact·restart 시 현재 clock으로 다시 더하지 않는다. 음수·소수·overflow·상한 초과·알 수 없는 단위는 거절한다. 여러 미완료 항목을 한 번에 retry하는 현재 규칙에서는 모두 호출 가능해지는 시각이 필요하므로 해당 항목 notBefore의 최댓값을 쓴다.
3. **기존 상한을 단조 보존한다.** original work.deadlineAt, operation maxCalls와 limits, parent lineage를 연장하지 않는다. 새로운 rate-limit 응답을 실제로 수락한 경우 새 notBefore를 기록할 수 있지만 최초 업무/재시도 총기한은 늘리지 않는다. 일반 failure backoff도 적용되는 경우 source notBefore와 그 backoff 중 늦은 쪽이 실제 다음 호출 조건이다. notBefore가 허용 deadline 이상이면 기한 안에 실행할 수 없다는 bounded 차단을 표시한다.
4. **요약은 head와 같은 CAS에 묶는다.** 현재 tip의 ReadProgress에 작은 wait 요약을 투영해 model/tool 예약의 동기 CAS gate가 사용할 수 있게 한다. summary는 ReadCheckpoints가 원본 replay와 정확히 대조하고, 원본이 없으면 무대기 또는 due로 간주하지 않는다. retryWakeAt는 이 요약과 다른 기존 제약을 합친 조회용 projection이다. checkpoint v2 settle/resume codec, strict schema, logical digest, artifact closure도 선택 필드를 보존해야 한다. 기존 필드 없는 v1/legacy 자료는 과거 직렬화대로 둔다.
5. **시간 도래는 실행 허가의 일부다.** pending/unknown call이 단순 시간 경과로 accepted/complete가 되지 않는다. due 이후에도 정확한 TaskSpec.readResume, 원 head의 단일 successor, 현재 권한·원본·query·snapshot·contract를 확인한다. 서버가 아직 제한 중이면 새 응답을 원본으로 기록하고 제한된 다음 대기로 돌아간다.

## 예약·실행·명시 재개 연결 순서

- 첫 단위의 요구가 “due 전 새 모델/도구 0”이라면 현재 goal/scope의 적용 대상 collection wait를 **allocationGate의 공통 부분**에 둔다. 특정 resume task만 막으면 모델이 새 task/일반 read를 만들어 우회할 수 있다. 읽기 증거의 적용 범위는 source/operation과 current goal을 명확히 한정하고, unrelated 다른 work에 전역 대기를 전파하지 않는다. source의 global rate-limit을 지원하려면 별도의 host scope 계약이 필요하다.
- ExecutionRuntime.reserve의 현재 decideExecution/CAS 및 PlanningRuntime.reserve의 replan/CAS 검사에 같은 gate가 필요하다. reserve뿐 아니라 이미 준비된 요청의 dispatch와 Broker→source→MCP send 최종 authorize도 확인한다. await 중 wait 근거·head·권한이 바뀌는 경우를 놓치지 않는다. 중단된 실제 write의 효과 의무와 저장 결과 정산은 이 gate보다 우선한다.
- source wait는 terminal partial의 정상 상태일 수 있으므로 새 의무 해결을 진전으로 세지 않는다. 대기 polling·due 관측·resume 명령만으로 captureProgress를 호출해 streak를 초기화하지 않는다. 원래 실패 관측은 기존 same-CAS accounting에 남으며 no-progress/repeated-failure/fast mode 한도를 우회하지 않는다.
- 명시 재개는 우선 기존 `plan`의 새 TaskSpec.readResume와 `run` 조합을 사용해도 된다. UI용 편의 명령을 추가한다면 actor·expectedGoalRevision·parentAttemptId·exact checkpointId·commandId를 받고 정본 원 task에서 query/contract를 가져와야 한다. generic 사용자 `resume`는 paused/blocked/waiting을 ready로 바꾸는 명령이므로 collection successor 생성 명령과 혼동하지 않는다.
- due 전 계획을 미리 접수할지와 due 전 resume 명령을 거절할지는 계약에서 하나를 선택한다. 어느 쪽이든 tool/model reserve 0, 원 wait 불변이어야 한다. due 이후 두 caller가 같은 parent를 재개해도 기존 active attempt와 첫 child head CAS가 단일 successor를 보장해야 한다. 명령 재전송은 receipt로 멱등 처리하며 새 timer ledger를 만들지 않는다.
- `retryWakeAt`가 null인 채 ready가 됐더라도 canonical wait에서 다시 판정해야 한다. pause는 자동 wake 후보에서 제외하지만 원 notBefore를 보존한다. resume 후 남은 대기를 다시 표시하고, cancel은 실행하지 않는다. goal/policy/data generation/원본/등록 변경은 old parent 재개를 거절한다. due 이후의 snapshot 변경은 서버 응답을 기존 성공 자료에 섞지 않고 거절한다.
- 상시 scheduler는 현재 없다. 첫 단위는 `runnable(now)`와 명시 `workflow.run` 호출로 검증하고 “저장된 대기와 명시 재개”로 표시하는 것이 정직하다. 향후 worker loop가 필요하면 기존 runnable를 주기적으로 조회하는 outer adapter로 추가하고, 후보 조회가 권한 인증이나 실행 claim을 대신하지 않도록 한다.

## 비용과 모드

대기 자체는 새 logical tool/model/token 비용이 없어야 하지만 정본·원본 검증과 scheduler polling의 로컬 I/O는 발생할 수 있다. 새 successor는 별도 일반 tool attempt이므로 work의 toolCalls reservation/dispatch를 소비한다. 새 계획이면 기존 replans 규칙도 적용한다. fast mode의 replans=0 또는 toolCalls=2에 막히는 경우 cooldown을 이유로 한도를 늘리지 않는다.

operation의 ReadCheckpoint.calls에는 이전 accepted/rejected/unknown/intent가 모두 남고 maxCalls를 계속 소비한다. 새 successor의 ReadCollectionState.calls는 accepted response 수와 다르다. 실제 MCP tools/call은 wire 계수이며 새 client discovery/list는 별도다. partial 원본의 성공 항목/usage를 다시 청구하거나, wait 동안 원격 내부 작업량·미확정 전송을 0으로 정정하지 않는다. parent grant 철회/축소와 child own limit도 기존 assertBudgetAuthority 경계를 유지한다.

## 조회·컨텍스트·CLI에서 빠지기 쉬운 지점

- [WorkResources](/Users/seunghanee/Documents/secumon/runtime/src/application/work-resources.ts)의 core.calls.get은 검증된 **historical_tool_result/newObservation:false**를 반환하고 materialized에 원 result/task/refs를 넣는다. 여기에 들어 있는 과거 wait를 현재 eligible 상태로 덮어쓰지 않는다. 현재 대기 요약을 추가한다면 별도의 canonical-view 필드로 두고 source proof/current head를 재검사한다. 두 단계 복사 결과를 새 cooldown 근거로 인정하지 않는다.
- [ContextPacket](/Users/seunghanee/Documents/secumon/runtime/src/application/context-packet.ts)의 execution에는 현재 retryWakeAt가 없다. readCollections의 ReadProgress에도 wait가 없으므로 현재 model packet은 deadline/호출 개수만으로 이 조건을 알 수 없다. 선택 wait 요약을 mandatory readCollections metadata·보호 digest·strict schema에 넣고 context compact/재생성/최종 sourcesCurrent 검사에 연결해야 한다. raw provider cursor·응답 본문·권한이 없는 head 식별자는 노출하지 않는다.
- ResumePacket.runtime과 ConversationService.snapshot.execution에는 retryWakeAt가 이미 있다. 새 원본 wait 요약이 들어오면 단순 옛 timestamp 복원 대신 현재 head와의 일치 검사가 필요하다. status/restore/원본 조회가 source.fetch·모델 또는 새 wait commit을 호출하면 안 된다.
- CLI JSON snapshot은 기존 retryWakeAt를 담지만 사람이 보는 statusLine은 대기 이유·시간을 표시하지 않는다. WorkView DTO와 Web/공통 formatter에도 wait 시각·재개 가능 상태가 없다. “제한 응답으로 대기 중, N시 이후 명시 재개 가능” 정도의 bounded 안내를 추가하고, 시간 도래를 “서버 제한 해제됨” 또는 “이미 재개됨”으로 표시하지 않는다. 공개 DTO gate와 최신 응답 세대 검사는 유지한다.
- Web의 일반 run은 durable web_run_requested를 먼저 저장하며 동일 command receipt 재송신은 실행하지 않는다. due 전에 접수한 run의 같은 requestId를 due 후 재전송하면 기존 동작상 실행되지 않는다. 이 의미를 유지하거나 명시 resume 명령 계약으로 구분해야 하며 UI가 같은 버튼 재전송만으로 자동 재개된다고 가정해서는 안 된다.

## 최소 수용 시험 행렬

아래 각 핵심 runtime 시나리오는 SQLite/file-journal에서 고정 clock으로 수행한다. source 형식은 실제 SDK fixture의 명시 rate-limit 응답 한 가지부터 시작한다.

1. **최초 대기:** partial/오류 원본과 exact notBefore 저장. due-1에서 반복 workflow.run·직접 model reserve·tool reserve·미리 준비된 dispatch를 시도해 새 model/tool/SDK entry 0, 예산·wait origin 불변. stored response 채택과 만료 예약 정산은 여전히 가능하다.
2. **정확한 due:** due에서 명시 새 task/readResume가 성공하고 원 success 항목은 재조회하지 않는다. due는 원 응답 시각에서 계산하며 원 requestId/observedAt/recordedAt는 불변이다. due가 곧 complete는 아니다.
3. **동시/중복:** 두 caller·동일 command 재전송·다른 command의 동일 parent에서 successor 1개, 부모 head CAS 1개, 새 physical call 1개. ACK 유실 후 receipt 재조회는 원본/예산을 재생성하지 않는다.
4. **재시작·시간:** head 게시 후 실제 worker 종료/새 owner 재열기에서 notBefore/deadline/calls 유지. clock을 due 전후로 옮겨 remaining delay가 재설정되지 않음을 확인한다. source timestamp를 local deadline처럼 신뢰하지 않는다.
5. **pause/cancel:** due 전 pause, due 후 paused 상태에서는 entry 0. 일반 resume는 원 대기를 지우지 않는다. cancel 이후 runnable 후보/직접 재개/늦은 응답 모두 새 결과로 승격하지 않는다.
6. **기한·상위 예산:** notBefore>=deadline, 반복 제한 응답, maxCalls=0, work toolCalls/replans/fast limits, parent grant 철회에 각각 entry 0. unknown intent와 실패 wire의 기존 비용은 남는다.
7. **현재성:** 대기 중 goal/policy/labels/generation/contract 교체, raw/head 유실을 각각 재개 거절로 확인한다. 최종 authorize await 중 같은 definition 새 entry와 권한 변경도 entry 0이다. due 뒤 source snapshot 변경은 이전 성공 자료 보존+새 응답 거절이다.
8. **분류:** malformed/overflow/음수 retry 값, nonretryable/forbidden, retry metadata 없는 일반 오류와 transport unknown을 각각 구분한다. 잘못된 값으로 wait를 무한 연장하거나 immediate retry로 바꾸지 않는다.
9. **조회/compact:** 대기 중 다섯 번 compact·reopen·core.calls.get·복사본 재조회·CLI/WorkView status에서 원본 pin과 wait 유지, 새 source/model entry 0. derived frame 유실은 재생성하지만 rate-limit 원본 유실은 fail closed다.
10. **진전·기존 호환:** wait polling/해제/명령만으로 productiveSteps 또는 실패창 reset이 생기지 않는다. 기존 legacy collection/일반 retry backoff·응답 의무·write unknown·완료 우선순위는 바뀌지 않는다. generic response dueAt의 overdue 의미도 유지한다.

첫 단위 완료 표현은 “고정 합성 MCP rate-limit의 영속 대기·정해진 시각 이후 명시 재개를 두 저장소에서 검증”이 적절하다. 운영 서비스 rate-limit 협상, 전역 endpoint fairness, 상시 scheduler 운영, HTTP Retry-After, 실제 모델 판단 및 사내 API는 별도 범위로 남긴다.
