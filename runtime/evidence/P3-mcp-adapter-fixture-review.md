# P3-01 MCP adapter: 합성 read fixture 검토

2026-09-06 · 읽기 기반 설계 제안. 이번 작업에서는 제품 소스 수정, SDK 설치, MCP 서버·시험·모델·외부 서비스 실행을 하지 않았다. 실제 사내 MCP 명세는 제공되지 않았으며, 아래 업무 payload는 학습 fixture의 제안이다. MCP envelope와 SDK API의 정확한 형태는 루트가 확인하는 공식 규격에 따른다.

권장 구성은 **문서 manifest batch 1개 + 관측 snapshot paged 1개**다. MCP adapter는 제한된 호출과 응답 구조 검증을 맡고, 업무별 mapper는 fixture binding에 둔다. 기존 ReadCollections가 요청 intent, checkpoint, 명시적 재개, 예산과 증거 채택을 계속 관리한다. 일반 core에 보존기간·자산·센서 키를 추가하지 않는다.

## 확인한 기존 계약

- [ReadRequest/ReadPage/ReadItem](../src/domain/read-collection.ts), [strict schema](../src/application/read-collection-contracts.ts): requestId/cursor/snapshot/retryItems/itemLimit와 항목별 status/output/evidence/artifacts/coverage/error를 구분한다.
- [페이지 검증](../src/application/read-collection-validation.ts): expected와 items의 ID·digest 집합 일치, snapshot 고정, 중복 ID·cursor loop 거절, totalItems 정합성, 미완료 항목만 재조회, 이미 성공한 항목 보존을 검사한다. 구조적 일관성이 외부 원본의 완전성을 증명하지는 않는다.
- [실행](../src/application/read-collections.ts): source 호출 전에 intent를 저장하고, 응답 후 현재 goal/policy/generation/lease/contract를 다시 확인한다. partial 또는 호출 오류에서는 해당 attempt를 멈추고 새 TaskSpec.readResume로 명시적 재개한다.
- [결과 projection](../src/application/read-checkpoints.ts): 결과 status는 수집 완결 여부에 따른 success/partial, effectState는 none이다. partial ToolResult.cursor는 **원격 페이지 커서가 아니라 checkpoint artifact ID**다. 원격 커서는 checkpoint.collection 안에 있다.
- [일반 ToolResult](../src/domain/model.ts), [증거 intake](../src/application/evidence-intake.ts): 호스트 attempt/result ID, 정책·scope·시간·계보 검증이 필요하다. error/cancelled ToolResult에 evidence/artifacts를 섞지 않는다.
- [실행 회귀](../src/tests/read-collections.test.ts), [순수 검증 회귀](../src/tests/read-collection-validation.test.ts): 취소·권한 철회 후 늦은 응답 차단, reopen 후 명시적 재개, empty page, pending retry, 한도 소진을 이미 다룬다. 새로운 MCP 연결에 자동으로 적용됐다고 간주하지 않고 통합 경로를 다시 검사해야 한다.

## 두 도구의 입력 분리

| 층 | 문서 읽기 | 보안 관측 읽기 |
| --- | --- | --- |
| 모델에게 보이는 도구 예시 | fixture.documents.read, version 1 | fixture.observations.read, version 1 |
| TaskSpec.input | `{documentIds: string[]}` | `{assetIds: string[], from: integer, to: integer}` |
| 제한 | 서로 다른 1–5개 ID, 호스트의 생성 문서 manifest 안에서만 선택 | 서로 다른 1–5개 생성 자산 ID, 고정 데이터 시간 범위 안에서 from < to |
| 호출 의미 | 선택한 문서를 정확히 읽는 batch | `[from,to)`와 선택 자산에 맞는 고정 관측 보고서를 페이지로 읽기 |
| host collection | kind=batch, manifest는 입력 ID에서 호스트가 계산 | kind=paged, 처음 반환받아 검증한 sourceSnapshot을 고정 |
| 업무 완료 예시 | 현행 근거로 retention.days 확인 | 요청 범위의 수집 보고서가 완결인지 확인 |

모든 input object는 additionalProperties=false로 고정한다. 임의 URL, 파일 경로, SQL·SIEM 검색식, shell, script, tenant/principal, destination, labels, evidence IDs, scope 변경 인자는 제공하지 않는다. 합성 자산 ID는 실제 IP·도메인을 조회하는 명령이 아니다. 날짜·자산 범위와 enum 목록은 binding과 fixture 생성 자료에 속한다.

MCP에 보내는 업무 arguments는 `{query, read}`로 정규화할 수 있다. query는 위 TaskSpec.input이고 read는 기존 ReadRequest의 5개 필드다. 모델은 read.requestId/cursor/snapshot/retryItems/itemLimit를 작성하지 않는다. host가 durable checkpoint로부터 채운다. MCP JSON-RPC 요청 ID와 ReadRequest.requestId는 서로 다른 식별자이며, 진단에서 관계를 기록하되 하나로 가정하지 않는다.

manifest의 ReadKey.inputDigest는 호스트가 `binding id/version + canonical query + logical item ID`에서 계산한 64자리 SHA-256이다. 콘텐츠 digest와 입력 identity를 혼동하지 않는다. 반환 문서·관측 본문은 별도의 recordRevision/contentDigest로 확인할 수 있다. batch 서버가 내보낸 목록을 그대로 trusted manifest로 채택하지 않는다.

첫 한도는 기존 회귀와 맞춘 maxPages=5, maxItems=20, maxCalls=6, maxPageBytes=65536, maxCheckpointBytes=262144, pageSize=5 정도면 충분하다. SDK 메시지 전체 bytes, 텍스트·구조화 payload bytes도 별도로 제한한다. 메시지를 임의로 자르고 coverage=complete로 유지하지 않는다.

## 업무 wire 응답과 host 출력

MCP의 업무 응답은 host의 Evidence나 ToolResult를 직접 반환하는 형태보다 **source record만 반환하는 strict page**가 적합하다. 예시 wire page:

```ts
type FixturePage = {
  schemaVersion: 1;
  requestId: string;
  sourceSnapshot: string;
  cursor: string | null;
  nextCursor: string | null;
  exhausted: boolean;
  totalItems: number | null;
  expected: { id: string; inputDigest: string }[];
  items: {
    id: string;
    inputDigest: string;
    status: 'success' | 'partial' | 'error' | 'not_run';
    coverage: 'complete' | 'partial' | 'unknown';
    record: DocumentRecord | ObservationRecord | null;
    error: { code: string; retryable: boolean } | null;
  }[];
};
```

두 도구는 각자 한 record 종류만 허용한다. 서로 다른 업무 record를 union으로 느슨하게 받지 않고 binding의 output schema로 제한한다. expected/items가 서로 같아도 서버가 같은 항목을 양쪽에서 빠뜨릴 수 있으므로 batch는 host manifest와 비교하고, paged는 검증 가능한 fixture snapshot/전체 집합과 추가 대조한다.

- DocumentRecord 최소 필드: documentId, recordRevision, sourceKey, rootSourceKey, observedAt, title, body 또는 구조화된 생성 문서 내용, retentionDays, derivedFromDocumentIds/supersedesDocumentIds. retentionDays는 유한 정수다. 첫 구현에서는 문서가 명시적으로 가진 구조화 값을 옮기는 것으로 한정한다. 자유 문장에서 LLM이 규정을 해석했다고 주장하지 않는다.
- ObservationRecord 최소 필드: recordId, sourceKey, rootSourceKey, observedAt, assetId, from, to, recordKind, 제한된 관측값. 이벤트 레코드와 범위 수집 보고서는 종류를 나눈다. 범위 보고서는 요청 범위와 source snapshot의 연결, 어떤 범위를 수집했는지, complete/partial, 관측 수를 명시한다.
- 오류 code는 binding의 고정 목록만 인정한다. raw 오류 메시지/stack/환경 값은 제품 답변으로 넘기지 않는다. not_run은 record=null, coverage=unknown이며 evidence/artifacts가 생길 수 없다.

처리 순서는 MCP result 구조·크기 확인 → tool 오류 여부 확인 → fixture output schema → source/query/response identity → 유한 필드 mapper → ReadPageSchema → 기존 acceptPage/증거 intake다. MCP content의 텍스트나 서버 설명은 데이터다. strict structured payload가 없다면 미리 정한 단일 text JSON fallback만 별도 계약으로 허용하거나 거절한다. 여러 content를 이어 붙여 임의 JSON을 복구하지 않는다. image/resource/link를 근거로 자동 내려받는 동작은 첫 read fixture에 필요 없다.

호스트가 ReadItem.output에 정규화한 기록을 넣고 Evidence를 만든 뒤 ReadPage로 반환한다. collection 결과의 ToolResult는 기존 ReadCheckpoints.project가 만든다. 원격 응답의 resultId/attemptId/effectState/coverage를 호스트의 권위 있는 결과 필드로 복사하지 않는다.

일반 Tool 구현으로 한 번만 호출하는 별도 비교가 필요하면 resultId·attemptId는 host가 만들고 read effectState=none으로 고정한다. status=success는 유효하고 완결된 응답, partial은 명시적으로 검증한 일부, error/cancelled는 evidence=[]/artifacts=[]다. 원격 isError=true 또는 전송 오류를 성공 페이지로 바꾸지 않는다. collection과 일반 Tool의 cursor 의미를 공유하지 않는다.

## Evidence 매핑과 완료 의미

| Evidence 필드 | host가 사용할 근거 |
| --- | --- |
| tenantId/scope/labels | 현재 work와 검토된 binding. 원격 문자열로 권한을 늘리지 않음 |
| id | binding namespace와 원본 record identity/관측판에 결합한 안정 ID. 같은 재조회에 임의 새 ID를 만들지 않음 |
| sourceId/lineageId | fixture manifest의 원본 관계. 문서 사본, SIEM에 전달된 같은 센서 원본을 별도 독립 근거로 늘리지 않음 |
| observedAt | 원본에 있는 고정 관측 시각. 조회 시각으로 바꾸어 새 관측인 것처럼 만들지 않음 |
| recordedAt | 최초 수락 기록 시각을 안정적으로 보존. 같은 evidence ID의 재조회마다 바꾸면 충돌하므로 같은 body로 재사용 |
| coverage | item 및 원본 수집 범위의 실제 완결성. partial record를 complete 근거로 승격하지 않음 |
| facts | mapper가 허용한 유한 키와 Scalar 값만 생성 |
| derivedFrom/supersedes | host manifest와 현재 접근 가능한 원본 evidence 관계로 검증. 원본 부재·권한 철회 시 관계를 지우고 독립 근거로 바꾸지 않음 |
| artifact/locator | host가 검증한 생성 자료나 수락 페이지에 대한 참조. MCP가 보낸 임의 로컬 경로나 URL을 그대로 접근 가능한 artifact로 쓰지 않음 |

[문서 단순 fixture](../fixtures/documents-simple.json)의 retention.days와 [복잡 fixture](../fixtures/documents-complex.json)의 구판/개정판/사본 관계를 재사용할 수 있다. 첫 성공 사례는 doc-current의 30일이며, doc-partial은 값이 같아도 완료 조건을 충족하지 못해야 한다. 다른 tenant·제한된 문서·원본 없는 사본·잘못된 개정 관계는 부정 대조로 둔다. 새 MCP 전송을 독립 원본 하나로 세지 않는다.

[관측 단순 fixture](../fixtures/observations-simple.json)의 collection.complete는 **조회가 0건인지**와 다르다. `items=[]`, timeout, rate-limit, 필터 결과 없음은 범위 수집 완료의 증명이 아니다. 일부 이벤트를 성공적으로 읽었다고 전체 선택 자산·시간 범위의 complete=true를 만들지 않는다. 관측 데이터에는 침해 확정, 차단 필요 등의 결론을 자동 추가하지 않는다.

권장 첫 관측 시나리오는 하나의 고정 범위에 대한 명시적 수집 보고서를 사용하는 것이다. 보고서가 해당 전체 범위와 고정 snapshot을 직접 다루고, complete임이 fixture manifest와 일치할 때만 collection.complete를 매핑한다. 여러 자산의 부분 보고서 중 하나를 전체 범위 근거로 사용하지 않는다. 이벤트 pagination의 완료와 source 수집 범위의 완료를 한 비트로 합치지 않는다.

현재 ReadCollections에는 전 페이지를 모은 후 업무별 집계 증거를 만드는 별도 mapper hook이 없다. 따라서 다음 둘을 구분한다: 첫 버전은 source가 제공한 고정 범위 보고서를 검증하여 읽는 것; 향후 전체 수집 기록을 근거로 host가 종합 coverage 증거를 만드는 것은 별도 구현 단위다. last cursor=null만으로 새 종합 evidence를 날조하여 이 간격을 메우지 않는다.

## partial·제한·cursor·late 사례

| 사례 | wire/mapper 처리 | runtime에 기대할 관측 |
| --- | --- | --- |
| batch 중 문서 B 일시 오류 | A success, B error/retryable=true, expected는 A/B 모두 | 첫 attempt partial. 새 readResume는 B의 ID/digest만 재조회. A bytes·시간·evidence 불변 |
| 부분 추출 | 해당 item partial, coverage=partial. 확인한 값만 제한된 evidence로 반환 | 완전 근거 요구를 충족하지 못함. 다음 페이지로 조용히 넘어가지 않음 |
| 권한 오류 | 해당 항목 error/retryable=false, 자료/근거 없음 | pending은 보존하지만 read_retry_forbidden으로 재개 거절 |
| 도구 전체 rate-limit | 유효한 항목 집합을 모르면 가짜 empty page를 만들지 않고 호출 실패 | 이미 저장된 intent/call budget 소비, partial 또는 일반 Tool error. 자동 재시도 없음 |
| 항목별 rate-limit | 이미 고정된 manifest/page item에만 고정 오류 code/retryable=true | 미완료 항목의 명시 재조회. 성공 항목 재전송·호출 예산 환급 없음 |
| 빈 중간 페이지 | expected/items=[]와 새로운 nextCursor, 동일 snapshot | 새 cursor로 진행 가능. 빈 페이지를 EOF로 추정하지 않음 |
| 진짜 빈 결과 | exhausted=true, nextCursor=null, totalItems=0의 일관된 페이지 | collection 수집 완료 가능. 도메인의 안전/부재/collection.complete 근거는 별도 |
| cursor 반복/잘못된 요청 응답 | requestId/cursor/nextCursor/snapshot 변조 | 기존 validator 거절, 앞서 받은 정상 페이지 보존 |
| pending retry의 snapshot/total 변경 | 실패 항목을 성공으로 바꿔도 원 page metadata와 다르면 거절 | 새 snapshot을 섞지 않음. 새 독립 조회가 필요 |
| 응답 전에 취소/goal·policy·generation 변경 | callback 종료만 믿지 말고 host와 ReadCollections의 현재성 검사 | 늦은 페이지 미채택, evidence·completedItems 증가 없음, 추가 페이지 호출 없음 |
| 재접속 또는 crash 뒤 늦은 응답 | 과거 RPC/request/attempt 매핑 유지, 새 호출에 귀속 금지 | unknown call 이력과 소비한 한도 보존. 명시 재개는 새 requestId |
| 응답 크기/항목/페이지/호출 한도 | 자르지 않고 고정 오류 또는 partial stop | maxCalls·checkpoint 이력이 재시작 뒤에도 유지 |

현재 ReadItem.error와 ToolResult.error에는 retryAfter 전용 필드가 없다. MCP 서버의 재시도 힌트가 있다면 host는 유효한 범위인지 검증하고 진단 데이터로 보존할 수 있지만, 이 메타데이터만으로 현재 core가 cooldown 스케줄링을 지원한다고 말할 수 없다. 첫 버전에서는 숨겨진 SDK retry/sleep을 끄거나 실제 횟수를 계측하고, 수집을 멈춘 뒤 명시 재개하도록 한다. `retryable=true`는 실행 권한이나 즉시 재시도 명령이 아니다.

스냅샷을 유지할 수 없는 실제 서비스의 timestamp pagination을 이 fixture의 불변 snapshot으로 가장하지 않는다. 첫 fixture의 cursor는 query·snapshot·namespace·page position에 결합한 opaque token이다. host가 커서 문자열을 분해하여 SQL·URL·새 권한으로 사용하지 않는다. snapshot 만료는 새 조회 필요라는 명시적 오류로 처리한다.

## 저장·호출 비용·검증 범위

ReadCollections가 현재 저장하는 response는 **수락된 정규화 ReadPage**다. raw MCP wire 원문이라고 이름 붙이지 않는다. wire bytes/JSON-RPC 횟수/SDK 내부 전송, mapper 뒤 page bytes, artifact 저장·읽기 bytes, 논리 toolCalls를 분리해 계측한다. 실패한 응답의 usage가 없으면 null을 0으로 바꾸지 않는다. 기존 projection은 해당 attempt의 호출만 합산하고, unknown/거절 call의 알려지지 않은 usage를 null로 보존한다.

raw wire를 영속화하려면 나중에 도착한 권한 철회 응답까지 무조건 artifact에 쓰는 경로를 만들면 안 된다. 첫 버전은 현재성 검사 후 기존 수락 페이지 저장 경로를 사용하고, 별도 wire 보존이 필요하면 그 저장의 권한·크기·세대·원문 공개 범위를 명시한 후 연결한다. text 안의 지시, 예시 policy, 재시도 요청은 planner 권한이나 시스템 instruction으로 승격하지 않는다.

기본 비교는 두 업무 × 두 저장소에서 동일 생성 데이터와 host mapper를 직접 source 경로/MCP 전송 경로에 연결한다. snapshot·생성 ID의 표현 차이만 명시적으로 정규화하고 항목 값, source/lineage, 시각, coverage, 오류·partial, criteria, 예산·호출 개수, resume 이력을 대조한다. 모델 호출은 0이고 LLM 추론·실제 SIEM/EDR 조회·사내 MCP 호환성의 검증으로 쓰지 않는다.

최소 통합 gate는 정상 schema/두 업무 의미 보존, partial retry 후 reopen, rate-limit에서 호출 폭주 없음, snapshot/cursor 부정 대조, 늦은 응답 차단, 사본의 독립 근거 증가 없음, raw text 지시의 권한 승격 없음이다. SDK handshake/tools list/tool call 결과를 실제로 통과했는지는 루트 실행에서 따로 기록한다. 이번 문서는 해당 gate의 성공 기록이 아니다.
