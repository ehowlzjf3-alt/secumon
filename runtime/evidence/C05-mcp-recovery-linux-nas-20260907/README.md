# C05 단순 MCP 저장 응답 복구 검증 준비

**작성·검토 단계이며 실행하지 않았다.** 제품/시험이 동결되고 같은 소스의 로컬 검증을 통과한 뒤 root가 이 도구를 실행한다. 현재 폴더에는 설정·pin·SSH control·시험 결과·최종 proof가 없다. 기존 C05 MCP 확정 증거와 원로그는 변경하지 않는다.

재사용 근거는 [직전 MCP 검증](../C05-mcp-linux-nas-20260907/verification.json)과 해당 관리 스크립트다. 이전 전체 시험의 실제 관측은 약 **885.8초**였으며, 이는 이번 시험 소요 시간이나 성능 예상값이 아니다. 과거 pin과 통과 수를 이번 결과로 옮기지 않는다. 복제 전후 파일 해시는 `script-provenance.json`에 남긴다.

## 준비된 API

모든 명령은 `runtime` 디렉터리에서 Node24로 실행한다. 아래는 사용 방법이며 이 준비 작업에서 실행한 명령이 아니다.

```sh
NODE_BIN="/absolute/path/to/node-v24.20.0/bin/node"
HELPERS="evidence/C05-mcp-recovery-linux-nas-20260907"

"$NODE_BIN" evidence/C05-mcp-recovery-select-tests.mjs
"$NODE_BIN" evidence/C05-mcp-recovery-select-tests.mjs --write
"$NODE_BIN" evidence/C05-mcp-recovery-run.mjs build1 npm run build
```

선택기는 인자 없이 신규·관련 목록과 근거를 출력한다. `--write`일 때만 `evidence/C05-mcp-recovery-new-files.json`, `evidence/C05-mcp-recovery-related-files.json`, 이 폴더의 `targeted-files.json`·`selection-notes.json`을 새로 만든다. 현재 source의 파일 존재와 목록 중복을 검사하며 기존 출력이 있으면 거절한다. **선택기는 빌드·시험을 실행하지 않는다.**

로컬 runner의 API는 `stage command ...args`로 이전과 같다. 예를 들어 선택기 출력의 신규 목록을 Node `--test --test-concurrency=2 --test-timeout=60000 --test-reporter=tap ...files` 인자로 넘긴다. `new1`·`related1` 같은 단계명은 각각 `C05-mcp-recovery-<stage>.log/.json`으로 보존한다. 이미 있는 단계 이름을 다시 쓰지 않는다. 로컬 runner는 신규·관련 단계 300초, 기타 180초와 직접 생성한 detached 그룹의 TERM/KILL·종료 관측 상한을 적용한다. Node24 디렉터리를 자식 PATH 앞에 놓으며 시스템 Node를 바꾸지 않는다.

로컬 alias는 root가 성공한 최종 단계만 골라 `C05-mcp-recovery-new-result.json`·`C05-mcp-recovery-related-result.json`으로 작성한다. 기존 `per_run_source_and_build_verification` 형식을 유지한다. `sourceObservation.before/after`, 실제 stage의 `sourceBefore/sourceAfter/buildBefore/buildAfter`, Node24, 원로그 hash와 종료 관측을 담아야 한다. `processEvidence`의 실제 root 실행 sessionId/exit와 `executions: [{stage, sessionId, exitCode}]` 기록은 root가 확인한 값만 넣는다. finalizer는 `evidence/C05-mcp-recovery-${stage}.log`를 대조한다. 실행하지 않은 결과 alias는 만들지 않는다.

새 로컬 stage는 `status=passed`, 실제 `timedOut=false`, leader exit·stdio close, 그룹 부재, 로그 handle 닫힘과 오류 없음도 남긴다. `assertLocalStageObservation`은 이 값들을 검사한다. `finishedAt`은 자식 종료와 로그 닫힘 뒤 관측값이며 물리 디스크 동기화 시각이 아니다.

## 신규 5개와 관련 30개 파일의 선택

신규는 `stored-tool-results`, `stored-result-runtime`, `mcp-stored-result`, `mcp-stored-result-recovery`, `stored-result-workflow`다. 실제 C01 SQLite/file-journal과 stdio peer의 SIGKILL, 후보·proof·실행기 및 원문 검증, 최초 ContextRecovery 앞 복구 순서와 작은 재개 문맥 한도를 확인한다. 숫자 5는 파일 수이며 실제 시험 수가 아니다.

관련 목록은 선택기 안에 근거와 함께 고정했다.

- 기존 MCP stdio·단순 읽기·coverage 및 P3 collection/settlement/wait 복구: 공유 원문과 원 영수증 의미 유지.
- 기존 host provider·MCP 등록·C01 profile·CLI/Web: 같은 보관 포트와 발견/닫기 수명 유지.
- 실행·복구·결과 검증·재사용·권한·usage·broker: 정상 owner 검사와 현재성, 측정값 보존 유지.
- 계약 snapshot과 catalog, workflow/crash/지속 업무·일반 답변: 새로운 복구가 신규 예약이나 완료 순서를 건너뛰지 않음.
- model runtime·compact runtime/window·일반 compact: 저장 결과 정산이 새 모델 호출보다 먼저인지, disclosure: 재개가 권한을 넓히지 않는지 확인.

변경되지 않은 C01 초기화/이관, C03 CRUD/UI, 다른 컴퓨터·게시판·A2A 영역은 관련 목록을 다시 크게 늘리지 않고 이후 전체 시험에서 확인한다. collection/wait 기존 회귀는 이번에 일반 입구의 collection/wait까지 새로 구현했다는 뜻이 아니다.

## Linux 준비와 실행 순서

| 경계 | 값 |
|---|---|
| 선행 원격 완료 결과 | `evidence-mcp-c05/result.json` |
| 선행 로컬 proof | `evidence/C05-mcp-linux-nas-20260907/verification.json` |
| 새 원격 결과 | `evidence-mcp-recovery-c05` |
| 새 소스 백업 | `before-mcp-recovery-c05-attemptN` |
| 관리 파일·업로드 접두사 | `mcp-recovery-c05-` |
| 새 로컬 결과 폴더 | `evidence/C05-mcp-recovery-linux-nas-20260907` |

예정 전용 root `/home/shaneee/secumon-linux-test.pCJ0bd`는 실제 실행 때 다시 확인한다. 시스템 Node18의 정확한 버전, root 0700과 private Node24.20.0, 파일시스템, 관측 가능한 같은 UID 전용 프로세스 부재를 사전 감사한다. 새 private control 디렉터리와 소켓은 root가 별도로 만들고 확인한 뒤 넘긴다. 기존 control 파일·경로를 복사하지 않으며 자격 증명을 스크립트·환경 출력·문서에 쓰지 않는다.

```sh
NAS_ROOT="/home/shaneee/secumon-linux-test.pCJ0bd"
SSH_HOST="configured-nas-host"
DEFAULT_NODE="observed-system-node-version"
CONTROL_DIRECTORY="/absolute/new-private-control-directory"

"$NODE_BIN" "$HELPERS/configure.mjs" "$NAS_ROOT" "$SSH_HOST" "$DEFAULT_NODE" "$CONTROL_DIRECTORY" \
  evidence-mcp-c05/result.json \
  evidence/C05-mcp-linux-nas-20260907/verification.json
"$NODE_BIN" "$HELPERS/preflight.mjs"
"$NODE_BIN" "$HELPERS/prepare-upload.mjs" 1 \
  evidence/C05-mcp-recovery-new-result.json evidence/C05-mcp-recovery-related-result.json
"$NODE_BIN" "$HELPERS/start-native.mjs" 1
```

configure는 이미 있는 새 control socket과 명시 입력을 검사해 기록할 뿐, 연결·업로드·pin·결과를 만들지 않는다. prepare-upload는 로컬 alias/hash/pin과 preflight를 대조한 뒤 허용된 source/package/tsconfig와 관리 파일 7개만 전송한다. 이전 source/dist는 시도별 백업으로 보존한다. dependency lock이 다르면 자동 설치하지 않는다. 기존 고정 자산 7개 검증도 유지한다.

필수 순서는 **build → new-mcp-stored-result-tests → related-existing-tests → typecheck-core → architecture → architecture-cli-fixtures → all-tests → fixtures**다. 전체 시험은 정확한 새 build에서 발견한 모든 `*.test.js`를 사용한다. 새/관련 파일 수로 통과 수를 만들지 않고 실제 TAP에서 읽는다.

| 실행 상한 | 시간 |
|---|---:|
| Linux 전체 runner | 1,800초 |
| Linux 전체 시험 단계 | 1,200초 |
| 신규·관련 각 단계 | 300초 |
| build/core/계층/CLI 구조/fixtures 각 단계 | 180초 |
| 개별 Node 시험 | 60초 |
| TERM→KILL / KILL 뒤 종료 관측 / 로그 flush | 각각 5초 |

Node 시험 concurrency는 2다. timeout 뒤 exit0이어도 통과로 처리하지 않는다. 실제 leader exit·stdio close·직접 생성한 그룹 부재·로그 flush를 구분한다. 접근할 수 없는 `/proc` peer는 미확인으로 남긴다. 관측 전용 프로세스0은 모든 시스템 프로세스가 없다는 보장이 아니며 별도로 그룹을 옮긴 후손의 부재를 주장하지 않는다.

성공 종료를 root가 확인한 뒤 `collect-attempt.mjs final` → `close-native.mjs` → `finalize-evidence.mjs` 순서로 실행한다. 실패 시 먼저 `collect-attempt.mjs attempt-N`으로 원 결과와 존재하는 로그를 회수한다. 원인 판단 전 자동 재실행하지 않는다. final proof는 8단계·9개 회수 파일의 hash·같은 pin·현재 빌드·전용 프로세스 감사·SSH 종료를 확인한 뒤 새로만 생성한다.

## 남는 범위

최종 scope 예정은 `mcp_stored_result_recovery_general_entry`이며 `chapterComplete=false`, `goalComplete=false`다. 이번 결과는 실제 MCP 도구가 반환한 SDK 해석 응답을 같은 시도에 복원하는 제한된 구조 검증이다. 원시 네트워크 프레임 보관, 물리 commit 시각·전원 장애 내구성, 실제 모델 의미 품질/요금, 사내 MCP·Knox·운영 배포를 증명하지 않는다. native Windows runtime/file 연결과 PostgreSQL은 미구현/미연결 또는 미검증이다.

raw 파일만 있거나 intent만 있는 경우를 성공으로 추정하거나 재전송하지 않는다. 전송 뒤 권한 변경 시 원응답·known usage 보존, 서버 없는 일반 재개, 일반 입구 collection/page/wait 복구는 후속으로 남긴다. 이전 초기화 race와 MCP stall의 미확정 원인을 이번 결과로 해결했다고 표현하지 않는다.
