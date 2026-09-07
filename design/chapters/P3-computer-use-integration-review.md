# P3-04 컴퓨터 유즈 계약·runner의 최소 통합 검토

2026-09-06. `design/12-computer-use-tools.md`와 현재 TypeScript runtime을 읽은 독립 정적 검토다. 제품 구현, 빌드, 시험, 모델·MCP·브라우저·OS 제어 호출은 수행하지 않았다. 이 문서는 합성 driver 시험을 실제 computer use 통과로 간주하지 않는다.

## 권고

**기존 실행 runtime을 유지하고, 컴퓨터 유즈를 등록된 Tool과 작은 application runner로 붙인다.** 새 planner·workflow·작업 저장소·전역 메모리·UI 전용 업무 장부는 필요하지 않다. 첫 단위에서는 상한 있는 batch 하나를 기존 Attempt 하나로 실행하고, 중단/장애 때 전체 batch의 효과를 보수적으로 분류한다. 단계별 durable 재개와 unknown 효과 해소는 별도 명시 계약이 필요하다.

첫 단위가 제공할 수 있는 것은 합성 환경의 관측 버전·대상 선택·짧은 단계 실행·사후 조건·사용자 인계·장애 후 안전한 정지다. 실제 앱 locator/접근성/초점·입력 주입/이미지 좌표·플랫폼 권한·프로세스 재접속 검증은 실제 driver 단위에 남는다.

## 재사용할 경로

| 책임 | 현재 코드 근거 | 컴퓨터 유즈 연결 |
|---|---|---|
| 도구 등록·고정 계약·입출력 schema·권한 | [tool-contracts.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-contracts.ts:22), [ports.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/ports.ts:66) | `observe`는 read, UI 입력 batch는 보수적으로 write로 별도 등록한다. 등록된 callback/definition을 고정하고 refresh 시 계약 digest가 바뀌면 중단한다. |
| 계획과 의도 | [execution-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts:80), [execution-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts:155) | 기존 Plan/TaskSpec에 typed batch 입력을 넣고 reserve/dispatch receipt를 사용한다. 별도 LLM 실행 루프를 만들지 않는다. |
| 실제 호출 직전 검사 | [tool-broker.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-broker.ts:20) | owner, 실행/목표/범위/입력/계약, lease/deadline, 권한·공개 정책·예산 검사를 그대로 통과한다. |
| 결과 보관과 채택 | [execution-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts:248), [evidence-intake.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/evidence-intake.ts:7) | 결과는 기존 ArtifactStore에 저장하고 receive/adopt로 채택한다. action 전송 사실과 목표 조건 검증을 다른 필드로 둔다. |
| 취소·늦은 결과 | [execution-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts:93), [execution-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts:197) | pause/cancel/goal 변경은 기존 명령과 signal을 사용한다. 늦은 결과가 새 목표나 취소 상태를 되돌리지 않는 기존 채택 검사를 유지한다. |
| 장애 후 상태 | [execution-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts:368), [control.ts](/Users/seunghanee/Documents/secumon/runtime/src/domain/control.ts:17) | reserved 미호출과 dispatched write unknown을 구분한다. write를 이름만 바꾼 task로 자동 재시도하지 않는다. |
| 중복 실행 관측 | [execution-join.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-join.ts:25) | 같은 work/attempt의 local promise join을 재사용한다. 이것을 OS 입력면 잠금으로 간주하지 않는다. |
| 단계 기록 패턴 | [read-collections.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collections.ts:88), [work-transactions.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/work-transactions.ts:5) | 단계별 재개가 필요하면 artifact 저장→검증→WorkState CAS head publish 패턴을 재사용한다. 저장소를 새로 만들지 않는다. |
| compact·resume | [context-compiler.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/context-compiler.ts:25), [context-recovery.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/context-recovery.ts:27) | 현재 시도·unknown·의무·관측 artifact 참조를 보존하고 실시간 화면 ref는 재검증 대상으로 표시한다. |
| 비용 | [tool-execution-usage.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-execution-usage.ts:3) | 논리 Attempt/구현 호출, transportCalls, internalOperations, imageBytes, waitMs를 그대로 사용한다. batch 1회를 실제 입력 1회로 보고하지 않는다. |
| 조립 | [compose-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/compose-runtime.ts:27) | 기존 collectionTools와 유사한 optional computer binding→등록 Tool→runner closure를 추가할 위치다. 실제 driver는 infrastructure에서 주입한다. |

## 현재 부족한 경계

### 1. batch 진입 후에는 Broker가 매 단계 다시 검사하지 않는다

`ToolBroker.invoke()`는 마지막 검사를 마치고 `Tool.execute()`를 한 번 호출한다. 현재 Tool context는 workId/attemptId/policy/signal이며 session generation·초점·창 identity·관측 버전은 없다. 긴 driver macro가 이 안에서 계속 입력하면 중간 목표/권한 변경을 Broker가 감지해 주지 않는다.

runner가 각 driver 호출 전과 await 이후에 현재 WorkState/Attempt를 다시 읽어 목표·범위·정책·lifecycle·contract digest·실행 소유자·lease·공유 deadline을 확인해야 한다. [ReadCollections.guard/current](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collections.ts:49)가 같은 형태의 내부 반복 검사 선례다. 필요하면 반복 검사 부분만 공통 helper로 뽑고, UI 의미 검사를 일반 Broker 안으로 밀어 넣지는 않는다.

driver는 한 번에 하나의 제한된 action을 받아 물리 입력 직전 session/fencing token·초점·대상을 검사해야 한다. runner가 이미 긴 macro 전체를 driver에 넘겼다면 다음 단계 검사만으로 취소 후 입력을 막을 수 없다. signal은 중단 요청이며 이미 발생한 입력의 취소나 rollback 증거가 아니다.

### 2. Attempt lease는 화면/세션 lease가 아니다

현재 owner/lease는 업무의 한 실행 시도를 소유한다. `ExecutionJoin` 키도 work+attempt다. 서로 다른 업무가 같은 페이지/OS 입력면에 입력하는 것을 막는 전역 자원 계약은 없다. StateRepository CAS는 업무 단위이므로 서로 다른 WorkState의 lease 필드만으로 같은 마우스/키보드 소유권을 원자 확보할 수 없다.

작은 `ComputerSessionPort`가 환경 identity, tenant/principal/work, agent-created/user-provided 구분, lease, generation/fencing token, 사람 인계 상태를 반환하도록 한다. 같은 입력면의 충돌 배제는 그 자원을 실제로 관리하는 driver/session provider가 집행한다. 처음에는 한 합성 session provider 인스턴스의 arbitration까지만 검증하고 다중 프로세스/실제 OS 잠금 보장은 분리한다. 사용자 제공 세션 해제가 브라우저 프로세스 종료로 이어져서는 안 된다.

인계 질문은 기존 response obligation과 Conversation/WorkView 경로를 쓸 수 있다. 다만 generic `resolve`는 사용자 답변 저장일 뿐이다. 재개에는 새 lease/generation 확보와 실제 재관찰이 필요하며 ‘다 했음’이라는 답변만으로 이전 ref/좌표를 되살리면 안 된다.

### 3. unknown은 안전하게 막지만, 해소하는 서비스는 아직 없다

[control.ts:24](/Users/seunghanee/Documents/secumon/runtime/src/domain/control.ts:24)는 pending effect_reconciliation을 모든 일반 task보다 먼저 차단한다. [submitPlan](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts:87)도 재계획을 막고 [user resolve](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts:126)는 이 의무를 해소하지 못한다. 따라서 일반 계획에 ‘화면을 다시 보고 확인’ 도구를 넣는 것만으로는 unknown 복구가 실행되지 않는다.

첫 단위에서는 unknown을 저장하고 재시작 후에도 입력을 반복하지 않는 것을 완료 기준으로 삼을 수 있다. **이것은 unknown 효과의 자동 대조·해소까지 구현했다는 뜻은 아니다.** 현재 [workflow-crash.test.ts](/Users/seunghanee/Documents/secumon/runtime/src/tests/workflow-crash.test.ts:58)도 합성 write 후 SIGKILL에서 차단·재발생 금지를 검증하는 형태다.

해소 단계에는 일반 실행 차단을 풀기 전에 사용할, host가 허용한 read-only 대조 경로가 필요하다. 원래 intent/attempt/session generation/대상/사업 결과 식별자에 결합한 관찰로 `applied`, `not_applied`, `unknown`을 판정하고 기존 WorkState transaction에 근거와 해소를 저장한다. ‘아직 안 보임’, timeout, 오래된 성공 toast만으로 not_applied/applied를 단정하지 않는다. 단순 사용자 reason이나 임의 callback boolean으로 의무를 satisfied 처리하면 안 된다. 효과 대조를 위한 별도 실행/비용/권한 경로를 설계하기 전에는 일반 Broker 또는 budget 검사를 우회해 driver를 부르면 안 된다.

효과가 확인돼도 원래 goal이 변경/취소됐다면 과거 효과만 정산하며 현재 목표 완료 근거로 자동 채택하지 않는다.

### 4. batch 전체 의도는 있지만 단계별 의도는 없다

Plan/dispatch receipt는 batch 전체 입력을 보존한다. 마지막 ToolResult.output은 성공적으로 receive가 끝났을 때만 남으므로 ‘2단계 입력 후 3단계 직전에 프로세스가 죽음’을 단계별로 확정하지 못한다. 첫 단위에서는 이를 전체 batch unknown으로 보수 처리하면 기존 장부만으로 안전성을 유지할 수 있다.

부분 단계에서 자동 재개해야 한다면 선택적 computer progress head와 typed `step_intent/step_receipt/observation/stop` artifact가 필요하다. action 이전 intent head를 WorkState CAS로 먼저 공개하고, receipt 없는 intent는 unknown으로 복원한다. 기존 `transact`, ArtifactStore, `commitWithArtifacts`, state adapters를 재사용한다. [ReadCheckpoints](/Users/seunghanee/Documents/secumon/runtime/src/application/read-checkpoints.ts:35)는 read/collection 전용 검증이므로 write UI checkpoint를 그대로 끼워 넣지 않는다. 새 progress를 만들면 commit 참조 수집, lifecycle, context 보호, resume schema/원본 검증에도 같은 참조를 연결해야 한다.

### 5. 실패 진단 artifact와 현재 결과 계약이 충돌할 수 있다

[validateEvidence](/Users/seunghanee/Documents/secumon/runtime/src/application/evidence-intake.ts:11)는 status=error/cancelled의 evidence/artifacts를 금지한다. 따라서 실패 ToolResult에 스크린샷 artifact를 그냥 넣으면 invalid_tool_result가 된다. output 안에 미검증 참조만 숨겨 넣는 것도 피한다.

첫 단위는 실패/중단의 작은 코드·단계 상태를 output으로 반환하고 evidence/artifacts는 비운다. 보존할 원문 진단이 필요하면 기존 artifact+committed progress 참조 경로로 저장하고 공개 조회를 별도로 검증한다. partial은 실제 부분 수행·관찰이 있는 경우에만 쓰며 성공처럼 보이게 바꾸는 우회로로 사용하지 않는다.

또한 현재 `ExecutionRuntime.failure()`는 write의 Broker 진입 전 실패도 보수적으로 unknown으로 만든다. 새 runner는 입력 전 중단을 확인한 경우와 입력 후 미확인을 구분해야 한다. 입력을 전송하지 않았다는 근거가 있을 때만 effectState=none이고, 전송 여부/결과가 불확실하면 unknown이다. 기존 core의 not_invoked write 경로를 개선한다면 별도 회귀로 범위를 확인한다.

### 6. 화면 원문과 실시간 ref의 의미를 분리해야 한다

관측에는 session/environment/window/frame, generation, observation ID, observedAt, 대상 의미·유일성·범위·잘림 여부를 둔다. 좌표 관측에는 원본 artifact와 viewport/DPI/scale/좌표 변환이 필요하다. 첫 합성 단위에서는 상징적인 target ref로 stale/모호성만 검증할 수 있고 실제 좌표 정확도는 미검증으로 둔다.

도구 결과 재사용은 [ToolResultReuse](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-result-reuse.ts:18)의 opt-in 계약이다. 현재 화면 관찰/입력 도구에 일반 TTL reuse를 선언하지 않고 fresh로 처리한다. 저장된 관찰은 과거 근거이며 다음 입력을 위한 실시간 권한이나 좌표가 아니다.

화면/DOM/AX/OCR/trace는 원문이다. 관찰 artifact의 labels와 업무 disclosure floor를 유지하고, 모델에는 model 목적지 검사, UI에는 screen, 진단에는 log/artifact 공개 경계를 적용한다. [DisclosureService.readRaw](/Users/seunghanee/Documents/secumon/runtime/src/application/disclosure-service.ts:155)는 등록·연결된 원문 공개 검사에 재사용할 수 있다. 인증 정보는 typed secret reference로 driver에 전달하고 값은 task/trace/채팅에 복사하지 않는다. 관측한 웹페이지 지시는 실행 승인으로 해석하지 않는다.

## 제안하는 첫 합성 단위

1. `domain/computer-use.ts`: 버전 있는 관측/ref, 작은 typed action union, bounded batch, step outcome, 조건 판정, session grant, 사용량 DTO. 임의 JS/shell/selector macro를 기본 인터페이스로 넣지 않는다.
2. `application/computer-use-ports.ts`와 작은 runner: 위 session/driver 포트, 관찰→현재성 검사→최대 몇 단계→조건 확인, 단일 deadline·driver 호출/전송 크기 상한, 중단 분류. 실제 숫자는 합성 사례의 검증 가능한 상한으로 명시한다.
3. `createComputerTool`과 compose의 optional binding: 현재 ToolContracts/Broker/ExecutionRuntime으로 진입한다. 처음에는 한 batch의 durable Attempt를 사용하고 단계별 crash 재개는 구현 범위에서 명확히 제외한다.
4. 합성 driver: 독립된 fixture 상태/효과 카운터와 관측 generation을 갖고 stale ref, 모호한 대상, 모달/인계, 부분 입력, 늦은 결과, 취소 미응답을 재현한다. 기대 boolean을 그대로 반환하는 가짜 성공기보다 독립 fixture 상태를 사후 판정 근거로 쓴다.
5. 두 저장소 통합: 실제 reserve/dispatch/receive/adopt/recover와 Workflow checkpoint를 통과한다. 입력 전·후 crash, 결과 저장 전 crash, goal/policy 철회가 포함된다. unknown이 남으면 완료·재입력이 모두 막혀야 한다.

합성 완료 뒤 다음 단위는 증거에 근거한 effect reconciliation 및 단계별 복구다. 그 다음에 로컬 합성 웹 앱의 실제 browser driver로 locator/actionability·관찰 비용·실제 입력·사후 조건을 검증한다. OS 네이티브 driver와 사내 앱은 별도 배치 검증이다.

## 핵심 시험 판정

- 관측 후 generation/초점/창이 바뀌거나 대상이 두 개면 입력 0회, 새 관찰 또는 인계로 종료한다.
- 단계 1 뒤 사용자 pause/cancel/goal/policy 변경이면 단계 2 입력 0회이며 늦은 결과로 상태가 복원되지 않는다.
- 같은 session의 두 업무가 동시에 입력하지 않으며 같은 attempt 재요청은 효과를 추가하지 않는다. 별도 독립 session만 병렬이 가능하다.
- 입력 전달 성공만으로 evidence를 만들지 않고 의도와 결합된 업무 결과를 확인해야 confirmed/success가 된다.
- 효과 후 응답 저장 전 crash는 unknown으로 복구되고 재제출을 하지 않는다. 이후 실제 대조 서비스가 없으면 계속 blocked인 것을 정확히 보고한다.
- fast/deep에 관계없이 대상·권한·사후 조건 검사를 유지하며 차이는 관찰/탐색 상한에 둔다.
- batch 외부 호출 1, 내부 action N, 이미지 bytes, 대기 시간을 따로 센다. 더 적은 모델 왕복과 더 적은 실제 driver 작업은 다른 관측이다.
- 기본 채팅은 접수·필수 인계 질문·결과만 표시하며 상세 단계/스크린샷은 현재 공개 권한을 검사한 별도 조회로 제공한다.

이 문서의 결과는 최소 통합 제안이다. 위 합성 시험과 실제 driver 시험은 이번 읽기 전용 조사에서 실행하지 않았다.
