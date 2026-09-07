# C03 D3 — 기존 SQLite 개인 기억의 명시적 문서 이관

2026-09-07 · 지원 POSIX 구현·검증 완료; C03 전체 진행 중 · 실사용 DB 이관 미실행

이 문서는 **한 담당의 기존 SQLite 개인 기억 전체를 같은 담당의 문서 저장소로 한 번 옮기고, 같은 세션에서 이어 쓰는 단위**의 설계다. SQLite 기본값, 업무 기억, 대화 원문, 작업 상태와 agentId는 유지한다. 새 담당을 만들거나 기존 기억을 사용자 발언으로 다시 등록하는 작업이 아니다.

현재 구현과 검증 상태는 [D3 진행 결과](C03-personal-memory-migration-result.md)를 따른다. 아래의 최초 검토·제안 표현은 당시 설계 이력이며, 구현 완료나 실제 운영 검증을 뜻하지 않는다. Checkpoint265에서 신규 38/38·관련 315/315·Linux 전체 3,038/3,038, 원로그 회수와 환경 정리를 확정했다. 아래 구현 전 결정과 실사용 검증 한계를 구분한다.

<!-- C03-D2-FINAL-PROOF: 60d7e65ea1dd57ebbb0ce5fb3268f259199e07ef36a034764b20669566c3037a -->

D1에 이어 D2는 같은 최종 소스의 Linux 전체 3,000/3,000·관련 306/306과 환경 정리까지 확인했다. [D2 결과](C03-document-draft-result.md) · [최종 검증 근거](../../runtime/evidence/C03-drafts-verification.json). 이 문서가 처음 작성될 때는 build2 관련 295/295 뒤 NAS 검증 중이었으며, 이후의 실패·진단·수정 이력은 D2 결과에 별도로 보존했다. D2 확정 시점의 D3는 설계 단계였으며 현재 구현·검증 진행은 위 결과 문서에 분리했다. 실제 사용자 DB의 백업·이관·전환·복원은 수행하지 않았다. 별도 합성 SQLite snapshot/backup 결합 probe 1회는 통과했으며 [관측 결과](../../runtime/evidence/C03-migration-backup-snapshot-probe.json)에 분리했다. D2 통과를 이관 검증으로 간주하지 않는다. [현재 실행 순서](../03-migration-plan.md) · [D1/D2/D3의 범위](C03-document-memory-plan.md).

## 0. 착수 전 범위 결정 — 구현 전

D2 Linux 검증을 기다리는 동안 [코드 경계 검토](C03-personal-memory-migration-review.md)를 반영했다. 아래는 다음 구현의 범위 결정이며 이관 기능이 동작한다는 결과가 아니다.

- **초기 설정과 현재 선택:** 원 config/setup/assignment는 보존한다. 현재 개인 저장소 선택은 한 공통 경계에서 계산한 `effectivePersonalMemory`(현재 사용할 개인 기억 저장 방식)로 상태 표시·저장소 조립·D2 초안·복제에 전달한다. 복제는 새 담당 ID와 새 문서 storeId를 받고 이관 자료를 복사하지 않는다.
- **전환 중 정상 열기:** 저장소를 생성하는 bind보다 먼저 이관 기록과 원 DB를 읽기 전용으로 검사한다. source fence 이후 activation 이전에는 정상 개인 기억 실행을 거절하고 같은 operation ID의 관리 재개를 안내한다. 원 DB 소실이나 이전 백업 치환을 빈 담당 초기화로 처리하지 않는다.
- **재개와 취소:** 첫 구현은 fence 이후 취소를 제외한다. fence 이전 preview는 이관을 시작하지 않은 조회이며 중단할 수 있다. fence 후에는 같은 고정 operation을 이어 간다. 활성화 후 SQLite 자동 fallback과 역이관도 지원하지 않는다.
- **기존 실행과의 관계:** 첫 지원은 기존 담당 실행을 중지한 오프라인 관리 작업이다. 운영자가 확인한 중지 조건, 실제 시험에서 통제한 자식 프로세스, 코드의 source 쓰기 차단을 구분해 기록한다. 파일 하나의 존재나 PID 조회만으로 모든 구버전 프로세스가 중지됐다고 보장하지 않는다. source SQL trigger는 구버전의 개인 row INSERT/DELETE와 UPDATE의 OLD/NEW 개인 파티션 이동까지 막고, 새 엔진의 업무 row는 유지한다. 이미 진행 중인 구버전 읽기를 취소하는 기능으로 설명하지 않는다.
- **데이터 보존:** SQL이 실제 보관한 최신 record와 모든 command receipt/audit·head를 내보낸다. 원 digest를 새 값으로 바꾸거나 저장되지 않은 과거 본문을 생성하지 않는다. 누락된 record, 영수증 revision의 중복/불연속, 최신 상태·head·색인 불일치는 preview에서 거절한다.
- **구현 크기:** 일반 기억 도구에 전체 DB 열거를 추가하지 않는다. 단일 담당의 호스트 관리 CLI, 한 방향 이관, 초기 seed와 최종 activation만 추가한다. Web은 기존 상태·기억·초안 흐름이 현재 저장소를 선택하는 연결을 재사용한다.

seed wire 형식(파일에 저장하는 데이터 구조)은 [초기 이관 기록 계약](C03-personal-memory-migration-seed-notes.md)을 채택한다. 기억별 seed_record와 namespace별 seed_head, 마지막 v2 format 게시로 import 완료를 확인하며 activation은 별도 정본 선택이다. 호스트 관리 계약은 안쪽 타입을 사용하고 실제 파일 envelope/format codec은 infrastructure에 두어 계층 의존 방향을 유지한다. [백업 후보 수명](C03-personal-memory-migration-backup-notes.md)의 전용 worker·읽기 snapshot·새 후보·검증 후 덮어쓰기 없는 게시 방식을 채택한다. 전체 memory DB 256MiB, worker 60초, batch 256페이지는 첫 관리 기능의 지원 상한/기본값으로 고정하며 측정된 최적 성능값은 아니다. 실제 결합 검증과 크기·중단 시험은 구현에 포함한다. 전체 DB를 문자열/Buffer 하나로 읽어 기존 bytes 전용 게시 도구에 넘기는 방식은 채택하지 않는다.

## 1. 현재 코드가 허용하는 것과 추가 연결이 필요한 것

| 확인한 현재 경계 | D3에 주는 제약 |
|---|---|
| [SqliteKnowledgeRepository](../../runtime/src/infrastructure/sqlite-knowledge.ts)의 `knowledge_records_v2`는 기억별 최신 JSON을 갱신한다. `knowledge_receipts_v2`에는 command ID·digest·revision과 개인 변경의 `audit_body`가 있다. | 과거 본문 전체가 저장된 이벤트 로그가 아니다. audit에는 이전/현재 출처 참조와 revision 정보가 있지만 과거 title/body 전체가 없다. 없는 과거 내용을 복원했다고 표시하지 않는다. |
| 같은 DB의 `partition='work'`와 `partition='personal'`이 논리적으로 분리되어 있다. | `memory.sqlite`를 제거하거나 전체 DB를 문서로 바꾸면 업무 기억까지 손상된다. 개인 파티션만 이관·은퇴시킨다. |
| [KnowledgeRepository](../../runtime/src/application/knowledge-ports.ts)는 ID 조회·영수증 조회·CAS commit·색인 API를 제공한다. 전체 정본/영수증 열거 포트는 없다. | 검색 `candidates()`로 내보내면 잊힌 기억·비활성 기억·검색에서 제외된 항목·영수증을 누락한다. 호스트 관리용의 작은 snapshot 내보내기 경계가 필요하다. 일반 에이전트 도구에 전체 열거 권한을 주지 않는다. |
| [DocumentKnowledgeRepository](../../runtime/src/infrastructure/document-knowledge.ts)의 일반 commit은 이전 revision+1, 연속 이벤트, 원 명령 영수증, witness를 대조한다. | 최신 revision N을 새 저장소에 `expectedRevision=0`으로 넣을 수 없다. 일반 commit의 CAS 검사를 완화하지 않고 초기 이관 전용 기록을 구분한다. |
| [FileAgentProfileStore.#read](../../runtime/src/infrastructure/file-agent-profile.ts)는 config와 setup-operation의 개인 저장 선택을 대조한다. [bindAgentMemoryProfile](../../runtime/src/infrastructure/agent-memory-profile.ts)은 초기 assignment와 ready를 별도로 검증한다. | `config.json`만 바꾸거나 초기 assignment를 삭제한 뒤 다시 초기화하는 방법은 이관이 아니다. 기존 초기화 이력을 보존한 명시 전환 계약이 필요하다. |
| [SQLite owner 검사](../../runtime/src/infrastructure/sqlite-knowledge-owner.ts)는 agent/shared 모드를 구분한다. [AgentKnowledgeRepository](../../runtime/src/infrastructure/agent-knowledge.ts)는 파티션별 정본 하나만 선택한다. | 첫 이관은 C01의 단일 agent 소유 SQLite에 한정한다. shared DB의 일부 담당만 옮기는 별도 배정 체계는 첫 단위에서 제외한다. 기존 파티션 라우터는 재사용한다. |

`file-journal`은 작업 상태 backend다. 개인 기억을 옮기기 위해 작업 상태 backend를 바꾸지 않는다.

## 2. 비교와 권장 범위

| 방법 | 판단 |
|---|---|
| 최신 활성 기억만 `remember()`로 새로 등록 | ID/revision/출처/영수증이 바뀌고 잊힌 항목이 사라진다. 이번 이관으로 채택하지 않는다. |
| 모든 과거 명령을 일반 `commit()`으로 재생 | SQL에 과거 본문이 없어서 실행할 수 없다. 가짜 revision이나 새 사용자 발언을 만들어 채우지 않는다. |
| **최신 상태와 실제 영수증을 초기 snapshot으로 가져온 뒤 일반 commit으로 이어 쓰기** | 권장한다. 저장에 존재하는 정보만 보존하며, 새 변경부터 D1의 연속 기록·witness·CAS를 그대로 사용한다. |

첫 지원 범위는 한 agent의 모든 tenant/principal 개인 파티션이다. 현재 개인 backend 선택이 담당 단위이므로 특정 사용자만 옮기는 혼합 라우팅은 추가하지 않는다. 사용자가 선택한 scope 목록과 실제 소유 범위가 다르면 실행 전에 거절한다.

대상은 그 담당의 `memory/documents`, 신규 storeId다. 다른 agent의 저장소, 이미 활성화된 문서 정본, 기존 내용을 합치는 병합, PostgreSQL, 원격 공유 파일시스템, 역이관은 이번 범위에 넣지 않는다. 재시작은 동일 operation ID와 동일 source/target/manifest일 때만 허용한다.

## 3. 무엇을 보존하고 무엇을 재구성하는가

- **현재 기억 정본:** 활성·철회·삭제 상태를 모두 포함한다. ID, tenant/agent/principal, revision/contentRevision, 제목·본문의 정확한 문자열, 날짜, labels, 만료, source의 session/message/sequence/receiptDigest/quote를 바꾸지 않는다. 저장 표현은 JSON에서 Markdown으로 바뀌므로 파일 bytes가 원 DB 컬럼 JSON과 같다는 뜻은 아니다. 원 SQL JSON bytes의 지문은 백업/manifest에 보존한다.
- **모든 실제 명령 영수증:** `(tenant,agent,principal,memoryId,commandId)`별 digest와 revision을 그대로 옮긴다. 있는 `audit_body`도 감사 데이터로 보존한다. 같은 과거 명령을 다시 보내면 기존 영수증을 돌려주고 새 revision을 만들지 않아야 한다.
- **과거 본문:** 원 SQLite가 보관하지 않은 본문은 생성하지 않는다. 내보내기 보고서에 `최신 기억과 영수증 보존, 과거 본문 전체 없음`을 명시한다. 대화 원문은 기존 channel 저장소에서 계속 확인한다.
- **색인:** 원 `head {revision,cursor,error}`는 초기 기록과 검증 보고서에 보존한다. 첫 버전의 정상 이관은 `cursor===revision && error===null`인 namespace만 전환한다. 저장된 active 정본과 원 색인이 일치하는지 대조하고 문서 조회 결과를 재구성한다. 원 색인이 늦거나 오류면 자동으로 정상화했다고 표시하지 않고 이관 준비를 중단한다. 별도로 선택한 기존 `rebuildIndex()`가 성공한 뒤 새 snapshot을 만들 수 있다.
- **업무 기억·대화·작업 장부:** 이관 대상이 아니다. 업무 파티션의 원 JSON/receipt/index row, channel의 메시지·세션·요약, state backend의 작업 revision·예산·모델/도구 사용량을 전후 대조하고 변경하지 않는다. 백업 때문에 memory DB의 형식 metadata가 바뀌는 것과 업무 row가 바뀌는 것을 구분한다.
- **기존 ref/dependency:** 같은 기억 owner/ID/revision/source가 유지되므로 저장 방식만 바뀌었다는 이유로 새 ref를 발급하지 않는다. 재개 후 기존 `KnowledgeService.get()`과 dependency/current 검사를 그대로 통과해야 한다. 이미 철회된 출처나 권한을 이관으로 유효하게 만들지 않는다.

## 4. 초기 문서 기록의 가장 작은 확장

일반 `KnowledgeRepository.commit()`은 변경하지 않는다. 호스트 전용 importer가 신규·비활성 문서 target에만 초기 snapshot을 게시한다.

권장 초기 형식은 기억 하나당 **최신 record + 그 기억의 모든 receipt/audit를 같은 초기 파일**에 넣는 것이다. 처음부터 revision N인 snapshot임을 명시하고, 원래 N번의 본문 변경을 순서대로 저장한 것으로 해석하지 않는다. namespace의 원 index head와 source snapshot 지문은 초기 manifest에 둔다. 형식 이름/버전을 변경하여 D1 reader가 모르는 초기 기록을 일반 이벤트로 오해하지 않고 거절하게 한다.

기존 [codec](../../runtime/src/infrastructure/document-knowledge-codec.ts)의 schema·본문 보존·해시, [owner 등록](../../runtime/src/infrastructure/document-knowledge-owner.ts), 연속 파일 게시·외부 witness·read-side barrier를 재사용한다. importer의 초기 record/receipt 재생 결과 뒤에 일반 D1 이벤트가 이어진다. 첫 새 정정은 원 N에서 N+1, 원 command 재전송은 저장된 원 revision으로 처리한다. namespace head 숫자는 import 파일 개수가 아니라 보존한 원 변경 수를 기준으로 이어 간다.

첫 단위에서는 개별 초기 파일 256KiB, namespace 전체 4,096개 기록·64MiB와 기존 pending 한도를 유지한다. 하나의 기억에 영수증이 많아 256KiB를 넘으면 preview에서 명시 거절한다. receipt 일부를 버리거나 과거 명령을 무시하는 옵션은 두지 않는다. 다중 페이지 seed는 실제 제한에 부딪힌 뒤 별도 검토하며 첫 구현에 넣지 않는다. 이관 직후 새 기억 변경을 받을 공간이 없는 target도 전환하지 않는다.

문서 정본 밖의 검증 manifest는 snapshot 지문·개수·경로·상태를 묶는 자료다. 운영 중 SQL과 문서의 본문을 동기화하는 두 번째 정본은 만들지 않는다. 원 SQLite 개인 row와 백업은 이관 후 은퇴된 복구 자료로 남긴다.

## 5. 명시 입력과 호스트 작업

명령 이름은 제안이다. 최소 관리 입력은 다음과 같다.

```text
memory-migrate preview|apply|resume|status
  --agent-directory <담당 root>
  --from sqlite --source <root/memory/memory.sqlite>
  --to documents --target <root/memory/documents>
  --operation-id <UUID> --target-store-id <UUID>
  --backup-directory <새 private 백업 경로>
  --scope all-personal
```

`source/target`은 자동 추정만으로 실행하지 않고 표시·검증한다. 경로가 owner에 권한을 부여하지 않는다. source는 해당 C01 profile의 실제 memory 경로와 agent DB owner에 일치해야 하고, target은 담당 내부의 지정된 새 문서 경로여야 한다. 엔진 영역과 경로 중첩, 링크, 다른 소유자, 기존 다른 operation의 target은 거절한다. 임의 SQLite 파일을 초기화하여 자기 source로 만들지 않는다.

preview는 source 형식·범위별 개수·예상 seed 크기·원 index 상태·백업 목적지·지원하지 않는 항목을 보여 준다. 승인된 apply는 그 manifest 지문과 source snapshot이 그대로인지 다시 확인한다. source가 바뀌면 새 preview가 필요하다. status/resume은 같은 operation ID의 저장된 입력을 읽고 다른 경로나 target storeId로 바꾸지 않는다.

이 작업은 실행기를 조립하거나 모델·도구·채널을 실행하지 않는 관리 명령이다. `openAgentStores()`로 먼저 모든 DB를 여는 대신 profile/owner 검사와 이관 adapter만 연다. 존재하는 pending 사용자 원문을 새로 적용하거나, 미완료 모델 응답을 채택하거나, 새 세션·업무를 만들지 않는다.

## 6. 백업·정지·복사·전환 순서

### A. 실행을 쉬게 하고 읽기 기준을 고정한다

해당 담당을 실행 중인 CLI/Web/상주 프로세스를 먼저 종료하고 진행 중 모델/도구/전달 효과를 대조한 상태여야 한다. D3가 임의로 상태를 완료·실패로 바꾸거나 미완료 원문을 처리하지 않는다. 실행 중·결과 불명·미대조 효과가 남으면 이관을 거절한다. 중단된 장기 작업 자체는 유지할 수 있다.

새 엔진 진입점에는 이관 관리 중인 담당의 실행을 거절하는 최소 gate를 연결한다. 이는 호스트 실행 권한 경계이며 일반 workflow의 budget이나 work 상태를 재설계하는 일이 아니다. 구버전 프로세스까지 새 파일 하나로 정지시킬 수 있다고 가정하지 않는다. 첫 지원은 오프라인 이관이며, 이미 열린 구버전 프로세스 종료가 충족되지 않으면 시작하지 않는다.

### B. 일관된 백업을 만들고 실제로 다시 읽는다

`memory.sqlite`의 살아 있는 main 파일만 복사하는 방법을 쓰지 않는다. WAL에는 아직 main에 합쳐지지 않은 committed 데이터가 있을 수 있다. SQLite가 지원하는 snapshot 백업 경로를 사용하여 새 private 후보에 백업하고, 완료·파일 sync·디렉터리 sync·대상 owner/형식·무결성·row manifest를 재검사한다. [SQLite 백업 API](https://www.sqlite.org/backup.html) · [SQLite WAL 수명](https://www.sqlite.org/wal.html).

백업 경계는 작은 SQLite 전용 호스트 helper에 둔다. 현재 `HostFileMutationScope.publish()`가 bytes를 받아 게시한다는 이유로 크기 제한 없는 DB 전체를 메모리에 올리지 않는다. 지원 Node24의 SQLite backup 호출과 private 후보 게시 방법, 전체 DB/백업 용량 상한은 첫 구현 전에 고정하고 시험한다. 일반 파일 mutation API를 스트리밍/백업 프레임워크로 확대할 필요는 없다.

백업 검증에는 DB 소유자, 스키마, 모든 개인 record/receipt/head/index, 업무 row 지문을 포함한다. profile의 identity/config/setup-operation/assignment 원 bytes도 보존한다. channel/state/artifact는 이관하지 않지만 대응 시점의 식별자·논리 지문과 사용자 원문 참조를 대조한다. 이 백업은 memory DB 복구 자료이며 전체 담당·외부 효과의 완전 복원본이라고 표시하지 않는다.

owner의 읽기에도 hot-journal 복구가 필요한 경우가 있다. 기존 `agent_storage_recovery_required` 의미를 유지하고 원 DB/journal을 보존한다. D3라는 이유로 foreign/unowned DB를 자동 인수하거나 sidecar를 지우지 않는다. 이 범위는 [C10의 복원 조건](../03-migration-plan.md#c10--설치버전-이행운영-복원시범과-선택-이관)을 따른다.

### C. source 개인 파티션을 중지하고 구버전 쓰기를 막는다

백업과 현재 source의 논리 snapshot 지문을 SQLite transaction 안에서 다시 대조한다. 동일할 때만 operation ID와 target storeId를 source의 이관 등록에 기록하고 개인 접근을 fenced 상태로 commit한다. 그 뒤 복사 중에는 일반 개인 get/receipt/commit/index 접근을 허용하지 않는다.

기존 schema 2를 그대로 둔 채 새 코드만 검사하면 구버전 `SqliteKnowledgeRepository`가 같은 개인 row에 계속 쓸 수 있다. 기존의 `#assertScoped/#legacyMode`와 legacy 은퇴 trigger 선례를 사용하여 호환 버전을 올리고, 개인 파티션의 SQL 변경에도 은퇴 gate를 둔다. 새 엔진은 업무 파티션을 계속 이해하지만 이전 엔진은 알 수 없는 버전을 거절해야 한다. 전체 memory DB를 read-only로 만들어 업무 기억까지 영구 중단시키지 않는다.

이관 조립자의 동시 실행은 같은 SQLite owner/operation을 검증한 transaction과 제한된 writer 점유로 직렬화한다. process 종료 뒤 DB lock이 해제되더라도 source의 영속 fence는 남는다. PID 파일이 오래됐다는 이유로 다른 이관의 소유권을 가져오지 않는다. 정확한 transaction 길이/timeout은 bounded source 규모에 맞춰 시험한다.

### D. 비활성 target을 만들고 전수 대조한다

동일 operation의 target 등록 → 결정된 초기 기록 → witness → 재오픈 대조를 진행한다. 부분 target은 아직 어느 정상 담당에서도 개인 정본으로 선택하지 않는다. 같은 이름의 파일이 있으면 exact bytes/hash와 owner를 검사하고 재사용하며, 불일치·예상하지 않은 파일·불명확한 게시 결과는 거절/복구 필요로 보존한다.

전환 전 대조는 active뿐 아니라 deleted/retracted 기억, 모든 command receipt, source 지문, index head와 검색 후보, scope 격리를 포함한다. source에 없는 과거 본문·새 command ID·새 user receipt를 생성하지 않았는지도 확인한다. target 재오픈은 기존 witness와 barrier를 통과해야 한다.

### E. 단일 activation 게시로 새 정본을 선택한다

`config.json`, `setup-operation.json`, 최초 `personal-memory-profile.json`은 당시 초기화 이력으로 보존한다. 세 파일을 차례로 덮어쓰는 전환은 중간 상태를 만들므로 권장하지 않는다.

가장 작은 권장 확장은 **한 방향 이관 operation과 최종 activation 한 개**다. activation은 기존 profile/assignment 지문, 같은 agentId, source fence, 검증된 target storeId·형식·manifest를 연결한다. 새 `FileAgentProfileStore.inspect()`와 `bindAgentMemoryProfile()`이 이 검증된 기록이 있을 때만 문서 개인 backend를 유효 설정으로 반환한다. 사용자가 보는 status에는 초기 SQLite 배정과 현재 문서 정본을 구분해 표시한다. 일반 설정 변경 이력 시스템까지 만들지 않는다.

기존 `document-memory-ready`는 target 등록 완료를 증명하는 데 재사용할 수 있다. **ready만으로 이관이 끝난 것은 아니다.** source fence와 데이터 검증을 묶은 activation의 no-overwrite 게시가 정상 라우팅의 전환점이다. 게시 후 sync/검사가 실패하면 `published/unknown`을 유지하고 동일 activation을 대조·동기화하여 재개한다.

신규 실행은 activation 검증 후 기존 `AgentKnowledgeRepository(workSqlite, personalDocuments)`를 선택한다. source 개인 row는 보존하되 사용하지 않는다. 문서 오류를 만나면 SQLite 개인 기억으로 fallback하지 않는다. 전환 직후 동일 memory ID/revision을 조회하고 새 정정·잊기를 실제 새 target에서 수행한 후 재오픈해 확인한다.

## 7. 중단과 되돌리기

| 멈춘 위치 | 허용되는 다음 행동 |
|---|---|
| 백업/preview 중, source fence 전 | 정식 activation이 없음을 확인하고 SQLite를 계속 사용한다. 불완전 백업을 정상 백업으로 표시하지 않는다. |
| source fence 후, target 일부만 게시 | 정상 실행은 거절한다. 동일 operation으로 검증된 파일만 재사용해 복사를 이어 간다. 옛 SQLite로 조용히 되돌아가지 않는다. |
| target/witness 검증 후, activation 전 | 전수 manifest와 source fence를 다시 확인하고 activation만 게시한다. 같은 데이터를 새 ID로 재등록하지 않는다. |
| activation link 후 sync 실패/프로세스 종료 | 결과 불명/게시됨을 보존한다. 동일 activation과 target을 읽고 barrier를 마친 뒤 정본 선택을 확정한다. |
| activation 후 target 손상/누락 | 문서 사용을 중단한다. 보관된 source가 있다는 이유로 자동 fallback/재초기화하지 않는다. |

**첫 단위에서는 source fence 이후의 취소를 지원하지 않는다.** fence 이전 preview는 중단할 수 있으며, fence 이후에는 고정된 operation의 resume으로 이관을 완성한다. 부분 target은 비활성 자료로 보존한다. 나중에 취소 기능을 넣을 때도 activation과 같은 source 상태 CAS로 배타적으로 결정해야 하며, 파일 부재 확인만으로 SQLite를 다시 활성화하거나 호환 schema를 낮추지 않는다.

**활성화 후 역이관은 지원하지 않는 안을 권장한다.** 문서에서 새 변경이 생긴 뒤 예전 SQLite로 돌아가면 기억/영수증/잊기 상태가 퇴행한다. 후속 역이관은 최신 문서 전체를 새로운 SQLite target으로 내보내고 별도 검증·전환하는 명시 작업이어야 한다. 백업 복원은 과거 시점 복구이며 역이관이나 엔진 rollback과 같지 않다. [설치·버전 이행의 복원 원칙](installation-and-versioning.md#6-되돌리기와-실패-복구).

## 8. 구현 파일과 작은 완결 순서

| 단위 | 재사용/최소 추가 | 끝나는 사용자 가치 |
|---|---|---|
| 1. 범위 확인·backup·preview | `sqlite-knowledge-owner.ts`, `agent-database-owner.ts`, 새 `personal-memory-migration-contracts.ts`와 SQLite snapshot/backup helper. 소유 범위가 고정된 관리 전용 열거, typed manifest, 명시 cap. | 실제로 옮길 기억/영수증과 제외·오류 항목, 검증한 백업을 확인한다. 이 단계만으로 이관 완료라고 하지 않는다. |
| 2. seed import·재오픈 대조 | 문서 codec/owner의 새 형식 지원과 작은 host importer. 일반 repository CAS와 기존 schema 검사를 유지한다. | 원 ID/revision/receipt를 보존한 비활성 target을 재오픈하여 검증한다. |
| 3. fence·activation·CLI | `sqlite-knowledge.ts`의 개인 fence/버전 검사, `file-agent-profile.ts`/`agent-memory-profile.ts`의 명시 이관 읽기, `agent-stores.ts`의 기존 라우터 연결, 관리 CLI 한 경로. | 같은 담당을 같은 세션에서 문서 기억으로 이어 쓰고 동일 과거 명령은 중복 적용하지 않는다. |

첫 완료 단위는 세 행을 모두 관통한다. importer만 만든 뒤 완료로 멈추지 않으며, C10 설치 패키지 전체·공유 DB 이관·PostgreSQL·범용 버전 관리가 끝날 때까지 기다릴 필요도 없다. 웹에는 최초부터 전체 관리 UI를 만들기보다 기존 상태/기억 화면에서 이관 결과와 오류를 확인하는 정도로 연결한다.

## 9. 반드시 입증할 범위

1. 여러 tenant/principal, 수정된 기억, 잊힌 기억, 여러 원 command receipt를 같은 ID/revision/source로 옮긴다. 일반 검색에서 보이지 않는 행도 누락되지 않는다.
2. source/backup/target의 정본·receipt·index 대조 실패, oversized seed, foreign/shared/unowned source, 잘못된 target/owner/storeId를 전환 전에 거절한다. hot-journal 복구가 필요한 source는 자동 정리하지 않는다.
3. 실제 별도 프로세스 SIGKILL을 백업 후보, source fence, seed/witness, activation 전후에 주입한다. 동일 operation 재개 결과와 원 `FileMutationFault` 상태·cause를 기록한다. 정전·네트워크 파일시스템 검증으로 확대 해석하지 않는다.
4. 동시 두 이관은 한 operation만 진행하고, 구버전/기존 scoped handle의 source 개인 쓰기 및 구버전 재오픈은 거절된다. 새 엔진의 work 파티션은 보존된다.
5. session 원문·compact 요약·work 상태/revision·장부·agentId가 불변이다. 모델·MCP·메신저 호출 없이 새 target의 기억 조회·정정·잊기와 원 영수증 중복을 검증한다.
6. 활성화 후 오류가 SQLite fallback을 만들지 않는다. 이전 기억 선택/ref는 기존 현재성 검사를 거치며 삭제/철회된 기억이 되살아나지 않는다.

형식 seed, schema fence, activation, backup helper와 관리 명령은 구현 후 검증 중이다. 실제 사용자의 DB에는 적용하지 않았다. 첫 단위의 fence 이후 취소 제외와 기존 프로세스 읽기 중단을 보장하지 않는 경계는 맨 위 결정을 따른다. 기존 D1/D2를 다시 만들거나 C04 이후를 파일 이관 확장 때문에 무기한 미루지 않는다.

구현 중 확인한 조회 경계: `profile.status=ready`는 담당 설정이 준비됐다는 뜻이다. 일반 상태 조회·복제는 SQLite를 열어 WAL/SHM을 새로 만들지 않는다. 저장된 activation으로 현재 선택을 표시하되, 실제 저장소 열기와 직접 기억 bind는 state의 기존 모순/소유 검사를 통과한 뒤, 새 배정 기록이나 DB를 만들기 전에 현재 source fence를 대조한다. 활성화된 담당의 폴더 이동은 현재 경로의 같은 ID·owner·fence·manifest로 확인하며 원 operation의 경로는 이력으로 남긴다. 이관 도중에는 원 경로를 유지한다.

오프라인 전제는 `--offline-confirmed --effects-reconciled`로 운영자의 확인을 기록한다. 값을 생략하면 apply를 거절한다. 이 표시는 기존 모든 프로세스와 외부 효과를 자동으로 탐지했다는 증거가 아니다. 실제 프로세스 종료 시험, SQL 쓰기 차단, 운영자의 확인은 결과에서 각각 구분한다.
