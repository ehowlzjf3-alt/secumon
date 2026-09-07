# P3-01 MCP batch/page·명시 재개 fixture 제안

2026-09-06 · 읽기 기반 설계다. 제품·시험·SDK를 수정하거나 빌드·시험·서버·모델·외부 서비스를 실행하지 않았다. v0.39의 단발 MCP fixture와 회귀는 그대로 보존하고 **새 collection 전용 서버와 계약 파일**을 추가하는 구성을 권한다. 아래 payload와 완료 기준은 제안이며 구현 결과가 아니다.

읽은 기준: [ReadCollectionSource 포트](/Users/seunghanee/Documents/secumon/runtime/src/application/ports.ts:90), [collection 모델](/Users/seunghanee/Documents/secumon/runtime/src/domain/read-collection.ts), [페이지·재조회 검증](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collection-validation.ts), [영속 runner](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collections.ts), [checkpoint 재검증](/Users/seunghanee/Documents/secumon/runtime/src/application/read-checkpoints.ts), [기존 통합 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/read-collections.test.ts), [v0.39 read adapter](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-read-tools.ts).

## 권장 최소 구성

| 항목 | 문서 batch | 관측 paged |
| --- | --- | --- |
| 새 remote tool 예시 | `documents.batch` | `observations.page` |
| 모델 TaskSpec.input | strict `{ids:string[]}` | strict `{ids:string[]}` |
| 선택 가능 ID | 생성 자료의 고정 enum, 중복 금지, 1–4개 | 생성 자료의 고정 enum, 중복 금지, 1–4개 |
| 논리 항목 | 선택 문서 ID당 기록 1개 | 선택 관측 ID당 기록 1개 |
| host manifest | query에서 완전한 ID/digest 목록 계산 | 같은 생성 manifest를 검증 oracle로 사용 |
| 기본 collection 한도 | pageSize=4, maxPages=1, maxCalls=4 | pageSize=2, maxPages=5, maxCalls=6 |
| source 식별 | 고정 문서 namespace | 고정 관측 namespace |
| 핵심 검증 | 일부 실패 뒤 실패한 ID만 재조회 | 빈 중간 페이지·부분 페이지·재접속 뒤 같은 snapshot/cursor |

업무 의미는 fixture binding에 둔다. 첫 데이터는 id/sourceKey/rootSourceKey/recordRevision/observedAt/value의 작은 구조화 기록이면 충분하다. `value`는 문서 30, 관측 1 등 고정 생성 값이다. 보안 위험도 추론, SIEM 쿼리, 자연어 문서 해석이나 자산별 행동을 일반 코어에 추가하지 않는다.

query는 ID 집합으로 정의하고 순서의 의미가 없다고 명시한다. query validator는 원래 입력을 변형하지 않고 검증하며, manifest/cursor 계산에는 ID를 정렬한 canonical query를 사용한다. 실제 TaskSpec와 readResume는 기존 queryDigest에 묶이므로 재개 때 입력 배열 순서까지 바꾸지 않는 것을 기본으로 한다. 모델 입력에 cursor/snapshot/requestId/retry/tenant/destination/labels를 허용하지 않는다.

## 호스트 요청과 원격 자료의 분리

MCP arguments 제안:

```ts
type CollectionArguments = {
  query: { ids: string[] };
  read: {
    requestId: string;
    cursor: string | null;
    snapshot: string | null;
    retryIds: string[] | null;
    itemLimit: number;
  };
};
```

`read`는 영속 runner의 ReadRequest에서만 만든다. `retryIds`는 이미 host가 검증한 retryItems의 ID projection이다. host inputDigest, work/attempt ID, Evidence ID와 권한은 서버에 보낼 필요가 없다. 응답의 requestId는 정확한 요청 결합에 쓰며 JSON-RPC ID와 동일하다고 가정하지 않는다.

raw structuredContent 제안:

```ts
type CollectionPayload = {
  version: 1;
  dataset: 'documents-v1' | 'observations-v1';
  requestId: string;
  snapshot: string;
  cursor: string | null;
  nextCursor: string | null;
  done: boolean;
  total: number;
  records: {
    id: string;
    outcome: 'ok' | 'partial' | 'error' | 'not_run';
    record: {
      sourceKey: string;
      rootSourceKey: string;
      recordRevision: string;
      observedAt: number;
      value: number;
    } | null;
    error: { code: 'temporary' | 'rate_limited' | 'forbidden'; retryable: boolean } | null;
  }[];
};
```

실제 두 output schema는 dataset을 각 고정 const로 두고 모든 object를 strict로 제한한다. 위 union은 설명용이며 두 도구를 느슨하게 섞는 구현을 권하지 않는다. raw는 ReadPage/Evidence/ToolResult가 아니다. 원격이 예상 집합이나 inputDigest를 만들어 호스트에 승인시키는 `expected` 필드도 없다.

호스트는 `ReadKey.inputDigest = digest(binding ID/version + canonical query + logical item ID)`를 계산한다. snapshot은 아직 없는 첫 batch manifest에 넣지 않는다. 이후 입력 identity와 원자료 snapshot/content identity를 각각 검사한다. response requestId/cursor/snapshot 및 record ID/source/revision/시각을 검사한 뒤 `expected`, `items`, coverage, artifact, Evidence를 만든다. batch의 첫 응답은 선택 manifest 전체, 재조회 응답은 retryIds 전체가 정확히 한 번씩 있어야 한다. paged의 첫·다음 페이지는 고정 fixture page plan에 대응해야 한다.

서버 자체의 입력 검증도 query/retry IDs의 부분집합, 중복, itemLimit, snapshot/cursor 결합을 검사한다. 이는 호스트의 응답 검증을 대체하지 않는다. 잘못된 응답을 만들기 위한 fault만 호스트 argv로 켠다.

## snapshot·cursor·source 계보

snapshot은 **선택된 불변 record 집합과 dataset 버전**의 digest에 결합한다. 한 프로세스의 시작 시간, PID, MCP connection generation, 재조회 횟수 또는 임시 rate-limit 상태에 묶지 않는다. 같은 자료의 새 서버 프로세스가 같은 snapshot과 cursor를 받아 이어 읽을 수 있어야 한다. 시각 기반 페이지나 현재 live 목록을 이와 같은 보장으로 표현하지 않는다.

cursor는 dataset/query/snapshot/page position에 결합한 bounded opaque 문자열이다. fixture는 호스트가 생성한 유한 page plan의 다음 위치를 가리키는 token만 인정한다. 새 namespace·다른 query·다른 snapshot의 token, 반복 token, 알려지지 않은 token은 오류다. token을 SQL·URL로 해석하거나 모델에 맡기지 않는다. 이 고정 생성 fixture에서 token digest는 권한 증명이 아니며 임의 사용자 접근을 통제하는 암호화 토큰으로 주장하지 않는다.

정상 paged 경로는 두 개 이상의 페이지로 구성한다. empty-page 모드도 처음부터 끝까지 정해진 page plan을 사용해 nonterminal 빈 페이지에 새 cursor를 준다. 재조회는 원래 페이지의 cursor/nextCursor/done/total/snapshot을 그대로 반환하면서 records만 미완료 집합으로 줄인다. 부분 페이지의 모든 항목이 성공하기 전에는 nextCursor로 진행하지 않는다.

fixture는 전체 selected ID와 고정 페이지 계획을 알고 있으므로 `total == selected unique IDs`와 최종 합집합을 직접 대조할 수 있다. 이는 **fixture 원자료의 유한 manifest**에 대한 완결성이다. 원격의 records와 total이 함께 항목을 누락하는 임의 운영 서비스를 기존 ReadPage 구조 검사만으로 탐지한다고 주장하지 않는다.

sourceKey/rootSourceKey는 manifest의 고정 mapping과 같아야 한다. 같은 원출처의 두 alias를 다른 페이지 또는 재조회에서 읽어도 lineage는 동일하다. 첫 단위는 alias를 같은 원출처로 취급하는 사례만으로 독립 출처 증가 방지를 검증할 수 있다. 실제 파생 사본의 derivedFrom을 추가한다면 원자료가 없는 사본을 새 독립 Evidence로 바꾸지 않는 별도 관계 검증이 필요하다.

Evidence ID는 host collection operationId + logical ID + snapshot/원관측판에 결합하고, 같은 operation의 성공 기록은 그대로 보존한다. 새 requestId나 MCP 재접속을 새 독립 source로 세지 않는다. 별도 collection operation에서 새 Evidence ID를 만들더라도 lineageId는 같은 원출처를 유지한다.

## partial과 재조회 완료 조건

첫 소단위에서는 **불완전 raw record는 저장하되 Evidence를 생성하지 않는 방식**을 권한다. ReadItem.partial은 제한된 진단 output을 가질 수 있으나 coverage=partial, evidence=[]다. 이후 성공 응답에서 처음 complete Evidence를 만든다. 기존 runner는 같은 Evidence ID의 다른 body를 `evidence_id_collision`으로 거절하므로 partial Evidence의 coverage/recordedAt/artifact를 같은 ID로 덮어 쓰는 구현은 맞지 않는다. 부분 근거 자체의 승격·개정은 추가 설계 없이 끼워 넣지 않는다.

| 사례 | 첫 응답·정지 | 명시 readResume 후 기대 |
| --- | --- | --- |
| A 성공/B 일시 오류 | batch 전체 manifest, A ok/B error(retryable) → partial | B만 요청, 같은 snapshot·total 유지. A의 output/Evidence/시각/artifact 동일 |
| 페이지 내 부분 기록 | A ok/B partial, 다음 cursor 존재 → partial | B만 요청. B ok가 된 뒤에만 원 nextCursor로 진행 |
| 항목 rate-limit | 선택된 B에 error/rate_limited/retryable → partial | 호출 권한·잔여 예산을 새로 확인한 명시 재조회만 허용 |
| 항목 forbidden | 기록 없음·retryable=false | source 호출 0으로 read_retry_forbidden, 앞선 성공 자료 유지 |
| 도구 전체 rate-limit | MCP isError 또는 고정 transport failure; 가짜 empty page 없음 | 호출 예산 소비·partial 정지. 호스트가 fault 해제 후 명시 재개해야 함 |
| 빈 중간 페이지 | records=[], done=false, 새 cursor, 같은 snapshot | 호출·page 한도 소비 후 다음 페이지. Evidence나 안전 판정 생성 없음 |
| 최종 빈 결과 | dataset에 실제로 선택 결과가 없다는 별도 fixture 사례, done=true/total=0 | collection 수집 완료와 업무 완료 구분. 결과 0건을 보안 정상으로 해석하지 않음 |

모델 query를 1–4개 ID로 고정하면 정상 dataset에서 total=0은 만들 수 없다. 따라서 empty-final은 첫 범위에서 제외하거나, 호스트가 검토한 명시적인 empty dataset ID를 별도 계약으로 추가한다. 기존 enum에 임의로 0건 의미를 끼워 넣지 않는다.

재조회는 모든 pending ID를 정확히 반환해야 하며 일부만 고르거나 이미 성공한 A를 포함해 성공 내용을 바꾸면 거절한다. total은 원 collection 전체 수이며 재조회 record 수가 아니다. 성공 기준은 pending 없음 + 모든 페이지의 snapshot/metadata 일치 + declared total/manifest 합치 + 최종 done이며, `request.retryIds !== null` 자체가 성공의 근거는 아니다.

`retryable`은 즉시 재실행 명령이 아니다. 현재 core에는 retryAfter cooldown 스케줄러가 없으므로 자동 sleep/retry를 추가하지 않는다. rate-limit의 시간 힌트를 넣더라도 저장 진단 정보와 실제 대기·실행 정책을 구분해야 한다.

## 연결 전에 필요한 두 경계

1. 현재 ReadCollectionSource.fetch context는 workId/attemptId/policy/signal만 받는다. `McpStdioClient.call`의 **실제 전송 직전 authorize**에 연결할 runner/Broker current callback 전달을 명시해야 한다. source.fetch 앞의 검사만으로 adapter 대기 중 정책·목표·중지 변경까지 검증했다고 할 수 없다. v0.39 Tool.authorize와 같은 목적의 좁은 포트 확장이 필요하다.
2. 현재 ReadCheckpoints는 원본이라고 부르는 **정규화 ReadPage**를 다시 읽어 replay한다. 새 MCP decoded 응답을 artifact로 붙이는 것만으로 그 자료에서 mapper 결과를 재계산하는 검증은 생기지 않는다. raw envelope와 정확한 read request/query/binding/session/최초 기록 시각을 묶고, 저장·resume·validateResult에서 그 변환 관계를 재검증하는 계약이 필요하다. generic core가 MCP schema를 이해하기보다 source의 검토된 raw→page proof checker를 호출하는 방향이 적절하다. 빈 페이지는 item.artifacts가 없으므로 raw proof를 항목에만 매달지 말고 페이지/호출 수준의 보호 참조로 보존해야 한다.

proof 재검증은 당시 source snapshot과 binding의 동일성을 검사한다. 오프라인의 저장 결과 검증에 현재 MCP 세션이 살아 있어야 하는 것은 아니다. 새 호출에는 새 세션의 manifest 승인과 현재 권한이 필요하며, 과거 session generation을 새 전송에 재사용하지 않는다. source binding 의미나 버전이 바뀌면 기존 readResume를 거절한다.

## 최소 시험 구성 제안

기본 통합 흐름은 두 저장소 각각 실행한다. 원격 프로토콜만 확인하는 중복 case는 저장소 없이 한 번으로 충분하다.

1. 문서 batch 정상: host manifest와 2–4개 기록의 ID/value/source/coverage, 호출 1회, 원응답/proof/최종 결과를 대조한다.
2. 관측 paged 정상 및 빈 중간 페이지: fixed page plan을 끝까지 읽고 total·유일 ID 집합을 확인한다. empty에서 evidence 0, 다음 cursor 진행을 확인한다.
3. batch partial/error → 저장소 close/reopen + MCP client/server 종료 → 새 client와 validator 구성 → 명시 readResume: B만 재조회, A 불변, 같은 operation/call budget 유지, 새 requestId를 확인한다.
4. paged 부분 페이지를 위와 같이 재접속 후 재개: 같은 opaque cursor/snapshot으로 B 복구 뒤 다음 페이지, 성공한 prefix 재조회 0, sibling resume 거절을 확인한다. reopen만으로 RPC가 발생하지 않아야 한다.
5. rate-limit·forbidden 대조: 정상 자료를 빈 페이지로 바꾸지 않으며 반복 자동 호출 0, 실패 호출도 maxCalls에서 차감된다. 예산 소진 후 새 task라도 추가 호출 0이다.
6. ID 누락/추가/중복, source/rootSource 변경, retry 집합 누락/성공 ID 재전송, snapshot/total/nextCursor 변경, query·namespace가 다른 cursor, cursor loop를 묶어 거절 시험한다. 앞선 accepted page는 변하지 않아야 한다.
7. 서버 dataset이 바뀐 뒤 재접속: 예전 cursor를 새 snapshot으로 조용히 계속 읽지 않는다. 서버의 snapshot-expired/unknown-cursor와 host의 snapshot mismatch를 모두 실패로 보존한다.
8. raw proof 변조·삭제 또는 다른 read request의 proof 대입 후 resume/validateResult/adopt 차단. 빈 페이지의 raw 삭제도 같은 경계에 포함한다. 실제 MCP와 source 재호출 0인 오프라인 부정 대조를 둔다.
9. adapter await 중 pause/goal/policy 변경 → 실제 tools/call 0; 실제 reply 후 authority 철회 → 페이지/원본 response 미게시·근거 미채택. late 응답 취소와 받은 뒤 거절의 관측을 나눈다.
10. 같은 rootSource alias·재조회는 독립 source 수를 늘리지 않으며, 오류/부분/빈 결과가 완료 근거를 만들지 않는다. 원격 content의 지시가 정책/계획으로 승격되지 않음을 strict 결과 대조로 확인한다.

프로세스 전체 복구가 이번 목표라면 추가 1단계만 분리한다: 소유 worker가 MCP call 직전 durable intent를 남긴 뒤 SIGKILL되고, 새 worker가 same snapshot의 명시 resume를 수행한다. 기존 intent는 unknown으로 남고 예산을 환급하지 않는다. 이를 작성·실행하지 않는다면 3·4는 **같은 시험 프로세스에서 저장소와 연결을 재구성한 재개**로만 보고한다. 단발 v0.39의 서버 process.exit 시험을 이 worker SIGKILL의 증거로 재사용하지 않는다.

## 파일·계측·범위

권장 새 파일은 `src/tests/helpers/mcp-collection-fixture-contracts.ts`, `mcp-collection-fixture-server.ts`다. 고정 자료/manifest/page plan의 순수 helper와 SDK 서버 entry를 분리한다. 기존 v0.39 서버의 기본 tools·enum·mode·schema를 바꾸지 않는다. fault는 mode argv와 고정 생성 자료만 사용하며 사내 파일·API·키를 읽지 않는다.

audit는 method/tool/query IDs/requestId/cursor/snapshot/retry IDs/item count/handler·response·close 사건의 제한된 JSONL로 충분하다. JSON-RPC ID, host ReadRequest ID, attempt ID를 같은 ID로 취급하지 않는다. 성공 prefix의 재호출 유무를 확인하려면 호출별 실제 반환 ID 목록도 기록한다. 자료 원문과 임의 오류 메시지는 audit에 필요 없다.

비교는 논리 Task 실행 수, MCP tools/call 수, handshake/list/notification 포함 전송 수, request frame bytes, decoded MCP JSON bytes, 정규화 ReadPage bytes, artifact/checkpoint bytes를 나눠 기록한다. 재개 후 호출 수는 child attempt 사용량과 root operation 누적치를 함께 보되 이중 합산하지 않는다. unknown 호출의 내부 사용량을 임의로 0으로 만들지 않는다. 모델 호출은 0이며 실제 사내 MCP/HTTP/OAuth·SIEM/EDR·Knox 호환성, 모델 추론 품질, 실제 서비스 지연 성능 검증은 이 제안의 범위가 아니다.
