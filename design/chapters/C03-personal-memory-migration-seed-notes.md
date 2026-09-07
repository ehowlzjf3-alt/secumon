# C03 D3 — SQLite 개인 기억의 초기 이관 기록 형식

2026-09-07 · 다음 구현의 계약 제안 · **형식·importer 미구현, 실제 DB 조회·이관·시험 미실행**

[D3 이관 계획](C03-personal-memory-migration-plan.md)과 [착수 전 코드 검토](C03-personal-memory-migration-review.md)의 초기 기록 부분을 구체화한다. 범위는 C01의 단일 agent 소유 SQLite 개인 파티션 전체를 같은 담당의 신규 문서 저장소로 옮기는 한 방향 이관이다. 업무 기억·사용자 대화·작업 상태·agentId를 바꾸지 않는다. 백업 파일 게시와 source fence/activation은 D3의 별도 연결이며, 이 문서는 그 사이에 넣을 seed 형식과 저장소 해석을 정한다.

여기서 **seed**는 과거 변경을 재실행하지 않고 가져오는 초기 상태, **prefix**는 namespace 앞부분에 놓인 초기 파일 묶음, **wire 형식**은 파일에 실제 저장할 데이터 구조를 뜻한다. 구현 파일·오류 이름은 제안이며 현재 API에 존재한다고 읽지 않는다.

## 1. 현재 코드에서 재사용할 사실

- [sqlite-knowledge.ts](../../runtime/src/infrastructure/sqlite-knowledge.ts)의 `knowledge_records_v2`는 기억별 최신 JSON만 보관한다. `knowledge_receipts_v2`는 모든 command별 digest/revision과 개인 변경의 `audit_body`를 보관한다. audit에도 과거 제목·본문 전체는 없다.
- 같은 파일의 `commit()`은 정본·receipt/audit·head·개인 색인을 한 transaction에 반영한다. receipt의 SQL 기본 키는 scope+기억 ID+command ID다. record 외래 키와 receipt revision별 UNIQUE가 없으므로 내보낼 때 관계를 직접 검증해야 한다.
- [document-knowledge-codec.ts](../../runtime/src/infrastructure/document-knowledge-codec.ts)의 `parseKnowledge`, `validateDocumentRecord`, `validateDocumentTransition`, 본문 분리와 digest 계산을 재사용한다. 일반 변경의 `expectedRevision + 1` 검사를 seed 때문에 완화하지 않는다.
- [document-knowledge.ts](../../runtime/src/infrastructure/document-knowledge.ts)의 `#scan`, `#snapshot`, `#sync`, `#publish`는 물리 파일 순번·원 bytes 해시·별도 witness·읽기 재개의 barrier를 이미 처리한다. `get/receipt/indexHead/candidates`는 같은 검증된 snapshot을 이용한다.
- [document-knowledge-owner.ts](../../runtime/src/infrastructure/document-knowledge-owner.ts)의 `DocumentFiles`는 private 파일, 안전한 이름·상한, 정확한 게시 후보와 2-link 관계, 경로 재확인, no-overwrite 게시를 연결한다. 이는 POSIX 경로 재확인 보장이며 Windows native 지원이나 모든 자식 경로의 고정 handle 보장은 아니다.

## 2. 저장 배열: 기억당 seed_record, namespace당 seed_head

기존 D1 v1 저장소와 v1 bytes는 그대로 둔다. **새 이관 저장소만 v2 format**을 사용한다. 한 namespace의 초기 파일은 다음과 같다.

```text
owner.json                       기존 owner 형식 그대로
import-manifest.json              이 operation의 예상 초기 prefix와 원 snapshot 지문
ns-<scope hash>/00000001.md        seed_record: 기억 A의 최신 record + A의 모든 receipt/audit
ns-<scope hash>/00000002.md        seed_record: 기억 B의 최신 record + B의 모든 receipt/audit
ns-<scope hash>/00000003.md        seed_head: 원 index head와 초기 개수
witness-<scope hash>/00000001.json 기존 {scope, sequence, digest} 형식
witness-<scope hash>/00000002.json
witness-<scope hash>/00000003.json
format.json                      모든 namespace를 대조한 뒤 마지막에 게시하는 v2 format
```

기억은 ID의 UTF-8 bytes 순으로 정렬한다. receipt는 revision 오름차순, 동률이면 command ID의 UTF-8 bytes 순으로 정렬하되 동률 revision 자체는 검증에서 거절한다. `localeCompare()`나 실행 환경의 정렬 규칙으로 bytes를 바꾸지 않는다. 기억이 없는 원 namespace에 정상 head만 존재하면 `seed_head` 한 개를 쓴다. 원 DB의 어느 표에도 없는 scope를 만들지 않는다.

`import-manifest.json`은 본문 정본을 복제하지 않는 검증 자료다. `seed_record`의 `KnowledgeRecord.body`가 Markdown 본문이며, metadata 안에 별도 `body` 필드를 두지 않는다. 출처의 `quote`와 감사 데이터는 원 schema대로 보존하므로 물리적으로 같은 글자가 한 번만 나타난다는 보장은 하지 않는다. 원 SQL JSON 문자열은 검증한 백업에 남기고 seed에는 그 원 문자열의 UTF-8 SHA-256만 둔다.

### 2.1 제안하는 정확한 필드

아래는 저장 형식의 타입 표기다. `Hash`는 소문자 64자리 SHA-256, `Count`는 음이 아닌 safe integer다. `Scope`는 현재 `DocumentNamespace`의 tenantId/agentId/principalId 및 고정 personal partition/namespace를 그대로 사용한다. 모든 객체는 알 수 없는 필드를 거절한다.

```ts
type ImportedReceipt = {
  commandId: string;       // 현재 documentName 범위
  digest: Hash;           // 원 SQL 문자열 그대로. 다시 계산하거나 대소문자 변환하지 않음
  revision: number;       // 양의 safe integer
  auditJson: string;      // 원 audit_body 문자열 그대로. 별도로 현재 audit 형식 검증
};

type SeedRecordPayload = {
  kind: 'seed_record'; operationId: UUID; snapshotDigest: Hash;
  sourceRecordJsonDigest: Hash;
  metadata: Omit<KnowledgeRecord, 'body'>;
  receipts: ImportedReceipt[];
};
type SeedHeadPayload = {
  kind: 'seed_head'; operationId: UUID; snapshotDigest: Hash;
  records: Count; receipts: Count; audits: Count; activeRecords: Count;
  head: { revision: Count; cursor: Count; error: null };
};
type SeedEnvelope = {
  schemaVersion: 2; scope: Scope; sequence: number; previous: Hash | null;
  payload: SeedRecordPayload | SeedHeadPayload;
  digest: Hash;
};

type ImportManifest = {
  schemaVersion: 1; kind: 'sqlite-personal-snapshot-v1';
  operationId: UUID; agentId: string; storeId: UUID;
  snapshotDigest: Hash;
  source: {
    mode: 'agent'; ownerDigest: Hash;
    knowledgeSchemaVersion: 2; scopedSchemaVersion: 1;
    backupDigest: Hash;
  };
  namespaces: Array<{
    scope: Scope;
    records: Count; receipts: Count; audits: Count; activeRecords: Count;
    head: { revision: Count; cursor: Count; error: null };
    currentRecordsDigest: Hash; receiptsDigest: Hash; indexDigest: Hash;
    prefix: { entries: number; bytes: Count; lastDigest: Hash };
  }>;
};
type ImportedStoreFormat = {
  schemaVersion: 2; format: 'immutable-markdown-namespace-v2';
  initialImport: {
    kind: 'sqlite-personal-snapshot-v1'; operationId: UUID;
    snapshotDigest: Hash; manifestDigest: Hash;
  };
};
```

`SeedEnvelope.sequence`는 양의 safe integer이며 기존 물리 기록 한도를 따른다. 파일 표현은 `<!-- secumon-memory-v2\n<JSON>\n-->\n<본문>`이다. seed_record의 본문은 최신 record의 정확한 문자열, seed_head의 본문은 빈 문자열이다. envelope digest는 기존 `documentDigest({ ...envelopeWithoutDigest, body })`, `previous`와 witness digest는 **이전/현재 파일의 정확한 bytes에 대한 SHA-256**이다. 두 해시의 의미를 섞지 않는다.

고정 입력으로 결정적인 seed bytes를 먼저 산출해 prefix의 개수·총 bytes·마지막 해시를 구한다. 그 뒤 manifest를 canonical JSON UTF-8로 직렬화하고 그 **파일 bytes**의 SHA-256을 format의 `manifestDigest`에 넣는다. seed에는 manifestDigest를 넣지 않아 상호 해시 의존을 만들지 않는다. 시각·무작위 후보 이름·실행 순서를 정본 내용에 넣지 않는다.

`snapshotDigest`는 source 개인 row의 논리 snapshot 지문이다. namespace를 scope의 canonical UTF-8 순서로 고정하고, 각 scope에서 최신 record의 ID+원 JSON 해시, 모든 receipt의 기억 ID+command ID+원 digest+revision+원 audit 문자열, 원 head, 원 index의 ID+document+원 body 해시를 결정적인 순서로 묶는다. SQL 숫자의 safe integer·텍스트 타입을 먼저 검증한다. `ownerDigest`는 읽은 C01 DB owner와 scoped binding metadata를 검증한 뒤 canonical 지문화한다. `backupDigest`는 따로 검증한 백업 파일의 bytes 해시다. source fence가 새 metadata를 추가해도 이미 고정한 개인 snapshot 지문을 바꾸지 않는다.

## 3. preview에서 먼저 거절할 자료

관리용 snapshot은 `records/receipts/heads/index` 네 표의 **scope 합집합**을 열거한다. `candidates()`나 active 조건으로 내보내지 않는다. SQL owner를 확인한 read snapshot과 검증된 백업을 사용하며, source·backup을 잘못된 새 DB로 초기화하지 않는다.

| 검증 대상 | 첫 D3의 수용 규칙 |
|---|---|
| 담당/사용자 범위 | 모든 개인 row의 tenant/agent/principal, SQL PK와 JSON, namespace가 일치해야 한다. agent-mode의 지정 agent만 허용한다. work row, shared mode, foreign scope는 seed로 들어가지 않는다. |
| 최신 정본 | `parseKnowledge()` 및 `validateDocumentRecord()` 통과, SQL id/namespace/revision과 일치. active/retracted/deleted를 모두 보존한다. 출처·quote·날짜·labels·revision/contentRevision을 바꾸지 않는다. 향후 source 형식 확장은 기존 공통 schema를 통해 받으며 seed 자체를 새로운 user-only 규칙으로 만들지 않는다. |
| 모든 receipt | 기억별 revision `1..최신 N`이 정확히 한 번씩 존재하고 command ID가 중복되지 않아야 한다. 정본 없는 receipt, 구멍·동일 revision의 여러 command·N보다 큰 revision은 거절한다. 새 ID/가짜 receipt로 보충하지 않는다. |
| 원 digest와 이름 | 현재 개인 서비스/D1의 `documentName`과 소문자 64hex digest 범위만 지원한다. SQL commit 자체는 비어 있지 않은 더 넓은 digest를 받지만, 이를 정규화하거나 새 해시로 교체하지 않는다. 범위 밖 자료는 preview의 지원하지 않는 자료로 보고한다. |
| audit | 현재 개인 SQL writer가 만든 아래 형식만 지원한다. SQL 컬럼은 nullable이지만 현재 개인 writer는 audit를 기록한다. 첫 D3는 NULL·미지 형식·잘못된 원문을 명시 거절하며 감사 내용을 생성하지 않는다. |
| head | `head.revision === 모든 receipt 수 === 각 최신 record.revision의 합`, `cursor === revision`, `error === null`이어야 한다. 계산 오버플로도 거절한다. 정상 empty namespace는 0/0/null이다. 없는 head를 기억이 존재하는 namespace의 정상 head로 간주하지 않는다. |
| 원 색인 | active 최신 record의 ID 집합, `${title}\n${body}`의 현재 NFC/en-US 소문자 정규화, index body의 완전한 record 값이 각각 일치해야 한다. 비활성·고아·누락·오래된 index row를 거절한다. 오류/지연은 별도 기존 rebuild를 선택한 뒤 새 preview로 처리한다. |

현재 `audit_body`를 파싱한 수용 형식은 다음과 같다. 원 JSON 문자열은 seed에 그대로 남긴다. 파싱 결과를 다시 직렬화해서 원 audit를 덮어쓰지 않는다.

```ts
type PersonalAudit = {
  expectedRevision: Count; revision: number; contentRevision: number;
  previousSources: SourceReference[]; sources: SourceReference[];
};
type SourceReference = {
  type: 'session_user_receipt'; session: SessionScope;
  messageId: string; sequence: number; receiptDigest: Hash;
};
```

각 audit의 revision은 receipt와 같고 expectedRevision은 revision-1이다. contentRevision은 양수이며 revision 이하, 인접 audit 사이에서 유지 또는 +1, 마지막 값은 최신 record와 같아야 한다. 첫 previousSources는 빈 배열이며 이후에는 이전 audit의 sources와 일치한다. 현재 개인 schema가 가진 source 수/SessionScope/name/sequence/hash 제한을 그대로 적용하고, 각 session의 tenant/agent/principal을 namespace에 대조한다. 마지막 sources는 현재 `sourceRefs(record)`와 일치해야 한다. audit가 보관하지 않은 workId·quote·과거 본문·과거 상태 변화까지 검증했다고 주장하지 않는다.

최신 record의 source를 현재 권한·원문에 대조하는 서비스 기능은 이관 후에도 그대로 호출된다. 가져왔다는 이유로 오래된 권한이나 철회된 출처가 다시 유효해지지 않는다. seed receipt는 과거 명령의 성공/중복 증거이며 현재 읽기 허가가 아니다.

## 4. 물리 순번과 기억/색인의 revision은 별개다

**기존 v1에도 물리 순번과 head 변경 수의 차이가 있다.** `#scan()`은 모든 파일에서 sequence를 올리지만 record 변경에서만 head.revision을 올린다. 실제로 기록된 index error/rebuild는 파일을 추가하며 head.revision을 올리지 않는다. 이미 같은 상태인 index 요청은 새 파일을 만들지 않는다.

| 실제/제안 흐름 | 물리 sequence | 개별 기억 revision | head revision/cursor/error |
|---|---:|---|---|
| 기존 v1: A 생성 | 1 | A=1 | 1/1/null |
| 기존 v1: index error → rebuild | 3 | A=1 | 1/1/null |
| v2 이관: A=4, B=2의 seed_record 둘과 seed_head | 3 | A=4, B=2 | 원 head 6/6/null |
| 그 뒤 A 정정 | 4 | A=5, B=2 | 7/7/null |
| index error 기록 | 5 | A=5, B=2 | 7/7/error |
| 새 C 생성 | 6 | A=5, B=2, C=1 | 8/7/error |
| index rebuild | 7 | 동일 | 8/8/null |

v2 seed_record 재생은 `records`와 receipt map만 채운다. 파일마다 head를 올리지 않는다. 마지막 seed_head에서 전수 대조 후 **원 head를 한 번 설정**한다. 그 뒤 일반 record/index 재생은 현재 v1과 같은 규칙을 따른다.

sequence는 파일명·해시 연결·witness·물리 개수 한도·`#synced`의 prefix 서명에만 사용한다. 개별 record.revision은 다음 CAS의 기준, head.revision/cursor는 기억 변경 수와 색인 반영 위치다. SQL이 저장하지 않은 과거 index 관리 호출 수를 복원하거나 head 숫자에서 추측하지 않는다.

## 5. 일반 포트와의 연결은 좁게 유지한다

1. `KnowledgeRepository`에는 seed/import 옵션을 추가하지 않는다. 현재 `DocumentChange`와 일반 `commit()`은 record/index만 받는다. 파일 decoder에만 별도의 저장 union을 추가하고, 관리용 importer만 seed encoder를 호출한다.
2. v2 reader는 manifest에 등록된 namespace의 처음 `prefix.entries`개를 seed로 해석한다. 기억 ID는 중복될 수 없고 seed_head는 마지막 한 개뿐이다. 모든 seed의 scope/operation/snapshot, prefix bytes/마지막 해시, 개수/head를 manifest와 대조한다. 그 뒤 seed가 다시 나오면 거절한다.
3. 이후 일반 변경은 v2 envelope의 기존 record/index payload로 저장한다. 저장소 format에 따라 encoder를 선택하며 v1 bytes는 바꾸지 않는다. v2에서 새로 생긴, manifest에 없는 namespace는 sequence 1부터 일반 record/index만 허용한다.
4. 가져온 기억이 revision N이면 다음 정정은 expected=N, next=N+1이다. 옛 command의 `receipt()`는 원 digest/revision을 반환한다. 같은 digest 재전송은 기존 duplicate, 다른 digest는 idempotency conflict다. seed 때문에 command 검증/CAS/transition/권한을 우회하지 않는다.
5. source audit는 seed에 보존하고 관리 검증에서 대조한다. 일반 receipt 포트는 지금처럼 digest/revision만 반환한다. 최신 body로 과거 revision의 record를 조회하는 새 API를 만들지 않는다.
6. manifest/format 불일치는 저장소 열기를 거절한다. 매번 모든 namespace 본문을 전수 읽는 대신, 최종 format 전 한 번 전체 대조하고 정상 조회는 선택 namespace의 초기 prefix·후속 chain·witness를 현재 snapshot 경계에서 검증한다. manifest에 있는 namespace의 완전 소실은 빈 scope로 처리하지 않는다.

## 6. 게시·중단·재개

**target owner 등록이나 문서 ready가 존재하는 것만으로 사용을 허가하지 않는다.** 초기 이관에는 별도 관리 진입점을 사용한다. 기존 v1 `registerDocumentKnowledgeStore()`로 format을 먼저 게시한 후 seed를 채우는 방법은 사용하지 않는다.

1. D3 source fence와 고정 operation/백업을 검증한 관리 importer만 target owner와 import manifest를 게시한다. 일반 constructor/inspect는 format 없는 부분 target을 계속 거절한다. 부분 상태 접근을 일반 get/commit에 열어 주지 않는다.
2. 고정 manifest에 맞는 seed bytes를 순서대로 no-overwrite 게시한다. 기존 파일은 exact bytes와 owner/link 경계를 검사한 뒤 재사용한다. manifest의 예상 prefix에 없는 파일·불일치·부분 canonical 파일은 복구 필요다.
3. complete seed 파일은 그 seed의 게시 지점이다. 파일 게시 후 witness가 없는 경우, importer는 manifest와 연속 prefix를 검증하고 **부족한 matching witness suffix만** 게시·sync한다. canonical seed를 다시 생성해 과거 prefix를 정상화하지 않는다.
4. 모든 namespace의 마지막 seed_head, prefix·witness·원 record/receipt/head/index 의미를 전수 대조하고 디렉터리 barrier를 통과한 뒤 `format.json` v2를 마지막에 게시·재검사·sync한다. format 자체가 import 완료 증거다. 별도의 seed 완료 파일이나 begin/end 상태 기계를 추가하지 않는다.
5. format이 존재해도 아직 agent의 정본 선택이 바뀐 것은 아니다. 관리 재오픈 대조 이후 D3 외부 activation이 source fence/target owner/manifest를 연결해야 한다. 초기 ready나 config를 바꾸어 activation을 대신하지 않는다.

| 중단 시점 | 같은 operation 재개의 결과 |
|---|---|
| owner/manifest/seed 후보만 있음 | 현재 host 정책으로 후보를 검증·보존한다. 이름만 보고 정본으로 인수하거나 일괄 삭제하지 않는다. 완성 여부/owner를 검증할 수 없는 후보는 기존 cleanup-required 의미를 유지한다. |
| seed link 후 witness 전 | 실제 canonical bytes가 예상 prefix와 맞을 때만 witness suffix+barrier를 완성한다. format이 없으므로 정상 사용은 계속 거절한다. |
| 일부 namespace만 완료 | 같은 manifest의 남은 namespace만 이어 간다. 다른 snapshot이나 target storeId로 재개하지 않는다. |
| canonical 중간 파일 소실/변조, witness가 prefix보다 앞섬 | 실패로 멈춘다. 누락을 새 빈 namespace나 과거 기억 상태로 해석하지 않는다. |
| format link 뒤 sync/검사 오류 | 원 `FileMutationFault`의 published/unknown 및 원 cause를 보존한다. 실패한 호출을 성공으로 바꾸지 않는다. 동일 format/manifest exact 비교와 barrier를 거친 재개만 허용한다. |
| format 완료, activation 전 | import는 완료됐지만 정상 개인 저장 실행은 아직 막혀 있다. 동일 D3 operation의 전환 검증을 이어 간다. |
| activation 이후 | 초기 seed 재입력은 금지한다. 일반 변경만 허용한다. source/target 결손을 SQLite fallback이나 새 문서 초기화로 숨기지 않는다. |

import 완료 이후에는 기존 D1의 read-side witness 보완을 재사용한다. 영수증 먼저 읽는 중복 명령도 새 일반 이벤트의 부족한 witness/barrier를 복구할 수 있어야 한다. 루트 manifest는 초기 seed 삭제를 검출하는 추가 기준이지만 외부 보관된 신뢰 anchor는 아니다. 동일 계정이 정본·witness·manifest·활성화 자료까지 함께 되돌리는 공격이나 모든 저장장치 장애를 탐지한다고 보장하지 않는다. Windows 미지원과 디렉터리 경로 재확인 한계도 유지한다.

## 7. 용량과 구현할 파일

기존 한도를 확대하지 않는다. seed_record는 원 영수증 전체를 포함해 **파일당 256KiB**, namespace는 **물리 파일 4,096개/64MiB**, 안전한 pending은 별도 **512개/64MiB**, 재시도는 **8번**이다. source의 더 작은 record/source/parser 상한도 적용한다. 큰 receipt를 페이지로 나누거나 일부만 가져오는 기능은 첫 D3에 넣지 않는다.

preview는 각 seed bytes를 실제로 인코딩해 한도를 계산하고, namespace마다 seed_head 및 **최소 다음 일반 파일 1개/256KiB 여유**를 남긴다. root 경계도 현재 `roots=4096`을 재사용한다. v1은 owner/format 두 파일 외 namespace·witness 경로를 셌다. v2에서는 추가 manifest 한 개도 같은 가변 4,096경로 안에 포함하여 root 열거 상한을 암묵적으로 늘리지 않는다. 정상 namespace/witness 쌍을 고려하고, 새 namespace 쌍 하나가 들어갈 여유도 preview에 남긴다. manifest 자체도 256KiB 이하로 제한한다. root pending allowance는 별도로 유지한다.

SQL 열거는 bounded iterator로 각 scope·기억·receipt의 실제 직렬화 크기를 누적한다. 전체 DB나 모든 row를 먼저 메모리에 올리지 않는다. 안전한 합산과 각 배열/문자열 cap을 검증하고, 제한 초과는 target 생성 전 preview에서 표시한다. snapshot/backup의 전체 파일 상한과 백업 후보 게시 수명은 별도 D3 호스트 연결에서 고정해야 하며, 이 seed 한도만으로 검증됐다고 간주하지 않는다.

| 예상 파일 | 필요한 최소 변경 |
|---|---|
| 신규 `application/personal-memory-migration-contracts.ts` | 호스트 관리용 snapshot/manifest/seed 타입과 strict schema. 일반 기억 도구의 열거 권한은 추가하지 않는다. |
| `infrastructure/document-knowledge-codec.ts` | v2 저장 envelope와 seed encode/decode. v1 bytes·일반 transition 의미 유지. |
| `infrastructure/document-knowledge-owner.ts` | v2 format/manifest 대조와 관리용 부분 import 검사. 현재 기본 v1 등록은 그대로 두고 부분 import 자동 인수 금지. |
| `infrastructure/document-knowledge.ts` | seed prefix 재생, 원 receipt와 head 초기화, format별 일반 encoder 선택. 기존 CAS/읽기 정책/chain/witness 재사용. |
| 신규 `infrastructure/document-knowledge-import.ts` | 결정적 prefix 생성·예상 bytes 게시·witness 완성·전체 대조·최종 format 게시. source fence/activation을 대신하지 않는다. |
| 신규 SQLite 관리 helper | owner 확인 후 네 표의 snapshot 열거·검증·지문. 기존 `sqlite-knowledge.ts`의 sourceRefs/정규화 의미를 재사용하되 공개 repository를 전체 관리 포트로 확대하지 않는다. 백업/fence는 D3 공통 작업과 합쳐 파일 수를 정한다. |

착수 검증은 v1 bytes 회귀, 두 기억의 서로 다른 revision/모든 receipt+audit/head 보존, index 관리 파일 뒤 일반 정정, 삭제 기억 비활성 유지, scope 격리, gap/orphan/audit/index/용량 preview 거절, 실제 seed-link→witness 및 format-link→sync 중단/재개에 한정해 묶는다. 마지막에는 기존 `KnowledgeService`와 `get/receipt/candidates`를 통해 옛 command 중복·새 정정·원문 dependency를 대조한다. 합성 source 행과 실제 SQLite/파일 수명 시험은 모델 품질 시험이 아니며, 현재 이 문서 작성에서는 어떤 시험도 실행하지 않았다.
