# P1-03 — 계획을 실행 상태로 연결하기

2026-09-05 · 결정적 실행 코어 구현·검증

이번 단위에서는 제출된 계획을 검증하고 도구를 실행한 뒤, 저장된 결과를 근거로 받아들여 다음 동작을 결정하는 경로를 만들었다. 두 업무군에 같은 코어를 사용했다. 전체 P1 챕터는 아직 진행 중이다.

## 이번에 배운 구분

계획은 앞으로 할 일이고 실행 시도는 실제로 시작한 일이다. 같은 작업을 재시도하더라도 시도 ID는 새로 생긴다. task ID에 묶인 도구·버전·입력·효과는 바꾸지 않는다. 이전 계획에서 사라진 미실행 작업도 수락 사건 이력으로 계약을 확인한다.

결과 수신과 근거 수락도 다르다. 원본을 저장하고 `received`를 커밋한 뒤에 tenant·범위·출처 참조·최신 목표·권한을 다시 확인한다. 수신 직후 프로세스를 다시 열면 도구를 또 실행하지 않고 이 수락 단계부터 이어진다. 취소된 업무의 늦은 결과는 이력으로 남지만 완료 근거로 채택하지 않는다.

Controller는 지금 계획에 실행할 작업이 남아 있으면 `continue`, 현 계획으로 목표를 채울 수 없으면 `replan`, 회신/실행을 기다리면 `wait`를 반환한다. 근거와 미해결 의무가 완료를 결정한다. 도구 큐가 비었다는 사실만으로는 완료하지 않는다.

## 구현과 확인

| 경계 | 실제 구현·검증 |
|---|---|
| 계획 수락 | 현재 state/goal/plan revision, DAG·누락 의존성, task ID 계약, 도구 버전/권한/입력, criterion/가설 근거 참조 검사 |
| 배정·호출 | owner/lease와 호출 예산 예약, dispatch 직전 상태/권한 재검사, CAS로 중복 배정·dispatch 방지 |
| 결과 | envelope/output schema, 출처·범위·label, 참조/순환·ID 충돌 검사, 원본 저장 → received → adopted 분리 |
| 제어 | continue/replan/wait/blocked/complete, pause/resume/cancel, 목표 revision 변경, 호출·재계획 상한과 기한 |
| 복구 | SQLite/원본 저장소 재개, 예약 만료 회수, 실행 중 읽기 재시도와 쓰기 unknown 분리 |
| 대기·취소 | 대기 상태의 반복 실행으로 사건/모델 호출이 증가하지 않음, lease 만료/결과 수신 때 runnable 전환 |
| 느린 도구 | 취소·lease timeout 뒤 제어 반환, 미완료 호출 조회와 늦은 결과 수신, 비동기 저장 실패 고정 진단 코드 |

실행 명령은 Node 24.20.0의 `npm run verify`다. 전체 **51개 시험**, 안쪽 계층 **14개 파일의 의존성 검사**, **4개 합성 시나리오·22개 완료/제어 판정**이 통과했다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P1-execution-verification.json)

P0 fixture에 기대값만 있던 `expectedControl`은 이제 명시적인 checkpoint 실행 상태와 함께 실제 `decide()` 결과를 비교한다. 예를 들어 ‘자료 없음’은 진행할 조회와 남은 예산이 있을 때 continue이고, 조회 예산이 이미 소진됐을 때 blocked다. 같은 자료 상태만 보고 둘을 구분할 수 없기 때문에 이 실행 입력을 보강했다.

## 코드를 읽을 순서

1. [제어 판정](/Users/seunghanee/Documents/secumon/runtime/src/domain/control.ts): 저장 상태에서 다음 동작을 고르는 함수.
2. [계획 검증](/Users/seunghanee/Documents/secumon/runtime/src/application/plan-validator.ts): 모델 제안이 실제 실행 가능한지 확인하는 경계.
3. [실행 코어](/Users/seunghanee/Documents/secumon/runtime/src/application/execution-runtime.ts): reserve/dispatch/receive/adopt와 사용자 명령을 별도 커밋으로 잇는 부분.
4. [근거 수락 검사](/Users/seunghanee/Documents/secumon/runtime/src/application/evidence-intake.ts): 도구의 성공 메시지만으로 근거를 신뢰하지 않는 이유.
5. [실행 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/execution.test.ts): 취소·늦은 응답·재시작·경쟁 배정을 재현하는 예제.

생각해 볼 문제는 ‘도구가 성공했는데 왜 업무가 완료되지 않을 수 있는가?’, ‘쓰기 실행의 결과를 받지 못했을 때 왜 같은 호출을 반복하면 안 되는가?’, ‘답을 얻었어도 담당자 회신 의무가 남으면 무엇을 보여줘야 하는가?’다. 각각 완료 조건·효과 대조·대화/전달 챕터로 이어진다.

## 확인 범위와 다음 작업

- P1-03은 work당 한 시도의 논리적 배정을 제공한다. 취소를 무시하는 외부 작업 자체를 강제 종료하거나 외부 시스템의 exactly-once 실행을 보장하지 않는다. 실제 adapter의 취소·멱등 키·대조 기능은 P3 연결 계약에서 검증한다. 읽기 lease 만료 후 재시도하면 외부의 이전 읽기와 물리적으로 겹칠 수 있다.
- unknown 쓰기는 대조 의무로 막고 일반 회신 해소 명령으로 우회하지 못하게 했다. 실제 시스템에서 효과를 조회·해소하는 adapter는 아직 없다.
- 모델이 필요한 시점은 replan으로 반환한다. scripted planner와 검증/실행의 연결은 시험했지만 모델 호출 예약·토큰 정산·실제 가설 추론 품질은 P1-06 작업이다. 자동·빠르게·깊게의 정책 차이도 후속 범위다.
- 첫 JSON Schema 구현은 Ajv 8.20.0과 draft-07이다. 등록 시 컴파일한 함수가 반복 검증에 사용되며 입력 값을 강제 변환하지 않는다. [공식 안내](https://ajv.js.org/guide/getting-started.html), [옵션](https://ajv.js.org/options.html).
- task ID 이력 확인은 현재 해당 work의 계획 수락 사건을 읽는다. 장기 이력의 조회량·색인·retention은 호출 장부와 저장/컨텍스트 챕터에서 개선한다.
- 실제 모델/API·사내 MCP·Knox·컴퓨터 유즈·운영 배포는 이번에 실행하지 않았다. 기존 API 키 실험 종료 상태를 유지한다.

다음은 **P1-04**다. 작은 도구 카탈로그에서 필요한 명세만 고르고, 호출 장부/근거 ID로 이미 얻은 결과를 찾으며, 지침 하나를 선택해 읽는 경로를 연결한다. 이후 P1-05에서 이 내부 사건들을 접수·현재 상태·필요 질문·결과 중심의 CLI로 보여준다.
