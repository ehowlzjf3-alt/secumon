# C08 순차 검증 준비 — 동료·반론·자원

2026-09-08 · checkpoint377에서 C07 검증과 별도로 준비했다. **제품 구현과 기존 시험을 읽은 검증 준비이며, 이번 문서 작성 중 빌드·시험·모델·외부 연결은 실행하지 않았다.** C08 통과 수나 완료 판정을 만들지 않는다. 요구는 [C08 계획](C08-integration-plan.md), [직접 동료·분리 원장 구현](C08-direct-peers-progress.md), [V08-01~06](C06-C10-verification-plan.md#c08)을 따른다.

## 현재 연결과 증거의 범위

[일반 프로필](../../runtime/src/presentation/agent-turn-profile.ts)은 `features.peers === true`일 때 등록을 요구하고 peer 도구·예산 도구를 조립한다. [host-peers](../../runtime/src/presentation/host-peers.ts)는 등록 메서드와 모델/역할 identity를 고정하고, `createRuntimePeerAgent`는 수신자의 기존 SessionService·WorkflowRuntime을 사용한다. 상주 consult는 발신 담당별 세션, review와 temporary는 요청별 세션이다. 내부 route는 `peer/local`이고 consult는 수신자 자체 예산을 사용한다.

[PeerAgents](../../runtime/src/application/peer-agents.ts)는 원 요청·수락 ticket·응답을 각각 artifact와 command 영수증으로 보관한다. review 응답은 [strict 반론 계약](../../runtime/src/application/peer-contracts.ts)을 검사하고 `hypothesisAssessment`를 무효화하여 기존 재평가 경로로 넘긴다. 이때 `evidence:[]`, `coverage:unknown`을 유지한다. 반론 수신만으로 판별 작업이나 독립 근거가 생성되는 것은 아니다.

[HostBudgetLedgerRouter](../../runtime/src/application/budget-work-ledgers.ts)는 명시 `{tenantId, principalId, scope}`별 원장을 연결한다. [예산 도구](../../runtime/src/application/budget-tools.ts)의 `recipientId`는 호스트가 등록한 정책·원장을 선택하며, 일반 저장소나 개인 기억을 합치지 않는다. 기존 같은 저장소의 [BudgetRuntimeRouter](../../runtime/src/application/budget-runtime-router.ts)와 구분한다.

[기존 P4 결과](P4-budget-authority-result.md)는 당시 소스의 검증 기록이다. 현재 C08의 직접 동료·분리 DB 원장·모델 예산 도구가 그 시험에서 확인됐다는 뜻은 아니다. 현재 `src/tests`의 해당 peer/host-peers/budget-work-ledgers/budget-tools 직접 참조 검색에서는 전용 연결 시험을 찾지 못했다. 구현 노트의 작성 당시 미빌드 문장은 [후속 통합 빌드 기록](C06-C10-implementation-result.md)과 구분하며, 빌드 통과를 동작 인수로 승격하지 않는다.

## 재사용할 기존 시험

| 기존 파일 | 이미 있는 판정·주입점 | C08에서 보완할 연결 |
|---|---|---|
| [budget-delegation.test.ts](../../runtime/src/tests/budget-delegation.test.ts) | 차원별 사용량·escrow·unknown·중복 grant·strict mandate | 원장 계산을 새로 시험 구현하지 않는다. 새 주소/도구 연결이 실제 이 계산을 사용하는지 확인한다. |
| [budget-delegation-runtime.test.ts](../../runtime/src/tests/budget-delegation-runtime.test.ts) | SQLite/file-journal, 실제 reserve/dispatch/adopt, 배정/실행 권한 분리, 취소·늦은 usage·중첩 정산·등록 철회·compact/reopen | `fundedRole`은 같은 StateRepository와 기존 router를 사용한다. 분리 저장소의 `HostBudgetLedgerRouter` 인수를 대신하지 않는다. |
| [budget-delegation-crash.test.ts](../../runtime/src/tests/budget-delegation-crash.test.ts) / [worker](../../runtime/src/tests/budget-delegation-crash-worker.ts) | 실제 자식 프로세스·SIGKILL, genesis/grant/activation 및 draining/fence/settlement 뒤 동일 grant 재개, 추가 호출·중복 정산 없음 | 새 분리 원장 경계에 필요한 중단 지점만 확장 후보로 둔다. 기존 모든 장애 조합을 복제하지 않는다. |
| [complex-agent-turn.test.ts](../../runtime/src/tests/complex-agent-turn.test.ts) | 상충 근거 뒤 필요한 판별 읽기만 추가하고 현재 독립 근거로 답변 | 실제 peer review 응답을 이 앞에 연결하여 반론→재평가→판별 관측을 확인한다. |
| [session-context-runtime.test.ts](../../runtime/src/tests/session-context-runtime.test.ts), [session-compact-runtime.test.ts](../../runtime/src/tests/session-compact-runtime.test.ts), [sqlite-sessions.test.ts](../../runtime/src/tests/sqlite-sessions.test.ts) | 세션 원문/ID, 업무별 독립 상태, compact 복구, 전달·세션 영수증 원자성/중복 거절 | 수신자 `peer` route와 resident/temporary 수명을 선택적으로 추가한다. 기존 CLI route 시험은 peer 전달 인수로 세지 않는다. |
| [host-tool-entry-fixture.ts](../../runtime/src/tests/host-tool-entry-fixture.ts), [agent-deployment-entry-fixture.ts](../../runtime/src/tests/agent-deployment-entry-fixture.ts) | 유한 구조화 모델 대역, 실제 임시 담당·registry·일반 CLI/HTTP·두 배치 분리 | 신규 peer 배치를 조립할 재료다. 기존 fixture가 peer 반론을 생성하거나 자원 도구를 선택한다고 가정하지 않는다. |

## 실제 미검증 연결과 최소 인수 묶음

| 요구 | 새 연결에서 확인할 관측 |
|---|---|
| V08-01 직접 동료·역할 | 게시판 없이 A→B와 B→A를 같은 엔진에서 실행한다. 상주 consult는 발신자별 세션을 이어가고, review/temporary는 다른 요청과 문맥을 분리한다. 동일 consult 재전달과 `core.peer.resume`은 원 request/ticket/work 및 최초 예산을 유지한다. consult에 budget grant를 강제하지 않는다. |
| V08-02 등록·권한 분리 | `peers` off이면 factory/peer·budget 도구 진입 없이 일반 세션 사용, on+미등록이면 명확한 오류. 등록의 명시 도구 목록, peer 목적지/labels, tenant·담당·모델 revision, close/취소 후 새 호출 거절을 실제 profile에서 확인한다. 배정 승인만 있고 실행 승인이 없으면 원장은 준비되지만 모델/도구 호출은 0이다. |
| V08-03 반론→후속 관측 | 수신자의 실제 구조화 응답에 대상 version·대안·근거 참조 또는 없음·판별 질문·영향·모델 identity가 남아야 한다. malformed/옛 대상/타 담당 근거 참조는 거절한다. 유효 응답 뒤 호출자 재평가와 필요한 판별 task를 실행하되, 같은 모델의 동의·반론 text·수신자 Evidence ID를 호출자 독립 근거로 승격하지 않는다. |
| V08-04 분리 원장·모델 도구 | 동일 principal/다른 scope의 두 실제 임시 저장소에 등록하고 `status→allocate(recipientId)→run→request/increase→return 또는 revoke/reconcile`의 실제 명령을 사용한다. 원 policy/owner 주소, 부모 hard limit, 원 artifact 존재 확인, 정확한 한 번 정산을 검사한다. 수신자 원문·기억이 후원자 결과에 섞이지 않아야 한다. 등록 제거·교체·권한 철회·미확정 효과/usage는 새 실행과 반환을 각각 제한하고, 동일 주소 재등록 뒤 원 grant로 재개한다. |
| V08-05 compact·재접속·수명 | 위 동일 시나리오에 compact/reopen을 한 번 끼워 원 요청/답변·장부·원문 참조를 다시 검사한다. wait→resume와 취소 중 늦은 답변은 새 목표 근거로 채택하지 않는다. 임시 업무 종료/자원 반환 후 상주 수신자 세션은 다음 요청을 받아야 한다. peer 요청·ticket·응답 게시 사이 중단 복구는 기존 budget crash 통과와 별도로 기록한다. |
| V08-06 내부 전달 | [SQLite LocalChannel](../../runtime/src/infrastructure/local-channel.ts)의 실제 `peer/local` 답변을 원 수신자 세션·전달 영수증·중복 lookup으로 확인한다. 다른 담당/세션은 읽기·추가 기록 거절, 외부 사람 채널 발신은 0이어야 한다. [PostgreSQL channel](../../runtime/src/infrastructure/postgres-channel.ts)의 동일 경로는 실제 DB 환경 인수로 별도 유지한다. |

준비·배정·실행·응답 수신·채택·정산은 각각 관측한다. “동료가 답했다”를 호출자 목표 완료나 사용량 완전 확정으로 치환하지 않는다. source/goal/policy 변경 후 본문 채택 거절과 이미 발생한 usage 보존도 분리한다.

## 실행 순서와 남길 한계

먼저 기존 예산 3개 파일을 현재 동결 소스의 기준선으로 선택한다. 이어서 **등록/직접 peer·반론, 분리 원장/예산 도구, 일반 재접속/내부 전달**의 새 연결만 작성한다. 기존 위임 알고리즘·전체 모델/세션 회귀를 재구현하거나 전부 반복하지 않는다. 새 사례가 기존 경계를 변경하거나 실제 실패를 드러낸 경우에만 관련 선택을 넓힌다. 모든 writer 동결 뒤 root가 빌드와 선택 실행을 묶고, 실행별 source/build·명령·원로그·terminal exit·고유 사례/재실행을 구분해 기록한다.

로컬 인수는 임시 디렉터리와 임시 host registry, 실제 저장소, 유한 구조화 모델 대역으로 먼저 수행할 수 있다. callback 장애·ACK 유실 주입은 실제 OS 종료와 구분하고, worker·IPC·timer·대기 gate는 상한과 finally 정리를 둔다. C07 공유 자료/아카이브 기능을 peer의 필수 전제로 추가하지 않는다.

**실제 모델/API 시험 중단은 유지한다.** 실제 독립 반론의 의미 판단·단독 대비 품질/비용·사내 모델/외부 peer 통신, 현재 Linux/native Windows 및 PostgreSQL 환경 인수는 미완료다. 로컬에서 검증 가능한 연결은 외부 환경 부재를 이유로 미루지 않는다. [협업 비교기](../../runtime/src/application/collaboration-evaluation.ts)의 합성 계측과 C09 성능 비교는 실제 모델 품질 입증으로 합산하지 않으며, 전체 C08/최종 통합 완료는 별도 판정한다.
