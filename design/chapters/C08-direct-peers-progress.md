# C08 직접 동료·임시 역할·반론 연결 진행

2026-09-08. 기능 구현을 먼저 이어가고 상세 검증은 별도 단계로 남긴다. 기존 P4의 역할·비용 부담·자료 접근·모델 위치 분리 원칙과 C08 범위를 적용한다. 게시판과 고정 리드/워커를 필수 조건으로 만들지 않는다.

## 작성한 실행 경로

[peer-contracts.ts](../../runtime/src/application/peer-contracts.ts)는 동료 identity/역할/모델, 요청·수락 ticket·응답 및 구조화 반론 계약이다. [peer-agents.ts](../../runtime/src/application/peer-agents.ts)의 `createPeerTools(services, peers, agentId)`는 `core.peer.consult`와 `core.peer.resume`을 제공한다. consult는 등록된 이름으로 요청하고 resume는 기존 requestId의 수신자 업무를 계속 실행한다. 요청·수락·응답은 기존 원문 저장소와 업무 트랜잭션 영수증을 사용한다. 저장 파일을 검색해 영수증을 만들지 않는다. 현재 구현은 해당 command의 기존 이벤트를 조회하므로 긴 업무 이력의 조회 비용 최적화는 후속이다.

[host-peers.ts](../../runtime/src/presentation/host-peers.ts)의 `HostPeerRegistration.open(context)`는 `peers`, 명시 `allowedTools`, `close`를 반환한다. `openRegisteredHostPeers`는 최대 16개 등록과 메서드·메타데이터를 캡처하고 close를 한 번만 실행한다. config의 선택값과 profile/compose 연결은 root 소유다. 게시판 flag로 동료 기능을 켜지 않는다.

`createRuntimePeerAgent({agentId,revision,role,scope,policy,limits,sessions,workflow,maxSteps?})`는 이미 열린 동일 범용 엔진의 SessionService와 WorkflowRuntime을 사용한다. 새 모델/DB/실행 루프를 만들지 않는다. `policy.allowWrites:false`인 자체 자원 업무만 이 consult 경로로 수행하며, 명시 자원 위임은 기존 BudgetDelegationService의 별도 경로다. 호출자 메모리나 개인 저장소를 수신자로 복사하지 않는다.

일반 상주 consult는 발신 담당별 지속 세션을, review와 temporary 역할은 요청별 별도 세션을 사용한다. 재전송은 최초 수신 payload의 예산을 유지한다. 수신자는 `channel:'peer'`, `destination:'local'`의 내부 route를 사용한다. 이 route는 호스트가 내부 sink로 연결해야 하며 사람 채널을 자동 선택하지 않는다. 역할의 업무가 끝나도 상주 담당의 세션이나 저장소를 닫지 않는다. profile 종료 시 호스트가 자신이 소유한 자원의 close를 수행한다.

## 반론과 근거의 구분

review는 현재 hypothesis ID를 명시하고 대상 의미의 version, 원 목표/계획 revision, peer agent/revision/role 및 모델 identity를 남긴다. 응답 JSON에는 대상·대안·근거 참조 또는 근거 없음·판별 질문·영향이 필수다. 기본 수신자 factory는 참조가 수신자의 현재 접근 가능한 근거에 속하는지 검사한다. 이 참조는 호출자의 Evidence ID가 아니다.

응답은 `peer_assessment_not_independent_evidence`, `evidence:[]`, `coverage:'unknown'`으로 반환한다. 같은 모델의 여러 응답을 독립 증거로 세지 않는다. 유효한 반론 답변을 받으면 기존 `hypothesisAssessment`를 무효화해 다음 assess/replan 경로가 재평가하도록 한다. 가설의 claim/status/support/counter, 새 판별 작업 및 최종 완료 판단은 기존 모델 제안과 PlanValidator가 처리한다. 반론을 받은 것 자체로 근거·가설·목표 완료를 자동 승격하지 않는다.

## 구현과 검증 상태

위 세 제품 파일을 작성했고 root가 peer 채널 및 profile/compose를 조립한다. 작성 중 root의 첫 빌드는 unused import 2개를 지적했고 이를 제거했다. 이 담당은 빌드·시험·네트워크·모델을 실행하지 않았다. 통합 동작이나 실제 독립 검토 품질의 검증 완료를 뜻하지 않는다.

별도 인수에는 A→B/B→A, resident/temporary 세션 수명, 반론 후 판별 계획, 권한·목표·등록 revision 변경, 중복 수신/재개, 부모 취소 중 수신자 호출, 내부 sink와 사람 채널 분리, 수신자 질문/대기 및 장기 미응답을 포함한다. 수신자의 기존 업무 정산을 사용하지만 교차 프로세스 중단·늦은 usage·동료 응답 복구의 상세 인수는 미실행이다. 자동 알림/상시 재개는 C09와 연결한다. 모델·사내서비스 실제 시험은 중단 상태다.

직접 consult는 수신자 자체 자원을 사용한다. 다른 담당 DB에 대한 명시 후원은 아래 별도 원장 등록 경로로 구현했으며, 상세 장애 인수는 아직 실행하지 않았다.

## 분리된 예산 원장 구현

`PeerAgents.assertRequest`는 도구 자체의 `local` 목적지 외에도 실제 peer의 목적지가 호출 업무의 `allowedDestinations`에 포함되는지 검사한다. custom host의 별도 목적지는 등록만으로 허용되지 않는다.

[budget-work-ledgers.ts](../../runtime/src/application/budget-work-ledgers.ts)의 `HostBudgetLedgerRouter`를 작성했다. 한 프로세스 안에서 호스트가 `{tenantId, principalId, scope}`별 실제 담당 원장을 명시 등록한다. 동일 principal의 서로 다른 담당도 scope로 구분한다. 재시작할 때 동일 주소로 실제 원장을 다시 등록해야 하며 원장이 없으면 다른 DB를 검색하지 않는다.

- `register(owner, {services, run(workId,maxSteps,signal), interrupt(workId)})`는 등록 해제 함수를 반환한다. run은 해당 담당의 기존 WorkflowRuntime을 호출한다. 호스트가 실제 runtime을 열고 닫으며 라우터는 저장소를 소유하거나 대신 닫지 않는다.
- `registerRecipient(id, {owner, policy, revision, approve})`는 모델이 선택할 이름과 고정 정책을 등록한다. `approve(binding,purpose,signal?,invocation?)`는 `allocation`과 `execution`을 구분한다. 배정 승인이 실행 승인을 대신하지 않는다.
- 양쪽 프로필은 같은 `host.budget.ledgers`를 전달한다. 일반 `services.state`, 원문, 세션, 메모리는 합치지 않는다. 예산용 포트는 원 소유자의 get/receipt/commit과 artifacts.exists만 수행하며 일반 목록·원문 읽기·닫기는 거절한다. 동일 주소 등록 교체 뒤 이전 runtime의 저장소가 계속 지출하는 경우도 거절한다.

[BudgetParent/BudgetGrant](../../runtime/src/domain/budget-delegation.ts)에 선택 `parentAddress`/`childAddress`를 저장한다. 주소가 없는 과거 같은 저장소 경로는 유지한다. [BudgetDelegationService](../../runtime/src/application/budget-delegation.ts)는 기존 pending → 부모 escrow → 자식 activation과 command 영수증을 재사용하고, 주소가 있는 링크의 배정·상위 권한 검사·증액·회수·반환·중첩 정산은 각 원 소유 원장에 수행한다. 예산 트랜잭션의 원문 존재 확인도 그 원장의 artifacts에서 처리한다. 사용량이 불확정이거나 원장이 닫혔다는 이유로 보류 자원을 반환하지 않는다.

[budget-tools.ts](../../runtime/src/application/budget-tools.ts)의 `core.budget.allocate`는 선택 `recipientId`를 받는다. 생략하면 기존 같은 담당 임시 업무이고, 지정하면 등록된 정책과 scope로 업무를 만든다. 모델이 수신자 정책·승인 callback·원장 주소를 입력하지 않는다. `core.budget.status`가 선택 가능한 이름을 표시하며 `core.budget.run`은 등록된 수신자 엔진을 실행한다. 수신자의 checkpoint·근거·개인 문맥을 후원자에게 넘기지 않고 상태/revision과 장부 수치만 반환한다. 분리 담당의 추가 자원 요청도 숫자 extra와 requestId만 노출하고 자유문장 reason은 원 담당 업무에 남긴다.

구현 파일을 작성했으며 이번 분리 원장 연결의 빌드/시험은 root 통합 전이다. 상세 인수에는 같은 principal/다른 scope의 두 실제 저장소, 배정 후 중단·재등록·동일 명령 재전송, 명시 승인 철회, 원장 교체/닫힘, 실행 취소/늦은 usage, 중첩 배정·증액·회수·중복 정산을 포함한다. 새 분산 프로토콜, 네트워크 원장, 저장소 검색, 자동 권한 발급은 지원 범위가 아니다.
