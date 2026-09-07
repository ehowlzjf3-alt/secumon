# C07 — Windows 공유 게시판·knowledge·archive 저장소 연결

2026-09-08. 기존 Windows ABI 3 파일 helper와 SQLite guard를 공유 저장소의 실제 등록·열기 경로에 연결했다. 이번 변경은 코드 구현이며 실제 Windows 실행 결과가 아니다. 빌드·시험·cargo·SQLite 실행·외부 접속은 수행하지 않았다. 통합 TypeScript 빌드는 상위 작업에서 별도로 확인한다.

## 연결한 입구

| 기존 입구 | 이번 연결 |
| --- | --- |
| [createLocalHostBoard](../../runtime/src/presentation/host-board.ts)의 `backend:'sqlite'` | [SqliteBoardRepository](../../runtime/src/infrastructure/sqlite-board.ts)가 `openHostSqliteDatabase`를 사용한다. 실제 SQLite 연결 종료까지 native main/디렉터리 참조를 보유하며 초기 SQL 실패 시에도 연결을 닫고 원 오류와 정리 오류를 보존한다. |
| 같은 factory의 `backend:'file'` | [FileBoardRepository](../../runtime/src/infrastructure/file-board.ts)가 Windows에서 기존 `WindowsJournalFiles`의 private scope·이름 조회·안정된 원문 읽기를 사용한다. 8MiB 기록은 native stream으로 읽고, 같은 디렉터리의 candidate를 flush한 뒤 기존 파일을 덮어쓰지 않는 원자적 게시를 수행한다. |
| [registerSharedKnowledgeStore / preflightKnowledgeStore](../../runtime/src/infrastructure/sqlite-knowledge-owner.ts) | 공유 knowledge의 명시 등록은 Windows guard가 main 파일을 안전하게 생성·보유한 뒤 기존 owner SQL을 수행한다. 읽기 전용 사전 확인도 guard 안에서 수행한다. 기존 [SqliteKnowledgeRepository](../../runtime/src/infrastructure/sqlite-knowledge.ts)의 실제 연결과 이어진다. |
| [createLocalArchiveRegistration](../../runtime/src/presentation/host-archive.ts) | [FileArchiveProvider](../../runtime/src/infrastructure/file-archive.ts)의 직접 디렉터리 열기를 Windows native 이름 조회로 연결하고, replay의 필수 barrier가 host의 `process-crash` 정책을 명시적으로 처리하게 했다. 원문 읽기·게시·close는 기존 host helper를 그대로 사용한다. |

호스트의 등록 API와 feature/권한 조립은 변경하지 않았다. 게시판 factory에는 호스트가 정한 절대 파일 또는 디렉터리 경로를 전달한다. 기존처럼 부모 디렉터리는 미리 준비되어 있어야 하며, Windows SQLite 부모는 현재 SID의 private 조건을 만족해야 한다. factory가 논리 게시판·멤버·게시물·질문을 새로 만들거나 개인 자료를 옮기지는 않는다.

공유 knowledge는 호스트가 `registerSharedKnowledgeStore(path, { storeId, agentIds })`로 정확한 담당 목록을 먼저 등록하고, `new SqliteKnowledgeRepository(path, { mode:'shared', storeId, agentId })`로 해당 담당 handle을 연다. 기존 등록 목록과 다른 재등록은 계속 거절한다. `agent_storage_owner`가 있는 개인 DB를 공유 저장소로 전환하지 않는다.

## 유지한 저장·권한 의미

게시판의 `board-journal-v1` 원문, checksum/previous chain, tenant/id별 순서, command 영수증과 중복·충돌 판정은 그대로다. Windows에서도 기록당 8MiB와 게시판당 4,096개 기록 상한을 적용한다. native 디렉터리 열거는 기존 helper의 65,536개 이름 상한 안에서 수행한다. 게시 단계는 동기로 끝내므로 게시 중 새로운 비동기 close 경계를 추가하지 않는다. `close()`는 보유한 Windows scope와 디렉터리 참조를 해제한다.

SQLite board의 테이블·transaction·revision CAS·변경 이벤트 형식과 공유 knowledge의 store/agent 등록 형식은 변경하지 않았다. 공유 board scope와 각 담당의 work scope, 원문 소유자 조회, private evidence·대화·개인 DB 격리도 기존 경계를 따른다. archive 역시 기존 owner/provider별 `archive-reference-v1` 형식을 유지하며 knowledge나 Evidence를 자동 생성하지 않는다.

Windows 파일 읽기·게시에는 실제 보유한 directory/file 객체를 사용한다. Node에서 경로만 확인한 뒤 파일 본문을 다시 여는 방식으로 대체하지 않는다. SQLite는 [기존 guard](../../runtime/src/infrastructure/windows-sqlite.ts)가 보유한 main의 canonical 경로를 실제 연결에 전달한다. 읽기 전용 guard는 ACL을 변경하지 않으며 writable guard의 private sidecar 상속 준비도 기존 계약을 재사용한다.

## 내구성과 남은 확인

Windows 파일 게시의 지원 수준은 **process-crash**다. candidate 파일 flush와 원자적 게시를 수행하지만 namespace/power-loss fsync를 제공하지 않으며 `directorySynced:false`를 유지한다. archive replay 역시 [completeMetadataPublication](../../runtime/src/infrastructure/host-metadata-files.ts)의 capability 결과를 처리한다. POSIX에서는 기존 fsync 경로를 계속 사용한다. 이 차이는 Windows flush 실패를 숨기거나 unsupported barrier를 성공으로 바꾸는 처리와 다르다.

이번 담당자는 실행 검증을 하지 않았다. 실제 Windows에서 addon 로드, SID/DACL·reparse·hardlink 거절, WAL/SHM 생성과 재열기, 두 저장소 인스턴스의 게시/등록 경합, 중단 후 duplicate receipt 회복 및 close는 후속 인수로 남는다. 네 제품 파일과 이 문서 외에는 변경하지 않았으며 공통 native/SQLite helper는 재사용했다.

이 단위는 [앞선 DB·lease 구현](C01-windows-database-lease-implementation.md)에서 남겨 둔 공유 knowledge 등록과 게시판·archive의 로컬 파일 입구를 연결한다. personal-memory 관리 backup/migration, PostgreSQL 전환·복구는 다른 작업의 범위이며 이 문서가 그 완료를 대신하지 않는다. Windows 전체 지원·전원 손실 복구·실제 모델/사내 서비스 품질을 검증 완료로 표시하지 않는다.
