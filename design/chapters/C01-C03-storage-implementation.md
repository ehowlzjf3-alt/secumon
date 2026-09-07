# PostgreSQL 및 Windows 저장 기반 구현 단위

현재 진행은 [checkpoint360 결과](C01-C03-migration-backup-result.md)가 우선한다. 아래는 checkpoint359의 구현·확인 기록이다. 기존 자료 이관/외부 백업은 checkpoint360에서 연결했으며 상세 검증은 하지 않았다.

2026-09-08 · checkpoint359 · 신규 저장 연결 구현·통합 빌드 통과, 상세 검증 대기

C06~C10의 실행 경로 연결과 build2 통과 기록은 보존한다. 이어 남은 C01~C03 저장 기반을 구현한다. 상세 검증을 먼저 확대하지 않고 구현 → 통합 빌드 → 별도 검증 목록 순서로 진행한다.

## PostgreSQL 연결 원칙과 현재 코드

기본은 SQLite이며 문서 개인 기억과 파일 저널 선택도 유지한다. `config.storage.postgres`에는 비밀값 없이 storeId, registrationId, purposes만 둔다. purposes는 state(업무 상태), knowledge(기억), channel(대화·세션) 중 호스트가 선택한다. 나머지 용도는 기존 로컬 설정을 따른다. PostgreSQL 업무 기억과 문서 개인 기억을 함께 선택할 수도 있다.

처음 setup operation과 설정에 선택을 저장하고, 저장소를 열기 전에 `storage-selection.json`으로 고정한다. 설정 제거·다른 등록·연결 누락을 빈 SQLite로 대체하지 않는다. 이미 로컬 자료를 가진 담당은 신규 등록 경로에서 거절한다. 이는 기존 자료 이행을 구현했다는 뜻이 아니다. clone은 새 담당 ID와 새 PostgreSQL 등록 ID를 발급하며 원 담당의 저장소를 자동 공유하지 않는다.

호스트가 Pool을 소유하고 명시적으로 스키마/담당 등록을 준비한다. 일반 `openAgentStores`와 모델·도구는 DDL(테이블 생성·변경)을 실행하지 않는다. 공급자 비밀값과 pool 종료는 호스트에 남고, 코어는 기존 저장 포트를 사용한다. 일반 profile에는 `host.postgres`로 연결한다. 구조적 client interface이므로 pg를 로컬 SQLite 기본 설치의 필수 의존성으로 추가하지 않았다.

각 transaction은 하나의 전용 client를 끝까지 사용한다. 쓰기는 담당/용도 binding row lock으로 직렬화하고, 읽기는 repeatable read snapshot으로 조회한다. 전체 DB나 다른 담당의 모델 실행을 하나의 lock으로 묶지 않는다. 쿼리/잠금 timeout과 client release를 관리하고 COMMIT 응답 불명 뒤 자동 새 명령·재전송을 하지 않는다. [node-postgres transaction 문서](https://node-postgres.com/features/transactions), [PostgreSQL 행 잠금 문서](https://www.postgresql.org/docs/current/sql-select.html).

| 코드 | 구현한 역할 |
|---|---|
| `runtime/src/infrastructure/postgres-store.ts` | 명시 provisioning, 등록 검증, 전용 transaction client, 종료 drain |
| `runtime/src/infrastructure/postgres-state.ts` | 업무·이벤트·전달·명령 영수증·대화 업무 검색, CAS와 중복 명령 |
| `runtime/src/infrastructure/postgres-knowledge.ts` | 담당/개인/업무 기억과 색인·정정·삭제·영수증. 상세는 [기억 구현](C03-postgres-knowledge-implementation.md) |
| `runtime/src/infrastructure/postgres-sessions.ts`, `postgres-channel.ts` | 지속 세션·원문·compact head·요약·전달의 원자 저장. 상세는 [세션 구현](C02-postgres-session-implementation.md) |
| `runtime/src/infrastructure/postgres-board.ts` | 공유 게시판 상태·변경 흐름·쓰기/미적용 영수증 |
| `runtime/src/infrastructure/agent-postgres-storage.ts` | 신규 담당 선택 고정, 명시 등록 준비, 일반 저장소 조합 연결 |
| `runtime/src/presentation/host-board.ts` | `createPostgresHostBoard`, 개인 저장소와 분리된 게시판 등록 |

실제 지원 판정은 별도 검증 후 한다. 현재 소스 작성만으로 SQL 실행·격리·장애 복구가 검증됐다고 하지 않는다.

[PostgreSQL 사용법](C03-postgres-usage.md)과 [호스트 예제](../../runtime/examples/postgres-host.mjs)를 저장했다. 예제는 init → 명시 provision → 일반 open으로 나뉘며 이번 작업에서 실행하지 않았다. [Windows 연결 범위와 잔여](C01-windows-runtime-implementation.md)도 별도로 기록했다.

## 이번 단위에서 실행한 확인

TypeScript build1은 닫는 괄호 누락으로 exit2, build2는 타입 오류 4곳으로 exit2였다. 실제 오류를 교정한 [build3](../../runtime/evidence/C01-C03-storage-build3.log)는 **actual exit0**이다. 최종 소스에서 `tsc`와 기존 build manifest 기록이 완료됐다. PostgreSQL 예제 `node --check`도 exit0이다. 예제 실행·DB 접속 결과가 아니다.

Windows Rust는 기존 소유 sysroot/cache에서 `cargo check --target x86_64-pc-windows-msvc --locked --offline` 한 번을 실행해 exit0을 확인했다. [원결과](../../runtime/native/windows-files/evidence/runtime-implementation-cargo-check.json). DLL 링크/Node 로드/실제 Windows 실행은 하지 않았다. 상세 동작·회귀·장애·플랫폼 시험, 실제 모델/API·사내 서비스·배포는 이번 단위에서 실행하지 않았다. [확정 체크포인트](../../runtime/evidence/C01-C03-storage-implementation-checkpoint.json).

C08/C09의 내부 `peer` 세션은 이미 만들어졌으나 LocalChannel이 cli/web/test만 받던 연결 누락도 수정했다. SQLite와 PostgreSQL local send에 peer를 포함하고 기존 원세션/전달 영수증을 재사용한다. 외부 발신을 추가하지 않았다. Windows 호스트에서 빌드한 `.node` 모듈은 패키지·오프라인 묶음의 지정 경로에 포함할 수 있게 했으며 실제 바이너리 빌드·배포 완료와 구분한다.

## 별도 검증 항목

- 신규 등록 → 같은 지속 세션 재열기 → 다음 업무 → compact → 원근거 재조회 → 답변. SQLite/문서 조합도 포함한다.
- 하나의 실제 PostgreSQL Pool/DB에서 담당 A/B, 사용자 U/V, 세션 X/Y, 같은 work/memory/command ID의 격리.
- 독립 client의 같은 revision/command 경쟁, rollback, COMMIT 직전/직후 응답 유실, 원 영수증 확인, close 대기/실패.
- 개인 기억 즉시 색인·업무 기억 지연 색인, 정정/삭제/재구축 오류, 권한 철회, SQL 정렬/Unicode/JSON 표현 적합성.
- 선택 누락·변조·등록 변경·서버 불통·스키마 버전 차이에서 로컬 fallback 없음, 스키마 일반 조회 자동 생성 없음.
- 공유 게시판 변경 cursor와 원출처 확인, 다중 참여자의 개인 저장소 비공유.
- Windows native addon 링크/Node 로드, ACL·handle·reparse·게시·동시성·종료와 모든 소비자 연결의 실제 Windows 시험.

## 여전히 구현이 필요한 범위

기존 SQLite/파일 자료를 PostgreSQL로 옮기는 복사·검증·전환·재개, 외부 DB snapshot과 로컬 원문을 결합하는 C10 백업/복원은 아직 구현 잔여다. 현재 로컬 lifecycle 경로는 PostgreSQL 선택에서 `lifecycle_external_storage_snapshot_required`로 거절하며 빈 로컬 백업을 전체 백업으로 내보내지 않는다. PostgreSQL 연결은 Windows의 로컬 설정·artifact·workspace 파일 경계를 대신하지 않는다. Windows native 단위의 소비자 잔여는 별도 결과 문서에 기록한다.

실제 모델/API 시험 중단과 실제 사내 MCP·Knox·A2A·배포 미실행을 유지한다. 상세 회귀/장애/플랫폼 시험은 전체 구현 뒤 순서대로 수행한다. C01~C10 전체 goal은 진행 중이다.
