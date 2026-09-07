# C05 전송 후 응답 보관: Linux 검증 준비

2026-09-07. 최초 읽기 검토 뒤, 별도 위임으로 [새 관리 폴더](C05-mcp-custody-linux-nas-20260907/README.md)에 스크립트 사본을 준비했다. **이번 준비에서는 빌드·시험, NAS 연결·전송·실행을 하지 않았다.** 최종 로컬 성공과 새 control 수명은 root가 확정한다. 아래 최초 검토 내용보다 실제 실행 API는 새 README와 스크립트를 우선한다.

직전 [복구 proof](C05-mcp-recovery-linux-nas-20260907/verification.json)의 현재 SHA-256은 `f2fbe8a2e971f29bf182a9cf018d8122ef38b1c7996628e4e6b8da1b4e926960`이다. [직전 실행 메타데이터](C05-mcp-recovery-linux-nas-20260907/run-metadata.json)는 종료·회수 완료, [정리 기록](C05-mcp-recovery-linux-nas-20260907/cleanup.json)은 관측 가능한 전용 프로세스 0과 SSH 종료를 기록한다. **종료한 exec 62370, 당시 control 디렉터리/소켓, 결과·pin·proof를 이번 실행으로 재사용하거나 재실행하지 않는다.** 같은 NAS 전용 작업 루트는 새 사전 검사 후 사용할 수 있지만 새 control 수명과 새 결과 폴더가 필요하다. 직전 README의 ‘준비·미실행’ 문구는 초기 작성 시점 기록이며, 현재 종료 여부는 위 결과 파일을 따른다.

## 복제할 파일과 최소 치환

원본 폴더는 `runtime/evidence/C05-mcp-recovery-linux-nas-20260907`, 새 폴더 권고는 `runtime/evidence/C05-mcp-custody-linux-nas-20260907`이다. **원본 스크립트 파일만** 새 폴더로 복제하고 복제 전후 해시와 치환 내역을 새 `script-provenance.json`에 기록한다.

| 원본 파일 | 새 파일 / 필요한 변경 |
|---|---|
| `mcp-recovery-c05-common.mjs` | `mcp-custody-c05-common.mjs`: local directory, config 파일명, predecessor/history 필수값, 설명의 단위명 |
| `configure.mjs` | 같은 이름: config 출력명과 predecessor/history 고정 검사 |
| `preflight.mjs` | 같은 이름: common import만 변경; 현재 환경·선행 종료 검사 유지 |
| `prepare-upload.mjs` | 같은 이름: common import, 업로드 7개 이름·allowlist, 새 remote evidence·archive·backup 접두사 |
| `start-native.mjs` | 같은 이름: common import와 원격 runner 경로; 새 실행 메타데이터만 사용 |
| `verify-linux-mcp-recovery-c05.mjs` | `verify-linux-mcp-custody-c05.mjs`: import, config/pin/selection 입력명, evidence 경로, scope/template, 신규 stage 이름, 필수 신규 파일 목록 |
| `collect-attempt.mjs` | 같은 이름: common import, 원격 evidence, stage allowlist |
| `close-native.mjs` | 같은 이름: common import; 새 결과·새 control만 정리 |
| `finalize-evidence.mjs` | 같은 이름: import, 업로드 이름, stage 목록·TAP 참조, 로컬 evidence 접두사, 필수 신규 목록, proof scope·한계 |

새 README는 실제 준비 상태로 작성한다. 기존 `script-provenance.json`의 실행/구문검사 결과는 복사하지 않는다. `config.json`, `control-directory.txt`, `build-pin.json`, preflight/upload/run/cleanup/result/verification JSON, tar와 원로그는 이번 관측에서 새로 생성한다. 과거 값으로 빈칸을 채우지 않는다.

| 필드·경로 | 이번 값 |
|---|---|
| `configuration.previousNativeResult` | `evidence-mcp-recovery-c05/result.json` |
| 필수 `configuration.historyEvidence` | `evidence/C05-mcp-recovery-linux-nas-20260907/verification.json` |
| 새 원격 결과 폴더 | `evidence-mcp-custody-c05` |
| 시도별 소스 백업 | `before-mcp-custody-c05-attemptN` |
| 소스 업로드 | `mcp-custody-c05-source-attemptN.tar.gz` |
| 관리 파일 접두사 | `mcp-custody-c05-` |
| 신규 단계명 권고 | `new-mcp-custody-tests` |
| proof scope 권고 | `mcp_post_send_response_custody` |

`configuration.root`, `sshHost`, `expectedDefaultNode`, `configuredAt`, control 경로는 root가 이번에 확인한 값을 전달한다. 전용 NAS root의 예정값은 `/home/shaneee/secumon-linux-test.pCJ0bd`이지만 경로·owner·0700·Node·프로세스 상태를 새로 검사하기 전에는 사용 가능하다고 확정하지 않는다. 자격 증명은 스크립트·문서·로그에 넣지 않는다.

## 시험 선택과 로컬 관측을 연결하는 방법

이미 있는 [신규 선택](C05-mcp-custody-new-files.json)과 [관련 선택](C05-mcp-custody-related-files.json)을 입력으로 사용한다. 최초 검토 시 7/47개였고 이후 인수가 추가됐다. 새 스크립트는 숫자를 고정하지 않고 실행 시 선택 JSON·실제 성공 argv를 대조한다. 파일 수를 시험 수로 해석하지 않는다.

초기 신규 7개에 종료·실제 SIGKILL·일반 workflow/CLI/Web·기록 조회·본문 복구 인수가 추가됐다. `prepare-upload`가 `{newFiles, relatedFiles}` snapshot을 만들며 중복·서로의 겹침·빌드 출력의 파일 존재를 검사한다. 전체 회귀는 그 빌드의 모든 `*.test.js`를 대상으로 한다.

직전 `verify-linux-...mjs`, `finalize-evidence.mjs`, 로컬 `C05-mcp-recovery-select-local.mjs`에는 **옛 신규 5개 파일의 hard-coded equality 검사**가 있다. 새 사본에서 이번 동결 목록으로 함께 바꾸어야 한다. 신규 stage 문자열은 runner의 시간 상한 선택·TAP 집계와 collector/finalizer의 허용 목록·회수 목록 전체에서 일치시킨다. 이름 일부만 바꾸면 신규 단계가 기타 180초로 잘못 분류될 수 있다.

로컬 [custody runner](C05-mcp-custody-run.mjs)는 이미 별도로 존재하므로 다시 만들 필요가 없다. 같은 최종 source/build pin의 성공 단계들을 선택하는 alias 조립에는 직전 `C05-mcp-recovery-select-local.mjs`의 검증을 재사용할 수 있다. 이 경우 새 `C05-mcp-custody-select-local.mjs`에서 모든 로컬 접두사·필수 신규 목록만 바꾸고 다음 관측을 유지한다.

- root가 제공한 실제 `stage/sessionId/exitCode`와 원 stage JSON/log를 대조한다. 과거 sessionId와 성공 숫자를 재활용하지 않는다.
- `sourceObservation.kind='per_run_source_and_build_verification'`, before/after pin, 실제 시험 Node, exit·stdio close·그룹 부재·로그 닫힘·`timedOut:false`를 검사한다.
- 실제 실행한 신규/관련 목록이 동결된 선택 JSON과 같은지 확인한다.
- 새 `C05-mcp-custody-new-result.json`, `...-related-result.json`, `...-local-buildN-pin.json`, `...-tool-exit-observations.json`은 같은 성공 관측으로 생성한다. 기존 출력 덮어쓰기 금지를 유지한다.

[첫 검증 기록](C05-mcp-custody-first-validation-note.md)의 실패나 준비 fixture 교정은 역사적 원로그로 남긴다. 아직 진행 중인 단계, 이전 source pin의 결과, 단순히 파일이 생성된 결과 JSON을 최종 성공 alias로 고르지 않는다. 이번 문서는 최종 build 번호·pin·통과 수를 확정하지 않는다.

## 실제 실행 순서

모든 관리 명령은 `runtime` 디렉터리와 전용 Node24에서 수행한다. 아래 명령은 **이 문서 작성 중 실행하지 않았다.**

1. 제품/시험 소스 동결 → 같은 소스의 로컬 build·신규·관련·core·계층 검증 종료 확인 → 실제 종료 관측으로 결과 alias 생성. 새 스크립트 치환 검토와 구문 검사는 실행 담당이 별도로 수행한다.
2. 새 private control 디렉터리와 SSH master를 마련하고 현재 환경값을 확인한다. 새 `configure.mjs`에 전용 root, host, 관측한 기본 Node 버전, 새 control, `evidence-mcp-recovery-c05/result.json`, 위 선행 proof 경로를 명시적으로 넘긴다. configure는 연결을 만드는 도구가 아니라 이미 마련한 새 control/config의 검증·기록이다.
3. 새 `preflight.mjs`: 선행 원격 결과의 실제 종료/성공, Linux·Node24.20.0·원 root/0700·기본 Node 보존·관측 가능한 전용 프로세스 부재를 기록한다.
4. `prepare-upload.mjs 1 evidence/C05-mcp-custody-new-result.json evidence/C05-mcp-custody-related-result.json`: 현재 build 검증과 같은 pin의 로컬 alias/hash를 확인한 뒤 업로드한다.
5. `start-native.mjs 1`: 새 runner 한 번을 시작하고 반환된 **새** 실행 세션을 관측한다. 이 단계에서 이전 exec 62370이나 이전 start/close/updater를 호출하지 않는다.
6. 성공 종료와 실제 observer exit를 확인한 뒤 `collect-attempt.mjs final`로 원 결과/로그를 회수한다. 실패면 `collect-attempt.mjs attempt-N`으로 있는 단계의 원로그부터 보존하며, 원인 확인 없는 자동 재시작은 하지 않는다.
7. `close-native.mjs`: 새 최종 회수 결과/pin을 확인한 뒤 현재 전용 프로세스 감사 → 새 SSH master 종료 → 소켓 부재 확인 → 새 control 디렉터리 제거 → cleanup/run 메타데이터 기록.
8. `finalize-evidence.mjs`: 로컬에서만 원로그·관측·hash·pin·정리 증거를 재대조하여 **새** verification.json을 배타적으로 생성한다. 이 단계는 시험/NAS 연결을 다시 실행하지 않는다. 문서/HTML updater는 별도 root 작업이며 과거 updater를 재실행하지 않는다.

업로드 대상은 source tar, runner, common, config, validation-inputs, targeted-files, build-pin의 **7개**다. tar allowlist는 `src`, `scripts`, `fixtures`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.core.json`을 유지한다. 원격 기존 source/dist는 시도별 백업에 보존한다. lock이 다르면 자동 설치하지 않고 중단한다. 업로드 SHA와 추출 후 source digest를 검사한다. 기존 원격의 `architecture-cli-check.mjs` 재사용 및 고정 자산 7개(`internal-io` 5개, guidance 2개)의 SHA 검사도 그대로 둔다.

## 시간 상한·원로그·정리 의미

단계 순서는 `build → new-mcp-custody-tests → related-existing-tests → typecheck-core → architecture → architecture-cli-fixtures → all-tests → fixtures`로 유지한다.

| 경계 | 기존 상한 유지 |
|---|---:|
| 전체 단계 실행 시간 예산 | 1,800초 |
| 전체 Node 시험 단계 | 1,200초 |
| 신규/관련 각 단계 | 300초 |
| build/core/계층/CLI 구조/fixtures 각 단계 | 180초 |
| 개별 Node 시험 | 60초, concurrency 2 |
| TERM 이후 KILL / 이후 종료 관측 / 로그 flush | 각각 5초 |

기존 runner는 각 단계에 `min(남은 전체 예산, 해당 단계 상한)`을 적용하고 종료·로그 정리에 별도 유한 시간을 준다. 이것을 프로세스 전체의 정확한 1,800초 강제 종료 시각으로 확대 해석하지 않는다. timeout 상태와 실제 exit code/signal은 따로 기록한다. timeout 뒤 exit0이어도 통과하지 않는다. 직접 만든 detached 그룹에만 TERM/KILL을 보내고, timer·listener·출력 pipe를 정리하며 종료 관측도 무한 대기하지 않는다.

성공 회수는 `result.json`과 단계별 원로그 8개의 **9개 파일**이다. `final-collection.json`에 각 SHA를 저장하고 finalizer는 업로드 목록·원격 결과·로컬 관측·각 원로그 hash를 다시 대조한다. 실패 회수는 실제 존재한 단계만 보존한다. `leaderExit`, `stdioClose`, `groupAbsentConfirmed`, `logFlushCompleted`와 오류/timeout을 별도로 확인한다. `finishedAt`은 관측/기록 시각이며 물리 디스크 commit 시각을 증명하지 않는다.

프로세스 감사는 같은 UID에서 `exe`/`cwd`가 전용 root 안에 있는 **관측 가능한** 프로세스에 한정된다. 접근 불가 peer와 별도 그룹으로 옮긴 후손까지 부재라고 주장하지 않는다. `observedOwnedProcesses=0`, `sshClosed=true`, control 경로 부재는 새 실행의 실제 정리 결과로만 채운다.

## 새 proof의 범위

finalizer는 현재 로컬 build와 NAS build의 동일 pin, 새/관련/전체 실제 TAP, 8단계 종료, 원로그 hash, 환경·정리 관측을 연결한다. 최종 통과 수를 선행 단위에서 옮기지 않으며 `chapterComplete=false`, `goalComplete=false`를 유지한다.

새 scope는 SDK decoded capture, 현재 본문 권한과 분리된 원응답 보관, 같은 원 시도의 known usage 보완, protected raw의 문맥 경계에 더해 종료/실제 SIGKILL과 명시 workflow·CLI/Web 제어 뒤 회계 연결을 포함한다. 해당 시험의 최종 통과는 실제 실행 증거로만 확정한다. 현재 reopen의 provider discovery 때문에 완전한 offline 입구라고 주장할 수 없다. 기존 collection/page/wait 통합 잔여도 유지한다. 실제 모델/API·사내 MCP/Knox·운영 배포·Windows native·PostgreSQL·원격 실행/과금 확정·전원 장애 내구성은 이 검증으로 증명하지 않는다.
