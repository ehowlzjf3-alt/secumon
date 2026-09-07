# P2-05 부모/자식 예산 위임 독립 검토

2026-09-05 · 실제 예약 연결 전 현행 경로를 읽은 설계 검토

부모가 자식 한도 전액을 먼저 보류하는 escrow 방식은 현재의 work 단위 CAS와 호환된다. 다만 부모 grant 발행, 자식 연결, 실행 중단, 정산은 서로 다른 커밋이다. **전액 보류는 초과 배정 방지의 근거이며 여러 work의 동시 커밋이나 즉각적인 원격 취소를 뜻하지 않는다.** 아래 내용은 구현 권고와 미실행 시험 계획이다. 순수 원장 helper 또는 기존 단일 work 시험을 자식의 실제 tool/model 할당 검증으로 대체하지 않는다.

## 확인한 재사용 지점

| 현행 경로 | 확인한 동작 | 위임 연결에서 보존할 조건 |
| --- | --- | --- |
| [StateRepository](../../runtime/src/application/ports.ts), [transact](../../runtime/src/application/work-transactions.ts) | 커밋 하나는 work 하나의 next/events/deliveries/receipt를 저장한다. command ID와 digest가 중복 여부를 결정한다. transact는 CAS 충돌 시 최신 상태에서 edit를 다시 실행한다. | 부모·자식 양쪽의 영수증을 하나의 원자적 트랜잭션으로 해석하지 않는다. beforeCommit의 부모 조회도 자식 CAS와 원자적이지 않다. |
| [SQLite](../../runtime/src/infrastructure/sqlite-state.ts), [file journal](../../runtime/src/infrastructure/file-journal-state.ts) | SQLite는 한 요청을 BEGIN IMMEDIATE 안에서 저장한다. journal은 한 work revision을 배타 게시하고, 게시 후 오류는 journal_commit_unknown으로 반환한다. 둘 다 최초 command receipt를 보존한다. | backend별 우회 트랜잭션을 만들지 않고 동일한 단계별 재시도 계약을 사용한다. 성공 응답을 잃어도 새 grant ID로 다시 발급하지 않는다. |
| [ExecutionRuntime.reserve/dispatch](../../runtime/src/application/execution-runtime.ts) | reserve에서 reservedToolCalls 증가, dispatch에서 이를 감소시키고 used.toolCalls 증가. 실제 도구 진입은 그 뒤이다. | 부모 가용액과 자식 cap을 예약·dispatch 경계에서 검사한다. dispatch 뒤 도구가 실행되지 않은 경우도 기존 논리 호출 계수를 임의 환불하지 않는다. |
| [ToolBroker.invoke](../../runtime/src/application/tool-broker.ts) | dispatch receipt, 현재 work/lease/policy/contract, 비동기 knowledge/reuse 검사 이후 최신 revision을 확인하고 실제 entry로 진입한다. | 마지막 부모 grant 검사도 reuse/source 검사 이후까지 유지한다. child allocation fence와 현재 deadline을 재검사한다. |
| [PlanningRuntime.reserve/execute](../../runtime/src/application/planning-runtime.ts) | 입력 artifact 저장 전후 비동기 검사를 거쳐 모델 호출 수와 토큰을 함께 예약한다. execute는 입력·출처를 읽고 최종 상태 확인 후 planner.propose에 진입한다. | context 준비 중 revoke/축소가 일어나도 오래된 grant로 예약 성공을 반환하거나 model transport에 진입하지 않도록 검사한다. |
| [PlanningRuntime.receive/recover](../../runtime/src/application/planning-runtime.ts) | 실행 중 lease 만료는 usage unknown과 tokenReservation을 유지한다. 취소·만료 후 늦은 응답도 비용을 한 번 정산하며 오래된 계획은 채택하지 않는다. | grant가 revoke되었다는 이유로 receive/recover를 차단하지 않는다. 새 배정 차단과 기존 비용 정산을 분리한다. |
| [applyValidatedPlan](../../runtime/src/application/plan-validator.ts) | 계획이 교체되면 used.replans가 증가한다. | 위임 한도에 replans가 포함되면 모델 예약뿐 아니라 수동 submitPlan과 모델 계획 채택의 증가 경계도 제한한다. |
| [commitWithArtifacts](../../runtime/src/application/commit-artifacts.ts) | 현재 work의 필수 원본 참조를 검증한 뒤 상태 커밋을 호출한다. | 관련 없는 원본 유실로 중단/정산 커밋이 실패할 수 있다. 실패를 비용 0이나 escrow 반환으로 바꾸지 말고 보류 상태를 유지한다. |

## 권고하는 최소 프로토콜

1. **부모에 먼저 발행한다.** 안정적인 grant ID, child work ID, command ID/digest를 정하고 부모 CAS에서 전체 자식 한도를 earmark한다. 같은 부모의 직접 예약과 다른 자식 grant 발행이 모두 같은 가용액 계산을 사용해야 한다. 한 차원이라도 부족하면 아무 차원도 부분 발행하지 않는다.
2. **자식의 최초 저장에 link를 포함한다.** grant를 확인한 뒤 새로운 자식 WorkState의 genesis CAS에 parent/grant identity와 고정 한도를 함께 저장한다. 독립 예산으로 이미 실행된 기존 work의 후부착은 첫 단위에서 거부하는 편이 단순하다. grant 없는 임시 runnable child를 먼저 만들지 않는다. link를 지우거나 다른 부모에 연결해 사용량을 초기화할 수 없어야 한다.
3. **새 배정과 실제 진입을 모두 검사한다.** 자식의 로컬 사용/예약, grant 한도·상태, 부모/자식 identity와 기한을 검사한다. 각 호출에 그 배정을 승인한 grant identity를 남겨 재시작 후에도 연결을 확인한다. tool reserve/dispatch/broker entry, model reserve/dispatch/propose 직전이 대상이다. 비동기 artifact/source/reuse 조회 전에 한 검사만으로 대체하지 않는다.
4. **revoke는 drain 시작으로 저장한다.** 부모에 draining을 커밋해 새 승인을 거부한 뒤 자식 CAS에 영속 allocation fence를 설치한다. 기존 자식의 stale reserve는 이 fence와 CAS로 충돌하거나 최신 edit에서 거부되어야 한다. 자식 fence 이후 새 예약을 허용하는 resume/goal/mode 우회도 거부한다. 부모 revoke 요청만 저장한 상태와 중단 완료를 구별한다.
5. **이미 배정한 비용을 정산한다.** 미전송 예약은 기존 취소/회복 절차로 해제할 수 있다. running/received, model usage unknown, write reconciliation 의무는 보존한다. 늦은 receive/recover/adopt와 정산 조회는 허용하되 새로운 호출을 만들지 않는다. 단순 cancelled/completed 상태나 lease 만료를 drain 완료 증거로 사용하지 않는다.
6. **부모에서 한 번 정산한다.** 자식의 fence와 usage를 특정 revision/receipt/digest로 고정하고 부모 CAS에 정산한다. 같은 영수증 재처리는 추가 차감·추가 환불을 만들지 않는다. 부모 정산 성공 후 자식 ACK를 잃어도 부모 영수증으로 복구한다. 불명 사용량이 남으면 가장 작은 초기 구현은 grant 전액 보류를 유지하는 것이다. 부분 반환을 구현한다면 알려진 비용과 불명 보류액, 이미 반환한 액수를 별도로 보존하고 후속 정산은 단조로운 delta만 적용한다.

부모 조회 직후 revoke, 자식 CAS 직전 같은 교차 work 구간을 완전히 없애려면 저장소의 다중 work 커밋 또는 부모에 호출별 승인 intent를 먼저 쓰는 더 큰 프로토콜이 필요하다. 이번 단위에서는 **전액 escrow를 유지한 채 자식 fence를 세운 뒤 정산**하는 방식으로 과소계상을 막는 것이 최소안이다. 마지막 조회 이후 즉시 revoke와 실제 함수 진입 사이의 전역 원자성을 주장하지 않는다. 중단 완료는 부모 요청 접수 시각이 아니라 fence/drain 확인으로 정의한다.

## 반드시 결정할 회계·권한 조건

### 가용액 계산과 비용 단위

부모가 직접 쓴 비용과 자식에게 위임한 비용을 구분한다. 각 additive 차원의 가용액은 `limit - localUsed - localReserved - outstandingEscrow - settledDelegatedCharge`로 계산할 수 있다. 실제 저장 필드 이름은 구현의 정본 layout을 따른다. active grant의 자식 사용량을 관측했다고 전액 escrow에 다시 더하면 이중 차감이고, active grant를 줄이면서 해당 사용량을 부모 사용액에 반영하지 않으면 과소계상이다.

예를 들어 부모 tool 한도 10, 직접 사용 2, 자식 grant 5이면 자식이 그중 3을 사용했어도 정산 전 가용액은 3이다. 자식을 fence/drain하고 3을 정산하면 escrow 5를 제거하고 delegated charge 3을 남겨 가용액이 5가 된다. 같은 정산을 재실행해도 5다.

- toolCalls는 현재 **논리 dispatch 수**이다. reused 또는 최종 gate에서 not_invoked였어도 dispatch 후 used.toolCalls는 남는다. 페이지 안의 실제 transport 횟수와 별개다. 이번 grant가 transport/API 비용을 제한하는 계약까지 제공한다고 주장하지 않는다.
- modelCalls는 dispatch에서 소비하며 tokens는 input estimate와 maxOutputTokens로 예약한다. `receive`는 보고 토큰이 예약보다 커도 실제 합계를 보존한다. 따라서 estimate 기반 escrow가 외부 제공자의 실제 청구액 상한을 보장하지 않는다. 초과 보고는 clamp하거나 버리지 말고 초과 채무를 기록하고 새 배정을 막는다.
- 토큰의 한쪽 값만 알려지면 현재 receive는 알려진 양을 used.tokens에 반영하면서 전체 예약과 unmeasuredModelCalls를 남긴다. 이 보수적인 보류를 정산 과정에서 사용량 0이나 확정 잔여액으로 해석하지 않는다.
- wallTimeMs는 병렬 자식들의 경과 시간을 단순 합산하는 차원으로 만들지 않는다. 자식/grant deadlineAt을 부모의 고정 deadlineAt 이하로 저장하고 lease도 그 이내로 제한한다. 생성·resume·모드/목표 변경으로 부모의 남은 시간을 재발급하지 않는다.
- 부모 한도 하향이 현재 확정 사용+예약+escrow보다 작아져도 기존 값을 잘라 맞추지 않는다. 남은 가용액을 0으로 보고 새 배정을 막고 drain한다. 기존 알려진 사용액이나 unknown을 초기화하지 않는다.
- 첫 단위에서 손자 위임을 지원하지 않으면 명시적으로 거부한다. 지원한다면 자식의 outstanding escrow도 drain 정산에 포함해 부모가 손자의 미확정 비용을 놓치지 않아야 한다.

### 실패와 고아 grant

부모 발행 ACK 유실, child genesis ACK 유실, 부모 정산 ACK 유실은 각 단계의 같은 command ID/digest로 복구한다. journal_commit_unknown은 실패한 단계의 효과가 없다는 뜻이 아니다. 저장소 읽기 실패·identity mismatch·원본 유실 시 새 실행과 환불을 거부하며, 이미 보류한 액수는 유지한다.

부모 grant는 있지만 자식이 없는 경우도 타이머만으로 반환하면 안 된다. 지연된 생성자가 과거 grant를 읽고 나중에 child를 만들 수 있기 때문이다. revoke를 먼저 고정하고 자식이 생성되더라도 현재 grant/fence 검사에서 실행하지 못하도록 해야 한다. 생성과 revoke가 경합하면 child link를 가진 중단 상태 또는 명시적인 미생성 상태 중 하나로 수렴시키되, 부모 예산을 두 번 가용화하지 않는다.

### 주체와 데이터 격리

첫 단위는 **같은 tenant/principal, 부모보다 좁은 child policy**로 시작하는 것을 권고한다. allowedTools/labels/destinations는 부모의 부분집합, allowWrites는 부모가 허용한 경우에만 허용한다. link/grant는 부모·자식 work ID, tenant/principal, 발행 당시 goal/policy identity와 고정 한도·기한을 묶는다. 현재 정책 철회·목표 변경의 영향을 검사하되, 변화가 과거 사용량·unknown을 지우지 않는다.

executor의 `owner` 문자열은 lease 소유자이며 사용자 권한 증명이 아니다. 현재 reserve/dispatch는 actor를 받지 않는 신뢰된 내부 API이다. child principal/capability를 별도로 발급하려면 WorkResources, knowledge actor와 policy 검증까지 연결해야 하므로 문자열 변경만으로 격리를 완료했다고 할 수 없다. 이번 단계에서는 grant ID를 bearer capability로 쓰지 않고, 신뢰된 호출 경계에서만 생성·연결하며 child의 실행 owner를 별도 식별할 수 있다.

부모에 전달할 내용은 grant/child ID, 사용·예약·unknown 집계, fence/정산 영수증과 상태 이유로 제한한다. 자식 evidence/body/artifact를 부모의 evidence 목록에 자동 복제하지 않는다. 자식 완료는 부모 완료의 증거가 아니며, 부모의 완료 판단은 기존의 독립 근거·원출처 계약을 통과해야 한다.

## 두 영속 backend의 필요한 시험행렬

아래 모든 항목은 SQLite와 file-journal에서 같은 application/runtime API로 실행한다. 명시한 crash 구간은 별도 프로세스 종료·재개를 포함한다. fake clock과 synthetic tool/planner를 쓰며, ledger 수치뿐 아니라 **실제 Tool.execute / Planner.propose 진입 수와 dispatch·settlement 영수증**을 함께 단언한다. 아래는 시험 계획이며 이번 검토에서 실행하지 않았다.

| ID | 정상·장애·경합 입력 | 필수 단언 |
| --- | --- | --- |
| BG-01 | 부모에 충분한 한도, 자식에 축소한 tool/model/tokens/replans grant; 실제 자식 source 및 planner 실행 | 부모의 직접 가용액이 발행 즉시 전액 감소한다. 자식이 실제 호출을 하고 집계가 정산된다. 도구와 모델 경계를 각각 확인한다. |
| BG-02 | 같은 부모에서 두 child grant + 직접 tool/model 예약을 경합 | 한도 내 winner만 커밋한다. 일부 예산 차원만 차감된 grant가 없다. loser의 물리 호출 0. |
| BG-03 | 동일 grant/child/command 재전송, 같은 command에 한도 또는 child ID 변경 | 동일 요청은 최초 영수증, 변경 요청은 idempotency conflict. grant/child/보류액 각각 한 번. |
| BG-04 | 부모 발행 커밋 직후 SIGKILL 또는 ACK 유실, child genesis 커밋 직후 같은 장애 | reopen 후 같은 단계 재개로 한 grant·한 link. 새 ID 발급 없음. 부모 단독 grant 상태에서 무담보 자식 실행 0. |
| BG-05 | 두 executor가 같은 자식의 마지막 tool 또는 model 잔여액을 동시 reserve/execute | 자식의 기존 단일 active attempt/model 규칙과 예산 상한 유지. 하나의 dispatch/진입만 발생. |
| BG-06 | 부모 grant 조회를 지연하고 revoke를 먼저 저장한 뒤 child reserve CAS 재개 | 늦은 child 예약이 fence와 충돌하거나 후속 gate에서 실행 차단. 부모는 drain 전 환불하지 않는다. 부모 revoke 접수와 완료를 구별한다. |
| BG-07 | 모델 context/artifact put 중 revoke, tool reuse 조회 중 revoke, model source 조회 중 revoke | 오래된 grant로 성공 예약을 반환하거나 실제 entry에 진입하지 않는다. 이미 저장된 미전송 예약은 명시 취소·회복된다. orphan derived artifact는 예산 환불 근거가 아니다. |
| BG-08 | revoke parent CAS 뒤, child fence CAS 뒤 각각 SIGKILL | reopen 후 draining 유지, 새 배정 0. fence는 resume/mode/goal 변경으로 사라지지 않는다. drain/정산은 계속 가능하다. |
| BG-09 | reserved 상태와 running 상태에서 자식 cancel/lease 만료; read/write/model 각각 | 미전송 예약만 기존 규칙대로 해제. dispatched 논리 호출은 보존. running model 토큰 unknown과 write reconciliation 의무 유지. 자동 재전송 0. |
| BG-10 | revoke 후 늦은 모델 응답 또는 tool 결과 도착; 같은 응답 중복 전송 | 비용은 한 번 정산한다. 만료·취소된 계획/결과는 기존 채택 규칙을 유지한다. grant 거부 때문에 receive/recover 자체가 사라지지 않는다. |
| BG-11 | 모델 usage 전부 누락, 한쪽만 보고, 예약보다 큰 확정 보고 | unknown 보류 유지, 알려진 비용 보존, 초과분 clamp/은폐 없음. reopen 후에도 새 할당 차단과 부모 채무가 유지된다. |
| BG-12 | child drain 이후 parent settlement 커밋 전/후 장애 및 중복 settlement | commit 전에는 escrow 유지. commit 후 ACK 유실은 최초 영수증으로 수렴. 반환액과 delegated charge를 중복 반영하지 않는다. |
| BG-13 | 부모 settlement가 읽은 child usage revision과 늦은 receive가 경합 | 오래된 작은 사용량으로 반환하지 않는다. 미확정 보류가 유지되거나 최신 pinned snapshot으로 재시도한다. 후속 정산은 단조로운 차이만 적용한다. |
| BG-14 | 부모 한도 하향·deadline 도달·mode 변경; 자식 재개/목표 변경 | 보유 grant가 한도 확장이나 시간 재설정 수단이 되지 않는다. 기존 used/reserved/unknown은 보존하고 새 배정만 막는다. |
| BG-15 | foreign tenant/principal, 넓어진 labels/destinations/writes, 다른 child/grant, 사전 사용 child, link 제거·재부착 | 거부 후 부모·자식 예산 불변 및 진입 0. link가 없다는 이유로 기존 delegated child를 독립 신규 예산으로 실행하지 않는다. |
| BG-16 | 부모 get/receipt 오류, 자식 receipt 손실/손상, 필수 원본 유실로 commit 실패 | 불확실한 상태에서 execute/환불하지 않는다. outstanding escrow와 unknown은 보존한다. 복구 성공과 임시 실패를 구별한다. |
| BG-17 | 새 배정이 막힌 child에 저장된 result/model reply 또는 unknown write 의무가 존재 | receive/adopt/recover/정산이 allocation gate보다 우선한다. 완료 가능한 저장 결과를 사용하되 새로운 호출·거짓 완료 없음. |
| BG-18 | child가 근거를 얻고 완료; 부모는 필요한 독립 근거가 없음; 상태 조회·재시작·compact 반복 | 부모 evidence/원출처 목록 자동 복제 0, 부모 거짓 완료 0. 읽기/replay의 물리 호출 0. 원장·기한·grant identity는 그대로다. |

기존 [state-conformance.test.ts](../../runtime/src/tests/state-conformance.test.ts)의 별도 프로세스 CAS·중복·ACK 뒤 SIGKILL, [model-boundaries.test.ts](../../runtime/src/tests/model-boundaries.test.ts)의 취소/late usage/unknown, [workflow-crash.test.ts](../../runtime/src/tests/workflow-crash.test.ts)의 실제 재시작 harness를 재사용할 수 있다. 이 기존 시험이 부모/자식 grant를 실행한 것은 아니므로 새로운 행렬의 통과 근거로 집계하지 않는다.

## 이번 검토 기록

- 수행: 위 application/domain/두 영속 adapter와 관련 시험의 읽기 검토, 본 문서 작성.
- 미수행: 소스·fixture·dist 변경, build/typecheck/test, 실제 모델/API/사내 서비스 실행.
- 결론 범위: 단계별 escrow/fence/drain 설계와 필요한 회귀 조건을 제안했다. root가 병행 작성하는 최종 budget layout 및 실제 runtime hook 구현의 검증 결과는 이후 별도 실행 기록으로 판정한다.
