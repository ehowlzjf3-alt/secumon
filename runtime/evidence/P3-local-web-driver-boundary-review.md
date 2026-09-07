# 로컬 계측 Web driver의 계약 경계 검토

2026-09-06 · 코드·설계 문서의 정적 검토 · 브라우저/서버/모델 실행 없음

현재 코어의 관찰, 입력 의도, 원본 artifact, 정산, 단일 후속 작업을 재사용할 수 있다. 새 어댑터가 맡아야 할 부분은 실제 renderer 세션과 대상의 현재성, DOM 입력 경계, 앱 영수증의 출처다. **현재 DOM 값, DOM 이벤트 수행, 앱 저장, 원 operation의 영속 영수증은 서로 다른 사실**이다.

이 문서는 일반 사내 웹 지원을 승인하거나 실제 browser 시험 통과를 기록하지 않는다. 원본 1,973개 보존과 실제 API 실험 취소는 유지한다. 이번 검토에서는 원본을 수정하거나 전체 해시를 다시 검사하지 않았다. 이전 [설계 문서](/Users/seunghanee/Documents/secumon/design/12-computer-use-tools.md:71)의 UI batch와 DB transaction 구분도 유지한다.

## 1. 이미 있는 코어와 재사용 범위

| 책임 | 현재 구현 | Web 어댑터에서의 처리 |
|---|---|---|
| 도구 등록·효과·결과 증명 | [createComputerTools](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-use.ts:51)는 observe/act/continue/verify와 artifact-proof validator를 등록 | 새 driver binding을 주입. 별도 실행 코어나 임의 JS tool을 만들 필요 없음 |
| 정본 권한 | [current](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-use.ts:102)는 goal/policy/세대/lease, 지식·예산과 후속 원본을 검사 | 각 입력에서 전달받은 authorizeInput을 호출. 어댑터가 자체적으로 작업 완료나 권한을 판단하지 않음 |
| 입력 전 의도·비용 | [runner](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-use.ts:412)는 관찰/입력 카운터를 선예약하고 입력 intent를 저장 | 한 act에서 임의 추가 입력·재시도 금지. 실제 내부 처리 비용은 usage로 반환 |
| 후속 작업 | [ComputerContinuations](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-continuations.ts:144)는 정확한 parent head와 proof를 검증하고 남은 단계를 계산 | 모델은 빈 input+computerResume만 제출. DOM에서 찾은 별도 단계로 원 batch를 바꾸지 않음 |
| unknown 정산 | [ComputerReconciliations](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-reconciliation.ts:262)는 읽기 권한으로 lookup하고 별도 응답/proof를 저장 | 앱이 증명할 수 있는 exact operation receipt만 반환. 조회에서 click/fill 재실행 금지 |
| 원본과 공개 | [관찰 저장](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-use.ts:150)은 현재 작업의 disclosure floor와 tool labels를 적용 | DOM·입력값도 원문. 전체 HTML, 비밀번호, 인증 토큰을 관찰 facts에 넣지 않음 |
| 저장소 | 기존 WorkState CAS·ArtifactStore·receipt 계약 | SQL/journal을 모두 사용. 앱의 업무 저장+영수증 저장은 외부 효과의 정본이며 새 에이전트 저장소를 만들 이유가 아님 |

원본 [Python browser tool](/Users/seunghanee/Documents/secumon/extracted/secu-agent/src/secu_agent/agent/tools/browser_tool.py:2189)은 설계 참고와 사례 재사용 대상이다. 새 TS 코어의 필수 의존성으로 복사하지 않는다. 기존 SyntheticComputerDriver의 operation schema·실패 사례는 재사용할 수 있지만 내부 fake element 상태 자체를 실제 DOM 관찰로 간주하면 안 된다.

## 2. DOM 관찰과 계측 앱 영수증의 차이

| 관측/응답 | 증명 가능한 범위 | 증명하지 못하는 범위 |
|---|---|---|
| textbox.value가 reviewed | 해당 시점 해당 요소의 값 | 이 attempt가 입력했는지, 서버에 저장했는지 |
| 저장됨 배너/DOM savedNote | 현재 페이지에 표시된 상태 | 정확한 operation 적용, 중복 저장 부재, 페이지 밖 영속 상태 |
| typed renderer 명령이 입력 직전에 거절됨 | 해당 명령이 DOM 입력 전 거절됐다는 신뢰 가능한 응답 | 이미 발송된 다른 명령·기존 외부 효과의 부재 |
| DOM fill/InputEvent/click 수행 응답 | 등록된 입력 경로가 수행됐다는 어댑터 주장 | native OS 입력, 사용자 신뢰 이벤트, 앱 업무 성공 |
| 동일 operation identity의 영속 applied receipt | 계약에서 정의한 입력/앱 효과가 적용되었다는 출처 있는 기록 | 전체 batch의 조건 충족, 다른 operation이 없었다는 보장 |
| receipt 없음/네트워크 timeout | 현재 증명할 수 없음 | not_applied 또는 안전한 재실행 |

현재 정산은 receipt의 identity를 그대로 대조한다. workId/attemptId/sessionId/epoch/surfaceId/operationId/viewRevision/focusRevision/targetRef/action이 모두 원 의도와 같아야 한다. `found`에는 receipt가 필수이고 `unknown`에는 receipt가 없어야 한다. [identity/lookup schema](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-operation-contracts.ts:13)

`applied`는 **그 typed input의 적용**이어야 한다. 예를 들어 Save click이 실행된 뒤 앱 업무 검증이 실패했다면 click 자체를 not_applied로 바꿀 수 없다. 그런 응답은 후속 작업이 같은 click을 다시 실행해도 된다고 잘못 판단하게 만든다. 성공 영수증을 뒤늦은 timeout/취소로 not_applied로 덮어쓰는 것도 금지한다. 영수증과 별도로 fresh DOM 조건을 확인한 뒤에만 batch 완료와 evidence가 만들어진다. [결과 projection](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-use.ts:213)

DOM을 직접 읽고 조작하는 일반 어댑터가 앱의 operation receipt를 얻을 수 없다면 lookup을 구현하지 않거나 unknown으로 유지해야 한다. 반대로 앱의 idempotency/receipt endpoint를 사용하는 계측 fixture는 그 앱이 정의한 identity와 영속 결정을 검증할 수 있다. 두 경우를 같은 unknown 복구 보장으로 보고하면 안 된다.

## 3. 최소 viable assurance 계약 변경안

기존 [ComputerDriver.act 주석](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-use-ports.ts:19)은 authorizeInput await 뒤 동기 최종 검사→입력을 요구한다. 호스트에서 승인을 검사한 뒤 별도 renderer에 메시지를 보내는 경로에는 추가 실행 경계가 생긴다. 이 사실을 기존 local driver 보장에 숨기지 않는다.

제안 타입:

```ts
type ComputerInputAssurance =
  | 'synchronous-local-v1'
  | 'renderer-gated-dom-v1';

// ComputerDriver
readonly inputAssurance?: ComputerInputAssurance;

// ToolDefinition
computerInputAssurance?: ComputerInputAssurance;
```

- 미지정 driver는 현재 local 계약 그대로 유지하고 생성 tool에도 필드를 생략한다. 기존 digest와 artifact 검증 호환성을 보존한다.
- 새 renderer driver는 `renderer-gated-dom-v1`을 명시한다. prepareComputerBinding에서 허용값과 원 callback을 고정하고, 생성된 ToolDefinition에 값을 넣어 contractDigest로 묶는다.
- 이 값은 검증 방식의 선언이다. capability나 쓰기 승인 자체가 아니며 marker만 붙인 임의 앱을 허용하지 않는다.
- ToolDefinition은 domain/model.ts가 아니라 application/ports.ts에 있다. WorkState나 checkpoint에 중복 필드는 필요 없다. 기존 contractDigest가 고정된 metadata를 인증한다.
- schema/주석 변경은 최소로 한정한다. 도구 정의의 엄격한 enum과 artifact-proof 요구, driver pin, 기존 필드 생략 회귀, assurance 변경 시 digest 변경을 검사한다.

| 선언 | 지킬 보장 | 남는 경계 |
|---|---|---|
| synchronous-local-v1 또는 미지정 | authorizeInput 완료 후 같은 실행 문맥에서 lease/view/focus/유일한 대상 검사와 입력을 동기적으로 수행 | 원래 driver가 약속하는 해당 로컬 실행 범위 |
| renderer-gated-dom-v1 | host 승인 샘플 이후 전송한 명령을 renderer가 실행하면서 lease/epoch/surface/ref/revision/focus/deadline을 동기 검사하고, 같은 renderer 명령 안에서 typed DOM 이벤트 수행 | host 승인과 renderer 실행 사이의 정책 철회·취소를 원자적으로 막는다는 보장 없음. native 입력 보장 없음 |

renderer profile의 `authorizeInput`은 전송 전 현재 권한 검사다. 단기 grant는 그 승인 표본을 운반하며, 그 뒤 발생한 정책 변경에 대한 선형화된 인증이 아니다. epoch/fence를 renderer에도 적용하면 이미 반영된 인계·폐기 grant를 거절할 수 있지만, 취소 메시지가 아직 도착하지 않은 명령을 취소 완료로 단정할 수 없다.

응답 분류는 다음을 따른다.

1. RPC 미전송을 확실히 아는 host 거절 또는 renderer의 입력 전 검증 거절: not_applied.
2. RPC 전송 이후 연결 종료·취소·timeout·ACK 유실: 입력 부재가 증명되지 않으면 unknown.
3. 신뢰할 수 있는 exact applied 응답/receipt: 적용 사실 보존. 취소가 적용 사실을 되돌리지는 않음.
4. lookup 결과 없음: unknown. 새로운 operationId로 같은 입력을 자동 재발행하지 않음.

## 4. 로컬 fixture가 추가로 보장해야 할 것

첫 구현은 고정된 loopback origin, 소유한 전용 browser context/page, Query/Search/Note/Save 요소로 한정한다. URL·JS·selector script를 tool input으로 받지 않는다. renderer 코드는 설치된 typed bridge이며 페이지의 문자열이나 사용자 입력을 실행 코드로 사용하지 않는다.

DOM bridge와 앱 receipt 사이의 대응을 명시해야 한다. 실제 폼 이벤트가 앱에 도달했는지 확인하는 시험과, HTTP로 앱 상태를 직접 바꾸는 시험은 구분한다. 직접 state API 호출만 성공했다고 DOM 입력 경로가 검증됐다고 기록할 수 없다. 이 챕터의 선택은 native click/fill이 아닌 renderer 내부 DOM automation이다.

앱 영수증 경로의 최소 요구:

- operation key와 전체 identity를 대조한다. 같은 key·다른 action/ref/basis를 덮어쓰지 않는다.
- 앱의 영속 상태 변경과 그에 대응하는 영수증을 같은 저장 결정에 넣는다. 단순 DOM 현재값을 보고 사후 receipt를 만들어서는 안 된다.
- 이벤트 적용 후 영수증 저장 전 장애처럼 원자화하지 못한 틈은 unknown으로 남긴다. 부분 장애에서 보장할 수 있는 효과 경계를 문서에 적는다.
- 서버 receipt가 DOM 적용을 대리 증명하는 경우, 등록 bridge의 operation/event와 결합해야 한다. 임의 POST payload를 믿어 applied receipt를 발급하면 실제 입력 증명이 아니다.
- not_applied receipt는 정확한 원 의도가 입력 전에 종결됐다는 기록이다. 서버 저장 미실행과 DOM 입력 미실행을 섞지 않는다.
- 재시작 이후에도 idempotency/receipt 범위와 보존 한도를 유지한다. 한도에 이르면 새 입력을 거절하거나 명시 운영 정책을 적용하고, 오래된 receipt 부재를 not_applied로 해석하지 않는다.
- 저장 ACK 불확실 시 새 입력을 막되 이미 영속화된 applied receipt의 읽기는 가능해야 한다. 기존 합성 [저장 경계](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/synthetic-computer-driver.ts:436)와 [lookup](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/synthetic-computer-driver.ts:253)는 참고 구현이다.

## 5. 관찰·세션·대기 매핑

| 계약 | 최소 Web 매핑 |
|---|---|
| sessionId, epoch, surfaceId | 소유 page/context와 페이지 세대에 결합. 재접속·페이지 교체·인간 인계 시 이전 grant/ref 무효화. 새 child는 새 epoch를 관찰할 수 있으나 원 act의 stale 관측을 새 입력 근거로 사용하지 않음 |
| revision, focusRevision | 대상 DOM 값·유일성·가시성·활성 상태와 초점에 영향을 주는 변화를 반영. 단순 observer 설치가 모든 의미 변화를 감지한다고 주장하지 않음 |
| elements | role/name/ref/value/visible/enabled를 실제 DOM에서 추출. 중복 role/name은 첫 요소 선택으로 숨기지 않음 |
| facts | 등록 앱 의미를 가진 명시 필드만. 저장된 원문 응답·전체 HTML을 임의 facts로 복제하지 않음 |
| partial, omittedCount | 제한을 넘으면 명시 잘림. partial view에서는 target 선택과 element_value 증명이 거절됨 |
| wait | 남은 deadline 안에서 변경/timeout/interrupted 반환. 네트워크가 조용하다는 사실을 업무 완료로 바꾸지 않음 |
| release | 자기 grant/page/context만 해제. 이전 lease의 release가 새 소유자의 session을 닫지 않음 |

현재 상한은 step 3개, 관찰 12회, 요소 40개, view 32,768 bytes, act 30초 이하다. lineage 입력 예약 6회/후속 8회는 새 attempt에서도 초기화되지 않는다. [schema](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-use-contracts.ts:37)

일반 URL/iframe/좌표/DPI/navigation 모델은 현재 ComputerView에 없다. 첫 어댑터의 닫힌 page 범위를 넘어가면 명시 중단한다. multi-frame이나 좌표까지 지원할 때는 관측·대상 identity를 버전 있는 계약으로 확장해야 한다.

현재 continuation은 직전 적용 단계의 condition 한 개를 재관찰한다. 여러 필드의 모든 선행조건을 재계산하는 일반 frontier가 아니다. Note A→B 같은 마지막 값 확인과 정의된 짧은 폼 흐름에는 사용할 수 있지만, 임의 웹 업무의 복잡한 전제 전체를 인증한다고 확대하면 안 된다. [현재 검사](/Users/seunghanee/Documents/secumon/runtime/src/application/computer-use.ts:468)

## 6. 별도로 측정·검증할 항목

| 시험 | 필요한 관측 |
|---|---|
| 실제 HTML 정상 경로 | 실제 DOM 값/이벤트, 앱 영속 상태, 정확한 receipt, fresh observation 기반 Evidence 각각 확인 |
| target/currentness | duplicate/hidden/disabled/ref 변경, rerender, focus, epoch, 페이지 교체가 입력 전 거절 |
| 전송 이후 취소/ACK 유실 | 실제 입력·앱 저장 count와 unknown 비교; 재조회가 입력을 늘리지 않음 |
| receipt 재시작/부재/충돌 | exact lookup, key 충돌 거절, 없는 receipt unknown, 과거 applied 덮어쓰기 불가 |
| continuation | applied unknown→정산→suffix, all applied→verify 0입력, 조건 불일치 중단, 원 deadline/누적 한도 유지 |
| 소비 경계 | parent proof/head 유실이 입력 직전·adopt·compact·restore/current에서 차단 |
| 세션/인계 | 같은 surface 상충 입력 직렬화, 이전 grant의 늦은 명령/release, 소유 browser 정리 |
| 실제비용 | logical tool call, browser transport 메시지, DOM 입력 수, 앱 mutation 수, receipt read, observation bytes, waitMs, wall time 구분 |

획득/해제는 현재 ToolUsage 반환이 없으므로 sessionCalls 같은 별도 계측으로 공개한다. browser 내부 메시지·프레임·HTTP 비용을 단일 toolCalls와 같은 수치로 보고하지 않는다. screenshot을 수집하지 않으면 imageBytes=0이며, 실제로 수집한 경우 원본 크기를 측정한다. synthetic virtual time 시험과 실제 browser wall time 시험을 나누고, 병렬 시험 지연을 근거로 제품의 action deadline을 늘리지 않는다.

이번 문서의 결론은 구현 전 경계 검토다. 실제 browser 실행, 앱 endpoint 실행, 빌드, 신규 시험 실행은 수행하지 않았다.
