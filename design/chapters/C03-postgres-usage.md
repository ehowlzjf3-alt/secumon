# PostgreSQL 호스트 배치 예제

2026-09-08 갱신. [postgres-host.mjs](../../runtime/examples/postgres-host.mjs)는 신규 담당의 PostgreSQL 선택·provisioning·일반 열기와 기존 로컬 담당의 이관, PostgreSQL+로컬 파일 결합 백업·복원, 엔진 호환 검사·버전 고정·전환 API를 연결한다. 예제 소스와 호스트 API의 연결 상태이며, 이 문서 작성 과정에서는 driver 설치·명령 실행·DB 연결·시험을 수행하지 않았다. 서버 적합성이나 운영 배치 완료를 뜻하지 않는다.

빌드된 runtime과 `package.json`의 Node.js 범위(`>=24.20.0 <25`)가 필요하다. 예제는 `runtime/examples/`에서 `../dist/`를 import한다. 배포용 시작 프로그램으로 옮길 때는 설치한 엔진의 실제 경로에 맞춘다. 담당 디렉터리는 엔진과 겹치지 않는 경로에 두고 상위 디렉터리를 먼저 준비한다.

`pg`는 runtime core의 필수 의존성에 추가하지 않았다. 호스트 프로젝트가 검토한 driver 버전을 자신의 manifest/lockfile로 고정하고, 이 예제에서 `import('pg')`가 해석되는 위치에 공급한다. PostgreSQL 서버와 접속 계정 역시 호스트가 준비한다. 아래 명령은 배치 형식이며 실행 기록이 아니다.

```sh
# runtime 디렉터리에서 실행하는 형식. 두 UUID는 해당 배치의 고정 ID로 정한다.
node examples/postgres-host.mjs init \
  --directory /srv/secumon-agents/research \
  --store-id 3a302327-5c0f-4a4a-baf7-14c5c4f8e235 \
  --registration-id 9ddba8fc-16c0-4ae4-b2a5-d8bba19330c6 \
  --purposes state,knowledge,channel

# 호스트의 비밀 주입 경로로 SECUMON_POSTGRES_URL을 설정한 뒤 실행한다.
# 해당 담당을 사용하는 모든 프로세스를 먼저 종료한다.
node examples/postgres-host.mjs provision \
  --directory /srv/secumon-agents/research --offline

node examples/postgres-host.mjs open --directory /srv/secumon-agents/research
```

`init`은 `FileAgentProfileStore.initialize(directory, { postgres: selection })`으로 로컬 identity/config를 만든다. 비밀 값이나 연결 문자열을 config에 저장하지 않는다. `storeId`, `registrationId`, `purposes`는 비밀이 아닌 배정 값이다. 반복 초기화에도 같은 값을 사용하며, 기존 담당의 선택을 명령으로 덮어쓰지 않는다.

`provision --offline`은 `provisionAgentPostgresStorage(profiles, directory, { selection, pool }, true)`를 호출한다. 저장된 유효 selection을 읽고 로컬 배정 표식·maintenance lease와 DB 등록/스키마를 확인한 뒤 선택한 용도의 DDL을 수행한다. 아래 `apply-migration`도 명시적 DDL 경로를 포함하며, 일반 `open`은 DDL을 수행하지 않는다. `--offline`은 운영자가 구형 엔진과 직접 DB client를 포함한 해당 담당 사용자를 모두 중지했다는 확인이다. 원격 실행기를 찾아 자동 종료하는 기능은 아니다. 관리 계정에는 필요한 스키마/테이블 생성 권한이 있어야 하며 실제 실행 계정 권한은 배치 담당자가 별도로 설정한다. 예제는 DB role/GRANT를 만들지 않는다.

`open`이 기본 명령이다. 먼저 ready config를 요구하고 `effectiveAgentPostgresSelection`으로 초기 config 또는 검증된 activation overlay의 선택을 읽는다. 동일 selection/pool을 `{ postgres: { selection, pool } }`로 `openAgentTurnProfile`에 전달하며 pending 이관은 거절한다. PostgreSQL 일반 열기/read는 DDL이나 자동 migration을 수행하지 않는다. 로컬 담당 표식 확인·동기화와 수명 lease는 기존 프로필 경로를 사용하므로 전체 파일시스템의 무쓰기 status 명령은 아니다. 예제는 명시적 합성 provider를 선택해 프로필만 열고 닫는다. 업무 접수·모델 호출·도구 호출을 하지 않는다. 실제 CLI/Web 배치에는 같은 host 객체를 해당 진입점에 공급하고 필요한 모델·도구 등록을 추가한다.

| `purposes` 선택 | 실제 저장 범위 |
| --- | --- |
| `state` | 업무 상태, 명령 영수증과 이력 |
| `knowledge` | 업무 근거 기억과 개인 기억의 scoped 저장소·영수증·검색 색인 |
| `channel` | 로컬 채널 전달과 지속 세션의 원문·이력·head·summary |

선택하지 않은 용도는 기존 로컬 설정을 따른다. PostgreSQL을 모두 선택해도 config/identity와 artifact/workspace 파일은 담당 디렉터리에 남는다. config의 기존 `storage.state` 값만 보고 실제 상태 저장소를 판단하지 말고 유효 selection의 purposes를 확인한다. 이관은 초기 config/setup을 덮어쓰지 않고 activation overlay로 선택을 전환한다.

기존 로컬 담당은 `init`으로 선택을 바꾸지 않고 다음 두 관리 단계를 사용한다. `/srv/secumon-agents/existing`은 앞의 신규 담당과 별개인 기존 SQLite/file-journal 담당 경로다. `SNAPSHOT_SHA256`은 prepare 결과의 snapshotDigest를 검토해 설정한 값이다.

```sh
node examples/postgres-host.mjs prepare-migration \
  --directory /srv/secumon-agents/existing \
  --store-id 04ccbd89-bdbc-4bd2-a7e4-a4a8e7e00bab \
  --registration-id c048a39c-7ec8-49a6-b33d-5704d802d50a \
  --operation-id 1571547c-cc9c-413c-8c96-9c34fe331d05 --offline

node examples/postgres-host.mjs apply-migration \
  --directory /srv/secumon-agents/existing \
  --operation-id 1571547c-cc9c-413c-8c96-9c34fe331d05 \
  --digest "$SNAPSHOT_SHA256" --offline
```

`prepare-migration`은 기존 owner/schema/영수증을 검증해 제한된 원본 페이지와 pending operation을 로컬에 보존한다. PostgreSQL에는 접속하지 않는다. `apply-migration`은 같은 operation·snapshot digest로 명시 provisioning, 대상 import, 원 저장소 retirement와 activation을 수행한다. 원문·revision·영수증을 새 업무 실행으로 재생성하지 않는다. 선택한 대상의 기존 자료를 덮어쓰지 않으며 미완료 import의 같은 operation 재개는 원 영수증과 실제 대상 자료를 다시 확인한다. 이미 activation이 끝난 관리 명령의 재호출은 원 이관 영수증을 확인하고 자료를 다시 import하지 않는다. 실패했다고 다른 operation ID로 바꿔 강행하거나 원 SQLite/WAL 파일을 지우지 않는다. 문서형 개인 기억은 그대로 유지하며 이미 retired된 개인 행을 SQL로 부활시키지 않는다. 세부 범위와 지원 한도는 [transfer 구현](C03-postgres-transfer-implementation.md)과 [이관 coordinator](../../runtime/src/infrastructure/agent-postgres-migration.ts)에 있다.

결합 백업과 복원은 다음 명시 명령으로 연결되어 있다. 백업 대상의 상위 디렉터리는 미리 준비하고, `BACKUP_SHA256`은 검토한 backupDigest로 설정한다.

```sh
node examples/postgres-host.mjs backup \
  --directory /srv/secumon-agents/research \
  --destination /srv/secumon-backups/research-20260908 \
  --operation-id ef0482d3-4e58-465c-9030-ee9411c804d2 --offline

node examples/postgres-host.mjs inspect-backup \
  --source /srv/secumon-backups/research-20260908

# 아래 복원은 원 경로가 부재하고 DB 대상이 사전 준비된 별도 복원 상황의 형식이다.
node examples/postgres-host.mjs restore \
  --directory /srv/secumon-agents/research \
  --source /srv/secumon-backups/research-20260908 \
  --operation-id d5d6c823-c3fc-4eb3-a1fc-f361beedfb55 \
  --digest "$BACKUP_SHA256" \
  --restore-floor /srv/secumon-host-policy/research-restore-floor.json --offline
```

`backup`은 동일 관리 잠금 아래 선택한 PG 용도의 한 snapshot과 로컬 자료 파일을 묶고 manifest를 마지막에 게시한다. `inspect-backup`은 로컬 백업의 원문/hash/manifest를 검증하며 PG 연결 없이 식별 정보와 지문만 출력한다. 일반 C10 로컬 백업 명령이 외부 DB까지 자동 보존하는 것은 아니므로 이 결합 API를 명시적으로 사용한다.

`restore`는 **원래 agentId·절대 경로·DB 배정**을 유지한다. 최초 대상 디렉터리는 부재해야 하며, 대상 PostgreSQL에는 같은 binding/schema가 미리 provisioning되어 있어야 한다. 대상 자료 테이블은 비어 있거나 같은 복원 operation의 동일 snapshot이어야 한다. 복원 명령은 대상 스키마를 만들지 않으며, 예제의 `provision`도 ready 담당을 요구하므로 원 경로가 사라진 DB 사전 준비 전체를 대신하지 않는다. 호스트가 별도로 대상 등록을 준비한 뒤 복원을 호출한다. 기존 디렉터리/DB를 덮어쓰지 않고, 중단된 정확한 marker가 있으면 같은 operation ID로 재개한다. 복원 표식이 남은 동안 일반 open은 차단된다.

`--restore-floor`는 백업 밖에서 호스트가 별도로 보존한 비공개 JSON 파일이다. 형식은 `{ "agentId": "담당 UUID", "backupDigest": "현재 복원 허용 지문" }`이며, 백업 내용을 복사해 이 파일을 만드는 절차가 아니다. `--digest`가 선택한 백업의 내용을 지문으로 고정하고 floor가 그 백업을 지금 복원해도 되는지 제한한다. 원 DB가 없으면 백업만으로 이후의 잊기·철회·삭제를 입증할 수 없다. 복원은 외부 효과를 되돌리지 않고 `recoveryRequired:true`로 기존 회복 절차를 요구한다. 상세 수명·한도·불명 commit·stale lease 경계는 [C10 PostgreSQL 결합 백업·복원 구현](C10-postgres-backup-implementation.md)을 따른다.

호스트는 Pool에 연결 5초, query 35초, 서버 statement 30초 제한과 idle 오류 listener를 둔다. 저장 어댑터의 transaction은 기존 statement 30초/lock 5초 제한을 적용한다. 이는 초기 배치값이며 처리량이나 전체 작업의 종료 시간을 보장하는 측정치는 아니다. `pool.connect()`에서 얻은 한 client의 query/release를 구조적 `PostgresPool` 인터페이스로 전달하므로 transaction 안에서 임의 `pool.query()`로 연결을 바꾸지 않는다. `profile.close()`가 runtime과 저장소를 정리한 뒤 호스트가 `pool.end()`를 호출한다. 오류 시에도 원 오류와 정리 오류는 호출자에게 보존하고, 직접 실행하는 예제의 stderr에는 비밀을 포함할 수 있는 driver 원문을 출력하지 않는다. Pool 수명·idle 오류·client 반환 계약은 [node-postgres Pool 공식 문서](https://node-postgres.com/apis/pool)를 따른다.

연결 문자열은 `SECUMON_POSTGRES_URL`에서만 읽으며 명령 인자·config·출력에 넣지 않는다. TLS와 인증 설정은 해당 driver/서버 정책에 맞춰 호스트가 공급한다. 예제는 TLS 검증을 끄지 않으며 비밀 배포·인증서 관리 자체를 구현하지 않는다. 연결·query timeout 설정은 [node-postgres Client 공식 계약](https://node-postgres.com/apis/client)을 참고한다. `init`, `prepare-migration`, `inspect-backup`에는 PostgreSQL 연결 환경변수나 pg 모듈이 필요하지 않다.

등록·스키마 불일치나 DB 연결 실패는 실패로 반환한다. 선택된 PostgreSQL이 없다고 빈 SQLite로 전환하지 않는다. write의 `postgres_commit_outcome_unknown`은 자동 재전송하지 않으며 원 command 영수증/상태를 확인하는 기존 복구 경로가 필요하다. 프로필 열기만으로 미확인 효과를 성공으로 확정하거나 업무를 다시 실행하지 않는다.

PostgreSQL 담당의 엔진 전환은 다음 호스트 명령을 사용한다. `check`는 선택된 DB와 혼합 로컬 저장소의 실제 버전을 확인한다. `pin`은 최초 버전 고정, `update`는 현재 버전 지문과 최신 결합 백업을 확인한 전환이다. 셋 모두 담당 사용자를 중지한 상태에서 로컬·DB 관리 잠금을 사용한다. 업무나 모델을 실행하는 명령이 아니다.

```sh
node examples/postgres-host.mjs check \
  --directory /srv/secumon-agents/research --engine /opt/secumon/releases/next \
  --operation-id bbfe7b95-e70e-4ffb-b913-7432ae1bf909 --offline

# 최초 고정. 이미 고정한 담당은 아래 update를 사용한다.
node examples/postgres-host.mjs pin \
  --directory /srv/secumon-agents/research --engine /opt/secumon/releases/current \
  --operation-id a6c794ee-ab54-43de-b52e-e27cb71a4ce4 --offline

# 위 backup 명령으로 현재 버전의 결합 백업을 만든 후 실행하는 형식.
node examples/postgres-host.mjs update \
  --directory /srv/secumon-agents/research --engine /opt/secumon/releases/next \
  --previous "$CURRENT_RELEASE_SHA256" --backup /srv/secumon-backups/research-20260908 \
  --operation-id 184d40fa-588d-4f12-b5b4-804f894d94de --offline
```

`CURRENT_RELEASE_SHA256`은 현재 pin의 `releaseDigest`다. PostgreSQL 지원 버전을 선언한 설치 묶음만 선택할 수 있으며, 선언이 없는 과거 묶음은 PG 담당의 전환 대상으로 거절한다. 업데이트 직전에는 백업의 로컬 원문과 DB snapshot을 현재 자료와 대조한다. 자료가 바뀌었으면 새 결합 백업이 필요하다. 엔진 고정 기록과 저장 자료의 복원은 별개이며 이 명령은 DB 형식 이관이나 실행 중 프로세스 교체를 수행하지 않는다. 실제 서버에서의 동작은 [후속 V10-18 검증](C06-C10-verification-plan.md)에 남겨두었다.

아직 남은 범위는 다음과 같다.

- **이관의 실제 인수:** 관리 API와 예제 연결은 구현됐다. 원문·영수증·소유/세대·head·문서 선택의 보존, 원본 변경/retirement/activation 사이의 중단과 같은 operation 재개는 실제 저장소에서 검증해야 한다.
- **운영 백업·복원:** 결합 snapshot/파일 보관과 복원 API는 구현됐다. 외부 floor의 지속 보관·승인 기준, 대상 DB 사전 준비, 여러 purpose/로컬 파일의 동시성, copy/import/commit 불명 후 재개와 삭제 이력 보존의 실제 운영 인수는 남아 있다. 새 `storeId` 발급은 기존 자료 복원이 아니다.
- **실제 서버와 플랫폼 검증:** PostgreSQL 문법/driver/격리/동시 CAS·전달 원자성·중단 복구·권한/TLS는 지원 서버에서 별도 검증해야 한다. PostgreSQL 사용이 native Windows의 로컬 파일 경계 지원을 완성하지 않는다. 모델 품질·실제 모델 API도 이 예제 범위에 포함하지 않는다.

구현 근거: [호스트 등록·provisioning](../../runtime/src/infrastructure/agent-postgres-storage.ts), [공통 PostgreSQL transaction](../../runtime/src/infrastructure/postgres-store.ts), [저장소 선택 조립](../../runtime/src/infrastructure/agent-stores.ts), [기억 어댑터](C03-postgres-knowledge-implementation.md), [지속 세션·전달 어댑터](C02-postgres-session-implementation.md).
