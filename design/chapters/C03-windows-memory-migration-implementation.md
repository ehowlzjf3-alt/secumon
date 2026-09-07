# Windows 개인 기억 이관 구현

checkpoint 362에서 개인 기억의 SQLite → documents 관리 경로를 Windows native 파일·SQLite 연결에 붙였다. 제품 코드는 저장했으며 통합 빌드와 실제 Windows 검증은 별개다. 이 문서 작성 과정에서 시험, 데이터베이스 실행, SSH 접속은 하지 않았다.

Root가 첫 TypeScript 통합 빌드와 Windows target `cargo check`의 exit 0을 확인했다. [첫 통합 빌드 원로그](../../runtime/evidence/C01-windows-administrative-build1.log)를 보존하며, 그 뒤 기존 operation reader의 exact path 계약에 맞춘 source/target 정규화 두 줄을 추가했다. 이 마지막 변경을 포함한 [최종 build2](../../runtime/evidence/C01-windows-administrative-build2.log)도 exit0으로 종료했다. 컴파일 확인은 실제 Windows 이관·중단 복구 시험을 대신하지 않는다.

`preview`는 기존 담당 소유자와 스키마를 확인한 뒤 하나의 읽기 트랜잭션에서 snapshot과 문서 이관 용량을 계산한다. `apply/resume`는 원래 순서인 프로필 원본 보관 → 백업 완료 → 원 SQLite 개인 영역 fence → 검증한 백업에서 documents import → 활성화 영수증 게시를 유지한다. 일반 실행의 `readSqlitePersonalMemoryFence` Windows 분기는 이미 구현돼 있어 다시 만들지 않았다. 원 owner, snapshot/work/owner digest, revision, 개인 기억 receipt와 index, fence trigger 검사는 기존 구현을 재사용한다.

관리 snapshot과 fence의 SQLite 연결은 [`openHostSqliteDatabase`](../../runtime/src/infrastructure/windows-sqlite.ts)를 사용한다. Windows는 원 main 파일과 부모 디렉터리를 native handle로 유지하고 SQL 호출 및 COMMIT 전후에 main/sidecar를 검사한다. 실행 중인 SQLite 파일에 POSIX `lstat`와 UID/mode 판정을 대입하지 않는다. 백업 위치의 중첩과 대소문자 경로 비교는 native 부모 경로를 사용한다. fence 쓰기의 원 오류와 rollback/close 오류를 함께 보존한다.

백업은 기존 [`personal-memory-backup`](../../runtime/src/infrastructure/personal-memory-backup.ts)과 별도 worker를 그대로 사용한다. 최대 256MiB, 60초, 한 번에 256 SQLite page, 작업별 최대 4개 후보 한도는 바꾸지 않았다. worker는 읽기 전용 BEGIN 뒤 실제 owner 조회로 고정한 같은 연결을 SQLite backup에 넘긴다. Windows Proxy의 내부 SQLite 객체는 모듈 안 WeakMap에서만 얻으며 호출자에게 노출하지 않는다. `hostBackupSqliteDatabase`는 원본과 대상의 native guard를 backup 완료까지 유지하고, 그 사이 같은 원본 연결의 SQL 실행·close를 거절한다.

원본 연결 종료와 후보의 journal 정규화·종료, 후보의 owner/schema/논리 digest/integrity 재검사를 끝낸 뒤에만 파일 바이트를 읽는다. 새 [`windows-personal-memory-backup`](../../runtime/src/infrastructure/windows-personal-memory-backup.ts)은 64KiB씩 해시하고 길이·identity·change token을 재확인한다. 읽기 handle을 닫은 다음 native `syncRegular`가 배타 handle로 `FlushFileBuffers`를 실행한다. 전체 DB를 하나의 Buffer로 읽지 않는다.

Windows에서는 기존 POSIX hardlink 게시 대신 native [`admin.rs`](../../runtime/native/windows-files/src/windows/admin.rs)의 `publishExisting`을 사용한다. 이미 검증된 후보의 정확한 identity/change token과 사설 ACL, 원·대상 디렉터리, 같은 volume을 확인한 후 같은 파일을 no-replace rename한다. 따라서 후보 검증 영수증에 기록한 identity가 최종 `backup.sqlite`에도 유지된다. 최종 파일을 worker로 다시 검증한 뒤 별도 `backup-complete.json`을 게시한다. 게시 결과가 불명확하면 후보나 최종 파일을 임의 삭제하지 않으며, 같은 작업의 기존 검증 영수증·identity·hash가 일치하는 경우에만 재개한다. 검증 영수증 없는 정본은 새 백업으로 덮지 않는다.

Windows 내구성은 기존 호스트 정책인 **process-crash**다. 파일 flush를 실행하지만 디렉터리 namespace fsync나 전원 차단 내구성을 보장한다고 표시하지 않는다. POSIX는 기존 hardlink·unlink·directory fsync 경로를 유지한다. worker의 IPC 단절 종료, deadline 이후 TERM/KILL과 종료 관측 한도, 종료 미관측 표식, 원 오류 및 독립 cleanup 오류 보존도 유지한다.

후속 검증은 기존 personal-memory migration/backup 회귀의 POSIX 결과와 실제 Windows ABI4 결합을 구분해 수행해야 한다. Windows에서 같은 snapshot backup, 4MiB를 넘는 후보, rename 직전·직후 중단 재개, 후보/정본 교체·ACL·link 거절, fence 이후 동일 백업 재개, worker 종료 관측을 확인할 필요가 있다. 현재 구현 저장만으로 이러한 실행 결과나 개인 기억 이관 전체 완료를 주장하지 않는다.
