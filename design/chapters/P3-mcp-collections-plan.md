# P3-01: MCP collection과 명시적 이어받기

2026-09-06 · 계획/구현 중 · 선행 v0.39, 전체 1,992개 검증

## 개념과 목적

한 번의 도구 호출에서 여러 페이지를 수집하더라도, 각 원응답·수집 요청·부분 성공·남은 예산을 구분해야 한다. 이번 챕터는 기존 ReadCollections/ReadCheckpoints에 실제 로컬 MCP source를 연결한다. 학습 순서는 개념 → 계획/완료 기준 → 구현 → 정상/실패/복구 검증 → 결과와 다음 시작점 저장이다.

성공했다고 저장된 항목은 유지하고 미완료 항목만 명시적으로 다시 요청한다. 응답을 받기 전에 중단된 호출은 unknown으로 남는다. 서버가 실행했더라도 수집 장부에 수락되지 않은 응답까지 중복 조회가 전혀 없다고 보장하지 않는다. 외부 서버와 로컬 checkpoint의 원자 커밋은 이번 계약에 없다.

## 선택한 구조

1. ReadPage에 선택적 rawArtifact를 추가하고 collection.pageValidation marker가 있는 Tool에는 validateReadPage callback을 요구한다. 기존 도구와 저장 형식은 필드를 생략한 채 유지한다.
2. source.fetch에 현재 권한 검사 callback을 전달한다. MCP client의 실제 stdio send 직전에 Broker와 수집기 권한·현재 요청·계약을 재검사한다. 별도 수집 실행 장부를 만들지 않는다.
3. MCP 원자료를 host가 검토한 mapper로 ReadPage에 투영한다. 원응답은 requestId별 decoded JSON envelope로 보존하고 모델 query와 host ReadRequest를 분리한다. 원격 응답의 Evidence·inputDigest·권한을 그대로 받아들이지 않는다.
4. ReadCheckpoints가 각 accepted call의 개별 normalized page를 읽을 때 rawArtifact와 mapper를 검증한다. 최종 병합 page의 마지막 원본 하나만 검사하지 않는다. 빈 페이지 원본도 call/page 수준에서 보존하고, 마지막 원본·등록 검사까지 수행한다.
5. 부모 readResume·receive/adopt·compact/reopen이 위 검사를 재사용한다. snapshot/cursor·완료 항목·누적 calls/maxCalls·부모당 단일 successor를 기존 계약대로 유지한다.

## 실제 로컬 fixture

새 fixture는 문서 batch와 관측 paged 두 도구다. 모델 입력은 합성 ID 집합이며 프로세스·경로·tenant·검색식은 받지 않는다. host가 query와 requestId/cursor/snapshot/retryIds/itemLimit를 작성한다. 서버는 raw records를 반환하고 host manifest가 키와 inputDigest를 생성한다.

dataset snapshot과 cursor는 프로세스 재시작과 구분한다. reconnect의 in-memory generation 숫자가 새 process에서도 전역적으로 증가한다고 가정하지 않는다. peer 실행 PID와 새 요청 ID를 함께 관찰한다. 개별 항목 error/rate-limit은 보존 후 명시 재개하며, cooldown scheduler와 전 페이지 업무 coverage 집계는 별도 요구로 남긴다.

## 완료 기준

- 문서/관측×SQLite/file journal에서 실제 SDK stdio 요청을 통해 정상 collection을 완결한다.
- partial 후 명시 resume는 이미 accepted된 success를 다시 요청하지 않고 미완료 항목만 처리한다. query/snapshot/total/입력 identity 변경과 cursor 반복은 거절한다.
- raw 원본·mapper·callback·계약이 유실/변조/교체되면 receive/adopt/compact/reopen/부모 resume에서 거절한다. raw proof는 빈 페이지도 포함한다.
- source 내부 대기 뒤 정책·목표·취소·자료 변경과 실제 전송 후 늦은 응답은 보수적으로 처리하며 새 근거/완료로 승격하지 않는다.
- 실제 소유 worker child 종료를 포함해 durable intent/accepted page 경계와 재개를 검증한다. peer도 소유 PID를 확인하고 종료한다. 단순 같은 프로세스 재열기와 실제 프로세스 종료 시험을 구분한다.
- 요청·응답·page/항목/byte 한도와 누적 call 비용을 보존한다. 알 수 없는 원격 작업량을 0으로 기록하지 않는다.
- 관련 시험 뒤 전체 native verify/core types/architecture/fixture 검사를 완료한다. 정본·원본1,973개·현재 SDK lock을 보존하고 결과를 파일에 저장한다.

## 분담과 제한

공통 core hook/회귀, 합성 fixture/계약, 복구 경계/기록을 독립 검토한다. MCP source adapter와 통합 실습·최종 빌드는 root가 담당한다. SDK/의존성 추가는 필요하지 않다. TypeScript와 storage-neutral core, 검토된 도구 재사용 원칙을 유지한다.

실제 사내 MCP·HTTP/OAuth·legacy profile·Knox·운영 입력·모델/API는 이번 로컬 검증 범위가 아니다. 취소한 API/key 실험을 재개하지 않는다. 원문 접근 방식은 기존 정책·disclosure 계약을 따른다. 전체 P0–P6 목표와 미완료 조건을 유지한다.

검토: runtime/evidence/P3-mcp-collections-boundary-review.md, P3-mcp-collections-fixture-review.md, P3-mcp-collections-recovery-review.md.
