# C04 등록 모델 연결 — 검증 결과

2026-09-07 · **macOS 신규 44/44·관련 245/245, NAS Linux 전체 3,253/3,253 및 필수 8단계 통과**. 등록 모델과 일반 입구 연결의 이번 단위를 검증했다. C04 전체와 상위 goal은 진행 중이며 실제 모델/API 시험 중단을 유지한다. [확정 증거](../../runtime/evidence/C04-registered-linux-nas-20260907/verification.json)를 기준으로 한다.

담당 설정의 모델 이름을 호스트가 등록한 객체에 연결하고, CLI와 Web에서 기존 주턴·도구·compact·답변 흐름을 사용하도록 구현했다. 기본 `local-contract-v1`은 정해진 문구를 처리하는 로컬 전송 예제다. 구조화 요청·응답 경계를 실제로 거치지만 외부 모델이나 사내 서비스에 접속하지 않는다.

사용법은 [등록 모델 가이드](C04-registered-model-usage.md), 범위와 인수 기준은 [등록 계획](C04-registered-model-plan.md), 변경 연결은 [구현 메모](C04-registered-model-implementation.md)를 참고한다.

## 구현된 연결

- C01 설정 v1/v2의 `model: null | {profile: string}`을 유지한다. `--provider registered`는 호스트 등록표의 정확한 이름을 선택한다. 없는 이름, 잘못된 계약, registered와 별도 synthetic compact의 혼합을 거절한다. 설정을 파일 경로·URL·실행 모듈로 해석하지 않는다.
- `AgentTurnHost`의 생성 함수에는 담당 ID·목적·스킬 모드만 전달한다. 반환된 신원·프롬프트·능력·입력 한도·메서드를 검사하고 고정한다. `runAgentTurnCli`, `openAgentWeb`, `openAgentTurnProfile`이 같은 등록표를 사용하며 HTTP 본문으로 모델이나 권한을 바꾸지 않는다.
- `StructuredSessionCompactAdapter`는 고정 지침·후보 스키마를 포함한 요청과 응답 파싱을 담당한다. 원문 조회·현재성·요약 채택·게시·사용량 정산은 기존 코어가 맡는다. `StructuredAgentModel`은 주턴과 compact의 신원·목적지·능력이 같은지 검사하고 두 입력 추정 설정과 주턴 프롬프트 지문을 함께 반영한다.
- 입력 한도와 출력 예약은 기존 `composeRuntime`을 통해 양쪽 호출 경로에 전달한다. 프롬프트·스키마·도구 정의까지 포함한 정규화 요청을 측정하며, 합성 예제라고 입력을 1토큰으로 취급하지 않는다. 원문·개인 기억·작업 장부 형식은 유지한다.
- 모델과 저장소를 열고 닫을 때 실패 원인을 보존한다. 초기화 이후 실패나 여러 정리 실패가 발생해도 다른 자원의 정리를 시도하고 최초 오류와 함께 전달한다. 이 과정에서 기존 `openAgentStores`의 정리 오류 소실도 한정 보완했다.

## 현재 확인된 검증

아래 표는 실제 종료 로그와 실행 기록으로 확인한 결과만 적었다. 진행 중인 후속 실행은 이전 실패와 별도로 기록한다.

| 단계 | 확인된 결과 | 근거 |
|---|---|---|
| 로컬 build2 | Node v24.20.0, 종료 0 | [실행 기록](../../runtime/evidence/C04-registered-build2.json), [원로그](../../runtime/evidence/C04-registered-build2.log) |
| 로컬 new2 | 신규 7개 시험 파일, **44/44 통과**, 실패·취소·skip 0, 종료 0 | [실행 기록](../../runtime/evidence/C04-registered-new2.json), [원로그](../../runtime/evidence/C04-registered-new2.log) |
| 코어 타입 core2 | 종료 0 | [실행 기록](../../runtime/evidence/C04-registered-core2.json), [원로그](../../runtime/evidence/C04-registered-core2.log) |
| 계층 architecture2 | 158개 대상 검사, 위반 0, 종료 0 | [실행 기록](../../runtime/evidence/C04-registered-architecture2.json), [원로그](../../runtime/evidence/C04-registered-architecture2.log) |
| 관련 회귀 related1 | **244/245 통과**, 기존 동시 초기화 시험 1개 실패 | [실행 기록](../../runtime/evidence/C04-registered-related1.json), [원로그](../../runtime/evidence/C04-registered-related1.log) |
| 동일 소스의 초기화 단독 진단 | 해당 시험 **1/1 통과**. 원래 실패 원인은 미확정 | [실행 기록](../../runtime/evidence/C04-registered-new-profile-diagnostic1.json), [원로그](../../runtime/evidence/C04-registered-new-profile-diagnostic1.log) |
| 관련 회귀 related2 | **245/245 통과**, 실패·취소·skip 0, 종료 0. 시험 파일 병렬도 1 | [실행 기록](../../runtime/evidence/C04-registered-related2.json), [원로그](../../runtime/evidence/C04-registered-related2.log) |
| Linux NAS | Node v24.20.0, 신규 **44/44**·관련 **245/245**·전체 **3,253/3,253** 통과. 빌드·코어 타입·계층·CLI fixture·전체 fixture를 포함한 8단계 성공 | [확정 증거](../../runtime/evidence/C04-registered-linux-nas-20260907/verification.json), [원 실행 기록](../../runtime/evidence/C04-registered-linux-nas-20260907/final/result.json) |
| 회수·정리 | 실행 10656 종료 0, 원로그·결과 9개 회수. 관측 가능한 전용 프로세스 0, SSH 종료. 접근 불가 같은 UID peer 2개는 범위 미확정으로 보존 | [회수 목록](../../runtime/evidence/C04-registered-linux-nas-20260907/final-collection.json), [정리 기록](../../runtime/evidence/C04-registered-linux-nas-20260907/cleanup.json) |

build2와 new2·related2는 실행 전후 소스가 같고, 두 시험 실행의 전후 빌드 지문도 일치한다. 실제 원로그·실행 종료·지문 관측을 묶은 [신규 결과](../../runtime/evidence/C04-registered-new-result.json)와 [관련 결과](../../runtime/evidence/C04-registered-related-result.json)가 생성되어 있다. 현재 확인한 고정본은 다음과 같다.

```text
sourceDigest  5fbcaf2a9e041479f06230548332db0860f91132a3ff2d366d7c9d69ca93f150
filesDigest   566f1372854a1399e2600c90d632ff97e320a0888606ff5bd890e0095b992b8a
fileCount     1611
```

지문은 시험한 소스와 빌드 파일이 같은지 비교하는 값이다. NAS 사전 확인에 들어 있는 `previousNative`는 **이전 문맥 창 단위**의 결과이며 이번 등록 단위의 Linux 통과로 계산하지 않는다. 사전 프로세스 확인도 전용 경로에서 관측 가능한 범위이고, 읽기 권한이 없는 다른 프로세스의 전역 부재를 증명하지 않는다.

## 신규 시험이 보여준 범위

[등록 흐름 시험](../../runtime/src/tests/registered-agent-flow.test.ts)은 실제 임시 담당 저장소에서 교정 X를 완료하고, 읽기 Y의 근거를 얻은 뒤 같은 업무의 후속 입력 16개를 추가했다. 호스트 입력 창을 좁힌 뒤 자동 compact를 여러 번 수행하고, 문맥에서 제외된 근거를 다시 조회하여 근거를 인용한 답변까지 진행하는 경로를 확인했다. 요약 경계 전진·이전 요약 연결·최신 원문 보존·원문 이력 불변·호출 정산과 작업별 장부 분리를 검사한다. 닫고 다시 연 뒤 같은 세션의 Z가 앞선 교정 결과를 이어 쓰는 경로도 포함한다. 자동 compact 횟수의 시험 계약은 **2회 이상**이며, 첫 실패 진단에서 관측한 3회를 최종 실행의 확정 횟수로 대체 기록하지 않는다.

별도 시험은 모델 응답이 저장된 직후 프로필을 닫고 다시 열어, 같은 응답을 추가 호출 없이 채택·전달하는지 확인했다. 신규 CLI/Web 시험은 실제 접수·허용된 읽기 도구·답변·재조회와 HTTP 입력에서 등록 정보를 바꿀 수 없는 경계를 확인한다. HTTP 시험의 통과는 실제 브라우저 화면 렌더링 검수와는 구분한다.

어댑터 시험은 신원·메서드·한도 계약, 고정 지시문을 포함한 입력 추정, 거절·잘린 응답·잘못된 JSON, 사용량의 숫자와 `null`, 송신 전후 취소, 현재 원문 인용과 요약 크기 검사, 자원 정리 실패를 다룬다. `[합성 주턴]` 고정 규칙의 성공을 자유 문장의 판단·계획·요약 품질로 해석하지 않는다.

## 실패 기록과 교정

첫 신규 실행은 [new1 원로그](../../runtime/evidence/C04-registered-new1.log)에 **39/41 통과, 2개 실패**로 남아 있다.

1. 바이트 비교 시험은 스키마가 추가하는 `planningFeedback: []`를 기대 요청에서 빠뜨려 22바이트 차이가 났다. 제품은 이미 정규화 요청을 측정·송신하고 있었다. 시험의 기대값을 같은 공개 스키마로 정규화했다.
2. 긴 대화 흐름은 compact 후보 3개를 정상 채택한 뒤, 제한된 다음 문맥에서 근거와 `fixture.read`가 빠지자 유한 합성 규칙이 질문으로 끝났다. [당시 진단](../../runtime/evidence/C04-registered-flow-diagnosis.json), [진단 원로그](../../runtime/evidence/C04-registered-flow-diagnostic.log)는 보존한다. 요약 게시 실패나 원문 삭제가 확인된 것은 아니다. 실제 원 요청→읽기→자동 compact→근거 답변이라는 인수 범위를 유지하기 위해 등록 예제에만 현재의 정확한 read 요청·생략된 근거·허용된 `core.evidence.get`을 함께 요구하는 재조회 규칙을 추가했다. 등록 신원 revision을 `registered-1`로 분리하고 경계 시험 3개를 보완한 결과 new2는 44/44 통과했다. 진단 JSON의 당시 제안은 역사 기록이며 최종 채택 경로는 위와 같다.

관련 회귀 related1의 오류는 기존 `agent-profile.test`의 여러 CLI 동시 초기화에서 나온 `agent_storage_path_unsafe`다. 같은 소스의 단독 진단은 1/1, related2는 245/245 통과했지만, 후자는 시험 파일 병렬도를 2에서 1로 낮춰 실행했다. 원래 실패 로그를 보존하며 경합 원인이 밝혀졌거나 안전 검사가 수정됐다고 결론내리지 않는다.

## 한계와 다음 단위

- 로컬 재조회 규칙은 `doc-current` 한 건, `detail: evidence`, 최대 4096바이트, 한 번의 계획된 시도를 대상으로 한다. 현재 요청·생략 조건·권한 거절 경계와 정상 재조회는 시험했지만, 조회 실패·부분 응답·크기 초과 이후 더 넓은 탐색이나 계획 수정을 수행하는 능력은 이 예제에 구현·검증하지 않았다. 범용 모델의 발견·반증·부분 재계획 능력을 대신하지 않는다.
- 현재 사용자·정책·도구 조립은 로컬 구성이며, 모델 등록이 사내 권한·SIEM/EDR/MCP·Knox 연결을 자동으로 제공하지 않는다. `modelInfo`는 호스트가 선택·선언한 정보이지 실제 연결 성공 증거가 아니다.
- 실제 모델/API·tokenizer 정확도·자유 문장 및 요약 품질, native Windows, PostgreSQL은 이번 결과로 완료되지 않는다. 패키지 공개와 안정적인 exports도 C10의 별도 범위다.
- 관련 회귀의 최초 경합 원인은 [진단 기록](C04-registered-profile-diagnosis.md)처럼 미확정으로 남긴다. NAS는 파일 병렬도 2로 통과했으나 원래 실패의 해결 근거로 일반화하지 않는다. 시스템 Node v18.20.4는 유지했고 전용 폴더의 Node v24.20.0을 사용했다. 실제 브라우저 렌더링과 클릭 검수는 이번 갱신에서 실행하지 않았다.

다음은 [복합 조사 인수 계획](C04-complex-turn-plan.md)의 일반 원문 → 두 가설 → 늦은 반증 → 필요한 작업만 추가 → 근거 답변, 그리고 판별 읽기 실패 후 질문 대기를 확인하는 단위다. 이후 [잔여 검토](C04-after-registration-review.md)에 따라 기존 명시 목표 변경 기능을 일반 CLI/Web에 연결한다. 기존 저장소·문맥 창·계획 검사기를 다시 만들지 않는다.
