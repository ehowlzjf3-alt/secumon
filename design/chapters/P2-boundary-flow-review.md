# P2-06 정보 흐름 독립 조사

2026-09-06 · 읽기 전용 코드 조사 · 실제 모델/네트워크/도구 호출 및 빌드 없음

이 문서는 P2-06 구현 전 연결 지점을 조사한 기록이다. 조사 당시 파일 내용에 대한 관찰이며, 이후 구현의 검증 결과를 대신하지 않는다. 기존 전체 내부/외부 리드+게이트/내부 주도+자문 중 어떤 배치도 채택하지 않는다.

## 1. 현재 권한의 의미

`Policy`는 tenant/principal, `allowedTools`, `allowedLabels`, `allowedDestinations`, `allowWrites`를 가진다. `allowedLabels`는 읽기 허용 등급이고 `allowedDestinations`는 목적지 허용 목록이다. 특정 목적지에 어떤 등급·표현을 공개할 수 있는지 연결하는 계약은 아직 없다. 현재 두 목록을 동시에 만족하면 접근할 수 있으므로 “내부 원문을 읽을 수 있음”과 “그 원문을 외부 모델로 보낼 수 있음”을 별도로 표현하지 못한다.

- [Policy 정의](/Users/seunghanee/Documents/secumon/runtime/src/domain/model.ts:35)
- [Policy 직렬화 계약](/Users/seunghanee/Documents/secumon/runtime/src/application/contracts.ts:18)
- [도구 허용 검사](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-contracts.ts:6)

`ToolDefinition.labels`는 도구 계약 접근 조건이다. 임의 `TaskSpec.input`의 실제 정보 등급이나 출처를 증명하지 않는다. Goal.description, Plan.reason, TaskSpec.description/input, Hypothesis 문자열, Obligation.reason에는 개별 정보 등급이 없다. 외부 리드에 evidence만 지우는 방식은 이 필드를 통해 이미 전달된 내용까지 제거하지 못한다.

기존 처리는 일정 범위에서 보수적으로 등급을 계승한다. 도구 결과 JSON, 모델 요청 JSON, 준비된 결과/질문은 대체로 업무의 `allowedLabels` 전체를 산출물 등급으로 붙인다. 이 동작은 원문만 따로 저장한 뒤 결과를 무조건 공개하는 것보다 안전한 기본값이지만, 실제 접근 범위와 공개 범위가 동일하다는 현재 전제를 해결하지 않는다.

## 2. 실제 경계별 전달 지점

| 경계 | 현재 전달물 | 현재 검사 | 구현 시 연결 지점 |
|---|---|---|---|
| 모델 입력 추정 | ContextPacket + 선택된 전체 ToolDefinition | context/도구 스키마, 현재 자료·권한, 크기 | `ContextCompiler.prepare`의 `estimateInput` 호출 **이전** |
| 모델 호출 | 저장된 packet/options | 모델 identity/destination, semanticDigest, 정책·자료·도구 재검사 | `PlanningRuntime.reserve`, `execute` 최종 `planner.propose` 직전 |
| 구조화 모델 transport | identity, packet, options, 고정 instructions | 요청 스키마·도구 목록·목적지·크기 | `StructuredPlannerAdapter.requestSnapshot`와 `invoke` 경계 |
| 도구 실행 | 전체 TaskSpec + work/attempt ID + 전체 Policy | 도구 권한·계약 digest·입력 스키마·lease·revision | `ToolBroker.invoke`의 재사용 결정 및 `tool.execute` 직전 |
| 사람 결과·질문 | Delivery.text + context + artifact 참조 + binding | 업무 소유자·수신자·목적지·등급·현재 증거 | `ConversationService.prepare`, `OutboxDispatcher.valid`, send/lookup 직전 |
| 원문·증거·호출 이력 재조회 | 원문 content, locator, 증거 facts, 저장된 input/output | read ACL, source/currentness/hash/receipt | `WorkResources` 및 discovery 도구의 호출자/목적지 view |
| provider 도구 목록 | description, input/output schema, destination, labels | 전체 페이지·revision·namespace·한도·freeze | 목록 적재는 재사용하고 모델로 내보낼 계약만 목적지별 검사 |

### 모델

[ContextCompiler](/Users/seunghanee/Documents/secumon/runtime/src/application/context-compiler.ts:117)는 근거 facts/artifact 참조, 호출 input/output, 기억 검색 결과, 지침 body/rules, 도구 스키마를 조립한다. 다음 항목도 정보 공개 대상으로 취급해야 한다.

- 근거 reference의 `sourceId`, `locator`, 관측 시각. 원문 본문이 없다는 이유로 공개 자료가 되지 않는다.
- 실행 중 attempt, read checkpoint 참조, 계획 task input, 가설·반증 설명, 사용자 응답 obligation.
- `core.calls.get`을 통한 과거 input/output 복사, `core.evidence.get`과 원문 조회, guidance 및 catalog 조회 결과.
- 압축 과정에서 반드시 유지하는 goal/hypotheses/obligations/plan. 근거만 필터링해도 보호 필드에 같은 내용이 남을 수 있다.

`prepare` 안의 [입력 추정](/Users/seunghanee/Documents/secumon/runtime/src/application/context-compiler.ts:336)은 주입된 `planner.estimateInput`에 원본 packet/options 복사본을 먼저 전달한다. 현 `StructuredPlannerAdapter` 추정은 로컬 계산이지만 `Planner` 포트는 이를 강제하지 않는다. 따라서 `propose` 앞에만 공개 정책을 검사하면 주입된 추정 adapter는 이미 입력을 받는다. 목적지 공개 검사 이후 추정하거나, 신뢰된 로컬 estimator를 별도 포트로 두는 선택이 필요하다.

[PlanningRuntime](/Users/seunghanee/Documents/secumon/runtime/src/application/planning-runtime.ts:49)는 예약 전 목적지 허용과 저장 산출물 읽기 권한을 검사하고, 실행 시 현재 revision/semanticDigest/자료/도구/예산을 재확인한 뒤 [propose](/Users/seunghanee/Documents/secumon/runtime/src/application/planning-runtime.ts:166)를 호출한다. 새 공개 정책을 policy에 넣으면 semanticDigest에 자연스럽게 포함된다. 목적지 검사 자체도 공개 정책을 포함해야 이미 예약된 입력의 재전송을 막을 수 있다.

[StructuredPlannerAdapter](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/structured-planner.ts:90)는 고정 지시문과 packet/options를 최종 요청으로 직렬화한다. 이 adapter의 도구 검사도 현재 읽기 등급/허용 목적지만 확인한다. provider별 adapter를 우회해서 직접 호출하는 상황을 테스트한다면 이 최종 경계에도 같은 공개 guard가 필요하다.

### 도구

[ToolBroker](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-broker.ts:19)는 dispatch receipt, 현재 상태, 작업 digest, 계약 digest, 권한, knowledge, budget을 확인한 후 실행한다. 마지막 await 이후 revision과 계약을 다시 확인하고 [전체 TaskSpec을 전달](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-broker.ts:46)한다. 따라서 목적지 공개 검사도 이 위치에 재사용할 수 있다. 입력 `input`만 검사하고 `description`, `readResume`, 전달된 Policy를 빠뜨리면 실제 payload 범위와 다르다.

재사용 결과는 실제 도구 entry 전에 반환한다. 실제 외부 전송이 없는 cache hit를 새 외부 노출로 기록할 필요는 없지만, 재사용 결과가 다음 모델/채널에 들어가는 공개 검사는 필요하다. 내부 자료 조회를 하는 core 도구와 외부 전송 도구를 같은 `allowedDestinations` 목록으로 취급하는 현재 방식만으로는 source→destination 경계를 표현할 수 없다.

### 대화와 채널

[ConversationService](/Users/seunghanee/Documents/secumon/runtime/src/application/conversation-service.ts:29)는 criterion 값과 증거 locator를 사용자 결과에 렌더링한다. 결과/질문에 업무 등급 전체를 붙이며, 접수와 일반 실패 알림은 고정 문구를 사용한다. 접수 문구에는 work ID가 포함되므로 이것도 조직 정책상 공개 가능한 메타데이터인지 별도 결정 대상이다.

[OutboxDispatcher.valid](/Users/seunghanee/Documents/secumon/runtime/src/application/outbox.ts:15)는 채널 binding/수신자와 읽기 등급을 확인한다. 기존 permission revocation, stale result, unknown delivery 처리는 유지해야 한다. 공개 거절이 발생했다고 이미 전달 여부가 불명인 메시지를 미전송으로 덮어쓰면 안 된다.

중요하게도 [lookup](/Users/seunghanee/Documents/secumon/runtime/src/application/outbox.ts:94)은 전체 Delivery를 sink로 넘긴다. lookup의 구현이 읽기라고 해도 text/context/artifact가 adapter에 도달하므로 send와 같은 공개 검사 범위다. `MessageSink`의 현 계약은 검색 키만 받는 형태가 아니다.

## 3. 재사용할 수 있는 방어 구조

- [authorizedWork](/Users/seunghanee/Documents/secumon/runtime/src/application/work-resources.ts:29): 현재 업무 소유자 확인과 actor 권한 교집합. 새로운 공개 정책도 actor가 넓힐 수 없게 교집합 규칙이 필요하다.
- [evidenceView](/Users/seunghanee/Documents/secumon/runtime/src/domain/evidence-access.ts:9): tenant/scope/source lineage/access와 원문 등급을 함께 확인한다. 공개 view를 만들기 전 읽기 권한 검사로 계속 사용한다.
- `dataGeneration`, `artifactBlocked`, `knowledgeInputsCurrent`: 철회·삭제·권한 변경·외부 기억 의존성 변경 감지. 공개 receipt는 원자료 버전과 이 세대를 함께 고정해야 한다.
- `semanticDigest`, context `policyDigest`, tool contract digest, state revision 재확인: 예약 이후 정책 또는 입력이 바뀌었는지 검증하는 기존 구조다.
- `ToolDefinitionSchema`/`snapshotTool`, provider epoch 및 전체 페이지 원자 교체: 동적 catalog를 새로 만들 필요가 없다. 설명·스키마도 공개 대상이라는 계약만 연결한다.
- `ContextCompiler.protectedInput`: 압축이 목표·반증·미해결 의무를 버리지 않는 검사다. 공개 정책 때문에 숨길 자료를 압축 생략으로 가장하지 않는다.
- `PlanProposalSchema`와 validator: 모델은 goal/policy를 변경할 수 없고, 제안은 도구 실행 권한을 부여하지 않는다. 고정 모델 지시문도 자료를 상위 지시로 승격하지 않도록 명시한다. 자연어 지시문만으로 보장되었다고 판정하지 않는다.

## 4. 최소 완결 구현 제안

1. **읽기 권한과 공개 권한을 별도 계약으로 표현한다.** 목적지, 수신 주체/역할, payload 종류, 허용 등급, 정책 버전을 명시한다. 설정되지 않은 목적지는 새 정책 사용 시 거절한다. 기존 fixture 호환성은 명시적으로 관리하고, 외부 목적지 이름만 보고 신뢰를 추론하지 않는다.
2. **모든 전달물을 보수적으로 분류하는 공통 guard를 연결한다.** 초기에 자유 문자열의 정확한 provenance가 없다면 업무 등급 전체를 공개 등급 하한으로 사용해 미분류 자유 텍스트가 외부로 빠지지 않게 한다. 이는 원문 없는 A/C 배치를 구현했다는 증거가 아니라, 무분류 payload를 안전하게 거절하는 기반이다.
3. **명시적 공개 view를 별도 산출물로 만든다.** 공개 view가 source ACL/버전/세대/정책/payload hash에 결합된 내부 게이트 결과여야 한다. 모델이 `labels: []`나 “요약” 표시만 붙여 등급을 낮출 수 없어야 한다. 자유 텍스트/경로/이미지 대신 허용 스키마 필드와 사건 범위의 가명 참조를 사용한다.
4. **모델 추정·실행, 도구, 채널 send/lookup에 연결한다.** 기존 마지막 revision/자료 확인 구조 안에 공개 결정을 넣는다. 예약/compact/restart 후에 과거 허용이 계속 유효하다고 가정하지 않는다.
5. **A/B/C 비교에서는 canonical 상태를 훼손하지 않는다.** 내부 업무의 근거를 지우는 대신 모델 역할이 받는 별도 view와 내부 질문 경로를 사용한다. 원문 없는 외부 역할이 판단할 수 없으면 내부 재질의/불충분을 기록하고, 원문 포함 내부 모델과 같은 품질이라고 주장하지 않는다.
6. **합성 outbound payload를 실제 entry에서 캡처해 검사한다.** 결과 점수와 노출 여부를 분리하고, estimator·propose·tool execute·send·lookup 전체에서 금지 sentinel이 사라졌는지 확인한다. 현재 구현하지 않은 A2A/웹/Knox/화면/로그 exporter는 generic payload 계약 시험과 실제 adapter 검증을 구별한다.

## 5. 구현 검증에서 빠뜨리기 쉬운 경우

- 읽기 등급은 허용되지만 외부 모델 목적지 공개는 거절되는 경우. 모델 호출뿐 아니라 estimator entry도 0이어야 한다.
- summary/card/reference/filename/locator/error/guidance/schema에 금지 문자열이 존재하는 경우. 원문만 검사한 통과로 오인하지 않는다.
- tool output이나 A2A 자료가 새로운 goal/policy/allowWrites를 주장하는 경우. runtime 권한이 바뀌지 않고 제안도 validator를 통과해야 실행된다.
- compact 후 다시 full로 읽거나 `core.calls.get`으로 복사했을 때 같은 정책이 유지되는 경우.
- 예약 후 목적지 권한 철회, 자료 정정/삭제, 재시작 후 저장 모델 입력 재사용. 최신 정책으로 다시 검사한다.
- channel 수신자는 원문 권한이 있지만 채널 또는 대화 모델 목적지는 원문 전송이 금지된 경우.
- 이미 send가 시작된 뒤 공개 권한이 철회되고 결과가 unknown인 경우. 재전송 금지와 전달 불확실성은 동시에 보존한다.
- 도구의 접근 등급이 public이어도 입력이 secret인 경우. 도구 label만으로 공개를 승인하지 않는다.
- 여러 허용된 공개 view를 합치면 재식별 또는 범위 확장이 생기는 경우. 단일 요청 필터 통과를 누적 노출 안전성으로 확대하지 않는다.

실제 조직 등급·모델 배치·보존 정책 결정과 OS/네트워크/서비스 계정 격리는 별도 실배치 선행 조건이다. 이 조사 및 로컬 guard 구현만으로 외부 리드가 사내 원문에 접근할 수 없다는 운영 보장을 선언할 수 없다.
