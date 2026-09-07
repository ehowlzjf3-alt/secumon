# C03 SQLite rollback journal 명시 회복 계획

2026-09-08. checkpoint364 이후의 **다음 구현 계획**이다. 제품은 아직 수정하지 않았고 DB 회복·시험을 실행하지 않았다. 원 rollback journal로 SQLite가 정상 회복할 수 있고, 회복한 자료의 담당 소유와 지원 스키마를 확인할 수 있는 경우만 대상으로 한다.

기존 C03 관측은 [구현 backlog](../implementation-backlog.json)의 `C01_journal_binding_owner_recovery`에 남아 있다. PostgreSQL 저장·이관 및 Windows 개인 기억 관리 연결과 별개인 잔여 기능이다. 과거 미구현 기록 전체를 다시 구현 대상으로 삼지 않는다.

## 현재 막히는 곳과 재사용할 코드

- [agent-database-owner.ts](../../runtime/src/infrastructure/agent-database-owner.ts)의 `inspectAgentDatabaseOwner`는 읽기 전용 연결에서 실제 owner를 읽는다. SQLite READONLY 계열 오류는 `agent_storage_recovery_required`로 반환한다. 이 분기를 정상 실행에서 읽기·쓰기로 바꾸거나 `bindAgentDatabase`로 owner를 새로 채우면 안 된다. 해당 오류만으로 hot journal 존재를 확정할 수도 없다.
- [agent-lifecycle.ts](../../runtime/src/infrastructure/agent-lifecycle.ts)의 `backupAgent`는 `inspectCompatibility`를 먼저 호출하므로 같은 owner 조회에서 막힌다. [personal-memory-backup-worker.ts](../../runtime/src/infrastructure/personal-memory-backup-worker.ts)도 읽기 전용 source snapshot을 전제로 한다. 두 백업을 그대로 호출해 회복 전 원본 보존이 끝났다고 처리할 수 없다.
- [agent-lifecycle-lease.ts](../../runtime/src/infrastructure/agent-lifecycle-lease.ts)의 `acquireAgentMaintenance`와 `recoverAgentLifecycleLeases`를 재사용한다. runtime lease가 없는 상태와 명시 `--offline`을 요구한다. 이 확인은 구형 엔진과 직접 DB 클라이언트도 운영자가 중지했다는 조건이며, OS의 모든 프로세스 부재를 증명하는 기능은 아니다.
- [agent-lifecycle-files.ts](../../runtime/src/infrastructure/agent-lifecycle-files.ts)의 제한된 파일 목록 캡처·SHA256·`copyLifecycleFile`을 사용한다. 원본 DB를 raw 파일로 읽는 구간에는 SQLite 연결을 모두 닫는다. 현재 한도는 파일 1 GiB, 묶음 4 GiB이며 이 작업은 대상 main/journal과 작은 관리 자료로 범위를 더 제한한다.
- [windows-sqlite.ts](../../runtime/src/infrastructure/windows-sqlite.ts)의 `openHostSqliteDatabase`, 기존 Windows stream/`publishExisting`, POSIX의 백업 no-overwrite 게시 절차를 재사용한다. 새 native 명령이나 별도 잠금 체계를 만들지 않는다.

## 첫 단위의 지원 범위

준비 완료된 담당의 활성 **로컬 SQLite** 저장소 한 개를 명시 선택한다. 종류는 `state | memory | channel`이며 경로는 profile에서 계산한다. 임의 파일 경로나 다른 담당 DB는 받지 않는다. file-journal state, PostgreSQL로 선택·퇴역된 DB, 진행 중인 개인 기억/PG 이관과 복원 작업은 대상이 아니다. documents 개인 기억을 쓰는 담당이라도 로컬 memory DB의 기존 work 자료와 개인 기억 fence는 그대로 보존한다.

첫 단위는 main과 `-journal`이 있는 단일 DB rollback만 지원한다. WAL/SHM가 함께 있거나 ATTACH의 여러 DB·super-journal에 의존하는 경우는 이 명령으로 처리하지 않는다. journal 헤더를 고치거나 삭제해 개설을 강제하지 않는다. 지원 여부를 안전하게 판별할 수 없으면 원본을 보존한 채 중단한다. 일반 조회/시작 중의 owner 오류, schema 오류, 파일 권한 오류가 자동 회복으로 이어지지 않는다.

## 명시 준비와 적용

1. **관리 작업 고정.** 기존 profile identity/config/저장 선택과 호스트 등록을 확인하고 maintenance lease를 잡는다. 동일 `operationId`에 담당 ID, canonical root, 저장 종류, 선택 지문, 원 main/journal의 파일 identity·길이·SHA256·sidecar 목록을 묶는다. DB owner가 아직 읽히지 않는 상태는 ‘담당 소유 DB 확인 완료’로 표시하지 않는다. 사전 파일 소유·경로 검사는 후보를 만들 권한만 확인한다.
2. **원본 보존.** 전용 private operation 디렉터리에 원 main/journal을 같은 basename 관계로 복사하고 목록·bytes·SHA256을 검증한다. 기존 파일을 덮어쓰지 않는다. 복사 후 원 source의 identity와 전체 묶음을 다시 확인한다. 원본 보존 영수증이 durable하게 게시되기 전에는 어떤 SQLite 쓰기 연결도 열지 않는다. 원본 사본은 이후 성공해도 자동 삭제하지 않는다.
3. **후보에서 정상 rollback.** 보존 사본을 직접 열지 않고 별도 후보 묶음을 만든다. 후보만 `openHostSqliteDatabase`의 읽기·쓰기 연결로 열어 실제 schema/owner 조회를 수행하고 SQLite의 정상 journal 처리를 허용한다. 새 owner 바인딩, schema migration, VACUUM, 데이터 행 보정은 하지 않는다. 연결을 닫은 뒤 읽기 전용으로 owner의 agentId/kind, 해당 저장 엔진의 지원 schema와 필요한 테이블·열, `integrity_check`를 검사한다. version 숫자 하나나 무관한 테이블 하나만으로 정상으로 인정하지 않는다. 생성·업그레이드 부작용이 있는 repository 생성자는 검증기로 사용하지 않는다. memory schema3이면 기존 퇴역 fence와 documents 선택의 일치도 유지한다.
4. **검토 가능한 준비 결과.** 모든 후보 연결을 닫은 뒤 회복 후보 main의 bytes·SHA256과 owner/schema 검증 결과를 저장한다. `prepared`는 후보가 확인됐다는 뜻이며 정본 적용 완료가 아니다. 원본과 후보 경로, 원본 묶음 지문, 예상 적용 지문을 관리 출력으로 제공한다. 후보에 미해결 hot journal/WAL가 남았다면 적용할 수 없다.
5. **같은 작업의 명시 적용.** `operationId`와 `expectedPreparedDigest`를 받는다. maintenance 아래 pending 관리 표식을 먼저 게시하고 일반 runtime 및 다른 저장 관리 작업의 진입을 막는다. 원본과 후보 지문을 다시 대조한 뒤 원 main/journal을 operation에 고정된 보존 이름으로 퇴역시키고, 검증한 후보 main을 정본 위치에 no-overwrite 게시한다. Windows는 기존 동일 volume 이동/게시 API, POSIX는 기존 링크·게시·디렉터리 동기화 패턴을 사용한다. journal을 새 main 옆에 남겨 새 후보를 다시 rollback하게 해서는 안 된다. 원본 보존본과 퇴역 파일을 임의 cleanup하지 않는다.
6. **적용 후 확인.** 정본의 정확한 후보 bytes와 읽기 전용 owner/schema를 재확인한 다음에만 별도 완료 영수증을 게시한다. 목표·attempt·명령 영수증·revision을 재생성하지 않는다. journal이 rollback한 미커밋 자료가 사라지는 것은 정상 회복 의미이며, 보존 원본과의 차이를 ‘자료가 전혀 변하지 않음’이라고 설명하지 않는다. 외부 도구의 효과·usage·작업 재개 판단은 기존 runtime reconciliation에 남긴다.

후보 처리에는 기존 개인 기억 backup의 유한 child deadline/종료 관측 패턴을 적용할 수 있다. 원본·정본은 부모만 다루고 child는 후보만 다루게 한다. 독립적인 범용 worker 관리 계층을 새로 만들지 않는다. 용량·실행시간 상한 초과는 완료가 아니라 중단 결과다.

## 중단과 동일 ID 재개

여러 파일을 한 번에 원자적으로 교체한다고 주장하지 않는다. 기존 no-overwrite 관리 영수증 방식으로 `prepared → pending → complete`를 구분하고, pending 중에는 기존 runtime lease를 다시 얻어도 DB를 열지 못하게 한다. `recover-leases`로 죽은 프로세스의 lease를 정리해도 이 pending 표식은 지우지 않는다.

재개는 저장한 원 source/퇴역 파일/후보/정본의 정확한 identity·지문과 게시 단계만 인정한다. 원본 퇴역 전, main만 퇴역, journal까지 퇴역, 후보 게시 후 완료 영수증 전을 구분한다. 정본에 후보가 이미 게시됐다면 다시 rollback하거나 덮어쓰지 않고 검증·완료 기록을 이어간다. 기존 POSIX link 게시 중 두 이름이 같은 inode를 가리키는 경우도 이 작업이 기록한 두 이름·원 identity일 때만 정리한다. 다른 내용, 다른 operation, 손실·권한 변경, 게시 결과 unknown은 추정 복구·새 ID 발급·자동 재시도로 숨기지 않는다.

원인과 close/flush/게시 오류를 함께 보존한다. 완료 영수증 없이 실패했다고 정본 미변경으로 단정하지 않는다. 정상 완료 이후의 상태 조회는 과거 영수증을 보여 주되, 현재 DB가 그 후 정상 업무로 변경됐을 수 있으므로 과거 후보 지문을 현재 DB 지문으로 표시하지 않는다.

## 가장 작은 API와 연결 파일

제안 관리 API는 `prepareAgentSqliteRecovery(profiles, directory, {operationId, kind, offline})`, `applyAgentSqliteRecovery(profiles, directory, {operationId, expectedPreparedDigest, offline})`, `readAgentSqliteRecovery(profiles, directory, operationId)`이다. 읽기 함수는 영수증만 조회하며 DB 개설이나 적용을 실행하지 않는다. 재개는 별도 repair 엔진 없이 같은 apply API와 같은 ID를 사용한다.

- 새 `application/agent-sqlite-recovery-contracts.ts`: 위 입력, 원본/후보 지문, 단계와 영수증의 좁은 strict 계약.
- 새 `infrastructure/agent-sqlite-recovery.ts` 및 필요한 전용 후보 worker: 파일 보존·정상 rollback·검증·게시 조율. owner 검증은 기존 inspector를 재사용하고, schema 검사에 필요한 기존 저장 엔진의 읽기 전용 조건만 분리한다. 일반 repository의 초기화 로직은 호출하지 않는다.
- 기존 `infrastructure/agent-lifecycle-lease.ts`: pending 회복 표식의 공통 진입 차단과 같은 operation의 명시 maintenance 재개만 추가한다. 기존 runtime/maintenance 상호 배제 의미는 유지한다. `agent-stores.ts`에 별도의 자동 회복 분기는 필요 없다.
- 기존 [agent-lifecycle-cli.ts](../../runtime/src/presentation/agent-lifecycle-cli.ts): `sqlite-recovery-prepare`, `sqlite-recovery-apply`, `sqlite-recovery-status`를 기존 명시 관리 입구에 추가한다. `agent repair`는 setup 복구 의미를 유지한다. 모델 tool, Web 일반 요청, 원문 입력에서 회복 옵션을 받지 않는다.

## 지원 한계와 이후 검증

손상 DB salvage, 잃어버린 journal 재구성, foreign owner 채택, 임의 schema 보정, WAL/다중 DB 트랜잭션 복구는 이번 구현 범위가 아니다. 새로운 네트워크 서비스·SQLite 확장 로딩·외부 모델 호출도 없다. Windows는 기존 ABI의 process-crash 내구성 계약을 사용하며 전원 장애 내구성과 실제 Windows 동작 확인을 동일시하지 않는다.

구현 후 좁게 확인할 항목은 실제 소유 DB의 rollback fixture(state/memory/channel), foreign/missing owner와 지원하지 않는 schema 거절, 경로·sidecar 교체 및 source 변경, 원본 보존 SHA 불변, 단계별 강제 종료 뒤 동일 ID 재개, pending에서 runtime/다른 관리 명령 진입 차단, journal 동반 없는 후보 게시, timeout/close/unknown 게시 결과 보존이다. 기존 lifecycle backup/restore, 일반 owner read-only 오류, 문서 개인 기억 fence와 PG 선택 거절 회귀도 함께 선정한다. 현재 이 문서는 해당 시험의 성공이나 제품 구현 완료를 주장하지 않는다.
