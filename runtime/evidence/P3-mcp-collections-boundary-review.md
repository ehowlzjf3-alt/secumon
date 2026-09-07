# P3-01 MCP 수집·재개 원본 경계 검토

상태: 읽기 설계 검토. 제품 코드 변경, SDK 설치, 빌드, 시험 및 서비스 실행 0회. 기존 로컬 MCP 단건 도구와 수집 코어를 읽은 결과이며, MCP batch/page 구현을 검증한 결과가 아니다.

## 권고

기존 `ReadCollections`가 요청 의도, 호출 상한, 페이지·항목 진도, 부모 단일 successor 및 체크포인트를 계속 소유한다. MCP 어댑터는 승인된 typed 요청을 만들고, SDK decoded 응답을 원본 artifact로 저장하며, 그 응답에서 개별 `ReadPage`를 결정적으로 만든다.

최소 공통 확장은 다음 세 가지다.

1. `ReadPage.rawArtifact?: ArtifactRef`: 개별 수신 페이지를 만든 외부 응답의 원본 참조. 기존 `ReadCall.response`는 계속 mapped page artifact다.
2. 등록 Tool의 선택적 `validateReadPage`와 수집 source의 `validatePage` 연결. `ReadCheckpoints.verify`가 **각 accepted call의 개별 received page**에서 호출한다.
3. `ToolDefinition.collection.pageValidation?: 'artifact-proof-v1'`: callback 필수 여부를 계약 digest에 포함한다. MCP 수집 도구는 marker를 필수로 설정한다. 기존 수집 도구는 필드를 생략하여 기존 계약을 유지한다.

`ReadCollectionSource.fetch` context에는 Broker가 공급한 `authorize`를 타입으로 노출하고, 실제 RPC 직전 사용할 수 있도록 수집 head/current 검사와 합성한다. SDK 타입은 infrastructure에만 남긴다.

## 기존 코어가 이미 보유한 경계

| 기존 위치 | 재사용할 보장 |
|---|---|
| `src/application/read-collections.ts:24` | reviewed definition과 source callback 캡처. 현재 fetch/manifest만 캡처한다. |
| `src/application/read-collections.ts:46` | running attempt, owner, lease, goal/policy/data generation, current task 및 contract 검사. |
| `src/application/read-collections.ts:63` | knowledge 검사 뒤 state/current 재확인. |
| `src/application/read-collections.ts:90` | artifact checkpoint 작성 후 WorkState CAS에 head/refs를 공개한다. 최초 child publish에서 parent.successorAttemptId도 같은 CAS로 설정한다. |
| `src/application/read-collections.ts:181` | 새 ReadCall intent checkpoint를 저장한 뒤 source를 호출한다. 실행 중단 후 같은 attempt를 자동 재실행하지 않는다. |
| `src/application/read-collections.ts:145` | 명시 readResume 시 정확한 parent head를 읽고 query/limits/contract를 비교한다. 부모 calls/refs/knowledge를 상속한다. |
| `src/application/read-checkpoints.ts:79` | current head·dispatch receipt·goal/policy/generation·parent chain을 검증한다. |
| `src/application/read-checkpoints.ts:134` | 개별 call의 request를 재계산하고 mapped page를 읽어 collection 상태를 재생한다. |
| `src/application/read-checkpoints.ts:183` | 현재 attempt가 실제 수행한 calls만 usage에 합산한다. inherited call을 다시 과금하지 않는다. |
| `src/application/read-checkpoint-store.ts:42` | 정본 state에 등록된 exact ref, 현재 visibility, artifact integrity와 checkpoint chain을 읽는다. 논리 projection cache는 원본 읽기를 대체하지 않는다. |
| `src/application/tool-contracts.ts:27` | callback과 definition을 등록 시 함께 캡처한다. `validateResult`는 detached state/result 및 await 뒤 동일 등록 entry를 검사한다. |
| `src/application/tool-broker.ts:55` | adapter await 뒤 실행 권한·goal·policy·knowledge·budget·effect proof·disclosure·동일 등록 entry를 검사할 authorize callback을 제공한다. |

수집용 별도 DB, 페이지 진도 장부 또는 독립 resume 엔진은 필요하지 않다. MCP SDK의 tools/list 페이지는 도구 발견용이며, 도구가 반환하는 데이터 페이지와 다른 계층이다.

## `validateResult`만 재사용하면 부족한 이유

`ExecutionRuntime.receive/adopt`는 ReadCheckpoints와 generic Tool.validateResult를 둘 다 호출한다. 이 경로에만 MCP 검증을 붙이면 최종 결과 채택은 보호할 수 있다.

그러나 수집 재개는 `ReadCollections.execute`가 parent에 대해 `checkpoints.read`만 호출한다. 실행 중이거나 결과가 아직 채택되지 않은 수집의 compact/restore 역시 `checkpoints.read`를 사용한다. 따라서 result callback만 연결하면 mapped page와 checkpoint가 온전하고 MCP 원본이 유실된 부모를 재개할 수 있다.

공통 `ReadCheckpoints.verify`에 page hook을 두면 기존 소비자가 자동으로 연결된다.

| 소비 지점 | 현재 호출 |
|---|---|
| receive 및 마지막 commit fence | `execution-runtime.ts:310`, `:343`의 `ReadCheckpoints.validateResult` |
| adopt 및 마지막 commit fence | `execution-runtime.ts:373`, `:414`의 `ReadCheckpoints.validateResult` |
| context prepare | `context-compiler.ts:217`의 collection 결과 검증 |
| compact 마지막 source fence | `context-compiler.ts:94`의 pending head read 및 `:108`의 adopted 결과 검증 |
| runtime reopen/restore | `context-recovery.ts:88`, `:152`의 current checkpoint read |
| 명시 parent resume | `read-collections.ts:152`의 parent checkpoint read |
| materialized result 읽기 | `work-resources.ts:173`, `:200`, `:268`의 collection 검증 |

페이지 hook을 둔 뒤 generic result callback으로 다시 전체 checkpoint를 읽는 중복 검증은 기본 경로에 추가하지 않는 편이 작다. 별도 result 수준 증명이 필요한 어댑터는 기존 validateResult를 함께 사용할 수 있다.

## 제안 포트 형태

구체 이름은 구현 시 정할 수 있으나 입력은 core 타입만 사용한다.

```ts
interface ReadPageProofInput {
  state: WorkState;
  task: TaskSpec;
  attemptId: string;
  request: ReadRequest;
  page: ReadPage;
}

interface ReadCollectionSource {
  manifest?(task: TaskSpec): ReadKey[];
  fetch(task: TaskSpec, request: ReadRequest, context: {
    workId: string;
    attemptId: string;
    policy: Policy;
    signal: AbortSignal;
    authorize?: () => Promise<void>;
  }): Promise<ReadPage>;
  validatePage?(input: ReadPageProofInput): Promise<boolean>;
}

interface Tool {
  // 기존 필드는 유지한다.
  validateReadPage?(input: ReadPageProofInput): Promise<boolean>;
}
```

- `createReadCollectionTool`은 `validatePage.bind(source)`를 최초 등록 시 캡처한다. 원본 source 객체 callback 교체로 현재 등록이 바뀌지 않아야 한다.
- `snapshotTool`은 validateReadPage도 캡처하고 marker가 있으면 함수 부재를 거절한다. marker는 collection 내부에 있어 read/no-reuse 제약도 기존 schema로 적용된다.
- ToolContracts의 wrapper는 모든 입력을 clone하고, attempt/tool identity와 marker를 확인한 뒤 callback을 호출한다. 반환 true와 동일 entry 유지가 모두 필요하다.
- marker가 있는 페이지에는 rawArtifact가 반드시 있어야 한다. callback 부재·제거·throw·false는 고정 공개 코드로 거절한다. marker 없는 기존 source에는 원본 증명 보장을 새로 주장하지 않는다.
- source verifier는 artifact/receipt를 읽을 수 있지만 SDK discovery/call을 실행하지 않는다. offline 원본 검증을 live MCP 연결 상태에 종속시키지 않는다.

## 원본과 mapped page 연결

현재 `read-collections.ts:208` 근처의 `raw` 변수는 `JSON.stringify(accepted.page)`다. 이것은 MCP 원본이 아니라 mapped page다. 필드명 또는 주석을 명확히 하되 기존 ReadCall.response 의미는 바꾸지 않는 편이 호환성이 좋다.

MCP envelope에는 최소 다음 바탕을 보존한다.

- workId, 원 호출 attemptId, core ReadRequest 전체 및 requestId
- task/query/input digest, definition/host mapping contract digest
- goal/policy digest와 data lifecycle generation
- endpoint·protocol·discovery snapshot 정보 및 실제 remote tool/input
- SDK가 normalize한 decoded response, 수신 시각, actual call 사용량 또는 전송 여부

검증은 host가 캡처한 입력 mapper를 task/request에 적용해 remote input을 재계산하고, 원본 envelope와 대조한다. output schema를 통과한 decoded body에 결정적 page projector를 적용한 뒤 supplied **received page** 전체를 비교한다. `rawArtifact` 자신은 내용 해시의 순환 참조를 만들지 않도록 envelope에 넣지 않고 projection 단계에서 첨부한다.

등록 version/definition digest는 mapping 변경 시 바뀌어야 한다. session generation은 실행 연결의 상태이고, snapshot은 실제 데이터 집합의 안정성 표식이다. MCP connection/discovery generation을 `ReadPage.sourceSnapshot`으로 대체해 데이터 일관성을 주장하면 안 된다. 원격 도구가 안정된 snapshot 또는 동등한 명시 계약을 제공하지 않는 경우 해당 범위를 완전한 paged collection으로 선언하지 않는다.

원래 `ReadCall` intent checkpoint를 호출 의도의 정본으로 재사용한다. MCP 응답 원본을 등록하는 receipt가 필요하더라도 새로운 retry/진도 장부를 만들지 않는다. 같은 attempt+requestId에서 중복 fetch가 전달될 가능성을 차단하는 것은 core call intent 및 어댑터 request identity로 처리한다. ACK 유실 시 동일 intent를 자동 재호출하지 않는다. 새 명시적 readResume만 기존 call 상한 안에서 후속 요청을 만든다.

## 개별 응답과 병합 페이지를 구분해야 한다

`read-collection-validation.ts:134–145`는 pending retry 시 이미 성공한 항목을 보존하고 새 응답의 미완료 항목만 덮어쓴다. usage/knowledge도 합산한다. 이 병합 결과에는 여러 응답의 내용이 있다.

따라서 최종 `checkpoint.collection.pages`의 병합본을 마지막 rawArtifact 하나에서 재계산하면 안 된다. `ReadCheckpoints.verify`가 이미 수행하는 `checkpoint.calls[n].response` 순회에서 개별 received page와 rawArtifact를 검증한 뒤, 검증된 페이지들을 기존 acceptPage로 재생해야 한다. 원 호출 task는 `call.attemptId`의 dispatch receipt에서 가져온다. child의 readResume task를 부모 응답 검증에 사용하지 않는다.

모든 개별 rawArtifact는 checkpoint.artifacts의 exact ref에 포함해야 한다. 항목 수가 0인 최종 빈 페이지도 예외가 아니다. evidence 또는 item.artifacts에만 참조를 넣으면 빈 페이지 원본을 잃는다. 부모 checkpoint.artifacts 상속과 개별 calls가 이전 raw 참조를 계속 보유하므로 별도 `rawArtifacts` 이력 배열은 필요하지 않다.

증거가 있는 항목은 각 Evidence.artifact가 해당 원본 envelope에 연결되는지 projector가 강제한다. 마지막 응답의 raw ref를 이전 성공 항목에 다시 붙이지 않는다. lineageId는 호출/응답 해시보다 논리 원자료 identity를 표현해야 중복 결과가 근거 수를 부풀리지 않는다.

## 권한 및 마지막 검증 시점

fetch에 Broker authorize를 그대로 노출하는 것만으로 끝내지 않는다. 수집용 합성 authorize는 다음 내용을 검사한다.

1. 현재 attempt/goal/policy/generation/contract/lease와 exact intent head.
2. 현재 head 및 부모 chain의 원본 proof. adapter await 중 parent raw 유실도 다음 RPC를 막는다.
3. Broker authorize의 budget·knowledge·effect·disclosure·등록 entry 검사.
4. 마지막 state/head/current 재확인. MCP client는 이 callback 뒤 자신의 session generation과 signal을 다시 검사하고 전송한다.

외부 RPC와 WorkState CAS가 하나의 원자 transaction이라는 주장은 하지 않는다. 이미 전달된 호출의 권한 철회나 응답 불확실은 미전송으로 바꾸지 않는다. 새 입력은 현재 권한으로 검사하고, 돌아온 응답은 다시 현재성을 확인한 뒤 원본/페이지를 게시한다.

`ReadCheckpointReader.revalidate`는 현재 캐시에서 재사용한 refs만 다시 검사한다 (`read-checkpoint-store.ts:166`). raw를 checkpoint.artifacts에 추가해 한 번 읽는 것만으로는 knowledge await 뒤의 원본 유실 검사가 보장되지 않는다. 다음 중 작은 방식을 선택해야 한다.

- 권고: proof 필수 ref는 최초 읽기부터 별도 검증 범위에 등록하고, 캐시 hit/eviction과 무관하게 마지막 revalidate에서 integrity를 확인한다.
- 대안: 마지막 fresh/knowledge 단계 뒤 page-proof hook을 다시 실행한다. 단순하지만 원본 JSON/receipt를 중복 읽는 비용이 더 크다.

각 callback 직후에는 동일 ToolContracts entry를 확인하고, 전체 검증 끝에는 state/policy/contract를 다시 확인한다. source 유실은 state revision이 그대로여도 실패해야 한다. 원본 get/exists 검사는 저장소의 실제 hash 검증 계약을 재사용한다.

## 대안 비교

| 안 | 장점 | 부족한 점 / 선택 |
|---|---|---|
| item.artifacts/Evidence.artifact만 사용 | domain 필드 증가 없음 | 빈 페이지 증명 불가, 어떤 ref가 원본인지 모호, 재계산 연결 없음. 비권고. |
| 최종 Tool.validateResult만 추가 | 기존 hook 재사용 | parent resume·pending compact의 checkpoints.read가 우회. 여러 소비자에 추가 배선 필요. 비권고. |
| 모든 raw metadata를 checkpoint/call 새 필드로 저장 | 명시적 장부 | checkpoint delta schema/이행/상속을 넓게 변경. 현재 목적에는 불필요. |
| rawArtifact + page hook + collection marker | 개별 call 재생에 붙고 모든 소비자가 같은 검증 사용 | 작은 domain/schema/port 확장 필요. 권고. |

## 구현 순서 및 완료 기준

먼저 core 타입/schema와 callback snapshot/marker 검사를 추가하고 기존 collection digest 호환을 확인한다. 다음 수집 실행·ReadCheckpoints의 최초/마지막 page 검증을 연결한 뒤 MCP source 어댑터를 추가한다. 마지막으로 실제 로컬 MCP subprocess fixture를 양 저장소 runtime에 연결한다.

필수 회귀는 다음과 같다.

1. batch partial → 명시 resume에서 성공 항목은 다시 요청하지 않고 미완료 key만 요청한다. parent/child 원본과 실제 호출 수·비용을 구분한다.
2. paged 응답의 snapshot/cursor/expected key/total/usage 변조는 원본 또는 page 재생 검증에서 실패한다. 정상 빈 최종 페이지도 raw proof를 보존한다.
3. MCP raw만 삭제·변조하고 mapped page/head는 유지했을 때 receive/adopt/compact/reopen/parent resume 모두 거절한다. 동일 revision 유실도 포함한다.
4. 두 개별 응답을 병합한 정상 페이지가 재개 후 통과하며, 첫 응답 원본 유실은 마지막 raw가 정상이어도 거절한다.
5. callback 누락/제거 refresh, 원본 객체 변조, callback await 중 동일 version provider 교체, detached 입력 변조가 현재 검증을 우회하지 못한다.
6. RPC 직전 authorize 동안 pause/goal/policy/knowledge/budget/원본 변경은 새 입력 0회로 끝난다. 실제 전송 뒤 취소·응답 유실은 미전송 0회로 정산하지 않는다.
7. intent ACK 유실/response ACK 유실/재시작은 같은 attempt를 재호출하지 않는다. 명시 resume는 정확한 parent와 단일 successor CAS를 사용하며 총 call 상한을 상속한다.
8. 반복 compact와 reopen이 원문 body를 context에 싣지 않으면서 원본 검증 참조와 pending 상태를 유지한다. 검증만으로 SDK 프로세스/RPC가 새로 생기지 않는다.

## 남는 범위

읽기 tool의 annotations는 권한이나 부작용 증명이 아니다. 사내 서버의 실제 batch/page/snapshot 계약이 아직 없으므로 로컬 계측 fixture와 host binding만 검증 대상으로 삼는다. 임의 MCP 도구의 데이터 페이지를 자동 추정하지 않는다. 원본 JSON, 원격 error 상세, 입력과 cursor는 모델·화면에 직접 공개하지 않고 기존 disclosure/context projection을 적용한다. 장기 수집 비용은 실제 RPC 수, inherited call, raw bytes, mapped page/checkpoint 읽기와 검증 비용을 나누어 관측한다.
