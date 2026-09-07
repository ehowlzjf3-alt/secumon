# C05 MCP 저장 전용 일반 입구의 Linux 검증 준비

이 폴더는 [완료된 custody 관리 도구](../C05-mcp-custody-linux-nas-20260907/README.md)를 복제한 **실행 전 준비물**이다. 제품·시험·이전 원로그와 proof는 수정하지 않는다. config/control/pin/성공 alias는 복사하지 않았으며 NAS 연결·전송·시험·최종화도 실행하지 않았다.

새 최종 proof의 scope는 `mcp_offline_general_resume`, 원격 결과는 `evidence-mcp-offline-c05`, 백업은 `before-mcp-offline-c05-attemptN`이다. 선행 결과는 `evidence-mcp-custody-c05/result.json`이고, 완료된 custody proof SHA는 `3783a0a1f5ba3a4eea5a9a2231d5def3dbaf44a163c4444b8e559642283e463c`다. 해당 proof가 인증한 원격 result SHA도 configure/preflight/native/finalizer에서 대조한다. 종료한 exec 32757이나 이전 control 수명을 새 실행으로 재사용하지 않는다.

## 실행 담당자의 순서

모든 명령은 `runtime`에서 실행한다. 아래는 실행 예시이며 root가 실제 최종 성공과 새 SSH control을 확인한 뒤 수행한다. 자격 증명은 인자나 설정에 기록하지 않는다.

```sh
NODE_BIN="$PWD/.tools/node-v24.20.0-darwin-arm64/bin/node"
HELPERS="evidence/C05-mcp-offline-linux-nas-20260907"
"$NODE_BIN" "$HELPERS/select-local.mjs" \
  evidence/C05-mcp-offline-stage-selection.json \
  evidence/C05-mcp-offline-terminal-input.json
```

첫 JSON은 `{ "build":"buildN", "new":"newN", "related":"relatedN", "core":"coreN", "architecture":"architectureN" }`다. 둘째는 `{ "executions":[{ "stage":"newN", "sessionId":실제번호, "exitCode":0 }], "synchronous":[...], "observedAt":"실제관측시각" }`다. 정확히 선택된 다섯 단계의 실제 terminal 관측만 root가 넣는다. 로그가 있다는 이유로 종료나 성공을 추정하지 않는다.

selector는 각 원 stage JSON/log의 source before/after·build pin·Node·실제 exit/stdio close·프로세스 그룹 종료·로그 닫힘을 확인한다. `--test --test-concurrency=1|2 --test-timeout=60000` 뒤의 명시 시험 경로를 확인하며 기본 spec 또는 명시 TAP reporter의 최종 count가 각각 한 번 있어야 한다. 시험을 reporter 변경만으로 다시 실행할 필요는 없다.

[신규 목록](../C05-mcp-offline-new-files.json)과 [관련 목록](../C05-mcp-offline-related-files.json)은 실행 시 읽어 실제 argv와 대조한다. 준비 시점의 10/67파일, 신규143개, build1/new1 같은 숫자·stage·pin은 코드에 고정하지 않는다. 관련 시험 교정으로 최종 stage가 달라지면 실제 성공 묶음을 선택한다. source 목록의 dist 경로는 해당 최종 build의 파일로 확인한다.

selector 출력은 이 폴더의 `local-new-result.json`, `local-related-result.json`, `local-buildN-pin.json`, `tool-exit-observations.json`이다. **출력이 하나라도 있으면 두 번째 선택 실행을 거절한다.** 중단으로 일부만 게시됐어도 보존하고 조사하며 자동 덮어쓰기나 재선택을 하지 않는다. 원 실패 로그는 그대로 남는다.

그 뒤 root가 새 private control socket과 실제 환경을 확인한 값으로 다음을 실행한다.

```sh
"$NODE_BIN" "$HELPERS/configure.mjs" "$NAS_ROOT" "$SSH_HOST" "$OBSERVED_DEFAULT_NODE" "$NEW_CONTROL_DIRECTORY" \
  evidence-mcp-custody-c05/result.json \
  evidence/C05-mcp-custody-linux-nas-20260907/verification.json
"$NODE_BIN" "$HELPERS/preflight.mjs"
"$NODE_BIN" "$HELPERS/prepare-upload.mjs" 1 \
  "$HELPERS/local-new-result.json" "$HELPERS/local-related-result.json"
"$NODE_BIN" "$HELPERS/start-native.mjs" 1
```

configure는 이미 만들어진 control을 검사하고 새 설정만 저장한다. prepare-upload는 최종 로컬 alias·현재 선택·원 증거 SHA·현재 build를 다시 검증한 뒤 시도별 불변 선택 snapshot을 만든다. source tar, runner, common, config, validation-inputs, targeted-files, build-pin의 7개를 전송하며 원격 SHA를 확인한다. 기존 source/dist는 별도 백업하고 package-lock이 달라지면 자동 설치하지 않는다. tar allowlist와 기존 고정 자산 7개 SHA도 유지한다.

원격 단계는 build → 신규 → 관련 → core → 계층 → CLI 계층 fixture → 전체 시험 → fixture의 8개다. 신규 단계명만 `new-mcp-offline-tests`로 바꿨다. 전체 시험은 새 build의 모든 `*.test.js`를 사용한다. 실제 native 종료를 관측한 뒤에만 다음을 실행한다.

```sh
"$NODE_BIN" "$HELPERS/collect-attempt.mjs" final
"$NODE_BIN" "$HELPERS/close-native.mjs"
"$NODE_BIN" "$HELPERS/finalize-evidence.mjs"
```

실패 시 먼저 `collect-attempt.mjs attempt-N`으로 존재하는 결과·원로그를 보존하고 자동 재시작하지 않는다. 성공 시 결과+8로그의 9개 SHA, 전용 프로세스 관측, root0700/default Node 유지, SSH/socket/control 정리를 기록한다. finalizer는 네트워크나 시험을 실행하지 않으며 기존 verification.json을 덮어쓰지 않는다.

## 유지한 시간·증거 경계

전체 단계 예산 1,800초, full 단계 1,200초, 신규·관련 각각 300초, 나머지 각각 180초, 개별 시험 60초와 concurrency2를 유지한다. TERM 뒤 KILL·종료 관측·로그 flush에는 각각 5초를 둔다. 시간 초과와 실제 exit를 별도로 보존하고 timeout 뒤 exit0도 통과로 세지 않는다. 단계 예산은 정리 시간까지 포함한 정확한 프로세스 수명 보장이 아니다.

최종화는 실제 8단계 성공, 전체 파일 목록, 선택 JSON/SHA, 업로드 7개, 결과+원로그 9개, 현재 pin, 선행 proof, 새 cleanup을 모두 대조한다. 같은 UID에서 전용 root의 관측 가능한 exe/cwd와 직접 관리한 process group만 부재를 확인한다. 접근 불가 peer는 미확정으로 남으며 전 시스템 프로세스 부재라고 하지 않는다.

새 인수는 명시적 `stored_only` 등록으로 peer 생성·discovery 없이 저장된 plain-read 증명/usage를 복구하거나 미호출 업무를 connection_required로 기다리는 것이다. 실제 CLI fixture는 원 응답 복구·답변, localhost HTTP fixture는 미호출 업무 대기를 확인한다. 모든 모델/서비스가 offline이라는 주장이나 자동 online fallback은 아니다. 일반 입구 collection/page/wait 복구, 실제 모델 품질/API, 사내 서비스, native Windows, PostgreSQL, 전원 장애 내구성과 C05 전체/goal 완료는 이 proof의 범위가 아니다.

파일별 원본·수정본 SHA와 문법 확인 결과는 `script-provenance.json`, `syntax-check.json`에 남긴다. 문법 확인은 helper 실행이나 통합 검증 통과가 아니다.
