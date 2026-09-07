# C01 공통 파일 경계 — 첫 추출 단위

2026-09-07 · 구현 전 작성한 계획 · 현재 구현·검증은 [결과 문서](C01-file-boundary-extraction-result.md)에서 확인한다.

첫 단위는 **프로필 메타데이터와 저널 헤더가 사용하는 디렉터리 검사·안정적인 제한 읽기·디렉터리 동기화의 POSIX 구현을 호스트 내부 경계로 추출**하는 것이다. 파일 형식, 담당 소유 판단, 초기화 순서, 기록 게시와 복구 알고리즘은 기존 위치에 남긴다. Windows 어댑터를 구현하기 전에 동일한 POSIX 동작을 유지하며 호출 지점부터 모으는 단계다.

이 문서는 [기존 Windows 파일 경계 계획](/Users/seunghanee/Documents/secumon/design/chapters/C01-windows-file-boundary-plan.md)의 후속 구현 연결이다. 원점부터의 설계 변경이나 Windows 지원 완료 기록이 아니다. 현재 진행 중인 Linux/NAS 전체 시험의 결과를 예측하거나 통과로 기록하지 않는다.

## 완료된 기반과 이번에 바꾸지 않을 것

- `local-file-paths.ts`의 `storageRootParts`와 `isJournalRecordPath`를 재사용한다. 루트 바로 아래 경로의 basename 처리와 저널 계측 구분은 다시 구현하지 않는다.
- `journal-ownership.ts`의 v1/v2 헤더, expected owner 복사·동결, `inspectJournalOwnership`, owner/형식 재검사는 유지한다. 공통 경계가 agentId를 판정하거나 소유 정보를 새로 발급하지 않는다.
- `agent-state-profile.ts`의 상태 backend 선택 고정, `agent-database-owner.ts`의 SQLite 담당 소유 확인, `openAgentStores`의 조합 순서는 이 단위에서 변경하지 않는다.
- `AgentProfileStore`, `StateRepository`, `WorkspaceStore`, `ArtifactStore` 등 application 계약과 저장된 JSON/DB 형식은 변경하지 않는다. 추론 코어·도구 입력·모델 프롬프트에 OS 개념을 추가하지 않는다.

## 첫 변경 범위

다음 이름은 **제안하는 신규 파일명**이며 현재 구현됐다는 뜻이 아니다. 계약과 구현 모두 `infrastructure` 안에 둔다. application 계층에 OS 파일 포트를 추가할 이유는 아직 없다.

| 파일 | 첫 단위에서 할 일 | 남겨 둘 책임 |
|---|---|---|
| 신규 `infrastructure/host-metadata-files.ts` | 디렉터리 식별, 제한 읽기, 동기화, 결과/오류의 작은 계약 정의 | JSON/Zod, agentId, 저널 revision, 업무 ID를 알지 않음 |
| 신규 `infrastructure/posix-metadata-files.ts` | 기존 Node POSIX 검사와 읽기 전후 동일성 확인을 추출한 구현 | Windows에서 POSIX 검사를 대신 적용하지 않음 |
| 기존 `infrastructure/agent-profile-files.ts` | `profileDirectory`의 검사 부분, `readProfileBytes`, `syncProfileDirectory`를 공통 경계에 연결하는 호환 래퍼로 전환 | 기존 exports, 디렉터리 생성 순서, JSON/버전 검사, profile 오류, pending 허용 정책, publish 순서 유지 |
| 기존 `infrastructure/journal-ownership.ts` | `directoryIdentity`, `readJournalMetadata`의 공통 OS 검사/읽기를 경계로 연결 | owner/header schema, 안전한 pending 내용 판정, 512개 한도, 초기화 관찰 재시도와 오류 의미 유지 |
| 신규 경계 전용 시험 | 아래 보존 계약과 어댑터 선택을 직접 검증 | 기존 저장소 시험을 삭제하거나 완화하지 않음 |

`file-agent-profile.ts`는 기존 helper exports를 그대로 사용하므로 첫 단위에서는 수정하지 않는 것을 목표로 한다. `file-journal-state.ts`도 이미 헤더 읽기를 `readJournalMetadata`에 위임하므로 기록 읽기·게시·캐시를 건드리지 않고 새 경계를 간접 사용한다. 래퍼로 해결되지 않는 호출부 변경이 필요하면 구현 전에 범위를 다시 설명한다.

## 먼저 필요한 계약

범용 파일 시스템 전체를 추상화하지 않는다. 아래 세 연산과 작은 값 타입으로 시작한다. 이름과 TypeScript 세부 문법은 구현 때 조정할 수 있지만 책임은 유지한다.

| 계약 | 의미와 제약 |
|---|---|
| `inspectDirectory(path, access, expectedIdentity?)` | 없음 또는 검사된 디렉터리 참조를 반환한다. 기존 참조가 있으면 동일한 디렉터리인지 재확인한다. 새 디렉터리를 생성하는 연산과 분리한다. |
| `readStableRegularFile(directory, leafName, policy)` | 검사된 부모와 단일 파일명으로 일반 파일을 읽는다. 최대 bytes, 파일 접근 정책, 링크 관계 판정, 관측자를 명시하고 읽기 전후의 객체·크기·메타데이터 변화를 확인한다. JSON이나 소유 헤더 의미는 해석하지 않는다. |
| `syncDirectory(directory)` | 디렉터리 저장 동기화를 요청하고 수행/실패/미지원 상태를 구분한다. POSIX 래퍼는 현재처럼 필요한 동기화 실패를 호출 실패로 전달한다. |
| `DirectoryIdentity` / `FileIdentity` | 같은 실제 객체인지 비교하는 호스트 내부 값. 상위 저장소에 POSIX inode나 Windows HANDLE 원형을 노출하지 않는다. 문자열 경로 자체를 파일 정체성으로 사용하지 않는다. |
| `FileBoundaryFault` | 없음·unsafe·changed·too-large·I/O 실패 등 OS 경계 실패. 기존 래퍼가 `AgentProfileError`와 `JournalStateError`로 매핑한다. 일반 실패를 파일 없음으로 바꾸지 않는다. |

여기서 참조는 검사한 디렉터리와 그 정체성을 묶는 내부 객체다. 첫 POSIX 구현은 현재 코드의 경로 재확인 수준을 보존한다. 이를 열린 디렉터리 핸들에 상대적인 접근이나 모든 중간 경로의 교체 방지까지 제공하는 객체라고 부르지 않는다. Windows 구현이 핸들을 보유하면 참조에 명시적인 수명/close를 추가하고, 실제 사용하는 저장소까지 수명 전달을 연결해야 한다.

파일명은 단일 leaf만 받는다. 하위 폴더로 내려가는 것은 디렉터리 참조를 새로 얻는 연산으로 표현한다. 이미 검증된 논리 workspace 경로를 실제 OS 경로로 다시 해석하지 않는다. 호환 래퍼는 기존 `dirname`/`basename`과 완료된 경로 도우미를 사용한다.

디렉터리 접근 정책과 파일 접근 정책은 별개다. 담당의 사용자 편집용 루트/스킬 원본은 다른 사용자의 읽기를 허용할 수 있지만, 그 안의 비공개 메타데이터 파일은 계속 private여야 한다. 이를 하나의 `private=false`로 전체 하위 영역에 전파하지 않는다.

저장 루트의 부모에 대한 sync도 저장 루트의 private 검사와 구분한다. 기존 코드는 부모가 0700이 아니어도 부모 디렉터리 엔트리의 동기화를 수행할 수 있다. 이 경우 동기화 용도의 디렉터리 참조를 사용하고, 그 참조를 비공개 파일 읽기 권한처럼 재사용하지 않는다. 추출 때문에 상위 Documents/tmp 경로까지 새로 private로 요구하지 않는다.

## POSIX 의미를 보존하는 구체적 방법

공통 경계는 기존 판정을 가장 느슨한 하나의 규칙으로 합치지 않는다. 두 래퍼가 차이를 명시적으로 전달한다.

| 보존할 의미 | 구현 연결 |
|---|---|
| private 영역 | 현재 UID와 mode 0700/0600 기준의 접근 검사 유지. 읽기 때 group/other 접근을 허용하지 않음. 기존 파일을 chmod해 조용히 인수하지 않음. |
| 사용자 편집 원본 | 현재 `privateMode=false`의 소유 UID 및 group/other 쓰기 거절 의미 유지. 0644/0755 원본을 일괄 거절하지 않음. |
| 파일 종류/안정성 | no-follow/nonblocking 열기, 일반 파일 검사, 제한된 버퍼 읽기, 열린 객체와 현재 파일명의 동일성·읽기 전후 메타데이터 확인을 유지. 최대 두 번의 안정 읽기 시도를 늘려 무제한 재시도하지 않음. |
| 서로 다른 크기 한도 | 저널 헤더/pending의 4 KiB, 프로필의 호출별 한도, clone setup 기록/스킬의 기존 한도를 호출자가 전달. 저널 한도를 공통 기본값으로 박아 다른 파일을 깨뜨리지 않음. |
| 파일 없음 | 프로필의 null 반환과 저널의 ENOENT 처리/초기화 분기를 호환 래퍼에서 보존. 파싱 실패·권한 거절·크기 초과는 없음이 아님. |
| 중단된 게시의 하드 링크 | 외부 hardlink 거절과 정상 pending↔final 동일 객체 쌍을 구분. 링크 수만 검사하거나 이름만 맞으면 허용하는 형태로 축소하지 않음. |
| 관측/계측 | 기존 headerReads/headerBytes/metadataChecks의 의미를 유지하는 관측 hook을 둔다. 레코드 계측·해시 호출·캐시/재생 알고리즘은 그대로 유지. |
| 디렉터리 동기화 | 기존 실행 지점과 순서를 바꾸지 않는다. 공통 함수 추출을 이유로 fsync를 빼거나 오류를 성공으로 돌리지 않음. |

pending 허용은 저장소 정책이다. 프로필의 `.secumon-init-….pending`과 저널의 정확한 `UUID.pending`을 하나의 느슨한 정규식으로 통일하지 않는다. 저널의 일반/private/UID/같은 inode·정상 2-link 쌍 판정, header 내용과 owner 확인, 후보 512개 한도는 유지한다. 프로필의 기존 허용 범위를 엄격하게 바꾸거나 열거 한도를 새로 도입하는 일은 별도 보강으로 기록하고, 단순 추출에 숨기지 않는다.

공통 읽기 함수는 링크를 검사해야 하는 시점에 **호스트가 등록한 링크 정책**을 호출하고 허용/거절/다시 관찰 필요 결과를 받는다. 정책은 정규화된 파일 정체성·링크 수와 제한된 sibling 조회만 사용하고, 모델/도구 입력으로 검사 생략 callback을 등록할 수 없다. 프로필과 저널의 이름·관계 판정은 각각의 모듈에 남긴다. 이 형태로도 기존 오류와 두 번의 읽기 시도가 보존되지 않으면 첫 추출을 디렉터리 검사·동기화까지로 나누고, 읽기 연결은 다음 작은 변경으로 진행한다.

## 첫 단위에서 같이 추출하지 않는 부분

| 현재 위치 | 다음 연결 단위 | 지금 함께 바꾸지 않는 이유 |
|---|---|---|
| `file-journal-state.ts`의 `#directory`, `#sync`, `#candidate`, commit | 공통 디렉터리 참조를 root/work에 연결한 뒤 no-overwrite 게시 계약 연결 | 헤더와 일반 레코드의 보장/한도가 다르고, commit_unknown·영수증·충돌·sync 경계 의미를 유지해야 함 |
| `file-workspaces.ts`의 `#directory`, `#locked`, `#read/#list`, stage | 디렉터리 정체성 맵부터 연결하고, 다음에 읽기와 게시를 연결 | lock 디렉터리, work/attempt 구분, manifest 비교·삭제 및 pending 발견 시 오류가 독립 계약임 |
| `file-artifacts.ts`의 생성자, `#read`, `#atomic` | 루트 고정/권한 정책을 별도 명시한 다음 async 경계와 replace 게시 연결 | 현재 루트 보장이 더 약하고 async I/O를 사용함. 동기 읽기로 대체하거나 새 권한 거절을 동작 보존이라고 표현하지 않음 |
| `agent-stores.ts` 및 DB owner helper | 호스트 경계를 조합 루트에서 전달하고 SQLite/sidecar 수명을 별도 연결 | SQLite가 경로를 다시 여는 동작을 파일 읽기 helper로 해결할 수 없음 |

아티팩트 게시의 `rename`과 저널/프로필 게시의 `link`는 같은 `atomicWrite()` boolean으로 묶지 않는다. 후속 계약은 덮어쓰기 없는 게시와 기존 파일 교체를 구분하고, 게시 여부와 동기화 결과를 각각 반환해야 한다. 특히 게시 뒤 sync 실패를 “쓰기 전 실패”로 표시하면 재시도가 이미 게시된 작업을 중복 실행할 수 있다. 기존 저널의 `journal_commit_unknown`과 조회/재시도 흐름을 연결 기준으로 삼는다.

SQLite 파일에 일반 메타데이터 읽기 함수를 재사용하지 않는다. [저널 담당 연결 계획의 SQLite 경계](/Users/seunghanee/Documents/secumon/design/chapters/C01-file-journal-binding-plan.md)에 기록된 별도 descriptor close와 잠금 간섭, WAL/SHM 생성, hot journal 복구 요구를 그대로 유지한다. 공통 루트 검사를 도입해도 SQLite 자체 경로 접근과 동시 교체 문제가 자동 해결됐다고 주장하지 않는다.

## Windows에 남길 작은 native 경계

첫 추출에서는 native 코드·설치 스크립트·패키지를 만들지 않는다. 후속 Windows 구현은 TypeScript 저장소와 복구 로직을 유지하고 **한 개의 작은 Rust Node-API 모듈**을 우선 후보로 둔다. C++로 바꿀 근거가 생기면 ABI/배포 부담을 비교하되 이 단계에서 두 구현을 만들지 않는다.

| native 경계 후보 | 책임 | TypeScript에 남는 책임 |
|---|---|---|
| 디렉터리 열기/생성 | 생성 시 보호된 DACL 적용, owner SID/접근권 확인, 실제 볼륨·파일 ID, 핸들 수명 관리 | 담당 경로 선정·engine 겹침 금지·agentId 판단 |
| 참조 기준 파일 열기/검사 | reparse point 및 중간 junction 처리, 파일 종류/ID/링크 관계, 경로 교체와 핸들 공유 조건 검사 | 크기 정책·파일 형식·pending 명명/내용·owner schema |
| 후보 게시/교체 | 열린 후보와 대상 정체성에 맞춘 no-overwrite/replace, 공유 위반과 이미 게시됨의 구분 | 후보 형식·재시도·충돌·영수증·업무 완료 판단 |
| flush/close | 실제 핸들에 대한 flush와 자원 해제, 미지원/실패 및 게시 후 결과 미확정 전달 | 요구하는 내구성 선택, 재조회·복구, 사용자 상태 표시 |

단순히 문자열 경로를 받아 ACL을 검사한 뒤 닫고 Node가 같은 경로를 다시 여는 API는 목표 경계가 아니다. 검사한 객체와 작업한 객체가 이어지는 핸들 수명이 필요하다. 정확한 Win32/필요 시 하위 API와 공유 플래그는 native 구현 시 실제 Windows에서 확인한다. `CreateFileW` 호출 하나나 최종 경로 문자열 확인만으로 중간 경로 교체가 해결됐다고 단정하지 않는다.

TypeScript에는 opaque 참조만 노출하고 임의 HANDLE 수치, 경로 검사를 우회하는 옵션, 범용 native 셸 실행을 제공하지 않는다. 정상 파일 읽기마다 PowerShell/icacls를 호출하지 않는다. native 모듈 로딩 실패나 필요한 ACL/핸들 기능 미지원은 명확한 미지원 오류이며 POSIX mode 검사로 대체해 계속 진행하지 않는다.

Node와 native의 역할을 합쳐도 같은 OS 사용자에게 임의 셸 권한을 준 상황의 완전 격리가 되지는 않는다. SQLite의 경로 재열기/sidecar를 이 핸들 수명과 어떻게 연결할지는 별도 검증 사항이다. 필요성이 확인되기 전에 새 SQLite VFS까지 이번 추출 범위로 키우지 않는다.

## 지원 상태와 검증 기준

어댑터의 능력은 하나의 `secure=true`로 표시하지 않는다. 최소한 접근 제어 방식, 경로/객체 재확인 수준, no-overwrite/replace 지원, 디렉터리 flush 지원 상태를 구분한다. `supported`, `unsupported`, `unverified`를 섞지 않는다. POSIX 디렉터리 fsync 호출 성공도 실제 정전 시험 완료와 같은 뜻이 아니다.

1. **추출 직전 기준 확보:** 부모가 확정한 소스 digest와 기존 시험 결과를 참조한다. 진행 중인 NAS 결과나 다른 소스 버전의 과거 결과를 현재 추출 검증으로 재사용하지 않는다.
2. **첫 작은 구현:** 새 계약/POSIX 구현과 두 호환 래퍼만 변경한다. 생성/게시 순서, owner 함수 및 외부 exports를 유지한다. 어댑터는 호스트에서 선택하며 native Windows에 POSIX 구현을 자동 배정하지 않는다.
3. **공통 경계 시험:** 없음/빈 파일/한도 경계·초과, symlink/특수파일·외부 hardlink, 정상 pending 2-link와 정리 중 변화, UID/mode, 부모·파일 교체, 읽기 중 크기/메타데이터 변화, descriptor 해제, sync 실패의 오류 전파를 검사한다. 권한/동시 변경을 확인할 수 없는 환경은 미검증으로 기록한다.
4. **기존 소비자 회귀:** 프로필 setup/clone/부분 재개, clone 스킬 0644/0755 읽기와 대상 0600/0700, journal owner/v1 호환/후보 한도/동시 초기화/실제 SIGKILL 경계, 일반 저널 기록/충돌/계측을 유지한다. 실제 게시 경계 시험이 helper 이동 뒤에도 같은 경계에 도달하는지 확인한다.
5. **지원 호스트 검증:** 저장소의 Node 24 빌드·타입·계층 검사를 거쳐 대상 시험을 실행한다. 공통 저장 경계 변경에 필요한 전체 회귀는 부모가 한 번 조정한다. Linux/NAS 실행은 대상 소스 digest와 파일 시스템 정보를 별도 기록한다. 이 계획 작성 중에는 어느 시험도 실행하지 않았다.
6. **Windows 판정:** 순수 경로 시뮬레이션과 POSIX 통과는 native Windows 지원 증거가 아니다. Windows native 구현·실제 로컬 NTFS 일반 계정 시험, 다른 계정 접근 거절, DACL/상속/reparse/hardlink·경로 교체, 열린 핸들/공유 위반, 실제 프로세스 중단/재개를 통과한 범위만 지원으로 표시한다. UNC/SMB와 정전 내구성은 별도 증거가 필요하다.

첫 단위의 완료 기준은 두 소비자가 공통 POSIX 경계를 사용하면서 저장된 bytes·소유 판정·오류·복구·계측 의미가 보존되는 것이다. Windows 미검증, artifact 루트 강화, workspace 잠금/게시, SQLite 수명, native 배포 연결은 각각 남은 항목으로 유지한다.
