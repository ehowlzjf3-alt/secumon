# C05 collection 저장 전용 재개의 계획·제어 연결 검토

2026-09-07 · **읽기 검토와 최소 확장 제안이며 구현·시험 결과가 아니다.** 현재 단순 읽기 offline 제품·시험·updater는 변경하지 않았다. [일반 입구 연결 메모](C05-mcp-collections-entry-notes.md)를 기준으로, 완전 checkpoint를 명시 `readResume` successor로 소비하는 경로만 좁혀 확인했다. 공개 API는 root가 확정한다.

현재 factory에 `availability: 'stored_only'`만 전달하면 최종 답변까지 연결되지 않는다. 이는 기존 단순 읽기 offline 결함이라고 확정할 사항이 아니라 **collection 일반 입구에 필요한 새 연결**이다. 실패한 원 부모를 성공으로 되살리거나 전체 도구를 callable 목록에 복귀시키는 방식은 권고하지 않는다.

## 이미 있는 합법적 형식과 현재 단절

| 재사용 위치 | 확인한 사실 |
|---|---|
| [contracts.ts](../../runtime/src/application/contracts.ts) 35·87행, [agent-turn-contracts.ts](../../runtime/src/application/agent-turn-contracts.ts) 12행 | `TaskSpec.readResume = {attemptId, checkpointId}`와 PlanProposal을 이미 허용한다. AgentTurn의 `kind: 'plan'`도 같은 스키마를 사용한다. 별도 모델 응답 kind나 새 명령은 필요 없다. |
| [domain/context.ts](../../runtime/src/domain/context.ts) 17행, [context-compiler.ts](../../runtime/src/application/context-compiler.ts) 172·222·464행 | `readCollections`에 원 attempt/task/head·phase가 있고, 현재 실패 부모의 task와 input은 frontier에 남는다. 재개 메타데이터는 필수 문맥으로 보호되며 page 본문·cursor를 넣지 않는다. |
| [context-compiler.ts](../../runtime/src/application/context-compiler.ts) 54·124·403행 | 재개 목록의 현재 계약은 `tools.get/check`로 확인하고 checkpoint 원문을 읽는다. requiredVersions도 기존 `check`를 사용한다. 따라서 stored_only 자체는 원문 문맥을 무효화하지 않는다. |
| [read-checkpoints.ts](../../runtime/src/application/read-checkpoints.ts) 215·246행 | 검증한 checkpoint의 `project()`가 기존 ToolResult와 `output.resume`를 만든다. 다만 raw receipt→checkpoint 정산 후 실패한 부모에는 아직 result가 없으므로 `output.resume`가 모델에 있다고 가정하면 안 된다. |
| [read-collections.ts](../../runtime/src/application/read-collections.ts) 103·192·204·224행 | 원 부모와 정확한 head·query·계약·한도를 확인한 명시 successor는 exhausted collection을 복사해 phase complete로 시작한다. while(fetch)로 들어가지 않고 기존 `project()`로 결과를 만든다. |
| [mcp-read-settlement-recovery.test.ts](../../runtime/src/tests/mcp-read-settlement-recovery.test.ts) 204·231·247행 | 완전 원응답 정산 뒤 실패 부모를 그대로 두고 별도 task ID/readResume→reserve→execute→adopt를 수행하는 기존 인수가 있다. 새 fetch는 0이지만 successor의 **논리 toolCalls는 1 증가**한다. 일반 host stored_only 연결을 통과한 시험은 아니다. |

단절은 두 곳이다. compiler 410행 이후 `options.tools`, `activeToolIds`, 축소된 `policy.allowedTools`는 callable 그룹만 포함한다. [agent-turn-prompt.ts](../../runtime/src/infrastructure/agent-turn-prompt.ts) 20행은 active tool IDs와 제공된 계약만 사용하라고 요구한다. 기존 [structured-planner.ts](../../runtime/src/infrastructure/structured-planner.ts) 42행도 제공된 계약만 사용하도록 한다. 메타데이터가 남아 있다는 이유만으로 모델이 없는 실행 계약을 추측할 수는 없다.

또한 [execution-runtime.ts](../../runtime/src/application/execution-runtime.ts) 85·256·302행과 [tool-broker.ts](../../runtime/src/application/tool-broker.ts) 55·60행의 `checkExecution`은 현재 stored_only successor도 막는다. `readResume`가 있다는 이유만으로 이 검사를 무조건 통과시키면 비최종 page나 임의 새 query까지 전송 가능해지는 결함을 만든다.

## 권고: 기존 재개 항목을 참조하는 완전 checkpoint 전용 표시

현재 부모 task가 frontier에 남아 있는 첫 연결 범위에서는 `readCollections`의 해당 항목에 선택적 **`resumeMode: 'stored_complete'`** 하나를 붙이는 안이 가장 작다. 이름은 제안이다. 바깥 `attemptId`, `taskId`, `progress.head.id`가 이미 원 부모·task·head를 식별하며, frontier task가 exact toolId/version/input을 제공한다. page/body/cursor나 전체 ToolDefinition을 다시 보내지 않는다. 원 definition은 호스트 등록표의 현재 get/check와 부모 contractDigest로 검증한다.

이 표시는 “이 도구를 새로 호출할 수 있다”가 아니라 “표시된 원 task의 입력 그대로, 표시된 완전 checkpoint를 소비하는 새 successor를 제안할 수 있다”는 범위다. 모델은 기존 PlanProposal 안에서 새 task ID, 같은 toolId/version/input, 정확한 `readResume`를 사용한다. 기존 task ID에 readResume를 붙여 의미를 바꾸면 [plan-validator.ts](../../runtime/src/application/plan-validator.ts) 28행의 `task_id_contract_changed`가 거절하므로 이를 유지한다. 완료 근거·criteria나 가설을 옵션만으로 새로 만들지 않는다.

표시를 붙이기 전에 기존 ReadCheckpoints 검증으로 아래를 확인한다. readProgress summary만으로 허가하지 않는다.

- 현재 goal/scope의 읽기 부모이며 원 head가 현재 tip이고 successor가 없으며 complete+adopted 상태가 아니다. 원 dispatch의 task와 현재 frontier task가 같은 query를 가리킨다.
- 실제 checkpoint `phase === 'complete'`, `collection.exhausted === true`, 아직 처리할 intent가 없음을 확인한다. 원 response·page replay, source snapshot, 원문 ref/bytes/hash, 현재 policy·자료 세대·지식 의존성·등록 계약 검사는 그대로다. 이후 검증된 page로 수집이 끝났더라도 과거 unknown call 기록은 있을 수 있다. 기존 ReadCheckpoints가 허용하는 그 이력을 새 옵션만을 이유로 지우거나 확정 사용량으로 바꾸지 않는다.
- 옵션의 parent/head/task 관계와 정확한 toolId/version/query/contract가 일치한다. 임의 input 변경·fresh 재조회·computerResume·다른 부모·낡은 head·이미 소비한 부모는 허용하지 않는다.

**원 query task가 현재 frontier에 없다면 mode 하나로 충분하지 않다.** 그런 항목에 옵션을 발급하지 않고 원 요청/계획의 검토 대상으로 남긴다. 일반 경로에서 반드시 복구해야 한다는 요구가 있으면, 원 dispatch로 검증한 query task를 별도 최소 참조로 전달하는 추가 계약부터 확정해야 한다. 과거 task를 현재 plan 안에 몰래 삽입하거나 모델이 summary에서 query를 재구성하게 하지 않는다. 첫 인수는 원 실패 task가 현재 plan에 남은 실제 중단 경로로 범위를 명시한다.

필요한 변경 지점은 domain/context·ContextPacket 타입과 strict schema, compiler의 보호 대상/출처 검사, 주턴·기존 planner의 고정 지침이다. 기존 TaskSpec/PlanProposal 응답 형식은 보존한다. 고정 지침 변경은 기존 prompt/template 지문에 반영하고 옛 저장 입력을 고쳐 쓰지 않는다. 별도 `ModelCallOptions.tools` 항목이나 active ID를 추가하지 않으므로 catalog 검색은 계속 stored_only 도구를 제외한다.

## 실행 예외는 task별 원문 검증 뒤에만

전용 옵션은 실행 권한 토큰이 아니다. reserve/dispatch/Broker에서 **현재 저장소를 읽어 같은 완전 head를 증명하는 좁은 guard**를 공유하는 편이 안전하다. 기존 `checkExecution`의 모든 오류를 완화하지 않고 `tool_connection_required`가 나온 collection의 exact stored-complete successor만 대상으로 한다. 일반 `check`의 입력·정책 오류는 그대로 거절한다.

동기 제어는 기존 readWaitControl처럼 metadata 후보만 판단할 수 있다. 실제 예약 게시 전, dispatch 게시 전, Broker 진입·마지막 await 뒤에는 ReadCheckpoints.read와 현재 state/entry/head 재확인을 수행한다. 원문 read와 commit 사이에 head·goal·policy·등록표가 바뀌면 다시 준비하거나 거절한다. 새 boolean `allowOffline`을 caller가 주입하는 식으로 넓히지 않는다. ReadCollections.execute도 완전 부모 소비 분기임을 확인하며, 조건이 어긋났을 때 fetch로 흘러가지 않는다. 기존 fetch의 authorize는 마지막 방어로 유지한다.

같은 `stored_complete` 동작은 등록 availability가 online/available로 바뀌어도 여전히 무송신 소비일 수 있다. **모드의 의미를 원격 연결 상태와 분리**하면 된다. outgoing에서는 광고한 옵션의 parent/head/task와 현재 등록 정의·권한이 여전히 같고 정확히 허용된 무송신 행동인지 별도로 확인한다. 일반 options.tools에는 지금까지의 callable 재검사를 유지한다. 받은 모델 응답을 채택할 때도 옵션의 원출처/정확한 계획은 재검증하지만, 나중에 availability가 stored_only가 됐다는 이유만으로 이미 받은 응답 자체를 버리지 않는다. 실제 successor 실행 시에는 다시 현재 task 권한을 검사한다. 기존 received ToolResult/page 증명에도 callable 검사를 넣지 않는다.

새 successor는 기존 논리 시도·예산·lease/CAS와 부모 successor 연결을 사용한다. 외부 MCP 호출 0을 논리 toolCalls 0이나 추가 자원 허가로 바꾸지 않는다. 실패한 부모의 status/result/owner를 덮거나 이미 실패·취소된 본문을 부모 결과로 자동 채택하지 않는다.

## 초기 page 상태별 모델 호출과 대기

| 검증한 초기 상태 | 최소 진행과 모델 호출 경계 |
|---|---|
| raw receipt가 있고 마지막 page가 최종 | 최초 compact/context보다 앞에서 기존 ReadReconciliation으로 정산한다. 정산 전의 unknown 요약으로 모델을 먼저 부르지 않는다. 정확한 successor가 이미 계획에 있으면 모델 호출 없이 실행한다. 없으면 위 전용 옵션으로 **한 번의 필요한 successor 계획 턴**을 허용하고, 무송신 소비·adopt 뒤 일반 답변 턴으로 간다. 이 경우 전체 모델 호출 0을 목표로 삼거나 원 부모 자동 adopt로 절약하지 않는다. |
| 마지막 저장 page가 비최종/실패 항목 있음 | 저장 page 정산까지 먼저 수행한다. 다음 request가 필요한 tip만 남고 stored_only라면 연결 대기를 반환해 successor 제안 모델을 호출하지 않는다. 온라인 명시 재열기 후 필요한 cursor/retryIds로 successor를 계획·실행한다. 별도 독립 실행 가능한 작업·이미 received인 결과 처리는 막지 않는다. |
| 검증된 전체 deferral/항목 retryAt의 기한 전 | 기존 readWaitControl→validateReadWaits/assertReadWaitReady를 재사용해 원 기한을 유지한다. 새 successor·모델·call 0이다. 재열기 시각으로 기한을 다시 계산하지 않는다. |
| 기한 도달 후에도 stored_only | 새로운 기한이나 polling을 만들지 않고 connection_required로 전환한다. 모델을 먼저 부르지 않는다. online 재열기 이후에만 정확한 다음 요청을 보낸다. |
| raw-only/intent-only, 손상·다른 소유자·원문 권한 상실 | 완전 checkpoint 옵션을 발급하지 않는다. 현재 복구 거절/unknown 의미를 연결 대기로 숨기거나 영수증을 만들어 완화하지 않는다. |

[domain/control.ts](../../runtime/src/domain/control.ts) 59행은 부모에 readProgress가 있으면 taskGate 전에 건너뛴다. 따라서 factory availability만 추가하거나 taskGate만 고쳐서는 비최종 page가 `plan_cannot_complete_goal` 재계획으로 빠지는 것을 막지 못한다. [execution-decision.ts](../../runtime/src/application/execution-decision.ts) 51행의 replan→read wait 합성 위치에 인접하여, **실행 가능한 독립 후보가 소진된 뒤 현재 actionable collection tip의 다음 요청 필요성**을 판단하는 분기를 권고한다. 전체 frontier나 완료한 의존 작업을 일괄 차단하지 않는다. goal/input/가설 변경에 필요한 별도 검토까지 숨기지 않도록 plan-cannot-complete 재계획의 연결 사유에 한정하고, 기존 terminal/obligation/budget/progress와 예약 만료 우선순위를 유지한다.

이 판정은 [PlanningRuntime.reserveModel](../../runtime/src/application/planning-runtime.ts) 215행의 model-needed 검사와 [WorkflowRuntime.finish](../../runtime/src/application/workflow-runtime.ts) 121행의 최종 제어 계산에 같은 결과로 도달해야 한다. 처음 복구를 앞당겨도 finish가 다시 replan으로 덮으면 사용자에게 연결 대기가 남지 않는다. 명시 compact와 원문 검증은 새 계획 모델 호출과 구분하며, 필요한 context 보관 검사를 없애는 최적화는 하지 않는다.

비최종이라고 항상 연결 대기로 바꾸는 것도 피한다. [nextRequest](../../runtime/src/application/read-collection-validation.ts) 97행은 호출·page·항목 상한과 영구 실패 항목을 구분한다. 현재 원 checkpoint에서 다음 요청이 합법적으로 가능한 경우에만 연결 필요를 반환하고, `read_call_limit`·`read_page_limit`·`read_item_limit`·`read_retry_forbidden`은 기존 제한/재검토 사유로 유지한다.

## 기존 시험에 붙일 최소 인수

- [read-collection-context.test.ts](../../runtime/src/tests/read-collection-context.test.ts): 완전 orphan의 mode·원 frontier task 참조가 필수 입력이고, inactive ID/callable 목록은 비어 있음을 확인한다. parent/head/query/contract 변경과 raw 소실을 추가하고 기존 여러 compact·재열기·출처 제거 시험을 재사용한다.
- [model-tool-availability.test.ts](../../runtime/src/tests/model-tool-availability.test.ts)와 [agent-turn-adapter.test.ts](../../runtime/src/tests/agent-turn-adapter.test.ts): 기존 PlanProposal/readResume가 정확한 전용 옵션 하나만 선택한다. 새 임의 query/일반 stored-only task는 허용하지 않으며 송신 전 옵션 현재성, received 뒤 availability 변경과 원문 손상은 서로 다르게 검증한다.
- [mcp-read-settlement-recovery.test.ts](../../runtime/src/tests/mcp-read-settlement-recovery.test.ts): 이미 있는 최종/비최종/deferral 중단 fixture와 failed 부모 보존·successor 관계·정산 기대값을 일반 host 등록 인수에서 재사용한다. 새 별도 복구 장부나 가짜 client로 통과를 대체하지 않는다.
- [tool-availability-runtime.test.ts](../../runtime/src/tests/tool-availability-runtime.test.ts): 최종 head 무송신 successor만 narrow gate를 통과하며, 비최종/due wait는 모델·예약 증가 없이 최종 연결 대기로 남는다. 원 lease·독립 작업·예산과 실제 송신 실패 maxAttempts 경계는 기존 인수를 확장한다.
- 일반 CLI/HTTP 인수: 두 C01 backend에서 최종 page는 필요 계획 1회→fetch 0→adopt→답변, 비최종과 기한 wait는 새 모델 0→명시 online→필요 request만 실행한다. 실제 stdio/IPC/프로세스 인수는 root가 조율하며 이 검토에서 실행하지 않았다.

실제 모델 의미 품질·API/사내 서비스·Windows·PostgreSQL 및 collection 전송 후 권한 변경의 custody 확장은 이 계획 경계만으로 검증되지 않는다. 특히 plain의 원응답 보관 허가를 collection 요청별로 이미 연결했다고 표현하지 않는다.
