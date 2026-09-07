# C05 단순 MCP 원응답 수신 뒤 중단 복구

<!-- C05-MCP-RECOVERY-NARRATIVE-PROOF: f2fbe8a2e971f29bf182a9cf018d8122ef38b1c7996628e4e6b8da1b4e926960 -->

2026-09-07 · **단순 MCP 저장 응답 복구를 구현하고 지원 POSIX에서 검증했다. macOS Node24 신규 55/55·관련 421/421, NAS Linux Node24 신규 55/55·관련 421/421·전체 3,423/3,423 통과.** 같은 소스·빌드의 필수 8단계·회수·정리가 [복구 확정 증거](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json)로 확정되었다. [현재 구현 결과](C05-mcp-response-recovery-result.md). C05 전체와 C01–C10 목표는 미완료다. 실제 모델/API 시험은 중단 상태이며 합성 모델·로컬 MCP peer의 계약 인수를 실제 모델 품질이나 사내 서비스 운영 검증으로 해석하지 않는다. native Windows runtime/file 연결·검증, PostgreSQL 및 설치·운영도 남아 있다.

MCP 최초 입구 연결 당시의 기록: [로컬 신규 30개](../../runtime/evidence/C05-mcp-new-result.json)·[관련 572개](../../runtime/evidence/C05-mcp-related-result.json), [build](../../runtime/evidence/C05-mcp-build2.json)/[core](../../runtime/evidence/C05-mcp-core2.json)/[계층](../../runtime/evidence/C05-mcp-architecture2.json) 검사를 통과했고 NAS 실행 22557도 전체 3,368/3,368·필수8단계와 회수·정리를 완료했다. [선행 확정 증거](../../runtime/evidence/C05-mcp-linux-nas-20260907/verification.json)를 보존한다. 선행 시험의 통과를 이 복구 경계의 증거로 사용하지 않는다.

목표는 MCP가 반환한 원응답과 그 영수증을 저장한 뒤, 실행기의 `result_received`를 쓰기 전에 프로세스가 종료되어도 같은 담당·같은 업무·같은 실행 시도의 결과를 이어 처리하는 것이다. `SIGKILL`은 프로세스가 정리 코드를 실행할 기회 없이 종료되는 상황이다. 복구는 저장된 증명을 읽는 작업이며 `tools/call`을 다시 보내는 작업이 아니다.

첫 단위는 기존 **단순 읽기**에 한정한다. 원응답이 있어도 귀속 증명이 없으면 성공으로 만들지 않는다. 원응답 보관과 현재 목표에 근거를 채택하는 과정도 분리한다. [MCP 최초 연결 계획](C05-mcp-host-plan.md)의 raw 복구 → 전송 후 권한 변경 → 서버 없는 재개 → 페이지·대기 입구 연결 순서를 유지한다.

## 구현에서 확정한 연결

`Tool.restoreResult`는 선택 콜백이며 도구 설명·버전 지문과 기존 원응답 저장 형식은 유지한다. `StoredToolResults`가 원문과 영수증을 읽어 검증한 뒤, 해당 실행기 안에서만 사용할 수 있는 복구 확인 객체를 발행한다. 일반 `receive`의 원 소유자 검사는 유지한다. 새 소유자가 원 소유자의 이름이나 기한을 바꾸는 방식은 사용하지 않는다.

복구 결과를 받기 직전까지 원문, 현재 상태와 실행 권한을 확인한다. 다른 상태 변경이 생기면 낡은 확인 객체를 버리고 다음 단계에서 다시 검증한다. 원응답 영수증이 없으면 `stored_result_unavailable`, 증명을 검증할 수 없으면 `stored_result_recovery_failed`로 원 시도를 차단한다. 두 경우 모두 새 조회를 자동 예약하지 않는다. 이미 다른 주체가 차단한 업무는 기존 사유를 보존하며, 명시적으로 재개한 뒤 복구할 수 있다.

실제 재개 순서는 **저장 응답 수신 → 이미 받은 결과의 채택 또는 거절·정산 → 필요한 컴팩트 → 문맥 체크포인트 → 이후 계획과 실행**이다. 첫 체크포인트를 만들기 전에 이미 실행된 도구의 결과만 처리하는 `settleStoredResult`를 둔다. 이 경로는 새 도구 호출이나 모델 호출을 예약하지 않으며, 기존 단계 상한과 진행 알림을 함께 사용한다. 같은 원문을 더 작은 문맥 한도로 다시 열었을 때도 먼저 수신·정산하고 컴팩트를 진행할 수 있게 하기 위한 순서다.

이미 `received`로 저장된 결과에는 기존 거절·정산 규칙을 적용한다. 권한이 취소되었더라도 이미 측정된 사용량을 없애지 않는다. 새 원문 복원 권한은 마지막 검증 콜백이 끝난 뒤에도 다시 확인한다. 과거 기한 만료의 실패 이력은 보존하고, 복원된 근거가 실제 채택된 경우에만 별도 진척을 한 번 기록한다.

현재 신규 5개 파일은 코어·실행기·MCP 원문·실제 stdio 프로세스 중단·컴팩트 순서를 다룬다. macOS Node24 신규 55/55·관련 421/421, NAS Linux Node24 신규 55/55·관련 421/421·전체 3,423/3,423 통과. 실행한 범위와 한계는 [결과 문서](C05-mcp-response-recovery-result.md)와 [복구 확정 증거](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json)를 따른다. 아래는 착수 당시의 경계 조사·계약 제안·시험 계획을 보존한 기록이며, “현재 공백”·“추가할” 표현은 당시 상태다.

## 착수 전 확인한 경계

| 현재 코드 | 확인된 동작과 이번 공백 |
|---|---|
| [mcp-read-tools.ts](../../runtime/src/infrastructure/mcp-read-tools.ts)의 `execute`, `intentId`, `responseId` | `dispatch` 확인 → `mcp-intent:<attemptId>` → 원격 호출 → envelope artifact → `mcp-response:<attemptId>` → `projectResult` 반환 순서다. 원응답 영수증은 artifact를 같은 업무 상태에 연결하지만 `Attempt.resultArtifact`는 아직 없다. |
| 같은 파일의 `readProof`, `projectResult` | dispatch·intent·response 영수증, artifact의 실제 바이트·SHA-256, 입력·계약·정책·목표 지문, 자료 수명 세대와 출처를 검증한다. projector는 저장된 SDK 응답에서 같은 결과를 재구성할 수 있지만 현재는 결과 검증 안에서만 사용하며 별도 복원 메서드가 없다. |
| 같은 파일의 `execute` | intent가 있는 같은 시도의 재호출은 `mcp_attempt_already_started`로 거절한다. 이를 지우거나 `execute`를 복구 API로 사용하면 안 된다. |
| [execution-runtime.ts](../../runtime/src/application/execution-runtime.ts)의 `dispatch`, `receiveOnce`, `adoptOnce`, `recover` | 논리 도구 호출은 dispatch에서 이미 1회 사용 처리된다. receive가 `receive:<attemptId>` 영수증과 결과 artifact·측정 usage를 저장하고 adopt가 근거를 채택한다. receive는 현재 실행자와 원 attempt의 owner가 다르면 거절한다. recover는 만료를 먼저 기록하므로, 그 뒤 일반 receive를 억지로 호출해도 `lease_expired`가 채택을 막는다. |
| [read-reconciliation.ts](../../runtime/src/application/read-reconciliation.ts)의 `reconcile` | collection은 `restoreReadResponse`로 원응답을 읽고 만료 attempt의 checkpoint를 정산한다. 원 attempt 소유자·lease를 바꾸지 않고, 근거 채택·예산 배정·재전송도 하지 않는다. **단순 읽기의 결과 수신과 동일한 상태 전이가 아니다.** |
| [domain/control.ts](../../runtime/src/domain/control.ts)의 `decide`와 실행기 `step` | received 채택, 만료 recover가 신규 reserve보다 앞선다. 이 순서에 복원을 넣어야 원응답이 있는데 다음 시도를 예약하는 일을 막을 수 있다. 이미 만료 처리된 후보는 현재 collection 재조정처럼 신규 제어 결정 전에 확인할 연결도 필요하다. |
| [context-recovery.ts](../../runtime/src/application/context-recovery.ts)의 `snapshot` | 현재 상태·원문 참조·권한·세션·기억을 검증해 재개 문맥을 만든다. 여기서 MCP 함수를 호출하거나 누락 결과를 임의 생성하지 않는다. |

보관된 원문은 SDK가 해석한 MCP 응답의 JSON이다. 네트워크에서 전달된 원본 프레임 바이트를 보관한다고 표현하지 않는다. 모델 답변이나 projector의 가공 결과만으로 원응답을 대신하지 않는다.

## 추가할 가장 작은 계약

**등록된 읽기 도구에 저장 결과 복원 콜백을 선택적으로 추가하고, 실행기 내부의 복구 수신에서만 사용한다.** 아래 이름은 구현 착수 때 확정할 제안이다.

```ts
// application/ports.ts의 안쪽 계약 제안. MCP 전용 클래스에 의존하지 않는다.
interface StoredToolResultInput {
  attemptId: string;
  task: TaskSpec; // 현재 모델이 다시 만든 task가 아닌 원 dispatch의 task
}
type StoredToolResult =
  | { kind: 'absent' }
  | {
      kind: 'available';
      result: ToolResult;
      receivedAt: number; // 검증한 원 envelope의 recordedAt
      receipt: { commandId: string; digest: string; artifact: ArtifactRef };
    };
// Tool.restoreResult?(state, input): Promise<StoredToolResult>
```

원응답 영수증이 없는 경우만 `absent`다. 영수증은 있는데 파일이 없거나 지문·소유자·정책이 다르면 오류다. 손상된 결과를 “없으니 다시 호출”로 바꾸지 않는다. `available` 형식만 맞는다고 신뢰하지 않고 현재 등록 도구의 proof 검사를 다시 통과해야 한다.

`ToolContracts`는 콜백을 고정하고, 결과 형식·원문 크기·수신 시각·원 영수증·등록 현재성을 확인하는 작은 호출 경계만 제공한다. [snapshotTool](../../runtime/src/application/tool-contracts.ts)이 이 메서드도 기존 메서드처럼 수신자와 함께 캡처하고 잘못된 콜백을 거절한다. 호스트 source의 기존 `snapshotTool` 사용을 통해 같은 경계가 전달되도록 한다.

첫 구현은 `effect: 'read'`, `resultValidation: 'artifact-proof-v1'`인 단순 도구만 허용한다. collection, computer continuation, effect receipt, reuse 결과를 이 경로로 받지 않는다. 기존 `restoreReadResponse`에 억지로 `ReadRequest`·checkpoint를 만들어 넘기지 않는다.

**기존 저장 형식을 불필요하게 바꾸지 않는다.** 복원 콜백은 호스트 코드의 기능이다. 이를 표시하려고 기존 `ToolDefinition`에 새 필드를 일괄 삽입하면 contractDigest가 바뀌어 이미 저장된 원응답을 현재 도구가 검증하지 못한다. 첫 단위는 선택적 런타임 메서드를 사용하고, 기존 definition·해시 포함 버전·envelope v1·영수증 해시는 그대로 유지하는 안을 권고한다. 이전 형식의 같은 raw 영수증을 새 복원 경로가 읽는 호환 시험을 둔다. projector의 의미가 바뀌면 기존 규칙대로 projectorVersion을 바꾸며 과거 출력으로 위장하지 않는다.

## MCP 안쪽 구현과 실행기 연결

1. **원응답 읽기 한 곳을 재사용한다.** `mcp-read-tools.ts`의 `readProof`에서 영수증·바이트·envelope 검증을 작은 내부 함수로 추출해 `validateResult`와 새 `restoreResult`가 공유한다. `projectResult`도 같은 함수를 쓴다. MCP의 별도 DB, 결과 캐시, 새로운 원응답 복사본은 만들지 않는다.
2. **원 영수증에서 해당 artifact만 고른다.** collection의 `restoreResponse`처럼 `mcp-response:<attemptId>` 영수증의 상태에 있는 참조를 receipt digest와 대조해 정확히 1개를 선택한다. 현재 단순 `readProof`의 `artifacts.at(-1)` 순서 가정보다 귀속 증명을 명시한다. 다른 artifact 본문이나 디렉터리를 검색하지 않는다. 기존 최대 envelope 512KiB와 JSON·관측 항목 제한을 보존한다.
3. **전체 원 호출을 대조한다.** 원 dispatch의 owner·attempt ID·task/inputDigest·contractDigest, intent digest와 저장 세션, response digest·artifact 바이트, endpoint/protocol/remote 계약/projector 버전을 확인한다. 기존 `readProof`는 현재 goal/policy 동일성, response 당시 owner·lease·상태, 원 lease 상한과 영수증 revision 순서를 모두 검사하는 함수는 아니다. 공유 원문 검증에 더해 복원 전용 검사를 둔다. envelope `recordedAt`은 응답 캡처 시각, 영수증 상태 `updatedAt`은 트랜잭션 준비 시각이며 현재 시각으로 덮어쓰지 않는다. 재연결 세대가 달라도 기존 계약과 출처가 같으면 원응답 증명은 유지될 수 있다. 새 서버 세대를 과거 envelope에 써넣지 않는다.
4. **일반 receive 권한은 유지한다.** 새 실행자가 이전 owner인 척 `ExecutionRuntime`을 생성하거나 attempt.owner를 자기 값으로 바꾸지 않는다. 공개 `receive`의 owner 검사를 삭제하거나 caller가 `force`, 임의 owner, 복원 결과 JSON을 넘기게 하지 않는다. 제안 `restoreStoredResult(workId, attemptId)`는 현재 등록 도구와 저장소에서 직접 증명을 읽고, 검증 완료한 경우에만 기존 `receiveOnce`의 공통 결과 검증·저장 부분으로 연결한다. 범용 함수에 MCP 영수증 이름을 하드코딩하지 않는다.
5. **기존 실행 영수증을 한 번 게시한다.** 결과 artifact와 `receive:<attemptId>` / `result_received`를 재사용한다. 일반 실행과 복구가 경합해도 같은 결과는 같은 영수증에 수렴하고 다른 결과는 identity 충돌이다. 복원 경로 전용 완료 파일·두 번째 정산 장부는 추가하지 않는다. source proof, 등록 entry identity, 상태·권한·수명 세대는 비동기 읽기 뒤와 commit 직전에 재확인한다.
6. **신규 실행 결정 앞에 연결한다.** 만료 `recover`에서 일반 만료 기록을 쓰기 전에 저장 결과를 확인한다. 이미 `lease_expired`이지만 결과가 없는 단순 읽기도 아래 제한 후보에 한해서 `step`의 신규 reserve/replan 결정 전에 확인한다. 현재 `PlanningRuntime.step`은 일반 실행 결정을 `execution.step`에 위임하므로 별도 모델 복구 루프를 만들지 않는다. 저장 결과가 `received`가 되면 기존 adopt·완료 평가·대화·outbox가 처리한다.

`PlanningRuntime.step`은 실행기 호출 전에 `compactStep`을 검사한다. running/received 시도는 이미 compact를 막지만, 이전 recover로 failed가 된 복원 후보는 이 조건에 들지 않는다. 따라서 **저장 응답 복원을 위한 새 모델 호출이 먼저 발생하지 않게** 이 순서도 연결한다. 동일한 후보 판정 함수를 재사용하여 compact를 미루고 기존 execution.step에서 복원하며, planner가 원응답을 중복 조회하는 두 번째 복구 루프를 만들지 않는다. compact가 필요한 세션·소진된 모델 한도에서도 먼저 원 수신을 정산하고, 이후 새 답변/compact에만 남은 모델 한도를 적용하는 인수를 둔다.

**확정된 결과를 되살리는 기능은 아니다.** 원응답 영수증으로 증명할 수 있고, 아직 running이거나 단순 lease 만료만 기록된 원 시도가 후보다. 이미 receive/adopt 영수증이나 결과 artifact가 있는 시도, 사용자 취소·명시적 실패·별도 거절로 확정된 시도는 재복원하지 않는다. 상태와 기존 영수증이 서로 모순되면 과거를 고쳐 맞추지 않고 오류로 멈춘다. 일시정지·취소·종료된 업무를 복구 때문에 자동 재개하지 않는다.

또한 같은 task의 새 attempt가 진행했거나 새 plan으로 넘어갔다면 옛 raw가 현재 결과를 덮지 못하게 한다. 원 dispatch의 plan/goal revision과 task/input 지문을 현재 선택된 plan/goal/task에 대조하고, 후속 시도의 존재도 commit 직전에 다시 검사한다. 조건이 달라진 옛 결과는 현재 근거로 채택하지 않는다. 그 원응답의 비용만 별도로 정산하는 확대까지 이 첫 단위에 섞지 않는다.

목록은 상태의 기존 attempts만 순회하고 대상 시도별 영수증을 조회한다. 범용 artifact 전수 검색이나 무한 재시도를 추가하지 않는다. 동일 시도의 프로세스 내 복원은 진행 중 Promise를 공유할 수 있으나 프로세스 간 정합성은 항상 기존 CAS 영수증에 의존한다. commit 불확실 응답은 **같은 commandId·digest의 실제 영수증을 다시 확인한 경우만** 완료로 해석한다.

`absent`를 받은 뒤의 제어도 명시해야 한다. 현재 일반 recover는 읽기 `lease_expired`를 retryable로 기록하므로, 그대로 흘리면 task.maxAttempts가 남은 작업은 다음 시도를 자동 예약할 수 있다. 복원 기능이 없는 기존 도구의 만료 처리는 유지하되, 이번 대상에서 확정된 저장 응답이 없거나 proof가 깨졌다면 **복원 불가를 명시적으로 반환하고 같은 workflow 실행에서 새 조회를 자동 예약하지 않는 정지 경계**를 둔다. 기존 실패/blocked 제어와 영수증을 사용하고 새 대기 서비스는 만들지 않는다. 새 원자료 조회를 허용할지는 이후 명시적 재개·계획의 일이며, 복구 함수가 intent를 지우거나 새 attempt ID로 재전송을 숨기면 안 된다.

## 수신 시각과 lease: 구현 전에 확정할 중요한 선택

lease는 “이 실행자가 호출을 수행할 수 있는 유효 시간”이다. 복구가 늦었다는 이유만으로 **그 시간 안에 이미 저장된 응답까지 늦게 도착한 것으로 바꾸면**, 보존한 성공을 계속 채택할 수 없고 재조회 압력이 생긴다. 따라서 다음 좁은 예외를 권고하되, 이는 아직 채택·구현된 동작이 아니다. 실행기의 기존 불변조건을 바꾸는 제안이므로, **채택 직전의 현재 코드와 원 dispatch·response 영수증 필드로 조건을 실제 증명할 수 있는지 다시 검토한 뒤 결정한다.**

- 원 reserve 시각 ≤ dispatch 준비 시각 ≤ intent 준비 시각 ≤ envelope 응답 캡처 시각 ≤ response 트랜잭션 준비 시각 < 원 lease와 업무 deadline을 확인한다. 영수증 revision도 dispatch < intent < response 순서여야 한다. 원 영수증이 실제 존재하고 해당 상태의 owner·lease·goal/plan revision·입력·정책·세대가 일치해야 한다. 이 조건을 충족하는 복구에서 현재 시각이 lease 뒤라는 이유만으로 새 `lease_expired`를 붙이지 않는 안을 검증한다. 이전 recover가 먼저 남긴 **단순 lease 만료만** 바로잡을 수 있으며, 앞 절의 취소·명시실패·확정 결과·후속 시도는 이 예외에 포함하지 않는다. 당시 event는 삭제하지 않는다.
- `owner`, `startedAt`, `leaseUntil`, 업무 deadline, 예산은 그대로 둔다. 복구 commit의 event 시각·상태 `updatedAt`은 실제 복구 시각이다. 원 응답의 `recordedAt`과 관측 시각은 원문 그대로이며 과거에 result_received가 있었다고 기록하지 않는다.
- 아직 다른 실행자의 lease가 살아 있고 result_received가 없다면 첫 자동 복구는 그 만료까지 기다린다. 라이브 실행자의 자리나 네트워크 호출을 강제로 인수하지 않는다. 기다린 뒤 저장 결과부터 확인하며, 이 복구 검사에는 모델 호출이나 도구 예약이 필요 없다.
- 업무 deadline이 이미 끝났거나 목표·권한·출처가 바뀌었다면 현재 완료·채택의 기존 차단은 유지한다. “lease 안에 응답 저장”을 현재 목표에 무조건 유효한 증거로 해석하지 않는다.

이 예외를 채택하지 않는다면 첫 단위는 “원응답을 결과 영수증과 측정값으로 보존하지만 만료 결과의 자동 채택은 하지 않음”으로 인수를 명시해야 한다. 단순히 owner 검사만 우회하고 성공 복구가 된 것처럼 설명하면 안 된다. 정상 사용자 흐름까지 이어야 하므로 위의 **입증된 제시간 수신** 예외를 우선 권고한다.

**시간 필드의 실제 의미를 보존한다.** [work-transactions.ts](../../runtime/src/application/work-transactions.ts)는 `updatedAt`을 정한 뒤 `beforeCommit`과 저장소 commit을 실행한다. [commit-artifacts.ts](../../runtime/src/application/commit-artifacts.ts)와 SQLite의 실제 쓰기는 그 뒤에 있다. 따라서 위 조건은 같은 호스트 clock에서 응답을 캡처하고 트랜잭션을 준비했으며 저장 직전의 기존 authorize 검사를 통과한 기록을 뜻한다. 물리 commit 완료나 네트워크 도착 시각이 lease 전이었다는 증명은 아니다. `Attempt.startedAt`도 reserve 시각이다. 실제 프로필의 clock은 `Date.now()`이고 재시작 사이 단조 증가를 보장하지 않는다. 관측 가능한 시각 역행은 거절하고, 숨은 wall-clock 보정을 검출하거나 새로운 monotonic clock이 구현됐다고 주장하지 않는다. 기존 v1 저장 형식을 유지하는 이 단위는 동일한 신뢰 clock의 역행 없는 관측 구간을 전제로 한다.

**기존 만료 복구에는 진척 기록도 포함한다.** `recover`와 `adopt`는 모두 `attempt:<id>:settled` 키로 진척을 기록하며, [observeProgress](../../runtime/src/domain/work-progress.ts)는 이미 처리한 키를 무시한다. 따라서 만료 오류만 지우면 복구한 근거의 새 진척이 누락된다. 우선 recover 이전에 저장 결과를 복원한다. 과거 recover가 있는 경우에는 그 영수증의 원 running→failed 전이와 원 시도가 같음을 확인하고, 기존 receive/adopt·resultId·resultArtifact·확정 execution이 없는 후보만 허용한다. 이후 실제 채택에서 새 receive 영수증에 귀속된 별도 진척 키로 한 번 기록하는 안을 검증한다. 과거 실패 이력·예산을 지우거나 새 attempt를 만들지는 않는다. 재접속·재복원에서 진척과 정산이 증가하지 않는 인수를 추가한다. 현재 `currentTask()`는 현재 plan revision 자체를 비교하지 않으므로 복원에서는 원 planRevision과 후속 attempt 부재도 명시적으로 대조해야 한다.

## 정산과 권한의 경계

| 상황 | 이번 단위의 처리 |
|---|---|
| 같은 목표·정책·입력·계약이고 귀속된 원응답이 있음 | 실제 바이트와 증명을 읽어 같은 ToolResult를 복원한다. 성공·부분·오류는 원 projection대로 유지하며 오류나 부분 응답을 완료 근거로 승격하지 않는다. |
| raw artifact만 게시되고 response 영수증은 없음 | 확정 수신으로 인정하지 않는다. 본문 파일 검색·임의 인수·intent 삭제·같은 시도 재전송을 하지 않는다. “확정된 저장 응답 없음”과 유효 lease 대기/만료 실패를 구분한다. 고아 artifact 정리는 별도 보존 정책의 일이다. |
| intent만 있음 | 호출의 실제 송신·수신을 추정하지 않는다. 기존 논리 dispatch 사용량은 남고 아직 보고되지 않은 transport 측정은 unknown이다. 0이나 성공으로 정산하지 않는다. |
| 영수증 있음, 파일 소실·변조·잘못된 참조·다른 담당/업무/시도 | 원본 증명 오류로 멈춘다. 현재 근거·대화·정산을 새로 확정하지 않으며 원 영수증을 지우지 않는다. |
| 재개 중 현재 권한 축소·목표 변경·자료 삭제 세대 변경·입력 교체 | 복구 본문 사용과 채택을 차단한다. 현재 권한으로 raw를 읽을 수 없는 경우 과거 policy를 임의 사용해 우회하지 않는다. 이 상황에서 보호된 수신/known usage를 따로 보존하는 확대는 다음 필수 단위다. |
| 기존 result_received가 이미 있음 | 새 raw 정규화나 재수신을 시도하지 않고 기존 result proof/adopt 경로를 사용한다. 다른 복원 후보로 덮어쓰지 않는다. |

호출 장부의 `budget.used.toolCalls`는 dispatch에서 이미 증가했다. 복원은 reserve/dispatch를 다시 호출하지 않으므로 추가 차감·반환·한도 확대가 없다. [tool-execution-usage.ts](../../runtime/src/application/tool-execution-usage.ts)의 `toolExecution`과 `summarizeToolExecution`을 그대로 사용해 같은 attempt.execution에 입증된 `transportCalls`를 한 번 기록한다. 원 실행을 복원하는 것이므로 `reused`나 `not_invoked`로 표시하지 않는다. 없는 `internalOperations`, `imageBytes`, `waitMs`는 null을 유지한다.

수신과 채택은 같은 말이 아니다. 복구로 `received`가 생겨도 현재 `adopt`의 task/권한/출처/입력/기억 검증을 다시 통과해야 근거와 답변에 들어간다. 예산이 다 소진되었더라도 이미 받은 응답을 정산하기 위해 새 배정 승인을 요구하지 않는다. 이후 필요한 새 모델 답변에는 원래 남은 모델 예산과 deadline이 그대로 적용된다.

## 필수 검증과 실제 구현 순서

첫 코드 묶음은 포트·MCP 원문 검증 공유 → 실행기 수신 복원 → 기존 일반 프로필 사용자 흐름까지 한 번 연결한다. 각 파일별로 독립 기능을 완료했다고 표시하지 않는다.

| 시험 묶음 | 필요한 관측 |
|---|---|
| 실제 SIGKILL: 원응답 artifact 게시 뒤 / response receipt 게시 뒤 / result_received 게시 뒤 | 실제 C01 SQLite·file-journal 두 저장소와 로컬 MCP peer를 사용한다. worker의 원 저장 함수가 성공한 직후 IPC로 부모에게 알리고 기다린다. 부모는 원본·영수증·상태·호출 audit를 확인한 뒤 자기 worker만 SIGKILL한다. 첫 경계는 복구 불가, 두 번째는 증명 기반 복구, 세 번째는 기존 수신의 중복 없는 재개다. |
| 정상 raw-receipt 복구와 재복구 | 새 executor owner로 열고, lease 이후/업무 deadline 이전에 복구한다. 원 owner/lease/deadline/raw 바이트/영수증 불변, 원 시도 1개, 논리 호출 1개·측정 transport 1회, receive 1개, 근거와 사용자 응답 중복 없음. 복구 중 다시 죽거나 commit 응답을 잃어도 같은 영수증으로 수렴한다. |
| 경합과 오류 경계 | 두 복원자, 원 실행의 receive와 복원 경합, proof 읽기 뒤 raw 변경·삭제, provider 교체·projector 버전 변경, 현재 상태/정책/목표/세대 변경을 실제 저장소 또는 정확한 비동기 경계 주입으로 확인한다. 이미 정산된 결과·사용자 취소·명시실패와 후속 attempt/plan은 되살리지 않는다. 안정된 잘못된 proof를 retry로 삼키지 않는다. |
| 원래 결과의 구분 | complete/partial/MCP tool error/유효 실패 envelope는 원 status·coverage·usage를 유지한다. 실제 송신 여부가 입증되지 않은 intent-only는 unknown을 유지한다. 위조된 수신 시각, lease 밖 영수증, 다른 work/tenant/agent/attempt의 ref를 거절한다. |
| 한도와 권한 | 논리 도구 예산이 소진돼도 저장 결과 복원 자체는 가능하고 카운터가 늘지 않는다. 새 호출·모델 실행은 잔여 한도 적용. 권한 축소 중 body 노출·근거 채택·옛 목표 완료가 없어야 한다. 일반 receive의 foreign-owner 거절 회귀도 유지한다. |
| 실제 일반 입구 | `createMcpHostTools` → `openAgentTurnProfile` → 기존 workflow/CLI 또는 Web 재개가 raw receipt를 인식한다. 로컬 합성 모델로 최종 근거 답변까지 확인한다. 새로운 프로필의 initialize/tools-list 횟수와 tools-call 횟수를 분리하며, 저장 결과 때문에 tools-call이 증가하면 실패다. |

[기존 SIGKILL 시험](../../runtime/src/tests/mcp-read-settlement-recovery.test.ts)과 [worker](../../runtime/src/tests/helpers/mcp-settlement-worker.ts)의 원 commit 이후 marker·부모 중단·peer 종료 확인 방식을 재사용한다. FakeClock은 lease/deadline 시간만 결정적으로 움직인다. 실제 프로세스 중단을 단순 예외나 mock 성공으로 대신하지 않는다. worker/peer의 PID 종료와 임시 폴더 정리를 별도로 확인하며 새 빌드와 원 로그·실제 종료코드·소스 지문을 보존한다.

예상 변경 범위는 `application/ports.ts`, `tool-contracts.ts`, `execution-runtime.ts`, `infrastructure/mcp-read-tools.ts`와 새 집중 시험/worker다. 실행기 내부가 커지면 신규 `application/stored-tool-results.ts` 한 파일로 proof 호출·형식 검사만 분리할 수 있다. definition/WorkState 저장 schema, SQLite 테이블, source 목록·정산·모델 루프를 통째로 바꾸지 않는다. profile/CLI/Web은 기존 workflow가 복원을 통과하는지 먼저 확인하고 실제 빈 연결이 있을 때만 최소 변경한다.

위 착수 계획에 이어 구현·통합 검증을 수행한 최종 결과는 [복구 확정 증거](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json)와 [결과 문서](C05-mcp-response-recovery-result.md)에 확정했다. 이 문서 갱신 자체는 시험 재실행이 아니다. 다음 [전송 후 권한 변경 수신 보존](C05-mcp-sent-authority-plan.md)은 제품 미착수이며, 서버 없는 일반 프로필 열기·페이지와 대기 입구·실제 사내 MCP·모델 API·Knox·native Windows를 이번 복구 완료로 함께 닫지 않는다.