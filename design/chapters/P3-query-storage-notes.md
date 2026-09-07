# P3-02 저장소 조회 경계와 비용 메모

이 문서는 긴 이력 조회 보완의 저장소 측 구현과 검증 범위를 설명한다. 제품 소스와 신규 회귀 시험은 저장했고 `npm run typecheck`는 통과했다. 빌드와 시험 실행 결과는 루트 작업에서 별도로 확정한다. 실제 모델, MCP, Knox, 외부 시스템 호출은 수행하지 않았다.

## 공통 조회 포트

`StateRepository.recentEventMetadata(workId, { throughRevision, limit })`는 지정한 상태 revision 이하의 최근 사건을 sequence 오름차순으로 반환한다. `items`의 필드는 `sequence`, `revision`, `type`, `at`뿐이며 `omittedCount`는 생략된 사건 수다. limit은 1–50이다. 데이터 payload, command 본문, 과거 WorkState를 반환하지 않는다. 이는 공개 허가가 아니라 내부 조회 포트이며, 화면 서비스가 현재 소유권·수신 경로·공개 정책을 검증해야 한다.

`StateRepository.conversationWorkPage({ tenantId, principalId, channel, conversationId, cursor?, limit })`는 `workIds`와 `nextCursor`를 반환한다. limit은 1–20이다. cursor는 adapter 및 조회 경로에 결합된 진행 위치이며 권한 증명이 아니다. 잘못된 cursor, 다른 adapter나 경로의 cursor는 `invalid_state_query`로 거절한다. 페이지 순서는 각 adapter에서 안정적으로 유지하되 adapter 간 동일 정렬은 계약에 포함하지 않는다. BMP/비 BMP 문자 ID가 섞여도 각 adapter에서 중복·누락 없이 진행해야 한다.

Journal 페이지는 정렬된 SHA-256 업무 디렉터리에서 최대 limit개 후보를 검사한다. 타 tenant/principal의 업무 또는 빈 디렉터리만 있는 페이지는 `workIds=[]`이고 `nextCursor`가 남을 수 있다. 호출자는 이를 종료로 오해하거나 빈 페이지를 모두 자동 탐색해서는 안 된다. 페이지를 읽은 뒤 새로 삽입된, 진행 위치보다 앞선 업무는 현재 순회에 추가되지 않을 수 있으므로 목록 새로 고침으로 발견한다. 기존 전체 목록/사건 API는 호환을 위해 유지한다.

## SQLite

기존 v1 정본 테이블을 보존하고 `BEGIN IMMEDIATE` 안에서 v3로 이동한다. 이번 구현 도중의 v2 DB도 v3로 이행하며, 정본을 다시 검사해 파생 색인을 재구축하고 알려진 조회 trigger를 교체한다. `event_metadata`는 사건의 작은 메타데이터를, `conversation_work`는 현재 소유자와 일치하는 대화 연결을 색인한다. 기존 자료는 스키마 검사 후 보충하며 오류가 있으면 테이블 생성·색인 변경·버전 변경을 모두 롤백한다. 이미 v3인 DB는 파생 색인을 다시 구축하지 않는다.

새 조회 SQL은 이벤트나 업무의 JSON body를 선택하지 않는다. 사건 tail은 revision/sequence 인덱스로 위치를 찾고 최대 limit개 metadata row를 읽는다. 대화 페이지는 binding 인덱스에서 최대 limit+1개의 ID를 선택한다. LIMIT은 반환 row와 body 해석을 제한하며 SQLite 내부 B-tree 페이지 방문 수나 실제 디스크 읽기량의 상한이라는 뜻은 아니다.

정본 `works`/`events`의 INSERT·UPDATE·DELETE trigger가 파생 색인을 같은 트랜잭션에서 갱신한다. 이로써 migration 전에 이미 열려 있던 구버전 연결이 기존 방식으로 commit해도 색인이 함께 갱신된다. 구버전 writer 자체를 차단했다고 주장하지 않는다. DB 파일을 직접 수정할 수 있는 주체에 대한 파일 무결성 방어를 새로 제공하는 변경도 아니다.

## File journal

Journal의 기록 포맷이나 권위 원본은 바꾸지 않는다. Cold read는 전체 record를 읽어 JSON/schema/checksum/hash chain/상태 전이를 검증하고 projection을 재구성한다. Warm read도 모든 기존 record의 본문을 다시 읽고 raw digest를 계산한다. 같은 bytes와 현재 파일 안전성 검사가 확인된 prefix에 대해서만 이전에 검증한 projection을 재사용한다. 외부 writer가 추가한 새 record는 schema/chain/전이를 확인해 이어서 반영한다.

따라서 warm read에서 줄어드는 것은 JSON 해석, schema 검증, 전이 검증, 이전 사건·receipt·delivery projection 재생이다. Warm physical read/hash 비용은 여전히 O(선택된 업무의 전체 이력 bytes)이며 stat만 확인한 cache hit는 사용하지 않는다. SHA-256 디렉터리 목록 열거와 관측 디렉터리 identity 확인은 여전히 O(전체 업무 디렉터리 수)이다. 새 페이지가 줄이는 것은 이력을 재생할 업무 수이며, 한 페이지에서는 최대 limit개 업무만 읽는다.

Root/work 디렉터리 identity·owner·mode, record nofollow/owner/mode, 읽기 전후 file metadata, store identity와 directory fsync fence는 cache hit에도 확인한다. 캐시에 남아 있는 record는 inode 교체도 거절한다. 해당 projection이 퇴출되면 record inode 기록도 함께 해제되므로 이후 같은 bytes의 inode 교체까지 영구적으로 거절한다는 보장은 하지 않는다. Cache 밖에서도 본문/checksum/chain 검증을 수행한다.

읽는 도중 정상 writer가 임시 hardlink를 정리해 ctime이 달라지는 경우에는 본문과 metadata 전체를 한 번 다시 읽는다. 재시도에서도 파일이 계속 바뀌면 거절한다. inode·권한 검사를 건너뛰지 않으며 안정적으로 읽힌 bytes도 cache digest 또는 전체 record checksum/chain 검증을 거친다.

관측한 업무 head revision/hash는 별도로 보존하여 이미 본 tail 삭제를 감지한다. 지연된 과거 commit ACK가 더 최신 head를 낮출 수 없도록 단조 증가시킨다. Head와 업무 디렉터리 bookkeeping은 O(관측한 업무 수)이며 projection cache 예산과 구분한다. 한 프로세스의 관측 이전 삭제나 재시작 전 과거 head까지 추적하는 영속 외부 감사 장부는 추가하지 않았다. 여러 파일에 대한 읽기는 전역 원자 snapshot이 아니며, 이후의 외부 변경을 영구적으로 막는 보장도 없다.

Cache 기본 예산은 32 MiB이며 `maxCacheBytes:0`으로 비활성화할 수 있다. 예산은 state·events·historical receipt state·delivery·record digest/identity를 직렬화한 bytes를 합산한다. Map은 entries 배열로 계산한다. 이는 실제 JavaScript heap의 정확한 상한이 아니다. LRU 퇴출과 close가 projection 및 record identity를 해제하고 close는 관측 업무 maps도 비운다.

## 관측과 회귀

Journal `metrics()`는 완료된 Node file read calls/bytes, raw hash/checksum hash calls/bytes, parsed/replayed records, cache hits/evictions, 측정한 metadata checks, directory syncs, page inspected works와 cache/bookkeeping 규모를 구분한다. OS page cache나 커널의 실제 디스크 I/O를 측정한 값은 아니다.

신규 `state-query.test.ts`는 세 adapter의 bounded metadata·scope·cursor·Unicode 진행을 확인한다. Journal은 cold replay N, warm replay 0이면서 본문 read/hash bytes 유지, 외부 append 이후 새 기록만 재생하는 조건을 확인한다. Warm cache의 same-length 변조+mtime 복원, 중간/끝 삭제, inode 교체, symlink, mode, header, fsync 실패, 반환 객체 변형, eviction/disable, 지연 ACK head 경합도 포함한다. SQLite는 migration 보충·롤백·기존 열린 writer·색인 실패의 전체 commit 롤백과 body 없는 조회 SQL을 확인한다.

시험 작성과 타입 검사 완료를 시험 실행 통과로 간주하지 않는다. 실행 결과와 실제 비용 수치는 루트의 최종 검증 로그 및 별도 관측 산출물에 기록한다.

## 최종 통합 결과 연결

이 문서의 작성·소스 검토·중간 검사 시점 이후 루트의 최종 통합 검증은 1,536/1,536 통과, 실패 0이었다. 신규 53개(저장 조회28·원자 제어17·공개 조회8), 코어 타입 검사·계층 검사·합성 fixture도 통과했다. 최신 SQLite schema는 v3이며 v1/v2의 이행을 검증했다. 이 문서의 중간 상태를 최신 결과로 해석하지 않고 [학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-query-control-result.md)와 [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-local-verification.json)을 따른다.
