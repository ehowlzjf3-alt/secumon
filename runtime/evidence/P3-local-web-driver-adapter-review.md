# P3 로컬 Web driver adapter 독립 검토

2026-09-06 · 읽기 전용 소스 검토 · 구현/빌드/시험/브라우저 실행 없음

대상은 `src/infrastructure/instrumented-web-computer-driver.ts`와 `src/tests/instrumented-web-computer-driver.test.ts`의 첫 구현이다. 경계 확인을 위해 renderer fixture, HTTP fixture, 기존 ComputerDriver와 runner/reconciliation 호출부를 함께 읽었다. 아래 줄 번호는 검토 당시 소스 기준이다. 실제 브라우저 통과나 운영 웹 지원을 판정한 문서가 아니다.

## 수정이 필요한 두 지점

### 1. 승인 대기 전에 입력 snapshot을 고정하지 않는다

`instrumented-web-computer-driver.ts:51–76`에서 schema의 `parse` 반환값을 사용하지 않는다. 원본 `lease`와 `request`로 operation identity와 중복 확인 digest를 만들고, `authorizeInput()`을 기다린 다음 같은 원본 객체를 전송한다.

따라서 호출자가 승인 대기 중 `request.action.value`, `request.operationId`, `request.basis` 또는 `lease`를 바꾸면, 등록된 중복 키/digest와 실제 renderer 명령이 달라진다. 응답의 operationId도 변경 가능한 원본 request와 비교한다. 입력 payload가 원래 검증된 요청과 같다는 보장이 끊긴다. 현재 일반 runner는 checkpoint에 요청을 복사하지만 driver에는 `requested.action`을 넘긴다(`application/computer-use.ts:479–487`). 후속 artifact 검증이 잘못된 결과 채택을 막아도 이미 발생한 다른 DOM 입력을 되돌리지는 못한다.

최소 수정은 driver 진입 시 lease와 요청 전체를 분리·검증하여, 고정한 snapshot으로 identity, digest, transport 인자와 응답 대조를 모두 계산하는 것이다. `lookup`도 schema 반환 identity로 범위와 영수증을 비교해야 한다. 현재 `lookup:88–94`는 원본 객체를 승인 대기 이후 재사용하므로 동일 문제가 있고, 정규화하지 않은 원본 JSON key 순서 때문에 의미가 같은 identity를 다른 것으로 거절할 수도 있다. acquire/observe의 대기 후 요청 대조와 관찰 상한도 같은 원칙으로 고정하면 일관된다.

회귀 기준:

- 승인 promise가 보류된 동안 원본 action/value, operationId, basis, lease를 변경해도 transport에는 처음 허용한 명령만 전달된다.
- 전송 대기 중 원본 요청을 바꿔도 응답 대조 기준과 관찰 상한은 바뀌지 않는다.
- 변경된 요청을 같은 operation 키로 별도 호출하면 기존 동작대로 conflict이며 두 번째 입력은 없다.
- lookup의 원본 identity 변경과 객체 key 순서 변경이 각각 다른 identity 허용 또는 같은 identity 오거절로 이어지지 않는다.

### 2. 전송 후 불확실한 내부 사용량을 0으로 확정한다

`instrumented-web-computer-driver.ts:17,74–79`는 전송 뒤 오류를 `unknown`으로 분류하면서 사용량을 `{transportCalls:1, internalOperations:0, imageBytes:0, waitMs:0}`으로 반환한다. renderer가 DOM 입력/검사/저장을 수행한 뒤 응답을 잃은 경우에도 작업과 대기 사용량이 0으로 정산된다.

기존 `ToolUsage`는 각 필드의 `null`을 지원한다(`application/contracts.ts:76`), runner와 reconciliation도 미관측 사용량에 null을 사용한다. 이 adapter가 확인한 transport 진입 수와 이미지 미사용 여부만 확정하고 내부 작업과 대기 수치는 null로 남겨야 한다. 승인 거절처럼 전송 전 입력 미발생이 확인된 경로의 0은 유지할 수 있다.

회귀 기준은 전송 후 응답 유실에서 status=unknown 및 미관측 비용=null, 전송 전 승인 거절에서는 transport/input 관련 비용=0이다. 실제 fixture 카운터와 비교할 때 unknown을 측정한 0으로 합산하지 않아야 한다.

두 지점은 부모 구현 담당에게 전달했다. 이 검토에서는 제품 코드를 수정하지 않았다.

## 소스에서 확인한 재사용 경계

| 경계 | 정적 확인 | 근거 |
|---|---|---|
| 모델 입력과 브라우저 실행 코드 | host가 정한 typed command와 고정 evaluate 함수만 사용한다. 모델 입력으로 JS 또는 이동 URL을 받지 않는다. | adapter:7–16,110–130 |
| 목적지 | 생성 시 loopback HTTP URL/port를 요구하고 사용자정보·query·fragment를 거절한다. 호출 전 host와 renderer에서 origin/path를 각각 비교한다. | adapter:111–129 |
| renderer 입력 | 현재 lease/epoch/surface/view/focus/unique ref/deadline을 검사한 뒤 DOM value와 이벤트/click을 수행한다. native OS 입력 계약은 아니다. | page:112–145,198–225 |
| 중복 operation | 동일 키·payload의 진행 promise/result를 재사용하며, 다른 payload는 unknown conflict이다. 최대 256개 이후 입력을 거절한다. | adapter:58–65; page:198–206 |
| 전송 후 취소 | host의 Promise.race 종료가 renderer 실행 취소를 의미하지 않는다. act는 전송 뒤 실패를 unknown으로 유지하며 같은 operation을 재전송하지 않는다. | adapter:74–81,120–133 |
| 응답 검증 | 기존 lease/view/action-result/lookup-result 스키마, observation element/byte 상한과 operationId를 재사용한다. | adapter:34–95 |
| 영수증 조회 | 현재 lease의 work/session 범위를 요구하며 found는 정확한 identity와 driver를 대조한다. missing receipt는 unknown이며 입력을 호출하지 않는다. | adapter:87–95; fixture:202–210 |
| 앱 저장과 영수증 | 계측 앱의 app mutation과 applied receipt를 같은 persist 데이터로 저장한다. 일반 DOM 관찰만으로 receipt를 합성하지 않는다. | fixture:212–225 |
| 조회 뒤 업무 권한 | driver의 승인 sample 이후에도 reconciliation service가 응답을 저장하기 전 현재 guard와 receipt identity를 재검사한다. | application/computer-reconciliation.ts:262–280 |

현재 URL 검사는 정규화한 origin/path 기준이다. fragment만 변경한 동일 문서는 허용될 수 있으므로 전체 raw URL byte 일치 보장으로 설명하면 안 된다. 현재 fixture는 HTTP query를 거절하며 fragment에 업무 의미를 부여하지 않는다. 이번 계측 앱에서 별도 우회는 확인하지 않았다.

## 현재 시험 소스와 실제 브라우저 판정의 구분

검토 당시 adapter 시험 파일에는 12개의 사례가 있었다. 승인 거절, 승인 중 취소, 전송 후 unknown/중복 재사용, payload conflict, 동시 join, malformed 응답, 다른 epoch의 view, observation 상한, missing/다른 identity의 receipt, 다른 경로/외부 목적지, host abort 이후 늦은 renderer 응답을 다룬다. 대부분 transport/Page 대역으로 구성되므로 실제 DOM 입력과 앱 receipt 저장을 입증하지 않는다. 이 검토에서 해당 시험을 실행하지 않았다.

실제 브라우저에서는 다음을 별도로 확인해야 한다.

- fresh DOM view를 사용한 Note 입력과 Save, 재관찰 및 실제 앱 receipt가 일치한다.
- rerender/ref 교체, focus 이동, hidden/disabled/중복 target, 사람 인계가 실제 입력 직전에 차단된다.
- DOM 이벤트는 실행됐지만 앱 응답을 잃은 경우 unknown이며 재시도 입력이 없다. 새 조회 attempt가 정확한 영수증만 읽는다.
- 새 문서/새 epoch가 이전 grant를 무효화하고, host 취소/timeout 후 늦은 입력 가능성을 완료된 취소로 표시하지 않는다.
- SQLite와 file-journal에서 기존 reserve/execute/adopt, reconciliation/continuation 경로가 같은 artifact proof를 검증한다.

남는 비원자적 경계는 host 권한 검사 이후 RPC 및 renderer 내부 gate까지의 구간이다. 이번 assurance는 그 구간의 즉각적인 권한 철회를 보장하지 않는다. 응답을 잃은 acquire가 서버에 lease를 남기는 경우도 만료까지 일시적으로 재접속을 막을 수 있으나, 그 자체를 입력 성공 또는 입력 재시도 허용으로 해석하지 않는다.

이 검토로 확인한 범위에서 추가적인 automatic replay 또는 missing receipt의 not_applied 변환 경로는 발견하지 못했다. 제시한 수정과 실제 브라우저 검증의 최종 결과는 부모 작업의 검증 기록으로 확인해야 한다.
