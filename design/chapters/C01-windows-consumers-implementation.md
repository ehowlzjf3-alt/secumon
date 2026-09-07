# Windows 저장 소비자 연결

2026-09-08 · checkpoint361 · 구현 연결·통합 빌드 통과, 상세 검증 미실행

checkpoint360 이후 남은 Windows 파일 소비자를 연결한다. 기존 POSIX 경로와 담당/사용자/세션/업무 분리를 유지한다. 새로운 agent 구조를 만들지 않고 공통 저장 포트가 Windows의 실제 파일 API를 사용하도록 한다. 상세 기능 시험은 전체 구현 후 별도 순서로 수행한다.

## 이번 단위의 구현 범위

| 영역 | 변경 목적 | 코드 |
|---|---|---|
| 공통 native ABI3 | 파일을 작은 조각으로 읽고 쓰며 최대 1GiB 파일을 처리한다. 파일 게시 이전 flush와 게시 결과를 구분한다. | `windows/streams.rs`, `windows-stream-files.ts` |
| 원문 artifact | 원문과 참조를 검증해 저장한다. 동일 ID의 다른 내용을 덮어쓰지 않는다. | `file-artifacts.ts` |
| workspace | 작업별 임시 파일을 보존하고, native 잠금으로 동일 시도의 쓰기를 직렬화한다. 정리 시 원 바이트를 대조한다. | `file-workspaces.ts`, `windows/mutations.rs` |
| file-journal | 기본 64MiB 기록 한도를 유지하며 revision별 기록을 중복 게시하지 않는다. | `windows-journal-files.ts`, `file-journal-state.ts` |
| SQLite | 파일을 연 동안 다른 객체로 교체되지 않게 main 파일과 조상 handle을 보유한다. owner·세션·지속 기록은 기존 SQL 구조를 사용한다. | `windows/database.rs`, SQLite/owner 소비자 |
| 설치·복원 | 큰 엔진/원문을 stream으로 복사하고 config·원문·지문을 기존 형식으로 보존한다. PostgreSQL 결합 복원의 로컬 파일 경로도 포함한다. | `windows-lifecycle-files.ts`, lifecycle/engine-release/PG-backup 소비자 |

`handle`은 운영체제가 실제로 열어 둔 파일·디렉터리 참조다. 문자열 경로만 검사한 후 다시 파일을 열어 해당 검사를 대신하지 않는다. `ABI`는 Node.js와 Rust 모듈 사이의 호출 규약이며 이번 새 API는 3을 요구한다. 이전 ABI2의 native 바이너리는 새 loader에서 거절된다. 아직 이 문서의 작성만으로 Windows 바이너리가 만들어지거나 실행된 것은 아니다.

## 내구성과 권한

Windows는 계속 `process-crash` 정책을 사용하며 `directorySynced:false`를 반환한다. 파일의 FlushFileBuffers와 디렉터리의 전원 장애 내구성을 같은 것으로 표시하지 않는다. native 게시 결과가 불명인 경우 `unknown`을 보존하고, 게시 뒤 검사/close 오류가 난 경우에도 이미 게시됐을 가능성을 숨기지 않는다.

파일 chunk(한 번에 처리하는 조각)는 최대 1MiB이고 stream 파일은 최대 1GiB다. profile의 작은 파일 API는 기존 4MiB 한도를 유지한다. 큰 파일의 capture/copy는 전체 파일을 한 번에 메모리에 올리지 않는다. artifact/저널의 기존 전체 본문 반환 포트는 필요한 범위만 유한하게 모은다.

새 private 디렉터리의 ACL(파일 접근 권한 목록)은 현재 사용자 SID(운영체제의 사용자 식별자) 하나에만 전체 접근을 주며 같은 권한을 자식 파일에 상속한다. SQLite가 만드는 WAL/SHM 등 보조 파일도 이 경로를 따른다. 기존 private 디렉터리의 DB 사용 준비는 동일 사용자 단일 권한을 먼저 검증한 경우에만 같은 private 권한의 상속을 준비한다. 일반 폴더나 다른 사용자가 포함된 권한을 자동으로 수정하지 않는다. 이미 열려 있는 DB와 보조 파일의 실제 공유·권한 동작은 Windows에서 별도 검증해야 한다.

## 검증은 별도

TypeScript 통합 `npm run build` 1회(session34305)가 **actual exit0**으로 끝났다. [빌드 로그](../../runtime/evidence/C01-windows-consumers-build1.log). Windows target cargo check1은 ACE flag의 u8/u32 타입 오류로 exit101이었다. 해당 오류 교정 후 check2 exit0, readOnly guard의 ACL 비변경을 연결한 최종 check3도 exit0이다. [native 소스 지문·원결과](../../runtime/native/windows-files/evidence/consumers-implementation-cargo-check.json).

Windows DLL 링크·Node 로드·실제 Windows 실행, 새 상세 테스트·DB 이관/백업/복원·모델/API·사내 연결·SSH/배포는 실행하지 않았다. [현재 체크포인트](../../runtime/evidence/C01-windows-consumers-checkpoint.json)에 빌드·원자료·현재 소스 지문을 저장한다. 현재 활성 실행 세션은 없다.

이후 [전체 검증 목록](C06-C10-verification-plan.md)의 Windows 항목에서 실제 native 링크/로드, 큰 파일과 빈 파일, 게시 전후 중단, 공유 모드, 권한 상속, 프로세스 종료 후 잠금 해제, SQLite 보조 파일, lease 재개, 설치/복원을 확인한다. 실제 포트 연결이 남은 부분은 미검증과 별도로 기록한다.

## 남은 실제 구현

일반 agent의 state/memory/channel과 독립적인 공유 board/knowledge 등록, 관리용 개인 기억 snapshot/fence/이행, PostgreSQL export·이관의 직접 SQLite 열기와 파일 저널 원본 format 전환은 Windows native 경계 연결이 남아 있다. 현재 `sqlite-board.ts`, `postgres-transfer.ts`, `agent-postgres-migration.ts`, `sqlite-personal-memory-migration.ts`의 직접 경로를 확인했다. 이를 일반 단일 담당 실행의 구현과 혼동하지 않는다. 다음은 이 관리/공유 포트가 기존 guard·stream을 사용하도록 연결하는 단위다.

네이티브 디렉터리 열거는 한 디렉터리 최대 65,536개를 지원한다. 이보다 큰 저장소의 목록 paging은 별도 후속이고, 조용한 목록 누락은 허용하지 않는다. 알 수 없는 게시 결과의 pending 후보를 임의 삭제·성공 채택하지 않으며 복원 작업의 재확인이 필요할 수 있다. 전체 Windows 지원이나 전체 C01~C10 goal을 완료 처리하지 않는다.

- [file-journal 구현 및 검증 항목](C01-windows-journal-implementation.md)
- [SQLite·lease 구현 및 잔여](C01-windows-database-lease-implementation.md)
- [설치·복원 구현](C10-windows-lifecycle-implementation.md)
