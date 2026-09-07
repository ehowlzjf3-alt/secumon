# P3-01: 여러 응답을 보존하고 중단 뒤 이어받기

2026-09-06 · v0.40 · 로컬 단위 검증 완료 / P3-01 진행 중

## 이번에 배우고 구현한 것

문서 A와 B를 읽다가 B만 부분 응답을 반환했다고 생각해 보자. 다음 실행은 A를 다시 읽을 필요가 없다. 대신 A가 실제로 수락되어 저장되었는지, 원본이 남아 있는지, 같은 자료 집합을 이어 읽는지 확인해야 한다. 이번 단위는 이 규칙을 기존 수집 장부와 실제 로컬 MCP 사이에 연결한다.

전체 계획은 [통합 구현 순서](/Users/seunghanee/Documents/secumon/design/03-migration-plan.md)를 따르며, 이번 범위와 완료 기준은 [단위 계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-collections-plan.md)에 먼저 저장했다. 진행 방식은 개념 → 계획 → 구현 → 정상/실패/복구 검증 → 결과 저장이다.

## 구조와 선택 이유

기존 ReadCollections가 요청 ID, cursor, snapshot, 미완료 항목과 누적 호출 예산을 관리한다. 새 MCP adapter는 host가 승인한 입력을 만들고 원격 JSON을 읽는다. 원격 결과의 Evidence나 inputDigest를 그대로 신뢰하지 않고, host mapper가 항목과 관측을 만든다. 새로운 수집 장부를 중복 구현하지 않았다.

각 요청은 먼저 intent로 저장된다. 응답은 별도 raw artifact와 영수증으로 보존하며 당시 요청·intent head·dispatch task·계약에 연결한다. 수집기는 이 원본에서 만들어진 개별 page를 검사한 뒤 accepted head를 저장한다. 마지막에 합쳐진 page 하나만 검사하면 앞선 성공 응답의 근거가 사라질 수 있으므로, 재개·receive/adopt·compact/reopen에서도 각 accepted call의 원본을 다시 검사한다. 항목이 없는 빈 페이지에도 raw 참조가 남는다.

자료 경계와 등록 교체도 실행 조건이다. 도구 이름과 버전이 같더라도 실행 중 등록 객체가 바뀌면 기존 adapter가 계속 보내지 못한다. Broker 승인 후 비동기 checkpoint 검사 사이의 교체 경합을 독립 검토에서 발견했고, 실행 시작의 등록 객체를 전송·수신·게시 끝까지 대조하도록 수정했다. core는 MCP SDK·데이터베이스 종류·문서/관측 분야에 의존하지 않는다.

## 코드 읽는 순서

1. [MCP collection adapter](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-read-collections.ts): 승인된 요청 → 원응답 영수증 → host projection.
2. [공통 수집기](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collections.ts): intent와 accepted head, 미완료 항목의 명시 재개.
3. [체크포인트 검증](/Users/seunghanee/Documents/secumon/runtime/src/application/read-checkpoints.ts): 부모 원 task와 개별 page proof의 재검증.
4. [MCP 통합 실습](/Users/seunghanee/Documents/secumon/runtime/src/tests/mcp-read-collections.test.ts)과 [실제 종료 복구 실습](/Users/seunghanee/Documents/secumon/runtime/src/tests/mcp-read-collections-recovery.test.ts).

## 실행 결과

최종 관련 검증은 **127/127, 실패·취소·skip 0**, 24,692.220667ms다. 신규 시험은 MCP 통합26 + 실제 종료 복구6 + 공통 page proof16 = **48개**다. 이전 단발 MCP와 기존 수집/저장 회귀는 관련127에 포함되며 신규48에 더하지 않는다.

| 상황 | 확인한 결과 |
|---|---|
| 문서 batch·관측 paged × 두 저장소 | 네 항목 완결; 문서는 MCP call1, 관측은 call2 |
| B만 부분 성공 후 명시 재개 | B만 재조회하고 A의 내용·근거·원본·시각 보존 |
| 빈 페이지 | 다음 cursor로 계속하며 빈 원응답 유실도 거절 |
| snapshot 변경·cursor 반복 | 앞선 accepted page 보존, 문제 응답 거절 |
| 원본 변조·query 변경 | 부모 재개 거절, 새 원격 호출 없음 |
| 도구 전체 오류·rate-limit | EOF/자동 반복으로 바꾸지 않고 호출 한도 유지 |
| 전송 대기·응답 이후 정책 변경 | 해당 page 수락/근거 게시 거절 |
| 실제 worker SIGKILL | intent·accepted partial·nonfinal page, 각 두 저장소에서 새 owner로 복구 |

실제 종료 실습은 worker와 MCP peer의 PID를 따로 기록한다. 종료 전 intent는 unknown 이력을 남기고 새 request ID로 이어간다. 이미 accepted된 성공 항목은 다시 읽지 않는다. 원 worker, 원 peer, 새 peer의 종료와 임시 자료 정리도 기록했다.

전체 **npm run verify 2,040/2,040, 실패·취소·skip 0**, 292792.22975ms다. 코어 타입·안쪽 계층98파일/위반0·합성4시나리오/22판정도 통과했다. [최종 정본](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-collections-local-verification.json)에 소스/빌드와 이전 기록의 보존 검사를 결합한다. 관련 로그와 32개 측정 행은 runtime/evidence/mcp-collections-final에 보존한다.

## 무엇을 보장하지 않는가

- 원격 서버가 응답했어도 로컬 accepted head 전에 중단되면 unknown일 수 있다. raw 영수증만 남은 응답을 전송 없이 수집 장부에 정산하는 기능은 아직 없으며 명시 재조회가 가능하다.
- 실제 SIGKILL 검증은 세 절단점×두 저장소다. wire 전송 후, raw 영수증 후·accepted 전, complete orphan, received 후의 모든 실제 kill 조합을 검증한 것은 아니다.
- 최초 snapshot은 원격의 opaque 식별자다. 이후 동일성과 선택 항목의 완결성·원본에서의 투영을 확인하며 원격 데이터의 객관적 진실을 독립 인증하지 않는다.
- rate-limit은 이번 fixture의 도구 전체 오류다. 항목별 Retry-After/cooldown 대기 및 자동 스케줄러 연결은 별도 단위다. 부분 항목은 원본과 출력만 보존하고 새 Evidence를 만들지 않는다.
- 수집 완료와 업무 전체의 완료 조건은 구분한다. 전 페이지를 요구하는 판단의 coverage 집계는 업무 계약과 함께 추가한다.
- 원격 내부 작업량·대기·이미지 사용량을 알 수 없으면 null로 남긴다. 관측한 MCP call 수는 속도 개선이나 전체 처리비용의 보장이 아니다.

SDK/lock은 v0.39 그대로다. 실제 모델/API 실험은 취소 상태이며, 사내 MCP·HTTP/OAuth·Knox·운영 GUI/배포는 실행하지 않았다. 별도 browser gate도 이번에 다시 실행하지 않았다. P3-01과 전체 P0–P6는 진행 중이다.

## 다음 단위

다음은 **rate-limit을 저장된 대기로 전환하고 기한 이후 명시 재개하는 계약**이다. 기다리는 동안 모델을 계속 호출하지 않고, 취소·기한·누적 예산을 지키며 미완료 항목만 이어받도록 한다. 이후 전 페이지 coverage 집계와 미수락 원응답의 정산을 따로 다룬다. 사내 연결 정보가 없는 상태에서도 합성 자료로 가능한 부분부터 진행한다.

생각해 볼 질문: 서버의 성공 응답, 로컬 accepted head, 업무 성공 판단은 각각 어떤 증거가 필요한가? 이 셋을 하나의 성공 표시로 합치면 어떤 중단 상황에서 잘못 이어가게 될까?
