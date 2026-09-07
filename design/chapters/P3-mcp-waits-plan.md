# P3-01: 호출 제한을 저장된 대기로 바꾸기

2026-09-06 · 로컬 구현·검증 완료 · 결과: P3-mcp-waits-result.md

## 개념과 목표

기한은 늦어지면 실패하지만 재시도 시각은 그때부터 실행이 가능하다. 기존 obligation.dueAt는 전자이므로 rate-limit 대기에 재사용하지 않는다. 원 수집 장부에 재시도 가능 시각을 보존하고 기존 Control.wait·retryWakeAt·runnable(now)와 연결한다. 모델/API 실험 취소를 유지하며 실제 로컬 MCP와 합성 자료로 검증한다.

진행 순서는 개념 → 이 계획/완료 기준 → 구현 → 정상/실패/재시작 검증 → 학습 결과와 다음 시작점 저장이다. 이전 단위는 구현·전체 검증·원본 보존을 완료한 진전이다. 전체 P0–P6 목표는 유지한다.

## 상태와 도구 계약

1. ReadResponse는 기존 ReadPage 또는 별도 ReadDeferral이다. whole-tool rate-limit을 가짜 빈 페이지로 만들지 않는다. deferral은 requestId·절대 dueAt·rate_limited 이유·원본/usage 참조를 갖고 기존 ReadCall에 deferred로 저장된다.
2. deferred call은 MCP 호출과 누적 maxCalls를 소비한다. collection의 accepted 항목·snapshot·cursor는 바꾸지 않는다. typed 원응답과 당시 task/request를 별도 sibling proof hook으로 확인한다. 새 deferralValidation marker를 opt-in하며 기존 도구의 직렬화/버전은 불필요하게 바꾸지 않는다.
3. 미완료 항목은 선택적 retryAt을 가질 수 있다. 현재 수집기는 모든 미완료 키를 함께 재조회하므로 가장 늦은 재시도 시각까지 해당 수집을 기다린다. 먼저 가능해진 일부 키만 쪼개 보내는 별도 최적화는 이번에 도입하지 않는다.
4. checkpoint.retryAt과 ReadProgress.retryAt은 수락된 deferral/미완료 항목으로 결정하는 절대 시각이다. 복원·압축·새 계획·일시정지 해제가 시계를 다시 시작하지 않는다. replay는 각 역사적 dispatch가 당시 대기 시각 이후였는지도 검사한다.
5. host mapper는 검토된 retryAfterMs를 원응답 recordedAt에 더해 dueAt을 만든다. 안전한 정수·최소/최대 지연·오류 상태·버전·상충 필드를 검사한다. 설치한 MCP SDK에 표준 Retry-After 의미를 가정하지 않으며, whole-tool isError가 SDK outputSchema 검증을 건너뛰므로 host가 독립 검증한다.

## 실행과 재개

- due 전에는 해당 successor의 예약/dispatch/원격 호출을 막는다. 부모의 단일 successor 권리는 조기 시도로 소비하지 않는다. 다른 실행 가능한 작업은 계속 선택할 수 있다.
- 현재 계획에 당장 가능한 작업이 없고 유효한 수집 대기가 있으면 모델 재계획을 반복하지 않고 Control.wait를 반환한다. retryWakeAt은 스케줄 조회용 투영이며 원본 대기의 권위가 아니다.
- 원 parent/head를 지정한 readResume 작업을 미리 계획할 수 있다. 기한 이후 host가 runnable(now)를 조회하고 기존 workflow를 실행하면 그 작업을 이어간다. 업무별 권한을 가진 host 호출을 시험하며 상시 백그라운드 daemon은 P4의 범위로 남긴다.
- reserve·dispatch·수집 parent claim·MCP 전송 직전에서 현재 권한·원본·등록·goal·기한·남은 예산을 확인한다. 단순한 task ID 변경 또는 같은 query의 새 task로 해당 work의 대기를 우회하지 못하게 한다. 전 조직/endpoint의 분산 quota limiter는 이번 범위가 아니다.
- expired deadline과 취소가 우선한다. pause/resume는 원 대기를 보존한다. 알 수 없는 내부 작업량은 0으로 기록하지 않는다. 이미 완료했으나 미채택인 checkpoint의 무입력 복구는 보존한다.

## 검증 완료 기준

- 문서 batch/관측 paged, SQLite/file journal에서 실제 SDK whole-tool 및 항목별 rate-limit을 실행한다.
- due 직전 예약·MCP·모델0, 정확한 due에서 미완료 항목만 이어받고 이전 성공·시각·원본·예산 보존을 확인한다.
- 반복 workflow 호출·compact·재열기·새 owner와 실제 worker 종료 복구에서도 시각이 연장/초기화되지 않는다.
- 조기/중복 successor, task ID/query 우회, invalid/overflow/과도한 지연, 원본/등록/권한 변경, 취소·pause·deadline·maxCalls 소진을 검사한다.
- 현재 상태와 컨텍스트/공개 상태에 대기 시각을 표시하되 과거 호출의 대기를 현재 실행 가능성으로 오인하지 않는다. 사람 메시지는 기존 접수·완료·필수 안내 규칙을 따른다.
- 관련 시험 후 native verify와 core 타입·계층·fixture를 확인한다. 사용자의 진행 방식 보완에 따라 과거 Python 구현/압축 원본/모든 이전 검증 기록의 반복 대조는 하지 않는다. 현재 기능의 직접 증거와 영향받는 새 코어의 회귀, 실행한 소스·빌드의 일치만 기록한다. 별도 browser gate와 실제 모델/사내 MCP/Knox/배포는 실행하지 않는다.

검토: P3-mcp-waits-boundary-review.md, P3-mcp-waits-fixture-review.md, P3-mcp-waits-runtime-review.md(runtime/evidence).
