# PostgreSQL 이동 스냅샷 구현

2026-09-08 현재 구현한 범위는 PostgreSQL과 로컬 SQLite/file-journal의 논리 원자료 내보내기, 그리고 명시적으로 준비한 PostgreSQL 대상으로 가져오기다. 실제 PostgreSQL 연결, 빌드와 시험은 이 작업에서 실행하지 않았다. PostgreSQL에서 SQLite/file-journal 대상으로 되돌리는 import는 아직 구현하지 않았으며, 아래 API가 그 기능까지 제공하는 것으로 해석하면 안 된다.

`runtime/src/infrastructure/postgres-transfer.ts`는 `TransferPageSchema`, `TransferManifestSchema`, `validateTransferManifest`, `transferPageDigest`와 세 함수를 공개한다.

- `exportPostgresAgent(pool, bindings, writePage, { maintenanceId? })`
- `importPostgresAgent(pool, targetBindings, manifest, readPage, { operationId, maintenanceId? })`
- `exportLocalAgent(profile, writePage, { purposes? })`. 로컬 목적 기본값은 state, knowledge, channel이다.

페이지 writer는 `(id, page)`, reader는 `(id)`를 받는다. manifest의 목적 목록, 원 binding, 선택적인 sourceKinds, 순서가 고정된 페이지 ID·행 수·지문 전체를 canonical JSON SHA256으로 묶는다. manifest의 digest 필드 자체만 계산에서 제외한다. `validateTransferManifest`는 파싱뿐 아니라 지문, 중복 목적, 모든 목적의 고정 테이블 목록과 페이지 순서도 확인하고 값을 반환한다. SQL 식별자는 별도 `postgres-transfer-tables.ts`의 22개 테이블과 열 목록에서만 나온다. 이동 페이지에서 store_id/agent_id는 제외하며, 원 agentId를 변경하지 않는 대상 binding이 두 키를 붙인다. tenant/partition/principal/session 키는 원 행에 남는다.

한 페이지는 최대 128행·JSON 4MiB, 전체 페이지 JSON은 64MiB, 페이지 수는 65,536개로 제한한다. 원 행 하나가 페이지 한도를 넘으면 나누거나 자르지 않고 거절한다. 가져오기는 읽은 페이지를 이 한도 안에서 보유한다. 이것은 직렬화 크기 제한이며 프로세스 메모리·물리 디스크 사용량 상한을 뜻하지 않는다. 원문 artifact 파일, 문서형 개인기억, workspace와 profile 파일은 이 SQL 페이지에 넣지 않으며 상위 이동/백업 절차가 함께 보존해야 한다.

PostgreSQL 내보내기는 하나의 repeatable-read read-only 트랜잭션에서 등록/schema/maintenance를 확인하고 각 테이블을 cursor로 읽는다. 모든 자료 SELECT와 INSERT는 고정 store/agent에 귀속된다. 보존 대상에는 work의 현재 revision과 전체 명령 영수증, 사건·delivery·대화 인덱스, 업무/개인 기억의 tombstone과 index cursor/error, session 원문·head·summary·publication, 게시판 자료가 포함된다. JSON을 담은 TEXT 열은 다시 직렬화하지 않는다. 따라서 SQL 내부 원문의 공백과 순서도 유지된다. bigint 값은 안전한 정수 범위에서만 codec 숫자로 변환한다.

가져오기는 사전에 명시적으로 provisioning된 schema와 binding만 사용한다. 한 write 트랜잭션에서 모든 binding을 잠그고 모든 대상 테이블이 비었는지 먼저 확인한 뒤 원 revision 행을 직접 넣는다. 새 work를 revision 0부터 재실행하지 않는다. 완료 영수증은 전체 snapshot digest와 목적을 `secumon_pg.transfers`에 같은 트랜잭션으로 저장한다. 동일 operation 재개는 영수증의 지문뿐 아니라 현재 대상 전체 행도 원 페이지와 대조한다. 일부 영수증만 있거나 행이 바뀌면 거절한다. COMMIT 결과가 불명확하면 공통 `postgres_commit_outcome_unknown`을 유지하며 자동 반복하지 않는다.

channel의 local_messages identity sequence는 원 순서를 그대로 넣고 이후 새 메시지가 앞에 끼지 않도록 증가시킨다. 이때 해당 테이블의 짧은 쓰기 잠금이 다른 agent의 채널 쓰기도 기다리게 할 수 있다. PostgreSQL sequence 자체는 트랜잭션 롤백으로 되돌아가지 않으므로 실패 시 번호 간격이 남을 수 있다. 자료 행과 완료 영수증은 같은 트랜잭션 경계를 유지한다.

로컬 내보내기는 호출 프로세스 소유의 기존 lifecycle maintenance barrier와 runtime lease 0을 확인한다. 상위 절차는 다른 엔진과 직접 DB 사용자를 포함한 offline 조건을 먼저 확보해야 한다. SQLite는 readOnly BEGIN의 같은 handle에서 owner와 현재 schema를 확인하고 iterator로 열을 읽는다. main/sidecar 안전성 및 main 파일 identity를 재확인하며, schema 변경이나 journal recovery를 자동 수행하지 않는다. SQLite가 요구하는 WAL 조정 sidecar와 순수 파일 복사의 문제는 상위 원본 스냅샷 절차에서도 따로 다뤄야 한다. 파일이 없으면 빈 데이터라고 가정하지 않고 source_missing으로 거절한다. owner만 있는 초기화된 빈 DB는 빈 테이블 페이지를 내보낼 수 있다.

file-journal은 header/owner, 연속 revision, 원 command ID/digest, checksum과 previousHash, 기존 `validateCommit`·`validateStateTransition`을 확인한다. 읽은 명령으로 최종 state와 각 시점의 영수증, 사건 sequence, delivery와 대화 인덱스를 계산해 SQL 열에 대응한다. 저장 엔진의 commit API를 호출하거나 원 revision을 새로 부여하지 않는다. 종료 전에 같은 디렉터리 목록과 실제 원문 SHA256을 다시 확인한다. 남은 pending 파일이나 연속성이 깨진 체인은 자동 복구하지 않고 거절한다. journal의 바깥 파일 포장과 바이트 단위 백업은 상위 파일 보존 절차에 남는다.

문서형 개인기억 선택은 그대로 둔다. SQLite schema 3이면 기존 개인기억 migration fence를 같은 handle에서 검사하며, 업무 partition만 SQL 페이지에 넣는다. 기존 retired personal 행은 복사하지 않는다. schema 2의 문서 선택도 SQL 개인기억을 제외한다. 문서 파일을 읽어 새 SQL 개인기억으로 등록하거나 archive 자료를 자동 복사하는 동작은 없다.

C10 PostgreSQL 백업은 `transfers`의 과거 이동 영수증을 자료 페이지에 복사하지 않는다. 업무의 state_receipts/knowledge_receipts/board_receipts는 보존하고, 복원 작업 자체에는 새 operation ID와 백업 snapshot digest를 묶은 별도 import 영수증을 만든다. 같은 복원 ID로 재개하면 이 영수증과 대상 전체 행을 대조한다. `transfers`를 재export에서 제외하므로 복원 직후 새 영수증이 추가되어도 자료 스냅샷 지문은 바뀌지 않는다. 현재 백업 입구는 미완료 migration을 거절하고 완료 activation/operation 파일을 함께 보존하며, 일반 runtime open은 과거 migration 영수증을 요구하지 않는다. 따라서 과거 영수증 미복사는 C10 복원이나 일반 업무 재개를 막는 필수 연결 누락이 아니다. 다만 복원 뒤 과거 migration의 apply 관리 명령을 다시 호출하면 해당 과거 영수증이 없어 거절될 수 있다. 이 관리 명령의 재호출 및 복원 중단 후 동일 ID 재개는 상세 검증 항목으로 남긴다.

다음 검증에서는 실제 PostgreSQL의 cursor/identity 처리, 여러 purpose의 일관 스냅샷, 바인딩 혼합 거절, 마지막 COMMIT 연결 단절, 같은 operation 재개와 대상 변경, SQLite/file-journal 간 동일 원문·revision·영수증·summary 유지, 문서 선택의 retired personal 제외, 큰 행/전체 한도, source 교체와 cleanup 실패를 확인해야 한다. 현재는 구현 상태이며 해당 검증 통과나 PostgreSQL 운영 배포를 주장하지 않는다.
