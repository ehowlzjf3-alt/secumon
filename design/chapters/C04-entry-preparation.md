# C04 첫 요청 연결 준비

2026-09-07 · 현재 코드의 읽기 전용 검토에 따른 제안 · 구현·시험·모델 호출 없음

첫 구현은 **시나리오 ID 없이 받은 요청 → 정상 업무와 원문 영수증 → 실제 문맥을 받는 주 모델 턴 → 답변/질문/기존 계획 실행 → 결과 전달 → 같은 세션의 후속 입력**으로 묶는 것을 권장한다. 직접 답변 한 건과 읽기 도구 한 건 뒤 답변하는 경로를 같은 입구에서 검증하는 것이 가장 작은 완결 범위다. 단순히 모델 옵션을 켜거나 프롬프트 파일만 추가하고 끝내지 않는다. 독립 반론 에이전트나 새 실행 엔진까지 넣지는 않는다.

[기존 C04 연결 메모](C04-next-implementation-notes.md)의 전체 방향을 바꾸지 않고 첫 실행 단위를 구체화한 문서다. 그 메모의 D2 검증 대기 문장은 작성 당시 상태다. 현재 D3 최종 Linux 검증은 부모 작업이 진행 중이며 이 문서가 통과나 C03 완료를 선언하지 않는다.

## 지금 있는 것과 새로 연결할 것

| 확인한 실제 경계 | 첫 구현에서 필요한 변경 |
|---|---|
| [담당 설정](../../runtime/src/application/agent-profile-contracts.ts#L7)에 purpose, model.profile, skills의 off/explicit/on-demand가 있다. [로컬 조립](../../runtime/src/presentation/local-profile.ts#L77)은 여전히 fixture·합성 actor·ScriptedPlanner와 enablePlanning:false를 사용한다. | C01 저장소 열기를 재사용하는 일반 요청용 조립을 추가한다. 호스트가 actor·정책·모델 프로필을 주입한다. 기존 demo 조립은 명시적인 합성 경로로 유지한다. |
| [Web 접수](../../runtime/src/presentation/local-workbench.ts#L215)는 rawText를 저장하지만 목표와 허용 도구는 선택한 scenario에서 가져온다. | 일반 요청은 scenarioId 없이 원문과 명시한 대상만 받는다. CLI/Web에서 각자 Goal을 합성하지 않고 application 진입점에 맡긴다. |
| [SessionService.accept](../../runtime/src/application/session-service.ts#L52)는 이미 결정된 Goal/Policy/Limits를 요구하며 원문 영수증·업무 ID·pending 복구를 연결한다. | 모델 호출 **전에** 원문 기반의 텍스트 응답 업무와 자원 주인을 고정한다. 목표 해석을 위해 별도 장부 밖 모델 호출을 먼저 하지 않는다. |
| [ContextCompiler.prepare](../../runtime/src/application/context-compiler.ts#L162)는 현재 세션·선택 개인 기억·지침을 packet/frame에 넣으며 [현재성 검사](../../runtime/src/application/context-compiler.ts#L75)가 있다. | 주 턴도 같은 compiler를 사용한다. 공통 원칙·담당 목적·반환 계약의 버전/지문을 실제 고정 요청에 포함한다. purpose는 권한이 아니고 skills=off이면 지침 본문을 넣지 않는다. |
| [Planner 포트](../../runtime/src/application/ports.ts#L64)는 propose와 선택적 compact만, [ModelCall](../../runtime/src/domain/model.ts#L227)은 planning/session_compact만 표현한다. [PlanningRuntime](../../runtime/src/application/planning-runtime.ts#L107)은 예약·응답 저장·usage·채택/거절을 이미 처리한다. | 주 턴의 답변/질문 결과를 엄격한 별도 반환 계약으로 추가하고 기존 호출 수명을 확장한다. 답변을 가짜 PlanProposal로 만들거나 표면에서 provider를 직접 호출하지 않는다. purpose 누락은 기존 planning이라는 호환 의미를 보존한다. |
| [Criterion](../../runtime/src/domain/model.ts#L25)과 [완료 검사](../../runtime/src/domain/completion.ts#L13)는 사실 키·독립 근거를 검사한다. [renderResult](../../runtime/src/application/conversation-service.ts#L48)는 해당 사실을 문자열로 조합한다. | Criterion을 재작성하지 않고 선택적 응답 요구와 답변 후보/평가를 추가한다. 가짜 facts.done이나 독립 근거 수 0으로 기존 조건을 우회하지 않는다. 기존 Goal에 새 필드의 기본값을 주입하거나 과거 bytes/digest를 바꾸지 않는다. |
| [WorkflowRuntime](../../runtime/src/application/workflow-runtime.ts#L77)은 compact→복구→실행→응답 준비→outbox→최종 재판정을 수행한다. [ConversationService.prepare](../../runtime/src/application/conversation-service.ts#L113)는 질문/결과와 전달 의무를 구분한다. | 이 루프의 기존 위치에서 주 턴을 진행하고 기존 질문·결과 outbox를 사용한다. 별도 대화 while-loop나 두 번째 전달 DB를 만들지 않는다. |

## 한 번의 구현 묶음

1. **접수와 텍스트 결과 계약을 함께 정한다.** 후보 파일은 신규 `application/agent-turn-service.ts`, `application/agent-turn-contracts.ts`와 기존 domain/model·contracts다. 입력은 호스트 actor, 선택 session, messageId, rawText, 선택한 기존 workId/expectedGoalRevision으로 제한한다. 새 업무는 아래 응답 요구를 가진 정상 WorkState로 생성한다. 기존 업무의 수정/답변은 SessionService.input/command를 사용한다. 기존 업무를 고를지 새 업무를 열지는 첫 단위에서 UI/CLI가 명시하며 모델에게 임의 업무 선택권을 주지 않는다.
2. **주 턴을 기존 모델 호출 수명에 넣는다.** ports·model-contracts·planning-runtime·compose-runtime에서 필요한 분기만 추가한다. 공통 예약/dispatch/receive/settle/현재성 검사를 재사용하고, 채택에서만 답변 artifact 또는 질문 의무를 만든다. 기존 StructuredPlannerAdapter의 신원·목적지·요청 크기·반환/usage 검사는 재사용할 수 있지만 현재 PlanProposal 전용 프롬프트는 그대로 주 턴에 쓸 수 없다. 실제 전송은 명시적인 결정적 대역을 주입한다.
3. **완료와 전달을 연결한다.** 텍스트 결과에는 원문 영수증·goal revision·채택된 call ID·artifact hash·검사 결과를 결합한다. 파일 존재/형식/현재성 검사는 시스템이 하고, 의미상의 요구 충족은 별도 평가로 표현한다. 첫 대역 시험의 정답 검사는 고정 fixture에 한정된다. 검사가 끝난 산출물 준비와 사용자 전달을 분리하여 기존 delivery 의무가 남으면 completed가 되지 않게 한다. 추가 질문은 waiting이며 답변 원문이 실제 적용되어야 다음 턴으로 간다.
4. **CLI/Web을 같은 경로에 연결하고 사용자 흐름으로 검증한다.** 현재 라우트·actor 검증·requestId 중복 처리·history·상태 카드·outbox를 재사용한다. 접수 안내 한 번, 실행 상태 카드, 최종 답변 또는 필요한 질문만 보여 준다. 내부 모델/compact 이벤트마다 말풍선을 추가하지 않는다. 정상 흐름과 아래 중단/변경 사례가 끝난 뒤 이 단위를 기록한다.

위 네 항목은 함수별 별도 챕터가 아니라 하나의 사용자 흐름을 완성하는 변경 묶음이다. D3에서 정한 유효 개인 기억 backend와 실행 전 gate는 그대로 사용하고, 일반 진입을 위해 SQLite/문서 저장소를 다시 만들지 않는다. 정책·완료 조건에 대한 모델 제안과 호스트가 권한을 부여하는 행동도 구분한다.

## 첫 호출의 업무 귀속과 완료 조건

**권장하는 최소 확장은 선택적 `Goal.responseRequirement`와 WorkState의 답변 후보·평가다.** 실제 필드 이름은 착수 때 정하되, 기존 사실 Criterion의 구조와 평가 의미는 유지한다. 응답 요구는 사용자 요청에 답변/산출물이 필요하다는 호스트의 계약이고, 답변 후보는 모델이 생성한 본문 artifact와 그 근거·평가다. 둘을 같은 값으로 저장하지 않는다.

- 새 응답 요구가 있는 업무만 사실 criteria가 빈 배열일 수 있다. 응답 요구가 없는 기존 Goal은 계속 최소 한 개의 기존 Criterion을 요구한다. 기존 fixture/저장 Goal을 변환하거나 responseRequirement:null 같은 기본값을 직렬화하지 않는다. 이전 의미 지문 버전도 조용히 바꾸지 말고 새 목적의 입력 지문에서 명시적으로 확장한다.
- 첫 입력은 `SessionService.accept`의 receive→정상 업무 commit→applied 원문 영수증 확인을 끝낸 후 모델을 예약한다. 업무 ID·정책·자원은 그때 이미 존재한다. 원문 수락만 되고 적용 전 중단되면 기존 resume가 같은 업무로 수렴하며 별도 임시 업무나 세션 예산을 만들지 않는다.
- 응답 요구에는 requestMessageId와 필요하면 원문 bytes 지문을 쓸 수 있다. **자기 자신의 최종 receipt digest를 accept payload 안에 넣으면 해시의 순환 참조가 생긴다.** 실제 AppliedSessionInput은 현재 방식대로 conversation.session에 연결하고, 모델 입력과 답변 후보는 적용된 그 기준을 참조한다.
- 답변 후보는 생성 call ID, 입력 packet/프롬프트 지문, goal revision, 적용 원문 기준, 본문 artifact, 사용한 근거 참조, 평가를 고정한다. 의미 평가가 요청 충족을 주장하더라도 시스템이 artifact 존재·hash·형식·현재 권한·세션/선택 기억 현재성을 별도로 검사해야 한다.
- 응답 요구와 사실 조건이 함께 있으면 **기존 사실 조건 충족 + 유효 답변 후보/평가 + 미해결 의무 없음**이 결과 준비 조건이다. 전달 의무까지 끝나야 작업 완료다. 응답 요구가 없는 과거 업무는 기존 사실 기반 renderResult를 그대로 사용할 수 있다.
- 현재 [결과 ID](../../runtime/src/application/conversation-service.ts#L128)는 goal revision·data generation·evidence digest·binding으로 만든다. 생성 답변에는 candidate/assessment 지문과 artifact 참조도 결과 ID·PreparedResponse·delivery context에 결합해야 한다. 같은 사실로 새 답변을 만든 경우 옛 답변과 같은 ID를 사용하면 안 된다. [outbox의 전송 직전 검사](../../runtime/src/application/outbox.ts#L28)와 결과 상태 조회도 현재 채택 후보와 대조한다. 과거 사실 전용 결과의 ID 계산은 그대로 유지한다.

이를 위해 completion뿐 아니라 [domain/control](../../runtime/src/domain/control.ts#L34), [execution-policy](../../runtime/src/domain/execution-policy.ts#L85), conversation.resultProof의 호출 경로도 같은 응답 준비 판정을 받게 해야 한다. UI만 산출물 완료라고 표시하면 기존 코어는 plan_required/기준 미충족으로 계속 재계획한다.

## 계획에서 최종 답변까지 같은 루프로 닫기

주 턴 결과는 `answer | question | plan` 세 분기로 시작하는 것을 권장한다. 계획 분기는 기존 PlanProposal의 base revision·허용 도구·의존성·재사용 검사를 그대로 통과한다. 새로운 응답 요구의 ID를 task.satisfies에 사실 Criterion처럼 넣으면 [기존 validator](../../runtime/src/application/plan-validator.ts#L23)가 unknown_criterion으로 거절한다. 첫 응답 전용 읽기 계획은 기존 계약이 허용하는 satisfies:[]를 사용하고, 작업 설명/주 턴 입력에서 응답에 필요한 관측 목적을 표현하면 된다.

실행 순서는 **주 턴의 계획 채택 → 기존 executor의 도구 예약/실행/관측 채택 → 새 실제 packet → 주 턴의 답변 후보/평가 → 기존 결과/outbox**다. 도구가 성공했다고 응답 요구를 충족시키지 않는다. 실행할 task가 없고 응답 후보가 없으면 합성 답변 턴이 필요하며, 이 상태를 무조건 새 계획 생성으로 보내지 않도록 workflow/planning 분기를 추가한다. 반대로 실행할 task가 남으면 기존 executor를 진행하고 매 task마다 불필요한 모델 턴을 강제하지 않는다. 질문 분기는 기존 waiting/response 의무를 사용한다.

모델의 자체 검토·반론은 제안/평가이며 독립적인 사실 근거가 아니다. 새 관측이 필요한 반론은 기존 가설의 반증 조건과 판별 task로 이어지고, 실제 도구 관측이 기존 출처/lineage/coverage 검사를 통과해야 사실 조건에 쓸 수 있다. 직접 글쓰기의 의미 평가는 이와 다른 계약이다. 구조 검사·결정적 fixture 정답·모델 자체 평가를 구분해 기록하고, 합성 시험으로 일반 모델의 의미 정확성을 보장했다고 표시하지 않는다.

## 필요한 회귀

| 사용자 흐름 | 실제 검사할 경계 |
|---|---|
| 문장 교정 한 건 | C01 담당의 CLI와 HTTP에서 scenarioId 없이 접수→원문 영수증→저장된 실제 모델 입력→답변 artifact→결과 전달까지 수행한다. 호출·입출력 usage는 같은 WorkState에 남으며 도구/가설/스킬 호출은 필요 없으면 0이다. |
| 한 번의 읽기 계획 뒤 답변 | 주 턴 대역이 plan을 반환하고 실제 기존 executor가 읽기 도구를 실행한다. 다음 모델 입력에 저장된 관측이 들어가며 answer가 채택·검사·전달된 후에만 응답 업무가 완료된다. 도구 성공만으로 completed가 되는 것을 막고, 사실 조건이 있는 별도 fixture에서는 자체 평가로 근거 수/반증 검사를 우회하지 못한다. |
| 추가 질문과 답변 | 모델 결과의 질문을 기존 response 의무/outbox로 보낸다. 재시작/재전송으로 질문을 중복 생성하지 않고, 사용자 답변 적용 전 완료하지 않는다. 답변 적용 후 같은 업무의 새 문맥을 사용한다. |
| 완료한 X 다음 Y | 같은 세션에서 Y를 새 업무로 열어 최근 원문 또는 요약+tail, 선택 기억이 실제 provider 입력에 들어가는지 확인한다. X의 graph·근거·자원을 Y에 복사하지 않고 다른 담당/사용자/세션은 섞이지 않는다. |
| 호출 중 수정·취소·기억 정정 | 응답을 지연시킨 대역으로 오래된 답변의 채택과 전달을 거절한다. 실제 소비 usage는 남고 모델 신원/프롬프트 지문이 바뀐 예약 호출도 재검사한다. |
| 동일한 사실의 답변 교체 | 첫 답변이 outbox에 대기 중인 상태에서 새 후보/평가를 채택한다. evidence digest가 같아도 result ID가 구분되고 오래된 본문은 전송 직전 차단된다. 이미 전달된 응답의 재전송 의미와 새 답변 전달은 섞지 않는다. |
| 응답 저장 뒤 프로세스 중단 | received 응답 artifact 뒤 실제 SIGKILL·재개에서 유효 응답을 재사용하고 provider 재호출을 피한다. outbox의 논리 전달 ID는 같아야 한다. 외부 API가 정확히 한 번 실행된다는 보장은 하지 않는다. |
| 한도·반환 오류·compact | 잘린 JSON/잘못된 결과/usage 불명은 성공으로 처리하지 않는다. 제한이 작은 합성 설정 한 건에서 기존 compact가 먼저 진행되고 새 packet을 주 턴이 사용하거나 명시적으로 대기/실패한다. C02 전체 시험을 복제하지 않는다. |

재사용할 시험 기반은 [session-flow-helpers](../../runtime/src/tests/session-flow-helpers.ts), [model-runtime](../../runtime/src/tests/model-runtime.test.ts), [model-boundaries](../../runtime/src/tests/model-boundaries.test.ts), [workflow-crash](../../runtime/src/tests/workflow-crash.test.ts), [persistent-session-presentation](../../runtime/src/tests/persistent-session-presentation.test.ts)다. 과거 Goal 직렬화/지문·기존 planning/compact 응답과 완료 의미를 유지하는 호환 시험도 필요하다. 첫 직접 흐름은 기본 SQLite에서 실행하고, 등록된 문서 개인 기억과 file-journal state에는 짧은 조립/격리 사례를 추가한다. 저장소별 전체 시나리오 복제로 같은 시험을 늘리지 않는다.

## 착수 전에 남은 선택

- **응답 요구와 평가의 최소 필드:** 위의 선택적 계약을 권장하되 신뢰하는 구조 검사, 자체 의미 평가, 사용자가 확인해야 할 상태를 어떻게 표현할지 착수 때 정한다. 기준이 명확하지 않은 업무를 무조건 completed로 보내거나 매 답변마다 별도 검토 모델을 호출하는 정책은 넣지 않는다.
- **주 턴 예약 조건:** 직접 답변, 질문 응답 뒤 재개, 계획 실행 뒤 합성 답변을 어떤 현재성/진행 조건으로 예약할지 정한다. 기존 자동/fast/deep 및 무진전 한도와 충돌하지 않아야 하며, 직접 답변을 위한 턴을 가짜 plan revision으로 정산하지 않는다.
- **모델 프로필 조립:** profile 이름을 어느 호스트 등록 정보로 해석하고, 주 턴/계획/compact가 같은 adapter인지 다른 adapter인지 최소 계약을 정한다. 비어 있거나 미등록이면 연결 없음으로 표시한다. API 키 탐색·외부 모델 호출·임의 fallback은 포함하지 않는다.

새로운 서브에이전트·A2A·Knox·컴퓨터 유즈 최적화·자동 기억 선별·PostgreSQL·네이티브 Windows는 이 첫 흐름의 선행 구현이 아니다. 필요한 C03 개인 기억/문맥 계약이 같은 검증 소스로 충족되면 C04를 시작할 수 있지만, PG/Windows와 다른 C03 잔여를 완료로 표기하지 않는다. 복합 반론·장기 재계획 품질, 실제 모델 적합성/의미 품질은 후속 C04에 남긴다. 이 문서는 파일만 작성한 준비 결과이며 위 검사들은 아직 실행하지 않았다.
