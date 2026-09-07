# C04 모델 창 관리 Linux 검증 준비

이 폴더는 실행 준비본이다. C04 turn의 완료된 스크립트만 복사하고 이번 창 관리 단위의 경로·단계·로컬 관측 형식만 바꿨다. 원본 파일과 이전 실행 증거는 수정하지 않았다. `script-provenance.json`에 원본과 복사본 SHA256을 기록했다. 이 준비 작업에서는 스크립트 실행, SSH, 전송, 시험, 설정·소스 묶음·pin·최종 증거 생성을 하지 않았다.

`targeted-files.json`은 root가 선택한 `C04-window-new-files.json`의 신규 12개 파일과 `C04-window-related-files.json`의 관련 49개 파일을 순서까지 그대로 담는다. 시험 수와 통과 여부는 목록에서 추정하지 않고 선택한 실제 로그에서 읽는다. 이번 로컬 결과 alias는 `C04-window-new-result.json`, `C04-window-related-result.json`이다.

재사용하는 전용 NAS 경로에는 완료된 `evidence-turn-c04/result.json`, Node 24.20.0, 의존성과 기존 7개 고정 자산이 있어야 한다. 새 원격 증거는 `evidence-window-c04`, 새 원격 소스 백업은 `before-window-c04-attemptN`이다. 기존 의존성 잠금 파일이 다르면 설치나 덮어쓰기로 우회하지 않고 중단한다.

## 실행자가 확정할 입력

- 같은 전용 NAS root, SSH 설정의 host 이름, 실제 관측한 기본 Node 버전, 새로 연 private control socket 디렉터리.
- 현재 소스와 일치하는 두 로컬 성공 alias, 원 로그·stage JSON·도구 종료 관측·고정 pin의 지문. 이번 alias의 `sourceObservation.before/after`는 실제 `buildBefore/buildAfter`와 같아야 한다.
- 보존할 역사적 JSON 경로. 예를 들어 이전 turn의 `verification.json`은 역사 기록으로만 넣는다.

`finishedAt`은 이번 stage runner가 child 종료 후 로그 닫힘을 관측한 시각이다. 정확한 OS 종료 순간으로 바꾸어 쓰지 않는다. 원 stage에 `timedOut` 필드가 없다는 사실도 보존하며 정상 종료와 alias의 판단을 구분한다. 최종 증거는 실제 시험 Node 버전과 최종 기록 프로세스 Node 버전을 따로 기록한다.

## 실행 순서 예시

아래는 실행자가 검토 후 사용할 예시이며 이 준비 작업에서 실행하지 않았다. `runtime`에서 실행한다. `NODE_BIN`은 해당 로컬 빌드와 같은 실제 Node 실행 파일의 절대 경로로 정한다.

```sh
NODE_BIN="/absolute/path/to/node-v24.20.0/bin/node"
HELPERS="evidence/C04-window-linux-nas-20260907"
NAS_ROOT="/absolute/dedicated/nas/root"
SSH_HOST="configured-nas-host"
DEFAULT_NODE="vX.Y.Z"
CONTROL_DIRECTORY="/absolute/private/control-directory"

"$NODE_BIN" "$HELPERS/configure.mjs" "$NAS_ROOT" "$SSH_HOST" "$DEFAULT_NODE" "$CONTROL_DIRECTORY" \
  evidence-turn-c04/result.json evidence/C04-turn-linux-nas-20260907/verification.json
"$NODE_BIN" "$HELPERS/preflight.mjs"
"$NODE_BIN" "$HELPERS/prepare-upload.mjs" 1 \
  evidence/C04-window-new-result.json evidence/C04-window-related-result.json
"$NODE_BIN" "$HELPERS/start-native.mjs" 1
```

실제 native 종료를 확인한 뒤 성공한 실행만 `collect-attempt.mjs final` → `close-native.mjs` → `finalize-evidence.mjs` 순서로 처리한다. 실패한 실행은 먼저 `collect-attempt.mjs attempt-N`으로 원 로그를 보존한다. 재시도는 실패 원인과 변경 범위를 검토한 뒤 별도 승인된 실행이며 자동으로 반복하지 않는다. `prepare-upload`는 설정 생성 후 전송까지 수행하므로 로컬 사전 검사만 하는 명령이 아니다.

단계는 build → new-context-window-tests → related-existing-tests → typecheck-core → architecture → architecture-cli-fixtures → all-tests → fixtures다. 전체 1,200초, 전체 시험 단계 900초, 다른 단계 180초, 개별 시험 60초 제한과 직접 실행한 프로세스 그룹 정리를 그대로 유지한다. `/proc`에서 접근할 수 없는 다른 프로세스는 미확인으로 남기며 전역 프로세스 부재를 주장하지 않는다.

최종 `verification.json`은 성공 로그 회수·현재 pin 대조·전용 프로세스 정리·SSH 종료를 모두 확인한 뒤에만 생성한다. 합성 모델의 구조적 검증이며 실제 API 품질, native Windows, PostgreSQL, 사내 서비스 연동 또는 C04 전체/전체 goal 완료를 뜻하지 않는다. 이전 D2 초기화 오류와 MCP 정체의 원인은 이번 실행 결과로 확정하지 않는다.
