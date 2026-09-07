# C05 응답 보관·회계의 Linux 검증 준비

관리 스크립트만 준비했다. NAS 연결·전송·시험·최종화는 실행하지 않았다. **최종 로컬 성공을 확인하기 전에는 config, build pin, 선택 snapshot이나 성공 alias를 만들지 않는다.** 과거 recovery 실행·control·proof는 새 실행의 결과로 재사용하지 않는다.

원본은 [직전 recovery 관리 폴더](../C05-mcp-recovery-linux-nas-20260907/README.md)이며 파일별 원본/수정본 SHA는 `script-provenance.json`에 있다. 제품·시험 파일과 선행 증거는 이 준비에서 바꾸지 않았다.

## 실행 담당자의 순서

모든 명령의 작업 디렉터리는 `runtime`이다. `NODE_BIN`은 이 시스템에 설치된 **실제 Node24 경로**를 지정한다. macOS 작업 호스트에서는 `runtime/.tools/node-v24.20.0-darwin-arm64/bin/node`이며 아래 명령처럼 runtime 안에서는 `.tools/...`로 지정한다. 다음 명령은 사용 예시이고 아직 실행하지 않았다.

```sh
NODE_BIN="$PWD/.tools/node-v24.20.0-darwin-arm64/bin/node"
HELPERS="evidence/C05-mcp-custody-linux-nas-20260907"
"$NODE_BIN" "$HELPERS/select-local.mjs" \
  evidence/C05-mcp-custody-stage-selection.json \
  evidence/C05-mcp-custody-terminal-input.json
```

첫 JSON은 `{ "build":"buildN", "new":"newN", "related":"relatedN", "core":"coreN", "architecture":"architectureN" }`, 둘째 JSON은 `{ "executions":[{ "stage":"newN", "sessionId":실제번호, "exitCode":0 }], "synchronous":[...], "observedAt":"실제관측시각" }` 형태다. 두 파일은 root가 **실제로 종료한 다섯 단계**의 관측값으로 작성한다. 번호·pin·시험 수를 예제에서 가져오거나 로그 존재만으로 성공을 추정하지 않는다.

selector는 현재 검증된 build, 각 단계의 before/after source, 실제 Node·종료·그룹 정리·로그 닫힘, 성공 TAP/spec를 대조한다. 기본 Node spec reporter와 명시 `--test-reporter=tap`을 허용하며 `--test --test-concurrency=1|2 --test-timeout=60000` 뒤에는 명시 시험 경로만 허용한다. 최종 각 count는 정확히 한 번 있어야 한다. 통과한 시험을 reporter 변경만으로 재실행할 필요는 없다.

입력 목록은 [신규](../C05-mcp-custody-new-files.json)와 [관련](../C05-mcp-custody-related-files.json)을 실행 시 읽는다. 파일 수·시험 수를 코드에 고정하지 않으며 실제 stage argv와 같은 목록이어야 한다. selector 출력은 이 폴더의 `local-new-result.json`, `local-related-result.json`, `local-buildN-pin.json`, `tool-exit-observations.json`이다. 기존 출력은 덮어쓰지 않는다. 과거 실패 단계는 그대로 남고 최종 성공으로 선택되지 않는다.

그 뒤 새 private SSH control 수명을 root가 마련하고 실제 환경값을 확인한다. 아래 shell 변수는 root가 관측한 값으로 넣는다. 자격 증명을 인자로 넣지 않는다.

```sh
"$NODE_BIN" "$HELPERS/configure.mjs" "$NAS_ROOT" "$SSH_HOST" "$OBSERVED_DEFAULT_NODE" "$NEW_CONTROL_DIRECTORY" \
  evidence-mcp-recovery-c05/result.json \
  evidence/C05-mcp-recovery-linux-nas-20260907/verification.json
"$NODE_BIN" "$HELPERS/preflight.mjs"
"$NODE_BIN" "$HELPERS/prepare-upload.mjs" 1 \
  "$HELPERS/local-new-result.json" "$HELPERS/local-related-result.json"
"$NODE_BIN" "$HELPERS/start-native.mjs" 1
```

`configure`는 이미 마련한 control socket과 명시 입력을 검사·저장하며 연결을 만들지 않는다. 선행 원격 결과는 `evidence-mcp-recovery-c05/result.json`, 새 결과는 `evidence-mcp-custody-c05`, 새 백업은 `before-mcp-custody-c05-attemptN`이다. 종료한 exec 62370이나 선행 control 경로를 사용하지 않는다.

`prepare-upload`가 **그 시점의** 신규·관련 JSON, SHA, 실제 성공 stage argv를 다시 대조해 선택 snapshot과 현재 build pin을 기록한다. 시도별 `upload-attemptN-targeted-files.json`은 불변으로 남으며 `targeted-files.json`은 현재 시도의 사본이다. 전송은 source tar·runner·common·config·validation-inputs·targeted-files·build-pin의 7개다. 기존 source/dist는 별도 백업하고 dependency lock이 다르면 자동 설치하지 않는다. tar allowlist와 기존 고정 자산 7개 SHA 검사를 유지한다.

원격 순서는 build → 신규 → 관련 → core → 계층 → CLI 계층 fixture → 전체 시험 → fixture의 8단계다. 전체 시험은 새 build의 모든 `*.test.js`를 읽는다. 실제 종료를 관측한 뒤 다음을 실행한다.

```sh
"$NODE_BIN" "$HELPERS/collect-attempt.mjs" final
"$NODE_BIN" "$HELPERS/close-native.mjs"
"$NODE_BIN" "$HELPERS/finalize-evidence.mjs"
```

실패하면 먼저 `collect-attempt.mjs attempt-N`으로 존재하는 원로그와 결과를 보존한다. 자동 재시작하지 않는다. 성공 정리는 해당 새 실행의 프로세스 감사와 SSH/socket/control 제거를 기록한다. finalizer는 NAS에 다시 접속하거나 시험을 실행하지 않는다.

## 시간 상한과 최종 확인

전체 단계 예산 1,800초, full 단계 1,200초, 신규·관련 각 300초, 나머지 각 180초, 개별 Node 시험 60초, concurrency 2를 유지한다. TERM 뒤 KILL·종료 관측·로그 flush에는 각각 5초를 둔다. 시간 초과와 실제 exit를 별도로 기록하고 timeout 뒤 exit0도 통과로 세지 않는다. 전체 단계 예산은 정리 시간까지 포함한 정확한 프로세스 수명 1,800초 보장이 아니다.

최종화에 필요한 source 의존 자료는 최종 로컬 성공 alias와 선택 JSON, 현재 build manifest/pin, 실제 native 8단계와 전체 파일 목록, 원 결과+로그 9개 SHA, 7개 전송 SHA, 선행 proof, 새 cleanup/run 기록이다. 현재 선택 JSON이 업로드 뒤 바뀌거나 현재 build가 검증한 pin과 다르면 거절한다. 전체 시험 수는 실제 TAP에서 읽으며 준비 시점의 예상 수로 채우지 않는다. 기존 실패/다른 pin의 로그는 역사적 관측으로 구분한다.

이 단위는 decoded 응답 보관, 원 시도 known usage, 종료 drain/중단, 명시 CLI/Web 제어 뒤 회계와 현재 본문 권한 분리를 검증한다. 비공개 원 요청의 재개 거절과 공개 원 요청의 유효 checkpoint는 다른 인수다. profile 재접속은 discovery를 할 수 있어 완전한 offline 입구라고 부르지 않는다. sent는 원격 실행·과금 확정이 아니며 실제 모델 품질/API·사내 MCP/Knox·Windows native·PostgreSQL·전원 장애 내구성·C05 전체/goal 완료를 증명하지 않는다.
