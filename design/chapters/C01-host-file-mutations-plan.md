# C01 호스트 파일 변경 경계 — 다음 구현 묶음

진행 상태: A의 POSIX 설정·복구 단위를 구현하고 NAS 전체2737개로 검증했다. [설정·복구 결과](/Users/seunghanee/Documents/secumon/design/chapters/C01-setup-mutations-result.md). B는 [Windows 선행 구현](/Users/seunghanee/Documents/secumon/design/chapters/C01-windows-native-progress.md)의 독립 모듈/컴파일 검사까지 진행됐으며 실제 Windows 인수는 남아 있다. 다음은 [C02 지속 세션 계획](/Users/seunghanee/Documents/secumon/design/chapters/C02-persistent-session-plan.md)다. 아래 계획의 미완료 B/C 범위는 유지한다.

2026-09-07 · 다음 구현 제안 · 제품 소스와 시험을 변경하거나 실행하지 않은 정적 검토

**다음 단위는 프로필의 ‘안전한 담당 영역 생성 → 덮어쓰지 않는 설정 게시 → 중단 후 같은 담당으로 재개’를 끝까지 연결한다.** 생성·쓰기·게시·삭제를 각각 별도 챕터로 추출하지 않는다. 기존 설정 기록과 복구 절차를 활용하고, 이 경로에서 실제로 필요한 호스트 파일 변경 경계만 만든다. Windows native 구현은 같은 사용 사례를 별도로 입증하는 작업으로 병행한다.

여기서 게시란 완성된 후보 파일을 정식 이름으로 보이게 하는 것이다. 게시 성공, 프로세스 중단 후 복구, 디스크 저장 동기화, 전원 장애에 대한 보장은 서로 다르다. 아래는 채택을 제안하는 계획이며 현재 Windows 지원이나 실행기 격리가 완성됐다는 기록이 아니다. 진행 중인 NAS 검증의 결과도 이 문서에서 판정하지 않는다.

## 현재 남아 있는 경계

행 번호는 작성 시점 기준이다. `raw fs`는 공통 호스트 경계를 거치지 않고 Node의 파일 함수를 직접 호출하는 부분을 뜻한다. 직접 호출 자체를 결함으로 간주하지 않고, 운영체제 보장과 호출자의 복구 책임이 만나는 지점을 찾았다.

| 현재 코드 근거 | 연결된 것과 남은 것 | 다음 단위에 주는 의미 |
|---|---|---|
| [HostMetadataFiles](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/host-metadata-files.ts:43), [POSIX sync](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/posix-metadata-files.ts:136) | 디렉터리 검사, 안정적인 제한 읽기, 디렉터리 sync. 생성·게시·삭제 계약은 없다. POSIX 참조는 경로와 객체 식별을 재확인하며, 열린 디렉터리 핸들을 계속 보유하지 않는다. | 완료된 읽기/검사/sync를 재사용하고 변경 연산의 객체·결과 수명을 추가한다. `path-recheck`를 `handle-reference`로 이름만 바꾸지 않는다. |
| [프로필 생성·게시 helper](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/agent-profile-files.ts:32) | `mkdir`, 후보 exclusive open/write/file fsync, `link` 게시, 후보 `unlink`가 직접 호출이다. 게시 후 후보 삭제가 실패하면 현재 `finally`의 다음 parent sync까지 도달하지 않는다. 반환 boolean은 정상 시 생성/기존 존재만 구분한다. | private 생성, 후보 소유, 게시 결과, 정리 실패, 부모 저장 동기화를 한 수명에서 다룰 실제 소비자가 있다. 오류·중단 시 행동 보강도 명시한다. |
| [FileAgentProfileStore 초기화](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-agent-profile.ts:90) | `setup-operation.json`을 먼저 게시하고 identity/config, 하위 디렉터리, setup을 만든 뒤 다시 검사한다. [엔진 경로 겹침 금지](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-agent-profile.ts:21)도 이미 있다. | 새 트랜잭션 DB나 새 담당 ID 체계가 필요하지 않다. 이 초기화와 재개 경로를 첫 완성 단위로 삼는다. |
| [openAgentStores](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/agent-stores.ts:15), [SQLite owner 연결](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/agent-database-owner.ts:69) | 조합 함수는 직접 파일을 만들지 않는다. DB helper가 새 파일만 exclusive 생성하고, SQLite가 DB와 WAL/SHM 등의 보조 파일을 직접 연다. 기존 DB의 별도 fd open/close는 잠금 간섭 때문에 금지돼 있다. | 파일 게시 helper를 SQLite에 통째로 적용하면 안 된다. 조합 시 검증된 영역을 전달하는 일과 SQLite의 실제 접근 수명은 구분한다. |
| [workspace 디렉터리·잠금](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-workspaces.ts:54), [stage/remove](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-workspaces.ts:170) | 참조 검사·잠금 소유·sync 순서·안정 read/list 연결이 있다. 생성, 후보 게시, 후보 삭제, 검증한 파일 삭제는 직접 호출이다. | 이미 끝난 read/list/lock/sync를 다시 만들지 않는다. 후속에서는 그 흐름 안의 변경 연산만 연결한다. 잠금 제거와 일반 파일 삭제를 후보 정리로 합치지 않는다. |
| [저널 후보·헤더](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-journal-state.ts:128), [commit](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-journal-state.ts:265) | root/work 참조와 sync는 연결됐다. 후보 생성·게시·정리는 직접 호출이다. 게시 후 실패는 이미 `journal_commit_unknown`이며 receipt/replay로 확인한다. 일반 레코드 읽기는 별도 경로다. | 결과 미확정을 처리하는 기준으로 재사용한다. commit 영수증·hash chain·헤더 owner·캐시를 새 파일 계층으로 옮기지 않는다. |
| [FileArtifactStore](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-artifacts.ts:34) | root는 `resolve`만 하며, async mkdir/open/rename/unlink를 사용한다. body와 metadata를 각각 게시하고 rename은 기존 대상을 교체할 수 있다. | private root 검증과 두 파일의 공개 시점을 함께 보강해야 한다. 동기 no-overwrite helper를 끼워 넣는 것으로 해결됐다고 표시하지 않는다. |

이는 [첫 추출 계획](/Users/seunghanee/Documents/secumon/design/chapters/C01-file-boundary-extraction-plan.md)의 다음 단계다. 완료된 경로 함수, 저널 owner, 디렉터리 참조, sync 관측자, workspace 안정 읽기와 잠금 수명은 유지한다.

## 바로 구현할 한 단위: 담당 설정의 생성과 재개

사용자가 새 디렉터리에서 setup을 실행하고, 중간에 종료됐다가 다시 실행해도 게시된 동일 담당 정보를 기준으로 설정을 마칠 수 있는 것이 결과다. 이미 설정된 다른 담당이나 엔진 설치 영역에는 쓰지 않는다.

다음 네 작업은 한 구현·검증 묶음이다.

1. **호스트가 허용한 변경 영역 확보.** 기존 `#root`의 엔진 겹침·중첩 담당 검사를 재사용한다. 기존 root 또는 root를 새로 만들 부모를 검사하고, 이 호출에서 사용할 변경 범위를 고정한다. 초기화 중 경로가 바뀌면 새 대상을 조용히 채택하지 않는다. 새 root가 생겼다면 그 부모 엔트리의 sync도 누락되지 않도록 연결한다. 0755 부모처럼 읽기가 공개된 상위 디렉터리를 일괄 private로 바꾸지는 않는다.
2. **처음부터 적절한 권한으로 생성.** root는 기존 owner-writable 접근 정책을 유지하고, `.secumon`과 기존 private 하위 영역은 private 정책을 쓴다. 기존 파일이나 디렉터리를 chmod/ACL 재설정으로 자동 인수하지 않는다. `EEXIST`는 동일 정책·객체·기존 프로필 내용을 다시 확인하는 분기다.
3. **후보 생성부터 게시·정리까지 묶기.** 같은 부모 안에 exclusive 후보 생성, 제한된 bytes 쓰기, 후보 파일 sync, no-overwrite 게시, 자기 후보만 정리, 필요한 디렉터리 sync와 마지막 참조 확인을 하나의 변경 연산으로 연결한다. 후보 정리와 sync를 독립적으로 시도해 한 실패가 다른 필요한 단계를 생략시키지 않게 하되, 부모 교체가 확인되면 바뀐 경로를 따라 정리하지 않는다.
4. **기존 설정 기록으로 결과 확인.** `initialize`의 operation → identity/config → 디렉터리 → setup → inspect 순서를 유지한다. 게시 결과가 미확정이면 기존 파일을 안정적으로 읽고 operation/identity/schema를 비교한다. 이미 게시된 operation의 ID를 다시 발급하거나, 결과 확인 전에 같은 설정을 덮어쓰지 않는다. 아직 operation이 한 번도 게시되지 않은 중단까지 영구적인 담당 ID가 있었다고 가정하지 않는다.

프로필 먼저 연결하는 이유는 이 경로에 작은 메타데이터, private 생성, 충돌, 복구 원본, 엔진 경계가 함께 있기 때문이다. 아티팩트의 async 대용량 처리나 SQLite 잠금까지 섞지 않고도 실제 사용자 행동 하나를 완성할 수 있다.

## 최소 코드 변경과 책임

다음 이름은 구현 시 사용할 수 있는 제안이다. 파일 함수마다 별도 어댑터나 서비스 계층을 만들지 않는다.

| 위치 | 다음 묶음의 책임 |
|---|---|
| 신규 `infrastructure/host-file-mutations.ts` | 검사된 영역에서의 디렉터리 생성과 no-overwrite 게시, 결과/정리 정보, 작업 동안의 참조 수명 계약. JSON·agentId·업무 의미는 모른다. |
| 신규 `infrastructure/posix-file-mutations.ts` | 현재 POSIX mode/UID·exclusive 생성·link·unlink·fsync 동작을 연결한다. 공통 metadata 구현과 같은 호스트가 발급한 참조만 받는다. 메타데이터 읽기를 복사하지 않는다. |
| `agent-profile-files.ts` | 기존 호출부가 사용하는 exports와 정상 반환을 가능한 한 유지한다. 새 변경 연산과 기존 profile 오류/파싱 사이의 래퍼가 된다. 범위를 생략한 경로-only 우회가 생기지 않게 호스트 내부 호출에서 참조를 전달한다. |
| `file-agent-profile.ts` | 초기화 한 번의 영역 확보/해제와 게시 후 재관찰을 연결한다. JSON 형식, 저장 기본값, repair 조건은 유지한다. 새 root의 부모 sync·결과 미확정·정리 진단은 이번 보강으로 구분한다. |
| 공용 helper의 직접 소비자 | `agent-clone-files.ts`와 `agent-state-profile.ts`에는 필요한 참조 전달만 연결한다. 후자의 backend 고정 기록 게시도 같은 helper를 사용하므로 호환 확인 대상이다. DB owner helper의 기존 sync 연결을 유지하며 SQLite 파일을 일반 게시 연산으로 전환하지 않는다. |
| 관련 profile/clone/호스트 시험 | 기존 설정·동시 초기화·부분 복구와 새 변경 수명 시험을 함께 실행한다. 공용 helper를 쓰는 clone의 bytes/hash/실행 bit/빈 디렉터리/한도/재개 계약을 회귀 검증한다. |

기존 `MetadataDirectory` 전체에 즉시 `close()`를 추가해 모든 저장소를 재작성하지 않는다. 변경 작업에만 명시적 수명을 갖는 작은 scope를 두고 `try/finally`로 해제한다. scope는 같은 provider의 디렉터리 참조와 허용된 단일 파일명을 받는다. 복사·위조한 참조, 다른 scope의 후보, `..`/절대경로/드라이브·스트림 표기 등 실제 호스트의 탈출 표현은 거절한다. 모델·도구는 scope를 만들거나 권한 검사 callback을 주입할 수 없다.

Windows 구현에서는 이 scope가 필요한 디렉터리·후보 핸들을 보유한다. POSIX 첫 연결은 현재의 경로 재확인 수준을 정확히 표시하며, `openat` 계열에 상대적인 핸들 접근까지 구현했다고 주장하지 않는다. scope의 해제 후 참조 사용은 실패해야 한다. GC에 의한 최종 정리만으로 자원 수명을 맡기지 않는다.

clone의 별도 root `mkdir`와 스킬 복사 helper에도 같은 생성·게시 래퍼가 영향을 준다. POSIX 회귀를 유지하기 위한 연결은 첫 묶음에 포함하지만, clone의 기존 source 검사·manifest·한도를 재설계하지 않는다. native Windows에서 해당 source/대상 검사가 연결되기 전에는 clone을 지원 완료로 표시하지 않는다.

## 게시 상태, 저장 동기화, 정리 결과

새 내부 결과는 적어도 아래 정보를 보존한다. 모든 저장소를 `atomicWrite(): boolean` 하나에 맞추지 않는다.

| 관찰된 상태 | 호출자가 할 일 |
|---|---|
| 후보를 만들기 전 실패 또는 게시를 시도하지 않은 실패 | 원 오류와 단계를 보존한다. 만들어 둔 자기 후보가 있으면 정리 결과도 남긴다. 정식 대상이 없다고 추측해서 다른 기존 파일을 삭제하지 않는다. |
| 대상이 이미 존재 | 이번 호출이 게시하지 않았음을 반환한다. 해당 파일이 같은 설정인지, 동시 초기화의 승자인지, 충돌인지는 `initialize`의 기존 파싱·identity 검사로 판단한다. |
| 이번 후보가 정식 이름에 게시됐고 요구한 barrier까지 성공 | 정상 완료한다. barrier는 저장 동기화 요청의 완료를 뜻하며 하드웨어 전원 장애 시험을 대신하지 않는다. |
| 게시됐으나 뒤의 sync/재확인/필수 정리가 실패 | 게시 사실과 원 cause, 실패 단계를 보존한다. 결과를 단순 ‘미실행’으로 되돌리지 않는다. 호출자는 정식 파일과 operation을 재조회하고, 필요한 sync를 다시 마쳐야 완료를 확정할 수 있다. |
| native 호출의 반환만으로 게시 여부를 확정할 수 없음 | `unknown`으로 남기고 정식 파일의 내용·객체 관계를 조회한다. 실패한 호출을 무조건 다시 실행하지 않는다. |

내부 결과에는 게시 상태, 수행한 파일/이름 저장 barrier, 후보 정리 상태를 구분한다. 부작용 전 오류는 기존 원 cause를 보존하고, 주 오류와 정리 오류가 함께 있으면 둘 다 남긴다. 외부의 기존 충돌·unsafe 의미는 유지하고, 추가되는 결과 미확정 표현은 의도적인 변경으로 문서화한다. 저널의 `journal_commit_unknown`을 참고하되 프로필에 저널 revision/receipt를 도입하지 않는다.

후보 정리는 이 호출이 확보한 부모·후보 이름·객체 식별을 기준으로 한다. UUID 모양의 이름만으로 소유를 인정하지 않는다. 중단 후 남은 후보를 발견했다고 자동 전체 삭제를 하지 않는다. 게시된 operation과 정상 파일을 기준으로 재개하고, 고아 후보의 안전성·개수·bytes 한도와 필요한 명시적 정리 절차를 따로 다룬다. 기존 clone의 정상 후보 허용량을 줄이거나 정상 2-link 게시 상태를 손상으로 바꾸지 않는다.

## Windows에서 실제로 구현할 경계

Node의 Windows `mode`/`chmod`는 POSIX의 owner/group/other 접근 제어를 제공하지 않는다. 현재 0600/0700 검사를 그대로 실행하는 것만으로 private 보장은 성립하지 않는다. [Node 24 파일 시스템 문서](https://nodejs.org/docs/latest-v24.x/api/fs.html#fschmodpath-mode-callback).

**TypeScript 저장소와 복구 로직을 유지하고, OS 핸들·ACL 연산만 Rust Node-API 모듈로 구현하는 것을 우선안으로 한다.** Node-API는 C ABI를 통해 다른 언어의 addon을 연결할 수 있다. ABI 안정성이 OS API, 외부 라이브러리, 모든 플랫폼의 바이너리까지 자동으로 보장한다는 뜻은 아니다. 대상 Node 버전과 Node-API 버전을 고정하고 플랫폼별 배포물을 검증한다. [Node-API 공식 문서](https://nodejs.org/api/n-api.html#writing-addons-in-various-programming-languages).

| native 책임 | 구현에서 확인할 사항 |
|---|---|
| 영역 생성·열기 | 생성 시점에 보호된 DACL을 적용하고 handle로 owner SID·허용 ACL·볼륨/파일 ID를 확인한다. DACL은 어떤 OS 계정에 접근을 허용할지 정하는 규칙이다. 기존 대상을 재설정하지 않고 검사한다. 보안 기능이 없는 볼륨은 거절한다. |
| 경로에서 객체로 연결 | root와 필요한 부모/후보의 handle 수명을 유지한다. final reparse point뿐 아니라 중간 junction과 경로 교체를 검사한다. no-delete 공유 조건 또는 실제 상대 handle 연산 등 선정한 방식이 조상 교체를 막는지 Windows에서 증명한다. 단순한 ‘경로 검사 → close → Node로 다시 open’으로 끝내지 않는다. |
| 후보 게시·자기 후보 정리 | 같은 볼륨의 후보를 대상으로 기존 이름을 덮어쓰지 않는 native 게시를 구현한다. handle 기준 link/rename·삭제 API의 실제 사용 가능성과 공유 플래그를 좁은 Windows 실험으로 정한다. 경로-only `MoveFileExW`를 호출했다는 이유만으로 핸들 상대 게시나 원자적 범위 고정을 주장하지 않는다. |
| 읽기·재확인·해제 | 초기화 후 inspect/read에도 같은 ACL·객체 검사를 연결한다. 생성만 native이고 확인은 POSIX UID 검사를 통과시키는 혼합을 피한다. 오류 경로·callback 예외·명시적 종료 모두에서 handle이 해제돼야 한다. |

`CreateFileW`는 생성 시 security descriptor와 핸들 공유 조건을 받으며, `FILE_FLAG_OPEN_REPARSE_POINT`는 열린 대상의 reparse 동작을 제어한다. 이 플래그 하나가 모든 중간 경로를 안전하게 고정한다고 해석하지 않는다. native API 선정은 이 제한을 전제로 한다. [CreateFileW 공식 문서](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).

Windows native 첫 입증 대상은 일반 사용자·로컬 NTFS의 setup/inspect다. 프로필 데이터만 사용하는 독립 호출로 생성→재호출→충돌→중단 재개를 시험한다. SQLite, workspace, artifact까지 열어야만 이 실험을 할 수 있게 결합하지 않는다. 현재 `hostMetadataFiles()`의 Windows 거절을 모듈 import 성공만으로 해제하지 않으며, 아직 연결되지 않은 공개 진입점은 변경 전에 계속 명시적으로 거절한다. native helper 구현, 실제 Windows 검증, 전체 런타임 Windows 지원은 각각 다른 완료 상태다.

native 작업의 첫 산출물도 빈 인터페이스가 아니다. 보호된 디렉터리와 후보를 실제로 만들고, 후보 flush와 정식 이름 게시를 실행한 뒤 별도 프로세스에서 다시 열어 판정하는 하나의 실행 가능한 경로를 만든다. no-overwrite 게시 API와 공유 조건은 이 경로의 충돌/교체 시험으로 결정하고, 기대한 범위 고정을 입증하지 못하면 해당 구현을 배치 가능으로 표시하지 않는다.

## Windows 디렉터리 flush의 보장과 제한

`FlushFileBuffers` 문서는 쓰기 권한이 있는 파일 핸들의 버퍼 flush를 설명한다. 볼륨 전체 flush는 관리자 권한을 요구한다. 디렉터리 핸들을 열 수 있다는 사실만으로 일반 사용자에게 POSIX 디렉터리 fsync와 같은 namespace 저장 barrier가 제공된다고 결론 내릴 수 없다. 이 문서들을 근거로 한 설계 판단이며, 실제 Windows 디렉터리 flush를 시험한 결과는 아니다. [FlushFileBuffers 공식 문서](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).

`MOVEFILE_WRITE_THROUGH`의 문서에는 이동 완료와 copy/delete 이동의 flush 설명이 있다. 이를 모든 rename·hardlink·부모 디렉터리 엔트리에 적용되는 일반적인 fsync 대체물로 확대하지 않는다. `FILE_FLAG_WRITE_THROUGH`의 NTFS metadata 설명도 해당 요청에서 발생한 변경의 범위다. 정확한 게시 방법·파일시스템·실행 권한별로 검증해야 한다. [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw), [CreateFileW 캐싱 설명](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew#caching-behavior).

따라서 계약은 다음과 같이 연결한다.

- 기존 POSIX 호출의 파일 fsync와 디렉터리 fsync 요구를 유지한다. 실패를 삼키거나 모든 플랫폼의 기본 내구성을 낮추지 않는다.
- Windows native는 실제 수행한 file flush, 게시 visibility, 이름 저장 barrier의 지원 상태를 따로 보고한다. `nativeWindows: implemented` 하나로 모든 저장 보장을 나타내지 않는다.
- 필요한 이름 저장 barrier가 알려진 미지원이면 strict 호출은 생성 전에 거절한다. 실행 중 지원/성공 여부를 확인하지 못했다면 게시 여부와 함께 명시적인 실패 또는 unknown을 돌려준다. `syncDirectory`를 성공하는 no-op으로 만들지 않는다.
- 일반 사용자 Windows 배치를 진행하려면 **프로세스 중단 후 복구를 보장하되 이름의 전원 장애 내구성은 미보장인 명시적 호스트 정책**을 별도로 연결할 수 있다. 이는 구현·검증할 선택지이며 현재 기본값 변경이 아니다. 호출자는 수행하지 못한 barrier를 결과에서 볼 수 있어야 하고, 요구한 barrier를 몰래 생략하는 옵션으로 구현하지 않는다.
- 그 정책도 실제 native 게시·재관찰·프로세스 종료 시험을 통과한 경로에서만 허용한다. power-loss까지 요구하는 배치는 적합한 저장 backend나 추가 검증이 필요하다. 관리자 권한의 볼륨 flush를 일반 에이전트의 자동 우회책으로 쓰지 않는다.

UNC/SMB·동기화 폴더·다른 볼륨 이동은 첫 NTFS 보장에 포함하지 않는다. 네트워크 파일시스템에서 로컬 실패처럼 보이는 결과도 무조건 ‘게시하지 않음’으로 분류하지 않는다.

## 실행기 보호와 도구의 권한

현재 `FileAgentProfileStore`는 호스트 설정용이고 작업 도구에는 scoped store를 전달한다. 이 분리를 유지한다. 생성·게시 native 함수를 일반 도구로 등록하거나 모델이 engine 경로/권한 정책을 선택하게 하지 않는다.

첫 묶음에서 추가로 확인할 것은 **승인된 담당 영역에 대한 변경만 허용하고, 엔진 설치 영역과 겹치거나 그곳으로 바뀐 경로에는 생성·게시·정리를 하지 않는 것**이다. 문자열 정규화에만 의존하지 않고 호스트의 실제 경로/객체 식별을 사용하며, Windows alias·대소문자·junction이 엔진 거절을 우회하지 않는지 시험한다. 엔진 위치와 범위는 신뢰하는 호스트 조합 지점에서 전달한다.

이것은 같은 OS 계정으로 실행되는 임의 코드 전체의 격리가 아니다. 실행 계정이 소유한 설치 파일은 그 계정의 셸이 별도로 바꿀 수 있다. 제품에서 ‘본체 수정 불가’를 보장하려면 설치/업데이트 주체와 에이전트 실행 계정의 쓰기 권한을 분리하고 설치 영역의 ACL/권한을 실제로 검증해야 한다. unrestricted shell·computer-use·외부 MCP에 엔진 쓰기 권한이 있으면 파일 helper만으로 보호됐다고 표시하지 않는다. 도구 실행 권한/샌드박스와 설치·업데이트 정책은 별도 명시 작업으로 남긴다.

## 구현 순서와 완료 기준

| 묶음 | 실제 결과와 인수 기준 | 다른 작업과의 관계 |
|---|---|---|
| **A. 다음 구현: POSIX setup 생성·게시·재개** | 위 프로필 경로에 변경 경계를 연결한다. 데이터 형식/기본값/ID 복구·clone 회귀를 유지하고, 엔진 범위 거절·게시 후 오류·정리 이중 실패를 검증한다. 기존 POSIX 보장과 새 보강/추가 I/O를 구분한 결과 문서를 남긴다. | Windows 장비 없이 개발·검증할 수 있다. 이 묶음을 파일 함수별 연속 챕터로 쪼개지 않는다. |
| **B. 병행: Windows native setup 입증** | Rust 모듈과 같은 setup 계약을 구현한다. ACL 생성·실제 계정 간 접근·핸들 수명·no-overwrite·process kill 재개·지원하지 않는 barrier 거절을 Windows에서 입증한다. 연결된 진입점과 미지원 진입점을 표시한다. | 호스트 계약, Rust 코드/패키징 골격, 이식 가능한 결과 상태 시험은 장비 확보 전에 진행한다. cross compile/mock 통과를 native 실행 통과로 기록하지 않는다. Windows runner 확보 전 실제 검증은 미완료로 남긴다. |
| **C. Windows 전체 배치 전 소비자 연결** | 저널/workspace의 게시와 자기 후보/검증된 파일 삭제를 기존 복구·lock 수명 안에 연결한다. 별도로 artifact의 async root/두 파일 공개 수명, SQLite owner/sidecar·연결 수명을 완성한다. 변경 연산이 없는 read-only 경로까지 일괄 재작성하지 않는다. | C02의 세션·context 구현을 시작하기 위한 선행 조건으로 만들지 않는다. 전체 Windows 지원이나 안전한 저장소 배치를 선언하기 전에는 필요한 연결과 실제 검증을 완료해야 한다. |

A에서 최소한 확인할 실패 경계는 다음과 같다. 기존 시험을 지우거나 동일한 정상 동작을 반복하는 대신 새 수명에 해당하는 사례를 추가한다.

- 새 root/0755 부모/기존 정상 담당/foreign 담당, 엔진과 동일·상하위·alias 경로. 거절 시 정식 파일 생성·덮어쓰기 없음.
- 후보 open/write/file sync 전후, no-overwrite 게시 직후, 후보 정리, parent sync, 반환 전 확인에서 오류 주입. 원 cause와 게시 단계가 유지되고 다른 주체의 파일은 보존됨.
- 동시 initializer, 실제 프로세스 종료 후 재시작. 게시된 operation이 있으면 같은 agentId를 사용하며, half-written 후보를 완성된 설정으로 채택하지 않음.
- 후보 이름을 바꾼 다른 객체/부모 교체/정상 pending↔final 동일 객체. 안전하지 않은 정리는 거절하고, 정리 실패가 주 오류를 덮어쓰지 않음.
- 정상·오류·중단 후 재호출의 descriptor 수명, mutation/barrier/cleanup 계측. 실제 I/O와 논리 게시 수를 혼동하지 않음.

B의 실제 Windows 시험은 로컬 NTFS에서 두 일반 계정, 상속 ACL·owner 불일치, junction/reparse·hardlink, 한글·공백·긴 경로·공유 위반, 단계별 process kill을 포함한다. 실제 전원 차단 시험을 하지 않았다면 해당 보장은 계속 미검증이다. Linux/macOS 시험을 Windows ACL 시험으로 대체하지 않는다.

**A의 인수 기준을 충족하면 공통 파일 추출을 이유로 C02를 계속 미루지 않는다.** C02는 확정된 application 저장 포트와 지원되는 POSIX 실행 환경을 사용해 같은 담당/사용자의 세션을 유지하고 compact하며 다음 작업으로 이어가는 구현을 진행할 수 있다. B/C는 플랫폼 배치 작업으로 병행하며 실제 Windows 사용을 준비할 때의 명시적 차단 조건으로 추적한다.

## 남기는 명시 항목

이 문서가 완료되는 것과 C01 전체가 완료되는 것은 다르다. 첫 구현 뒤에도 다음 상태를 결과 문서에 남긴다.

- POSIX path recheck와 Windows handle 기반 접근의 실제 구현 범위, native 실행을 마친 진입점.
- 저널 일반 레코드 읽기, workspace stage/remove 변경 연산, artifact async 게시, SQLite 자체 파일/sidecar 접근의 잔여 연결.
- 고아 후보의 자동 청소, stale lock 인수, 저장 형식 변경, SQLite VFS 교체는 이번 추출의 숨은 후속 필수 작업으로 늘리지 않는다. 필요가 입증되면 별도 작업으로 결정한다.
- 엔진 설치 권한과 도구 실행 격리, Windows native 바이너리 패키징/업데이트·지원 아키텍처의 검증.
- 파일시스템별 이름 저장 barrier, 네트워크/동기화 디렉터리, 전원 장애의 미지원 또는 미검증 상태.

첫 A 묶음의 변경은 프로필 생성·게시·재개의 실제 결과를 개선해야 한다. 함수의 이동만 끝나고 Windows 쪽은 계속 TODO만 남거나, 모든 저장소를 다시 쓰느라 세션/추론 개발이 중단되는 방향으로 확장하지 않는다.
