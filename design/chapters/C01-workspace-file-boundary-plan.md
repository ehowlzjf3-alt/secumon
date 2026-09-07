# C01 파일 작업공간의 공통 디렉터리·잠금·동기화 연결

2026-09-07 · 연결 전 수립한 계획 · 이후 구현과 NAS 검증 완료는 [결과 문서](C01-workspace-directory-lock-sync-result.md) 참고

**다음 단위는 `FileWorkspaceStore`의 디렉터리 정체성, 잠금 수명, 디렉터리 sync를 함께 연결한다.** 같은 작업의 진입부터 반환까지 어느 디렉터리를 사용했는지 보장하는 한 단위다. 현재 `HostMetadataFiles`로 구현 가능하며 새 application 포트나 저장 형식은 필요하지 않다. 읽기 검증·중복 읽기 제거와 파일 게시/복구 계약은 아래 후속 범위로 구분한다.

기존 [공통 경계 추출 계획](C01-file-boundary-extraction-plan.md)의 작업공간 후속 항목을 구체화한다. [C01-workspace-plan.md](C01-workspace-plan.md)는 담당 디렉터리 등록 계획이므로 이 파일 작업공간 연결 계획을 대체하지 않는다. 앞선 NAS 검증은 [저널 결과 문서](C01-journal-directory-sync-result.md)에 있으며 이 계획의 구현·검증 완료를 뜻하지 않는다.

## 현재 코드의 보장과 경계

[`file-workspaces.ts`](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-workspaces.ts:19)는 `root / sha256(workId) / sha256(attemptId) / files / sha256(path).json`으로 분리한다. 논리 파일 경로는 JSON 안의 값이며 실제 하위 OS 경로로 해석하지 않는다. root·work·attempt·files는 현재 UID와 private 권한을 검사한다. 부모는 정규화와 sync에 사용하고 private를 요구하지 않는다.

- `#locked`는 attempt 안의 `.lock` 디렉터리를 원자적으로 생성한다. 이미 있으면 `workspace_busy`이며 남은 잠금을 자동으로 훔치지 않는다. 해제 때 생성 당시 dev/ino와 같은 잠금인지 비교한다.
- `stage`는 같은 경로·내용·속성의 재요청을 허용하고 다른 내용은 덮어쓰지 않는다. 후보 파일 쓰기·파일 fsync → hard link 게시 → 후보 삭제 → 디렉터리 sync 순서다. `#list`는 `.pending`을 `workspace_incomplete_write`로 거절한다.
- **이 저장소에 영속 잠금 소유 영수증, lease, 자동 stale-lock 복구, 저널식 command receipt는 없다.** 체크포인트 ID와 영수증은 [`WorkspaceCheckpoints.checkpoint`](/Users/seunghanee/Documents/secumon/runtime/src/application/workspace-checkpoints.ts:77)의 상태 commit에 속한다. 파일 게시, artifact 저장, 체크포인트 확정을 같은 성공으로 취급하지 않는다.
- 프로세스가 죽어 `.lock`이나 `.pending`을 남긴 경우 현재 경계는 보존·거절이다. 이미 저장한 체크포인트로 복원하는 상위 흐름과 잠금 회복은 다른 기능이다. `removeAttempt`의 여러 unlink도 하나의 원자 트랜잭션이 아니다.

## 다음 한 단위의 실제 연결 지점

| 호출 위치 | 재사용·수정 | 유지할 실패 의미 |
|---|---|---|
| 생성자, `#identities` | `#files = hostMetadataFiles()` 선택 후 부모 `sync` 참조를 root 생성 전에 확보. root/work/attempt/files 정체성 맵을 `MetadataDirectory` 맵으로 대체 | 미지원 플랫폼은 파일 생성 전 `workspace_platform_unsupported`. 부모 0755 등 기존 허용 유지. 정규화·현재 root 경로 규칙 유지 |
| `#directory` → `#scope`, `#locked` | mkdir와 검사 책임은 유지하되 공통 `inspectDirectory(path, 'private', expected)` 사용. 이미 관측한 디렉터리는 사라져도 다시 mkdir하지 않음 | 처음 보는 work/attempt/files의 생성은 허용. 관측한 위치의 소실·교체는 실패하며 새 참조로 인수하지 않음. 기존 `read/list`가 미생성 scope를 준비하는 동작은 바꾸지 않음 |
| `#locked`의 `.lock` 획득·해제 | 원자 mkdir/EEXIST 처리는 그대로 두고, 성공한 잠금만 private 참조로 확보. 이 참조는 **이번 호출의 지역 변수**로 사용 | 영속 맵에 `.lock`을 넣지 않음: 정상 해제 후 다음 호출의 새 lock은 다른 객체여야 함. stale lock 강제 삭제·재시도·timeout 추가 없음 |
| `#locked`의 완료 fence | root/work/attempt/files를 기존 참조로 재확인한 뒤 `syncDirectory(ref)` 호출 | `files → attempt → work → root → parent` 순서 유지. 필수 참조가 없으면 실패. 부모 참조를 매번 새로 얻어 교체를 수용하지 않음 |
| `#locked`의 finally | 획득했던 lock과 동일한 디렉터리인 경우에만 rmdir하고 **같은 attempt 참조**를 sync | 다른 잠금/교체된 attempt 안의 잠금을 제거하지 않음. 정상 해제 뒤 attempt sync 순서 유지. cleanup 오류를 성공으로 바꾸지 않음 |
| `#sync`, `close` | `#sync`는 문자열 대신 참조만 받음. 현재 작업공간 전용 sync 카운터는 없으므로 새 카운터를 만들 필요 없음. close는 기존 닫힘 검사와 참조 정리를 담당 | 공통 경계의 diagnostics로 추가 검사 비용을 구분. POSIX 참조는 열린 핸들이 아니며 별도 fd 해제 API를 새로 만들지 않음 |

이 연결에서 필요한 좁은 보강도 명시한다. 현재 `#directory(create=true)`는 이미 관측한 폴더가 사라져도 mkdir부터 수행하므로 실패 전에 대체 폴더를 만들 수 있다. 또한 `.lock`이 교체되면 현재 finally는 삭제를 생략한 채 성공을 반환할 수 있고, lock 관찰/해제 실패가 주작업 오류를 덮을 수 있다. 같은 디렉터리·잠금 수명 보장에 포함해 **재생성 없음, 잃어버린 잠금으로 성공 반환 없음, 원래 실패 보존**을 검증한다. 잠금 복구 서비스를 추가하는 변경은 아니다.

오류 매핑은 저장소 안의 작은 helper로 유지한다. 공통 `unsafe/changed/unsupported_platform`은 대응 workspace 오류로 전달한다. 기존에 원 EIO/ENOENT를 던지던 lstat/open/fsync 실패는 cause를 재전달하고 없음으로 처리하지 않는다. 검사 API가 부재를 null로 반환해 원 오류가 없으면 해당 경로·syscall을 가진 ENOENT 형태를 만든다. 주작업과 해제 모두 실패한 경우 주작업 오류를 잃지 않도록 좁은 처리와 시험을 함께 정하며, 현재 `WorkspaceError(code)`만으로 cause 보존이 되는 것으로 가정하지 않는다.

## 읽기·게시에서 재사용할 것과 보류할 것

| 현재 지점 | 검토 결과와 후속 묶음 |
|---|---|
| `#read` 67행, `#list` 87행 | 공통 안정 읽기와 JSON/체크섬/정규 base64/파일 ID 검증을 함께 묶는 후속 단위. 현재 list는 경로를 얻으려고 한 번 읽고 `#read`에서 다시 읽는다. 한 번의 안정 읽기에서 레코드 전체를 검증하고 파일명 hash까지 확인하면 중복 읽기를 줄일 수 있다. 실제 계측으로 확인하며 이번 디렉터리 연결의 성능 향상으로 주장하지 않음 |
| 공통 읽기 한도·링크 정책 | `ceil(maxFileBytes × 4 / 3) + 65536` 직렬화 한도와 원문 한도를 모두 유지. 현재 구현은 nlink를 제한하지 않지만 공통 기본은 1-link이므로 단순 치환은 정책 변경이다. workspace의 `.pending` 발견 거절을 유지하며 프로필/저널의 2-link 허용 정책을 그대로 가져오지 않음 |
| 읽기 오류 | 현재 read의 open ENOENT는 `workspace_file_unavailable`, list의 open 실패는 `workspace_file_unsafe`. list의 초기 oversized 판정도 read와 다르다. 후속 읽기 연결에서 호환·명시 변경을 정하고 `changed`를 무조건 없음으로 축소하지 않음 |
| `stage` 120~125행 | 현재 `O_EXCL` 후보, 파일 fsync, no-overwrite hard link와 후보 정리를 재사용. 현 `HostMetadataFiles`에는 생성·게시·삭제·잠금 연산이 없으므로 이를 연결했다고 표시하지 않음. 공통 게시 API는 게시 여부/정리 실패/재호출 판정까지 같이 검토하는 별도 보장 단위 |
| `removeAttempt` | 잠금 안의 정확한 manifest 비교 후 삭제를 유지. 부분 삭제 실패를 원자 성공/롤백이라고 부르지 않음. 체크포인트·원본을 재작성하여 실패를 숨기지 않음 |
| 상위 checkpoint/restore/cleanup | 기존 업무/시도/tenant/labels/lifecycle 검사, 체크포인트 ID와 상태 commit, 활성·unknown 시도 정리 차단을 그대로 사용. async artifact 어댑터, SQLite, 도구/추론 코어 변경은 제외 |

## 구현과 검증 순서

1. 현재 NAS 검증 대상 소스와 결과를 먼저 분리해 보존한 뒤 다음 제품 변경을 시작한다. `file-workspaces.ts`와 필요한 전용 시험/격리 worker만 한 단위로 변경한다. 공통 계약을 확장할 필요가 생기면 실제 필요를 먼저 확인한다.
2. root/work/attempt/files 참조, 부모 sync 참조, 호출별 lock 참조와 전체 fence/해제를 함께 연결한다. 기존 형식·해시·동일 stage 재호출·manifest 삭제·상위 체크포인트는 그대로 둔다.
3. 기존 workspace/담당 저장소 회귀에 아래 검증을 묶는다.

| 보장 | 의미 있는 검증 |
|---|---|
| 업무 분리·권한 | 같은 논리 path를 여러 work/attempt에 사용해 재개 후 분리, private root/하위와 일반 부모 구분, 링크/권한 변경 거절 |
| 참조 연속성 | root/work/attempt/files 및 부모 교체·소실, 생성 직후 소실, 빈 files 목록 도중 교체, 관측한 폴더 자동 재생성 없음 |
| 잠금 수명 | 두 프로세스 경합, 정상 연속 호출의 새 lock 허용, 남은 lock 거절, 획득 직후 교체/삭제 때 외부 lock 보존, 실패 시 획득한 lock만 해제 |
| sync·실패 | 생성자 root→parent, 완료 files→attempt→work→root→parent, 해제 후 attempt 순서. open/fsync EIO, 주작업+cleanup 동시 실패, 게시된 파일을 sync 실패 때문에 삭제하지 않음 |
| 중단·체크포인트 | 실제 SIGKILL로 lock 획득 후·후보 파일 동기화 후·게시 후 경계를 한정 검증. 남은 파일·잠금 보존과 재호출 거절을 자동 복구로 오표시하지 않음. 정상 checkpoint 저장/재열기/restore 및 안전 cleanup 회귀 재사용 |

4. 관련 시험이 끝난 최종 소스에서 빌드·타입·계층·필수 통합 검증을 조정한다. macOS 개발 결과와 실제 Linux 결과를 구분하고, Windows native ACL/핸들/flush와 전원 차단 내구성은 이번 단위의 완료 조건에 포함하지 않는다.

## 구현 중 확정한 좁은 결정

2026-09-07: 단일 주작업 또는 해제 실패는 원오류 객체를 전달한다. 둘 다 실패한 경우만 `WorkspaceError(primary.code, { cause: primary, cleanupError })`로 감싸 기존 오류 코드를 유지한다. 코드가 없는 원오류에는 `workspace_operation_failed`를 사용한다. 주작업의 존재는 값의 참/거짓으로 판단하지 않는다. 이 선택 때문에 application의 기존 WorkspaceError 생성자에 선택 오류 정보만 추가하며, 저장 포트/파일 형식은 바꾸지 않는다.

성공 fence는 sync가 모두 끝난 뒤 하위 폴더와 lock을 다시 확인한다. 해제 뒤 새 주체가 만든 lock은 별개의 호출 소유이므로 재검사·삭제·재획득하지 않는다. 이 시점 attempt sync가 실패하면 성공을 반환하지 않지만 이미 게시한 파일과 새 lock은 보존한다.

POSIX mkdir는 생성 객체 식별자를 반환하지 않는다. 따라서 mkdir와 첫 lock 관찰 사이 교체, 검사와 경로 기반 rmdir 사이 교체를 원자적으로 방지했다고 주장하지 않는다. 최초 관찰 실패 시 무작정 잠금을 지우지 않는다. native 핸들 기반 실행/파일 보장은 별도 후속이다.
