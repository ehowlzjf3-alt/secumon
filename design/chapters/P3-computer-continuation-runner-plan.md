# P3-04 실제 이어가기 runner 계획

기준 v0.36 · 기존 전체 1,853개 통과 · v0.37 로컬 실행·복구 검증 완료

학습 순서는 개념 이해 → 작은 실행 계획 → 구현 → 정상·실패·복구 검증 → 학습 결과와 다음 단계 저장이다. 한 챕터는 검증 가능한 동작 단위로 나누며, 설계 방향이 달라지는 결정은 별도로 남긴다. 전체 P0–P6 목표는 유지한다.

이번 단위는 실제 continue/verify 실행이다. continue는 원본 dispatch의 typed steps에서 서버가 계산한 남은 입력만 수행한다. verify는 모든 입력이 applied인 원본의 현재 조건을 새로 관찰하고 자체 입력은 0회다. 이전 v0.36의 계약 시험은 실제 실행 지원의 증거가 아니다.

## 실행 계약

- 신규 act는 checkpoint v2를 게시한다. v1 읽기·정산 호환은 유지하되 누적 시도 수가 없는 v1은 이어가기 입력을 허용하지 않는다.
- v2 lineage는 rootAttemptId/actionDeadlineAt/maxObservations/maxInputAttempts/maxSuccessors/depth/observationsUsed/inputAttemptsUsed다. 최초 쓰기 deadline과 상한을 후속 작업이 늘리지 못한다. 관찰 12 이하, 입력 시도 binding.maxSteps*2 이하, 후속 깊이 8 이하다.
- child.initialObservation은 parent.latestObservation의 역사 참조다. entryObservation은 child의 첫 새 관찰, continuation.inheritedObservation은 마지막 applied 단계의 현재 조건을 확인한 새 관찰이다. child의 새 lease epoch를 사용할 수 있지만 과거 targetRef를 입력에 재사용하지 않는다.
- child.steps는 실제 자기 입력만 가지며 index는 0부터다. 원본 단계와의 대응은 claim.nextStep+index로 검사한다. 효과·usage·completedSteps도 자기 시도 기준이고 계보 누적량은 별도 metadata다.
- 첫 head를 관찰 호출 전에 게시하고 각 observe 예약 counter와 input intent를 driver 진입 전에 영속화한다. 실패·강제 종료도 예약한 누적량을 소비한다. v2 head의 게시 receipt를 원본과 함께 검증한다.
- unknown/intent는 정확한 settled proof가 필요하다. applied는 건너뛰고 not_applied만 새 operation ID로 재시도한다. 화면이 같다는 이유로 unknown을 applied로 바꾸지 않는다.
- 같은 parent의 claim과 successor Attempt, 예산 예약은 같은 CAS다. 취소/실패 후에도 claim을 삭제하거나 형제를 만들지 않는다. claim이 생긴 parent는 late publish/receive로 변하지 않는다.
- 이전 단계 조건은 뒤 단계가 덮어쓸 수 있다. 마지막 applied frontier만 새 관찰로 확인한다. 불일치 시 관찰 한도 안에서 중단하며 과거 applied 입력을 다시 실행하지 않는다.
- continue는 원 action deadline 안에서만 입력한다. all-applied verify의 새 읽기 lease는 원 입력 창을 갱신하지 않는다.

## 연결과 검증

ComputerContinuations의 prepare/resolve/current/refresh를 저장·예약·dispatch·broker·driver 경계에 연결한다. raw 원본 증명 검사는 knowledge 조회를 호출하지 않는다. 특정 정산 proof 검사로 child→parent 검증 시 자기 정산을 다시 검사하는 순환을 피한다. context/compact/restore는 마지막 child까지 원본 참조를 보존하고 원 입력 본문을 자동 복사하지 않는다.

정상 applied prefix→suffix, not_applied retry, 입력 없는 verify, A→B 조건 변경과 신선한 epoch를 확인한다. 실패는 proof 유실·변조, sibling 경쟁, goal/policy/owner/취소 변경, 만료와 누적 한도다. 복구는 영속 backend 재시작과 실제 소유한 시험 child의 SIGKILL 후 claim/intent/counter 보존을 확인한다. 최종 관련 시험과 전체 npm run verify를 실행하고 결과·소스/빌드·원본 보존 기록을 저장한다.

실제 API/모델 시험은 사용자의 취소 상태를 유지한다. 현재 단위는 로컬 합성 driver로 검증하며 운영 GUI·사내 MCP·메신저·배포를 실행하지 않는다. emitting build는 root만 수행한다.

완료 결과는 [실제 이어가기 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-continuation-runner-result.md)와 전체 1,930개 검증 기록을 따른다. P3-04 전체 상태는 부분 검증/진행 중이다.
