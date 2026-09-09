# 실제 PostgreSQL 사용 입구와 인수 실행 조건

2026-09-09 · checkpoint405. SQLite run3와 file-journal run2의 실제 PostgreSQL 정상 경로가 통과했다. 확인 범위와 남은 분기는 [실환경 인수 감사](C10-postgres-real-audit.md)에 구분했다. 실제 모델/API 시험은 중단 상태를 유지한다.

PostgreSQL은 선택한 호스트가 연결하는 저장 방식이다. 에이전트 코어의 기본 SQLite와 파일 저장을 바꾸거나 `pg`를 필수 의존성으로 추가하지 않는다. 선택한 호스트가 PostgreSQL 서버·계정·driver와 접속 설정을 준비하고, `state`, `knowledge`, `channel` 중 사용할 용도를 등록한다. config/identity와 artifact 등 로컬 파일은 PG 선택 후에도 남는다.

일반 사용 입구는 [runtime/examples/postgres-host.mjs](../../runtime/examples/postgres-host.mjs)이며 상세 형식은 [PostgreSQL 호스트 배치 예제](C03-postgres-usage.md)에 있다. 빌드된 runtime에서 다음 도움말로 지원 명령을 확인할 수 있다. 아래는 사용 형식이며 이 문서 작성 중 실행한 명령이 아니다.

```sh
node examples/postgres-host.mjs --help
```

이 예제의 DB 접속 설정은 `SECUMON_POSTGRES_URL`이다. 호스트의 비밀 주입 경로로 공급하며 명령 인수·담당 config·로그에 연결 문자열을 기록하지 않는다. `pg`는 호스트의 별도 package/lockfile에 고정하고 예제의 `import('pg')`가 해석되는 위치에 공급한다. 이번 시험은 PostgreSQL 15.18, Node 24.20.0, 별도 호스트 driver `pg@8.23.0`을 사용했다.

| 작업 | 기존 입구와 조건 |
| --- | --- |
| 신규 담당 | `init`으로 선택 ID·용도를 저장한 뒤 `provision --offline`으로 등록·스키마를 준비한다. |
| 기존 로컬 담당 이관 | `prepare-migration`의 operation ID와 snapshot digest를 보존해 `apply-migration`에 전달한다. 기존 담당을 다시 초기화하지 않는다. |
| 엔진 관리 | `check` → 최초 `pin`; 전환은 `update`에 현재 release digest와 현재 PG+로컬 결합 백업을 전달한다. |
| 백업·복원 | `backup`, `inspect-backup`, `restore`를 사용한다. 복원은 아래 별도 준비 조건을 충족해야 한다. |

`provision`과 `apply-migration`은 명시적으로 DDL을 수행하므로 관리 호스트에 필요한 스키마·테이블 생성 권한이 있어야 한다. 예제는 DB 계정이나 GRANT를 대신 만들지 않는다. 일반 `open`은 DDL이나 업무 실행을 시작하지 않는다.

관리 작업의 `--offline`은 해당 담당을 사용하는 모든 프로세스와 구형 writer·직접 DB client를 중지했다는 호스트의 확인이다. 프로그램이 원격 프로세스를 찾아 종료한다는 뜻은 아니다. local/DB 관리 잠금과 정상 해제를 사용하며, commit 결과가 불명인 경우 오류와 fence를 보존하고 실제 관리 상태를 확인해야 한다.

복원 대상 DB는 같은 agent/store/registration/purpose binding으로 사전 준비하고 해당 binding의 대상 자료는 비워 두어야 한다. 이번에는 원 DB와 별도의 빈 복원 DB를 사용했다. `--restore-floor`는 백업에서 자동 생성한 허가가 아니라, 호스트가 별도로 보관·검토한 현재 복원 기준 파일이다. 현재 계약은 `agentId`, `backupDigest`를 받는다. 오래된 삭제·권한 철회가 복원으로 되살아나지 않는지 판단할 운영 기준까지 이번 합성 자료 인수가 대신하지 않는다.

원 담당·SQLite/WAL·journal·원문·영수증·백업·실패 로그는 보존한다. 복원할 원 경로를 확보할 때도 원 담당을 별도 보존하며 덮어쓰지 않는다. 복원 후 일반 열기는 필요한 host identity rebind와 새로운 reconciliation을 거쳐야 한다. 기존 reconciliation이나 완료 응답을 새 복원의 확인으로 재사용하지 않는다.

이번 증거 harness는 [C10-postgres-real-fixture.mjs](../../runtime/evidence/C10-postgres-real-fixture.mjs)이다. 일반 배포 시작 프로그램과 별개이며, 새 시험 디렉터리와 전용 source/restore DB 쌍으로 backend별 실행한다. 아래 환경값은 모두 실행자가 지정하며 비밀 예시는 포함하지 않는다.

| 환경변수 | 값의 의미 |
| --- | --- |
| `SECUMON_PG_STATE_BACKEND` | 원 로컬 저장소: `sqlite` 또는 `file-journal`. |
| `SECUMON_PG_CASE_ROOT` | 아직 존재하지 않는 절대 경로. runtime과 서로 포함 관계가 없어야 한다. |
| `SECUMON_PG_SOCKET` | 실제 PostgreSQL Unix socket 디렉터리의 절대 경로. |
| `SECUMON_PG_PORT` | 해당 socket 서버의 포트 식별 번호. |
| `SECUMON_PG_USER` | 호스트가 준비한 시험용 DB 사용자. |
| `SECUMON_PG_SOURCE_DATABASE` | 새 시험의 전용 원 DB 이름. |
| `SECUMON_PG_RESTORE_DATABASE` | 원 DB와 다른, 사전 준비할 전용 복원 DB 이름. |
| `SECUMON_PG_HOST_PACKAGE` | `pg`를 해석할 별도 호스트 `package.json`의 절대 경로. |

변수를 공급한 뒤 **격리된 runtime 디렉터리**를 작업 디렉터리로 삼아 실행하는 형식이다.

```sh
node evidence/C10-postgres-real-fixture.mjs
```

harness는 Unix socket과 `ssl:false`를 사용하는 이번 로컬 NAS 인수용이다. 원격 TCP·TLS·사내 인증 환경을 검증한 것으로 확대하지 않는다. 연결할 서버를 자동 시작하지 않으며 기존 성공·실패 case와 사용한 DB를 지우고 같은 시험을 강행하지 않는다.

runtime은 담당 사용자 전용으로 준비한다. 이번 private runtime·case 디렉터리는 `0700`이며, 전체 빌드·guidance·fixtures·package/lockfile·실제 `node_modules` 파일과 해당 OS용 native addon이 필요하다. 의존성 링크만 복사한 불완전한 디렉터리를 실제 설치 bundle로 간주하지 않는다. 기존 설치본을 수정하는 대신 별도 복사본을 사용했다.

초기에는 NAS 홈 경로의 `0777` 권한 때문에 initdb 준비와 엔진 bundle 검사가 각각 거절됐고, runtime 복사에서 빠진 `guidance/` 때문에 업무 준비가 `ENOENT`로 종료됐다. private 복사본과 실제 의존성·누락 파일을 준비한 뒤 다시 실행했다. 이는 제품 검사를 느슨하게 바꿔 해결한 것이 아니며 [실패 기록](C10-postgres-real-progress.md)을 보존했다.

엔진 관리 인수의 `0.1.1-fixture-update.2`는 기존 전체 runtime으로 만든 **시험용 후보 버전**이다. 실제 설치·핀 전환 검증에 사용했지만 출시 버전이나 배포 권고가 아니다.

**현재 이번 PostgreSQL 시험 서버는 종료돼 있다.** 재개할 때는 보존된 경로와 실제 서버 상태를 먼저 확인하고, 필요한 서버를 명시적으로 시작한 뒤 연결한다. 이번 정상 종료는 원본·DB 데이터 디렉터리·백업을 삭제한 것이 아니다.
