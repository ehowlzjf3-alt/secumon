# Collection 응답 보관과 자기 호출 사용량 — 구현 후보

이 문서는 다음 custody 단위의 **검토용 후보**다. 제품·시험·NAS helper를 변경하거나 실행하지 않았다. 현재 collection 일반 입구 검증과 별도이며 C05 전체 완료를 뜻하지 않는다. [앞선 누락 검토](C05-mcp-collections-post-send-custody-review.md)를 바탕으로, 아직 없던 포트·영수증 형식·합산 조건을 아래처럼 제안한다.

## 선택하는 작은 구조

원 `mcp-page:<attemptId>:<requestId>` 영수증을 페이지 관측의 정본으로 사용한다. 기존 checkpoint의 호출 목록을 새 장부로 복사하지 않는다. 원문 보관, 현재 page/deferral 사용, attempt 사용량 합산은 서로 다른 판단이다.

- **보관:** 이미 보낸 자기 요청의 유효 응답을 원 라벨로 저장한다. 현재 정책·목표·실행 취소와 분리하지만 소유자, 자료 세대, 원 dispatch/page intent, 유한 프로필 종료 수명은 검사한다.
- **본문:** 기존 `restoreResponse`/page·deferral proof/`ReadReconciliation`/receive·adopt가 현재 권한과 원본을 계속 검사한다. captured 뒤 실패한 응답을 page로 승격하지 않는다.
- **회계:** 자기 attempt의 새 요청 추가가 끝난 뒤, 전체 자기 호출을 한 번씩 읽어 총계를 만든다. 한 페이지라도 관측이 불명이면 해당 측정값은 null이다. 실행 중 부분 합계로 이미 알려진 총계를 변경하지 않는다.
- **문맥:** 비필수 보관 참조만 정확한 귀속 증명으로 제외한다. 회계 후보가 아니어도 보관 참조는 검증할 수 있어야 한다.

## A. 페이지 보관 포트와 증명 형식

### 공개 포트 후보

기존 plain `Tool.execute`의 `authorizeResponseCustody`를 실제 collection 실행에도 발급하되, Broker가 공유하는 검사는 고정된 dispatch 소유 부분으로 한정한다. 현재 `custodyAttempt()`에 들어 있는 `readProgress` 전체를 collection의 불변 식별자로 쓰면 첫 head 게시부터 달라지므로 안 된다. plain의 기존 비교는 유지하고 collection은 고정 attempt 식별자와 페이지별 head 증명을 나누어 검사한다.

```ts
// ports.ts: 기존 fetch context에만 추가. 실행 authorize는 그대로 유지한다.
ReadCollectionSource.fetch(task, request, {
  workId, attemptId, policy, signal, authorize,
  authorizeResponseCustody?: () => Promise<void>,
});

// 새 페이지 측정 조회. 원 head는 response envelope와 그 게시 영수증에서 찾는다.
interface ReadUsageRestoreInput {
  attemptId: string;
  task: TaskSpec;
  request: ReadRequest;
  dispatchedAt: number; // 현재 검증한 자기 ReadCall의 값
}
type ReadUsageRestoreResult =
  | { kind: 'absent' }
  | (Extract<StoredToolUsage, { kind: 'available' }> & {
      intent: { commandId: string; digest: string; artifact: ArtifactRef };
    });

ReadCollectionSource.restoreUsage?(state, input: ReadUsageRestoreInput)
  : Promise<ReadUsageRestoreResult>;
Tool.restoreReadUsage?(state, input: ReadUsageRestoreInput)
  : Promise<ReadUsageRestoreResult>;
```

`StoredToolUsage`의 `usage`, `receivedAt`, `receipt`, `custodyOnly`, `responseObserved`를 재사용한다. `receivedAt`은 envelope.recordedAt이며 아래 시각 종류와 함께 해석한다. `intent.artifact`는 정확한 원 intent head다. 이 포트는 본문이나 가공 page를 반환하지 않고 projector, manifest 함수, discover, fetch를 호출하지 않는다. `ToolContracts`는 입력/반환 shape와 원 task/등록 객체를 고정하고 await 뒤 등록 동일성을 검사한다. 기존 plain `restoreUsage`의 collection 제외 조건은 유지한다.

기존 `ReadResponseRestoreInput`에 억지로 맞추어 과거 head를 전체 artifacts에서 탐색하지 않는다. 사용량 입력은 이미 검증한 호출의 request·dispatchedAt만 주고, source가 정확한 response command → envelope.intentHead → `read:<attemptId>:<head.id>` 영수증을 검증한다. 반환 intent의 마지막 호출이 입력과 완전히 같아야 한다.

### 새 responseData만 확장

기존 definition/version/bindingDigest, `responseRecovery:'stored-response-v1'`, envelope v1, checkpoint logical v1/record v2는 유지한다. 새 journal payload에만 선택 witness를 붙인다.

```ts
{ attemptId, requestId, artifact,
  custody?: {
    schemaVersion: 1;
    outcome: 'returned' | 'captured' | 'failure';
    transportCalls: 0 | 1;
    recordedAtKind: 'decoded_response' | 'response_prepared';
  }
}
```

허용 조합을 strict union으로 고정한다. `captured`는 decoded_response/1, 유효 decoded 반환도 decoded_response/1이다. 실제 `McpCallError`만 있는 failure는 response_prepared/0 또는 1이다. 기존 주입 client처럼 capture 없이 정상 반환하는 호환 경로는 returned/response_prepared/1이며 SDK decode 시각을 주장하지 않는다. 나머지 조합은 거절한다.

별도 `decodedAt` 숫자를 journal에만 넣는 대안은 채택하지 않는다. 현재 repository.receipt는 digest와 state만 반환하므로 그 숫자를 복원하려면 추가 event 조회가 필요하다. 고정 marker 조합과 기존 raw의 recordedAt을 사용하면 plain처럼 제한된 조합의 responseData digest 대조로 원 ref를 유일하게 찾을 수 있다. raw 파일을 훑거나 시간값을 추측하지 않는다.

| 자료 | recordedAt의 의미 | 새 usage-only 판정 |
|---|---|---|
| witness 없는 기존 정상 응답 | 기존 envelope 준비 시각 | 원 proof가 유효하면 transport 1 |
| 기존 failure.sent=false | 기존 실패 envelope 준비 시각 | 정확한 기존 영수증이면 transport 0 |
| 기존 failure.sent=true | 기존 코드의 추론도 포함 | transport null; known 1로 소급 확정하지 않음 |
| 새 decoded marker | 해당 요청의 SDK promise resolve 직후 호스트 관측 시각 | 유효 capture의 transport 1 |
| 새 typed failure marker | 응답값 없는 실패 envelope 준비 시각 | 실제 McpCallError.sent에 따른 0/1 |
| 임의 예외, 영수증 없음, raw-only | 수신·전송 관측 증명 없음 | absent/불명; 0이나 1을 만들지 않음 |

기존 page/deferral의 원 bytes와 dueAt 계산을 재작성하지 않는다. 새 decoded 응답의 deferral은 그 새 recordedAt을 기준으로 계산한다. 이는 과거 준비 시각을 decode 시각으로 소급 해석한 것이 아니다. `updatedAt`은 트랜잭션 준비 시각이고 receipt 존재는 commit 증거다. 어느 값도 물리 commit 종료 시각, 네트워크 도착 시각, 원격 실행·과금 완료를 증명하지 않는다.

### 저장 순서와 수명

1. 기존 실행 authorize로 원 dispatch/현재 task/계약/정책/lease와 실제 page intent를 검증한다. 같은 intent head를 게시한 영수증과 세션·requestDigest를 고정한다.
2. `McpStdioClient.call`에 기존 `{capture:{now,decoded}}`를 전달한다. 요청별 immutable capture를 검증한다. strict JSON, 실제 UTF-8 byteLength, session/endpoint/protocol, 정확한 query/read 인자 지문과 응답 한도를 확인한다. client의 실제 관측값만 사용한다.
3. capture 뒤 client가 실패하면 captured witness로 원문을 보관한 뒤 원 오류를 다시 던진다. SDK reject 등 decoded 값이 없는 경우는 typed McpCallError만 failure witness를 만들며 임의 예외는 원 오류를 보존한다. malformed/초과 bytes를 유효 raw로 저장하는 예외는 만들지 않는다.
4. raw put 전후와 response transaction beforeCommit에 보관 authorize를 검사한다. 원 tenant/principal/work.createdAt/dataGeneration, attempt 고정 식별자, 원 dispatch/intent receipt digest, 원 head/request/등록 수명이 같아야 한다. response command가 이미 있으면 정확히 같은 귀속의 영수증으로만 재전송을 해소한다.
5. raw는 기존 `disclosureLabels(dispatch.state) ∪ definition.labels`로 저장한다. 현재 정책으로 재라벨링하지 않는다. 새 응답 영수증은 raw를 원 attempt에만 연결하고 checkpoint/call 상태·현재 goal/plan·budget·result를 고치지 않는다.
6. 정상 반환이면 저장 뒤에도 기존 현재 실행 authorize를 거쳐야 projectResponse로 진행한다. 새 raw 보관이 새 page·deferral·successor 실행 허가가 되지 않는다. authority 실패 시 다음 요청 0이다.

Broker의 보관 허가는 원 invocation/프로필 drain 수명 안에서만 살아 있다. 각 페이지의 source closure가 원 intent를 추가로 묶는다. lifecycle 변경·원 owner 변경·원본 손상은 보관도 거절한다. lease가 끝나거나 successor가 생겨도 이미 보낸 부모 응답을 자식 응답으로 바꾸지 않는다. 늦은 부모 보관은 원 intent가 그대로 귀속됨을 입증할 때만 가능하다.

시각은 `reserve/start ≤ dispatch 준비 ≤ intent 게시 준비 ≤ recordedAt ≤ response 준비 ≤ 검사 clock`을 확인하고 원 intent 호출 시각도 비교한다. 새 decoded marker의 recordedAt만 실제 capture 관측값으로 취급한다. 보관 자체에 `response 준비 < lease`를 요구하지 않는다. 이미 받은 값의 늦은 보관이 목적이기 때문이다. 현재 body 사용은 별도 판단이다.

새 marker를 읽는 body 경로는 captured/failure를 거절한다. returned 복원은 기존 현재 goal/policy/lifecycle·request/head·원문 proof에 더해 새 관측 시각의 원 lease/deadline 내 수신을 검사한다. **새로운 시각 검사는 새 marker 자료에만 적용**한다. 기존 정상 page/deferral에 강화된 복원 조건을 일괄 적용하지 않는다. 늦은 보관 준비 시각과 늦은 수신을 혼동하지 않고, 이 조건은 기존 failed 부모의 상태를 성공으로 바꾸는 허가도 아니다.

## B. 전체 자기 호출 집합과 보호 참조 증명

### 한 번의 내부 검사, 서로 다른 두 결과

새 작은 application helper `StoredReadUsages`를 제안한다. 새 repository나 영속 플래그 없이 기존 state/receipt/artifacts/clock/digester/ToolContracts를 받는다.

```ts
inspectCustody(state, attemptId): Promise<ReadCustodyInspection | null>;
prepareUsage(state, inspection): Promise<ReadUsageTicket | null>;
assertCurrent(state, inspectionOrTicket): Promise<void>;
```

검사 결과는 내부에서만 사용하며 외부 입력을 그대로 ticket으로 인정하지 않는다. `inspection`은 원 dispatch/head, 자기 호출 집합, 페이지별 receipt 또는 부재, 정확한 보관 참조를 갖는다. `prepareUsage`만 아래 종료 조건을 요구한다. **실행 중 보호 raw를 문맥에서 제외하려고 usage의 종료 조건을 약화하지 않는다.** 현재 source/등록/state pin과 원본을 beforeCommit 또는 최종 반환 전에 다시 검사한다. 영수증 부재도 pin에 포함하므로 검사 중 늦은 영수증이 생기면 다시 준비한다.

### 현재 body 권한 없이 역사적 head를 읽는 범위

현재 `ReadCheckpoints.read`는 현재 goal/policy와 모든 page proof를 요구한다. 이 API에 `ignorePolicy`를 넣지 않는다. 실제 과거 게시 영수증을 읽기 권한의 근거로 삼는 작은 내부 검사에서 기존 `ReadCheckpointReader`, strict checkpoint/record schema, 원 dispatch·progress 비교를 재사용한다.

- 현재 indexed head의 `read:<attemptId>:<head.id>` 영수증을 우선 확인한다. `read_response_reconciled`로 게시된 head는 기존 record v2의 정확한 settle base를 읽고 `read-reconcile:<attemptId>:<base.id>` 영수증과 그 payload 지문을 대조한다. 임의 event 검색이나 두 번째 head 게시 이력을 만들지 않는다.
- reconcile base를 알아내기 위한 최초 읽기도 현재 exact indexed ref/tenant/blocked/dataGeneration와 원 dispatch policy의 라벨 검사를 통과한 해당 head 하나로 제한한다. 게시 영수증을 찾기 전의 bytes는 후보일 뿐이다.
- 영수증의 실제 state snapshot으로 Reader를 구성하고 bounded chain을 읽는다. 현재 policy를 원 policy로 덮어쓴 가짜 WorkState를 정상 현재성 검사에 넘기지 않는다. 현재 head/attempt와 과거 게시 state의 연결, 원 goal/scope/task/query/contract, 부모·자식 관계를 별도로 비교한다.
- 자기 call마다 정확한 request/dispatchedAt으로 source.restoreUsage를 부른다. source는 원 intent 영수증의 실제 snapshot에서 마지막 intent와 envelope.intentHead를 검증한다. 현재 head 목록에 없던 임의 요청의 receipt를 끼워 넣지 못한다.
- 현재 소유자·자료 세대·blocked/indexed ref·등록 definition/binding의 동일성은 과거 자료를 읽기 전후 모두 검사한다. 새 권한에서 body를 사용할 수 있다는 뜻은 아니다.

기존 Reader의 record 10,000개/chain 64 MiB/단일 record 16 MiB 및 collection별 상한을 그대로 사용한다. 한 검사 안에서 정본 해독과 영수증 조회를 공유한다. 사라진 head/receipt, 중복 request, 엇갈린 지문은 오류이며 missing 값을 0으로 처리하거나 임의 artifacts를 제외하는 fallback은 없다. 현재 등록에 해당 source 복원 callback이 없으면 복원을 지원하지 않는 상태다.

### 합산 자격과 unknown 정련

호출 집합은 검증된 자기 checkpoint에서 `call.attemptId === attempt.id`인 항목만으로 만든다. 각 원 intent가 정확한 dispatch에 속하며 requestId 중복이 없어야 한다. 요청 집합 지문에는 request 전체·dispatchedAt·원 intent proof를 넣고, 나중에 바뀔 수 있는 accepted/unknown 상태와 raw receipt 도착 여부는 별도 관측 지문으로 둔다.

`prepareUsage`는 다음 중 하나로 **새 자기 요청을 추가할 수 없을 때만** 총계를 반환한다.

- attempt가 received 또는 기존 terminal 상태이고, 원 dispatch/현재 고정 attempt와 마지막 게시 head가 유효하다.
- 원 attempt의 고정 leaseUntil이 만료되어 기존 ReadCollections의 current/publish guard가 새 intent를 게시할 수 없다. deadline만 지난 경우는 연장 가능성을 추측하지 않고 별도 종료 상태를 기다린다. 동일 호스트 clock의 비역행 전제를 확인하고 상태/clock을 commit 직전에 재검사한다.

work의 paused/cancelled/blocked 표시만으로 호출 집합이 닫혔다고 판단하지 않는다. 실행 중일 때는 영수증을 보관하고 합산을 보류한다. failure receive 뒤 또는 만료 후의 기존 회복 pass에서 합산한다. **lease 만료는 마지막 raw receipt의 추가까지 막는 조건이 아니다.** 늦은 receipt는 같은 고정 호출 집합의 관측을 정련할 수 있다.

합산은 `ReadCheckpoints.projection`의 자기 호출 필터·측정별 null 전파·safe integer 규칙을 작은 순수 함수로 추출하여 공유하는 방향이다. 새 helper는 정상화 page를 projector로 다시 만들지 않고 원 응답 영수증의 측정 증명을 제공한다.

- 새 확정 page receipt가 1, typed pre-send 실패가 0이면 그 실제 값만 더한다. 어느 자기 호출이든 receipt 부재/구형 모호한 sent=true이면 transportCalls 총계는 null이다. internalOperations/imageBytes/waitMs도 각각 동일 규칙이다.
- `accepted/deferred/rejected/unknown/intent`는 page 처리 상태다. 원 receipt가 증명한 전송 여부와 같지 않다. captured 응답은 page가 미채택이어도 transport 1이며, intent-only는 0이 아니다.
- 부모 calls는 자식 합계에서 제외한다. 완전 checkpoint를 로컬 소비한 자식은 자기 wire 호출 0이고 기존 논리 toolCalls +1/implementationCalls 1은 유지한다. 부모는 자기 응답 측정을 원 attempt에 보존한다.
- 예: 자기 호출 A=1, B=미관측이면 총계 null이다. B의 원 receipt=1이 뒤늦게 오면 null→2가 가능하다. A=1을 먼저 총계 1로 쓰고 나중에 2로 바꾸는 경로는 금지한다. 같은 receipt 재조회는 합계를 더하지 않는다.
- 이미 known인 측정값과 새 확정 총계가 다르면 기존 `tool_execution_usage_conflict`다. unknown으로 강등하거나 기존 mergeToolExecution을 누적 덧셈으로 변경하지 않는다.

기존 `tool-usage:<attemptId>:<sourceDigest>` / `tool_execution_usage_recorded` 명령을 재사용한다. sourceDigest는 고정 호출 집합·그 종료 증명·페이지별 receipt digest 또는 absent·계산 총계를 포함한다. 원문을 이벤트에 복제하지 않는다. state CAS와 beforeCommit의 전체 proof 재검사 뒤 **attempt.execution만** 기존 merge로 정련한다. status/error/result/adopted/readProgress/goal/plan/budget는 그대로다.

현재 `recordedStoredUsageAttempts`는 unchanged attempt와 과거 usage event만으로 skip할 수 있다. collection에 그대로 적용하면 늦게 raw receipt만 추가되고 attempt가 불변인 경우를 놓친다. 첫 구현에서는 collection을 이 skip에서 제외하고 bounded 자기 request receipt 목록을 재확인한다. 부분 관측 sourceDigest를 영구 완료 표시로 쓰지 않는다.

### ContextRecovery의 exact custodyRefs

현재 raw뿐 아니라 `storeReadCheckpoint`가 원 policy.allowedLabels로 저장한 checkpoint도 보호될 수 있다. raw 한 ref만 제외하는 plain 경로를 그대로 복제하면 정책 축소 뒤 과거 head 때문에 여전히 재개가 막힌다.

`inspectCustody`에서 실제 검증한 보관 raw와 그 귀속을 증명하는 역사적 checkpoint record 참조를 모으되, **checkpoint.artifacts 전체를 제외 목록으로 복사하지 않는다.** 실제 방문한 record/head, 필요하면 그 해독에 사용한 정확한 normalized page/deferral 참조를 구분한다. normalized response까지 제외하려면 원 request·response receipt와 구조/지문 연결이 검증된 것이어야 한다. 임의 projector 부가 artifact는 자동 포함하지 않는다.

ContextRecovery는 기존 required 계산을 먼저 수행한다. 현재 필요한 head/result/evidence/model/input 참조, 다른 현재 자료의 정본으로 쓰인 ref는 제외 불가다. 그 후 현재 indexed·동일 tenant·nonblocked이지만 현재 labels로 읽을 수 없는 비필수 ref 중 **새 witness에 연결된 증명 목록과 교집합**만 derived packet에서 제외한다. 원 state/artifact/receipt는 삭제·재라벨링하지 않는다. legacy raw는 새 custodyOnly 권한으로 소급 제외하지 않는다.

history chain이 필요한 정본 자료인데 검증할 수 없거나 보호 제외로 연결할 수 없으면 `resume_custody_unavailable` 등 기존 실패 경계를 유지한다. 실행 가능한 collection view·cursor·본문을 새로 공개하지 않으며, 원 사용자 입력 자체의 읽기 권한이 없으면 기존 session/input 거절은 남는다. 최종 packet 게시 전에 state/등록/원본/자료 세대 및 host execution authority를 다시 검사한다.

## 연결 순서와 구현 단위

**A — capture와 보관:** ports/ToolContracts의 좁은 source callback, Broker의 고정 dispatch custody guard, 같은 ReadCollections 인스턴스의 페이지별 closure 전달, MCP adapter의 marker/원 ref 판별을 구현한다. 현재 실행 authorize와 기존 page/deferral validation은 분리 유지한다. actual client capture/close 코드는 재사용하며 새 peer나 transport 구현은 없다.

**B — 정산과 보호 투영:** StoredReadUsages의 역사적 head/페이지 proof, 종료된 자기 호출 집합 총계, 기존 ExecutionRuntime 회계 pass 및 ContextRecovery를 연결한다. plain은 기존 동작을 유지한다. collection invoke 실패 때는 먼저 기존 failure receive로 종료 상태를 남긴 뒤 회계 기회를 주거나, 실제 lease 만료 뒤 기존 pass에서 정련한다. 종료되지 않은 시점의 알려진 페이지를 부분 합계로 기록하는 우회는 없다. profile drain 안에서 이 순서를 완료하고 저장소 close 이후 추가 raw/receive/usage 게시를 차단한다.

Workflow의 현재 정상 stored result/collection settlement → usage → compact/context 순서를 재사용한다. 현재 정책으로 page를 읽을 수 없어 body settlement가 불가능한 경우에는 원문에 접근하지 않는 metadata 수준 사전 분기로 usage-only 기회를 먼저 확보한다. source 손상 등 임의 예외를 catch해 성공으로 바꾸지 않는다. required 원문/현재 실행 권한 부족은 이후 기존 오류나 wait로 유지한다. GET/status에는 회계 쓰기를 추가하지 않으며 actor·세션 검사 후 명시 제어/재개 경로만 기존 pass를 사용한다.

**C — 실제 중단과 일반 입구:** [별도 인수 후보 지도](C05-mcp-collections-custody-acceptance-candidate.md)의 기존 fixture를 사용한다. 원 page intent → raw-only → response receipt → aggregate usage 각 cut을 구분하고 SQLite/file-journal, final/nonfinal/deferral, 늦은 receipt, 부모/자식, 두 복구자 경합, 실제 프로필 종료를 검증한다. 일반 CLI/HTTP stored_only 재개는 새 client/discovery/call 없이 원 usage와 보호 packet을 확인하고, 필요한 현재 입력 권한을 유지한 fixture와 입력권한 거절 fixture를 나눈다. 실제 모델/API 품질 검증이 아니다.

중간 A/B 완료를 전체 custody 완료로 발표하지 않는다. source는 부모가 정한 동결을 유지하며, 후보 검토 후 staging에서 나누어 구현하고 마지막 통합 source로 필요한 local/NAS 검증을 한 단위로 수행한다.

## 검토가 필요한 좁은 결정

1. 새 marker의 `recordedAtKind`와 위 strict 조합, 그리고 새 returned의 원 lease 내 수신 검사 범위를 승인해야 한다. 기존 원자료 형식·legacy proof는 불변이다.
2. 보호 제외 증명에 실제 방문한 normalized page/deferral까지 포함하는 범위는 인수로 확인해야 한다. 원 raw와 record만으로 충분하다고 가정하지 않는다. unrelated artifact와 현재 required는 항상 제외 불가다.
3. historical head 게시 조회/호출 구조 비교는 기존 Reader·checkpoint helper에서 최소 추출할 위치를 구현 때 정한다. 새 상태기계나 별도 ledger가 필요한 것으로 해석하지 않는다.

## 현재 소스 근거

- [MCP collection](../src/infrastructure/mcp-read-collections.ts): `original`/`restoreResponse`/`fetch`. capture 미전달과 post-call/current authorize, 기존 mcp-page payload, envelope v1/deferral recordedAt 계산을 확인했다.
- [Plain MCP custody](../src/infrastructure/mcp-read-tools.ts), [요청별 capture](../src/infrastructure/mcp-stdio-client.ts): 고정 witness 대조, 원문/측정 검증, captured와 typed failure 구분, 보관 수명 재사용 근거다.
- [Broker](../src/application/tool-broker.ts), [ReadCollections](../src/application/read-collections.ts): 현재 plain-only custody와 mutable readProgress 문제, `read:<attempt>:<head>` 게시, source 호출 앞뒤 실행 guard를 확인했다.
- [Checkpoint Reader](../src/application/read-checkpoint-store.ts), [ReadCheckpoints](../src/application/read-checkpoints.ts), [Reconciliation](../src/application/read-reconciliation.ts): 실제 record/페이지 한도, 현재 body proof, 자기 호출별 합산, 별도 reconcile head 게시를 확인했다.
- [ExecutionRuntime](../src/application/execution-runtime.ts), [기존 merge](../src/application/tool-execution-usage.ts), [skip 판정](../src/application/stored-usage-records.ts): 부분 합계 충돌, invocation failure 순서, late receipt를 놓칠 skip 경계를 확인했다.
- [ContextRecovery](../src/application/context-recovery.ts), [현재 collection visibility](../src/domain/context.ts): required 우선과 plain raw만 제외하는 현재 동작, head 라벨에 따른 view 비공개를 확인했다.
- [트랜잭션 시각](../src/application/work-transactions.ts), [포트](../src/application/ports.ts): receipt는 digest/state만 반환하며 updatedAt은 beforeCommit 이전 준비 시각임을 확인했다.

이 문서의 판정은 읽기 검토다. 새 회귀를 실행하거나 현 NAS 결과를 다시 관측하지 않았다.
