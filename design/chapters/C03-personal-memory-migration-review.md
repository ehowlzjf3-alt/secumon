# C03 D3 — 개인 기억 이관 착수 전 검토

2026-09-07 · 현재 소스의 읽기 전용 검토 · D3 미구현

[D3 이관 계획](C03-personal-memory-migration-plan.md)을 현재 C01·D1·D2 연결과 대조했다. 아래의 **확인한 사실**은 소스에서 읽은 동작이고, **권장 결정**과 **검증할 경계**는 앞으로 구현할 내용이다. 실제 SQLite 사용자 자료를 조회하거나 백업·이관·복원 시험을 수행하지 않았다. 현재 별도로 진행하는 D2 초기화 오류 진단의 원인이나 해결 여부를 이 문서에서 판단하지 않는다.

검토 범위는 한 담당의 SQLite 개인 파티션 전체를 같은 담당의 문서 정본으로 옮기는 첫 단위다. 업무 기억·세션 원문·작업 상태를 다시 구현하거나 D1/D2를 재작성할 필요는 없다.

## 1. 초기 설정과 실제 사용 중인 저장소를 구분해 전달한다

**확인한 사실.** [file-agent-profile.ts:61](../../runtime/src/infrastructure/file-agent-profile.ts#L61)은 저장된 config와 setup-operation의 개인 저장 선택이 같은지 검사한다. 반면 [local-profile.ts:67](../../runtime/src/presentation/local-profile.ts#L67)은 반환된 config가 schemaVersion 2인지 보고 문서 초안 기능을 켜며, [file-agent-profile.ts:214](../../runtime/src/infrastructure/file-agent-profile.ts#L214)의 clone도 source.config로 새 담당의 backend를 정한다. 따라서 라우터만 문서로 전환하면 초안 기능과 clone이 초기 SQLite 설정을 계속 따를 수 있다.

**권장 결정.** 초기 config/setup/assignment는 원 bytes와 의미를 보존한다. 검증된 activation을 반영한 `effectivePersonalMemory`, 즉 **현재 사용할 개인 저장소 선택**을 한 곳에서 조립해 상태 표시·저장소 라우터·초안 기능·clone에 전달한다. 이 선택을 어디에 반환할지는 착수 때 타입 계약으로 고정한다. 원 config를 검사하는 기존 규칙을 완화하거나 서로 다른 소비자가 activation을 각자 해석하게 하지 않는다.

**재사용과 검증.** [agent-stores.ts:35](../../runtime/src/infrastructure/agent-stores.ts#L35)의 배정 결과 연결과 기존 `AgentKnowledgeRepository`를 재사용한다. 이관한 담당을 다시 열었을 때 현재 문서 선택이 모든 표면에서 일치해야 한다. clone은 현재 backend를 따르되 새 agentId/storeId를 받고, 기억·원 이관 자료·activation을 복사하지 않는 기존 새 담당 의미를 유지한다.

## 2. 구버전 쓰기 차단과 오프라인 확인을 별도 조건으로 둔다

**확인한 사실.** [sqlite-knowledge.ts:67](../../runtime/src/infrastructure/sqlite-knowledge.ts#L67)의 schema/owner 검사는 [선택 경로:121](../../runtime/src/infrastructure/sqlite-knowledge.ts#L121)에서 다시 호출된다. commit은 [같은 파일:168](../../runtime/src/infrastructure/sqlite-knowledge.ts#L168)의 SQLite 쓰기 transaction 안에서 선택을 검사한다. [기존 은퇴 trigger:113](../../runtime/src/infrastructure/sqlite-knowledge.ts#L113)는 과거 테이블에 INSERT/UPDATE/DELETE가 계속 들어가는 것을 막는 선례다. 현재 소스에는 D3 fence나 이관 실행 gate가 없다.

**권장 결정.** 새 실행과 이관 관리 작업의 동시 진입은 담당 owner와 operation을 검증하는 최소 배타 경계로 막는다. 실행 gate는 [agent-stores.ts:35](../../runtime/src/infrastructure/agent-stores.ts#L35)의 상태·기억 배정과 DB 생성보다 먼저 검사한다. SQLite의 새 호환 버전 검사와 개인 파티션 은퇴 gate에는 위 코드를 재사용한다. UPDATE로 개인 파티션에 들어오거나 빠져나가는 경우에는 NEW만 아니라 OLD의 소유 범위도 검사해야 하며 DELETE도 포함한다. 업무 파티션은 새 엔진에서 계속 사용할 수 있어야 한다.

**아직 확정할 부분.** 이미 열린 구버전 handle의 쓰기를 차단하는 것은 실행 중인 프로세스·모델·외부 효과가 모두 멈췄다는 증명이 아니다. 첫 지원은 오프라인 이관으로 유지하고, 기존 프로세스 종료와 미대조 효과 부재를 어떤 지원 절차로 확인할지 정해야 한다. gate 파일이나 PID 부재만으로 종료를 입증했다고 표시하지 않는다. 구버전 재오픈 거절과 기존 handle의 쓰기 거절도 각각 검증한다.

## 3. 첫 단위에는 fence 이후 취소를 넣지 않는다

**확인한 사실.** [agent-memory-profile.ts:43](../../runtime/src/infrastructure/agent-memory-profile.ts#L43)은 SQLite 배정 상태에서 documents 폴더나 문서 ready가 발견되면 거절한다. 계획에 제시된 “부분 target은 보존하고 SQLite로 돌아가기”는 현재 배정 규칙만으로 실행할 수 없다. 단순히 source gate만 풀면 다음 정상 열기가 다시 실패한다.

**권장 결정.** 첫 D3에서는 source fence 이후 취소를 제외하고, 같은 operation ID·source·target·manifest로 재개하는 경로를 제공한다. fence 전 preview를 중단하는 것은 허용한다. 부분 target을 지우거나 최초 assignment를 삭제해 취소한 것처럼 만들지 않는다.

**후속 경계.** 취소를 나중에 지원할 경우에만 cancelled operation에 속한 비활성 target을 배정 검사가 구별하게 한다. 취소와 activation이 동시에 실행될 때 파일 부재 확인만으로 양쪽이 진행하면 안 된다. 같은 source operation의 영속 상태를 CAS로 결정하고, activation이 게시되었거나 게시 여부가 불명확하면 SQLite로 되돌아가지 않아야 한다. 이 취소 계약은 이번 구현 범위가 아니다.

## 4. seed 형식은 영수증 무결성과 전체 용량까지 고정한다

**확인한 사실.** [sqlite-knowledge.ts:103](../../runtime/src/infrastructure/sqlite-knowledge.ts#L103)의 영수증 테이블은 command ID별 기본 키를 갖지만 record에 대한 외래 키나 revision별 UNIQUE 제약은 없다. [receipt 조회:158](../../runtime/src/infrastructure/sqlite-knowledge.ts#L158)는 digest/revision을 반환할 뿐, 모든 영수증과 정본의 관계를 전수 검사하지 않는다. 정상 commit은 [같은 파일:176](../../runtime/src/infrastructure/sqlite-knowledge.ts#L176)에서 revision을 확인하고 정본·head·색인·audit/receipt를 한 transaction에 저장한다. 이는 실제 DB에 오류행이 있다는 뜻이 아니라, importer가 SQL 제약만 믿을 수 없다는 의미다.

**권장 검증.** 관리용 snapshot 열거는 정본·영수증·head·색인의 소유 범위를 함께 대조한다. 정본 없는 영수증, 같은 기억에서 충돌하거나 빠진 revision, 보존한 변경 수와 head의 불일치, 지원하지 않는 audit 형식은 preview에서 명시 거절한다. 감사 데이터에 없는 과거 본문이나 명령 내용을 생성하지 않는다. `parseKnowledge`, [validateDocumentRecord:32](../../runtime/src/infrastructure/document-knowledge-codec.ts#L32), [D1 witness 대조·복구:81](../../runtime/src/infrastructure/document-knowledge.ts#L81)를 재사용하고 일반 commit의 revision+1 규칙은 그대로 둔다.

**아직 확정할 부분.** 초기 seed의 정확한 wire schema, audit의 수용 규칙, SQLite backup 후보의 수명과 source/backup 전체 용량 상한은 미확정이다. 계획의 파일·namespace 한도뿐 아니라 [documentLimits.roots:11](../../runtime/src/infrastructure/document-knowledge-codec.ts#L11)과 [root 검사:98](../../runtime/src/infrastructure/document-knowledge-owner.ts#L98)도 preview에 반영해야 한다. namespace마다 정본과 witness 경로가 생기므로 여러 tenant/principal을 합친 전체 경로 수를 계산한다. 이관 직후 다음 정상 변경을 게시할 공간도 남겨야 한다. 특정 숫자나 백업 API 사용 방식을 검증 완료로 간주하지 않는다.

## 5. source 결손과 과거 백업 치환은 일반 bind 전에 거절한다

**확인한 사실.** [bindAgentDatabase:71](../../runtime/src/infrastructure/agent-database-owner.ts#L71)은 파일이 없으면 새 파일을 만들 수 있고, 빈 DB이면 owner를 배정한다. 기존 owner가 같은 agentId라는 사실만으로는 그 DB가 activation에 연결된 source snapshot인지 알 수 없다. 이관 후 `memory.sqlite`만 과거 백업으로 교체하거나 잃어버린 경우를 정상 새 DB 초기화에 맡기면 이관 fence와 업무 기억이 유실된 상태를 숨길 수 있다.

**권장 결정.** 이관 operation/fence/activation이 있는 담당은 일반 bind를 호출하기 전에 기존 source의 owner·fence·snapshot 연결을 검사하고, 결손이나 불일치를 복구 필요로 거절한다. 기억 DB에는 업무 파티션도 있으므로 문서 target이 살아 있다는 이유로 빈 SQLite를 새로 만들어 계속하지 않는다. [inspectAgentDatabaseOwner:56](../../runtime/src/infrastructure/agent-database-owner.ts#L56)의 읽기 전용 owner 검사와 hot-journal의 `agent_storage_recovery_required` 의미를 재사용한다. 이 검사는 SQLite 조정용 sidecar가 절대 생기지 않는다는 보장이 아니다.

**복원 검증 경계.** fence 이전 백업으로 source만 교체한 경우, main/sidecar의 일부 유실, activation 후 target의 손상·누락, activation 게시 직후 동기화 실패를 각각 구분한다. [agent-memory-profile.ts:58](../../runtime/src/infrastructure/agent-memory-profile.ts#L58)의 “ready 이후 누락된 문서 저장소를 재생성하지 않음”과 기존 게시 오류·원 cause 보존을 재사용한다. 조용한 SQLite fallback, 문서 재초기화, sidecar 삭제, schema 자동 하향으로 복원했다고 처리하지 않는다.
