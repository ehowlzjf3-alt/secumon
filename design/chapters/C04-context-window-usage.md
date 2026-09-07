# C04 모델 문맥 창 관리 — 사용 안내

2026-09-07 · 현재 코드에 있는 호스트 API를 설명한다. 같은 소스의 로컬 신규 71/71·관련 704/704와 Linux 전체 3,209/3,209 검증 범위는 [결과 문서](C04-context-window-result.md)를 따른다. 아래 숫자는 설정 의미를 설명하는 예이며 특정 모델의 권장값이나 실측값이 아니다.

모델이 한 번에 읽고 답할 수 있는 공간을 **문맥 창**이라고 한다. 이 기능은 다음 답변에 꼭 필요한 내용이 들어가는지 먼저 확인하고, 과거 대화가 너무 길면 필요한 구간을 요약해 작업을 이어간다. 에이전트의 장기기억을 지우거나 한 작업이 끝날 때 대화를 초기화하는 기능이 아니다.

## 설정할 값

| 이름 | 뜻 | 현재 설정 위치 |
|---|---|---|
| `maxInputTokens` | 모델 입력만 사용할 수 있는 최대 토큰 수 | `Planner.capabilities` 필수 값 |
| `contextWindowTokens` | 입력과 출력이 함께 쓰는 총 토큰 공간 | `Planner.capabilities` 선택 값 |
| `maxOutputTokens` | 모델이 지원하는 출력 상한 / 이번 호출의 출력 예약 | capability는 선택 상한, PlanningRuntime config는 이번 예약. 서로 구분한다. |
| `maxInputBytes` | 직렬화된 요청의 바이트 상한 | capability와 PlanningRuntime config 중 작은 값 |
| `maxRequestBytes` | 구조화 어댑터가 실제 송신 전에 검사하는 요청 크기 | StructuredPlanner/StructuredAgentTurn 설정. capability의 바이트 제한에도 반영된다. |
| 작업 `limits.tokens` | 해당 업무가 사용할 수 있는 누적 자원 예산 | 기존 작업 접수·장부. 모델 문맥 창과 별개다. |

입력 상한 32,000, 총 창 32,000, 이번 출력 예약 2,000이면 허용 입력은 30,000이다. 입력이 30,001이면 총 창에 맞지 않는다. 입력 토큰이 들어가도 바이트 상한을 넘으면 거절한다. 총 창을 등록하지 않은 기존 어댑터는 입력 상한만 적용하며 임의의 총 창을 만들어 넣지 않는다.

값은 양의 안전 정수여야 한다. 출력 예약이 등록된 출력 상한을 넘거나 총 창을 전부 차지하면 설정 오류다. 호출마다 적용되는 공통 계산은 [resolveModelInputLimits](../../runtime/src/application/model-input-budget.ts), 수치 검증은 같은 파일의 `assessInputFit`이 담당한다. PlanningRuntime 기본 요청 상한은 65,536바이트, 출력 예약은 2,048토큰이다. 이는 현재 호스트 기본값이며 모델 스펙이 아니다.

## 로컬 추정기 등록

추정기는 **모델을 호출하지 않고** 송신할 요청의 크기를 계산하는 함수다. [StructuredPlannerAdapter](../../runtime/src/infrastructure/structured-planner.ts)와 [StructuredAgentTurnAdapter](../../runtime/src/infrastructure/structured-agent-turn.ts)의 설정에 선택적인 `inputEstimator`를 넣을 수 있다.

```ts
// 호스트가 구성하는 설정의 일부. localCounter는 호스트가 별도로 제공한다.
inputEstimator: {
  profile: {
    id: 'company-model-input',
    revision: '1',
    templateRevision: 'company-request-v1',
    kind: 'conservative_estimate',
  },
  estimate(request, serialized) {
    return {
      tokens: localCounter.countRequest(request),
      bytes: Buffer.byteLength(serialized, 'utf8'),
      method: 'company-local-estimate-v1',
    };
  },
}
```

이 예시는 연결 모양이며 `localCounter` 구현을 제공하지 않는다. 실제 모델에 맞는 로컬 계산기를 별도 검증해야 한다. 지시문·원문·도구 정의·반환 형식·이전 답변 등 어댑터 요청 전체를 계산해야 한다. 추정 경로에서도 원래 권한·프롬프트·형식 검사는 유지된다. 너무 큰 요청은 측정 단계에서 수치를 반환할 수 있지만 실제 송신 경계의 크기 검사는 생략되지 않는다.

`profile`은 추정기의 등록 정보다. `id`는 이름, `revision`은 계산 방식 버전, `templateRevision`은 요청 포장 버전이다. `kind`는 `tokenizer`, `conservative_estimate`, `legacy_adapter_revision` 중 하나이며, 정확한 모델 토큰화기를 검증한 경우에만 `tokenizer`라고 등록한다. 계산기나 요청 포장을 바꾸면 해당 버전도 바꿔야 한다. 함수 구현 자체의 변경을 자동으로 알아내는 기능은 없다.

미등록 구조화 어댑터의 기본 추정은 UTF-8 바이트 수를 토큰 수로 사용하는 보수적 방식이다. 모델 이름만 보고 전역 tokenizer를 고르거나 네트워크로 계산하지 않는다. 기존 `estimateInput`, `estimateTurnInput`, `estimateCompactInput` 포트도 유지한다. compact를 제공하는 별도 Planner는 자신의 전체 compact 요청을 `estimateCompactInput`에서 계산해야 하며, 일반 주턴 어댑터를 등록했다고 compact 구현까지 생기지는 않는다. [등록 구현](../../runtime/src/infrastructure/model-input-estimator.ts), [목적별 포트](../../runtime/src/application/ports.ts).

추정 결과의 `tokens`는 양의 안전 정수, `bytes`는 음이 아닌 안전 정수이며 실제 입력 포장의 바이트 수보다 작을 수 없다. `method`는 비어 있지 않은 계산 방식 이름이다. 잘못된 값이나 계산기 예외를 과거 대화를 더 지워도 된다는 신호로 취급하지 않는다.

## 자동 동작과 명시 요청

일반 업무 실행은 기존 `workflow.run(workId, actor, options)`를 사용한다. 호스트가 지속 세션과 compact provider를 함께 조립했다면 다음 모델 입력 검사와 필요 시 자동 compact가 연결된다. 별도의 자동 요약 엔진을 호출할 필요는 없다.

| 내부 판단 | 이어지는 동작 |
|---|---|
| `fits` | 현재 요청이 들어간다. 기존 예방적 compact 기준은 유지하되, 선택적인 compact의 용량 부족만으로 들어가는 실제 요청까지 막지 않는다. |
| `needs_session_compact` | 현재 원문은 남기고 과거의 완전한 구간을 요약한다. 요약 채택 후 실제 입력을 다시 측정한다. |
| `required_overflow` | 현재 원문이나 필수 상태부터 넘는다. 자동 compact 호출을 만들지 않고 필수 입력 초과를 반환한다. |

이미 채택한 계획의 도구 실행과 검증된 답변 전달은 새 모델 호출이 아니므로 이 입력 창 검사를 이유로 막지 않는다. `enablePlanning:false`인 compact 전용 배치도 기존대로 가능하며, 비활성 주 모델의 입력 공간을 계산하려고 하지 않는다.

호스트가 명시적으로 대화만 정리하려면 기존 API를 사용한다.

```ts
const call = await runtime.compactPlanning.requestCompact(workId, {
  force: true,
  requestId: 'host-issued-stable-id',
  expectedGoalRevision: currentGoalRevision,
});
// 다음 호스트 실행 단계에서 진행한다. 실제 반복은 호스트의 유한한 실행 제어를 따른다.
await runtime.compactPlanning.compactStep(workId, { auto: false });
```

`runtime.compactPlanning`이 실제로 구성되어 있을 때의 예다. `requestCompact`는 예약하며, `compactStep` 한 번이 전체 완료를 보장하지는 않는다. `auto:false`는 이미 진행 중인 compact만 처리하고 새 일반 계획·도구 호출을 시작하지 않는다. 동일 request ID는 같은 요청의 재전송에 사용하며 다른 내용에 재사용하지 않는다. `force`도 현재 원문을 삭제하거나 창 제한을 우회하지 않는다.

현재 일반 CLI는 `secumon-agent chat … --provider synthetic --compact-provider synthetic`으로 명시 합성 흐름을 연결한다. 자유 문장 모델이 아니며 지원 고정 원문은 `chat --help`에 나온다. `chat`에는 이번 문맥 창 값을 변경하는 새 CLI 옵션이나 명시 compact 하위 명령을 추가하지 않았다. 기존 작업 CLI의 `work compact`와 Web의 문맥 정리 경로는 유지된다. 임의 모델 등록·창 설정은 현재 TypeScript 호스트 조립 경계에서 하는 일이다. [일반 CLI](../../runtime/src/presentation/agent-turn-cli.ts), [기존 작업 CLI](../../runtime/src/presentation/cli.ts).

## 세션 구간 설정과 측정 API

호스트는 `composeRuntime({ session: { repository, agentId, compact: { … } }, … })`로 세션 기준을 설정한다. 명시 합성 프로필인 `openAgentTurnProfile`에는 `compactLimits`가 있다.

| 세션 설정 | 기본값 | 의미 |
|---|---:|---|
| `maxContextBytes` / `maxContextEntries` | 65,536 / 256 | 원문·요약을 읽어 정상 세션 문맥으로 만들 때의 상한 |
| `triggerRatio` / `targetRatio` | 0.8 / 0.6 | 기존 예방적 정리 시작·목표 비율 |
| `keepRecentEntries` | 8 | 비강제 정리의 기본 최근 원문 유지 수. 강제 정리도 최소 현재 원문 1개는 남긴다. |
| `maxCompactInputBytes` / `maxCompactEntries` | 49,152 / 64 | 한 compact 후보의 원문 구간 상한 |
| `maxSummaryBytes` | 8,192 | 생성·검증할 요약 내용의 바이트 상한 |

이 값만으로 모델에 들어간다고 판정하지 않는다. 최종 요청 전체의 모델 추정과 출력 예약도 함께 통과해야 한다. 후보는 완전한 항목 단위로 반감하며 설정 최대 256항목에서도 최초 포함 9회 이내로 로컬 측정한다. 탈락 후보는 실제 모델 호출·토큰 사용으로 정산하지 않는다.

직접 조립하는 호스트가 사용할 수 있는 내부 공개 API는 다음과 같다. 일반 사용자 명령에서 모두 직접 호출할 필요는 없다.

| API | 결과와 주의점 |
|---|---|
| `sessions.inspectContext(state)` | 게시 없는 complete/capacity draft. capacity에는 잘린 `entries`를 넣지 않고 현재 원문·이전 요약·전체 manifest를 반환한다. |
| `sessions.draftCurrent(state, draft)` | draft가 현재 입력·출처와 같은지 읽기 전용으로 확인한다. |
| `sessions.materializeContext(state, draft)` | complete만 기존 세션 head 게시 경로로 전환한다. capacity는 거절한다. |
| `context.inspect(state, limits)` / `planning.turns.inspect(state, callId, limits)` | 필수 부분·선택 부분의 크기와 세 가지 판단을 돌려준다. head 없는 preview는 송신 자료가 아니다. |
| `context.materialize(inspection)` / `planning.turns.materialize(inspection)` | 같은 인스턴스가 만든 fits 준비를 한 번 소비해 실제 입력을 만들고 다시 검사한다. JSON으로 복사한 검사 결과는 이 준비를 대신하지 못한다. |
| `sessions.prepareCompact(state, { measure, … })` | 동기 로컬 callback이 `fit`/`too_large`를 반환한다. 일반 실행에서는 SessionCompactCalls가 전체 요청 추정 callback을 제공한다. |

preview에는 아직 게시하지 않은 세션 head 대신 제한된 메타데이터 여유 512바이트·512토큰 단위를 별도로 더한다. 이것은 선택 힌트이며 tokenizer의 정확한 헤더 비용이라고 주장하지 않는다. 실제 게시한 요청을 반드시 다시 측정한다. [preview 구현](../../runtime/src/application/model-context-preview.ts).

## 오류를 읽는 방법

아래는 코어·호스트 API의 오류다. 모든 코드가 현재 CLI/Web에서 각각 친절한 문장이나 독립 HTTP 상태로 표시되는 것은 아니다. 상위 오류의 `cause`에 원인이 보존되는 경로도 있다.

| 코드 | 의미·대응 |
|---|---|
| `model_window_configuration_invalid` | 상한·출력 예약·등록 정보가 유효하지 않다. 호스트 설정을 고친다. |
| `model_input_estimate_invalid` | 추정값이 잘못됐거나 요청 바이트를 과소 보고했거나 등록 추정기가 실패했다. 추정기를 점검한다. |
| `model_input_required_overflow` | 현재 원문·필수 상태만으로 초과한다. 더 적합한 창이나 명시적인 요청 범위 조정이 필요하다. 자동 원문 삭제로 해결하지 않는다. |
| `model_input_limit` / `model_request_too_large` | 최종 입력 또는 실제 어댑터 요청이 한도를 넘는다. preview 적합은 실제 송신 허가가 아니다. |
| `session_compact_capacity` | 더 작은 유효 원문 구간도 compact 입력에 들어가지 않거나 정리할 구간이 없다. 원문은 보존된다. |
| `session_compact_unavailable` / `session_compact_failed` | 요약 제공자가 없거나 진행이 실패했다. 호출·영수증 상태와 원인을 확인한다. |
| `model_input_profile_changed` / `context_state_changed` | 준비 중 설정·상태가 바뀌었다. 낡은 준비를 재사용하지 않고 현재 상태에서 다시 판단한다. |
| `session_context_changed` / `model_session_changed` | 원문·세션·요약 기준이 달라졌거나 확인할 수 없다. 변경·결손을 용량 문제로 바꾸지 않는다. |

예산 부족은 별도다. 창이 충분해도 작업의 남은 모델 호출·토큰 자원이 없으면 기존 장부가 실행을 막는다. 이미 받은 응답의 사용량과 원본은 설정 변경 뒤에도 보존하고 기존 채택·정산 경로로 처리한다.

## 보존되는 것과 남은 것

대화 원문 이력, 세션 요약, 선택한 개인 장기기억, 도구 결과 산출물, 작업 상태·자원 장부는 서로 다른 기록이다. compact는 원문 이력을 없애지 않고 필요한 요약 참조를 다음 문맥에 붙인다. 개인 기억 정정·삭제, 게시판·아카이브 정책을 자동으로 대신하지 않는다. 준비 한 개를 잠시 보관하는 캐시도 에이전트 장기기억이 아니다.

현재 시험은 명시 합성 제공자와 요청 크기 계산·정산·출처·재시작을 검증한다. 실제 모델별 토큰 정확도, 요약 품질, 전체 지연·비용 절감, Windows native·PostgreSQL·사내 메신저 배치는 별도 검증이 필요하다. 실제 모델/API 호출 중단은 유지한다.
