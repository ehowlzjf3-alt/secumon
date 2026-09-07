# C05 완전한 collection의 모델 재개 선택지 검토

2026-09-07 · **구현 확정 전의 최소 변경 제안이다.** [계획·제어 검토](C05-mcp-collections-planning-review.md)와 [선행 복구 검토](C05-mcp-collections-recovery-review.md)를 현재 compiler·schema·주턴·저장 증명 코드에 대조했다. 작성 시 선행 offline 단위의 native attempt 2는 진행 중이다. 이 문서는 제품·시험·기존 문서나 SSH를 변경·실행하지 않았으며, 아래 collection 연결의 통과를 주장하지 않는다.

권고는 기존 `readCollections` 항목의 선택적 `resumeMode: 'stored_complete'`를 **정본 메타데이터와 구분하여 검증**하는 것이다. 뜻은 “이 head의 완전한 저장 수집물을 소비하는 명시 successor를 제안할 수 있음”이다. online/stored-only 여부, 실행 허가, 부모 시도의 성공 또는 사용자 목표 완료를 뜻하지 않는다. 새 ToolResult·TaskSpec·PlanProposal 형식은 필요하지 않다.

## 현재 비교를 그대로 둔 채 필드를 붙이면 깨지는 곳

[domain/context.ts](../../runtime/src/domain/context.ts)의 `readCollectionContext`는 현재 goal/scope에서 보이는 후속 없는 tip을 `{attemptId, taskId, attemptStatus, progress}`로 만든다. 여기에는 원 head·진행 요약만 있으며 host availability를 읽지 않는다. 이 생산 함수와 WorkState의 `ReadProgress`는 그대로 유지한다.

[ContextCompiler](../../runtime/src/application/context-compiler.ts)의 `collectionContractsCurrent`와 `sourcesCurrent`는 모두 packet의 `readCollections` **전체**와 이 정본 목록을 digest로 비교한다. 따라서 packet에만 mode를 붙이면 정상 packet도 불일치한다. 반대로 정본 생산 함수에 availability를 섞으면 재접속만으로 저장된 요청·받은 응답의 출처 판단이 변한다. 두 비교 중 하나만 고쳐도 나머지 검사에서 거절된다.

최소 분리는 다음과 같다.

- [ContextPacketSchema](../../runtime/src/application/contracts.ts)의 항목에 `z.literal('stored_complete').optional()`만 추가한다. 알 수 없는 mode와 임의 추가 키는 기존 strict 검사가 거절한다. 기본값을 채우지 않아 mode 없는 구형 packet/frame의 해석과 직렬화를 유지한다.
- compiler 내부의 공통 투영에서 **허용한 mode 필드만** 분리하고, 나머지 네 필드와 progress 전체를 기존 정본 목록에 정확히 대조한다. 항목 삭제·추가·순서 변경·head/ref/phase 변경을 무시하는 필터로 바꾸지 않는다.
- mode가 실제 들어 있는 항목은 별도 조건을 검사한다. 동기 `collectionContractsCurrent`는 원 task/등록/현재 tip의 구조 관계를 확인하고, 비동기 `sourcesCurrent`는 이미 읽는 실제 checkpoint로 아래 조건을 확인한다. mode만 제거하고 통과시키는 구현은 불충분하다.
- mode **부재**는 이전 저장 입력과 호환된다. 새 compiler가 발급한 mode는 frontier task와 함께 필수 입력으로 보호한다. 현재 `protectedInput`에 `plan`과 `readCollections` 전체가 들어가므로 선택·축약 중 제거하지 않고, 저장 frame과 실제 모델 요청 bytes에 포함한다.

## marker를 발급하고 다시 확인할 정확한 관계

metadata의 `progress.phase === 'complete'`만 보고 선택지를 발급하지 않는다. 기존 [ReadCheckpoints.read](../../runtime/src/application/read-checkpoints.ts)의 원문·원 dispatch 검증이 성공한 결과와 현재 frontier를 사용한다.

1. 현재 goal/scope의 읽기 부모이며, terminal 상태·effectState none·후속 없음·현재 exact head이다. 이미 채택된 완전 부모, running/received 부모, 다른 목표나 자료 세대는 선택 대상이 아니다. received 결과는 기존 receive/adopt 선행 경로로 처리한다.
2. 실제 checkpoint가 complete이고 `collection.exhausted === true`이며 미정산 intent가 없다. 원 retryAt이 있다면 기존 시각 규칙을 만족한다. 과거 unknown call 이력이 있다고 이를 삭제하거나 확정 사용량으로 바꾸지는 않는다. 완결 여부는 기존 page replay와 원응답 검증으로 판단한다.
3. 같은 `taskId`의 원 query task가 **현재 frontier와 실제 packet.plan.tasks 양쪽에** 있다. `taskDigest(frontierTask) === parent.inputDigest` 및 `{toolId, toolVersion, input}`의 digest가 checkpoint.queryDigest와 같아야 한다. current plan의 이름이 같다는 사실만으로 통과시키지 않는다.
4. 현재 등록의 definition digest·collection 종류/한도·입력 schema·현재 policy가 원 checkpoint와 맞아야 한다. 원 parent/head/query/contract/권한 확인은 mode에서 생략할 수 없다.

`ReadCheckpoints.read`는 내부 `dispatch`에서 원 영수증의 task를 읽고, 그 taskDigest를 attempt.inputDigest에, query digest를 checkpoint에 이미 대조한다. 따라서 위 3번 때문에 dispatch 영수증이나 전체 문맥을 **한 번 더 읽을 필요는 없다.** 검증된 checkpoint와 이미 계산한 frontier task를 비교하면 된다. frontier에 원 task가 없다면 첫 연결 범위에서는 mode를 내보내지 않는다. 원 query를 요약에서 재구성하거나 과거 task를 현재 plan에 몰래 삽입하지 않는다.

모델은 새 task ID에 같은 toolId/version/input과 `readResume: {attemptId, checkpointId}`를 넣은 기존 PlanProposal을 제안한다. 부모 task ID를 재사용해 readResume를 추가하는 변경은 기존 `task_id_contract_changed`가 거절한다. fresh 조회, 다른 parent/head, 임의 새 query나 computerResume를 이 선택지로 허용하지 않는다. 의존관계·criteria·가설의 검증도 그대로다.

## 송신 선택과 받은 응답의 출처를 분리한다

[AgentTurnPrompt](../../runtime/src/infrastructure/agent-turn-prompt.ts)는 현재 active IDs와 제공된 도구 계약만 쓰도록 지시한다. 새 지침에는 “명시된 stored_complete 항목만 원 frontier task의 exact query를 사용하는 readResume 제안으로 선택할 수 있다”는 좁은 예외를 설명해야 한다. `options.tools`, `activeToolIds`, `policy.allowedTools`에 저장 전용 도구 전체를 복귀시키지 않는다. 이 목록의 active subset 의미도 바꾸지 않는다.

같은 mode는 online에서도 항상 **로컬 완전 수집물 소비**를 뜻한다. 연결이 생겼다는 이유로 successor가 일반 `Tool.execute`나 source `fetch`로 전환되어서는 안 된다. 모델의 marker는 실행 permit이 아니며, 실제 reserve/dispatch/소비는 root와 실행 담당이 마련할 현재 증명 기반 경계를 다시 통과해야 한다. 로컬 소비 실패 시 새 원격 조회로 fallback하지 않는다. 부모 failed/원 owner/기존 사용량은 그대로이고 기존 child 논리 toolCalls 1과 transport 0 의미를 유지한다.

가용성 전환은 세 경우를 나눠야 한다.

| 저장된 입력/응답 | 유지할 판단 |
|---|---|
| 저장 전용에서 만든 요청: 일반 options.tools에 해당 collection이 없고 mode만 있음 → online | 같은 원 parent/head/query가 유효하면 mode 자체는 유효하다. 저장 요청에 도구를 추가하거나 bytes를 다시 쓰지 않는다. |
| online에서 만든 요청: options.tools에도 해당 도구가 있음 → 전송 전 stored-only | mode가 유효해도 일반 목록의 callable 검사는 그대로다. 기존 outgoingDefinitionsCurrent가 미송신 요청을 취소할 수 있으며 이를 우회하지 않는다. |
| 이미 received인 응답 → availability만 변경 | 정본·등록 definition·원문은 재검증하지만 availability만으로 응답을 무효화하지 않는다. 반대로 원문 소실·head/query/정책 변경은 여전히 거절한다. |

[AgentTurnCalls.current](../../runtime/src/application/agent-turn-runtime.ts)는 `definitionsCurrent`와 `sourcesCurrent`를 사용하고, `outgoingCurrent`만 callable 검사를 더한다. 이 분리를 유지하면 semantic v4 주턴의 새 mode도 같은 경로로 검증할 수 있다. `tools.revision`에 묶인 inspect/materialize 캐시는 전환 시 재준비하되, 그 캐시 무효화를 received 증명 조건으로 옮기지 않는다.

호환성에는 별도 주의가 있다. 고정 지침을 바꾸면 prompt digest도 달라지고 `promptCurrent`는 현재 host prompt와 exact 비교한다. **mode 없는 구형 schema를 읽을 수 있음**과 **새 prompt로 재열어도 과거 주턴을 그대로 채택함**은 같은 보장이 아니다. 기존 prompt·저장 입력·해시를 덮거나 current 검사를 완화하지 않는다. availability-only 인수는 같은 새 prompt/profile pin에서 수행하고, prompt 변경으로 거절되는 과거 호출은 기존 수명/정산 의미로 남긴다.

또한 session 없는 legacy planning의 `PlanningRuntime.sessionCurrent`는 입력을 읽지 않고 돌아간다. 그 plan 채택은 동기 `validatePlan`의 tools.check가 중심이므로, 공통 compiler에서 marker를 광고하면서 [기존 StructuredPlanner 지침](../../runtime/src/infrastructure/structured-planner.ts)까지 확장한다면 **marked 저장 입력의 채택 직전 원문 검사 연결도 포함해야 한다.** 지침 두 곳만 바꾸고 모든 옛 planning reply에 새 원문 증명이 생겼다고 주장하지 않는다. 첫 범위를 일반 semantic v4 주턴으로 한정하려면 발급 범위를 명시해야 하며, 숨은 전역 예외로 해결하지 않는다. 원 TaskSpec/PlanProposal 응답 schema와 known usage 정산은 어느 선택에서도 유지한다.

## 한 검증 단계에서 재사용할 것과 다시 읽을 것

새 공용 캐시나 임의 boolean 검증 포트 대신 compiler의 collection 검사 부분을 작은 **private 함수**로 묶는 정도를 권고한다. 기존 `sourcesCurrent`의 tip별 `checkpoints.read` 반환값을 버리지 않고 그 호출 안에서 mode 조건까지 확인한다. `read → mode 검사 때문에 다시 read → sourcesCurrent가 다시 read`라는 세 겹의 검증은 만들지 않는다. 동기 정의 검사에서는 checkpoint I/O를 하지 않는다.

발급은 첫 estimate/preview 전에 검증된 결과로 이루어져야 한다. 현재 compile의 head 전용 `read(progress.head)`는 byteLength만 확인하고, 전체 검증은 나중의 sourcesCurrent에서 한다. 발급 때문에 이 초기 부분을 전체 checkpoint 검증으로 바꾸면 **첫 원문 검증 비용이 추가될 수 있다.** 이를 이미 무료로 읽고 있었다고 표현하지 않는다. 다만 그 초기 반환값을 모든 최소/선택/최종 estimate의 mode 생성에 재사용하고, 원 task는 frontier·attempt digest로 확인하며, head-only get이나 별도 원 receipt get을 중복 추가하지 않는다. 기존 선택 반복은 I/O 없이 같은 immutable packet 후보를 측정해야 한다.

최종 게시·materialize·실제 전송·응답 채택의 검증은 별개 단계다. 이 사이에는 모델 대기, 다른 state commit, 원문 삭제, 등록 교체가 가능하므로 초기 Map을 권한 증명으로 재사용하지 않는다. 기존 [ReadCheckpointReader](../../runtime/src/application/read-checkpoint-store.ts)의 한 검증 범위 안 parse/bytes 재사용과 마지막 원문 재검사, ReadCheckpoints의 state/등록/지식 경계는 유지한다. `inspectInputs.current()`도 실제 verify를 다시 하므로 값싼 캐시 확인으로 오해하지 않는다.

후속 측정은 같은 fixture/pin에서 compile·materialize·pre-send·adopt를 나눠 state.get/receipt, artifacts.get/반환 bytes, checkpoint reader의 parses/revalidations를 관측한다. 관측용 조회를 분리하고, 의미 조건 확인만을 위한 추가 raw read가 없는지 비교한다. 현재 문서에는 실행 시간·I/O 감소 수치를 제시하지 않는다. 전체 prefix/원응답 최종 재검증을 지워 성능을 얻는 안은 제외한다.

## 최소 변경 위치와 인수

| 위치 | 변경 또는 재사용 범위 |
|---|---|
| domain/context.ts·domain/model.ts, application/contracts.ts | packet용 optional mode 타입/strict schema만 추가. readCollectionContext 생산값과 WorkState/ReadProgress는 불변. |
| application/context-compiler.ts | 두 정본 비교의 공통 투영, private collection 원문 검사 반환값 재사용, 발급/표시 관계 검사, frontier·필수 입력·실제 bytes 측정 연결. |
| infrastructure/agent-turn-prompt.ts | exact readResume 제안 예외와 비권한 의미를 고정 지침에 포함하고 기존 digest 생성 재사용. |
| application/agent-turn-runtime.ts·context-store.ts·context-contracts.ts | 기존 nested packet schema/저장·current 호출 재사용. 별도 marker 장부·frame format·reply 형식은 추가하지 않는다. |
| application/planning-runtime.ts·infrastructure/structured-planner.ts | 일반 주턴은 기존 current/outgoing 분리 유지. legacy planning에도 발급한다면 위 marked-input 채택 검사와 고정 template 변경을 함께 처리할 조건부 범위. |
| 실행 계층 | 이 문서의 marker를 신뢰하지 않고 기존 parent/head/query와 현재 권한을 다시 증명하는 로컬 소비 경계를 사용. Tool.execute/fetch 미사용과 단계별 permit은 실행 담당의 별도 확정 사항. |

가장 작은 회귀 묶음은 다음과 같다.

- 완전 orphan에서 새/구형 packet을 모두 읽고, 새 frame/실제 request에는 mode와 exact frontier가 남는다. 원 body/cursor가 섞이지 않고 tiny window/반복 compact에서도 필수 옵션이 빠지지 않는다. mode만의 날조, 목록 누락·progress 변경, 원 task 없음/다른 query는 거절한다.
- 같은 pin에서 offline→online 및 received 뒤 online→offline을 구분한다. mode-only 요청은 원문이 유효하면 유지하고, 일반 options.tools가 포함된 미송신 요청은 기존 callable guard를 따른다. 받은 응답의 known usage와 원 input/reply bytes는 보존한다.
- checkpoint 읽기 뒤 다른 await에서 head/successor/goal/policy/generation/등록 교체 또는 원문 소실이 발생하면 새 게시·전송·로컬 소비를 막는다. host authority 취소도 await 뒤 마지막 진입에서 확인한다. 상태가 같다는 이유만으로 같은 UID의 원문 소실을 놓치지 않는다.
- 실제 C01 CLI/HTTP 최종 페이지 재개에서 필요한 명시 successor 계획 → 로컬 소비 → receive/adopt → 답변을 확인한다. 새 MCP 전송 0과 child 논리 toolCalls 1, 부모 실패·원 owner·원문·영수증 보존을 따로 확인한다. 선행 정산의 maxSteps/onStep와 낮은 첫 문맥 한도는 앞선 복구 검토의 인수를 재사용한다.

이 선택지 연결은 실제 모델의 자료 해석 품질, collection 전송 후 권한 상실 시 decoded custody/비용 정산, 사내 서비스·Windows·PostgreSQL 또는 C05 전체 완료를 의미하지 않는다.
