# C02 compact 이후 감사와 다음 사용자 가치 단위

2026-09-07 · 초기 코드/계획 감사와 최종 검증 연결 · 전체 챕터 완료 기록 아님

**최종 Linux 전체 2,836/2,836, compact 46/46 통과와 전용 시험 프로세스 0개·SSH 종료를 확인했다. C03의 “이 내용은 기억해 → 같은 담당의 새 대화에서 회상 → 정정/잊기”에 착수할 범위별 gate를 충족했다.** [최종 근거](../../runtime/evidence/C02-compact-verification.json)와 [결과](C02-session-compact-result.md)에 따른 갱신이다. C03 구현, C01/C02 전체, 전체 goal의 완료를 뜻하지 않는다. 다음 성과는 기본 SQLite의 사용자 흐름이며 저장 어댑터 전면 재작성이나 공통 helper 추가가 아니다.

## 1. 이번 감사에서 확정한 것과 확정하지 않은 것

- 초기 감사 당시 [03-migration-plan.md](/Users/seunghanee/Documents/secumon/design/03-migration-plan.md:84)와 [implementation-backlog.json](/Users/seunghanee/Documents/secumon/design/implementation-backlog.json:2361)은 C02를 진행 중, C03을 계획 상태로 두었다. C02의 `persistent_session_progress.compact=not_implemented_in_this_unit`는 **이전 지속 세션 첫 단위**의 범위 설명이다. 이를 최신 compact 코드의 부재로 읽으면 안 된다. 이번 문서 갱신은 백로그를 변경하지 않는다.
- 현재 소스에는 요약 저장·검증·호출 정산·세션 문맥 조합·CLI/Web 연결이 있다. 아래 “구현 있음”은 해당 경로를 코드에서 확인했다는 의미다.
- 초기 [C02-compact-targeted1.log](/Users/seunghanee/Documents/secumon/runtime/evidence/C02-compact-targeted1.log:47)는 **46개 중 42개 통과, 4개 실패**다. 반복 수동 compact의 SQLite/파일 저널 및 설치 CLI에서 `token_budget_exhausted` 3건, 자동 compact 채택 기대 실패 1건이 기록되어 있다. 수정 전 결과와 원로그를 보존한다.
- 그 첫 빌드의 sourceDigest는 `372829417018ca7b5a63ad95a42cc7d4f586909299a0c11786f03f5f5499d73f`다. 첫 NAS는 build2 `cc3847d78e929914c9e37ddca46e45fa533eead0cda8dc5796ee3043d364afcb`에서 **2,830/2,831·실패 1**이었다. 최초 NAS의 정확한 throw 줄은 미확정이다. 이후 동일 오류 경로의 고정 재현·수정과 최종 통과를 최초 로그의 완전한 원인 특정으로 바꾸어 쓰지 않는다.
- 최종 sourceDigest `2193685e0a64d0f88e40113b2838afc03c8c24b8430d6a6c36847613b77e0967`에서 Linux 전체 **2,836/2,836**, compact **46/46**, build·core typecheck·계층 137개/위반 0·CLI 경계·fixture가 통과했다. 최종 원로그와 정리 결과는 검증 JSON에 연결되어 있다. build2의 브라우저·합성 계측 1회는 각 pin의 관측이며 최종 소스의 재검증은 아니다.
- 실제 모델/API 실험은 중단 상태다. 정확 인용을 생성하는 합성 provider의 통과는 임의 모델의 의미 보존, 좋은 반론 생성, 토큰 절감률을 입증하지 않는다. 이번 감사에서는 빌드/시험/NAS 접속을 실행하지 않았다.

## 2. 네 가지 관심사를 섞지 않기

| 관심사 | 현재 코드에 있는 것 | 아직 남은 것 또는 이번 범위 밖인 것 |
| --- | --- | --- |
| 사용자 대화 보존과 의미 compact | `SessionService`의 접수/적용 입력, `SqliteSessionRepository`의 원문 참조·수신함·원문 head, 별도 immutable summary/물리 head/게시 영수증, `SessionCompactor`의 요약+최근 원문 조합. 요약 끝은 현재 적용 입력보다 앞이며 원문을 삭제하지 않는다. 최종 등록된 compact 46개가 통과했다. | 합성 인용 규칙 밖에서 모델이 중요한 합의·반론·수치를 올바르게 선별하는지는 미검증. 등록 시험의 통과가 C02의 모든 설계 인수 조건을 충족한 것은 아니다. |
| 도구·지침·결과의 활성 문맥 축출 | `selectContextItems`의 full/reference/omitted 선택, 90%/70% 수위, 최소 체류 2회·미사용 3회, 최대 128개 선택 메모. compiler는 사용 표시/필수 도구/버전/재조회 경로와 축출·재로딩 계측을 사용한다. | “일주일 미사용”처럼 실제 시간·업무 변화에 따른 적응 정책과 실제 절감 측정은 별도다. 도구 목록/스킬 호출의 전체 최적화는 C05다. 현재 알고리즘을 C02 때문에 다시 만들 필요는 없다. |
| 필수 업무 상태 보호 | 목표·정책·가설·의무·자원 장부·필수 근거·미정산/unknown 시도·외부 효과 참조를 compiler의 보호 digest와 복구 경로에 포함한다. WorkState에 전체 실행 상태를 보존하고 모델에는 필요한 현재 부분을 구성한다. | 자연어 요약을 이유로 완료 의무나 검증된 근거를 새로 발급하는 기능은 없다. 대화 속 반론 보존과 독립 반론을 생성·평가하는 능력은 다르며 후자는 C04/C08의 모델·협업 작업이다. |
| 개인 장기기억과 대화/복구 분리 | C01 `openAgentStores`는 상태 저장, `channel.sqlite`, 개인 memory DB, artifacts/workspace를 분리하고 DB owner를 확인한다. `KnowledgeService`에 생성·읽기·검색·정정·철회·삭제·색인과 의존성 검사가 있다. compact는 이 저장소에 자동 등록하지 않는다. | 새 대화에서도 사용할 기억을 고르는 실제 사용자/에이전트 등록 경로, 사용자 발언을 출처로 보존하는 계약, 담당 ID를 포함한 논리 참조와 공유 저장 어댑터 격리. 문서 기억/PostgreSQL은 아직 구현된 어댑터가 아니다. |

주요 구현 연결:

- [session-compactor.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/session-compactor.ts): `previous`, `snapshot`, `prepareCompact`, `validateCandidate`, `publishCompact`. 동일 범위의 미채택 최신 후보를 지나 이전의 사용 가능한 버전을 조회하며, 기록이 존재하는 것과 creator model call이 채택된 것을 구분한다.
- [session-originals.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/session-originals.ts): `read`/`manifest`가 원문·출처 정책·데이터 세대·인용을 확인한다. 요약만 이어 읽고 원문 검사를 생략하는 경로로 바꾸지 않는다.
- [sqlite-sessions.ts](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/sqlite-sessions.ts): `history`의 `(afterSequence, throughSequence]` 구간, summary의 독립 head/CAS/영수증/과거 prefix 보존. 같은 cutoff를 새 버전으로 대체해도 이전 기록을 보존한다.
- [planning-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/planning-runtime.ts): `requestCompact`/`adoptCompact`; 기존 예약·호출·응답·사용량 수명 안에서 별도 목적 `session_compact`를 처리한다. [workflow-runtime.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/workflow-runtime.ts)는 필요한 compact를 실제 작업 전에 진행한다.
- [context-selection.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/context-selection.ts), [context-compiler.ts](/Users/seunghanee/Documents/secumon/runtime/src/application/context-compiler.ts): 미사용 내용 선택과 필수 입력 보호는 기존 재사용 지점이다. `ContextMemo.mode='compact'`와 세션 의미 요약을 같은 저장 개념으로 취급하지 않는다.

## 3. C02 잔여와 C03 착수 조건

C02 반복 compact의 **현재 소스에 대한 등록 시험과 NAS 정리는 끝났다.** 수동/자동 compact, 취소·지연 응답, 원응답 저장 후/게시 후 강제 종료 복구, 반복 X/Y/Z 문맥과 원문/사용량 보존은 해당 구조 시험의 범위에서 확인했다. 첫 실패·고정 재현·수정·최종 결과를 서로 다른 근거로 보존하며 변화 없이 전체 시험을 다시 반복하는 작업은 제안하지 않는다.

CLI/Web은 최종 등록 시험의 결과와 build2 실제 브라우저 관측을 구분한다. 실제 브라우저·계측을 최종 pin에서 다시 실행했다고 쓰지 않는다. 지속 세션 첫 단위의 과거 결과와 `not_implemented_in_this_unit` 기록도 보존한다. 전체 계획/백로그는 별도 소유 문서이며 이번 갱신에서 편집하지 않았다.

C03의 [개인 기억 계획](C03-personal-memory-plan.md)에 정한 **명시적 등록·선택적 회상·정정·잊기 범위의 진입 gate는 충족했다.** 다음 경계를 유지한다.

1. 지원되는 POSIX의 담당 ID·DB owner·저장 루트는 C01에서 재사용한다.
2. C02의 원문/세션/요약 구분과 반복 복구의 현재 등록 검증을 다음 단위의 근거로 삼는다. 기억 저장이 참조할 원문 receipt를 재구현하거나 대화 요약을 정본으로 대신하지 않는다.
3. Windows native의 미검증·호스트 실행 격리는 해당 플랫폼 배치의 잔여로 남긴다. 이 미확보 상태를 숨기지 않되 독립적인 SQLite 기억 구현을 무기한 막는 사유로 만들지 않는다.
4. 실제 모델 품질 미검증은 계속 표시한다. 외부 호출 중단 상태에서 저장·격리·명시적 기억 등록의 C03 구조를 구현하는 것은 가능하다.

범위별 진입 조건의 충족은 C01/C02 전체나 전체 goal의 완료를 뜻하지 않는다. 실제 모델/API 중단과 네이티브 Windows 미검증, 호스트 격리·C02 잔여 인수 항목은 유지한다. 이번 갱신은 C03 구현이나 백로그의 상태/의존성을 변경하지 않았다.

## 4. 다음 단위 하나: 담당의 명시적 기억이 새 대화에서 이어지고 정정되는 흐름

사용자 경험은 다음과 같다.

> 담당 A에게 “앞으로 답변은 한국어 세 문장으로 해. 이 설정은 기억해”라고 등록한다. 같은 담당에서 새 대화와 새 작업을 열면 필요한 기억만 조회해 현재 입력에 연결한다. 사용자가 “이제 자세히 설명하도록 바꿔” 또는 “이 기억은 잊어”라고 하면 정정/삭제가 이후 검색과 이미 불러온 기억의 현재성 검사에 반영된다. 담당 B와 다른 사용자의 개인 기억은 바뀌지 않는다.

이 단위는 대화 전체 자동 저장, 세션 요약 자동 승격, 게시판·아카이브 자동 복제를 포함하지 않는다. 기억 등록은 처음에는 명시적 명령/동작으로 제공하면 모델의 자율 선별 품질과 무관하게 끝까지 검증할 수 있다. 에이전트가 스스로 필요성을 판단해 제안/등록하는 정책은 이 경로를 재사용할 수 있다.

### 실제로 추가할 연결

| 재사용 | 추가할 부분 |
| --- | --- |
| C01 담당 디렉터리·`memory.sqlite`·DB owner 확인 | 호스트가 고정하는 담당/사용자 기억 scope와 논리 reference. 사용자가 전달한 agent ID를 신뢰하거나 DB 경로를 모델 인자로 노출하지 않는다. |
| `KnowledgeService.create/get/search/revise/delete`, 저장 CAS/receipt/색인 | 기본 SQLite에서 사용할 담당 기억 서비스와 명시적 등록·정정·삭제의 CLI/Web 진입 경로. API 메서드만 추가하고 실제 채널/새 작업 사용이 빠진 채로 끝내지 않는다. |
| 기존 evidence 기반 `KnowledgeSource`와 검증 | 사용자 합의/선호를 위한 정본 출처 유형. 현재 입력 receipt의 scope/message/sequence/digest를 고정하고 “사용자가 말한 선호”로 표시한다. 대화 발언을 검증된 Evidence로 조작해 기존 source 요구를 통과시키지 않는다. |
| `core.memory.get/search`, knowledge dependency·cache·`refreshKnowledge` | 같은 담당의 허용된 개인 기억이 새 세션/다른 업무 scope에서도 선택적으로 조회되는 범위. 현재 도구는 `state.goal.scope`로 검색을 좁히므로 세션 지속만으로 이 기능이 생기지는 않는다. |
| 기억 본문/출처/버전 확인, compiler의 `retrievedKnowledge` | 정정·삭제 후 이전 검색 결과·프레임·요약 속 기억 참조를 최신 revision/부재로 판단하는 실제 연결. 새 대화 기억은 대화 원문과 따로 표시하고 현재 사용자 지시가 우선하도록 한다. |

현재 [KnowledgeRecord/TrustedKnowledgeActor](/Users/seunghanee/Documents/secumon/runtime/src/domain/knowledge.ts)와 [KnowledgeRepository](/Users/seunghanee/Documents/secumon/runtime/src/application/knowledge-ports.ts)에는 `agentId`가 없다. [SqliteKnowledgeRepository](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/sqlite-knowledge.ts)의 정본 키도 `(tenant_id,id)`다. **기본 담당별 DB의 물리 격리가 이미 있다는 사실과, 여러 담당을 같은 DB에 넣어도 안전한 논리 격리는 별개다.** 다음 연결에서 담당 식별을 reference/검색/cache 경계에 명시적으로 묶고, 공유 DB 지원은 실제 namespace/owner 계약을 구현·검증한 범위만 주장한다.

현재 [KnowledgeService.create](/Users/seunghanee/Documents/secumon/runtime/src/application/knowledge-service.ts:357)는 작업 evidence 또는 기존 기억에서 출처를 가져오고, [KnowledgeRecordSchema](/Users/seunghanee/Documents/secumon/runtime/src/application/knowledge-contracts.ts)는 출처를 최소 하나 요구한다. 따라서 단순히 `create` 도구를 노출하는 것만으로 “이 사용자 선호를 기억해”가 완성되지는 않는다. 출처 타입의 확장이 필요한 지점은 여기다. 기존 근거 기억의 검증 강도를 낮추는 방식으로 해결하지 않는다.

기존 local profile은 이미 기억 DB를 `composeRuntime`에 연결하고 `core.memory.get/search`를 제공한다. 다만 [local-profile.ts](/Users/seunghanee/Documents/secumon/runtime/src/presentation/local-profile.ts:68)의 actor/allowed scopes는 합성 시나리오 구성이며, 실제 담당 설정에서 권한을 조합하는 범용 배치 계약과 동일하지 않다.

### 이 단위의 완료 기준

- 실제 담당 A/동일 사용자/새 세션 Y에서 명시적으로 등록한 기억만 조회해 실제 ContextPacket과 저장 입력 artifact에 반영한다. 이전 세션 전체를 새 세션에 붙여 성공처럼 만들지 않는다.
- 담당 B·다른 사용자·권한 밖의 업무에는 기억 검색, 직접 ID 조회, 캐시, 프레임 재사용으로 원문이 새지 않는다.
- 정정 또는 삭제 후 재검색·재시작·기존 입력 프레임 재사용에서 이전 기억을 그대로 채택하지 않는다. “잊기”의 논리 삭제와 백업/파일의 물리 제거는 별도로 설명한다.
- 등록/정정 중 중단 후 동일 명령을 재개하면 한 번만 반영한다. 기본 SQLite만으로 사용할 수 있고 PostgreSQL 서버나 게시판이 필요하지 않다.
- 기존 대화 이력과 summary는 기억 DB에 자동 복제되지 않는다. 사용자 발언·검증 근거·기억 카드의 신뢰 의미를 보존한다.

문서 파일 기억, PostgreSQL 등록/적합성, 정본 간 이행·장애 복구는 C03의 후속 잔여로 계속 보관한다. 지금 그것들을 동시에 구현하거나, 이미 있는 tool eviction/compact/상태 저장을 다시 추출하는 계획으로 범위를 늘리지 않는다.
