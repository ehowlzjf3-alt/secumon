# C04 모델 입력 창에 맞춘 문맥과 compact — 실행한 계획

2026-09-07 · **이 계획의 문맥 창 단위를 구현하고 검증했다.** 같은 최종 소스의 로컬 신규 71/71·관련 704/704, Linux 전체 3,209/3,209와 정리 기록은 [구현 결과](C04-context-window-result.md)를 따른다. 아래 공백과 구현 순서는 착수 당시 계획으로 보존하며 미구현 목록으로 읽지 않는다. 남은 C04 범위는 [후속 검토](C04-after-window-review.md)에 정리했다.

완성할 흐름은 **현재 상태와 출력에 필요한 공간 계산 → 불필요한 도구·결과 본문 축소 → 실제 요청 추정 → 필요하면 들어가는 크기의 원문 구간만 compact → 같은 업무의 실제 답변 입력 재조합**이다. 작은 모델에서 원래 들어갈 수 있는 구간까지 용량 오류로 포기하는 문제를 줄인다. 모든 작은 창에 맞출 수 있다고 보장하지 않는다. 현재 사용자 원문이나 필수 상태만으로 한도를 넘으면 원문을 버리지 않고 명시적으로 멈춘다.

근거는 [C04 원래 계획](C04-general-turn-plan.md), [전체 계획 C04](../03-migration-plan.md), [백로그의 C02_compact_model_window_allocation](../implementation-backlog.json)과 현재 코드를 읽은 결과다. 실제 모델/API 시험은 계속 중단한다.

## 1. 재사용할 현재 연결과 정확한 공백

| 위치·심볼 | 이미 연결된 동작 | 이번에 필요한 차이 |
|---|---|---|
| `application/ports.ts`: `Planner.estimateInput/estimateTurnInput/estimateCompactInput`, `ModelCapabilities` | 목적별 요청 크기를 추정할 포트와 입력 토큰 한도가 있다. | 현재 능력값에는 총 문맥 한도와 출력 한도의 구분이 없다. 추정기의 모델·템플릿 버전과 추정 신뢰 수준도 고정된 계약이 아니다. |
| `infrastructure/structured-planner.ts`, `structured-agent-turn.ts`: `requestSnapshot`, `estimate*` | 지시문·도구 정의·원문·previousAnswer를 포함한 제공자 요청을 만든다. 현재 추정은 UTF8 바이트를 토큰 수로 사용한다. | 해당 모델에 등록된 로컬 추정기로 같은 요청을 계산한다. 이것을 정확한 모델 tokenizer라고 부르지 않는다. `requestSnapshot`의 바이트 초과 예외가 선택 항목 축소 전에 추정을 중단할 수 있는 점도 처리한다. |
| `application/context-compiler.ts`: `prepare`, `protectedInput` | 필수 상태를 보호하고 도구·근거·결과·지침·attempt를 선택한다. 완성 요청을 다시 추정하며 선택 공간을 최대 5번 줄인다. | 이 선택기를 다시 만들지 않는다. 다음 주 턴의 필수 공간과 세션이 쓸 수 있는 공간을 같은 조립 경로에서 구해 compact 필요성 판단에 전달한다. |
| `application/session-compactor.ts`: `prepareCompact` | 원문·이전 요약·prefix와 현재 입력을 검증하고 기본 최대 64개 구간에서 최근 원문을 남긴다. | 현재 `maxInputBytes×0.75`, `maxInputTokens×3`, `bytes(input)+256`은 초기 휴리스틱이다. 제공자 요청의 실제 추정에 맞춰 유한하게 구간을 다시 줄이는 연결이 없다. |
| `application/session-compact-runtime.ts`: `SessionCompactCalls.prepare` | 구간을 받은 뒤 `{compact, options}`를 추정한다. | 지금은 한 구간을 한 번 추정한다. 추정 초과가 확인되면 예약 전에 더 작은 유효 prefix를 선택하도록 연결한다. |
| `application/planning-runtime.ts`: 예약, `compactStep` | 입력 초과 거절, 입력+출력 자원 예약, 호출·응답 보존·정산·재개가 있다. | 자원 장부의 토큰 한도와 모델의 총 문맥 한도를 구분한다. 실제 주 턴이 들어가는지 판단한 결과로 자동 compact를 요청한다. |

`ContextMemo.mode='compact'`의 도구 축출, 세션의 의미 요약, 개인 장기기억은 계속 별개다. `SyntheticSessionCompactPlanner`의 토큰 추정값 1은 합성 규칙 실행용이며 작은 실제 모델 창이 검증됐다는 근거가 아니다.

## 2. 최소 계약과 공간 계산

기존 목적별 `estimate*` 포트를 유지하고 공통 반환 타입을 이름 붙인다. 현재 `{tokens, bytes, method}`는 계속 읽을 수 있게 하며, 새 추정기에는 모델/요청 템플릿의 고정 버전과 `tokenizer` 또는 `conservative_estimate` 구분을 추가한다. 모델명만 보고 전역 tokenizer를 추측하지 않는다. 등록한 로컬 계산만 수행하고 네트워크로 토큰 수를 조회하지 않는다. 지원하지 않는 모델은 기존 보수적 바이트 추정으로 남기거나 등록 단계에서 명시적으로 거절한다.

`ModelCapabilities`와 등록 설정에 선택적인 `contextWindowTokens`(입력과 출력이 함께 사용하는 창), `maxOutputTokens`를 추가한다. 기존 `maxInputTokens`는 입력 자체의 한도로 그대로 해석한다. 총 창을 제공하지 않은 기존 설정은 그 사실을 기록하며 임의 값을 채우지 않는다.

```text
허용 입력 토큰 = min(등록된 입력 한도, 등록된 총 창 - 이번 출력 예약)
                 // 총 창이 없는 설정에서는 두 번째 항을 사용하지 않음
최종 요청 추정 ≤ 허용 입력 토큰
최종 요청 바이트 ≤ 요청 바이트 한도
이번 출력 예약 ≤ 등록된 출력 한도  // 출력 한도가 등록된 경우
```

양의 안전 정수와 합산 초과를 검사한다. 출력 예약은 몰래 줄이지 않으며, 출력만으로 창을 소진하면 설정/용량 오류다. 보수적 템플릿 여유를 추정에 넣었다면 다른 층에서 중복 차감하지 않는다. 실제 사용량 정산은 기존 모델 응답의 usage를 따른다. 이 계산을 새 자원 배정 장부로 만들지 않는다.

모델별 추정은 송신할 **동일한** 지시문·요청 포장·도구 schema·반환 형식·선택된 previousAnswer를 포함한다. 구조화 어댑터의 추정 경로는 권한/형식 검사를 유지하면서 크기 초과도 수치로 반환하여 축소 판단에 쓸 수 있게 한다. 실제 `turn/propose/compact` 송신 경계의 크기 제한은 유지한다. 잘못된 형식·권한 오류·비정수 추정은 축소 재시도 대상으로 바꾸지 않는다.

## 3. 필수 입력을 먼저 계산하고 세션 공간을 결정한다

`ContextCompiler.prepare`의 기존 조립을 재사용해 읽기 전용 크기 판단을 분리한다. 새 독립 compiler나 두 번째 source 조회 엔진은 만들지 않는다. 같은 현재 상태로 계산한 최소 구성과 최종 구성을 이용한다.

- 목표/정책, 현재 가설·반론 연결, 미완료 의무, 미정산 작업, 실행 장부·기한, 필수 근거와 읽기/컴퓨터 진행 참조는 기존 `protectedInput`의 의미대로 유지한다.
- 현재 적용된 사용자 원문은 그대로 남긴다. 선택된 개인 기억과 이전 초안을 공간 확보를 이유로 몰래 제거하지 않는다. 개인 기억 축출 정책 변경은 C05의 별도 단위다.
- 현재 frontier·새로 요청한 도구·discovery 등 기존 필수 도구 판정을 유지한다. 선택 가능한 도구/결과 본문은 `selectContextItems`의 기존 full/reference/omitted 규칙을 사용한다.
- 도구 schema는 이번 모델 **입력**이고 모델이 답할 공간은 **출력 예약**이다. 아직 실행하지 않은 모든 도구의 원응답을 미리 현재 입력으로 세지 않는다. 이후 큰 도구 결과는 기존 산출물 참조/페이지 조회로 다룬다.

세션에 줄 공간의 초기 제안은 필수 부분의 측정에서 얻는다. tokenizer는 조합에 따라 길이가 달라질 수 있으므로 부분별 토큰 수를 뺀 결과를 정확한 적합 판정으로 사용하지 않는다. 최종 조합을 다시 추정하는 검사가 항상 마지막 기준이다. 부분 크기 측정용 임시 구성은 송신하거나 `ContextFrame`/세션 head로 저장하지 않는다.

최소 필수 입력 자체가 넘으면 `model_input_limit`의 원인을 필수 상태/현재 원문/출력 공간 중 어디인지 구분해 종료한다. 세션 과거 부분 때문에 넘고 유효한 prefix가 있다면 기존 실행 조정자에게 compact 필요를 알린다. compiler 안에서 모델을 호출하지 않는다. 크기 판단의 재사용은 같은 state revision·정책·source 기준 안에 한정하고, 다른 입력이나 재시작에서는 다시 검증한다.

## 4. compact 구간을 예약 전에 유한하게 줄인다

`SessionCompactSource.prepareCompact` 옵션에 **읽기 전용 측정 callback**을 작게 추가한다. `SessionCompactCalls.prepare`가 같은 call ID·출력 예약·제공자 추정기를 고정한 callback을 제공한다. callback 자체를 저장하거나 provider 호출로 구현하지 않는다.

1. `SessionCompactor.prepareCompact`가 지금처럼 기존 요약, eligible 원문과 각 prefix manifest를 한 번 제한 범위에서 읽는다. pending 입력을 건너뛰어 완료 prefix를 만들지 않는다.
2. 첫 후보부터 callback으로 전체 `{compact, options}`와 제공자 포장을 추정한다. 바이트·토큰 모두 들어가면 선택한다.
3. 초과하면 **완전한 원문 항목 단위**로 count를 줄이고 기존 prefix 목록에서 새 manifest와 `inputDigest`를 계산한다. 예: 64→32→16→8→4→2→1. 설정 상한 256개에서도 최초 포함 최대 9회로 끝내고 매번 count가 감소하도록 한다. 가장 큰 가능한 구간을 찾기 위한 추가 탐색은 첫 단위에 넣지 않는다.
4. 현재 입력보다 앞선 prefix만 허용하고 강제 compact도 최근 원문 최소 1개를 남긴다. 이전 요약과 보호 항목은 유지한다. 원문 한 개나 보호 요약 자체가 들어가지 않으면 `session_compact_capacity`로 끝낸다. 원문 쪼개기·자동 기억 삭제·출처 없는 짧은 요약 생성은 하지 않는다.
5. 최종 후보만 기존 모델 호출로 예약하고 입력 산출물을 저장한다. 크기 비교로 탈락한 후보마다 modelCalls/토큰을 배정하거나 사용량을 늘리지 않는다. 실제 호출 이후의 실패·취소·CAS 충돌은 지금처럼 정산한다.
6. 게시·채택 후 실제 주 턴 입력을 재조합하고 같은 모델 창으로 다시 검사한다. 아직 넘으면 기존 `compactStep`/`WorkflowRuntime`의 유한 단계·무진전 경계를 통해 다음 구간으로 진행한다. 크기가 줄지 않은 후보의 거절은 유지한다.

추정 과정에서 새 입력·정책·출처·이전 요약 기준이 바뀌면 이전 prefix를 이어 붙이지 않고 현재성 실패로 되돌린다. 이미 예약한 입력은 다시 잘라 같은 call ID에 덮어쓰지 않는다. 저장된 응답이 있는 재시작은 기존 input/reply/publication 영수증으로 재개하고 다시 모델을 부르지 않는다. 새 창/추정 설정은 어댑터 버전 또는 명시적 설정 지문에 귀속하여 예약 후 설정이 바뀐 미실행 호출을 재검사한다. 기존 semanticVersion 2/3/4와 저장된 호출의 해석을 일괄 바꾸지 않는다.

## 5. 구현 순서와 바꿀 파일

| 순서 | 수정 범위 | 완료되는 연결 |
|---|---|---|
| A | `application/ports.ts`, 필요 시 작은 신규 `application/model-input-budget.ts`; `infrastructure/structured-planner.ts`, `structured-agent-turn.ts` | 모델 한도/추정 타입, 목적별 동일 요청 추정, 입력·출력·총 창 계산. 기존 설정 호환. |
| B | `application/context-compiler.ts`, `agent-turn-runtime.ts`, `planning-runtime.ts` | 기존 필수/선택 구성으로 다음 턴의 공간과 compact 필요 판단. 현재 source/previousAnswer 검증 재사용. |
| C | `application/session-compact-ports.ts`, `session-compact-runtime.ts`, `session-compactor.ts`; 필요한 경우 `workflow-runtime.ts`의 기존 compact 요청 연결만 | 측정 callback, 단조 감소하는 구간 선택, 최종 구간만 예약, compact 뒤 실제 답변 재개. |
| D | 필요할 때만 `domain/context.ts`, `application/contracts.ts`의 선택적 metrics, 기존 호출 저장 schema | 추정 방식/설정 지문, 필수 입력 크기, 최종 요청 크기, 출력 예약, 축소 횟수와 종료 이유를 고정 입력 또는 기존 metrics에 남김. 값 중복 저장은 피함. |

A→C는 하나의 사용자 흐름을 완성하는 순서다. 추정 helper의 단위시험만으로 끝내지 않는다. `sqlite-sessions.ts`, summary CAS/receipt, SessionOriginals, agent-owned 저장소, 메모리 이관·문서 정본은 재구현하거나 schema 이행하지 않는다. C05의 장기 source 재검증 I/O 최적화·도구 랭킹·일반 캐시는 이번 완료 조건에 추가하지 않는다.

## 6. 필요한 회귀와 완료 게이트

기존 `context-compiler`, `context-selection`, `session-compact-runtime`, `session-compact-flow`, `agent-turn-compact`, `agent-turn-boundaries`, `generated-answer` 시험을 재사용하고 다음 차이만 추가한다.

1. **전체 요청 측정**: 한국어·ASCII·도구 schema·프롬프트·previousAnswer가 큰 합성 요청에서 등록 추정기에 실제 송신과 같은 내용을 전달한다. 바이트와 토큰을 독립 제한하며 비정수/과소 바이트/추정 오류는 호출 전에 거절한다.
2. **창과 출력**: 입력 자체는 들어가지만 출력 예약을 더하면 총 창을 넘는 경계, 정확한 한도/한도+1, 총 창 미등록 기존 설정을 확인한다. 미정산/사용량 불명은 기존대로 다음 예약을 막는다.
3. **필수 상태 보존**: 긴 세션과 큰 필수 도구를 함께 넣는다. 선택 항목 축소→compact→최종 답변에서 목표·반론/의무·현재 사용자 원문·선택 기억·필수 도구가 유지된다. 최소 필수 부분 초과 때 provider 호출·새 호출 예약·요약 게시가 0이어야 한다.
4. **구간 조정**: 첫 휴리스틱 후보는 초과하지만 더 작은 완전 prefix는 들어가는 추정기를 사용한다. 유한 횟수, prefix/digest 대응, 단 한 번의 실제 compact 호출과 정상 정산을 확인한다. 한 원문도 안 들어가는 경우와 강제 compact의 최근 원문 보존을 포함한다.
5. **재시작/늦은 변경**: 조정 도중 입력·정책 변경, 예약 후 추정 설정 변경, 응답 저장 뒤 재개에서 낡은 호출을 새 설정으로 몰래 바꾸지 않는다. 기존 실제 중단/영수증 재개 시험에 조정된 입력 한 사례를 연결하고 기존 중단 suite를 새로 복제하지 않는다.
6. **끝까지 연결**: 실제 담당 저장소+SessionService+PlanningRuntime에서 작은 **합성** 창으로 여러 구간 compact 후 CLI 또는 Web 최종 답변까지 확인한다. 원문·개인 기억·업무 장부가 유지되고, 새로운 작업에서도 같은 세션이 이어져야 한다. 두 state backend의 기존 조립 회귀를 재사용한다.

완료는 관련 타입/계층 검사, 위 집중 회귀, 최종 고정 소스의 필수 통합 검증과 증거 기록까지다. 변화나 미해결 실패 없이 전체 검증을 반복하지 않는다. 합성 창의 통과는 용량 계산·현재성·수명 검증이며 임의 모델의 토큰 정확도, 요약 의미 보존, 응답 품질 또는 성능 개선의 실측이 아니다. 실제 모델/API 재개, 사내 서비스·Knox, Windows 연결과 PostgreSQL은 이번 실행이나 완료 조건에 포함하지 않고 기존 미완료 범위로 남긴다.

## 착수 전 경계 검토

[병렬 구현 계약 검토](C04-context-window-review.md)를 함께 따른다. 입력 설정 지문은 기존 의미 지문과 분리하며, 이미 받은 응답의 사용량·원본을 설정 변경만으로 폐기하지 않는다. 필수 후보까지 적용한 최소 입력의 초과와 요약 가능한 세션 이력 때문에 발생한 초과를 구분한다.

B 구현은 현재 ContextCompiler의 frames.stage뿐 아니라 SessionCompactor.context의 publishHead/retainHead까지 고려해야 한다. 측정만 하는 경로가 저장소를 갱신하지 않도록 기존 조립의 draft와 게시를 분리한다. 미게시 draft를 가짜 head를 가진 정상 SessionContext로 포장하지 않는다. 이 API를 먼저 정한 뒤 실제 원문 capacity 회복·최종 요청 재측정까지 연결한다.
