# C05 collection 일반 재개의 복구 순서 검토

2026-09-07 · **읽기 검토와 구현 전 제안이다.** [일반 입구 준비 메모](C05-mcp-collections-entry-notes.md)를 현재 소스와 대조했다. 아래 local ticket과 로컬 successor 소비 API는 아직 확정하거나 구현하지 않았다. 제품·시험·기존 문서는 변경하지 않았고 새 시험·SSH·모델 호출도 실행하지 않았다. 선행 단순 읽기 offline 검증을 collection 일반 입구의 통과 근거로 사용하지 않는다.

## 초기 문맥보다 늦은 collection 복구

현재 호출 순서는 다음과 같다.

```text
Workflow.run
  authorize / expectedGoalRevision → knowledge·obligation·notification refresh
  settleStoredResult (plain read만)
  compactStep
  ContextRecovery.restore → readSessionContext
  Planning.step → Execution.step / recover
    ReadReconciliation.reconcile
```

[WorkflowRuntime](../../runtime/src/application/workflow-runtime.ts)의 98행은 최초 문맥보다 먼저 `settleStoredResult`를 부른다. 그러나 [ExecutionRuntime](../../runtime/src/application/execution-runtime.ts)의 713행 메서드는 collection을 제외한다. collection의 원응답 정산은 `recover`의 674행 또는 `step`의 743행에 있다.

따라서 `mcp-page` 원응답 영수증을 남긴 뒤 죽은 **running collection**은 선행 복구에 선택되지 않는다. [PlanningRuntime.compactStep](../../runtime/src/application/planning-runtime.ts)은 running/received 시도가 있으면 새 compact를 예약하지 않는다. 이후 [ContextRecovery.snapshot](../../runtime/src/application/context-recovery.ts)의 `readSessionContext`에서 용량 오류가 나면, 기존 lease 만료 처리와 collection reconciliation에 도달하기 전에 일반 재개가 끝날 수 있다.

이것은 reconciliation이 항상 packet bytes를 줄인다는 주장이 아니다. 정산은 새 checkpoint와 참조를 추가할 수 있다. 필요한 것은 먼저 원 lease 만료·저장 정산을 처리해 이후 compact가 가능한 상태로 만드는 **순서**이며, 실제로 낮은 첫 문맥 한도를 둔 인수로 확인해야 한다.

최소 연결 후보는 기존 선행 복구 옆에 collection 전용의 유한한 정산 단계를 두는 것이다. 만료한 running read collection에는 기존 `recover` 전이를 적용한 뒤 reconciliation을 재사용하고, 이미 terminal이며 미정산 call이 있는 경우는 reconciliation만 수행한다. 이미 received인 collection 결과의 기존 adopt도 초기 문맥보다 앞에 둘 후보이다.

이 단계에는 새 reserve·dispatch·model·fetch를 섞지 않는다. 기존 `maxSteps`와 `onStep`에 실제 전이를 반영하고, 원응답이 없거나 head가 바뀌지 않았는데 계속 `continue`를 반환해 같은 후보를 반복하지 않는다. 현재 work의 취소·정지·실패·완료 제외, 원 actor/scope/session, owner·lease와 원 귀속은 유지한다. `ReadReconciliation.current`는 상태·등록·원 checkpoint·knowledge를 재검사하지만 **host authority lease 자체는 검사하지 않는다.** 새 일반 선행 경로에는 비동기 검사 뒤와 게시 직전의 현재 host authority 검사가 필요하다. DB commit과 signal 변경이 원자적이라는 새 보장을 만들지는 않는다.

## 정산 완료와 결과 채택 사이에 남는 경계

[ReadReconciliation](../../runtime/src/application/read-reconciliation.ts)은 원 intent head와 `mcp-page` 영수증을 검증하여 accepted/deferred call 및 새 checkpoint를 게시한다. 부모 시도의 결과를 채택하거나 새 예산을 예약하지 않는다. `readProgress`와 원본 참조는 갱신하지만 부모의 failed 상태·원 owner·result null·미채택 상태를 성공으로 바꾸지는 않는다. checkpoint의 사용량 기록이 생겼다는 사실과 부모 `execution.usage`를 보완했다는 주장을 구분해야 한다.

실제 [기존 정산 복구 시험](../../runtime/src/tests/mcp-read-settlement-recovery.test.ts)의 199~244행은 그 다음 단계를 명시한다. 최종 페이지를 정산한 경우에도 새 `readResume` task를 `submitPlan`으로 제출하고, successor를 `reserve → execute → adopt`하여 완료한다. 그 경우 실제 fetch는 0이지만 successor의 논리 toolCalls는 1 증가한다. 부모는 failed/미채택·원 owner를 유지하고 원 head와 successor 링크를 보존한다.

이 시험은 과거 session과 무송신 call 대역으로 조립한다. 이를 실제 `stored_only` Tool로 바꾸면 [ExecutionRuntime.reserve](../../runtime/src/application/execution-runtime.ts)의 `requireCallable`이 그 무송신 successor까지 차단한다. **factory와 선행 reconciliation만 연결해도 최종 일반 답변이 된다고 볼 수 없는 이유**다.

## 완료 checkpoint의 로컬 소비 제안

부모 기록을 고치지 않는 방향으로는 기존 **명시적 `readResume` successor**를 유지하고 완료 checkpoint 소비만 좁게 허용하는 방안을 권고한다. 다음은 아직 채택된 계약이 아니다.

1. metadata의 `phase: complete`는 스케줄 힌트로만 쓴다. reserve/dispatch 직전에 [ReadCheckpoints.read](../../runtime/src/application/read-checkpoints.ts)로 원 head 전체를 검증하고, exhausted·미정산 intent/unknown 없음·retryAt 충족·원 query/contract/limits/goal/policy/generation·부모 successor 부재를 확인한다.
2. 그 검증과 정확한 parent head·현재 등록 entry·state에 묶인 **instance-bound local ticket**을 발급하는 작은 내부 경계가 후보이다. 이 ticket에 한해서 실행 불가 사유 중 connection 오류만 로컬 소비로 분기한다. 다른 계약·현재 호스트 권한·예산·owner·lease 검사는 그대로 둔다. 단순 boolean이나 모델이 보낸 “검증됨” 표지를 권한으로 사용하지 않는다.
3. 소비는 **일반 `Tool.execute`나 source `fetch`를 호출하지 않는다.** [ReadCollections.execute](../../runtime/src/application/read-collections.ts)에 이미 있는 ‘완료 parent에서 child checkpoint 생성·publish → ReadCheckpoints.project’ 부분을 작게 추출해 코어에서만 실행하는 안이다. 실제 네트워크 호출이 가능한 경로로 fallback하지 않는다.
4. 이후 정상 receive/adopt를 사용한다. 부모 failed 상태·원 owner·원 usage를 재작성하지 않고 기존 successor 링크만 연결한다. 현재 시험과 같은 child 논리 toolCalls 1 / transportCalls 0 의미도 보존한다. 이를 전체 비용 0이라고 바꾸어 설명하지 않는다.
5. 비동기 읽기 뒤, reserve·dispatch 게시 직전, 로컬 투영·receive/adopt 전에도 정확한 현재 head·등록·상태·권한과 원문 증명을 재검사한다. partial 또는 다른 head로 바뀌었거나 원문이 사라지면 ticket을 폐기하고 거절한다. 저장 전용 도구를 전역 `available`로 바꾸거나 `StoredToolResults`의 plain 검사를 느슨하게 하지 않는다.

**모델의 명시적 successor 선택 경로도 결정해야 한다.** 현재 계획에 `readResume` task가 없으면 이 로컬 소비 경로만으로 자동 완료되지 않는다. 기존 시험은 새 계획을 직접 제출하며, 현재 새 모델 입력의 callable 목록에서는 stored-only collection 정의가 빠진다. 모델이 어떤 허용된 표현으로 검증 대상 successor를 선택하고 기존 plan 검증을 통과할지까지 연결해야 한다. 호스트가 모델 선택을 대신한 가짜 계획을 몰래 만들거나, 모든 저장 전용 도구를 송신 후보에 되돌리는 방식으로 이 공백을 숨기지 않는다. 이 선택 계약이 미확정인 상태에서 일반 최종 답변의 완결을 약속하지 않는다.

## 부분 정산과 두 종류의 대기

부분 정산 뒤에는 [domain/control](../../runtime/src/domain/control.ts)의 57~59행이 `last.readProgress` 또는 maxAttempts 때문에 기존 task를 건너뛴다. 그러면 task allocation gate의 connection 검사에 닿지 못하고 replan으로 흐를 수 있다. [readWaitControl](../../runtime/src/application/read-waits.ts)은 미래 retryAt이 있을 때만 이 replan을 `read_retry_wait`로 덮는다. 비최종 페이지나 retryAt이 지난 부분 결과는 같은 보호를 받지 않는다.

최소 제어 보강 후보는 실행 가능한 독립 작업을 먼저 선택한 뒤, 미완료·후속 없는 collection에 대한 fallback에서 대기를 합성하는 것이다. 원 retryAt 이전에는 `read_retry_wait`, 이후 저장 전용이면 `connection_required`로 표현한다. metadata는 스케줄 힌트이고, 실제 실행·후속 선택에는 기존 `validateReadWaits`의 원 checkpoint/page/deferral 검증을 유지한다. 원 계약·권한 오류를 연결 대기로 숨기지 않는다.

`absent`는 빈 페이지나 완료를 뜻하지 않는다. raw-only/intent-only·unknown을 정상 partial로 확정하거나 같은 요청을 몰래 재전송하지 않는다. 원 retryAt을 재접속 시각부터 다시 계산하지 않고, 성공한 item·원 cursor/snapshot·실패 retryIds·operation/root attempt·남은 한도를 유지한다.

collection의 전송 후 권한 상실은 plain custody와 별개이다. 현재 MCP collection call에는 decoded capture가 없고, 응답 뒤 authorize 실패는 raw/response 게시 전에 끝날 수 있다. 이번 저장 페이지 재개를 연결해도 페이지별 늦은 수신 보관·알려진 비용 정산을 완성했다고 주장하지 않는다. 현재 raw 권한·원 정책 검사를 그대로 유지하며, 구형 `sent`를 원격 실행·청구의 확정 증거로 해석하지 않는다.

## 가장 가치 있는 일반 입구 인수

| 흐름 | 새로 확인해야 할 경계 |
|---|---|
| 실제 CLI: 긴 세션·낮은 첫 문맥 한도, 최종 raw receipt 뒤 SIGKILL → stored-only 재개 | 원 lease 만료·정산 → 필요한 compact → 검증된 로컬 완료 소비 → 정상 답변 순서. 같은 원응답 재송신 0, 저장 전용 peer 0, 반복 정산·답변 중복 0. 상태 조회는 읽기로 유지한다. |
| 실제 HTTP: 비최종 page 정산 → 연결 대기 → 명시 online 열기 | 원 cursor/snapshot에서 다음 page만 호출하고 이미 받은 items·원 영수증·남은 한도를 보존한다. 실패한 업무 전체를 새 업무로 다시 만들지 않는다. |
| 실제 HTTP: deferral 또는 항목 부분 실패 뒤 재접속 | 원 retryAt 이전 새 모델/예약/call 0, 이후에도 stored-only는 연결 대기. online에서 실패 retryIds 또는 필요한 다음 요청만 보내고 성공 항목을 반복 수집하지 않는다. |
| 일반 재개 중 변경·증거 부재 | 첫 복구 await 중 정책/host signal/원 head/원문 변경과 raw-only·intent-only에서 명시 거절, 원본·영수증 보존, 새 송신 0. 손상을 정상 대기로 가리지 않는다. |

핵심 흐름은 C01 SQLite/file-journal 두 backend와 실제 로컬 peer 감사를 사용한다. 기존 저수준 오류 조합을 전부 복제하는 대신 새 호스트 조립·일반 CLI/HTTP·첫 문맥 순서·명시 successor 선택에 집중한다. 실제 모델 의미 품질이나 사내 서비스·Windows·PostgreSQL 검증은 이 제안에 포함하지 않는다.
