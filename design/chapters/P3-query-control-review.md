# P3-02 조회 비용·목록 cursor 독립 검토

2026-09-06 · v0.31 다음 단위 · 합성 로컬 자료 · 설계/기존 소스 읽기 검토

이 기록은 새 구현의 통과 결과가 아니다. 기존 [저장 계획](P2-storage-plan.md), [저장 결과](P2-storage-result.md), [Web 결과](P3-web-result.md)와 현재 journal·공통 조회·목록 구현 및 회귀 시험을 읽어 후속 단위의 수용 기준을 정리했다. 제품/시험 코드 수정, build/test, 서버 실행, 모델·외부 서비스 호출은 하지 않았다. root와 저장소 구현 담당에게 아래 기준을 전달했다.

## 1. Journal: 본문 무결성을 유지하면서 재생 비용 줄이기

[기존 journal](../../runtime/src/infrastructure/file-journal-state.ts)은 조회마다 전체 revision 본문을 읽고 checksum, 이전 hash, 업무/명령/revision, 상태 전이를 검증한다. root/header/work directory의 안전성과 열린 인스턴스가 관측한 identity도 확인하고 읽기 마지막에 directory sync를 수행한다. [기존 장애 시험](../../runtime/src/tests/journal-fault.test.ts)은 본문 손상, chain 오류, 중간 삭제, symlink/권한/identity 교체, 공개와 ENOENT의 경합, directory sync 실패 때의 읽기·중복 ACK 거부를 포함한다.

파일 크기·mtime·ctime·inode만 같은 경우에 저장해 둔 projection을 반환하면 현재 본문을 재검증하는 기존 계약과 같지 않다. metadata를 보존한 본문 손상은 stat으로 확인할 수 없다. 같은 UID의 악의적 전체 rollback을 원래 보장하지 않았다는 제한도, 평범한 본문 손상을 더 이상 확인하지 않는 근거가 되지 않는다.

담당자가 확정해 전달한 방향은 **stat-only cache를 사용하지 않는 것**이다. warm 조회에서도 모든 기존 record를 nofollow로 열어 안전성과 본문 hash를 검증한다. 검증된 raw digest가 같은 prefix만 JSON/schema/transition/projection 재생을 생략하고, 외부 writer가 append한 suffix는 순서대로 검증·반영한다. 이 방식은 본문 인증을 생략하지 않는 CPU 최적화다. cold에서는 전체 재생, warm에서도 전체 이력 bytes 읽기/hash와 metadata 확인이 남는다. 마지막 record나 전체 업무 삭제의 독립 외부 head 없는 판별, 전원 차단, 같은 UID의 악의적 rollback에 대한 기존 제한도 유지한다.

캐시의 수용 기준은 다음과 같다.

- root/header/work identity와 mode/owner, 각 record의 일반 파일·nofollow·크기 검사 및 directory sync를 cache hit에서도 수행한다. 오류를 오래된 성공 snapshot으로 대체하지 않는다.
- 검증이 끝난 연속 prefix만 캐시에 넣는다. candidate만 썼거나 공개 후 ACK가 불명인 값은 검증 없이 정본 cache로 승격하지 않는다. duplicate receipt는 해당 명령 당시 state를 계속 반환한다.
- 반환된 state/events/deliveries/receipt의 mutation이 내부 cache나 다른 조회에 영향을 주지 않는다. [공통 저장 계약 시험](../../runtime/src/tests/state-conformance.test.ts)의 snapshot 복사 계약을 warm path에도 적용한다.
- 항목 수와 추정 직렬화 bytes로 LRU를 제한한다. 최신 state만이 아니라 과거 receipt state, events, deliveries, record fingerprint를 포함한다. Map은 명시적으로 항목 배열로 변환해 계산하며, 이 값이 JavaScript 전체 heap 사용량이라고 주장하지 않는다.
- cache eviction/reopen은 전체 검증으로 돌아간다. 권한·원본 artifact·기억의 현재성에 관한 결과를 이 cache로 대신하지 않는다.

## 2. 제한된 조회의 의미와 남는 물리 비용

초기 포트 초안 이후 저장된 구현은 `recentEventMetadata(workId, {throughRevision, limit<=50})`와 `conversationWorkPage({tenantId, principalId, channel, conversationId, cursor?, limit<=20})`다. 전자는 `{items, omittedCount}`, 후자는 `{workIds, nextCursor}`를 반환한다. cursor는 저장소 전용 위치이며 공개 화면에는 별도 handle만 노출한다. 아래 새 소스 검토는 구현을 읽은 결과이고 시험 통과를 뜻하지 않는다.

진단의 revision 조건은 LIMIT보다 먼저 적용해야 한다. 정본 revision N을 표시하는 요청에 N 이후 event가 append되어도 N까지의 마지막 50건과 정확한 생략 수가 나와야 한다. 순서는 업무별 sequence 오름차순을 유지한다. 메타데이터 포트는 event의 type/at/revision/sequence만 반환하고 data 본문을 materialize하지 않는 편이 적합하다.

접수/결과/질문/실패 전달 조회는 현재 state에서 계산한 정확한 ID를 사용한다. 최신 것처럼 보이는 다른 kind의 과거 delivery로 fallback하지 않는다. 현재 응답의 artifact·evidence·가설 basis·knowledge 검사, route/actor/screen/log 권한, 두 차례 projection과 최종 state 확인은 [WorkViewService](../../runtime/src/application/work-view-service.ts)에 남긴다. 이력 읽기를 줄이는 작업이 `unchanged`에서 원본 검사를 생략하는 변경이 되어서는 안 된다.

각 저장소 비용은 구분한다. SQLite의 결과 행/JSON decode 수와 반환량은 LIMIT로 줄일 수 있지만 conversation binding을 JSON 안에서 찾는 조건은 후보 row scan이 남을 수 있다. File journal은 현재 물리 형식에 별도 검증된 색인이 없으므로 cold 업무 탐색과 전체 history 본문 확인 비용이 남는다. `limit=20`은 반환량의 상한이지 전체 디스크 scan이나 전체 업무 directory 탐색이 20개라는 뜻이 아니다.

## 3. 목록: denied 탐색과 cursor 수명

[기존 LocalWorkbench](../../runtime/src/presentation/local-workbench.ts)는 전체 conversation ID를 읽은 뒤 cursor hash에 맞는 ID를 다시 찾는다. 이 방법은 전체 ID 조회 비용을 남기며, anchor가 현재 목록에서 사라지면 다음 페이지를 해석할 수 없다. 새 keyset 조회에서는 다음 조건을 명시해야 한다.

- 한 HTTP 요청에서 검사할 후보 수에 별도 상한을 둔다. 권한 없는 카드도 후보 budget을 소비한다. 제한까지 모두 denied이면 빈 items와 전진한 nextCursor를 반환할 수 있으며, 이것을 전체 목록 끝으로 표시하지 않는다. 빈 페이지를 채우려는 자동 재요청이 새 무제한 loop를 만들지 않게 한다.
- anchor는 마지막으로 **검사한 내부 정렬키**다. 마지막으로 공개한 카드만 기준으로 삼으면 denied-only 페이지가 전진하지 않는다. strict-after 조회는 anchor 자체의 현재 존재나 현재 공개 권한을 요구하지 않는다. anchor가 삭제·연결 해제·권한 철회되어도 이후 키부터 진행한다.
- 공개 token은 actor/tenant/route/filter/order/version에 고정한다. 숨겨진 work ID를 평문이나 단순 base64로 넣지 않는다. 제한된 수명·항목 수를 가진 opaque token resolver 등을 사용할 수 있다. token 만료/다른 profile/restart 정책은 명시적으로 거부하고 첫 페이지 갱신을 안내하며, 조용히 처음부터 재시작해 중복/누락을 감추지 않는다.
- 초안에서는 저장소별 ID 정렬의 통일을 권고했다. 현재 구현은 저장소 전용 cursor를 도입해 각 adapter 내부에서만 순서가 안정적인 계약으로 정리했다. Memory는 JS ID 순서, SQLite는 BINARY ID 순서, journal은 SHA directory 순서다. cursor를 다른 adapter로 이동하지 않고 각 adapter의 Unicode·page size 1 회귀에서 전진/중복 없음을 확인하면 된다. 저장소 사이에 같은 표시 순서를 보장한다고 주장하지 않는다.
- 후보를 가져온 뒤 반환할 카드 전체를 현재 WorkView cursor로 다시 검사한다. B 조회 중 A 권한이 철회되는 기존 회귀를 유지한다. 제한된 재검사에서도 계속 바뀌면 contention으로 끝내며 오래된 카드를 반환하지 않는다. cursor는 권한 증명이 아니다.
- 여러 업무를 아우르는 snapshot을 보장하지 않는다. 앞쪽에 새 업무가 삽입되면 새 첫 페이지 조회에서 나타날 수 있다. 이동/새로 연결된 업무가 현재 페이지에서 빠질 수 있는 keyset 계약을 문서화한다.

## 추가 시험·측정 기준

| 범위 | 구체적인 회귀 또는 관측 | 판정 |
| --- | --- | --- |
| Journal warm integrity | 정상 조회로 cache를 채운 뒤 기존 prefix의 같은 길이 본문 변경과 mtime 복원, 중간 record 삭제, symlink/권한 변경 | get뿐 아니라 새 query·receipt·commit도 실패하고 손상 record를 덮어쓰지 않음 |
| Journal publication | 다른 writer의 append, revision open ENOENT 직후 공개, 공개 후 ACK 대기 중 reader, sync 실패 | 정상 연속 append를 손상으로 오인하지 않고 sync 실패 시 성공 ACK/조회 없음 |
| Journal cache isolation | 반환 snapshot 변경, LRU eviction, 새 instance, 과거 command duplicate | 캐시 오염 없음, 최초 receipt state 보존, cold에서도 손상 검출 |
| Journal 실제 비용 | 동일 R개 이력의 cold, 동일 instance warm, 다른 instance가 ΔR append, eviction 후 cold | replay/schema/parse는 R→0→ΔR; body read/hash bytes는 따로 기록하고 감소했다고 주장하지 않음 |
| Event tail, 모든 저장소 | 50개 초과, 한 revision에 여러 event, event 없는 revision, throughRevision보다 새 append | throughRevision 조건을 먼저 적용한 마지막 50건·정확한 omittedCount·work별 sequence |
| 목록 제한, 두 영속 저장소 | 후보 상한보다 많은 denied 업무 뒤에 visible 업무, 마지막 카드가 후속 검사에서 철회 | 한 요청 후보/WorkView 호출 상한 유지, 빈 페이지도 cursor 전진, 이후 visible 업무 도달 |
| Cursor, 두 영속 저장소 | anchor 연결 해제/권한 철회/소실, 다른 actor/route token, 만료·reopen, BMP/non-BMP ID로 page size 1 | 숨긴 ID 공개 없음, 정해진 수명/재시작 동작, strict-after 순서·중복/누락 계약 일치 |
| 현재성 유지 | unchanged cursor로 조회 중 원본/가설-only basis/기억 무효화, B 검사 중 A 철회 | 과거 결과·카드 복원 없음, state commit/artifact put/channel send 0 |

계측은 record/header body read 횟수와 bytes, raw hash와 checksum hash 각각의 횟수·bytes, JSON parse/schema/transition/replay 횟수, metadata open/stat 및 directory fsync, cache hit/eviction/추정 bytes를 나눠 기록한다. cache reset과 metrics reset도 구분한다. wall time은 보조 관측이며 기능 시험을 불안정한 지연 임계값으로 만들지 않는다. 이 단위에서 무엇이 실제로 줄었는지는 새 계측 결과와 최종 검증 기록이 있어야 확정할 수 있다.

## 새 구현의 독립 소스 검토

첫 구현 저장 뒤 제품·시험 소스를 읽었으며 실행은 하지 않았다. 아래 발견은 root와 각 담당자에게 전달했고 수정 후 재확인 및 최종 실행 결과는 별도로 기록해야 한다.

| 발견 | 현재 코드에서의 구체적인 경로 | 최소 수정·회귀 |
| --- | --- | --- |
| 이미 열린 SQLite v1 writer의 새 색인 미갱신 | v1 연결을 연 상태에서 v2 constructor가 migration하면, 이미 열린 v1 commit은 user_version을 재검사하지 않고 works/events만 쓴다. event_metadata와 conversation_work를 갱신하지 않아 get/events와 새 query가 달라진다. | v1 연결을 먼저 연 회귀에서 migration 뒤 commit을 거부하거나 파생 색인을 원자적으로 유지해야 한다. 원본 변경 trigger는 후자의 한 방법이다. user_version만으로 모든 구버전 writer가 차단됐다고 주장하지 않는다. |
| Journal identity 기록이 projection cache 상한 밖에 남음 | maxCacheBytes=0 또는 eviction 뒤에도 record 경로별 dev/ino Map은 계속 늘어난다. 첫 구현의 close도 이 Map을 지우지 않는다. | identity를 cached record와 같이 회수하거나 별도 상한과 fail-closed 동작을 둔다. 별도 retained bookkeeping을 수치로 표시하고 close에서 해제한다. projection bytes만으로 전체 retained 상태가 bounded라고 주장하지 않는다. |
| 늦은 commit ACK가 관측 head를 과거로 되돌림 | commit N의 hook이 대기하는 동안 같은 instance의 get이 외부 writer의 N+1을 관측한 뒤 N의 ACK가 돌아오면 무조건 set으로 observed head가 N이 된다. cache가 없을 때 새 tail 유실 검사도 약해진다. | 관측 revision은 최대값만 유지하고 같은 revision의 hash 불일치는 거부한다. maxCacheBytes=0과 published hook으로 순서를 고정한 회귀가 적합하다. |
| 새 listPage options가 신뢰된 scope를 덮을 수 있음 | ConversationService가 actor/route 뒤에 `...options`를 합친다. JS 호출자가 extra scope 필드를 전달하면 tenant/principal/channel/conversationId가 덮인다. 현재 Web caller는 고정 literal을 보내므로 그 HTTP 경로의 결함은 아니다. | options를 strict-parse하거나 cursor/limit만 명시 복사한다. extra scope를 거부하거나 원래 actor/route로 고정하는 API 회귀를 추가한다. |

현재 구현에서 확인한 유지 사항은 다음과 같다.

- WorkView는 `recentEventMetadata`의 현재 revision/50개 조건을 사용하고 compose도 실제 읽기 wrapper만 전달한다. 원본 artifact·knowledge·가설 basis 검증, projection 재확인과 마지막 state 확인을 유지했다.
- LocalWorkbench는 한 adapter page의 후보만 확인하고, 반환할 카드의 공개 cursor를 최대 3회 재검사한다. 외부 `wl2`는 instance별 UUID handle로 128개/15분 상한을 가지며 private adapter cursor를 반환하지 않는다. denied-only 페이지의 UI 안내도 다음 페이지와 전체 끝을 구분한다.
- goal 명령은 숫자형 양의 safe expectedControlRevision을 필수로 받고, 변경하는 동일 CAS의 edit에서 expectedGoalRevision과 control revision을 검사한다. CLI/Web schema와 실제 전송에 두 조건을 연결했고 unrelated revision만 바뀐 CAS 재시도는 허용한다.
- [새 조회 시험](../../runtime/src/tests/work-query-view.test.ts)은 실제 commit으로 120개 사건과 43개 업무를 만들고 20개 카드의 공개 권한을 바꾼다. [목표 동시 변경 시험](../../runtime/src/tests/goal-control-atomic.test.ts)은 실제 commit conflict를 주입하고 receipt/state 불변과 CLI/HTTP payload를 검사한다. 이는 시험 내용을 읽은 확인이며 통과 결과는 root의 최종 실행에 따른다.

### 네 지점 수정 후 소스 재확인

root의 수정 알림 뒤 위 네 지점만 다시 읽었다. **네 발견 모두 소스에서 수정된 것을 확인했으며 실행 검증은 아직 root 수행 전이다.** 범위를 넓힌 추가 검토나 제품/시험 실행은 하지 않았다.

| 이전 발견 | 저장된 수정과 현재 판정 |
| --- | --- |
| 이미 열린 SQLite v1 writer | works/events의 insert/update/delete source trigger가 conversation_work/event_metadata를 같은 원본 변경 트랜잭션에서 갱신한다. v2 commit의 별도 중복 insert는 제거했고 migration·기존 자료 적재·trigger 설치·user_version 변경은 하나의 BEGIN IMMEDIATE/COMMIT 안에 있다. 이미 열린 v1 writer를 막는 방식이 아니라, 그 정상 원본 쓰기에도 색인을 유지하는 방식으로 해소했다. migration 뒤 새로 여는 구버전 프로그램의 version 거부와 구분한다. |
| 무제한 record identity Map | 전역 record Map을 제거하고 dev/ino를 CachedProjection.records에 포함했다. 직렬화 bytes에 함께 계산하며 eviction과 같이 회수한다. close는 cache·work identity·known ID·observed head도 모두 비운다. metrics는 cache 안 record identity 수와 별도 observed work/directory 수를 구분한다. |
| commit ACK의 observed head 역행 | replay와 commit 모두 `#observeHead`를 사용한다. 같은 revision의 다른 hash는 거부하고, 더 높은 revision만 저장하므로 N+1 관측 뒤 N의 늦은 ACK가 head를 낮추지 않는다. |
| listPage options의 scope 덮기 | actor/route를 직접 고정하고 options에서는 limit/cursor만 명시 복사한다. 새 회귀는 extra tenant/principal/channel/conversationId를 넣어도 원래 업무만 반환하는지 실제 저장소를 통해 확인하도록 작성됐다. |

남은 비용·보장 범위는 이전 설명과 같다. warm journal도 전체 본문을 읽고 hash하며, directory/head/known-ID의 작은 관측 정보는 관측한 업무 수에 비례한다. projection bytes를 프로세스 heap 전체의 상한으로 해석하지 않는다. 수정된 네 동작의 실제 회귀 통과 여부와 측정 수치는 최종 검증 기록에서 확인해야 한다.

## 최종 통합 결과 연결

이 문서의 작성·소스 검토·중간 검사 시점 이후 루트의 최종 통합 검증은 1,536/1,536 통과, 실패 0이었다. 신규 53개(저장 조회28·원자 제어17·공개 조회8), 코어 타입 검사·계층 검사·합성 fixture도 통과했다. 최신 SQLite schema는 v3이며 v1/v2의 이행을 검증했다. 이 문서의 중간 상태를 최신 결과로 해석하지 않고 [학습·결과](/Users/seunghanee/Documents/secumon/design/chapters/P3-query-control-result.md)와 [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-local-verification.json)을 따른다.
