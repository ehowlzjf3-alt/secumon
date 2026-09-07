# P3-04 실제 이어가기 학습·결과

2026-09-06 · v0.37 · 로컬 단위 검증 완료 · 전체 P3-04 부분 검증/진행 중

이번 [실제 이어가기 학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-continuation-runner-result.md)에서 v2 checkpoint와 실제 continue/verify를 연결했다. 원 입력의 기한·누적 한도를 유지하고 부모당 하나의 후속 작업만 예약하며, 적용된 입력은 반복하지 않는다. 현재 조건을 새로 확인하는 verify는 입력 0회다. 전체 **1,930개 시험·실패 0**, 신규 77개·최종 관련 143개, 코어 타입 검사·안쪽 계층 98파일/위반 0·합성 4시나리오/22판정이 통과했다. 실제 SIGKILL 복구 6개와 정산 후 진행 장부 갱신·중복 credit 방지도 검증했다. P3-04는 부분 검증/진행 중이며 실제 GUI·모델/API·사내 서비스는 미실행이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-runner-local-verification.json).

## 배운 개념

긴 작업의 재개는 같은 입력을 다시 실행하는 명령이 아니다. 원본에서 이미 적용된 범위를 확정하고, 새 관찰로 현재 조건을 확인한 뒤 남은 단계만 실행해야 한다. 효과가 불명확하면 해당 입력의 영속 영수증을 먼저 대조한다. 입력 적용 사실은 현재 목표 달성 근거와도 구분한다. 최종 근거는 새 관찰에서 생성한다.

계획 전체와 이번 시도가 수행한 입력도 구분한다. child.steps에는 자기 입력만 남고 index는 0부터다. 원본 단계는 claim.nextStep+index에 대응한다. 부모 Attempt/head/result는 그대로 보존한다. verify는 자기 입력·효과 0회이며 새 읽기 lease가 원 쓰기 기한을 갱신하지 않는다.

## 구현한 순서와 저장 경계

1. 신규 act가 v2 lineage와 최초 시작 receipt를 저장한다. 원 actionDeadlineAt·관찰/입력 한도·후속 깊이는 고정한다.
2. 후속 계획은 빈 input과 원 attempt/head·필요한 정산 ref만 전달한다. 서버가 원 dispatch의 typed steps에서 다음 위치를 계산한다.
3. 검증된 claim과 단일 successor Attempt·도구 예산 예약을 같은 CAS로 저장한다. 취소/실패 후에도 형제를 만들거나 claim을 지우지 않는다.
4. 새 lease에서 관찰하고 마지막 applied 단계의 현재 조건을 확인한다. 앞의 조건을 뒤 단계가 덮어쓰는 A→B는 허용한다. 과거 targetRef는 재사용하지 않는다.
5. observe 전 누적 counter와 입력 전 intent를 저장한다. 관찰 결과와 applied 응답은 다음 필수 checkpoint에 함께 저장해 중복 I/O를 줄인다.
6. 결과 수신·채택·compact·restore 등은 부모의 원본·정산 증명을 계속 검사한다. 마지막 knowledge/budget await 이후에도 입력 직전 원본을 재확인한다.
7. 검증된 정산은 진행 장부를 갱신한다. sourceAttemptId/operationId/outcome이 같은 재증명은 새 credit이 되지 않으며 목표 Evidence도 만들지 않는다.

## 정상·실패·복구 검증

최종 관련 143/143, 전체 1930/1930·실패 0, 268403.600375ms다. 원본 1973개와 lock·선행 기록·소스/빌드 연결은 [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-runner-local-verification.json)에서 별도로 확인한다.

| 신규 회귀 | 개수 |
|---|---:|
| v2 checkpoint 계약 | 11 |
| coordinator 준비·정본·복구 | 12 |
| 실제 continue/verify | 16 |
| 마지막 입력 권한·근거 수명 | 14 |
| 실제 SIGKILL/재시작 | 6 |
| 추가 v2 context/복원 | 12 |
| 정산 진전·중복 credit | 6 |

정상 suffix·not_applied 재시도·입력 없는 verify, 새 epoch, 바뀐 현재 조건, 형제 예약 경쟁, 기한/누적 한도, 원본 유실, pause/goal 변경을 검증했다. SIGKILL은 claim 예약 직후, 관찰 예약 직후, Save 적용 뒤 응답 전을 양 저장소에서 실행했다. Save 적용 뒤에는 영수증 정산 후 depth2 verify로 완료하며 Save를 다시 실행하지 않았다.

중간 실패는 숨기지 않는다. 첫 관련 138/141, 다음 182/185, 세 번째 135/137의 기록을 보존한다. 마지막 실패는 실제 정산을 진행 장부에 반영하지 않아 no_progress_limit이 잘못 유지되던 문제였으며 fixture 완화 대신 제품 연결을 수정했다.

## 효율 관측과 제한

[before](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-runner-profile-before.json)와 [after](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-continuation-runner-profile-after.json)는 단일 로컬 중간 계측이다. 같은 합성 목표에서 입력3/Save1을 유지하며 실행 3.32초→2.43초, commit19→14, journal 읽기743MB→499MB를 관측했다. 반복 부모 검증 비용은 여전히 남는다. 이 수치를 일반 지연 보장이나 depth8 성능으로 해석하지 않는다.

프로토콜 시험의 실제 watchdog은 runner/authority/progress 60초, 종료 복구 lease는20초로 두고 가상 시간의 원 입력 timeout 5초 및 누적 한도를 그대로 검증한다. 실제 호스트 디스크 부하와 논리적 입력 기한을 분리하기 위한 시험 설정이며 제품 기한을 연장한 것이 아니다. 첫 전체 검증의 1,929개 통과·1개 취소는 depth2 복구 시험의45초 외부 대기 한도였고, 해당 시험만120초로 조정한 뒤 전체를 다시 검증했다.

v1은 조회·정산 호환을 유지하되 누적 counter가 없어 continuation을 허용하지 않는다. 관찰 예약 뒤 입력 intent 전 종료는 counter를 보존하고 보수적으로 unknown에 머문다. 입력이 없었다는 사실의 별도 정산은 후속 과제다. 실제 복구는 depth2까지 시험했고 상한8의 전체 성능은 아직 측정하지 않았다. 원작성자의 최신 namespace/reviewer 재인증·조회 전체 custody 예산은 기존 한계를 유지한다.

다음은 실제 로컬 합성 Web driver와 동일 목표 비교다. 전체 P0–P6 목표를 유지한다. 실제 모델/API 시험은 사용자 취소 상태이며 사내 서비스·Knox·운영 GUI·배포를 실행하지 않았다.
