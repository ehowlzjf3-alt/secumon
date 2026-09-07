# P3-01 MCP adapter 경계 검토

2026-09-06 · 기존 runtime 소스 읽기와 최소 연결 제안

이번 검토에서 소스 수정, SDK 설치, 빌드, 시험, 모델/API/외부 서비스 호출은 하지 않았다. SDK v2와 2026-07-28 규격 확인은 부모 작업이 맡고 있으며, 이 문서는 해당 규격을 독립 검증하거나 최종 버전을 pin한 기록이 아니다.

결론은 **host 승인 manifest를 바탕으로 읽기 Tool을 만들고, 원 MCP 응답 artifact에서 output과 Evidence를 재계산하는 작은 adapter**다. 기존 호출 장부·저장소·카탈로그·결과 수신/채택·compact 경계를 재사용한다. MCP SDK 타입은 infrastructure에 두고, 코어에는 SDK 객체·JSON-RPC ID·transport 연결 객체를 넣지 않는다.

## 1. 이미 있는 연결 지점

| 책임 | 현재 구현과 의미 |
|---|---|
| 목록 준비/교체 | `application/provider-tool-snapshot.ts:9–11,46–81`: 모든 page가 한 revision이라는 계약, 상한·중복·cursor 순환·부분 실패 검사 후 한 번에 replace |
| 도구 계약 고정 | `application/tool-contracts.ts:27–33,47–52`: definition과 execute/validateResult callback을 함께 복사·고정하고 schema를 컴파일 |
| 버전 변경 | `tool-contracts.ts:61–80`: sourceRevision만 바뀌어서는 contract digest가 바뀌지 않는다. callback 의미 변경은 definition.version에 반영해야 한다. |
| 호출 직전 권한 | `application/tool-broker.ts:23–58`: dispatch receipt, 현재 goal/task/owner/lease, 계약 digest, knowledge/예산/effect proof, 최종 revision과 공개 목적지를 검사 |
| 결과 수신 | `application/execution-runtime.ts:289–345`: dispatch 원본, 수명/정책, ToolResult/Evidence, output schema, artifact 존재, custom proof와 commit 직전 재검사 |
| 결과 채택 | `execution-runtime.ts:369–417`: 현재 task/goal/정책, lease/취소, 원본과 custom proof를 확인하고 최종 CAS fence에서 다시 검증 |
| compact | `application/context-compiler.ts:99–109,199–219`: 채택된 custom proof 결과를 원본 artifact에서 다시 읽어 검증 |
| 공개 화면 | `application/work-view-service.ts:72–99`: Evidence.artifact와 derived parent 원본을 읽고 결과 현재성을 판단. 임의 Tool.validateResult callback을 직접 호출하는 경로는 아니다. |

이 때문에 새로운 MCP 전용 task graph, 실행 장부, 메모리 저장소 또는 전용 완료 판정기를 만들 필요가 없다. 연결은 기존 `Tool.execute`와 `Tool.validateResult`를 중심으로 한다.

## 2. Manifest·schema·version·목록 변경

### 권한과 의미는 host manifest에서 정한다

최소 manifest는 provider/내부 tool ID/host revision, 원격 tool name, 목적지와 labels, 승인한 input schema, 원응답/structuredContent schema, 결과 projector ID·revision, 읽기 효과, 호출·응답·목록 상한을 가진다. 실제 transport 설정과 인증 handle은 host 구성으로 분리한다. 서버 설명문·annotations·serverInfo는 관측/대조 대상이며 권한 원천이 아니다.

첫 단위에서는 승인된 read tool만 등록한다. 원격 annotation에 read-only라고 쓰여 있다는 이유만으로 effect='read', 무제한 retry, cache 또는 공개 labels를 설정하지 않는다. host manifest가 검토한 효과/출처를 보증하지 못하는 도구는 등록을 보류한다.

Definition.version에는 host manifest와 projector의 의미 변경이 반영되어야 한다. 승인 schema·remote name·목적지·자료 등급·결과 해석이 바뀌면 version/contract digest가 달라져 이미 예약된 호출이 기존 계약으로 새 callback을 실행하지 못해야 한다. serverInfo.version이나 tools/list의 우연한 동일 문자열만으로 실행 의미를 보증하지 않는다. 동일 계약의 연결 재시작은 별도 session generation으로 다루며, 연결이 끊겼다고 과거 원본 관측의 의미 revision까지 임의 변경하지 않는다.

### 입력 schema와 결과 schema를 구분한다

`ToolDefinition.outputSchema`는 MCP 원응답 전체가 아니라 `ToolResult.output`에 적용된다(`execution-runtime.ts:307`). wrapper가 `{kind, responseArtifactId, data}`를 출력하면 이 wrapper schema를 등록하고, 원격 structuredContent schema는 별도로 검증해야 한다. 원격 output schema를 그대로 wrapper outputSchema에 복사하면 정상 결과가 잘못 거절되거나 다른 위치의 내용이 검증된다.

현재 `infrastructure/ajv-schemas.ts:5–13`는 strict 컴파일, coercion/default 삽입/추가 필드 제거 없음, async schema 거절이다. MCP 쪽 선언 dialect·keywords와 현재 컴파일러의 지원 범위가 맞는지 확인해야 한다. 맞지 않는 `$schema`나 제약을 지워서 억지로 통과시키지 않는다. 첫 manifest가 지원하는 작은 subset을 선택하거나, 별도 원격 schema compiler를 바깥층에 두어 명시한다. 원격 `$ref`가 임의 네트워크/파일 조회 권한이 되어서는 안 된다.

### tools/list page를 ProviderToolPage로 바로 옮기지 않는다

기존 `ProviderToolSource`는 한 revision의 완전한 목록을 요구하지만 MCP listing pagination에는 그 원자 revision이 없다는 전제를 따른다. 페이지마다 임의 revision을 붙이거나 전체 목록 hash를 원격 snapshot 보증이라고 설명하지 않는다.

최소 구현은 host manifest의 고정 tool 집합을 등록 후보로 삼고, bounded discovery를 해당 집합과 대조하는 방식이다. 원격 페이지를 모두 모으는 동안 duplicate name/cursor cycle/상한/취소/페이지 오류를 검사한다. 발견 결과는 host manifest 대조가 끝난 뒤 한 번만 교체한다. 그때의 sourceRevision은 ‘로컬에서 승인·대조한 manifest/discovery revision’이며 원격 원자 snapshot을 뜻하지 않는다. 마지막에 tools/list를 두 번 읽어 같아도 원자성이 생기는 것은 아니다.

목록 변경 알림 또는 재연결은 session/discovery generation을 dirty로 만든다. 이후 새 tools/call은 재확인까지 막는다. 진행 중 목록의 부분 실패로 기존 registry 전체를 지우거나 새 도구를 자동 승인하지 않는다. 연결 대기/queue/discovery await가 끝난 뒤 실제 call 전에는 세대와 현재 업무 권한을 다시 확인한다. 알림이 없거나 서버가 변경을 보고하지 않는 경우까지 완전 감지한다고 주장하지 않는다.

과거 관측의 유효성과 현재 endpoint 호출 가능성은 분리한다. 이미 채택된 raw-response proof의 검증은 네트워크 재호출 없이 가능해야 한다. 서버 재시작·목록 알림만으로 역사적 관측을 삭제하지 않는다. 반면 진행 중인 요청을 새 session/manifest의 응답처럼 채택하는 것은 막는다. 변경 시 과거 자료를 철회해야 하는 실제 업무 의미는 기존 data lifecycle을 통해 명시한다.

## 3. 요청·원응답·Evidence의 최소 흐름

1. Broker가 현재 계약과 공개 권한을 검사한 뒤 고정한 task/policy를 adapter에 전달한다.
2. adapter가 연결/queue 준비를 기다렸다면 실제 SDK call 직전에 현재 상태·goal/task·contract·disclosure·예산과 session generation을 다시 검사한다. Broker는 execute 진입 전까지 검사하므로 adapter 내부 await 뒤 권한까지 대신 보장하지 않는다.
3. SDK에서 받은 원 MCP 응답 JSON 값을 제한된 immutable envelope로 저장한다. 이는 SDK가 decode한 JSON의 보존이며 실제 wire byte 캡처라고 표현하지 않는다.
4. 승인된 순수 projector가 원응답을 검증하여 제한된 output과 Evidence를 만든다. ToolResult와 원본 ref를 기존 receive/adopt로 반환한다.
5. validateResult가 같은 artifact를 다시 읽어 basis/원응답을 확인하고 같은 projector로 결과를 재계산한다. 채택/compact 검사는 기존 callback fence를 그대로 사용한다.

### 원응답 envelope의 최소 내용

새 State 필드를 먼저 추가할 필요는 없다. 기존 ArtifactRef와 dispatch receipt, 명시 command receipt/event를 이용할 수 있다. envelope의 권장 metadata는 다음과 같다.

- schemaVersion/kind, workId/attemptId, dispatch에 고정된 task/input digest, goalRevision/scope/policy digest/data generation.
- provider/tool/version/contract digest, host manifest와 projector revision, 원격 tool name, 승인한 endpoint ID, session/discovery generation, 프로토콜 버전.
- 호출 전후 host 시각, SDK가 반환한 bounded 원응답 JSON, host가 실제 측정한 사용량과 미관측 null 필드.

식별·권한 metadata는 원격 결과에서 받아 덮어쓰지 않는다. request 자체는 이미 dispatch receipt에 있으므로 중복 복사는 필수 아님이다. 필요할 때만 정확한 원 request를 artifact로 분리하며 비밀 환경 변수나 인증 값을 넣지 않는다. envelope에는 자유 형식 remote metadata도 포함될 수 있으므로 labels는 현재 누적 disclosure floor와 binding labels를 보수적으로 상속한다.

raw ref를 validator가 ‘이 업무가 소유한 원본’으로 읽게 하려면 기존 transact/commitWithArtifacts로 `mcp-response:<attemptId>` 같은 결정적 command ID에 한 번 등록하는 작은 절차를 쓸 수 있다. 같은 ID의 다른 bytes는 conflict로 처리한다. 이 절차는 원격 호출을 다시 하지 않는다. 저장과 참조 commit 사이 오류는 기존 미채택 artifact/재시작 의미를 따른다. command receipt는 로컬 adapter가 수신한 원본의 provenance이며 원격 서버 진실성이나 효과 영수증을 증명하지 않는다.

### Evidence는 승인된 데이터 해석으로만 생성한다

기본 adapter가 모든 텍스트 응답에 facts를 붙여서는 안 된다. 구조화 결과가 없거나 mapping이 없으면 raw artifact와 제한된 output만 남기고 Evidence는 비워 둔다. `isError`, 구조 오류, 지원하지 않는 content kind는 성공 근거가 아니다. resource URI/image/url은 자동 읽기·다운로드하지 않는다.

프로젝터는 명시 schema의 Scalar 필드만 facts로 옮긴다. scope/tenant/labels/관측 시각·coverage/source identity는 host binding과 호출 원본으로 결정한다. 자료의 완전성을 보증하는 별도 계약이 없으면 `coverage='complete'`를 붙이지 않는다. 미래 시각/모호한 source key는 조용히 보정하지 않고 거절하거나 unknown으로 남긴다.

**Evidence.artifact는 authoritative raw-response envelope를 가리킨다.** 별도 요약만 가리키면 raw 원본이 사라져도 `WorkView`의 원본 검사는 요약만 읽어 통과할 수 있다. locator는 envelope 안의 승인된 JSON 위치 또는 record ID로 정한다. 입력/결과 검증 artifact가 별도로 필요하면 그 참조가 원본 폐기 검사에서 빠지지 않도록 dependency closure를 명시해야 한다.

**lineageId는 attempt나 응답 hash로 만들지 않는다.** `domain/completion.ts:19–21`는 서로 다른 lineageId를 독립 출처로 센다. 같은 원자료를 두 번 호출해 서로 다른 requestId/artifact hash를 얻어도 독립 근거는 늘어나면 안 된다. host가 정의한 dataset/source lineage를 유지하고, 같은 자료의 재조회/정정은 해당 lineage 안에서 표현한다. 두 진짜 독립 자료만 독립 lineage를 가진다.

## 4. validateResult와 실패 경로

MCP tool definition에 `resultValidation:'artifact-proof-v1'`를 붙이고 callback을 함께 제공한다. 등록 시 callback 누락은 이미 거절된다. callback과 definition 원본을 나중에 바꿔도 등록 객체가 변하지 않으며, callback await 중 provider entry가 교체되면 이미 false가 된다(`tool-contracts.ts:28–33,85–95`). 따라서 MCP 전용 우회 validation registry를 만들 필요가 없다.

callback은 raw envelope를 strict parse하고 다음을 확인한다.

- 이 attempt의 dispatch receipt와 work/task/input/goal/scope/contract/basis가 일치한다.
- artifact 참조·tenant/labels·차단/삭제 상태와 body integrity가 유효하다.
- 고정된 projector revision으로 만든 output, evidence, artifacts, coverage, error, usage가 실제 ToolResult와 일치한다. runtime이 추가한 retained knowledgeDependencies는 기존 방식대로 분리하여 확인한다.
- 검사 중 상태/등록이 바뀌면 최종 fence에서 거절한다. 입력 또는 원격 call을 재실행하여 proof를 만들지 않는다.

현재 `evidence-intake.ts:11–13`는 error/cancelled 결과에 Evidence와 artifacts가 있으면 거절한다. 따라서 MCP 오류 원문을 보존하기 위해 `status='error', artifacts=[raw]`를 그대로 반환하면 안 된다. 오류 원본을 보존할 경우 별도 원본 등록은 기존 상태 장부에 하고, 실패 ToolResult는 evidence/artifacts 비움과 고정 오류 코드를 유지한다. 성공으로 위장하거나 partial을 오류 보존용으로 남용하지 않는다. 상세 오류 원문은 일반 채팅에 그대로 보내지 않는다.

첫 범위가 검토된 read tool이므로 ToolResult.effectState는 none이다. 전송 후 취소/timeout은 응답이나 재조회 결과를 모른다는 뜻이며, SDK가 실제 remote 실행을 멈췄다는 증명은 아니다. 재접속은 원래 tools/call의 ACK 복구가 아니다. 자동 숨은 retry를 하지 않고, 재시도가 허용될 때에는 기존 runtime의 새 attempt와 예산으로 처리한다. implementationCalls, MCP transport 왕복, 서버 내부 작업, bytes·대기를 구분하고 관측하지 못한 값은 null로 남긴다.

## 5. 최소 파일 배치와 검증 기준

권장 새 경계는 `application/mcp-contracts.ts`(host manifest/decoded reply/envelope/projector 계약), `application/mcp-tools.ts`(현재 권한·raw artifact·ToolResult/validator), `infrastructure/mcp-client.ts`(공식 SDK 연결) 정도다. domain에 MCP SDK 개념을 추가하지 않는다. 파일명은 구현 담당이 기존 규칙에 맞게 확정한다. compose에서는 기존 services.tools에 생성한 도구를 넣거나 작은 optional binding 입력만 연결한다.

첫 통합 시험은 다음 신뢰 경계를 중심으로 묶는다.

1. 고정 host manifest와 실제 로컬 MCP listing/call, 예상 schema/remote name 대조, 미승인 annotation/도구의 권한 부여 없음.
2. 부분 목록·중복 name/cursor·목록 중 변경·reconnect/dirty generation·예약 뒤 version 변경이 새/잘못된 도구 실행으로 이어지지 않음.
3. adapter queue/connect await 중 pause/goal/공개 권한 철회 시 실제 call 0, 전송 뒤 취소·늦은 응답은 완료/미호출로 오인하지 않음.
4. 원응답의 error/비구조 text/초과 크기/지원하지 않는 resource가 Evidence나 완전 coverage를 만들지 않음. 문서와 관측 fixture를 같은 wrapper로 처리.
5. raw artifact 삭제·변조·다른 attempt 원본·projector/schema 변경이 receive/adopt/compact에서 거절됨. raw Evidence 원본 유실은 공개 화면 결과 준비 상태도 바꾼다. 두 저장소에서 동일 동작.
6. 같은 source 재조회 두 번이 minIndependentSources=2를 충족하지 않음. 독립 source 두 개는 조건이 맞을 때 충족함.
7. SDK call 결과를 저장한 뒤 재시작·응답 유실/동일 command 재전달에서 원격 호출을 자동 반복하지 않음. 오류 원문 보존이 failed-result schema와 충돌하지 않음.

실제 사내 명세·auth·G-DATA, 원격 paging 의미·rate limit, 쓰기 효과 대조, Knox 메시지 계약은 별도 선행조건이다. 로컬 MCP 읽기 adapter의 성공으로 이 조건을 충족했다고 기록하지 않는다.
