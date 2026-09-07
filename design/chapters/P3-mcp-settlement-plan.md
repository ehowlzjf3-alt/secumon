# P3-01: 전체 수집 조건과 미반영 응답 복원

2026-09-06 · 로컬 구현·검증 완료

[학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-settlement-result.md): 관련 154/154, 전체 2,117/2,117 통과. 아래는 이 구현 단위에 적용한 계획이며 전체 P3-01 완료를 뜻하지 않는다.

직전 단위는 대기·재개 구현과 전체 2,089개 시험을 완료한 진전이다. 이번 판단 근거는 현재 소스와 v0.41 검증 결과이며 과거 Python 코드나 압축 파일 전체를 다시 비교하지 않는다.

## 개념과 구현 목표

한 항목을 온전히 읽었다는 사실과 요청한 모든 항목을 읽었다는 사실은 다르다. 개별 Evidence는 그대로 유지하고, 전체 수집이 필요한 Criterion에는 조회 digest와 선택적 snapshot 조건을 붙인다. host가 승인한 유한 manifest를 checkpoint에 고정하고 현재 ReadProgress에 전체 수집 상태를 투영한다. 이 투영은 별도 근거 출처를 만들거나 기존 독립 출처 수를 늘리지 않는다.

수집 완료 투영은 같은 목표·조회·snapshot·예상 항목 집합·정확한 head에 묶는다. 페이지별 실제 항목을 manifest와 대조하며, 원격 total/EOF만으로 전체 업무 범위를 추정하지 않는다. 알려진 manifest가 없는 조회는 이 완료 조건을 충족했다고 표시하지 않는다. 빈 manifest의 수집 충족도 개별 사실 또는 부재 주장의 근거를 자동 생성하지 않는다.

응답 수신과 checkpoint 반영 사이에 중단되면 저장된 receipt를 먼저 복원한다. 원래 attempt의 마지막 intent를 원 응답으로 정산하고, 이후 명시 readResume는 정산된 head부터 이어간다. 정산은 다음 페이지 실행·원격 호출·모델 호출·결과 채택을 하지 않는다. 원 응답 시각, retryAt, snapshot, request ID와 누적 호출 한도를 보존한다.

## 변경 경로

1. 도메인/계약: optional Criterion collection requirement, checkpoint의 승인 manifest와 검증 가능한 ReadProgress 투영. 완료·결과 준비·진전·모드 판단에 동일 조건을 전달한다.
2. 도구 포트: 저장된 응답만 읽는 복원 callback과 manifest callback을 등록 시 고정한다. MCP receipt 복원은 외부 어댑터에 두며 코어에 MCP/DB 의존을 추가하지 않는다.
3. 복원 서비스: terminal/expired read의 unclaimed original head를 CAS로 정산한다. 같은 요청의 receipt 없음과 존재하지만 무효인 상태를 구분한다. 현재 goal·policy·자료 세대·원본·등록이 바뀌면 정산하지 않는다. 중복 정산은 멱등이며 이미 준비된 후속 작업의 옛 head는 실행 전에 거절한다.
4. 런타임: 기존 lease 복구 뒤 저장 응답 정산을 연결한다. 완전한 응답을 이미 저장한 작업은 재전송 없이 현재 권한의 후속 실행으로 소비할 수 있다. 수신되지 않은 요청은 unknown 이력을 유지한다.

## 완료 기준과 검증

- 부분 성공만으로 전체 수집 조건을 통과하지 않으며, 같은 query의 마지막 항목까지 검증한 뒤 통과한다. 다른 query/snapshot/목표·잘못된 항목 집합·투영 변조를 거절한다. 개별 Evidence ID·값·시각·독립 출처 수가 유지된다.
- SQLite/file journal에서 실제 로컬 MCP 응답 receipt 직후 SIGKILL을 수행한다. 정상 전체·비최종 page·제한 응답을 재전송 없이 정산하고, 후속 실행은 필요한 나머지 호출만 한다.
- 복원 중 누락/손상된 원본·권한/등록/목표 변경·중복 호출·후속 claim 경합을 검사한다. 정산 단계에서 모델·원격 호출·추가 예약은 0이다.
- 관련 시험 후 native verify의 빌드·전체 시험·코어 타입·계층·fixture 검사를 수행한다. 현재 실행의 로그와 소스/빌드 일치를 간결하게 저장한다.

모델/API 시험 취소는 유지한다. 사내 MCP·Knox·운영 시스템·배포는 이번에 실행하지 않는다. 승인된 유한 manifest가 없는 임의 검색의 완전 열거 보장은 해당 소스의 명세가 필요하며 미확인 상태를 성공으로 표시하지 않는다. 전체 P0–P6 계획은 계속 유지한다.
