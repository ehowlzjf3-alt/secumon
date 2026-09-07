# C05 MCP 일반 입구 Linux 검증 준비

**최종 검증 완료(2026-09-07).** 신규30/30·관련572/572·전체3368/3368, 필수8단계·원로그회수·관측 전용프로세스0·SSH정리를 확인했다. [확정 증거](verification.json)를 따른다. 아래는 실행 전 준비 절차의 기록이며, 완료한 native22557나 configure·시험·회수·finalize를 반복 실행하지 않는다.

**configure 전 준비 상태다.** 스크립트 9개를 직전 C05 호스트 검증에서 복제·교정했다. 이 폴더를 준비하면서 configure·업로드·NAS 접속·native runner·빌드·시험·최종 증거 생성은 실행하지 않았다. Node 구문 검사도 아직 실행하지 않았다. 원본/복제 스크립트 해시와 교정 범위는 `script-provenance.json`에 있다.

직전 확정 근거는 `../C05-host-linux-nas-20260907/verification.json`이다. 그 검증의 신규 54/54·관련 356/356·전체 3,338/3,338과 소스/빌드 pin을 이번 결과로 옮기지 않는다. 이전 증거·설정·control·결과·archive는 복사하거나 덮어쓰지 않았다.

## root가 실행 전에 확정할 입력

- 새 제품/시험 소스 동결 후 Node 24로 확인한 최종 pin과 같은 pin의 성공한 로컬 신규·관련 시험 alias. 경로 예시는 `evidence/C05-mcp-new-result.json`, `evidence/C05-mcp-related-result.json`이다. helper는 두 경로를 명시적으로 받는다.
- 새 `targeted-files.json`: `{ "newFiles": [...], "relatedFiles": [...] }`. `dist/tests/<name>.test.js` 형태이며 각 목록 내부와 두 목록 사이에 중복이 없어야 한다. 새 build의 실제 파일 존재를 runner가 확인한다. 시험 수·통과 수는 파일 수로 추정하지 않고 실제 TAP에서 읽는다.
- 기존 전용 NAS root와 시스템 Node 버전의 현재 관측, 새 private SSH control 디렉터리/소켓. 설정에는 자격 증명을 저장하지 않는다. 아래 configure는 연결을 만들지 않고 이미 준비한 control을 확인한다.

신규 목록의 시작점은 `host-provider-tools.test.js`, `mcp-host-tools.test.js`, `mcp-agent-profile.test.js`, `mcp-agent-entry.test.js`다. root가 최종 소스에 맞춰 확정한다. 관련 목록은 기존 `host-tools`/`host-tool-profile`/`host-tool-entry`, `execution-authority`/`tool-usage-authority`, `tool-catalog-lifecycle`, `mcp-stdio-client`, `mcp-read-*`, 도구 결과 검증·재사용, 일반 프로필·CLI/Web·workflow 경계를 중심으로 고른다. collection/wait의 기존 회귀 통과를 새 일반 입구의 collection/wait 구현 완료로 표현하지 않는다. 전체 시험 단계는 새 build의 모든 `*.test.js`를 발견하여 실행한다.

로컬 alias는 `sourceObservation.kind=per_run_source_and_build_verification`, `perRunBeforeCaptured=true`와 실제 Node 24 시험 런타임을 기록해야 한다. alias의 before/after, 원 stage의 sourceBefore/sourceAfter·buildBefore/buildAfter가 같은 최종 pin이어야 한다. 종료 관측에는 `executions: [{ stage, sessionId, exitCode }]`를 보존하며 `evidence/C05-mcp-${stage}.log`와 대조한다. `finishedAt`은 자식 종료 후 로그 닫힘을 관측한 시각이다. 없는 `timedOut` 필드를 실제 관측한 false로 바꾸지 않는다.

## 재사용 경로와 불변 경계

| 구분 | 이번 경로 |
|---|---|
| 선행 완료 원격 결과 | `evidence-host-c05/result.json` |
| 선행 로컬 확정 증거 | `evidence/C05-host-linux-nas-20260907/verification.json` |
| 새 원격 결과 | `evidence-mcp-c05` |
| 원격 소스 백업 | `before-mcp-c05-attemptN` |
| 원격 관리 파일/압축 접두사 | `mcp-c05-` |
| 새 로컬 증거 | `evidence/C05-mcp-linux-nas-20260907` |

예정 root `/home/shaneee/secumon-linux-test.pCJ0bd`의 private 권한, 전용 Node `24.20.0`, 시스템 Node 유지, 기존 dependency lock 동일성을 실행 시 재확인한다. 잠금 파일이 다르면 별도 설치 없이 우회하지 않는다. 기존 소스는 시도별 백업으로 보존한다. 업로드는 `src/scripts/fixtures`·package/tsconfig 파일과 명시한 관리 파일만 허용하며, 전송 해시·추출 소스 digest·native build pin·기존 고정 자산 7개를 대조한다. 새 MCP 시험 서버와 고정 계약도 `src`에 포함되므로 별도 다운로드가 필요 없다.

source/build 변경 여부 확인, 8단계 결과, 원로그와 결과 9개 회수·해시, 실제 종료·정리 검사는 이전 helper를 유지했다. 오래된 MCP stall의 원인을 이번 통과로 설명하지 않는다. 추가 trace나 audit export는 현재 runner에 자동 활성화하지 않았다. 기본 인수의 audit는 시험 안에서 확인 후 정리되므로 보존된 TAP와 해당 pin의 시험 코드가 그 관측의 근거다.

## 시간 상한

| 구간 | 상한 |
|---|---:|
| 전체 runner | 1,800초 |
| 전체 시험 | 1,200초 |
| 신규·관련 시험 각 단계 | 300초 |
| build·core·계층·CLI 구조·fixtures 각 단계 | 180초 |
| 개별 Node 시험 | 60초 |
| TERM 후 KILL까지 / KILL 후 관측 / 로그 flush | 각각 5초 |

Node 시험 동시성은 2다. 직전 전체 시험은 원격 결과의 10:18:31.859Z–10:33:02.313Z, **870.454초**로 이전 900초 상한에 가까웠다. 새 subprocess 인수를 더한 이번 상한은 그 관측에 여유를 둔 운영 한도이며, 성능 향상이나 이번 소요 시간을 예측한 수치가 아니다. 개별 시험 60초는 파일 전체·suite 합계의 시간 제한으로 바꾸지 않는다.

시간 초과와 실제 leader 종료 코드, stdio 닫힘, 프로세스 그룹 부재, 로그 flush를 각각 기록한다. timeout 후 exit 0이어도 통과로 처리하지 않는다. 직접 생성한 detached 자식 그룹만 TERM/KILL하며, 그룹 부재를 끝없이 기다리지 않는다. 같은 UID의 접근 가능한 exe/cwd가 전용 root에 속하는지 감사하고, 접근할 수 없는 peer는 미확인으로 남긴다. 관측 가능한 전용 프로세스 0을 시스템 전체 프로세스 부재로 확대하지 않는다.

## 실행 순서 — 이 준비에서는 실행하지 않음

root가 위 입력을 확정하고 스크립트를 검토한 뒤 `runtime`에서 실행한다. 로컬 Node 경로는 `.tools/node-v24.20.0-darwin-arm64/bin/node`다. 아래 변수 값은 실행 시 실제 관측값으로 채운다.

```sh
NODE_BIN="/absolute/path/to/node-v24.20.0/bin/node"
HELPERS="evidence/C05-mcp-linux-nas-20260907"
NAS_ROOT="/home/shaneee/secumon-linux-test.pCJ0bd"
SSH_HOST="configured-nas-host"
DEFAULT_NODE="observed-system-node-version"
CONTROL_DIRECTORY="/absolute/new-private-control-directory"

"$NODE_BIN" "$HELPERS/configure.mjs" "$NAS_ROOT" "$SSH_HOST" "$DEFAULT_NODE" "$CONTROL_DIRECTORY" \
  evidence-host-c05/result.json \
  evidence/C05-host-linux-nas-20260907/verification.json
"$NODE_BIN" "$HELPERS/preflight.mjs"
"$NODE_BIN" "$HELPERS/prepare-upload.mjs" 1 \
  evidence/C05-mcp-new-result.json evidence/C05-mcp-related-result.json
"$NODE_BIN" "$HELPERS/start-native.mjs" 1
```

원격 필수 순서는 **build → new-mcp-host-tests → related-existing-tests → typecheck-core → architecture → architecture-cli-fixtures → all-tests → fixtures**다. `start-native`의 실제 종료를 관측한 뒤 성공이면 `collect-attempt.mjs final` → `close-native.mjs` → `finalize-evidence.mjs` 순서로 실행한다. 실패하면 먼저 `collect-attempt.mjs attempt-N`으로 당시 결과와 존재하는 로그를 회수한다. 새 시도는 원인·변경 범위를 판단한 뒤 root가 선택하며 자동 재실행하지 않는다. finalizer는 이미 있는 `verification.json`을 덮어쓰지 않는다.

최종 scope는 `mcp_host_read_tools_general_entry`이며 `chapterComplete=false`, `goalComplete=false`다. 실제 모델/API·사내 MCP·Knox·배포·native Windows·PostgreSQL은 완료 주장에 포함하지 않는다. 단순 MCP raw 수신 뒤 result_received 전 복구, 전송 뒤 권한 변경 시 수신/known usage 보존, offline 일반 재개, 일반 입구의 페이지·대기 복구는 [필수 후속 순서](../../../design/chapters/C05-mcp-host-plan.md)에 남는다.
