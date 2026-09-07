# P1-04 — 필요한 도구·기록·지침만 읽기

2026-09-05 · 작은 카탈로그와 공통 조회 경로 구현·검증

이번 단위는 P1-03의 실행 코어에 도구 발견, 호출/근거 재조회, 방법론과 지침 선택을 연결했다. 모델이나 특정 DB의 API를 코어에 넣지 않았으며 두 업무군에 같은 구성을 적용했다.

## 세 가지를 구분한다

도구 카탈로그에서 ‘이 기능을 가진 도구가 있다’고 찾는 것과, 그 도구를 실행할 권한이 있는 것은 다르다. 검색 전에 현재 권한으로 후보를 제한하고, 선택할 때 정확한 ID/버전을 사용하며, 실제 호출 직전 Broker가 저장된 시도·owner·목표·권한·입력을 다시 확인한다.

호출 장부에서 과거 성공 결과를 찾았다고 현재 상태를 새로 관측한 것은 아니다. 저장 결과에는 원래 attempt, 당시 목표 revision과 수락 여부, 현재 근거의 유효성을 표시한다. 재조회 자체는 외부 원천을 다시 실행하거나 근거 수를 늘리지 않는다.

지침은 방법을 돕는 자료다. 본문을 읽었다고 권한이 늘거나 완료 기준을 충족하지 않는다. 단순 조회는 `core.direct-lookup` 방법을 선택하며 기본 지침 목록은 비어 있다. 비교·반증·회신 대기가 있으면 그에 맞는 방법을 선택한다. 이 선택은 작은 결정 규칙이며 실제 모델의 업무 해석 성능 시험은 아니다.

## 구현된 경로

| 경로 | 동작 |
|---|---|
| core.catalog.search | 권한 필터 후 한국어/영어 lexical 검색, 최대 20개 짧은 카드, 전체 schema 미포함 |
| core.catalog.get | 정확한 provider 구분 ID/버전, 선택 명세와 계약 digest, 본문 크기 상한 |
| core.evidence.get | 현재 수락된 근거 또는 원문을 ID로 읽고 출처·관측 시각·범위 보존 |
| core.calls.find | 현재 work의 제한된 호출 카드, 입력 digest 조건, 당시 상태·효과·수락 여부 |
| core.calls.get | 저장 결과 원본 재조회, historical/current 구분, 새 관측 아님을 표시 |
| core.guidance.find | 업무 특성에 맞는 방법과 지침 카드, 본문은 읽지 않음 |
| core.guidance.load | 정확한 지침 버전·적용 조건·권한·hash 확인 후 선택 본문/참조 저장 |

이 7개 공통 조회 도구와 합성 원천 도구 `fixture.read`를 예제에 연결했다. 기존 시큐몬의 전체 도구 후보를 이식한 수가 아니다. 도구 등록의 중복 거부·정확 선택·제한 검색, 근거 읽기의 원본 위치 보존 원칙을 재사용했다.

모델이 조회 도구를 요청하면 기존 task/attempt·호출 예산·결과 저장을 거친다. 내부 UI의 직접 상태/근거 조회는 application reader로 실행할 수 있고 모델을 부르지 않는다. 입력 크기 상한은 본문/정의에 적용하며 짧은 상태·참조 envelope의 크기는 별도다. 초과는 `too_large`/부분 결과로 명시한다.

## 검증한 예제

두 업무군에서 도구 카드 검색 → 정확한 명세 선택 → 방법/지침 카드 → 명시적으로 선택한 지침 본문 → 합성 원천 조회를 실행했다. 호출 장부에는 다섯 번의 로컬 도구 호출이 남고 원천 조회는 한 번, 새 근거도 한 개다. 지침 선택 기록에는 ID/버전/hash, 선택 이유, work/goal revision, 방법이 함께 남는다.

별도 단순 조회 예제는 원천 도구 한 번으로 끝나고 지침 본문이나 가설 검토를 추가하지 않았다. 목표를 변경한 뒤 기존 근거와 호출 결과를 모델용 조회 도구로 읽는 예제에서는 원천 도구가 재실행되지 않았고 새 목표의 추가 완료 조건도 건너뛰지 않았다.

SQLite와 artifact 저장소를 닫고 다시 연 뒤 저장된 지침·원천 결과를 읽었다. 원천 도구 호출 횟수와 예산 사용량이 늘지 않았다. 이는 저장 결과 재조회 검증이며, P2의 자동 결과 재사용/신선도 판단을 완료했다는 의미는 아니다.

등록 snapshot 변조, 동일 ID 중복/다른 provider 혼동, 잘못된 버전·인자, 권한 밖 목록, 부분 결과, 철회/대체된 근거, 본문 크기, 지침 파일 hash/경로/링크 치환도 시험했다.

## 구현 중 보강한 정보 경계

동적 근거/기록 조회를 붙이며 실행 도중 권한이 바뀌는 경우를 검사했다. Broker와 reader는 실행 당시 허용 범위와 현재 허용 범위의 교집합을 사용한다. 결과 보관은 dispatch 영수증의 정보 등급을 기준으로 하며 권한이 줄었다고 원문을 더 낮은 등급으로 다시 저장하지 않는다.

결과 수신 전에 등급이 철회되면 원문을 제외한 고정 실패만 저장한다. 수신 후 수락 전에 철회되면 보호된 원문을 읽지 않고 시도를 거부 상태로 정리한다. 기존처럼 received에 계속 머무르거나 새 권한으로 예전 원문을 노출하는 경로를 막는 로컬 시험을 추가했다.

현재는 보수적으로 dispatch 때 허용되었던 label 집합을 결과 분류에 사용한다. 관련 없는 label 하나가 철회되어도 결과가 제한될 수 있다. 더 세밀한 산출물 분류·목적지 공개 view·배포 중 정책 변경은 P2/P3에서 이어 검증한다. 사내 인증/모델/수신자 경계 전체가 검증된 것은 아니다.

## 실행 결과와 읽는 순서

Node 24.20.0에서 `npm run verify`가 통과했다. 전체 **66개 시험**, 안쪽 계층 **22개 파일/위반 0**, **4개 시나리오·22개 완료/제어 판정**이다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P1-resources-verification.json)

1. [카탈로그](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-catalog.ts)와 [등록 계약](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-contracts.ts): 검색 카드와 선택 명세의 차이.
2. [Broker](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-broker.ts): 현재 실행 시도와 권한 재검사.
3. [근거·장부 reader](/Users/seunghanee/Documents/secumon/runtime/src/application/work-resources.ts): 현재 근거와 역사적 결과의 구분.
4. [방법 선택](/Users/seunghanee/Documents/secumon/runtime/src/domain/methods.ts), [지침 로딩](/Users/seunghanee/Documents/secumon/runtime/src/application/guidance.ts), [공통 지침 본문](/Users/seunghanee/Documents/secumon/runtime/guidance/evidence-review.md).
5. [코어 구성](/Users/seunghanee/Documents/secumon/runtime/src/application/compose-runtime.ts)과 [통합 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/resources.test.ts).

생각해 볼 질문: ‘이전에 성공한 결과는 어떤 조건에서 현재 근거가 될 수 있을까?’, ‘검색으로 찾은 모든 도구의 명세를 바로 읽어야 할까?’, ‘지침에 실행하라고 적혀 있으면 누가 권한을 결정할까?’ 다음 챕터의 컨텍스트·재사용·업무 배치와 연결되는 질문이다.

P1-04는 검증 완료했다. 다음은 **P1-05: CLI 접수·상태·목표 변경/취소·결과 전달**이다. P2의 자동 캐시·합류·batch/증분·카탈로그 갱신과 전체 개인/조직 기억, P1-06 실제 모델 품질·토큰 정산, 실제 MCP/Knox/컴퓨터 유즈는 남아 있다. 종료한 API 키 시험은 재개하지 않았다.
