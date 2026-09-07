# C04 명시 목표 변경 Linux 검증 준비

이 폴더는 실행 준비본이다. 완료된 `C04-registered-linux-nas-20260907`의 현재 스크립트 9개를 재사용하고 이번 목표 변경 단위의 이름·단계·출처를 연결했다. 이전 스크립트와 실행 증거는 변경하지 않는다. `script-provenance.json`은 읽은 원본과 새 스크립트의 SHA256을 기록한다. 준비 단계에서 수행하는 검사는 구문과 정적 연결뿐이며 SSH·전송·시험·설정 생성·pin 생성·최종 증거 생성은 포함하지 않는다.

## 아직 확정하지 않은 입력

실행용 `targeted-files.json`은 아직 없다. root가 신규·관련 목록을 확정한 뒤 `{ "newFiles": [...], "relatedFiles": [...] }` 형태로 저장해야 한다. 각 목록은 중복 없는 `dist/tests/<name>.test.js` 경로이며 서로 겹치면 안 된다. 신규 묶음에는 다음 파일이 포함될 예정이다. 목록이나 파일 수로 실제 시험 수·통과를 추정하지 않는다.

- `dist/tests/agent-goal-change.test.js`
- `dist/tests/agent-goal-change-cli.test.js`
- `dist/tests/agent-goal-change-compact.test.js`
- `dist/tests/agent-turn-web.test.js`
- `dist/tests/web-view-state.test.js`
- `dist/tests/complex-agent-turn.test.js`

관련 목록은 core/session/execution/completion/request/body/raw receipt 회귀 중 root가 선택한다. 성공 alias의 예정 경로는 `evidence/C04-goal-new-result.json`, `evidence/C04-goal-related-result.json`이다. `prepare-upload.mjs`는 명시한 두 경로를 받으므로 최종 stage 이름이 달라져도 원 결과를 새로 실행하지 않고 선택할 수 있다.

두 alias는 현재 source/build pin과 일치하며 실제 Node 24 시험에서 생성한 원 stage JSON·로그·도구 종료 관측·각 SHA256을 참조해야 한다. `sourceObservation.before/after`와 원 stage의 `buildBefore/buildAfter`가 모두 같은 pin이어야 한다. 로컬 `C04-goal-run.mjs`의 형식을 그대로 소비하고 runner 자체는 수정하지 않는다. 최종 기록은 `recorded_exec_exit_observations` 역할의 JSON에서 `executions: [{stage, sessionId, exitCode}]`를 읽어 해당 stage의 `evidence/C04-goal-<stage>.log`와 종료 관측을 대조한다. 성공할 것이라는 예상으로 alias나 종료 관측을 만들지 않는다.

## 전용 환경과 보존 경계

재사용 예정 NAS root는 `/home/shaneee/secumon-linux-test.pCJ0bd`다. 완료된 `evidence-registered-c04/result.json`, private Node 24.20.0, 기존 의존성과 고정 자산 7개가 필요하다. 신규 원격 증거는 `evidence-goal-c04`, 소스 백업은 `before-goal-c04-attemptN`이다. 기본 시스템 Node 18은 변경하지 않으며 실행자가 실제 `/usr/bin/node --version` 관측값을 설정에 등록한다. 기존 등록 단위의 control socket은 재사용하지 않고 새 private socket을 준비한다.

의존성 잠금 파일이 다르면 설치나 덮어쓰기로 우회하지 않는다. 전송 대상은 기존 소스 allowlist와 이 단위의 runner/common/config/목록/pin/선택 결과뿐이다. 자격 증명은 찾거나 인수·파일·로그에 저장하지 않는다. 설정은 전용 root, SSH host 이름, 관측한 시스템 Node 버전, private control 디렉터리와 역사적 증거 경로만 담는다.

이전 등록 단위의 `verification.json`과 초기화 실패 진단은 별도 pin의 역사적 증거로 보존한다. 목표 변경 단위의 로컬 실패·진단 JSON도 root가 `configure`의 역사적 증거 인수로 선택한다. 재실행 통과가 이전 실패의 원인 확정이나 수정 증명이 되지는 않는다. 현재 소스가 변경 중이므로 준비본은 최종 pin이나 통과 수를 고정하지 않는다.

## root 실행 순서

아래 명령은 로컬 성공과 최종 pin·목록을 확정한 뒤 root가 실행할 예시다. 준비 작업에서는 실행하지 않는다. `runtime` 디렉터리에서 실행하고 변수는 실제 관측값으로 채운다. 이미 존재하는 설정·결과를 덮어쓰지 않는다.

```sh
NODE_BIN="/absolute/path/to/node-v24.20.0/bin/node"
HELPERS="evidence/C04-goal-linux-nas-20260907"
NAS_ROOT="/home/shaneee/secumon-linux-test.pCJ0bd"
SSH_HOST="configured-nas-host"
DEFAULT_NODE="vX.Y.Z"
CONTROL_DIRECTORY="/absolute/new-private-control-directory"

"$NODE_BIN" "$HELPERS/configure.mjs" "$NAS_ROOT" "$SSH_HOST" "$DEFAULT_NODE" "$CONTROL_DIRECTORY" \
  evidence-registered-c04/result.json \
  evidence/C04-registered-linux-nas-20260907/verification.json \
  evidence/C04-registered-profile-diagnosis.json
"$NODE_BIN" "$HELPERS/preflight.mjs"
"$NODE_BIN" "$HELPERS/prepare-upload.mjs" 1 \
  evidence/C04-goal-new-result.json evidence/C04-goal-related-result.json
"$NODE_BIN" "$HELPERS/start-native.mjs" 1
```

`configure`는 기존 private control socket을 검사할 뿐 새 SSH 연결을 만들지 않는다. `prepare-upload`는 전송과 원격 소스 교체를 수행하므로 읽기 전용 검사가 아니다. native 종료 후 성공 실행은 `collect-attempt.mjs final` → `close-native.mjs` → `finalize-evidence.mjs` 순서다. 실패하면 `collect-attempt.mjs attempt-N`으로 원 로그를 먼저 회수하고, 원인과 변경 범위를 확인한 다음 별도 attempt를 명시한다. 자동 재실행은 하지 않는다.

단계는 build → new-goal-change-tests → related-existing-tests → typecheck-core → architecture → architecture-cli-fixtures → all-tests → fixtures다. 전체 1,200초, 전체 시험 단계 900초, 다른 단계 180초, 개별 시험 60초 제한을 유지한다. 직접 실행한 detached 프로세스 그룹에 TERM 후 5초, KILL 후 5초의 종료 관측 한도를 적용하며 실제 leader 종료·stdio 닫힘·그룹 부재·로그 닫힘을 각각 기록한다.

`/proc` 감사는 comm 이름과 무관하게 같은 UID의 접근 가능한 exe/cwd가 전용 root 안에 있는 프로세스를 찾는다. 접근 불가능한 peer는 미확인으로 별도 남기며, 예상 밖 I/O 오류는 감사 실패로 유지한다. 관측 가능한 전용 프로세스 0과 직접 관리한 그룹 부재를 확인해도 전역 프로세스 부재를 주장하지 않는다. 별도 그룹으로 이동한 후손은 직접 그룹 종료 보장 밖이다. 시스템 Node 유지·전용 root 권한·SSH 종료 gate도 유지한다.

최종 `verification.json`은 같은 pin의 8단계 성공, 원 로그 9개 회수와 해시, 실제 자식 종료, 전용 root 감사와 SSH 종료를 확인한 뒤에만 생성한다. scope는 `explicit_general_goal_change_raw_receipts_control_and_compact`, status는 `verified_supported_local_posix_partial_chapter`이며 실제 시험 수는 TAP에서 읽는다. `chapterComplete`와 `goalComplete`는 false다.

로컬 `finishedAt`은 child 종료 후 로그 닫힘을 관측한 시각이다. 정확한 OS 종료 시각으로 표현하지 않는다. 원 stage에 `timedOut` 필드가 없으면 그 사실을 보존한다. 로컬 시험 Node, 로컬 build Node, 최종 기록 프로세스 Node, native Linux Node를 구분한다. 결정적 합성 제공자의 구조·출처·경합 검증이며 실제 모델/API 의미 품질, native Windows runtime/file binding, PostgreSQL, Knox/사내 서비스, 제품 배포, 전원 장애 내구성을 검증했다고 표현하지 않는다.
