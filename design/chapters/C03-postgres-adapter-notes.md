# C03 PostgreSQL 어댑터 검토 메모

2026-09-07 · 현재 코드 읽기와 후속 구현 제안 · 제품 변경·DB 연결·외부 네트워크·시험 실행 없음

**개인/업무 기억의 `KnowledgeRepository`부터 PostgreSQL을 연결하고, 실행 상태와 채널·세션은 후속 단위로 이어가는 방향을 권한다.** PostgreSQL이 명시적으로 등록되지 않은 담당은 기존 SQLite를 사용한다. 이미 등록·배정된 PostgreSQL에 장애가 생겼을 때 SQLite나 문서 폴더를 새 정본으로 만들지 않는다. 여기서 정본은 수정·삭제·버전 판정의 기준이 되는 저장 자료다.

이 문서는 구현 순서를 제안한다. C03 개인 기억 소스의 NAS 통합 검증은 루트 작업에서 별도로 진행 중이며 그 결과를 이 문서에서 앞당겨 확정하지 않는다. 현재 source pin과 제품·시험·스크립트는 변경하지 않았다. 실제 PostgreSQL 동작, 실제 모델 품질, native Windows 실행을 검증한 문서도 아니다.

## 1. 현재 코드에서 확인한 경계

| 저장 용도 | 현재 계약과 연결 | 재사용할 부분 / 실제 공백 |
|---|---|---|
| 개인·업무 기억 | `KnowledgeRepository`: get, receipt, commit, indexHead, candidates, rebuildIndex, markIndexError, close가 모두 Promise. SQLite에는 담당 전용/명시 공유 모드와 work/personal 구획이 있다. | 같은 포트와 `KnowledgeService`의 출처·권한·정정·잊기 검증을 재사용한다. PostgreSQL 구현은 없다. |
| 실행 복구 상태 | `StateRepository`: 상태·사건·outbox 의도·명령 영수증을 한 commit에 넣는다. SQLite와 파일 저널이 구현한다. | 저장 불변조건은 재사용한다. PostgreSQL의 CAS·경합·결과 불명 복구와 공유 담당 범위는 새 구현/검증이다. |
| 대화 원문·세션·compact | `SessionRepository`는 입력 receipt, 순서 있는 history, 적용 상태와 고정 prefix/head를 다룬다. `SessionSummaryRepository`는 요약·이전 prefix·게시 receipt를 다룬다. | 원문 검증과 요약의 게시/채택 구분을 유지한다. 실제 구현은 `SqliteSessionRepository`이며 `LocalChannel`과 같은 연결을 쓴다. |
| 채널의 로컬 전달 기록 | `LocalChannel`은 `MessageSink`의 send/lookup 외에 표면용 messages를 제공한다. 로컬 전달과 assistant 세션 entry를 같은 SQLite transaction으로 저장한다. | 단순 SQL 치환으로 나눌 수 없다. PostgreSQL 전환 시 두 기록의 원자적 게시를 함께 보존해야 한다. 외부 Knox 전달 성공과 DB commit은 별개다. |
| 큰 원본·작업 파일 | `ArtifactStore`는 비동기 바이트/논리 참조 포트이고, C01은 파일 artifact와 파일 workspace를 연결한다. | 기억 DB를 바꿔도 원본을 PostgreSQL에 전량 복사하지 않는다. 소유 범위와 참조가 유효한 기존 원본 제공자를 사용한다. |
| 게시판·아카이브 | 게시판에는 별도 `BoardRepository`가 있고 C01 features는 기본 비활성이다. 아카이브의 배치별 조회/등록 연결은 C07 범위다. | 개인 기억과 같은 DB에 있어야 하는 조건은 없다. 첫 PostgreSQL 기억 단위에 게시판·아카이브까지 만들지 않는다. |

현재 [C01 설정 계약](../../runtime/src/application/agent-profile-contracts.ts)은 schemaVersion 1이며 `storage.state`에 sqlite/file-journal, `storage.memory`에 sqlite만 허용한다. artifacts는 files다. [저장소 조합](../../runtime/src/infrastructure/agent-stores.ts)은 memory와 channel의 로컬 owner를 확인한 뒤 `SqliteKnowledgeRepository`와 `LocalChannel`을 직접 생성한다. `knowledge` 변수와 [로컬 표면 조합](../../runtime/src/presentation/local-profile.ts)의 repository 매개변수도 구체 SQLite 타입이다. 이 부분을 `KnowledgeRepository`로 받게 하는 것은 필요하지만 코어 전체를 다시 추상화할 이유는 없다.

[상태 방식 고정](../../runtime/src/infrastructure/agent-state-profile.ts)은 `.secumon/state-profile.json`에 최초 state backend를 고정하고, 이후 설정과 다르면 거절한다. 이 표식은 **상태 저장 방식의 배정**이며 원격 기억 등록 표식이 아니다. 현재는 이 검사 안에서도 memory/channel의 로컬 SQLite 소유를 확인하므로, 기억만 원격으로 옮길 때 그 검사를 선택된 용도에 맞게 조정해야 한다.

[설치 CLI](../../runtime/src/presentation/agent-cli.ts)의 init/status/repair/clone에는 PostgreSQL 등록·연결 검증·자료 이행 명령이 없다. init은 로컬 기본 저장소를 연다. [업무 CLI](../../runtime/src/presentation/cli.ts)의 `--state-backend`는 별도 로컬 예제 경로의 sqlite/file-journal 선택이고 C01 담당 디렉터리 옵션과 함께 쓸 수 없다. 이를 PostgreSQL 등록으로 해석하면 안 된다. [package.json](../../runtime/package.json)에도 PostgreSQL client 의존성은 없다.

## 2. 왜 기억부터 시작하는가

첫 목표는 **같은 담당에서 “기억해” → 재시작 → 새 대화 회상 → 실제 입력 packet → 정정·잊기**가 PostgreSQL 기억 정본에서도 유지되는 것이다. 기존 C03 서비스·선택·현재성 검사와 CLI/Web 흐름을 그대로 통과시킬 수 있고, DB 변경이 필요한 범위는 기억 트랜잭션과 호스트 등록/조합으로 제한된다.

반면 state부터 시작하면 모든 실행 명령·예약·사용량·outbox·강제 종료 복구를 다시 검증해야 한다. channel/session부터 시작하면 입력 접수와 applied 상태, 전달 기록과 assistant entry, 요약 receipt와 accepted 호출 상태까지 C02 경계를 함께 다뤄야 한다. 두 저장소가 같은 PostgreSQL 서버에 있다는 이유만으로 기존 독립 포트 호출들이 한 transaction이 되는 것도 아니다.

따라서 권장 순서는 다음과 같다.

1. **기억:** 등록된 PostgreSQL `KnowledgeRepository`를 C01과 실제 C03 사용자 흐름에 연결한다. 개인/업무 구획과 기존 Evidence 기억 계약을 함께 지킨다. SQLite 기본값을 유지한다.
2. **실행 상태:** 필요 배치가 확인되면 `StateRepository`를 추가한다. 상태·사건·영수증·outbox의 원자적 commit과 실행 복구를 끝낸다.
3. **채널·세션:** 로컬 전달 기록과 세션 원문/요약 저장을 한 구현 단위로 연결한다. 현재의 전달+assistant entry 원자성을 보존하고, state와의 분리된 접수/적용·요약 게시/채택 복구도 검증한다.
4. **선택 저장소:** 게시판·아카이브·큰 원본의 공급자는 각각 C07/C10의 실제 배치 요구에 맞춘다. 메모리 어댑터를 범용 DB 관리 계층으로 키우지 않는다.

이 순서는 세 포트를 반드시 모두 PostgreSQL로 바꾸라는 뜻이 아니다. [전체 계획](../03-migration-plan.md)의 문서 기억 → PostgreSQL 등록/적합성 범위도 유지한다. 문서 기억 어댑터와 PostgreSQL 어댑터는 같은 기억 계약에 대한 별도 구현이며, PostgreSQL용 ORM·SQL helper를 문서 어댑터의 선행 조건으로 만들지 않는다.

**다중 호스트 상주 담당이 바로 필요하면 순서를 다시 좁혀 정해야 한다.** 공유 PostgreSQL에 기억만 있다고 다른 호스트에서 해당 출처의 로컬 session/state/artifact까지 조회할 수 있는 것은 아니다. 원문 제공자가 없으면 현재성 검증은 실패해야 한다. 메모리 단위의 완료를 분산 담당의 이동·인계·복원 완료로 표시하지 않는다. 원문을 모두 개인 기억에 복사하거나 검증을 생략해 이 공백을 메우지 않는다.

## 3. 등록과 기본값: 용도별로 하나의 정본만

후속 설정에는 backend 이름 외에 **호스트가 등록한 저장소 참조**가 필요하다. 논리 storeId, 용도(memory 등), 허용 담당/조직 범위, 연결 자격증명 참조, 저장 schema/호환 버전이 등록에 속한다. DB 비밀번호나 임의 SQL/search_path를 모델·기억 카드·채팅 인자로 받지 않는다. 비밀 값은 config 출력이나 diagnostic에 넣지 않고 호스트의 설정 경계에서 해석한다. 구체 드라이버와 TLS 옵션은 실제 대상이 정해진 구현 때 확인한다.

| 상황 | 제안 동작 |
|---|---|
| 새 담당, PostgreSQL 선택/등록 없음 | SQLite 기본으로 초기화하고 이후 같은 배정을 재사용한다. |
| 등록은 있으나 이 담당의 memory 배정 없음 | 자동 전환하지 않는다. 기존 SQLite 정본을 사용하거나 명시 배정을 기다린다. |
| 신규 담당이 등록된 PostgreSQL memory를 명시 선택 | 저장소 식별·버전·담당 등록을 먼저 확인하고 memory 배정을 고정한 뒤 연다. 해당 담당의 빈 로컬 memory DB를 대체 정본으로 만들지 않는다. |
| 기존 SQLite 담당이 설정만 PostgreSQL로 바꿈 | 이행 필요 오류. 다른 정본을 새로 열어 기존 기억이 사라진 것처럼 보이게 하지 않는다. |
| PostgreSQL 배정 뒤 timeout/인증 오류/등록 소실 | 사용할 수 없음 또는 결과 불명을 구분한다. get의 null/검색 빈 결과로 바꾸거나 SQLite로 자동 전환하지 않는다. |
| DB나 namespace가 사라졌는데 로컬 배정 표식은 남음 | 단순 첫 실행으로 간주해 원격 정본을 다시 생성하지 않는다. 생성 의도/완료 receipt 또는 복원 자료로 판단한다. |
| clone으로 새 agentId 생성 | 원본 담당의 원격 partition과 기억을 자동 공유하지 않는다. 신규 담당 등록·새 배정이 필요하다. 연결 profile 이름을 복사하더라도 사용 권한을 복사한 것이 아니다. |

기존 config v1은 그대로 읽되 새 저장 선택은 버전 있는 계약으로 추가하는 방안이 적합하다. 구버전 엔진이 새 설정을 잘못 이해해 SQLite를 열지 않게 명시 거절한다. state/memory/channel의 배정을 용도별로 고정하고 backend·storeId 변경은 명시 이행 경로만 허용한다. 이것은 기존 C01 방식 고정의 확장이며 새 전역 저장 프레임워크가 아니다.

프로필 파일 검사/생성과 원격 연결 검증은 구분한다. `status`의 파일 조회만으로 원격 health를 통과한 것처럼 표시하지 않는다. 등록/연결 검사 명령은 비동기 작업임을 명시하고 제한 시간·실패 이유를 반환한다. 현재 `repair`는 누락된 설정을 복구하는 범위이므로 PostgreSQL 데이터 복원 명령으로 재활용하지 않는다.

## 4. 공유 PostgreSQL에서 유지할 계약

기억의 논리 키는 기존 SQLite 구획을 따른다. 개인 기억은 `tenantId + agentId + partition=personal + principalId + memoryId`, 업무 기억은 `tenantId + agentId + partition=work + memoryId`다. 업무 기억의 author/공유·검토 정책은 기존 의미를 유지한다. principalId를 업무 구획에 기계적으로 추가해 공유 의미를 바꾸지 않는다.

- 호스트가 발급한 어댑터 handle에 agentId/storeId를 고정한다. 호출별 tenant와 개인 principal도 인증된 서비스가 전달한다. get뿐 아니라 receipt, commit, index head/cursor, candidates, 재색인, cache key에 같은 범위를 적용한다.
- body의 owner/tenant/id/revision과 SQL 키를 서로 확인한다. id/commandId가 같아도 다른 담당·사용자의 row를 조회하거나 충돌시키지 않는다. 등록을 확인할 수 없으면 거절하며 row 내용이나 임의 도구 인자로 담당을 등록하지 않는다.
- 개인 기억의 현재 row, scoped 명령 receipt, 검색 문서와 head/cursor 갱신을 한 DB transaction으로 커밋한다. 잊기 시 활성 row 본문/quote와 검색 문서는 제거하고, 중복 명령/삭제 상태의 최소 metadata는 보존한다. 과거 대화·백업의 물리 삭제와 구분한다.
- 같은 commandId/digest는 최초 결과를 반환하고 다른 digest는 충돌이다. 다른 명령의 오래된 expectedRevision은 CAS 충돌이다. DB 경합에서 승자가 하나라는 사실을 실제 독립 연결로 검증한다. 기존 SQLite의 `BEGIN IMMEDIATE`를 PostgreSQL SQL로 그대로 복사하지 않는다.
- commit 전 확실한 거절과 commit 응답 유실을 구분한다. 후자는 scoped receipt 대조가 필요하며 실패를 “미기록”으로 추정해 새 commandId를 발급하지 않는다. 연결 재수립·transaction 재시도는 같은 명령 identity 안에서 제한한다. rollback/close 실패로 첫 원인을 덮지 않는다.
- 문자열 JSON 원본, receipt digest, sourceVersion과 revision은 이행 중 그대로 유지한다. JSONB 등 검색용 표현을 추가하더라도 원본의 bytes/기존 hash 의미를 임의 재작성하지 않는다. 숫자는 현재 안전한 정수 한도를 검증한다.
- 검색 결과는 후보이며 `KnowledgeService`가 정본과 사용자 receipt/Evidence 출처를 다시 확인한다. 첫 어댑터는 현재 문자열 검색·정렬·상한·truncated·index lag 의미를 보존한다. 전문 검색/임베딩을 필수로 넣지 않는다.
- SQL 조건과 scoped handle이 기본 경계다. DB 역할/RLS를 추가하더라도 애플리케이션 범위 검증을 삭제하지 않는다. pool의 이전 요청 설정이 다음 tenant 요청에 남지 않는지 확인한다. 테이블/schema 이름이나 search_path를 담당 정체성으로 대신하지 않는다.

현재 [SQLite 기억 구현](../../runtime/src/infrastructure/sqlite-knowledge.ts)과 [소유·공유 등록](../../runtime/src/infrastructure/sqlite-knowledge-owner.ts)을 의미상의 기준으로 사용한다. 실제 PostgreSQL의 SQL·잠금·타입 변환·검색 정렬이 동일하다고 가정하지 않는다. 스키마 생성/업그레이드는 일반 read handle의 임의 동작이 아닌 명시적 등록·이행 단계에 둔다.

## 5. 이행과 원본 복원은 첫 사용의 문턱

빈 신규 PostgreSQL 저장소에 연결하는 기능과 기존 담당의 자료를 옮기는 기능을 분리해 표시한다. 기존 담당 사용까지 지원하려면 다음 한 흐름을 끝내야 한다.

1. 쓰기 주체를 멈추거나 이행 대상으로 고정하고, source owner/배정/schema와 source head를 확인한다. 모델·도구 재호출을 이행 수단으로 사용하지 않는다.
2. 기억의 canonical row, scoped receipt와 tombstone, revision/head를 복사한다. 검색 문서는 재생성 가능하나 지연/오류 상태를 성공으로 오표시하지 않는다. 기존 업무 기억 JSON과 개인 기억 구획을 구분한다.
3. 출처의 SessionScope/messageId/digest와 state/evidence/artifact 참조가 대상 배치에서도 검증 가능한지 확인한다. **memory export만으로 대화 원문이 복원됐다고 하지 않는다.** 원문을 계속 로컬에 둘 경우 그 담당과 연결 경로를 유지하고, 새 호스트로 옮길 경우 필요한 원본/상태의 복원 계획이 별도로 있어야 한다.
4. 대상의 소유 범위·개수·digest·receipt·삭제 상태와 실제 get/search/선택 문맥을 검증한다. 기억에 없는 원문을 재구성해 넣지 않는다.
5. 목표 storeId/schema와 이행 operationId를 가진 완료 증거를 남기고 용도 배정을 전환한다. 중단 재호출은 같은 대상/operation을 대조하며 source와 target에 동시에 쓰지 않는다. 실패한 이행 자료와 원본을 자동 삭제하지 않는다.

cross-store 원자 transaction을 전제하지 않는다. 복사 중 실패, 대상 commit 뒤 응답 유실, 배정 표식 전후 중단을 각각 재개할 수 있어야 한다. 새 target에서 쓰기를 받은 뒤 old source로 단순 되돌리면 그 쓰기를 잃을 수 있으므로 자동 롤백으로 처리하지 않는다. 엔진 버전 되돌리기와 데이터 복원은 다른 작업이다.

**hot journal gate는 유지한다.** 현재 [SQLite owner 검사](../../runtime/src/infrastructure/agent-database-owner.ts)는 소유 조회 전에 복구가 필요한 경우 `agent_storage_recovery_required`로 거절한다. [C01 저널 연결 결과](C01-file-journal-binding-result.md)의 이 경계를 PostgreSQL 이행 도중 우회하지 않는다. 출처를 확인하지 못한 DB를 writable로 열거나 owner 표식을 다시 발급하지 않고 DB/sidecar 원본을 보존한다. 정식 복원은 신뢰할 수 있는 백업·담당 식별·manifest로 복원 대상을 확정한 뒤 격리된 복사본에서 수행하고, 확인할 근거가 없으면 진행하지 않는다. 원본 DB만 복사하고 필요한 WAL/journal을 버리는 식의 백업을 허용하지 않는다.

복원 시 과거의 잊기·접근 철회가 되살아나지 않게 삭제/정정 ledger와 원문 정책의 현재 기준을 대조한다. 검증되지 않은 구버전 기억은 검색·모델 문맥에 공개하지 않는다. 최신 삭제 증거까지 함께 잃었다면 과거 백업만으로 최신 상태를 증명할 수 없다는 제한을 기록한다. [C10 운영 복원](../03-migration-plan.md)의 복원 목표·보존·실제 장애 시험은 별도로 남긴다.

## 6. 비동기 client와 Windows 경계

기존 기억/상태/세션 포트는 이미 Promise이므로 PostgreSQL의 비동기 client를 인프라 어댑터 안에 둘 수 있다. 연결 pool·query 제한 시간·오류 변환·close는 호스트 조합에서 소유한다. 코어에 DB 연결 객체나 SQL/transaction callback을 전달하지 않는다. 동기 constructor 안에서 네트워크 완료를 억지로 기다리거나 `Atomics.wait`로 query를 구현하지 않는다. 현재 `openAgentStores()`가 async이므로 비동기 연결 조립 지점으로 재사용할 수 있다.

어댑터의 async transaction에서는 각 query가 완료되기 전에 commit/release하지 않는다. 여러 요청의 transaction이 같은 client에 섞이지 않아야 한다. 종료·취소 시 이미 보낸 commit의 결과를 “취소되어 미반영”으로 단정하지 않으며, pending 작업과 자원 해제를 별도로 정리한다. 현재 포트에 AbortSignal이 없는 메서드도 있으므로 첫 구현에서는 명시된 드라이버 timeout/close 동작과 결과 불명 의미부터 고정한다. 전 포트의 취소 인자를 일괄 추가하지 않는다.

PostgreSQL 연결 성공은 Windows 전체 지원의 증거가 아니다. C01 설정·identity·배정 표식, 파일 artifact/workspace에는 로컬 파일 경계가 남는다. [현재 Windows 선행 구현](C01-windows-native-progress.md)은 독립 addon의 대상 컴파일과 macOS 검사이며 실제 Windows 실행·TS 런타임 연결은 미완료다. POSIX 검사를 Windows 권한 검사로 대체하거나 PostgreSQL 선택만으로 기존 Windows 거절을 해제하지 않는다.

후속 Windows 연결에서 native 파일 핸들을 비동기 DB await 전후로 유지해야 한다면 실제 소유 수명을 명시하고 finally에서 정리해야 한다. 동기 callback의 끝에서 닫힌 핸들이 비동기 작업까지 보호한다고 가정하지 않는다. 반대로 DB query 자체를 Rust 파일 addon으로 옮길 필요도 없다. 실제 Windows에서는 driver 설치/연결/중단 복구와 로컬 프로필 파일 경계를 함께 시험해야 한다.

## 7. 구현·인수 순서와 실제 PostgreSQL 없는 시험의 한계

첫 단위는 새 helper 수를 늘리는 대신 **등록부터 사용자 흐름까지** 완료한다.

1. 호스트의 명시 등록·용도 배정·config 호환·미등록 기본값을 추가하고 memory 조합의 구체 SQLite 타입만 포트로 바꾼다. 새 PostgreSQL driver 의존성은 이 단계에서 범위를 정해 추가한다.
2. `KnowledgeRepository` PostgreSQL 구현에 scoped CRUD/receipt/CAS/검색과 close를 연결한다. 기존 서비스·선택·모델/도구 사용량 수명은 재작성하지 않는다.
3. 같은 CLI/Web 기억 동작을 신규 등록 담당에서 끝내고, 기존 SQLite 담당의 명시 이행·재개와 원문 연결을 검증한다. “연결 설정 저장”만으로 DB 사용 가능 판정을 내리지 않는다.
4. 아래 실패·격리·현재성 검증을 같은 소스 pin에서 수행하고, 실제 관측 비용과 미검증 범위를 기록한다. 통과하지 않은 저장 용도는 지원 목록에 넣지 않는다.

| 인수 대상 | 재사용할 시험 의미 | 추가로 필요한 PostgreSQL 관측 |
|---|---|---|
| 기억 적합성 | [개인 저장 계약](../../runtime/src/tests/sqlite-personal-knowledge.test.ts), [공통 fixture](../../runtime/src/tests/personal-knowledge-storage-helpers.ts)의 범위/receipt/정정/삭제/이행 | 독립 실제 DB 연결의 같은 revision·같은 command 경쟁, rollback, commit 응답 유실 후 receipt 확인, schema/등록 불일치 |
| 담당·사용자 격리 | 같은 id/command를 A/B 담당·U/V 사용자에서 사용; scoped get/search/head/receipt/current와 위조 owner 거절 | 하나의 pool과 같은 DB에서 요청을 번갈아 실행하고 이전 요청의 권한/transaction 상태가 남지 않음 |
| 실제 기억 사용 | [문맥](../../runtime/src/tests/personal-memory-context.test.ts), [출처 서비스](../../runtime/src/tests/personal-knowledge-service.test.ts), [CLI/Web](../../runtime/src/tests/personal-memory-presentation.test.ts)의 같은 X→Y 흐름 | PostgreSQL에서 받은 기억이 실제 packet에 포함됨. 정정·잊기·원문 철회·재시작·늦은 합성 reply에서 이전 revision이 채택되지 않음 |
| 기본값·장애 | 미등록 SQLite 유지, 고정 backend 불일치 거절 | 등록된 PG 불통에서 빈 로컬 memory 생성/기억 없음 응답/자동 schema 재생성이 없음. 실패 후 같은 배정으로 재개 |
| 이행·복원 | 원 JSON/hash/receipt/owner/삭제 보존과 hot journal 원본 보존 gate | source/target 쓰기 분기 없음, 중단 단계별 재개, 원문 참조 검증, 구버전 reader 거절, 복원 뒤 잊기 재적용 |
| 자원·비용 | 모델/도구 가짜 호출 없이 기억 사용; 현재성 검사 유지 | pool 대기·query 수·반환 bytes·source state/receipt 조회 수·전체 지연·timeout/close 누락을 구분해 측정 |

PostgreSQL 서버 없이 작성하는 fake client/SQL forwarding 시험은 호출 순서·오류 매핑·fallback 금지·자원 정리 의도를 확인할 수 있다. **실제 PostgreSQL 적합성 통과가 아니다.** SQL 문법/타입·검색 순서·격리·동시성·서버 commit·권한·TLS·연결 중단·백업 복원은 실제 지원 버전의 서버에서 따로 확인해야 한다. unavailable 환경에서 시험을 skip했다면 skip으로 기록하며 SQLite 통과로 대체하지 않는다.

실제 서버 검증이 열리기 전에는 “선택 가능한 미검증 어댑터”와 “운영 지원”을 구분한다. 실제 모델/API는 이 저장소 검증의 선행 조건이 아니며 중단을 유지한다. 합성 planner로 원문·선택·사용량·취소 경계는 시험할 수 있지만 자연어 기억 선별 품질이나 토큰 절감률은 이 문서의 결과가 아니다.

## 8. 이번 검토가 바꾸지 않은 것

제품/시험/스크립트와 C03 NAS source pin, 전체 계획/백로그는 수정하지 않았다. PostgreSQL 서버 등록·접속·드라이버 설치·새 정본 생성·기존 자료 이행을 수행하지 않았다. 이 메모는 C03/C10에 남은 저장 어댑터 순서를 결정하기 위한 근거이며 C01·C02·C03 또는 전체 goal 완료 표시가 아니다.

계약 참고: [저장소·복구 설계](../16-storage-and-recovery.md), [개인 기억 계획](C03-personal-memory-plan.md), [KnowledgeRepository](../../runtime/src/application/knowledge-ports.ts), [StateRepository/ArtifactStore/MessageSink](../../runtime/src/application/ports.ts), [SessionRepository](../../runtime/src/application/session-ports.ts), [요약 저장](../../runtime/src/application/session-compact-ports.ts), [LocalChannel](../../runtime/src/infrastructure/local-channel.ts), [SqliteSessionRepository](../../runtime/src/infrastructure/sqlite-sessions.ts).
