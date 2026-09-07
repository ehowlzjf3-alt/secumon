# C04 등록 모델 연결 뒤 남는 범위 — 검토 초안

2026-09-07 · 읽기 전용 조사. 등록 모델 단위의 최종 검증·정리가 끝난 뒤 사용할 후속 메모이며, C04 완료 판정이 아니다. 현재 등록 코드와 회귀는 존재하지만 검증이 진행 중이다. 이전 [문맥 창 확정 증거](../../runtime/evidence/C04-window-linux-nas-20260907/verification.json)는 이전 소스의 결과로 유지한다. 이번 조사에서는 제품·시험·기존 계획·증거를 수정하거나 시험을 실행하지 않았다.

**다음 일은 새 추론 프레임워크가 아니다.** 일반 요청으로 들어온 복합 조사를 기존 가설·계획·실행·응답 경로에서 끝까지 확인하고, 별도로 명시적 목표 변경을 일반 CLI/Web에 연결하면 된다. 실제 모델의 의미 판단 품질은 중단된 API 시험과 함께 별도 미검증으로 남는다.

## 구현과 남은 확인을 구분

| 요구 | 현재 코드에서 확인한 경로 | 정확히 남는 부분 |
|---|---|---|
| 일반 요청·직접 답변·질문·읽기 후 답변 | `AgentTurnService.accept/followUp` → `PlanningRuntime` → 기존 executor/outbox. 질문 답변과 추가 입력은 같은 업무의 적용 원문을 갱신한다. | 첫 흐름을 다시 구현하지 않는다. 등록 단위의 최종 pin·실제 검증 결과만 확정한다. |
| 모델 등록·주턴/compact 연결 | `host-models.ts` → `openAgentTurnProfile` → `StructuredAgentModel`; CLI/Web이 같은 조립을 사용한다. | 등록 코드가 이미 있으므로 상위 계획의 “아직 미구현” 문구는 이번 단위의 결과 확정 때 갱신할 역사적 상태다. 실제 사내 transport 접속 성공을 의미하지 않는다. |
| 가설·지지/반증·판별 관측 | `Hypothesis`에 질문·주장·예상 관측·반증 조건·근거 ID가 있고, 주턴의 `plan`도 `validatePlan`을 거친다. 새 관측은 `hypothesesRequireReview`로 검토를 다시 요구한다. | **일반 입구에서의 복합 통합 검증**이 남는다. 반론 문장이나 자체 검토를 새로운 독립 Evidence로 만들지 않는지 확인한다. |
| 필요한 부분만 재계획 | `applyValidatedPlan(..., true)`는 동일 작업 목록의 평가 갱신에 계획 버전·replan 비용을 올리지 않는다. 변경된 그래프만 새 버전을 만들고, 같은 ID/실행 계약의 성공한 작업은 `taskSucceeded`로 재사용한다. | 코어는 존재한다. 일반 응답 업무에서도 영향 없는 성공 작업이 다시 실행되지 않고, 바뀐 판별 작업만 실행되는지 끝까지 확인한다. 전체 그래프 제출 방식이므로 별도 patch 언어는 필요 없다. |
| 실패·무진전·불확실성·완료 | 기존 control/진행·예산 gate와 질문 의무를 사용한다. `needs_work`, 미완료 작업, 미검토 가설, 미해결 의무는 응답 완료를 막는다. | 기존 단위 시험을 복제하지 말고 복합 흐름에 읽기 실패 한 가지를 넣어 회복 또는 명시 대기로 끝나는지 확인한다. 의미상 충분한 답변인지는 별도 평가다. |
| 사용자의 명시 목표 변경 | `SessionService.command`와 `ExecutionRuntime.command(kind:'goal')`에 원문 영수증·목표/제어 버전 검사·진행 호출 중단·전달 무효화가 있다. | **일반 입구가 미연결**이다. `AgentTurnService.followUp`은 continue/clarify만 지원하고, chat CLI에 목표 변경 명령이 없으며, 일반 Web은 goal 명령을 거절한다. |

근거: [일반 입력 서비스](../../runtime/src/application/agent-turn-service.ts), [주턴 채택](../../runtime/src/application/planning-runtime.ts), [계획 검사·채택](../../runtime/src/application/plan-validator.ts), [가설 검토](../../runtime/src/domain/hypotheses.ts), [작업 재사용](../../runtime/src/domain/task-status.ts), [완료 판정](../../runtime/src/domain/completion.ts), [일반 프로필](../../runtime/src/presentation/agent-turn-profile.ts).

## 다음 최소 단위 1: 일반 입구의 복합 조사 인수

이미 있는 [model-runtime.test.ts](../../runtime/src/tests/model-runtime.test.ts)의 늦은 반증·평가만 갱신·한 번의 그래프 변경 시나리오는 기존 사실 조건 업무를 검사한다. [agent-response-completion.test.ts](../../runtime/src/tests/agent-response-completion.test.ts)는 응답 업무의 완료 우회를 검사한다. [registered-agent-flow.test.ts](../../runtime/src/tests/registered-agent-flow.test.ts)는 단일 자료 읽기·반복 compact·답변·재접속을 검사한다. 이 세 경계가 **하나의 일반 요청에서 함께 작동하는지**가 남은 인수 공백이다. 기존 시험의 실행 이력과 이 새 결합의 검증은 구분한다.

하나의 결정적 제공자와 실제 임시 C01 저장소로 다음 흐름을 끝낸다. 일반 원문 접수 → 두 설명을 구분하는 읽기 계획 → 지지 관측 → 늦은 반증 → 영향 있는 작업만 추가/대체 → 근거를 인용한 답변 → 전달·완료. 중간에 compact 또는 재접속 한 번을 넣고, 원문·반증·유효한 작업 성공·사용량이 보존되는지 본다. 실패 변형은 판별 읽기 한 건의 실패 후 대체 읽기 또는 필요한 질문으로 한정한다.

관측할 것은 최종 답변의 문구만이 아니다. 모델 입력에 실제 가설·반증 ID가 전달됐는지, 현재 관측으로 평가했는지, 같은 작업이 중복 호출되지 않았는지, 단순 평가와 그래프 변경의 replan 사용량이 다른지, 완료가 판별 작업/미해결 의무보다 먼저 일어나지 않았는지를 확인한다. 합성 답변의 정답은 fixture가 정한 것이며 실제 모델의 추론 품질로 표시하지 않는다.

현재 일반 local 프로필의 자료 도구는 `doc-current` 한 건만 제공한다. 복합 시험에는 기존 `documents-complex` 자료와 `FixtureReadTool`을 신뢰된 시험 호스트에서 조립해 사용한다. 등록 factory는 모델만 반환하는 계약을 유지한다. 이 시험을 이유로 임의 HTTP 도구 주입, 전역 도구 등록 재작성, 운영 배치 설정을 추가하지 않는다. 공개 CLI/Web은 같은 application 입력 경계를 사용함을 좁게 확인하고, 필요한 조립 확장이 실제로 드러난 경우에만 별도로 결정한다.

현재 가설과 판별 작업의 관계는 설명·예상 관측·반증 조건 및 Evidence ID로 표현된다. 별도 `hypothesisId → taskId` 필수 필드는 없고, 검사기는 문장의 의미적 타당성까지 증명하지 않는다. 먼저 위 흐름에서 관계와 결과를 독립 fixture 기대값으로 확인한다. 구조 필드를 늘리는 일은 그 검증에서 구체적 필요가 확인될 때만 검토한다.

## 다음 최소 단위 2: 명시적 목표 변경 연결

기존 추가 입력은 **원래 목표를 유지하며 보충**하는 행위다. 같은 세션의 새 `ask`는 별도 업무다. 기존 업무의 목표를 교체하는 명령은 둘과 구분해 CLI/Web에서 명시적으로 받는다. 자연어 문장을 보고 모델이 몰래 목표를 교체하도록 하지 않는다.

작은 application 메서드가 사용자 원문과 안정적인 message/command ID, 현재 목표 버전, 제어 버전을 받아 기존 `SessionService.command(kind:'goal')`로 넘기면 된다. 새 응답 목표의 description과 `responseRequirement.requestMessageId/requestTextDigest`는 이번 명시 원문에 맞춰 호스트가 만든다. 정책·scope·완료 조건을 모델이나 HTTP 임의 객체가 바꾸는 입구는 만들지 않는다. 범위 변경까지 필요하면 허용 규칙을 별도로 정한다.

인수는 네 가지면 충분하다.

1. 같은 세션·업무에서 목표가 정확히 한 버전 전진하고, 원문/이전 호출/근거/정산은 보존된다. 추가 입력은 목표 버전을 바꾸지 않는다.
2. 같은 명령 재전송은 중복 변경·중복 호출을 만들지 않는다. 낡은 목표/제어 버전이나 다른 담당·사용자·세션은 거절한다.
3. 이전 목표의 진행 중 모델 응답·도구 결과·대기 전달은 새 목표의 완료 근거가 되지 않는다. 실제 발생한 usage는 유지한다.
4. 원문 접수와 적용 사이 중단 후 재개해도 같은 변경 영수증을 사용한다. 새 목표의 답변을 검토·전달한 뒤에만 완료한다.

근거: [세션 명령](../../runtime/src/application/session-service.ts), [기존 목표 변경 코어](../../runtime/src/application/execution-runtime.ts), [일반 CLI](../../runtime/src/presentation/agent-turn-cli.ts), [일반 Web의 현재 거절](../../runtime/src/presentation/local-workbench.ts), [목표/제어 원자성 회귀](../../runtime/src/tests/goal-control-atomic.test.ts).

## 이 두 단위와 분리할 미완료 사항

실제 모델의 가설·반론·요약·완료 판단, tokenizer 정확도, 제공자별 실제 usage/취소 준수는 API 시험 중단 상태로 남긴다. 등록과 구조화 대역의 성공이 이를 대신하지 않는다. 독립 반론 에이전트·동료 위임은 C08, 실제 도구/스킬·권한 배치와 Knox는 C05/C06, PostgreSQL 및 Windows 저장·실행 연결은 해당 잔여 장의 책임이다. 이들을 먼저 구현해야 위 두 단위를 시작할 수 있는 것은 아니다.

착수 조건은 이번 등록 단위의 최종 소스·필수 검증·자원 회수 증거 확정이다. 그 다음 **복합 흐름 인수부터 시작하고, 드러난 최소 연결만 보강한 뒤 명시 목표 변경**으로 이어간다. 기존 저장소·문맥 창·호출 장부·계획 검사기를 다시 만드는 단계는 넣지 않는다.
