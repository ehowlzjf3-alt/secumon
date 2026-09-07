# C01 — Windows SQLite 소유·lifecycle lease 연결 구현

2026-09-08. SQLite main 파일의 native 보유 수명을 실제 연결 종료까지 유지하고 lifecycle lease의 생성·조회·삭제를 Windows 파일 경계에 연결했다. 기존 POSIX SQL·owner·lease 정책은 유지한다. 실제 Windows DLL 로드·SQLite 동작·ACL·종료 복구 인수는 미실행이며, 컴파일 확인은 상위 작업이 기록한다.

## SQLite 원 객체와 실제 연결

[native DatabaseGuard](../../runtime/native/windows-files/src/windows/database.rs)는 private 디렉터리 참조와 main 파일을 보유한다. main은 READ/WRITE 공유를 허용하고 DELETE 공유를 거절한다. SQLite에는 그 보유 파일의 canonical volume GUID 경로를 전달하며 원 ID·현재 owner/DACL·단일 링크·reparse 여부를 다시 확인한다. 단순 path 검사 뒤 보유 객체 없이 Node에서 다시 여는 방식이 아니다.

`Scope.database(leaf, create)`는 기존 main을 확인하거나 명시 create에서만 private 빈 파일을 배타적으로 만들고 Flush한다. main 없이 sidecar만 있으면 거절하며, 동시 초기화로 main이 뒤늦게 생긴 경우 한 번 다시 확인한다. 현재 WAL/SHM/journal은 native metadata/ACL 검사로 확인한다. sidecar는 SQLite가 정상적으로 만들고 제거할 수 있으므로 main처럼 수명 전체를 고정하지 않는다.

[windows-sqlite](../../runtime/src/infrastructure/windows-sqlite.ts)의 `openHostSqliteDatabase`는 Windows에서 실제 SQLite 연결을 이 guard 안에 연다. SQL exec·prepare·statement 실행과 iterator의 각 진행 전후에 guard를 확인한다. SQLite 연결이 닫힌 다음 main/디렉터리 참조를 명시적으로 닫는다. SQLite close가 실패하면 guard를 유지해 close를 재시도할 수 있게 한다. 초기화 실패와 cleanup 오류가 함께 있으면 두 오류를 보존한다. POSIX와 실제 `:memory:` DB는 기존 DatabaseSync 경로를 사용한다.

연결한 consumer는 다음과 같다.

- [agent-database-owner](../../runtime/src/infrastructure/agent-database-owner.ts): 존재·sidecar·소유 확인, 새 owner transaction, WAL 준비를 native guard 안에서 수행한다. POSIX의 descriptor/uid/mode/identity 경로는 그대로 둔다.
- [sqlite-state](../../runtime/src/infrastructure/sqlite-state.ts), [sqlite-knowledge](../../runtime/src/infrastructure/sqlite-knowledge.ts), [local-channel](../../runtime/src/infrastructure/local-channel.ts): constructor부터 실제 close까지 guard를 보유한다. channel에 주입되는 SQLite session도 같은 연결을 사용한다.
- [readSqlitePersonalMemoryFence](../../runtime/src/infrastructure/sqlite-personal-memory-migration.ts): 일반 profile inspect/reopen의 read fence만 Windows guard 경로에 연결했다. 같은 owner·fence·SQL snapshot 검증을 유지하고 Node lstat 기반 ownedPath로 우회하지 않는다.

## Sidecar ACL과 읽기/쓰기 구분

공통 native 경계는 새 private directory에 현재 effective SID의 단일 FA ACE와 OI/CI 상속을 적용한다. 현재 effective privacy 검사도 동일 SID·단일 FA ACE만 허용하며 OI/CI/INHERITED 외 임의 flags·다른 SID·복수 ACE는 허용하지 않는다. uid/mode를 Windows 권한으로 합성하지 않는다.

기존 비상속 private 디렉터리는 **writable create/open에서만** 같은 SID의 상속 DACL을 준비한다. 기존 parent와 bounded 직계 child privacy를 검증하고, 이미 필요한 상속이 있으면 변경하지 않는다. private가 아닌 ACL을 “복구”하거나 공개 ACL을 비공개로 덮어쓰지 않는다. SetSecurityInfo가 기존 child로 ACE를 전파할 수 있으므로 이 전환은 일반 ACL 편집 API로 공개하지 않는다. [Microsoft의 SetSecurityInfo 계약](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo).

`create=false`의 존재/읽기 전용 guard는 ACL을 변경하지 않는다. 읽기 전용 SQLite가 WAL coordination 파일을 만들 수 있다는 기존 제약은 유지하며 현재 sidecar가 private 조건을 충족하지 않으면 거절한다. writable guard는 이후에도 상속 조건을 확인한다. namespace fsync를 제공한다고 표시하지 않으며 host process-crash 정책과 `directorySynced:false`를 유지한다.

## Lifecycle lease

[agent-lifecycle-lease](../../runtime/src/infrastructure/agent-lifecycle-lease.ts)는 Windows에서 [전용 helper](../../runtime/src/infrastructure/windows-lifecycle-lease.ts)를 사용한다. root·barrier·lease 목록은 native 존재/이름 조회로 확인하고, immutable lease 게시에는 기존 profile mutation scope를 사용한다.

해제 시 현재 private 원문을 읽어 기대한 lease 값과 비교하고 `removeRegular(leaf, expectedBytes)`에 정확한 바이트를 전달한다. native가 보유한 regular file을 비교·삭제하므로 검증 뒤 Node unlink로 다른 이름을 지우는 경로를 사용하지 않는다. runtime/maintenance 상호 배제, UUID·host·PID, 명시 offline 확인과 살아 있는 PID 거절, publish 이후 실패 cleanup, 반복 close 의미는 기존대로다. scope는 finally에서 닫힌다.

## 확인과 잔여

이번 담당자는 새 시험·빌드·cargo·SSH·실제 Windows 실행을 수행하지 않았다. 상위 작업이 공통 ABI 3/다른 파일 경계와 모아 compiler 확인을 수행하며 원 로그와 최종 source를 보존한다. native 파일/TS consumer는 해당 통합 확인을 위해 동결한다.

이번 연결은 일반 단일-agent SQLite state/memory/channel과 profile read fence다. 관리용 personal-memory snapshot/fence/write migration, 직접 DatabaseSync를 여는 일부 export/backup/다른 저장소 factory, shared knowledge 등록의 전체 Windows 연결은 이 변경에 포함하지 않았다. 원 DB handle을 외부 SQLite API에 직접 넘기는 관리 작업도 별도 guard 연결이 필요하다. file-journal·artifact·workspace·일반 lifecycle tree 작업은 다른 담당 범위다. 이 문서는 해당 작업이나 실제 Windows·전원 손실·실서비스 품질 검증의 완료를 대신하지 않는다.
