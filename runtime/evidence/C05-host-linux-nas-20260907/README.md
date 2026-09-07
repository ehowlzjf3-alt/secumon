# C05 호스트 읽기 도구 Linux 검증 준비

실행 준비본이다. 완료된 `C04-goal-linux-nas-20260907`의 관리 스크립트 9개를 복사하여 이번 단위의 이름·단계·출처만 연결했다. 원본 스크립트와 과거 실행 증거는 변경하지 않는다. `script-provenance.json`은 실제 읽은 원본과 사본의 SHA256을 기록하고, `preparation-check.json`은 Node 24 구문 검사와 정적 비교 결과만 담는다. **이 준비는 빌드·시험·SSH 접속·전송·실행 성공의 증거가 아니다.**

## root가 확정할 입력

- `targeted-files.json`: `{ "newFiles": [...], "relatedFiles": [...] }`. 각 목록은 중복 없는 `dist/tests/<name>.test.js` 경로이며 서로 겹치지 않아야 한다. 현재는 생성하지 않는다. 파일 수로 시험 수나 통과 수를 추정하지 않는다.
- 최종 소스/빌드 pin과 성공한 로컬 신규·관련 시험 alias. 예정 경로는 `evidence/C05-host-new-result.json`, `evidence/C05-host-related-result.json`이며, `prepare-upload.mjs`는 실제 선택 경로를 인수로 받는다.
- root가 작성하는 로컬 `evidence/C05-host-run.mjs`의 원 stage JSON·원로그·종료 관측. 이 준비에서는 해당 runner를 생성·수정·실행하지 않는다.
- 실제 관측한 전용 NAS root, SSH host, 시스템 Node 버전과 새 private control 디렉터리. 자격 증명은 인수·설정·로그에 저장하지 않는다.

로컬 alias의 `sourceObservation.kind`는 `per_run_source_and_build_verification`, `perRunBeforeCaptured`는 `true`여야 한다. `sourceObservation.before/after`와 원 stage의 `buildBefore/buildAfter`는 선택한 같은 pin이어야 한다. Node 24에서 수행한 원 stage의 `exitCode`, `signal`, `sourceBefore/sourceAfter`, `node`, `pid`, `startedAt/finishedAt`도 대조한다.

종료 관측 JSON은 `recorded_exec_exit_observations` 역할로 연결하고 `executions: [{ stage, sessionId, exitCode }]`를 보존한다. 최종 기록은 각 항목을 `evidence/C05-host-<stage>.log` 및 선택 alias와 대조한다. `finishedAt`의 의미는 `child_exit_then_log_close_observed_by_stage_runner`다. 자식 종료 후 로그 닫힘을 관측한 시각이며 정확한 OS 종료 시각으로 바꾸지 않는다. 원 stage에 `timedOut` 필드가 없으면 그 부재도 기록한다.

## 재사용 환경과 이전 결과

예정 전용 root는 `/home/shaneee/secumon-linux-test.pCJ0bd`다. 실행 시 같은 경로와 private 권한, 전용 Node `24.20.0`, 기존 의존성·자산을 다시 검사한다. 시스템 Node나 전역 환경을 바꾸지 않는다.

| 항목 | 정확한 위치 |
|---|---|
| 완료된 이전 원격 결과 | `evidence-goal-c04/result.json` |
| 보존할 이전 로컬 확정 증거 | `evidence/C04-goal-linux-nas-20260907/verification.json` |
| 이번 원격 증거 | `evidence-host-c05` |
| 이번 시도별 원격 소스 백업 | `before-host-c05-attemptN` |
| 이번 원격 파일 접두사 | `host-c05-` |

`configure`와 공통 검사기는 이전 원격 결과가 위 **goal-c04** 경로인지 확인한다. 자기 자신의 새 결과를 선행 완료로 인정하지 않는다. 이전 로컬 verification 경로도 역사적 증거 목록에 반드시 포함한다. 앞선 성공 수치나 미확정 초기화/MCP 진단을 이번 C05의 결과나 원인 규명으로 옮기지 않는다.

의존성 잠금 파일이 다르면 별도 설치 없이 우회하지 않는다. 업로드는 기존 `src/scripts/fixtures`와 지정된 package/tsconfig 파일, 이번 관리 파일로 제한한다. 고정 자산 7개의 기존 해시와 AppleDouble·링크·탈출 경로 거절을 유지한다. 기존 control socket 기록은 복사하지 않는다.

## 실행 순서 — 준비 단계에서는 실행하지 않음

아래는 로컬 신규·관련 검증과 최종 목록을 확정한 뒤 root가 실행할 예시다. `runtime` 디렉터리에서 실행하며 변수에는 실제 관측값을 넣는다. 이 저장소의 로컬 Node 경로는 `runtime` 기준 `.tools/node-v24.20.0-darwin-arm64/bin/node`다.

```sh
NODE_BIN="/absolute/path/to/node-v24.20.0/bin/node"
HELPERS="evidence/C05-host-linux-nas-20260907"
NAS_ROOT="/home/shaneee/secumon-linux-test.pCJ0bd"
SSH_HOST="configured-nas-host"
DEFAULT_NODE="vX.Y.Z"
CONTROL_DIRECTORY="/absolute/new-private-control-directory"

"$NODE_BIN" "$HELPERS/configure.mjs" "$NAS_ROOT" "$SSH_HOST" "$DEFAULT_NODE" "$CONTROL_DIRECTORY" \
  evidence-goal-c04/result.json \
  evidence/C04-goal-linux-nas-20260907/verification.json
"$NODE_BIN" "$HELPERS/preflight.mjs"
"$NODE_BIN" "$HELPERS/prepare-upload.mjs" 1 \
  evidence/C05-host-new-result.json evidence/C05-host-related-result.json
"$NODE_BIN" "$HELPERS/start-native.mjs" 1
```

`configure`는 이미 만든 private control socket을 확인하며 접속을 생성하지 않는다. `prepare-upload`는 소스 전송과 원격 교체를 수행한다. 성공 종료 후 `collect-attempt.mjs final` → `close-native.mjs` → `finalize-evidence.mjs` 순서로 진행한다. 실패하면 먼저 `collect-attempt.mjs attempt-N`으로 실제 로그를 회수한다. 새 시도는 원인과 변경 범위를 판단한 뒤 명시적으로 선택하며 자동 재실행하지 않는다.

필수 단계는 **build → new-host-tool-tests → related-existing-tests → typecheck-core → architecture → architecture-cli-fixtures → all-tests → fixtures**다. 전체 1,200초, 전체 시험 900초, 기타 단계 180초, 개별 시험 60초 한도를 유지한다. 직접 시작한 detached 프로세스 그룹에 TERM 후 5초, KILL 후 5초의 관측 한도를 적용한다. 실제 leader 종료·stdio 닫힘·그룹 부재·로그 닫힘을 각각 확인한다.

`/proc` 감사는 comm 이름을 사용하지 않고 같은 UID의 접근 가능한 exe/cwd가 전용 root 안에 있는지를 본다. 읽지 못하는 peer는 미확인으로 남기고 예상 밖 I/O 오류는 감사 실패다. 관측 가능한 전용 프로세스 0은 전역 프로세스 부재나 별도 그룹으로 이동한 모든 후손의 부재를 증명하지 않는다. 전용 root·시스템 Node 유지·SSH 종료 검사도 그대로다.

최종 `verification.json`은 같은 pin의 8단계 통과, 원로그와 결과 9개 회수·해시, 실제 종료·정리 확인 후에만 생성한다. scope는 `host_read_tools_and_execution_authority`, chapter는 `C05`, status는 `verified_supported_local_posix_partial_chapter`다. `chapterComplete`와 `goalComplete`는 false이며 시험 수는 실제 원로그에서 읽는다.

실제 모델/API, 사내 서비스·Knox, 쓰기 MCP, 제품 배포, native Windows 연결, PostgreSQL, 전원 장애 내구성과 모델 품질은 이 검증의 완료 주장에 포함하지 않는다. 로컬 시험 Node·빌드 Node·최종 기록 Node와 native Linux Node도 각각 기록한다.
