# MCP collection 요청별 custody — A 인수 사본

상태: **staging 작성·읽기 검토만 수행. 제품 미적용, 빌드·타입 검사·시험 미실행.** `src/tests/` 아래 두 신규 파일은 root가 같은 단위의 core/adapter 사본과 함께 검토·통합할 대상이다.

채택 기준은 [C05 계획](../../../../design/chapters/C05-mcp-collections-custody-plan.md)이다. 실제 테스트 실행 시점의 원문과 지문은 별도 검증 기록으로 남겨야 하며, 이 manifest의 지문은 작성 시점 의존 파일 관측값이다.

## 구성과 범위

- `mcp-collection-custody-fixture.ts`: 기존 `collectionBinding`·`collectionFixturePage`를 import하고 실제 SQLite/file-journal 저장소, FileArtifactStore, composeRuntime, ToolBroker, ReadCollections를 사용한다. C01 일반 프로필 입구를 시험하는 fixture는 아니다.
- 기본 transport는 고정된 SDK decoded 값을 전달하는 대역이다. 원 요청별 `requestId`로 capture/intent/원문 참조를 묶고, 별도 두 work가 같은 client를 사용하는 동시 시험도 둔다. 직접적인 SDK 수신 증거로 확대하지 않는다.
- 마지막 한 사례만 기존 로컬 stdio collection 서버와 실제 McpStdioClient/SDK를 사용한다. decoded 콜백 직후 AbortController를 중단하여 `post_response` 실패, 원문·영수증 보관, projector 0을 확인한다. 외부 모델·서비스를 호출하는 사례는 없다.
- raw 저장 전/후와 실제 commitWithArtifacts의 artifact 존재 확인 직후에 제한된 seam을 둔다. 원 intent/dispatch 손상은 저장소 read wrapper의 정확한 영수증 하나만 바꾼다. legacy/불가능 marker는 실제 commit 요청의 서명과 event payload를 바꾸어 저장한다.
- 부모합계·usage 정산·ContextRecovery 보호 투영·SIGKILL·일반 CLI/HTTP 입구는 이 A 파일에 포함하지 않는다. 임의 디렉터리 검색으로 원문을 복구하지 않는다.

## 작성된 인수

아래 반복을 합하면 **28개 등록 예정 시험**이며 실행 결과 수가 아니다.

| 묶음 | 예정 수 | 관측할 경계 |
| --- | ---: | --- |
| SQLite/file-journal × returned/captured 후 권한 축소 | 4 | 원 owner/lease/dispatch 보존, decoded 원문·marker·1회 사용량 증명, projector/채택 0 |
| 두 backend의 실제 2page head 진전·저장소 재열기 | 2 | 현재 head와 다른 원 intent별 조회, 정상 marked body와 원문·영수증 불변 |
| raw 전/후·response commit 직전 명시 취소 | 3 | 보관 허용, 현재 page/근거 채택 거절, 취소 상태 유지 |
| owner·generation·원 intent 손상 | 3 | custody 거절, response receipt 없음, 이미 생긴 고아 raw만 허용 |
| captured 오류와 custody 오류 동시 발생 | 1 | 두 원 오류 보존 |
| 호출 후 catalog entry 제거 | 1 | 원 귀속 보관 허용, 현재 등록 callback 조회와 분리 |
| sent false/true 및 일반 오류 | 3 | 확인된 0/1만 보관, 일반 오류에서 sent 추정·원문 조작 금지 |
| legacy 정상/실패 | 2 | 정상 body 호환, 과거 실패 sent=true 사용량 null |
| lease 뒤 게시된 decoded/prepared | 2 | 원 관측 시각과 준비 시각 구분, 새 body의 원 lease 경계 |
| captured body·wrong input/contract/raw·invalid marker | 3 | captured page 재사용 금지, request/dispatchedAt/원 영수증·해시 검사 |
| 같은 client의 두 동시 원 요청 | 1 | request/work/attempt/intent/raw 혼합 금지, 3초 barrier fallback·finally release |
| 실제 SDK decoded 뒤 abort | 1 | 실제 stdio call 1, postcheck 실패와 decoded 보관 구분 |
| source/restoreUsage getter 단회 등록 | 1 | 나중 getter 값으로 교체하지 않고 최초 함수의 this·호출 유지 |
| 최초 intent receipt 귀속 | 1 | digest/head가 같은 work/createdAt/owner 대체 snapshot을 source 진입 전 거절 |

모든 getter 인수는 실제 state/events/receipt/raw bytes와 호출·가공·manifest·게시 횟수의 불변을 비교한다. `restoreUsage`는 실행 중에도 요청 한 건을 읽을 수 있지만, 이 시험은 그 값을 실행기 장부에 조기 합산하지 않는다. 현재 head 변경은 그 자체로 거절 조건이 아니며, 실제 정상 2page 진전 후 원 intent 조회로 확인한다. 늦은 요청과 successor 사이의 전체 합계는 후속 B/C 범위다.

Root가 적용하기 전 제품 경로가 여전히 없는지 확인하고 이 manifest의 두 파일 SHA를 대조해야 한다. 기존 shared helper·제품·과거 staging·증거는 이 사본 작성에서 수정하지 않았다.
