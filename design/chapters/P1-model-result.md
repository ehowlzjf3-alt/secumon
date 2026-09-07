# P1-06 — 모델 호출과 가설·계획 변경: 로컬 구현 결과

2026-09-05 · 로컬 계약 검증 완료 · 작업 전체는 진행 중

[구현 계획](/Users/seunghanee/Documents/secumon/design/chapters/P1-model-plan.md)에 따라 planner를 기존 실행·저장·근거·대화 경로에 연결했다. 모델의 제안이 엄격한 검증을 통과한 뒤 업무 상태가 되는 경로를 구현했다. 실제 provider 통신과 모델의 추론 품질은 검증하지 않았다.

## 호출과 계획 수락은 서로 다른 상태 변경이다

| 단계 | 저장하거나 확인하는 내용 |
|---|---|
| reserve | provider/model/adapter revision, 목적지, 입력 artifact, 기반 상태/계획 버전, 예상 입력/최대 출력의 예약 |
| dispatch | 현재 권한·목표·계획·근거·시도 상태와 lease 확인, 발송 의도와 호출 횟수 기록 |
| receive | 응답의 구조/신원, 결과 artifact, 알려진 usage·미계측 부분 기록 |
| adopt | 입력 당시 업무 의미가 현재도 유효한지, 제안의 버전·도구/DAG·가설 근거를 검사한 후 계획 또는 평가 수락 |
| recover | 미발송 예약은 반환하고, 발송 후 응답을 잃은 호출의 비용은 unknown으로 유지 |

예약/수신/사용량 장부는 상태 revision을 올린다. 모델 응답의 숫자만 그대로 비교하면 정상 응답도 오래된 것으로 거부된다. 이를 해결하기 위해 목표·정책·계획·시도·근거·가설 평가·의무의 의미 digest를 보존한다. 응답은 원래 입력 revision을 제시해야 하며, 해당 의미가 현재와 일치할 때만 최신 커밋 revision에 대입해 검사한다. 현재 목표나 정책을 모델이 바꿀 수 있는 경로는 없다.

무효 계획도 이미 발생한 호출 비용은 남긴다. 최근 거부 사유 3개를 다음 계획 입력에 포함해 같은 오류를 고칠 수 있게 했다. 오류 본문이나 비밀 값을 피드백에 복사하지 않는다. 예제에서는 없는 도구 버전을 제안한 첫 호출을 거부하고, 다음 호출이 검증 사유를 읽어 유효 계획을 제안한 뒤 도구를 한 번만 실행했다.

## 가설이 바뀌어도 항상 작업 그래프를 바꾸지는 않는다

가설에는 질문·주장·예측·반증 조건·이유가 필요하다. supported/refuted/contested 상태에 맞는 근거 연결을 검사하고, 현재 근거의 supersession·권한 기준은 완료 판정과 공유한다. 같은 가설 ID의 의미를 바꾸거나 현재 지지/반증 연결을 조용히 없애는 제안은 거부한다. 오래된 근거가 대체된 경우 이전 사건 기록에 남기고 새 평가에서는 현재 근거를 사용한다.

활성 가설이 있고 현재 근거 집합이 이전 평가와 달라지면 검토를 요청한다. 초기 구현은 새 근거의 관련성을 보수적으로 판단해 재검토한다. 실제로 관계없는 근거까지 불필요하게 검토하는 비용은 P2의 효율 평가 대상이다. 새 평가가 기존 작업 그래프를 유지하면 plan revision과 replan 사용량은 바뀌지 않는다. 변경된 그래프는 완료 시도와 기존 작업 ID를 보존한 채 검증한다.

합성 문서 실험의 대역은 다음 평가를 제안했다. 엔진은 제안의 근거·상태·계획 변경을 검증하고 수락했다.

| 관측 단계 | 가설 평가 | 다음 행동 |
|---|---|---|
| 아직 자료 없음 | open | 최초 문서 조회 |
| 최초 문서가 90일 명시 | supported | 독립 문서와 개정 이력 조회를 계획에 추가 |
| 독립 문서가 30일 명시 | contested | 예정된 개정 이력 조회 유지 |
| 개정 이력이 옛 90일 문서를 대체 | refuted | 현재 독립 근거가 30일로 일치함을 완료 기준으로 판정 |

이 실험에서 모델 대역 호출 4회, 원천 도구 3회, 작업 그래프 재계획 1회였다. 나머지 평가는 그래프를 유지했다. 단순 문서/관측 업무는 가설 없이 모델 대역 1회와 도구 1회로 끝났다. 이는 고정 대역의 제안을 처리하는 실행 체계의 증거이며 실제 모델의 정확도나 호출 절감률을 측정한 결과는 아니다.

## 비용·취소·정보 경계

입력의 UTF-8 바이트 기반 추정과 최대 출력으로 호출 전 예산을 예약한다. 구조화 adapter는 instructions와 JSON schema까지 포함한 실제 transport 요청 크기를 계산한다. 이 값은 tokenizer의 실제 usage나 과금 상한 보장이 아니다. 실제 보고 토큰을 별도로 누적하며 부분 usage는 알려진 숫자만 기록한다. 미계측 호출은 예약을 남기고 다음 모델 호출을 차단한다. usage가 누락되는 실제 내부 모델을 지원하려면 후속 비용 정책/계측 adapter를 검증해야 한다.

입력 artifact를 읽는 동안 취소·목표 변경·권한 철회가 일어난 경우, 전송 직전 최신 검사에서 차단해 transport 호출 0회를 확인했다. 동일 실행기 안의 사용자 취소는 모델 AbortSignal로 연결한다. 취소를 무시하는 모델도 제어를 반환할 수 있으며 늦은 응답은 비용을 정산하되 만료/취소된 계획으로 사용하지 않는다. 다른 프로세스의 제어와 외부 서비스의 물리적 취소까지 원자적으로 보장하는 것은 아니다.

수신 artifact 저장 중 권한이 바뀌면 현재 정책으로 제한된 재검사를 수행한다. 알려진 usage는 보존하고, 허용되지 않는 응답 본문은 낮은 등급으로 다시 저장하지 않는다. 가설 검토나 모델 응답 대기가 남아 있으면 대화 계층도 결과 준비/전달을 멈춘다. 모델 수신/만료 상태는 저장소의 재개 대상 조회에 포함했다.

## 코드와 실습

1. [PlanningRuntime](/Users/seunghanee/Documents/secumon/runtime/src/application/planning-runtime.ts): 호출 장부·예산·입력·응답 수락·복구와 기존 executor 연결.
2. [구조화 adapter](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/structured-planner.ts): 설정 snapshot, provider 중립 transport, 엄격한 JSON/usage/잘림 처리. 숨은 재시도나 JSON 수정 호출이 없다.
3. [가설 재검토](/Users/seunghanee/Documents/secumon/runtime/src/domain/hypotheses.ts)와 [계획 검증](/Users/seunghanee/Documents/secumon/runtime/src/application/plan-validator.ts): 현재 근거·이력·변경과 유지 판정.
4. [기능 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/model-runtime.test.ts), [경계 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/model-boundaries.test.ts), [대화 연결 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/model-conversation.test.ts): 실제 상태를 따라 읽을 수 있는 예제.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm run build
node --test dist/tests/model-runtime.test.js
```

`composeRuntime`은 identity를 가진 planner를 주입하면 `planning`도 제공한다. `planning.runUntilYield(workId)`는 모델 예약/수신/수락과 기존 도구 실행을 연결한다. 기존 CLI의 `demo`는 계속 명시적인 합성 계획을 사용한다. 위 모델 실습은 테스트 파일의 주입 대역으로 실행하며 실제 모델 설정을 자동 읽지 않는다.

## 검증 범위와 다음 작업

`npm run verify`에서 **130개 시험**, 안쪽 계층 29파일/위반 0, 4개 fixture 시나리오·22개 완료/제어 판정이 통과했다. 이번 모델 관련 43개 시험에는 구조화 adapter 14개, 기능 12개, 경계 13개, 대화 연결 4개가 포함된다. SQLite와 artifact를 다시 연 뒤 저장된 응답을 수락하며 모델을 추가 호출하지 않는 경로도 확인했다. 독립 코드 검토에서 발견한 취소·수신 정책·결과 준비 경계 문제는 수정 후 관련 테스트와 전체 회귀 검증을 통과했다.

[검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P1-model-local-verification.json)에 범위·검사 결과·미검증 항목·당시 소스 hash를 저장했다. 실제 provider HTTP/MCP 연결, 실제 모델 품질·과금/usage 적합성, 토큰화 정확도는 미검증이다. 실제 API/사내 서비스 호출은 0회이며 종료한 키 탐색/시험을 재개하지 않았다.

P1-06 전체는 **in_progress**다. 검증 완료 작업 수는 기존 9개를 유지한다. 다음 로컬 구현은 P1-07의 상태 기반 최소 재개 패킷과 접수부터 결과까지의 중단/복구 통합이다. P1-06/P1-07의 실제 모델 통합 완료 조건은 그대로 남긴다. 이후 P2의 저장소 교체·기억·컨텍스트·호출 효율 작업으로 이어간다.
