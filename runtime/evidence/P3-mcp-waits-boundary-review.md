# P3 MCP Retry-After 대기와 명시 재개: 공통 경계 검토

2026-09-06 · 읽기 설계안. 제품 코드 변경, 설치, 빌드, 시험 및 외부 서비스 실행 0회. 기존 수집/원본 proof/record delta 경로를 바탕으로 작성했다.

## 권고와 범위

호출 전체가 rate limit으로 연기된 경우에는 `ReadDeferral` 응답과 `ReadCall.status='deferred'`를 사용한다. 실제 데이터가 들어온 응답은 기존 ReadPage로 처리하고, 그 안의 미완료 항목에만 절대 재시도 시각을 붙인다. 대기 중에는 현재 수집 attempt를 끝내고 checkpoint를 남긴다. 내부 sleep loop, 자동 MCP retry, 새 수집 장부는 만들지 않는다.

여기서 호출 전체 대기는 한 tools/call의 데이터 응답 전체가 보류되었다는 뜻이다. 현재 WorkState 수집 lineage의 다음 요청을 제한한다. 모든 work/사용자/연결에 걸친 provider 전역 rate limiter를 구현한 것으로 설명해서는 안 된다. 그런 공유 제한은 별도 정책·포트가 필요하다.

## 정확한 최소 타입 제안

```ts
// domain/read-collection.ts
export interface ReadDeferral {
  kind: 'read_deferral';
  requestId: string;
  dueAt: number;
  reason: 'rate_limited';
  rawArtifact?: ArtifactRef | undefined;
  usage?: ToolUsage | undefined;
  knowledgeDependencies?: KnowledgeDependency[] | undefined;
}
export type ReadResponse = ReadPage | ReadDeferral;

export interface ReadItem extends ReadKey {
  // 기존 필드는 유지한다.
  retryAt?: number | undefined;
}

// domain/read-checkpoint.ts
export interface ReadCall {
  // 기존 request/attemptId/response/times/errorCode는 유지한다.
  status: 'intent' | 'accepted' | 'deferred' | 'rejected' | 'unknown';
}
export interface ReadProgress {
  // 기존 필드는 유지한다. 검증된 다음 요청의 정적 절대시각이다.
  retryAt?: number | null | undefined;
}

// application/ports.ts
export interface ReadDeferralProofInput {
  attemptId: string;
  task: TaskSpec;
  request: ReadRequest;
  deferral: ReadDeferral;
}
export interface Tool {
  // 기존 validateReadPage는 ReadPage 전용 그대로 둔다.
  validateReadDeferral?(state: WorkState, input: ReadDeferralProofInput): Promise<boolean>;
}
export interface ReadCollectionSource {
  // context는 기존 authorize 포함형을 유지한다.
  fetch(task: TaskSpec, request: ReadRequest, context: ReadFetchContext): Promise<ReadResponse>;
  validateDeferral?(state: WorkState, input: ReadDeferralProofInput): Promise<boolean>;
}
// ToolDefinition.collection에 추가한다.
// deferralValidation?: 'artifact-proof-v1' | undefined
```

`ReadFetchContext`는 설명을 위한 기존 fetch context의 별칭이다. 새 필수 실행 포트를 만들 필요는 없다. 기존 `Promise<ReadPage>` 구현은 union 반환 포트에 그대로 대입할 수 있다. 기존 page callback 입력을 union으로 넓히면 모든 adapter가 불필요하게 분기해야 하므로 sibling deferral callback이 더 작다.

`collection.deferralValidation`은 opt-in 계약 marker로 사용한다. marker가 있는 도구에는 deferral callback이 필수이고 rawArtifact 없는 deferral은 거절한다. 지원하지 않는 기존 도구가 deferral을 반환하면 일반 source 오류로 처리하며 증명된 대기로 승격하지 않는다. MCP 어댑터는 기존 pageValidation과 새 marker를 모두 선언한다. 항목 retryAt은 개별 ReadPage proof의 재계산 대상이다.

## 왜 ReadPage에 가짜 빈 데이터를 넣지 않는가

| 표현 | 문제 또는 선택 |
|---|---|
| empty ReadPage, exhausted=true | 첫 요청에서 빈 수집을 완료했다고 주장할 수 있다. |
| empty ReadPage, exhausted=false | snapshot/cursor/total을 원격이 제공하지 않았는데 만들어야 하고, 빈 데이터 페이지처럼 acceptedRequestIds/collection.calls를 올린다. |
| 모든 항목을 error로 만들어 ReadPage 반환 | 원격이 항목 identity/manifest를 확인한 응답이라는 허위 주장을 만들 수 있다. 기존 pending 성공 항목까지 잘못 덮기 쉽다. |
| source 예외에 retry 시각만 붙임 | 재시작·proof 검증·사용량·dueAt 재생이 사라진다. |
| typed ReadDeferral + deferred ReadCall | 기존 호출 intent와 response artifact를 재사용하며 데이터 projection은 그대로 둔다. 권고. |

ReadDeferral에는 items, expected, totalItems, nextCursor, exhausted, 새로운 sourceSnapshot을 넣지 않는다. 어떤 요청을 연기했는지는 기존 ReadCall.request와 requestId가 증명한다. 아직 snapshot을 받지 못한 첫 호출은 기존 null을 유지한다.

## 영속화와 상태 전이

기존 ReadCollections는 intent checkpoint를 먼저 저장한다 (`read-collections.ts:207–210`). 응답을 받은 뒤 분기한다.

- ReadPage: 기존 page proof → mapped page artifact → acceptPage → accepted call.
- ReadDeferral: strict schema와 raw proof → mapped deferral artifact → deferred call. collection 상태는 바꾸지 않는다.
- 응답 유실/취소/파싱 불가: 기존 unknown/rejected 의미를 유지한다. rate limit을 관측한 것으로 추정하지 않는다.

deferred call의 response는 typed deferral JSON artifact다. receivedAt은 응답 수신/처리 시각, errorCode는 고정 `read_rate_limited`로 둘 수 있다. deferred이면 response/receivedAt/errorCode가 모두 있어야 한다. intent에는 기존대로 응답 필드가 없어야 한다.

deferred는 호출을 실제 시도했다. checkpoint.calls.length 및 maxCalls는 소비한다. 기존 collection.calls/acceptedRequestIds는 **수락된 데이터 페이지 응답** 수이므로 증가시키지 않는다. completedPages/items, pending 성공 항목, cursor, snapshot, total, unknown 호출은 전부 보존한다. phase는 partial, stopReason은 `read_rate_limited`로 끝내고 부모의 임의 자동 retry를 만들지 않는다.

item.retryAt은 안전한 정수 절대시각이며 non-success이고 error.retryable=true인 항목에만 허용한다. success에는 금지한다. 재시도 불가 항목에 future retryAt을 넣어 재시도 가능으로 바꾸지 않는다. 정상 partial 데이터는 기존 규칙대로 채택할 수 있지만, 대기 metadata 자체를 Evidence나 추가 coverage로 취급하지 않는다.

## 기존 record delta를 재사용하는 방법

새 delta 종류나 별도 배열 없이 기존 `change.type='settle'`을 확장한다.

1. `read-checkpoint-record.ts:35`의 settle 허용 상태에 deferred를 추가한다.
2. deferred response artifact를 읽고 ReadDeferralSchema로 파싱하는 분기를 둔다. 기존 readPage loader는 유지하고 별도 readDeferral loader를 선택적으로 추가하거나 내부 response loader를 제공한다. page 전용 공개 helper를 무조건 union으로 바꾸지 않는다.
3. deferred replay는 `settleCall`로 원 intent의 identity/times를 검증한다. collection 전체를 base와 같게 유지하고 response/raw refs 및 knowledge만 closure에 추가한다.
4. source deferral 원본과 mapped deferral artifact는 기존 checkpoint.artifacts 및 부모 상속에 포함한다.
5. logicalDigest는 deferred status/response ref/phase/stopReason을 포함한 logical checkpoint를 계산한다. fake page를 거쳐 digest를 맞추지 않는다.

현재 decoder는 accepted 응답만 page로 읽는다 (`read-checkpoint-record.ts:148` 이하). `ReadCheckpoints.verify`도 accepted 이외 상태를 skip한다 (`read-checkpoints.ts:144`). 두 경로 모두 deferred를 명시적으로 읽어야 한다. enum만 늘리면 dueAt 증명을 읽지 않고 건너뛰게 된다.

## Replay와 proof 계약

현재 원 task/request별 page proof 구조를 deferral에도 적용한다.

- 해당 call.attemptId의 dispatch task를 사용한다. child의 resume task로 부모 deferral을 재계산하지 않는다.
- raw ref의 현재 tenant/labels/lifecycle/등록 참조/byte bound를 확인한다.
- raw envelope에서 Retry-After를 host 규칙으로 재계산해 requestId, dueAt, reason, usage를 mapped deferral 전체와 비교한다.
- `ToolContracts.validateReadDeferral`은 callback과 metadata를 등록 시 캡처하고 detached 입력과 await 뒤 동일 entry를 확인한다.
- reader.proofOriginal을 사용하여 최초 읽기 및 cache eviction 뒤에도 마지막 raw integrity fence에 남긴다. 현재 raw page에 적용한 동일 보장이다.
- receive/adopt/compact/reopen/부모 resume는 ReadCheckpoints 검증을 재사용한다. 시간이 지났다는 이유로 deferral 원본 검증을 생략하지 않는다.

accepted/deferred 응답 모두 현재 attempt의 실제 usage 합계에 포함한다 (`read-checkpoints.ts:191–200`). inherited 응답은 child 사용량에 더하지 않는다. unknown/rejected 호출의 미확인 사용량을 0으로 채우지 않는다. 도구가 대기하라는 응답을 준 시간이 있다고 해서 ToolUsage.waitMs에 그 미래 대기 전체를 실제 수행 시간처럼 기록하지 않는다.

## 재시도 시각 계산

현재 nextRequest는 pending의 미완료 항목을 **전부** 선택하고, acceptPage는 그 집합 전체를 요구한다 (`read-collection-validation.ts:102`, `:135`). 이 계약을 유지하는 최소안은 다음 요청의 barrier를 계산하는 것이다.

```text
next retryAt = max(
  현재 다음 요청에 적용되는 verified whole-call deferral.dueAt,
  현재 pending non-success 항목들의 retryAt
)
```

힌트가 없으면 null/필드 생략이다. 다음 요청이 필요 없는 exhausted checkpoint에는 대기를 만들지 않는다. 일부 key만 먼저 요청하려면 nextRequest/expected key/partial merge/proof 계약을 추가 변경해야 한다. 이번 최소안은 기다릴 필요가 없는 미완료 항목도 같은 batch에서 잠시 대기시킬 수 있다는 효율 한계를 명시한다.

대기 계산은 현재 wall clock으로 필드를 삭제하거나 rewrite하지 않는다. ReadProgress.retryAt은 checkpoint에서 재계산한 절대시각이다. now와 비교하는 것은 실행/스케줄러 판단이다. 그래야 같은 head가 시각 변화만으로 invalid projection이 되지 않는다.

원자료의 Retry-After seconds/date 처리와 overflow 검사는 infrastructure에서 수행한다. 타이머 지연 때문에 dueAt이 core의 receivedAt보다 앞설 수 있으므로 `dueAt >= receivedAt`을 구조 조건으로 강제하면 정상 응답을 거절할 수 있다. raw의 기록 시각을 바탕으로 정규화하고, dispatch 이후 생성된 안전한 절대시각인지 proof로 확인한다. 이미 지난 hint라도 deferral 수신은 한 번 partial로 끝낸다. 무한 즉시 retry loop로 바꾸지 않는다.

## dueAt 이전 successor를 막는 위치

단순히 모델에게 기다리라고 보여주는 것으로 끝내면 안 된다.

1. **reserve 전 및 reserve commit fence**: exact parent head와 원본을 읽어 gate를 계산한다. 대기 중이면 attempt/예산 예약/부모 successor 소비를 만들지 않는다. `execution-runtime.ts:166`의 reserve 경로가 조기 차단 지점이다.
2. **dispatch 전 및 dispatch commit fence**: 오래된 예약이나 우회 삽입된 예약이 이른 실행을 만들지 못하게 같은 현재 검사를 한다.
3. **ReadCollections parent 검사 후 초기 child publish 직전**: `read-collections.ts:175–192`에서 dueAt과 현재 deadline을 검사한다. 최초 publish CAS가 parent.successorAttemptId를 설정하므로, 이 CAS 전에 막아야 한다.
4. **매 ReadCall intent 생성과 RPC 직전 authorize**: 최초/다음 요청에 대해 checkpoint에서 계산한 barrier를 확인한다. source 내부 await 이후 clock/권한/등록/head를 다시 검사한다.
5. **replay**: 각 새 call의 dispatchedAt이 그 call 이전 prefix에서 계산된 barrier 이상인지 확인한다. 이를 하지 않으면 이른 호출 기록을 저장한 뒤 시간이 지난 시점에 검증할 때 정상처럼 보인다.

단순 현재시각 검사가 아니라 역사적 dispatchedAt 검사와 현재 admission 검사가 모두 필요하다. 이미 완료됐지만 외부 result를 잃은 checkpoint의 무입력 재개는 남은 maxCalls가 0이어도 기존처럼 가능해야 한다. 실제 추가 fetch가 필요한 경우에만 maxCalls 여유를 요구한다.

dueAt이 work.deadlineAt 이상이면 시간을 앞으로 당겨 호출하지 않는다. 원본 dueAt을 그대로 보존하고 deadline으로 실행 불가를 반환한다. 목표/정책/자료 세대/contract가 바뀌면 기존 resume proof가 허용하는 범위만 따른다. waiting 상태가 이런 경계를 면제하지 않는다.

## 컨트롤러 연결 주의

기존 decide는 readProgress가 있는 attempt를 자동 재시도하지 않는다 (`domain/control.ts`의 task 선택). 새 대기도 이 원칙을 유지한다. future retryAt을 확인한 controller는 저장된 wait/wake metadata를 반환하고 모델을 반복 호출하지 않는다. due가 지나면 검증된 명시 readResume task를 처리할 수 있으며, SDK 자체 retry는 여전히 꺼져 있다.

work의 다른 독립 task가 실행 가능한데 첫 번째 throttled task 때문에 전체를 기다리게 하지 않도록 task별 eligibility를 비교해야 한다. WorkState.retryWakeAt은 스케줄링 projection일 뿐이며 실제 호출 권한으로 사용하지 않는다. dueAt 변경·원본 유실·cancel/pause·goal 변경 이후 오래된 wake가 실제 실행을 복원해서는 안 된다. root가 controller 경로를 별도로 설계 중이다.

## 호환성과 범위 기록

기존 ReadPage/ReadProgress의 새 필드는 optional이며 기본값을 serialize하지 않는다. 구형 logical checkpoint와 delta record는 기존처럼 읽고 재생한다. 새 deferred record는 구형 reader가 조용히 accepted로 오해하지 않고 실패해야 한다.

새 marker는 definition digest를 바꾼다. 이전 수집을 재개하려면 이전 exact tool/version/validator도 여전히 등록되어 있어야 한다. 기존 checkpoint의 contractDigest를 새 계약으로 rewrite해 이행하지 않는다. 새로운 응답 능력을 배포할 때 version 변경 및 이전 읽기 계약 보존 범위를 명시해야 한다.

## 완료 기준 제안

- 첫 호출 전체 throttle 후 snapshot=null, pages/items=0, acceptedRequestIds=[]를 보존하고 calls=1, actual transportCalls=1, deferred raw proof를 남긴다.
- 성공 항목 A와 throttled B/C에서 A는 재요청하지 않는다. 최소 barrier 정책이면 max(B.retryAt,C.retryAt) 전에는 새 입력/모델/예산 예약/parent successor가 0개다.
- dueAt-1 거절, dueAt 경계 허용, deadline 이후 거절을 fake clock과 양 저장소에서 확인한다. 부모 call budget과 unknown 기록은 재개 후에도 유지된다.
- whole deferral 원본 또는 item-retry page 원본만 유실/변조했을 때 시간이 지났어도 receive/adopt/compact/reopen/resume가 거절한다.
- deferral을 page로 바꾸기, dueAt 줄이기, wrong request/attempt/snapshot, callback 누락/교체가 proof/replay에서 거절된다.
- 실제 로컬 MCP 도구의 알려진 throttle schema만 deferral로 변환한다. 임의 text/transport 실패/list change를 Retry-After로 추정하지 않는다.
- ACK 유실/프로세스 종료 후 같은 attempt를 자동 재호출하지 않고, 새 명시 resume가 현재 원본·clock·권한을 검사한다.
- reserve/dispatch/authorize 및 역사 replay 모두 due gate를 적용하여 저장된 이른 예약/이른 call을 우회 수단으로 사용할 수 없다.
