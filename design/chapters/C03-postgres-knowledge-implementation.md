# PostgreSQL 기억 저장소 구현

2026-09-08 구현본이다. [PostgresKnowledgeRepository](../../runtime/src/infrastructure/postgres-knowledge.ts)는 기존 `KnowledgeRepository`의 get/receipt/commit/indexHead/candidates/rebuildIndex/markIndexError/close를 모두 구현한다. 아직 통합 빌드·시험·실제 PostgreSQL 연결을 실행하지 않았다. 구현된 메서드와 실제 DB에서 확인한 동작을 구분한다.

## 등록과 저장 범위

호스트가 공통 [PostgresStore](../../runtime/src/infrastructure/postgres-store.ts)를 `purpose:'knowledge'`로 열어 생성자에 전달한다. 어댑터 생성자는 SQL·DDL·네트워크 연결을 수행하지 않는다. `POSTGRES_KNOWLEDGE_SCHEMA`는 명시 provisioning에서만 실행하는 테이블/색인 SQL 배열이다. 같은 DB에 다음 담당을 등록할 수 있도록 DDL은 `IF NOT EXISTS`를 사용하지만, 기존 SQLite/document 자료 복사나 손상된 DB를 새 정본으로 대체하는 경로는 없다.

테이블은 `secumon_pg.knowledge_records`, `knowledge_heads`, `knowledge_receipts`, `knowledge_index`이며 키의 선두는 항상 store_id/agent_id/tenant_id/partition/principal_id다. 어댑터 조회·갱신은 고정된 store_id와 agent_id를 `$1`, `$2`로 전달한다. 개인 기억은 principal_id까지 구분하고 `KnowledgeRecord`의 owner/author/namespace/scope/private 속성을 다시 검사한다. scope 생략은 이 담당의 work 파티션이며 개인 기억을 생략된 scope로 쓰면 거절한다. 다른 담당의 scope와 기존 unscoped SQLite 형식은 받지 않는다.

공통 store가 읽기 트랜잭션의 repeatable-read snapshot과 쓰기 트랜잭션의 등록 행 잠금, 등록 ID·schema 확인, 연결 정리와 commit 불확실성 처리를 담당한다. 어댑터의 close는 store.close에 위임하고 호스트 Pool을 종료하지 않는다.

## 기존 기억 의미의 재사용

[knowledge-contracts.ts](../../runtime/src/application/knowledge-contracts.ts)의 `parseKnowledge`를 그대로 사용한다. [SQLite 어댑터](../../runtime/src/infrastructure/sqlite-knowledge.ts)와 같이 동일 명령 ID·digest는 원 revision의 duplicate, 다른 digest는 idempotency_conflict, expectedRevision 불일치는 conflict다. record/명령 영수증/namespace head와 개인 색인 갱신을 하나의 쓰기 transaction에 넣는다. namespace·scope·author·createdAt 고정, updatedAt/contentRevision 전이, 비활성 tombstone의 active 재전환 금지를 유지한다. 영수증에는 기존 개인 출처 audit 형태도 기록한다.

개인 기억은 commit에서 active 색인을 갱신하고 retracted/deleted 항목을 제거한다. 기존 head가 준비 상태였을 때만 cursor가 revision을 따라간다. 업무 기억은 기존 지연 색인 동작을 유지하여 rebuild 전에 head revision과 cursor가 다를 수 있다. 조회만으로 기억을 등록하거나 archive 자료를 복사하지 않는다.

후보 검색은 tenant·namespace·scope·author/공유/검토 권한·labels·kind·문자열을 SQL로 제한하고 최대 201개 ID만 받는다. 이는 최종 읽기 권한·만료·출처 현재성 검증을 대체하지 않으며 그 검사는 기존 KnowledgeService에서 계속 수행한다. 검색 문서는 기존 NFC 및 en-US 소문자 정규화를 유지하고, ID 순서는 `C` collation으로 고정한다. PostgreSQL JSON 연산과 `ON CONFLICT` 문법은 공식 문서를 대조했다. [JSON 연산](https://www.postgresql.org/docs/current/functions-json.html), [INSERT/ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html), [collation](https://www.postgresql.org/docs/current/collation.html).

## 재구축과 실패

재구축은 namespace 전체 5,000건 상한을 유지하며 본문은 64건씩 읽는다. 같은 writer transaction 안에서 기존 색인을 교체하고 cursor/error를 갱신한다. 재구축 중 검증·SQL 오류가 발생하면 savepoint까지 되돌려 기존 색인을 보존하고 `index_capacity_exceeded` 또는 `index_rebuild_failed`를 head에 기록한다. 오류 기록 자체가 실패하면 두 원인을 AggregateError로 보존한다. 바깥 COMMIT 결과가 불확실하면 별도 오류 기록 write나 자동 재시도를 시작하지 않는다.

revision/cursor/count의 PostgreSQL bigint 반환값은 안전한 비음수 정수인지 확인한다. DB가 반환한 record JSON과 행의 id/namespace/revision도 대조한다. JSON 본문은 text로 보관하며 로컬에서 임의로 자르거나 다른 문자로 바꾸지 않는다. PostgreSQL text/JSON 연산이 표현하지 못하는 문자열이나 깨진 행은 원 DB/검증 오류로 거절된다. 이 입력 범위에 대한 실제 conformance는 아직 확인하지 않았다.

## 남은 확인

저장소 인터페이스에 빈 메서드나 임시 성공 반환은 없다. 실제 DB의 provisioning·두 담당/두 principal 분리·중복/CAS·forget·색인 오류/복구·commit/연결 종료 실패는 아직 미검증이다. 기존 SQLite/document 전환·백업/이행은 이 어댑터가 구현하지 않으며, 호스트 등록/프로필 선택과는 별도 작업이다. 이 문서의 구현 기록을 PostgreSQL 운영·이행 완료 또는 C03 전체 완료 증거로 사용하지 않는다.
