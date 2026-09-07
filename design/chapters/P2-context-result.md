# P2-03 — 컨텍스트를 줄여도 무엇이 남아야 하는가

2026-09-05 · 로컬 계약 검증 완료 · 실제 모델 조건은 미충족

[계획](/Users/seunghanee/Documents/secumon/design/chapters/P2-context-plan.md)에 따라 모델에 보낼 입력을 선택하고, 그 선택을 저장된 원본과 현재 상태에 연결했다. **컨텍스트에서 내려놓는 것과 저장된 사실을 삭제하는 것은 다르다.** 현재 업무의 정본은 WorkState와 원본 artifact에 남으며, ContextFrame은 다시 만들 수 있는 작업용 입력이다. Node 24.20.0에서 전체 **521개 시험**, 코어 타입 검사, 안쪽 계층 52파일·의존 위반 0, 합성 4시나리오·22판정이 통과했다. [실행·소스 검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-context-local-verification.json)

## 이번에 배울 구분

| 대상 | 의미 |
|---|---|
| 정본 | 목표·정책·계획·가설·근거·시도·의무·예산을 보존하고 완료를 판정하는 기준 |
| 모델 입력 | 지금 필요한 정본 일부와 현재 허용된 도구 명세·지침·과거 관측 |
| 저장 참조 | 내용을 읽을 위치와 신원을 보존한 표시. 새로운 관측이나 사실 본문을 대신하지 않음 |
| 선택 메모 | 최근 실제 사용·본문 유지·퇴거·재로딩 기록. 삭제되면 다시 만들며 권한을 부여하지 않음 |
| ContextFrame / head | 기반 revision·정책·도구/지침 기준, 선택 사유와 입력 비용을 저장한 파생 파일 / 현재 파일의 정본 참조 |

정리 과정에서 추가 LLM을 호출하지 않는다. 우선 명시적인 규칙으로 지켜야 할 내용을 고정하고, 남은 예산 안에서 선택한다. 따라서 저장·복원 계약은 결정적인 시험으로 확인할 수 있다. 어떤 정보가 실제 업무 해결에 더 중요한지 판단하는 모델 품질은 별도 검증 대상이다.

## 실제 실행 순서

1. 최신 업무 상태와 기억 출처를 확인한다. 이전 frame에서는 선택 메모만 참고하며 과거 본문을 현재 사실로 채택하지 않는다.
2. 필요한 원본을 읽고, 과거 호출은 실제 dispatch 영수증의 task·입력 digest·attempt/result 신원과 대조한다. 복사본은 원 호출까지 현재 권한과 버전을 확인한다.
3. 필수 정보와 입력 예산을 먼저 확보한다. 나머지는 본문 / 참조 / 제외 중 하나로 선택한다. 원본이 없거나 필수 내용만으로 한도를 넘으면 성공한 compact로 처리하지 않는다.
4. 실제 packet과 ModelCallOptions를 구성하고 adapter가 직렬화할 요청의 크기를 다시 계산한다. 모든 도구 명세를 별도 필드에 남기는 우회를 없앴다.
5. frame을 저장하고 동일 바이트를 읽어 확인한다. 모델 입력도 저장한 뒤, 같은 상태 revision에서 head와 모델 호출 예약을 함께 커밋한다.
6. 게시 직전·직후 출처를 확인한다. 재시작한 예약 호출도 모델 전송 직전에 현재 도구·지침 계약과 대조한다. 오래된 응답은 현재 계획으로 채택하지 않는다.

이 경로는 [ContextCompiler](/Users/seunghanee/Documents/secumon/runtime/src/application/context-compiler.ts), [ContextFrameStore](/Users/seunghanee/Documents/secumon/runtime/src/application/context-store.ts), [PlanningRuntime](/Users/seunghanee/Documents/secumon/runtime/src/application/planning-runtime.ts)에서 이어진다. `composeRuntime`은 `context`를 반환하지만 `prepare()` 자체는 후보 파일만 저장한다. 정상 실행의 head 게시는 모델 예약 트랜잭션이 맡는다. 테스트의 수동 게시와 공개 사용자 명령은 구분한다.

## 지키는 정보와 내려놓는 정보

목표·범위·완료 기준·정책, 가설의 예측/반증 조건과 지지/반증 근거, 의무와 wake/due, 예산·기한, 미확정 효과와 실행 중 시도는 보호한다. 가설 평가의 evidenceIds도 평가 상태로 남긴다. 다만 평가를 한 번 받았다는 이유만으로 모든 무관한 근거 본문을 영구 고정하지 않는다. 현재 기준의 fact key를 가진 근거와 진행 작업에서 직접 참조하는 근거는 본문을 유지한다.

계획은 완료되지 않은 작업과 그 의존 조상을 보존한다. 의존 작업 ID를 끊거나 완료 여부를 모델이 추측하게 만들지 않는다. 이전 목표 revision의 계획은 현재 실행할 작업으로 활성화하지 않으며, 계획 갱신에 필요한 revision 정보는 유지한다. 필수 의존 조상만으로 입력이 너무 커지는 경우는 명시적인 입력 한계다.

관련 없는 근거와 완료된 시도·결과는 선택적으로 내린다. `core.evidence.find`는 한국어/영어 단서로 현재 허용된 짧은 출처 카드를 찾고, `core.evidence.get`은 본문이나 원본을 다시 읽는다. 전체 과거 ID를 별도 목록으로 프롬프트에 다시 붙이지 않는다. `contextView.omitted`와 발견 도구로 빠진 항목이 있음을 알린다.

도구는 현재 실행할 정확한 버전과 발견/조회에 필요한 소규모 도구 집합을 우선 유지한다. `core.catalog.search/get`으로 불러온 명세는 현재 권한과 digest를 확인한다. 실제 options, activeToolIds, 입력의 allowedTools는 같은 선택을 따른다. 정본 정책의 전체 허용 목록은 바뀌지 않는다. 같은 호출에서 서로 다른 두 버전이 동시에 필수라면 조용히 버전을 교체하지 않고 충돌을 반환한다.

신뢰된 지침 manifest가 `requiredRules`를 선언하면 규칙·버전·manifest digest·원본 hash는 유지하고 긴 설명을 내릴 수 있다. 필수 규칙을 분리하지 않은 기존 지침은 본문 전체가 필수다. 도구 응답이 스스로 만든 규칙 목록을 신뢰하지 않는다. 지침을 다른 호출 장부로 복사해도 현재 버전·권한 확인을 우회하지 못하며, 참조만 허용된 결과는 선택 메모에도 본문 유지로 잘못 집계하지 않는다.

## 사용 수명과 비용 읽기

선택 함수의 기본 임계값은 상단 90%, 하단 70%, 최소 본문 유지 2회, 미사용 판단 3회다. 포함돼 있었다는 사실로 사용 시각을 갱신하지 않으며 새로운 실제 사용 표식을 구분한다. 권한·digest 변경은 유지 유예보다 우선한다. 선택 메모는 최대 128개이고 본문 퇴거/재로딩 수를 기록한다. 이는 제한된 작업 집합의 관찰값이며 제품 전체의 영구 사용 통계가 아니다.

| 기록 | 정확한 의미 |
|---|---|
| baselinePacketBytes / baselineToolBytes | 선택 전 기본 packet / 전체 현재 허용 명세 목록의 직렬화 바이트 |
| packetBytes / toolBytes | 선택 뒤 실제 packet / 명세 목록 바이트 |
| envelopeBytes | `{packet, options}` 전체 바이트. 차감용 overhead 값이 아님 |
| requestBytes | adapter가 직렬화하는 요청 전체 바이트. identity·공통 지시·응답 schema 포함 |
| estimatedTokens / estimateMethod | adapter의 추정값과 방법. 현재 로컬 structured adapter는 UTF-8 byte 추정이며 실제 tokenizer 사용량이 아님 |
| outputTokenReservation | 미리 확보한 출력 예산 |
| sourceReads | compiler가 집계한 원본 artifact 읽기·dispatch 영수증·이벤트 조회 수. 저장 계층 내부 I/O·검증기 비용·frame 저장 비용의 전체 계측이 아님 |
| extraModelCalls | 정리 과정의 추가 모델 호출 수. 현재 0 |

실제 모델이 보고하는 input/outputTokens는 모델 호출 장부에 별도로 남는다. 전송 직전 계약 변경으로 차단되면 transport와 토큰은 0이지만, 기존 예산 규칙상 이미 dispatch한 모델 시도 1회는 남는다. 이 횟수와 실제 provider 왕복을 같은 지표로 읽지 않는다. P2-05에서 모드·비용 평가와 함께 비교한다.

## 검증하면서 수정한 경계

- 새 목표와 이전 plan.goalRevision의 합법적인 불일치가 재생성을 막던 오류를 수정했다. 과거 계획을 현재 작업으로 재활성화하지 않는다.
- 파생 파일 유실만으로 오래된 근거/카탈로그 조회가 새 요청으로 승격되지 않도록 정본에 남은 관측 기준 revision을 사용한다.
- 원본 존재 검사 중 출처가 삭제되는 경우에는 후보를 게시하지 않는다. 저장소 커밋 뒤 반환 전에 바뀐 경우에는 head를 은퇴시키고 예약을 취소해 성공으로 반환하지 않는다.
- `core.calls.get`을 여러 번 거친 복사본도 실제 원 호출을 따라 검사한다. 현재 금지된 도구나 교체된 지침의 원문을 직접 조회·모델 입력으로 되살리지 않는다.
- 예약 후 재시작하면서 등록 도구나 지침이 바뀌면 전송 전에 막는다. 계획 채택 단계에서만 실패시키는 것으로 원문 전송 검사를 대신하지 않는다.
- 전체 입력/결과를 가진 호출과 저장 참조만 가진 호출을 schema에서 구분한다. 불완전한 호출 쌍이나 참조에 붙인 본문은 transport에 전달하지 않는다.

## 로컬 검증 결과

| 이번 추가 시험 | 개수 |
|---|---:|
| 선택·표현 상한·수명·재로딩 | 16 |
| frame 저장·경합·유실·재시작 | 35 |
| head 수명과 원본 구분 | 18 |
| 근거 발견·권한·부분성 | 14 |
| 두 업무군·두 backend의 반복 교체와 실제 전송 크기 | 10 |
| 지침 규칙·원문·버전·호출 쌍 | 10 |
| 예약 중 출처 변경과 파생 유실 | 6 |
| 모델 입력의 중첩 복사본 공개 경계 | 2 |
| 재시작 뒤 도구·지침 변경 전송 경계 | 16 |
| 직접 호출 조회의 복사 출처 검사 | 18 |
| structured transport의 불완전한 호출 쌍 | 1 |

추가 146개와 이전 375개를 합쳐 521개가 통과했다. 최종 `npm run verify`는 exit 0이며 [전체 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P2-context-verify.log)에 저장했다. 중간 전체 실행의 4개 실패는 목표/계획 revision과 평가 권한 오류 구분을 보정한 뒤 모두 다시 검증했다.

두 업무군 × 두 영속 상태 저장소에서 각각 5회 작업 집합을 교체·게시한 뒤 작은 초기 단서를 재조회했다. 별도 두 backend 시험에서는 5회 compact 후에도 미확정 쓰기 효과와 기한 있는 응답 의무를 유지했다. 이를 실제 모델의 추론 성공으로 해석하지 않는다.

큰 카탈로그 합성 사례는 두 backend에서 같은 크기를 기록했다. 허용된 81개 중 13개 명세를 전송했고, 명세 목록은 **516,137 → 33,277 bytes**, packet은 **4,451 → 2,222 bytes**였다. 실제 `{packet, options}`는 35,577 bytes이고 identity·공통 지시·schema까지 포함한 로컬 transport 요청은 **39,952 bytes**였다. 전체 baseline과 선택 결과의 포함 필드가 다르므로 이 숫자를 실제 API 비용 절감률로 환산하지 않는다.

## 학습과 남은 범위

빌드 후 [선택 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/context-selection.test.ts) → [반복 교체 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/context-compiler.test.ts) → [지침 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/context-guidance.test.ts) → [예약/출처 경합 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/context-reservation.test.ts) → [재시작 전송 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/context-dispatch.test.ts)을 읽는다. 초기 단서를 내린 순간, 원본을 다시 찾는 순간, 완료 판정이 사용하는 상태를 비교하면 각 계층의 책임을 이해하기 쉽다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm run build
node --test dist/tests/context-compiler.test.js dist/tests/context-guidance.test.js dist/tests/context-reservation.test.js
```

이번 구현은 규칙으로 선택하는 로컬 기준선이다. 실제 모델의 단서 활용·판단 품질, 모델별 토큰 계산·prompt cache·속도/비용, 운영 규모의 검색 성능은 미검증이다. 원본과 과거 호출을 다시 확인하는 내부 조회 비용은 여전히 누적될 수 있다. P2-04의 결과 재사용·dedup·batch·페이지/증분·카탈로그 갱신에서 개선한다. 모델 호출마다 별도 LLM 요약을 수행하지 않았고 의미 요약의 충실성을 검증한 것도 아니다.

여러 저장소의 재검사는 전역 원자적 snapshot이나 외부 효과 fence가 아니다. 마지막 검사 이후 변경까지 막는 것은 실제 배치의 조건부 실행 계약에 달려 있다. 파생 파일을 지워도 원본은 복원할 수 있지만 필수 원본이 사라졌다면 성공으로 숨기지 않는다. 물리 purge·백업·운영 복원, CLI/Web/Knox의 수동 compact UI는 후속 범위다.

실제 모델/API·사내 서비스 시험 중단을 유지한다. 로컬 통과와 실제 모델 선행 조건은 별도이며 P2-03 전체 상태는 `in_progress`로 유지한다. 다음 독립 로컬 챕터는 P2-04 도구·지침 호출 효율이다.
