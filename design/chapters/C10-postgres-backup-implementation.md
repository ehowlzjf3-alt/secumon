# PostgreSQL과 로컬 파일의 결합 백업·복원

2026-09-08 구현본. [agent-postgres-backup.ts](../../runtime/src/infrastructure/agent-postgres-backup.ts)는 PostgreSQL 선택 담당의 DB snapshot과 로컬 config/identity/artifact/workspace/세션 자료 파일을 하나의 manifest로 묶는다. 최초 작성 때 실제 DB 접속·백업·복원·빌드·시험은 실행하지 않았다. 이후 checkpoint360에서 관리 호스트 예제와 통합 빌드 연결을 마쳤고, checkpoint362에서 Windows의 동일 복원 후보 재개를 연결했다. [checkpoint360 결과](C01-C03-migration-backup-result.md) · [Windows 관리 연결](C01-windows-administrative-implementation.md). 실제 DB 백업·복원 및 플랫폼 인수는 별도 미검증이며 기존 C05 증거와 실제 배포 상태를 바꾸지 않는다.

공개 호스트 API는 다음과 같다. `host`는 기존 `{ selection, pool }`이고 pool의 수명·인증은 호출자가 소유한다.

```ts
backupAgentPostgres(profiles, directory, destination, host, { offline, operationId })
inspectAgentPostgresBackup(backupDirectory)
restoreAgentPostgresBackup(profiles, backupDirectory, originalDirectory, host, {
  offline, operationId, expectedDigest,
  currentFloor: { agentId, backupDigest },
})
```

checkpoint360~366의 구현 정리 기준으로 [postgres-host.mjs](../../runtime/examples/postgres-host.mjs)의 `backup`/`inspect-backup`/`restore`에서 위 API를 호출할 수 있다. `restore --restore-floor HOST_JSON`은 호스트가 별도로 보관한 복원 허용 기준을 읽는다. 예제는 `SECUMON_POSTGRES_URL`과 호스트가 제공한 `pg` pool을 사용하며 연결 문자열을 명령 인자나 manifest에 넣지 않는다. 관리 입구가 없는 상태는 아니지만 실제 호출·운영 정책 검증은 아직 수행하지 않았다. PG 선택 담당의 엔진 check/pin/update도 checkpoint367에서 [별도 호스트 API](C10-postgres-engine-implementation.md)로 연결했다.

`currentFloor`는 **호스트가 백업과 별도로 보존한 현재 복원 허용 기준**이다. 선택한 백업의 값을 그대로 복사해 넣는 절차는 이 검사를 충족하는 운영 근거가 아니다. expectedDigest는 선택한 원본 백업의 지문이고 currentFloor는 그 백업을 지금 복원해도 된다는 별도 호스트 판단이다. 원 DB가 사라졌다면 백업만으로 그 이후의 잊기·철회·삭제를 입증할 수 없다. 이 모듈은 그 이력을 만들어 내거나 오래된 자료를 최신이라고 표시하지 않는다. 기준을 제공할 수 없으면 복원을 요청하지 않는다.

백업은 로컬 maintenance lease와 선택한 모든 DB binding의 동일 operation maintenance fence를 확보한 뒤 진행한다. 정상 PostgresStore read/write는 이 fence가 있는 동안 거절되며, 관리 snapshot만 자신의 maintenanceId로 접근한다. 기존 직접 DB client나 구형 엔진까지 멈췄다는 `offline:true` 확인은 별도로 필요하다. DB fence가 임의 외부 SQL 계정을 통제하는 것은 아니다.

`exportPostgresAgent`는 선택한 용도 전체를 한 PostgreSQL read transaction의 snapshot으로 읽는다. 그 fence를 유지한 상태에서 로컬 파일을 먼저 복사하고 export 뒤 다시 원본 tree 지문을 확인한다. config의 초기 선택 대신 `effectiveAgentPostgresSelection`을 사용하므로 완료된 이관 overlay도 따른다. 개인 기억 이관 또는 PostgreSQL 이관이 pending이면 거절한다. 이관 operation/activation과 원 snapshot page 파일도 로컬 원본의 일부로 보존한다. runtime lease, maintenance 표식, SQLite의 재생성 가능한 SHM과 이전 복원의 실행 표식만 제외하고 WAL 및 실제 자료는 보존한다.

백업 디렉터리는 새 경로만 허용한다. 구조는 `data/`, `pages/`, 마지막에 게시하는 `backup.json`이다. 페이지는 strict transfer schema와 canonical 논리 digest를 검증하고, 원 파일 bytes/SHA-256도 top manifest에 기록한다. 로컬 파일은 기존 lifecycle stream copy/digest를 사용한다. 소유한 일반 파일만 읽고 symlink·불명 소유·경로 겹침을 거절한다. 원문·자료를 포함한 백업이므로 비공개 디렉터리와 파일로 게시하며 credential/pool 연결 문자열은 manifest에 넣지 않는다.

공용 [postgres-transfer-files.ts](../../runtime/src/infrastructure/postgres-transfer-files.ts)는 별도 migration coordinator에서도 재사용한다.

```ts
writePostgresTransferPage(privateRoot, id, page) // { id, file, bytes, sha256 }
readPostgresTransferPage(privateRoot, id)        // TransferPage
inspectPostgresTransferPage(privateRoot, id)     // { page, file }
```

`page-00000001` 형식의 id만 경로로 사용한다. 기존 파일은 strict 내용과 canonical digest가 같을 때만 재사용·재sync하며 다른 내용은 덮어쓰지 않는다. 페이지 상한은 파일 포장까지 4MiB, 전체 DB transfer는 현재 transfer 모듈의 64MiB 지원 상한이다. 결합 파일 총량 4GiB/개별 로컬 파일 1GiB/항목 100,000개와 top manifest 4MiB 제한도 적용한다. 실제 가능한 항목 수는 manifest 한도로 더 작을 수 있다. 성능 측정값이 아닌 첫 관리 작업의 고정 지원 상한이다. 로컬 복사 버퍼는 1MiB이며 DB 전체를 한 파일 Buffer에 밀어 넣지 않는다. DB import의 자체 bounded row 검증 비용은 transfer 모듈에 남는다.

복원은 동일 agentId, originalRoot, storeId/registrationId/purposes만 허용한다. 대상 DB 등록·스키마는 호스트가 미리 명시적으로 준비해야 하며 이 모듈은 DDL이나 신규 등록을 하지 않는다. import는 대상의 선택 테이블이 비어 있거나, 같은 operation의 동일 snapshot receipt와 실제 데이터가 일치하는 경우만 허용한다. 기존 자료가 있는 DB나 다른 operation을 덮어쓰지 않는다.

로컬 대상은 처음에는 부재해야 한다. `.secumon-restore-in-progress.json`을 먼저 게시한 뒤 파일을 복사하고 PG import를 수행한다. 같은 operation·backup digest의 표식이 있으면 중단 지점에서 재개한다. 복원 중에도 로컬 maintenance lease를 사용한다. 재개할 때는 기존 `recoverAgentLifecycleLeases`의 동일 host·소유 PID 사망 검사를 통과한 stale lease만 정리하며 살아 있는 PID나 다른 host의 lease는 거절한다. 이미 게시된 최종 파일은 해시가 같을 때만 건너뛰며, 없는 파일은 private candidate에 stream 복사·fsync한 뒤 no-overwrite로 게시한다. 이 operation에 속한 정확한 candidate 이름만 정리한다. DB import 뒤 재export로 논리 snapshot을 대조하고 로컬 전체 tree·identity/config·engine pin을 다시 확인한다. 완료 표식 게시와 DB/local fence 해제까지 확인한 뒤 시작 차단 표식을 제거한다. 같은 완료 operation의 재확인도 실제 파일과 DB가 그대로일 때만 허용한다.

DB commit 결과가 불명확하면 DB fence를 무조건 해제하지 않는다. import/maintenance receipt와 현재 상태를 확인해야 하며 같은 operation만 재개한다. 확실한 실패에서는 관리 fence를 정리하되 복원 차단 표식과 미완성 자료는 남겨 자동 실행을 막는다. 백업 작성 중 실패한 디렉터리는 수사 가능한 미완성 결과로 남으며 정식 backup manifest가 없으면 받아들이지 않는다. 새 대상 디렉터리 생성과 첫 표식 게시 사이의 중단처럼 소유 operation을 입증하지 못하는 빈 경로는 자동 채택하지 않는다.

복원 결과는 항상 `recoveryRequired:true`다. 모델 호출, 업무 재시작, 도구 재전송, 외부 효과 취소는 하지 않는다. 일반 runtime의 기존 회복/영수증 경로를 통과한 뒤 새 실행을 결정해야 한다. 엔진 자동 업데이트나 자료 형식의 자동 업그레이드도 하지 않는다.

남은 검증은 연결된 관리 호스트의 실제 호출과 currentFloor 보존 정책, 실제 PostgreSQL 동시성·commit 불명·재접속·권한/TLS, copy/publication/import 각 중단 지점과 같은 operation 재개, 로컬 SQLite/WAL 또는 문서 기억을 함께 쓰는 혼합 배치의 복원 인수다. native Windows 파일 게시·잠금 검증도 독립적으로 남는다. PG 엔진 check/pin/update도 V10-18에서 별도로 검증한다. 이 문서는 제품 API와 관리 입구의 연결을 설명하며 실제 운영 복원 성공의 증거는 아니다.
