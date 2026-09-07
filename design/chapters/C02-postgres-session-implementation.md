# C02 PostgreSQL 지속 세션·전달 정본 구현

2026-09-08. 구현 초안이며 실제 PostgreSQL 접속·시험·배포 통과 기록이 아니다.

`PostgresSessionRepository(store)`는 기존 SessionRepository 전체 포트를 구현한다. 같은 담당/tenant/principal의 route alias 열기, 명시 session 재개, 원문 inbox의 정확한 재전송과 정산, 권한에 따른 이력 페이지, 현재/retained head, 요약 publication과 CAS·이전 요약 참조를 보존한다. 기존 SessionService/SessionCompactor가 저장소 위에서 수행하는 원문 인용, summary manifest, 모델 수신·사용량·현재성 검증은 그대로 재사용한다. PostgreSQL adapter가 요약 내용을 새로 생성하거나 원문 검증을 대신하지 않는다.

공통 `PostgresStore`의 read는 repeatable-read/read-only 트랜잭션, write는 바인딩 행을 잠그는 트랜잭션이다. 모든 데이터 테이블과 조회는 `store_id, agent_id`로 시작하고 그 뒤 tenant/principal/session을 제한한다. 매 동작의 등록/스키마 검사는 공통 Store가 수행한다. bigint 반환값은 공통 safe-integer 검사로 해석하며 JSON은 기존 schema로 검증하는 TEXT 정본이다. 기존 SQLite 자료나 cursor를 PostgreSQL로 자동 이관하지 않는다. PostgreSQL 이력 cursor는 저장소 바인딩·scope·정책·조회 범위를 별도로 고정한다.

`PostgresChannel(store)`는 LocalChannel과 같은 send/recordConfirmedDelivery/lookup/messages/close 표면과 `sessions`를 제공한다. confirmed delivery의 저장 영수증과 assistant session entry/sequence 갱신은 한 `store.write`의 동일 client를 사용한다. 세션 helper 안에서 새 트랜잭션을 열지 않는다. 동일 전달 ID의 내용 충돌은 rollback 후 unknown이고, COMMIT 결과 불명은 자동 재시도하지 않는다. 재접속 후 원 ID의 lookup으로 대조해야 한다. 원문/전달이 없는 상태를 성공으로 만들어 내지 않는다. close는 공통 Store의 진행 중 작업 정리를 기다리며 호스트 pool 자체 소유권은 가져오지 않는다.

명시 설치 경로는 `provisionPostgresStore(pool, channelBinding, POSTGRES_CHANNEL_SCHEMA)`이다. `POSTGRES_CHANNEL_SCHEMA`는 새 `postgres-channel-schema.ts`의 고정 DDL이며 `postgres-channel.ts`에서도 export한다. constructor/일반 read는 CREATE TABLE이나 자동 migration을 실행하지 않는다. channel purpose가 아닌 Store는 생성 시 거절한다. 호스트 profile/CLI 조립과 credential/pool 공급은 별도 root 작업이다.

작성 파일: `runtime/src/infrastructure/postgres-sessions.ts`, `postgres-channel.ts`, `postgres-channel-schema.ts`. 기존 SQLite/LocalChannel/포트/프로필은 이 하위 작업에서 변경하지 않았다.

남은 검증: 실제 PostgreSQL DDL·driver 타입과 transaction 격리, 담당/tenant/principal 간 차단, 동시 inbox/summary CAS, 전달 commit 경계의 중단·재접속, policy 변화 중 이력/compact 원문 검증, SQLite와 같은 의미의 회귀 및 현장 운영 복원. 실제 모델·DB 호출/상호운용을 검증했다는 주장은 하지 않는다. `messages`는 기존 LocalChannel 계약대로 해당 대화 전체를 반환하므로 대규모 사용자 화면의 별도 pagination은 후속이다.
