# C01 저널 디렉터리 sync 연결 계획

2026-09-07 · 구현 전 계획 · 현재 구현·검증은 [결과 문서](C01-journal-directory-sync-result.md)에서 확인한다.

[root/work 참조 연결](/Users/seunghanee/Documents/secumon/design/chapters/C01-journal-directory-boundary-plan.md)에 이어, `FileJournalStateRepository.#sync`를 이미 선택한 호스트 파일 경계로 연결한다. **기존 디렉터리 fsync의 호출 순서·시도 계측·오류·게시 후 결과 미확정 의미를 유지**한다. 부모 디렉터리 정체성의 보관과 재확인은 새 보강이며 추가 I/O로 기록한다.

## 최소 수정과 호출 지점

| 위치 | 다음 변경 |
|---|---|
| `host-metadata-files.ts` | 작은 `MetadataSyncObserver { beforeSync(): void }` 타입과 `syncDirectory(directory, observer?)`의 선택 인자 추가. 기존 인자 하나짜리 호출은 그대로 사용 가능 |
| `posix-metadata-files.ts`의 `syncDirectory` | 디렉터리 검사 → open → 열린 객체 검사 → **observer.beforeSync()** → 실제 fsync → 경로 재확인 순서. 기존 finally close 유지 |
| `file-journal-state.ts` 생성자 | 기존 `#files`를 사용해 정규화한 부모 디렉터리를 `sync` 용도 참조로 **저널 root 생성 전** 확보하고 `#parentDirectory`에 보관 |
| `FileJournalStateRepository.#sync` | 인자를 문자열에서 `MetadataDirectory`로 변경. `#files.syncDirectory(ref, { beforeSync: … })`를 호출하고 callback에서 기존 `#metrics.directorySyncs` 증가 |
| 생성자 끝 | 기존 root → parent 순서를 `#sync(#rootDirectory)` → `#sync(#parentDirectory)`로 유지 |
| `#fence(folder?)` | 기존 root/선택 work 검사를 유지한 뒤, 폴더가 있으면 기존 work 참조로 sync → root 참조 sync → parent 참조 sync → 기존 마지막 `#check` 유지 |

부모는 `realpathSync(parts.parent)`로 정한 동일 경로를 사용한다. 부모가 private라는 요구를 추가하지 않는다. `sync` 참조는 읽기 권한으로 사용하지 않으며, 부모 참조를 매 sync마다 새로 발급해 교체된 부모를 수용하지 않는다. 기존 부모 부재 선검사의 `journal_parent_missing`은 유지하고, 그 뒤 참조 취득 시 사라진 경우는 ENOENT 형태의 합성 cause와 `journal_directory_unavailable`로 구분한다. 이미 얻을 수 있는 실제 오류는 원 cause를 보존한다.

`#fence`의 work 참조는 기존 업무 해시 키로 `#workDirectories`에서 가져온다. 반드시 존재해야 하는 참조가 없으면 내부 연결 오류로 실패하며, 새 참조를 만들어 조용히 복구하지 않는다. `#sync` 안에서 문자열 경로를 다시 받아 디렉터리 정책을 선택하지 않는다. 다만 POSIX 어댑터 자체는 여전히 저장한 경로를 재확인하고 여는 방식이다. **이 연결은 열린 디렉터리 핸들에 고정된 접근을 구현하는 것이 아니다.**

## observer와 계측

`beforeSync()`는 호스트가 제공하는 동기 관측 알림 하나다. 승인·재시도·업무 실행 callback으로 확대하지 않는다. 저널 callback은 카운터 증가만 수행하고 예외나 비동기 작업을 만들지 않는다. 전역 diagnostics의 전후 차분으로 개별 저널의 카운터를 계산하지 않는다.

| 결과 | 알림 및 기존 `directorySyncs` |
|---|---|
| 참조/경로 검사 실패 | 없음, 증가 없음 |
| 디렉터리 open 실패 | 없음, 증가 없음 |
| 열린 디렉터리 정체성 검사 실패 | 없음, 증가 없음 |
| fsync 호출 성공 | 1회, 1 증가 |
| fsync 호출에서 EIO 등 발생 | 1회, 1 증가 |
| fsync 후 경로 재확인 실패 | 이미 1회/1 증가. 동기화 시도가 없었던 것으로 되돌리지 않음 |

공통 경계의 자체 `directorySyncs`도 실제 fsync 시도를 센다. 부모 참조 취득과 공통 함수의 추가 디렉터리/객체 검사는 별도 `diagnostics()`에 드러낸다. 기존 저널 `metadataChecks`를 모든 실제 OS 호출 수로 확대 해석하지 않는다. 동일 작업의 fsync 순서와 횟수는 유지하되, 총 메타데이터 I/O가 이전과 같다고 주장하지 않는다.

## 오류와 게시 의미

- 일반 OS I/O 실패는 `FileBoundaryFault.cause`의 원 오류를 전달한다. 특히 fsync/open/close에서 발생한 EIO를 `journal_directory_unsafe`로 바꾸지 않는다. 실제 ENOENT가 전달된 경우도 원 cause를 유지한다.
- 공통 경계가 새로 발견한 `unsafe`/`changed`는 각각 `journal_directory_unsafe`/`journal_directory_changed`로 전달한다. 미지원은 `journal_platform_unsupported`; 발급되지 않은 참조는 내부 경계 오류를 보존한다.
- 부모가 교체되거나 열린 디렉터리가 검사 당시 객체와 달라지면 sync를 거절한다. 이는 이전 문자열 sync보다 강화된 동작이다. 필요한 후속 검사에서 실패해도 이미 게시한 파일을 지워 되돌리지 않는다.
- `#candidate`와 일반 레코드의 **파일 fsync**는 이 단위에서 변경하지 않는다. `linkSync`, 후보 정리, 기록 포맷/해시/owner, 영수증·중복 방지, 캐시를 유지한다.
- `commit`의 `published` 플래그와 catch 경계를 유지한다. 게시 전 실패는 기존 실패, 게시 후 sync 또는 새 참조 검사 실패는 `journal_commit_unknown`이며 원 실패를 cause로 보존한다. `directory_synced` callback과 committed 반환을 앞당기지 않는다.
- 생성자의 헤더 게시 이후 sync 실패도 기존 초기화 재개 규칙을 따른다. 유효한 헤더를 삭제하거나 새 storeId를 발급하여 복구하지 않는다.

## 구현·검증 순서

1. root/work 참조 연결의 관련 검증을 먼저 마친다. 다음 sync 변경과 실패 원인을 섞지 않는다.
2. 선택 observer와 POSIX 호출 지점을 추가한 뒤, 저널의 부모 참조·`#sync`·생성자·`#fence`만 연결한다. 기존 프로필 등 observer 없는 호출은 호환성을 유지한다.
3. 격리 시험으로 검사 실패/open 실패/fsync 실패/성공/후속 재확인 실패의 알림 횟수·원 cause·descriptor close를 확인한다. 부모 0755 등 기존 허용 권한, 교체된 parent/root/work 거절도 확인한다.
4. 저널 시험에서 생성자와 fence의 root/work/parent 순서, 게시 전·후 EIO와 `journal_commit_unknown`, receipt 재조회 및 동일 명령 재시도, 실제 게시 단계 SIGKILL 후 재개, 기존 `directorySyncs` 의미를 확인한다. fsync와 무관한 file open 횟수를 알림 횟수로 시험하지 않는다.
5. 두 작은 변경이 확정된 소스에 Node 24 빌드·타입·계층 및 필수 통합 전체 검증을 **한 번** 조정한다. 각 단위의 관련 검증은 별도로 기록하며, 이전 소스의 전체 통과를 새 통과로 재사용하지 않는다. Linux/NAS와 개발 호스트 결과는 소스 digest로 구분한다.

새 포트·서비스·게시 프레임워크는 필요하지 않다. 위 세 제품 파일과 관련 시험의 작은 변경으로 구현 가능한 범위다. Windows native flush, 모든 중간 경로 교체 방지, 전원 차단 내구성은 이 단위의 완료 조건에 포함하지 않으며 별도 구현·실제 검증 대상으로 남긴다.
