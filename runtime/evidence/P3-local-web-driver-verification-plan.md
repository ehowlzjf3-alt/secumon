# v0.38 로컬 Web driver 검증 기록 준비

이 helper는 이미 끝난 실행의 로그·JSON·이미지를 읽어 기록한다. build, test, 서버, 브라우저, 모델/API를 실행하지 않는다. 현재는 준비 단계이며 최종 입력이 없는 상태에서 실행하면 안 된다.

수정 범위는 `P3-local-web-driver-record.cjs`와 이 문서다. 제품·시험 소스는 수정하지 않았다. 최종 실행과 결과 문서 갱신은 루트 담당이다.

## 보존할 이전 기준선

- 이전 정본: `runtime/evidence/P3-continuation-runner-local-verification.json`, v0.37, 1,930 tests, 190,463 bytes.
- 고정 SHA256: `26aaf65d6d106f0b1b7df696bb343da1e4f787c667f95925d9b3a9db39664127`.
- 이전 정본과 과거 log/artifact는 당시 해시로 대조한다. 그 JSON에 들어 있는 옛 `sources`, `buildFiles`, `buildManifest`, `codeDigest`를 현재 구현과 맞추려고 변경하거나 재생성하지 않는다.
- 현재 lock은 v0.37 `sources`의 `runtime/package-lock.json` pin과 같아야 한다. 이전 원본 목록 1,973개도 크기와 SHA256이 같아야 한다.
- workspace 및 runtime의 `.git` 부재를 유지한다. 과거 해시가 없는 중간 로그는 존재 여부만 확인한 것으로 구분한다.

## 최종 실행 전 루트가 확정할 것

1. 전체 Node 24.20.0 `npm run verify` 종료 코드·최종 단일 test summary·코어 타입 검사·architecture·fixture 4/22. skip이 있으면 통과 수와 분리하고 이유를 남긴다.
2. 관련 검증 로그와 종료 코드. 새 시험 그룹의 합은 `testsPassed - 1930`이고 작업 목록의 `additional_tests`와 같아야 한다. 별도 browser 검사 수를 전체 npm 검증 분모에 덧셈하지 않는다.
3. 실제 브라우저 JSON 및 별도 로그. SQLite/file-journal, 실제 browser/Playwright 버전, transport, programmatic DOM 입력, 외부 모델/서비스 0을 명시한다. fake transport나 선택적 browser skip을 실제 브라우저 통과로 표시하지 않는다.
4. 동일 목표 비교 JSON과 별도 로그. `synthetic:separate`, `synthetic:batched`, `web:separate`, `web:batched` 네 집단을 구분한다. 성공/시도, 모델 진입, 논리 tool call, 내부 메시지, 관찰/입력/저장, 이미지 수·bytes, 경과 시간을 각각의 분모와 함께 남긴다. 0·미측정·해당 없음은 구분한다.
5. desktop/mobile UI QA JSON, 관찰 방법, 이미지나 관측 로그. DOM helper 시험 통과만으로 실제 화면 QA를 대신하지 않는다.
6. 소유 브라우저와 loopback 서버 종료 확인 JSON 및 로그. 다른 사용자의 브라우저를 종료하거나 운영 서비스를 검사하는 작업은 포함하지 않는다.
7. 최종 `v0.38` 작업 목록·결과 문서·README·학습/검증/WORKLOG 링크. P3-04 `status=in_progress`, `local_contracts=partially_verified`, 전체 완료 작업 9개를 유지한다. `actual_driver=locally_verified_instrumented_web`, `actual_model=not_run`으로 이번 범위만 구분한다.

브라우저/비교/UI QA summary는 실제 관측에 사용한 runtime source digest를 보존해야 한다. helper의 `sourceDigestPointer`는 그 JSON의 실제 필드를 가리킨다. 최종 code digest와 다르면 helper는 기록을 거절한다. 실행 뒤 소스가 바뀌었으면 그 관측이 최신 결과인 것처럼 digest만 고치지 않는다.

## 입력 계약

루트가 최종 확정한 JSON을 `runtime/evidence/P3-local-web-driver-verification-input.json`처럼 별도 파일로 저장한다. 다음은 형식 예시이며 아직 관측값이 아니다. `FINAL_*` 문자열과 숫자는 실제 값으로 치환하고, JSON pointer는 실제 생성된 summary의 필드를 가리키도록 정한다. 추가 JSON parser/producer 형식을 제품에 강제할 필요는 없다.

```json
{
  "schemaVersion": 1,
  "ready": true,
  "actualDriver": "locally_verified_instrumented_web",
  "expectedInnerFiles": "FINAL_INTEGER",
  "verify": {
    "command": "npm run verify",
    "log": "runtime/evidence/P3-local-web-driver-verify.log",
    "exitCode": 0,
    "testsPassed": "FINAL_INTEGER",
    "testsSkipped": 0
  },
  "targeted": {
    "command": "FINAL_RECORDED_COMMAND",
    "log": "runtime/evidence/P3-local-web-driver-targeted-final.log",
    "exitCode": 0,
    "testsPassed": "FINAL_INTEGER",
    "testsSkipped": 0
  },
  "acceptanceEvidence": ["runtime/src/tests/FINAL_TEST_FILE.ts"],
  "browser": {
    "status": "passed",
    "summary": "runtime/evidence/FINAL_BROWSER_SUMMARY.json",
    "logs": ["runtime/evidence/FINAL_BROWSER_RUN.log"],
    "sourceDigestPointer": "/codeDigest",
    "checks": [{"pointer": "/passed", "equals": true}],
    "observation": {
      "driverKind": "instrumented_local_web",
      "nativeInput": false,
      "actualModelCalls": 0,
      "externalServiceCalls": 0,
      "backends": ["sqlite", "file-journal"],
      "browserVersion": "FINAL_VERSION",
      "playwrightVersion": "FINAL_VERSION",
      "transport": "FINAL_TRANSPORT"
    }
  },
  "comparison": {
    "status": "passed",
    "summary": "runtime/evidence/FINAL_COMPARISON_SUMMARY.json",
    "logs": ["runtime/evidence/FINAL_COMPARISON_RUN.log"],
    "sourceDigestPointer": "/codeDigest",
    "checks": [{"pointer": "/passed", "equals": true}],
    "observation": {
      "sameGoal": true,
      "actualModelCalls": 0,
      "cohorts": ["synthetic:separate", "synthetic:batched", "web:separate", "web:batched"],
      "timingClaim": "local_observation_only",
      "denominators": {"description": "FINAL_PER_COHORT_TRIAL_AND_COUNTER_DEFINITIONS"}
    }
  },
  "uiQa": {
    "status": "passed",
    "summary": "runtime/evidence/FINAL_UI_QA.json",
    "logs": ["runtime/evidence/FINAL_UI_QA.log"],
    "artifacts": ["runtime/evidence/FINAL_SCREENSHOT.png"],
    "sourceDigestPointer": "/codeDigest",
    "checks": [{"pointer": "/passed", "equals": true}],
    "observation": {"viewports": ["desktop", "mobile"], "method": "FINAL_OBSERVATION_METHOD"}
  },
  "shutdown": {
    "status": "passed",
    "summary": "runtime/evidence/FINAL_SHUTDOWN.json",
    "logs": ["runtime/evidence/FINAL_SHUTDOWN.log"],
    "checks": [{"pointer": "/ownedProcessesStopped", "equals": true}],
    "observation": {"ownedBrowserStopped": true, "loopbackServerStopped": true}
  },
  "additionalArtifacts": [],
  "knownLimits": []
}
```

`checks`는 실제 JSON의 필드를 지정한 값과 정확히 대조한다. `/a/0/b` 같은 JSON pointer와 `~0`/`~1` escape를 지원한다. 관측 성공, 실제 transport 여부, skip/실패 0, 입력·저장 횟수, 비교 집단과 종료 상태 등 핵심 필드를 충분히 지정한다. `observation`은 루트가 선언한 범위·분모이며 helper가 이미지에서 추론하거나 실제 브라우저 실행을 다시 입증한 값이 아니다. 이 차이는 결과 JSON에도 남는다.

## 최종 실행

workspace 루트에서 루트 담당자가 실행한다. 아래 명령은 이 준비 작업에서 실행하지 않았다.

```sh
runtime/.tools/node-v24.20.0-darwin-arm64/bin/node runtime/evidence/P3-local-web-driver-record.cjs --input runtime/evidence/P3-local-web-driver-verification-input.json
```

helper는 현재 소스와 compiled build stamp를 대조하고, 기존 기록 체인·원본·lock·문서 링크·JSON·guidance·작업 의존 관계를 검사한다. 모든 조건을 충족한 뒤 이번 `P3-local-web-driver-local-verification.json`만 기록한다. 이전 정본·로그·소스·dist는 쓰지 않는다. 실패 시 과거 성공 기록을 이번 성공으로 복사하지 않는다.

결과에 통과 수, skip 수, 실제 브라우저 관측, 동일 목표 비교, UI QA, 종료 확인과 각 hash를 따로 남긴다. 실제 브라우저 성공은 계측 localhost 앱 전용 DOM adapter의 성공이며, native 입력·비계측 사내 화면·조직 인증·운영 배포·실제 모델 성능·전체 재설계 완료의 증거가 아니다.
