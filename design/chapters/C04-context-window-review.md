# C04 창 관리의 병렬 구현 계약 검토

2026-09-07 · 읽기 검토/권고. [다음 단위 계획](C04-context-window-plan.md)의 A(추정·창 계산)와 C(compact 구간 조정)가 공유할 두 결정만 정리했다. source·시험은 동결 상태이며 변경/실행하지 않았다. 실제 모델/API 시험 중단을 유지한다.

## 결정 1 — 입력 설정 지문은 업무 의미 지문과 분리한다

**권고: `ModelCall.inputProfileDigest?: string` 한 개를 선택 필드로 추가하고, 새 호출에는 예약에 사용한 입력 설정 지문을 저장한다. `semanticVersion`을 올리거나 기존 `semanticDigest` 계산에 설정을 끼워 넣지 않는다.**

현재 `PlanningRuntime.digest(state, version)`는 v2에서 execution, v3에서 적용된 session, v4에서 generatedAnswer를 추가한다. `matches(call)`는 provider/model/adapterRevision/destination 및 현재 `Planner.identity`를 대조하지만 capabilities나 추정 설정은 확인하지 않는다. `ModelCallSchema`는 strictObject이므로 새 필드는 domain 타입과 schema 양쪽에 선택적으로 추가해야 한다. 없는 옛 필드에 기본값이나 null을 자동 삽입하지 않는다.

### A가 제공할 작은 계약

`model-input-budget.ts`에 순수한 `inputProfile(...)`/`inputProfileDigest(...)`와 적합 판정을 둔다. 이름은 구현 시 조정할 수 있지만 계산 입력은 다음처럼 고정한다.

```text
version: 1
purpose: planning | agent_turn | session_compact
identity: 기존 provider/model/revision
destination
limits: maxInputTokens, contextWindowTokens|null, maxOutputTokens|null
runtime: maxInputBytes, 이번 maxOutputTokens
estimator: 등록 id/revision, request-template revision, 추정 방식, 적용 여유 설정
```

여기서 version은 **입력 설정 표현의 버전**이다. `ModelCall.semanticVersion`과 별개다. 등록값을 복사/동결하고 같은 canonical JSON digest 도구로 지문을 계산한다. 함수의 `toString()`이나 현재 시각으로 지문을 만들지 않는다. 같은 capabilities라도 추정기·요청 템플릿이 바뀌면 등록 revision이 바뀌어야 한다. 선언한 버전은 그대로 둔 채 임의 코드를 바꾸는 신뢰되지 않은 플러그인까지 이 지문이 탐지한다고 주장하지 않는다.

`identity.revision`은 기존 어댑터 구현/행동 버전으로 유지한다. capabilities 설정만 바꿀 때마다 가짜 model identity를 만들거나 기존 call.adapterRevision을 고쳐 쓰지 않는다. 실제 tokenizer가 없는 기존 제공자에는 알려진 fallback 방식/버전을 기록한다. 기존 사용자 정의 estimate hook에 별도 추정기 등록이 없다면 `legacy_adapter_revision`으로 구분하고 그 한계를 남긴다. 이를 새 모델별 tokenizer의 정확한 지문이라고 표현하지 않는다.

추정 결과 `{tokens, bytes, method}`와 설정 지문은 구분한다. 지문은 설정을, 추정값은 **그 고정 요청**의 예상 크기를 나타낸다. 동일 call ID의 inputArtifact/options/예약량을 새 설정으로 덮어쓰지 않는다. 설정의 설명용 snapshot이 필요하면 기존 예약 이벤트의 data에 한 번 기록할 수 있지만 전체 capabilities를 여러 저장소에 중복 정본으로 만들 필요는 없다.

### 검사 위치와 기존 호출 호환

| 호출 단계 | 권고 동작 |
|---|---|
| 새 예약 | 세 목적 모두 동일 입력 profile을 고정한다. 준비·최종 예약 직전 설정 지문이 달라지면 예약하지 않는다. 최종 선택된 입력에만 profile digest를 저장한다. |
| `reserved` → `dispatch` | 새 필드가 있으면 현재 지문과 같아야 한다. 다르면 기존 미실행 예약 반환/취소 경로를 이용하고 새 call ID로 다시 준비한다. |
| `execute`의 최종 송신 전 | await가 끝난 뒤 profile을 다시 비교한다. `matches(call)`와 별도의 `inputProfileCurrent(call)`를 호출해 source/권한 검사와 함께 적용한다. 아직 송신하지 않은 호출의 취소/정산은 기존 `model_not_sent` 경로를 유지한다. |
| 이미 송신한 `running/unknown` | 설정 변경이 실제 사용량을 없애지 않는다. 원 응답을 기록하고 usage/unknown을 기존대로 정산한다. 설정이 달라졌다는 이유로 receive 자체를 거절해 미정산으로 남기지 않는다. |
| 저장된 `received`/`accepted` | 입력 창·추정 설정은 새 송신의 조건이지 이미 존재하는 원문/답변의 진실성 조건이 아니다. 설정만 바뀌었다고 원응답·요약 영수증·과거 답변을 지우거나 재호출하지 않는다. 기존 모델 identity/프롬프트·업무 의미·출처/권한·완료 검사와 단계별 채택 규칙은 그대로 적용한다. |
| 필드 없는 옛 v2/v3/v4 또는 version 없는 호출 | 읽기·영수증·usage를 유지하고 profile digest를 소급 생성하지 않는다. 아직 송신 전이면 저장된 **그 입력**을 현재 한도로 다시 검증한다. 현재 추정이 기존 `inputEstimate`/예약량을 초과하거나 출력·바이트 한도를 위반하면 새 호출 준비가 필요하다. 더 작은 구간으로 옛 inputArtifact를 바꾸지 않는다. 과거 설정 동일성을 확인한 것으로 표시하지 않는다. |

`matches(call)`를 무조건 확장하는 방식은 피한다. 이 함수는 `adoptResponse`에서도 사용되므로 입력 크기 설정 변경만으로 이미 받은 정상 답변이 버려질 수 있다. 최소 추가 지점은 `reserveModel`의 준비/commit 경계, `dispatch`, `execute`의 마지막 eligible 경계다. 새 지문 검사는 미실행 입력의 예약 보호이고 `GeneratedAnswer.basisDigest`나 세션 요약의 source digest를 대체하지 않는다.

필수 회귀는 새 예약 뒤 cap/추정 revision 변경 시 송신 0, 송신 직전 변경 시 기존 취소 정산, 옛 v2/v3/v4 직렬화·해시 보존, 옛 reserved의 현재 적합 판정, 받은 응답의 설정 변경 후 재호출 0·usage 보존이다. 모델 identity나 프롬프트까지 바뀐 경우는 설정만 바뀐 사례와 분리한다.

## 결정 2 — 크기 판정과 compact 필요 판정을 분리한다

**권고: A는 요청이 들어가는지 수치로만 판단하고, C는 명시적인 ‘크기 초과’ 결과에만 구간을 줄인다. 일반 `model_input_limit` 예외를 잡았다는 이유만으로 자동 compact를 시작하지 않는다.**

현재 `ContextCompiler.prepare`의 `model_input_limit`에는 비정수/과소 바이트 추정, 기본 필수 입력 초과, 선택 항목을 줄여도 넘는 경우가 함께 들어 있다. `PlanningRuntime.reserveModel`도 추정값 유효성과 입력 크기를 같은 코드로 거절한다. `compactStep`은 실패 후 세션 context를 읽을 수 있으면 진행을 허용하고, 일부 용량 코드를 `session_compact_capacity`로 바꾼다. 세션 context가 유효하다는 사실만으로 전체 주 턴 요청이 모델 창에 들어간다는 결론을 내릴 수 없다.

### A ↔ C의 최소 인메모리 계약

```ts
type InputFit =
  | { kind: 'fit'; estimate: ModelInputEstimate }
  | { kind: 'too_large'; estimate: ModelInputEstimate;
      dimensions: ('bytes' | 'input_tokens' | 'total_window')[] };

// 같은 callId/options/profile을 닫아 둔 동기·읽기 전용 callback.
// invalid estimate, configuration/source/authorization failure는 정상 fit 결과가 아니다.
type MeasureCompact = (input: SessionCompactInput) => InputFit;
```

추정기가 실제 외부 호출을 하지 않는 기존 동기 포트이므로 callback도 비동기 네트워크 기능으로 넓히지 않는다. C는 A가 검증한 `too_large`일 때만 원문 항목 수를 줄인다. `fit`이 나오면 최종 inputDigest/prefix와 그 estimate를 같이 반환하여 다른 후보의 측정값을 쓰지 않게 한다. 소스 현재성은 최종 예약 전 기존 검사로 다시 확인한다. malformed 값이나 임의 provider 예외를 `too_large`로 만들지 않는다.

### 오류/결과를 다음 행동에 연결하는 기준

| 원인 | 내부 분류 권고 | 자동 compact/구간 축소 |
|---|---|---|
| 추정값이 NaN·음수·비정수, 저장 envelope보다 작은 bytes, 잘못된 estimate | `model_input_estimate_invalid` | 둘 다 금지. 제공자 계약 오류다. |
| 출력 예약이 cap/총 창을 초과, 음수 입력 공간, 잘못된 한도 설정 | `model_window_configuration_invalid` | 둘 다 금지. 원문을 줄여 해결할 수 없다. |
| 예약 중 profile이 바뀜 | `model_input_profile_changed` | 현재 후보로 compact하지 않는다. 새 설정으로 준비를 다시 시작한다. |
| 최소 필수 업무 상태·현재 사용자 원문·필수 도구/선택 기억만으로 초과 | `model_required_input_limit` | 자동 compact 금지. 필수 내용을 삭제하거나 요약 완료로 가장하지 않는다. |
| 필수 부분은 들어가고, 선택 항목 축소 뒤에도 요약 가능한 과거 세션 부분 때문에 초과 | 내부 `{kind:'needs_session_compact', basis, profileDigest}` | **이 경우만** 기존 정식 compact 호출로 연결한다. 적용 basis가 달라졌으면 다시 판단한다. |
| compact 후보의 유효한 추정이 초과 | `InputFit.too_large` | C 내부에서 아직 예약하지 않은 구간만 유한 축소한다. |
| 한 원문 항목/이전 보호 요약까지 줄여도 초과, 요약 가능한 prefix 없음 | `session_compact_capacity` | 더 작은 모델 호출을 반복하지 않고 종료한다. |
| source·권한·정책·pending 입력·원본 검증 실패 | 기존 source/currentness 오류 | 크기 초과로 바꾸지 않는다. |
| 이미 받은 모델 답변의 잘림/거절/usage 불명 | 기존 `model_output_truncated`/거절/unknown 수명 | 입력 compact로 분류하지 않는다. 이미 사용한 자원과 원응답을 보존한다. |

일반 용량 오류의 외부 표시를 당장 전부 바꿀 필요는 없다. CLI/Web은 기존 `model_input_limit` 표시를 유지할 수 있지만, 실행 조정에는 위 내부 판별 결과를 전달한다. 문자열 하나만 비교하거나 외부 오류가 같은 문자열을 던졌다는 이유로 compact를 예약하지 않는다. 신규 내부 타입/전용 오류는 application 경계에서 만들고 cause와 측정값을 보존한다.

선택기와 최소 필수 구성을 아는 B(`ContextCompiler` 연결)가 `needs_session_compact`를 결정한다. A는 토큰 창 계산만으로 ‘과거 세션이 원인’이라고 추측하지 않고, C는 자체 구간 초과를 다시 별도 compact 호출의 원인으로 내보내지 않는다. 이 구분으로 A와 C를 병렬 구현할 수 있다.

B의 판단 입력에는 두 조건이 더 필요하다. **현재 `baseEstimate`를 최소 필수 크기로 사용하면 안 된다.** base에는 전체 세션이 들어 있고 필수 후보 도구는 아직 적용되지 않아, 줄일 수 있는 부분은 크게 잡고 꼭 필요한 schema는 빠뜨릴 수 있다. 기존 후보의 minimum 표현을 실제 반영하고 현재 원문/보호 부분을 구분한 구성으로 판정해야 한다. 이 조건이 확보되기 전에는 generic `model_input_limit`을 `needs_session_compact`로 승격하지 않는다.

또한 `frames.stage`만 생략해도 준비가 무쓰기가 되는 것은 아니다. `SessionCompactor.context`는 `publishHead/retainHead`를 실행한다. B가 읽기 전용 draft/probe와 예약 시 실제 head/frame 게시를 분리하기 전에는 이 경로를 ‘무쓰기 probe’로 부르거나 capacity 거절 시 게시 0을 가정하지 않는다. 미게시 draft에 가짜 head ID/digest를 넣어 정상 `SessionContext`로 통과시키지 않는다. A의 크기 판정과 C의 callback은 게시된 head나 frame을 선행으로 요구하지 않으며, B의 draft 형식과 실제 게시 경계를 정한 뒤 연결한다. 이 보강은 오류 분류의 증거를 확보하기 위한 조건이지 A/C에서 세션 저장을 새로 구현하라는 요구가 아니다.

필수 회귀는 **추정 오류/출력 초과/필수 상태 초과에서 compact 호출 0**, 세션 초과에서만 compact 예약, C의 `too_large`→더 작은 완전 prefix→단일 예약, 줄일 수 없는 prefix의 유한 종료, 유효 세션 context이지만 도구/출력 포함 전체 요청은 넘는 사례다. 기존 source 실패·응답 저장 재개·장부 시험을 재작성하지 말고 이 분기만 추가한다. 이 검토는 계약 권고이며 구현 또는 실제 모델 적합성 검증 결과가 아니다.
