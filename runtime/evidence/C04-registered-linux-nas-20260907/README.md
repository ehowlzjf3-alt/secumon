# C04 등록 모델 Linux 검증 준비

이 폴더는 실행 준비본이다. 완료된 `C04-window-linux-nas-20260907`의 스크립트 9개를 재사용하고 이번 등록 모델 단위의 이름·단계·출처를 연결했다. 이전 스크립트와 실행 증거는 변경하지 않았다. `script-provenance.json`은 원본·복사본·시험 목록·기존 로컬 runner의 SHA256을 보존한다. 이 준비 작업에서는 구문과 정적 연결만 확인하며, SSH·전송·시험·설정 생성·pin 생성·최종 증거 생성을 하지 않는다.

`targeted-files.json`은 `C04-registered-new-files.json`의 신규 7개 파일과 `C04-registered-related-files.json`의 관련 33개 파일을 순서까지 그대로 담는다. 파일 수로 시험 수나 통과를 추정하지 않는다. 선택할 로컬 결과 alias는 `C04-registered-new-result.json`, `C04-registered-related-result.json`이며, 실제 성공 로그와 원 관측 JSON이 필요하다.

재사용할 전용 NAS root에는 완료된 `evidence-window-c04/result.json`, Node 24.20.0, 의존성 및 기존 7개 고정 자산이 있어야 한다. 새 원격 증거는 `evidence-registered-c04`, 소스 백업은 `before-registered-c04-attemptN`이다. 의존성 잠금 파일이 다르면 설치나 덮어쓰기로 우회하지 않는다. 기본 시스템 Node를 변경하지 않는다.

## 실행자가 확정할 입력

- 같은 전용 NAS root, SSH 설정의 host 이름, 실제 관측한 기본 Node 버전, 새 private control socket 디렉터리.
- 현재 소스와 같은 두 로컬 성공 alias. Node 24에서 실행한 `C04-registered-run.mjs`의 원 stage JSON, 로그, 도구 종료 관측, 고정 pin 및 각각의 지문이 있어야 한다.
- 각 alias의 `sourceObservation.before/after`와 원 stage의 `buildBefore/buildAfter`가 같은 pin이어야 한다. 이번 준비본은 이전 방식의 사후 pin 확인만으로 대체하지 않는다.
- 보존할 역사적 JSON 경로. 이전 window의 `verification.json`은 별도 pin의 역사적 증거로만 취급한다.

로컬 `finishedAt`은 child 종료 후 로그 닫힘을 관측한 시각이다. 정확한 OS 종료 시각으로 표현하지 않는다. 원 stage에 `timedOut` 필드가 없으면 그 사실을 보존하며 alias의 정상 종료 판단과 구분한다. 최종 증거는 로컬 실제 시험 Node, 로컬 build Node, 최종 기록 프로세스 Node, native Linux Node를 따로 기록한다.

## 실행 순서 예시

아래는 root가 로컬 성공과 최종 pin을 확인한 뒤 사용할 예시다. 준비 작업에서는 실행하지 않는다. `runtime` 디렉터리에서 실행하며 변수는 운영자가 확인한 값으로 채운다. 자격 증명은 인수나 파일에 저장하지 않는다.

```sh
NODE_BIN="/absolute/path/to/node-v24.20.0/bin/node"
HELPERS="evidence/C04-registered-linux-nas-20260907"
NAS_ROOT="/absolute/dedicated/nas/root"
SSH_HOST="configured-nas-host"
DEFAULT_NODE="vX.Y.Z"
CONTROL_DIRECTORY="/absolute/private/control-directory"

"$NODE_BIN" "$HELPERS/configure.mjs" "$NAS_ROOT" "$SSH_HOST" "$DEFAULT_NODE" "$CONTROL_DIRECTORY" \
  evidence-window-c04/result.json evidence/C04-window-linux-nas-20260907/verification.json
"$NODE_BIN" "$HELPERS/preflight.mjs"
"$NODE_BIN" "$HELPERS/prepare-upload.mjs" 1 \
  evidence/C04-registered-new-result.json evidence/C04-registered-related-result.json
"$NODE_BIN" "$HELPERS/start-native.mjs" 1
```

native 종료를 확인한 뒤 성공 실행은 `collect-attempt.mjs final` → `close-native.mjs` → `finalize-evidence.mjs` 순서로 처리한다. 실패 실행은 `collect-attempt.mjs attempt-N`으로 원 로그를 먼저 보존한다. 원인과 변경 범위를 검토한 다음 실행만 별도 attempt로 진행하며 자동으로 재시도하지 않는다. `prepare-upload`는 전송과 원격 소스 교체까지 수행하므로 로컬 읽기 전용 검사 명령이 아니다.

단계는 build → new-registered-model-tests → related-existing-tests → typecheck-core → architecture → architecture-cli-fixtures → all-tests → fixtures다. 전체 1,200초, 전체 시험 단계 900초, 다른 단계 180초, 개별 시험 60초 제한을 유지한다. 직접 실행한 detached 프로세스 그룹에 TERM 후 5초, KILL 후 5초의 종료 관측 한도를 적용한다. `/proc`의 모든 comm 이름을 확인하되 접근 가능한 같은 UID의 exe/cwd가 전용 root에 속하는 프로세스만 소유를 확정한다. 접근 불가능한 peer는 미확인으로 보존하며 전역 프로세스 부재를 주장하지 않는다.

최종 `verification.json`은 성공한 8단계 원 로그 회수, 현재 source/build pin 일치, 실제 자식 종료·소유 그룹 부재, 전용 root 감사, SSH 종료를 확인한 뒤에만 생성한다. scope는 `registered_model_profile_general_entry_structured_compact`, status는 기존과 같은 `verified_supported_local_posix_partial_chapter`다. 실제 시험 수는 TAP 로그에서만 읽는다.

등록 모델 조립과 구조화 전송·compact의 결정적 대역 검증이다. 실제 모델/API의 의미 품질, native Windows, PostgreSQL, Knox/사내 서비스, 제품 배포 또는 C04 전체·전체 goal 완료를 뜻하지 않는다. Windows runtime/file binding의 미구현·미연결·미검증과 이전 D2 초기화/MCP 정체 진단의 한계는 최종 증거에도 보존한다.
