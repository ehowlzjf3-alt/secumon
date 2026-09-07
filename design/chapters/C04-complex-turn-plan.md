# C04 복합 조사 한 흐름 인수 계획

2026-09-07 · 실행한 인수 계획. 등록 단위의 Linux 검증·회수·정리 뒤 기존 제품 코어를 유지하고 통합 시험을 추가했다. 로컬 신규 2/2·관련 43/43의 [결과](C04-complex-turn-result.md)를 확인했다. 명시 deep 모드에서 성공 흐름과 판별 실패의 질문 대기를 검증했으며 실제 모델 품질·새 시험의 Linux 실행·C04 전체 완료를 뜻하지 않는다.

사용자가 “두 문서의 현행 보존기간이 같은지, 차이가 있으면 개정 이력까지 확인해 설명해 줘”라고 요청했을 때, 초기 90일 관측에 머무르지 않고 30일 반증과 개정 자료를 확인해 답하도록 검증한다. 중간에 담당을 닫았다 다시 열어도 이미 읽은 자료를 재실행하지 않아야 한다. 판별 자료를 읽지 못하면 확인한 사실과 부족한 자료를 구분해 질문하고 기다린다.

이번 범위는 **성공 흐름 1개와 판별 읽기 실패 변형 1개**다. 일반 요청 → 가설 → 읽기 → 반증 → 필요한 계획 변경 → 근거 답변 → 전달이라는 결합을 확인한다. 등록·문맥 창·compact·저장소를 다시 구현하지 않는다. 중간 보존 경계는 재접속 한 번으로 고정하고, 반복 compact 자체의 인수는 기존 등록 흐름 시험을 재사용한다.

## 현재 계약과 재사용 지점

| 필요한 동작 | 그대로 쓸 코드·시험 | 이번에 더 확인할 결합 |
|---|---|---|
| 일반 원문 접수와 담당·사용자·세션 연결 | [AgentTurnService.accept](../../runtime/src/application/agent-turn-service.ts), [세션 조립 helper](../../runtime/src/tests/session-flow-helpers.ts) | 실제 C01 담당 저장소에서 원문 영수증 → 정상 work → 첫 모델 예약 순서. 모델은 ID·권한·scope를 정하지 않는다. |
| 등록된 구조화 주턴 | [호스트 등록](../../runtime/src/presentation/host-models.ts), [StructuredAgentTurnAdapter](../../runtime/src/infrastructure/structured-agent-turn.ts), [composeRuntime](../../runtime/src/application/compose-runtime.ts) | 시험 전용 유한 transport의 `plan / answer / question`이 기존 검증·호출 장부를 모두 통과한다. |
| 가설·반증·평가와 부분 재계획 | [model-runtime.test.ts:49](../../runtime/src/tests/model-runtime.test.ts#L49), [계획 검사](../../runtime/src/application/plan-validator.ts), [가설 현재성](../../runtime/src/domain/hypotheses.ts) | 사실 조건 업무에서 검사한 흐름을 일반 응답 업무에 결합. 같은 task 배열의 평가 갱신은 계획 버전·replan 비용을 올리지 않는다. |
| 성공 작업 재사용 | [task-status.ts](../../runtime/src/domain/task-status.ts), [control.ts](../../runtime/src/domain/control.ts) | 이전 task ID와 실행 계약을 보존하고 새 판별 task만 추가한다. 같은 ID의 입력을 바꾸면 기존 검사기가 거절한다. |
| 답변·완료·전달 | [agent-response-completion.test.ts](../../runtime/src/tests/agent-response-completion.test.ts), [generated-answer.ts](../../runtime/src/application/generated-answer.ts), [completion.ts](../../runtime/src/domain/completion.ts) | 가설 현재성, 답변 근거·원문·계획 버전, 미완료 작업, 질문 의무와 실제 전달을 함께 확인한다. |
| 재접속·실제 입력 관측 | [registered-agent-flow.test.ts](../../runtime/src/tests/registered-agent-flow.test.ts) | 저장된 late counterevidence를 재접속 후 다음 주턴이 실제로 보고, 추가 source 호출 없이 이어 간다. |

첫 구현은 신규 `runtime/src/tests/complex-agent-turn.test.ts`와 필요한 시험 helper 하나가 예상 범위다. `FileAgentProfileStore` → `openAgentStores`로 SQLite 기본 담당을 열고, 신뢰된 시험 조립에서 `documents-complex`의 `FixtureReadTool`과 등록 모델을 `composeRuntime`에 넘긴다. 기존 helper의 초기화·정리 패턴을 재사용하되, 여러 기존 시험의 조립을 광범위하게 바꾸지는 않는다.

등록 factory는 모델만 반환한다. 현재 `openAgentTurnProfile`의 `doc-current` 단일 자료 도구를 바꾸려고 HTTP 도구 주입이나 새 운영 설정을 추가하지 않는다. 신규 시험은 CLI/Web이 사용하는 동일한 `AgentTurnService.accept`와 workflow 경계를 직접 호출한다. 실제 표면의 등록·접수 연결은 기존 등록 시험으로 유지한다. 전체 계층 결합에서 실제 제품 결함이 드러난 때에만 해당 기존 메서드를 좁게 수정한다.

## 고정 입력과 독립 기대값

[documents-complex.json](../../runtime/fixtures/documents-complex.json)의 다음 세 자료만 이번 관측 순서에 사용한다. 기존 사실·계보·개정 관계를 그대로 보존한다. 자료가 미리 준비되어 있어도 읽기 전에는 WorkState나 모델 입력에 넣지 않는다.

| 자료 | 고정 사실 | 최종 판단에서의 역할 |
|---|---|---|
| `doc-a-old` | 90일, 계보 `doc-a` | 처음 관측한 잠정 근거. 개정 후에도 원본·실행 이력은 보존된다. |
| `doc-b` | 30일, 계보 `doc-b` | 초기 90일 설명을 반박하는 별도 출처. |
| `doc-a-amendment` | 30일, 계보 `doc-a`, `supersedes: ['doc-a-old']` | 같은 계보의 유효 개정 자료. 현행 A/B가 30일로 일치함을 판별한다. |

가설은 기존 `Hypothesis` 필드로 두 개를 둔다. H90은 “현행 보존기간은 90일”, H30은 “90일 관측은 구본이고 현행은 30일”이다. 각각 질문·예상 관측·반증 조건을 명시하고, 채택 뒤 같은 ID의 의미를 바꾸지 않는다. `supportIds / counterIds`는 해당 시점에 실제 읽고 접근 가능한 Evidence만 사용한다. 개정으로 old가 현행 보기에서 빠지면 현재 가설 참조에서도 제외할 수 있지만, 과거 모델 입력·평가·도구 결과는 삭제하지 않는다.

정답 oracle(제공자 응답과 별도로 둔 시험 기대값)은 현재 근거 ID `{doc-b, doc-a-amendment}`, 서로 다른 계보 `{doc-b, doc-a}`, 각 30일, old의 유효 대체 관계다. 답변 문구만 동일하다고 통과시키지 않는다. 최종 답변의 현재 근거 인용도 이 두 ID여야 한다. “초기 90일 설명을 바꾼 이유”는 이전 관측 이력과 개정 관계에 맞아야 하며, old를 새로운 현행 독립 출처로 세지 않는다.

**현재 일반 입구의 `criteria`는 빈 배열이다.** 이를 숨기려고 접수 뒤 fixture의 사실 조건을 work에 직접 끼워 넣지 않는다. 일반 응답의 문장 의미나 두 출처의 충분성을 코어가 독자적으로 증명한다고 주장하지도 않는다. 이 흐름에서 하드한 차단 조건은 미검토 관측, 검증된 계획의 미완료 작업, 답변의 `needs_work / missing`, 현재성, 질문 의무다. 숫자 일치·독립 출처와 반론의 적절성은 고정 oracle로 따로 확인한다. 사실 조건이 있는 목표의 반증 차단은 기존 완료 단위 시험이 담당한다.

## 성공 흐름의 체크포인트

| 단계 | 모델·executor가 할 일 | 저장 상태와 독립 확인 |
|---|---|---|
| 접수 | 자연어 원문으로 일반 work를 만든다. | 원문·request digest·session/agent/사용자 연결 고정, 모델/도구 호출 0. 응답 완료 요구는 원래 요청을 가리킨다. |
| 최초 계획 | `read-old` → `read-independent` 두 task와 열린 H90/H30을 제안한다. 두 번째 task는 첫 번째에 의존한다. | 계획 revision 1. 가설의 Evidence 참조는 아직 비어 있다. |
| 초기 관측 | old 한 건을 읽고, 동일 task 배열로 H90 지지·H30 반박을 평가한다. | old 원문 결과가 실제 주턴 packet에 있다. `model_plan_accepted`의 이유가 `assessment`, 계획 revision 1·replan 사용량 0. 아직 답변 전달 없음. |
| 늦은 반증 | B 한 건을 읽어 채택한다. 여기서 모든 핸들을 닫고 같은 담당·세션을 다시 연다. | old/B의 원본 결과·attempt ID·usage·가설은 유지된다. 새 관측 때문에 다시 검토해야 하며, 재접속 자체의 모델/도구 호출은 0. |
| 판별 계획 | 90/30 충돌을 두 가설에 반영하고 `read-amendment`만 추가한다. 기존 두 task는 ID·입력·의존성까지 동일하게 제출한다. | 새 계획 revision 2, replan 사용량 1. old/B를 다시 실행하지 않고 amendment만 읽는다. 반론 문장을 Evidence로 생성하지 않는다. |
| 최종 평가 | 개정 관측을 보고 동일 세 task 배열로 H90 기각·H30 지지를 기록한다. | 평가 대상 현재 Evidence 집합과 `hypothesisAssessment`가 일치한다. 계획 revision 2·replan 사용량 1 유지. 실제 입력에 B와 amendment의 근거/계보가 있다. |
| 답변·전달 | 두 현행 근거를 인용한 설명과 해결한 반론을 낸다. `missing=[]`, 자체 검토 `satisfied`를 제출한다. | 현재 원문·목표·계획·자료와 일치한 host 채택 답변만 전달한다. 결과 전달 영수증 1개 뒤 `complete`. 기존 완료 업무를 resume해도 모델 재호출·중복 전달 없음. |

이 고정 순서를 구현하면 예상치는 원본 읽기 3회, 주턴 모델 5회(계획 2 + 평가 2 + 답변 1), 계획 revision 2, replan 1이다. 구현·실행 전의 예상값이며 실제 결과에 맞춰 근거 없이 늘리지 않는다. 각 호출은 유한 transport가 명시한 알려진 input/output usage를 합산하고 예약이 모두 반환되어야 한다. 입력 추정은 실제 구조화 요청 바이트·출력 예약을 사용하고 `tokens:1` 대역으로 창 검사를 회피하지 않는다. 본 단위는 넉넉한 등록 창을 사용해 compact 호출 0을 기대한다.

transport는 호출 순번만 보고 정답을 내지 않는다. 적용 원문, packet의 현재 근거·가설·계획·작업 결과가 위 상태에 해당하는지 확인하고 그 상태에서 허용한 고정 응답만 낸다. 예상하지 못한 상태는 명시적으로 실패한다. oracle과 transport의 판정 코드를 공유해 같은 버그를 정답으로 인정하지 않는다.

## 실패 변형: 개정 자료가 없으면 질문 대기

같은 원문·도구 계약·첫 두 자료·계획을 사용하되, 판별 자료 `doc-a-amendment` 조회만 도구 경계에서 한 번 `error`, `retryable:false`, `coverage:unknown`으로 반환한다. 실패 전에 실제 success를 실행하거나 개정 Evidence를 미리 주입하지 않는다. `maxAttempts:1`로 설정해 무작정 재시도하지 않는다.

제공자는 현재 실패를 보고 “개정 원문을 확인하지 못해 현행을 확정할 수 없다. 유효한 개정 자료를 제공해 달라”는 질문을 낸다. task를 빈 배열로 바꿔 실패를 지우거나, `satisfied` 답변으로 바꾸지 않는다. 질문은 기존 `agent-question:<callId>` 의무와 outbox를 사용한다.

인수 기준은 다음과 같다.

- 원본 읽기 총 3회 중 old/B 성공 2회와 판별 실패 1회를 그대로 보존한다. 개정 Evidence가 없고 두 가설의 남은 충돌이 기록되어 있다. 성공 작업 재실행은 0회다.
- 예상 주턴 4회(최초 계획·초기 평가·판별 계획·실패 질문), 계획 revision 2·replan 1. 알려진 실패·질문 usage도 빠짐없이 정산하고 진행 중 예약이 남지 않는다.
- 결과 `complete`나 최종 결과 delivery는 없어야 한다. 질문 delivery 1개와 pending response obligation을 저장하고 `wait / pending_obligation`으로 끝난다. `step_limit`, 예산 소진, 알 수 없는 오류로 끝나면 이 인수의 성공으로 보지 않는다.
- 같은 담당을 다시 열고 resume해도 동일 질문을 중복 발송하거나 같은 판별 도구·모델을 재호출하지 않는다. 원문과 이전 실패 결과는 조회할 수 있어야 한다.

사용자가 이후 다른 원본을 제공해 재개하거나 기존 목표를 바꾸는 흐름은 이번 두 시험에 덧붙이지 않는다. 명시 목표 변경은 [후속 검토의 별도 단위](C04-after-registration-review.md)에 남긴다.

## 구현 순서와 종료 조건

1. 시험 helper에서 C01 저장소·등록 transport·실제 세 자료와 actor/policy를 조립하고, 입력·호출·원본 결과·이벤트·delivery를 관측한다. scope/tenant를 바꿔야 한다면 신뢰된 fixture 조립에서 한 번 정하고 자료 전체에 일관되게 적용한다.
2. 성공 흐름을 공개 application 경계로 연결한다. 도중에 상태를 직접 고쳐 완료시키지 않는다. 앞의 단계별 oracle와 실제 저장 input artifact를 대조한다.
3. 같은 helper의 판별 read 실패 변형을 추가한다. 질문 대기와 재접속 후 무호출을 확인한다. 필요한 제품 교정은 드러난 기존 경계의 결함에 한정해 기록한다.
4. root가 새 두 시험과 변경된 기존 모듈의 관련 회귀를 실행하고, 적용 범위에 맞는 저장소·계층·플랫폼 검증을 선정한다. 최종 source/build pin, 실패 및 수정, 종료/정리 결과를 별도 결과 문서에 저장한다. 계획 작성 시의 이전 통과 수를 새 구현의 결과로 사용하지 않는다.

후속 File-journal 전체 조합, compact 품질, 실제 사내 모델·API·tokenizer, 독립 반론 sub-agent, CLI/Web 목표 변경, PostgreSQL·Windows·Knox는 이번 종료 조건이 아니다. 이 단위가 통과하면 입증되는 것은 **기존 범용 런타임 계약이 고정된 복합 관측과 실패에서 함께 동작한다는 것**이다. 실제 모델이 스스로 좋은 가설·판별 계획·반론·정확한 답변을 만든다는 품질 검증은 별도로 남는다.
