# 기존 자료 이관·외부 저장 백업 연결

2026-09-08 · checkpoint360 · 구현 연결 및 통합 빌드 통과, 상세 검증 미실행

C06~C10 주 실행 경로는 checkpoint357에서 연결했다. 이번에는 C10 복원에 필요한 PostgreSQL 기존 자료 이관·백업과 Windows 설정/복제 소비자를 보완했다. 작업의 목표·근거·영수증을 새로 실행하거나 개인 기억과 대화를 합치지 않는다. 구현 우선 방침에 따라 상세 회귀/장애/플랫폼 검증은 [별도 목록](C06-C10-verification-plan.md)에 남긴다.

## 기존 자료를 PostgreSQL로 옮기는 과정

`prepareAgentPostgresMigration`은 실행기를 정지한 담당의 SQLite/file-journal 원자료를 유한한 페이지로 저장하고, 원 설정과 저장소 선택의 지문 및 이관 작업 번호를 기록한다. 이 단계에는 PostgreSQL에 접속하지 않는다. 준비가 확정되면 일반 실행은 이관 완료를 기다린다. 설정만 바꿔 비어 있는 저장소를 열지 않는다.

`applyAgentPostgresMigration`은 같은 작업 번호·snapshot 지문·호스트 등록을 요구한다. 명시적으로 DB를 준비하고 maintenance(점검 중 쓰기 차단)를 건 뒤 원 revision·업무/기억/대화 영수증·세션/compact 상태를 복사한다. 이어 원 SQLite에는 이전 엔진의 재쓰기를 막는 버전/trigger를, 파일 저널에는 지원하지 않는 새 format 표식을 남기고 activation(대상 저장소 사용 확정)을 마지막으로 게시한다. 원자료 파일과 기록은 보존한다. 문서 개인 기억을 쓰는 경우 문서는 그대로 두고 SQL의 업무 기억만 이동한다.

중단 뒤에는 같은 operation(하나의 이관 작업 식별자)으로 이어간다. import 완료 여부는 원 snapshot과 DB 영수증으로 대조하며 COMMIT 응답이 불명인 경우 새 작업 번호로 자동 재전송하지 않는다. 실패한 이관의 DB 쓰기 차단은 그대로 남긴다. 활성화 이후 같은 이관 완료 처리를 반복할 때는 과거 행을 다시 덮어쓰지 않는다.

기존 config를 재작성하지 않고 이관 기록을 적용해 실제 PostgreSQL 선택을 얻는다. 일반 profile/store, clone, lifecycle, 호스트 예제가 이 선택을 사용한다. PostgreSQL 설치 스키마는 2로 올렸으며 명시 provisioning에서만 이전 설치 스키마를 바꾼다. 일반 열기가 DDL을 실행하지 않는다. 실제 서버에 업그레이드를 실행한 기록은 아니다.

현재는 하나의 불변 이관 작업과 같은 등록 내 로컬 용도의 추가 이관을 지원한다. 여러 차례 임의의 DB 간 이동이나 PostgreSQL→SQLite 역이관을 구현했다고 표시하지 않는다. 상세 코드와 제한은 [transfer 구현](C03-postgres-transfer-implementation.md)을 따른다.

## PostgreSQL과 로컬 원문을 함께 백업·복원

`backupAgentPostgres`는 로컬 실행 lease(실행 중임을 나타내는 표식)와 DB 점검 차단을 함께 사용한다. PostgreSQL의 일관된 snapshot과 로컬 config·identity·문서·artifact·workspace를 묶고 원문 지문을 확인한 뒤 백업 manifest(파일 목록과 지문)를 마지막에 저장한다. 도중에 남은 디렉터리를 완성된 백업으로 채택하지 않는다.

`restoreAgentPostgresBackup`은 원 담당·원 경로·같은 등록과 호스트가 백업 밖에 따로 보관한 복원 허용 기준을 요구한다. 대상 PostgreSQL은 사전에 명시 provisioning되어 있어야 하며, 비어 있거나 같은 복원 작업의 정확한 재시도여야 한다. 기존 임의의 DB 자료를 교체하지 않는다. 복원 표식이 있는 동안 일반 profile 열기를 차단한다. 파일/DB를 복구하고 재조회 지문을 확인한 후 표식을 해제하며 업무 실행은 시작하지 않는다.

백업이 외부 시스템에서 이미 발생한 효과를 취소하지는 않는다. 재개 때 기존 실행 영수증과 외부 상태 대조가 필요하다. 복원 허용 기준은 최신 삭제/철회 정보를 백업 자체로 추정하는 기능이 아니다. 복원은 새 관리 작업 영수증을 사용하며 실제 업무 영수증은 보존한다. 이전 migration의 관리 영수증은 백업하지 않으므로 복원 후 과거 이관 apply 명령 재호출은 거절될 수 있다. 일반 runtime 재개에는 그 관리 명령이 필요하지 않다.

API·한도·정리 및 재개 범위는 [외부 백업 구현](C10-postgres-backup-implementation.md), 사용 입구는 [호스트 예제](C03-postgres-usage.md)를 따른다. 예제에 prepare-migration/apply-migration/backup/inspect-backup/restore 명령을 연결했다. 연결 문자열이나 비밀을 설정/명령 인자에 넣지 않는다.

## Windows 소비자 연결

setup·profile 조회·설정/identity 읽기·skill 복제·문서 개인 기억 게시를 기존 Rust handle API에 연결했다. ABI는 2이며 디렉터리 열거와 자식 정보 확인을 포함한다. Windows 기본 게시 내구성은 process-crash(프로세스 중단에 대한 게시 단위)이고 `directorySynced: false`를 명시한다. 전원 장애까지 견디는 디렉터리 동기화를 성공한 것으로 보고하지 않는다. 엄격한 정책은 별도 선택이며 지원하지 않는 경우 거절한다. [Windows 구현 범위](C01-windows-profile-implementation.md).

일반 file-journal·artifact·workspace, SQLite 소유 표식/lock과 일부 lifecycle 파일 소비자는 아직 Windows 연결이 남아 있다. `.node` 모듈 링크·Node 로드·실제 Windows 실행도 하지 않았다. 이 결과는 전체 Windows runtime 사용 가능 판정이 아니다.

## 이번에 실행한 확인

- TypeScript build1(session63253): actual exit2. 종료 경로의 타입 추론 때문에 null/undefined 오류가 발생했다.
- 오류를 던지는 공통 함수 두 곳의 `never` 함수 타입을 명시한 build2(session29945): **actual exit0**. [로그](../../runtime/evidence/C01-C03-migration-backup-build2.log).
- 호스트 예제 `node --check`: exit0. 예제 실행이나 DB 접속 결과가 아니다.
- Windows Rust ABI2 target cargo check: 1회 exit0. [원결과](../../runtime/native/windows-files/evidence/profile-implementation-cargo-check.json). DLL 링크/Windows 실행 없음.

상세 테스트, 실제 PostgreSQL/SQLite 이관·백업·복원 실행, 모델/API, 사내 MCP·Knox·A2A, SSH/NAS/배포는 실행하지 않았다. [체크포인트 증거](../../runtime/evidence/C01-C03-migration-backup-checkpoint.json)에 현재 빌드와 소스 지문을 저장한다. 이전 통과 기록은 해당 시점의 증거로 보존한다.

## 다음 구현과 이후 검증

다음 구현 단위는 Windows 잔여 파일 소비자 연결이다. C05의 동결된 시험 후보는 보존하며 새로운 상세 시험을 시작하지 않는다. 저장 기능 상세 검증은 아래와 C06~C10 목록을 합쳐 전체 구현 후 진행한다.

- SQLite/file-journal 및 문서 개인 기억 조합에서 목표·revision·영수증·대화·session/task context head가 유지되는 이관.
- prepare/apply 각 게시·COMMIT·원자료 쓰기 중단·activation 전후 강제 종료, 같은 작업 번호 재개와 다른 번호 거절.
- 기존 로컬 작성자와 PostgreSQL 작성자의 경합 차단, installation 버전 호환, 기존 개인 기억 retired fence 유지.
- 백업 도중 로컬/DB 변경, 부분 파일·지문·등록 불일치·용량 초과, 같은 복원 operation 재개와 업무 중복 실행 방지.
- 빈 target/기존 target, 유지한 host floor, 과거 migration 관리 명령 재호출, 실제 업무 영수증 보존.
- Windows setup/inspect/clone/문서 기억의 ACL·reparse·동시 변경·게시 내구성과 ABI2 링크/로드/종료.

전체 C01~C10 goal은 진행 중이다. 구현 완료와 상세 검증 완료를 하나의 상태로 표시하지 않는다.
