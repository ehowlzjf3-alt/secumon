# C01 저널 디렉터리 참조 연결 계획

2026-09-07 · 구현 전 계획 · 현재 구현·검증은 [결과 문서](C01-journal-directory-sync-result.md)에서 확인한다.

앞선 [공통 파일 경계 추출](C01-file-boundary-extraction-result.md)의 후속으로, **열린 저널이 기억하는 root/work 디렉터리 식별을 기존 공통 참조로 연결**한다. root는 저널 전체 폴더, work는 업무별 기록 폴더다. 참조는 검사한 실제 디렉터리를 다시 확인하기 위한 값이며, 현재 POSIX 구현에서는 열린 OS 핸들을 보유하지 않는다.

## 권고하는 최소 범위

첫 구현은 `file-journal-state.ts`의 `#directory`와 root/work 식별 필드만 연결한다. **`#sync` 연결은 아래 계측·오류 보존 조건을 먼저 해결한 다음 단위로 분리**한다. 이 범위만으로 application 계약이나 파일 형식을 바꾸지 않고 숫자형 POSIX dev/ino 비교를 공통 호스트 경계로 옮길 수 있다.

| 구분 | 현재 코드와 다음 행동 |
|---|---|
| 재사용 | `hostMetadataFiles()`의 호스트 선택, `inspectDirectory(path, 'private', expected)`와 `MetadataDirectory`, `storageRootParts`, 현재 생성·초기화 순서 |
| 수정 | 숫자형 `Identity` 대신 `#rootDirectory: MetadataDirectory`, `#workDirectories: Map<string, MetadataDirectory>`를 보관한다. 한 저장소 안에서는 같은 호스트 어댑터가 발급한 참조를 계속 사용한다. |
| 수정 | `#directory`가 공통 검사를 호출하고 기존 `JournalStateError`로 변환한다. 참조를 갱신할 때도 이전 참조를 `expected`로 전달하여 교체된 폴더를 새로 수용하지 않는다. |
| 기존 호출 연결 | 생성자, `#check`, `#workDirectory`, `#fence`, 게시 직전 검사, `#directories`가 같은 참조 맵을 사용한다. 업무 폴더를 반환하는 기존 문자열 API는 유지한다. |
| 새 구현 | 기존 파일 안의 작은 오류 변환 외에 새 포트·서비스·전역 레지스트리를 만들지 않는다. 필요한 연결 회귀 시험만 추가한다. |
| 제외 | 생성·게시·일반 레코드 읽기·SQLite·workspace/artifact·Windows native 구현 |

`#workDirectory`의 사전 존재 확인은 첫 단위에서 유지한다. 아직 관측하지 않은 업무 폴더가 없으면 정상적으로 `null`을 반환하고, 관측했던 폴더가 없어지면 `journal_directory_unavailable`이어야 한다. 이 검사까지 합쳐 실제 I/O를 줄이는 변경은 미관측/관측 상태와 계측 차이를 따로 검증한 뒤 결정한다. 따라서 이번 연결만으로 저널의 모든 OS 호출이 추출됐다고 표시하지 않는다.

구현 검토에서 현재 `create=true`가 관측했던 폴더에도 먼저 mkdir를 수행하는 것을 확인했다. 삭제된 폴더를 다시 만든 뒤 정체성 불일치로 거절할 수 있으므로, 이번 단위에서는 이미 관측한 폴더를 다시 만들지 않고 기존 존재 검사에서 거절한다. 첫 관측 전 생성 순서는 유지한다. 이는 단순 타입 교체와 별도로 기록할 동작 보강이며, 원본 보존 회귀로 검증한다.

같은 경계의 추가 보강: 최초 업무 폴더 생성 직후 삭제된 경우에는 nullable 조회 결과 대신 `journal_directory_unavailable`로 거절한다. 또한 목록에서 관측한 빈 업무 폴더를 읽을 때 정상 레코드가 없으면 그대로 null을 반환하던 경로에 기존 참조 재확인 1회를 추가한다. 빈 폴더를 읽는 도중 교체되는 경우도 해당 조회에서 감지하기 위한 추가 검사다. raw readdir 오류까지 모두 새 오류로 통일하는 변경은 하지 않는다.

공통 검사의 `null` 결과에는 원래 ENOENT 객체가 남아 있지 않다. 이 경로에서는 code·syscall·path를 담은 합성 cause를 사용하고 원래 errno/stack까지 보존했다고 주장하지 않는다. 기존 사전 lstat에서 받은 ENOENT와 공통 경계의 EIO cause는 실제 원 객체를 보존한다. 원 오류를 다시 얻기 위한 추가 lstat는 하지 않는다.

## 보존해야 할 오류와 계측

| 관찰 | 유지할 결과 |
|---|---|
| root/work 없음 또는 조회 I/O 실패 | `journal_directory_unavailable`, 가능하면 원래 오류를 cause로 유지 |
| 링크·일반 파일·공개 권한·다른 UID | `journal_directory_unsafe` |
| 유효한 다른 디렉터리로 교체됨 | `journal_directory_changed` |
| 호스트 어댑터 미지원 | `journal_platform_unsupported` |
| 어댑터에서 발급하지 않은 참조 | 내부 연결 오류를 실패로 전달하고 검사 생략이나 새 참조 발급으로 회복하지 않음 |

기존 `metadataChecks`는 기존 `#directory` 호출당 증가 위치를 유지한다. 공통 `diagnostics()`가 세는 실제 경계 I/O와 소비자의 호환 계측은 별개다. 추가 검사 횟수나 Windows 지원 수준을 기존 카운터 이름으로 추정하지 않는다. `metrics().observedDirectories`는 여전히 관측한 업무 폴더 수다.

## `#sync`를 별도 연결하는 이유와 조건

현재 `#sync`는 디렉터리를 열고, **fsync를 시도하기 직전** `directorySyncs`를 증가시킨다. 열기 실패는 집계하지 않고 fsync 실패는 집계한다. 공통 `syncDirectory`는 열기 전후 디렉터리도 검사하지만 fsync 시도 관측 hook은 없다. 호출 직전 카운터를 증가시키면 검사·열기 실패도 fsync처럼 집계되어 기존 의미가 바뀐다.

다음 sync 연결 때는 다음 조건을 먼저 정한다.

1. 실제 fsync 시도 시점을 알려주는 작은 관측 방식이 필요한지 결정한다. 전역 `diagnostics()` 차분을 저장소 동작이나 계측의 근거로 삼지 않는다. 그 계약이 마련되기 전에는 기존 `#sync`를 유지한다.
2. root/work sync는 보관한 참조를 사용한다. parent는 private 폴더라고 가정하지 않으며 sync 용도 참조를 사용한다. parent 참조의 최초 취득·재검사 시점을 정하고, 디렉터리 교체 거절을 새로 강화하는 부분은 변경으로 기록한다.
3. 기존 일반 EIO는 원래 cause를 보존해 전달한다. 새 디렉터리 검사 실패는 위 저널 오류로 변환한다. 실패를 성공·파일 없음으로 바꾸지 않는다.
4. 생성자와 `#fence`의 root/work/parent 동기화 순서 및 호출 횟수를 유지한다. 게시 후 sync 실패는 기존 `commit`의 처리에 따라 결과 미확정으로 남는다.

## 이번 단위에서 그대로 두는 책임

- **게시:** `#candidate`의 exclusive 생성·쓰기·파일 fsync, `linkSync`의 덮어쓰기 없는 게시, EEXIST 충돌 판정, pending 정리는 기존 위치에 남긴다. 디렉터리 참조만 생겼다고 이 게시가 참조 기준으로 실행되는 것은 아니다.
- **레코드:** `#readFile`의 일반 기록 읽기, `RecordIdentity`, 길이·메타데이터 재검사, 해시·순서·영수증·캐시·재생 로직은 유지한다. 이미 연결한 헤더 읽기와 섞지 않는다.
- **결과 미확정:** `published` 플래그, `journal_commit_unknown`, `candidate_synced`/`published`/`directory_synced` 단계와 후속 조회·중복 방지 의미는 유지한다. sync 작업을 이동하더라도 커밋 완료 조건을 앞당기지 않는다.
- **저장 형식·소유:** v1/v2 헤더, agentId/storeId, 업무 폴더 이름, 레코드 bytes, owner 검증은 바꾸지 않는다.

## 구현 후 필요한 증거

1. 변경 소스를 확정한 뒤 Node 24 빌드·타입·계층 검사를 실행한다. 앞서 완료한 추출 검증 결과를 다음 변경의 통과 근거로 재사용하지 않는다.
2. `journal-fault.test.ts`의 root/work 링크·권한·교체·sync 실패와 실제 게시 단계 중단 시험을 유지한다. 관측한 폴더의 삭제, 목록 조회 이후 교체도 기존 맵을 사용하는지 추가로 확인한다.
3. `journal-owner.test.ts`, `state-conformance.test.ts`, `state-query.test.ts`, `agent-backend-binding.test.ts`에서 소유·재개·상태·조회 연결을 확인한다. 기존 케이스를 삭제하거나 허용 오류를 넓혀 맞추지 않는다.
4. sync까지 연결할 때는 검사 실패/열기 실패/fsync 실패/성공의 카운터와 원래 cause, 게시 후 실패의 `journal_commit_unknown`을 별도로 검증한다. 필요한 전체 회귀는 부모 작업에서 한 번 조정한다.

완료 판정은 **저널 root/work 식별이 공통 경계를 사용하며 기존 외부 동작이 보존됨**까지다. 현재 경계는 경로 재확인 방식이다. native Windows 지원, 핸들에 고정된 접근, 모든 중간 경로 교체 방지, 다른 OS 계정 접근 거절, 전원 차단 내구성은 각각 별도 구현·실제 검증이 필요하다.
