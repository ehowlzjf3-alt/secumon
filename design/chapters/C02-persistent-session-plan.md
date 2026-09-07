# C02 첫 구현 — 세션을 유지하며 다음 작업으로 이어가기

2026-09-07 · 현재 소스를 읽고 작성한 구현 계획 · 제품/시험/빌드 변경·실행 없음

**같은 담당과 사용자의 세션에서 작업 X가 끝난 뒤 Y를 요청하면, 최근 대화와 합의를 Y의 모델 입력으로 이어준다.** X와 Y의 목표·계획·근거·실행 영수증·자원 장부는 계속 별개다. 모델 호출이 끝나거나 프로세스가 꺼져도 세션 기록은 남는다. 문맥을 유지하기 위해 모델을 계속 호출하지 않는다.

[C02 재사용 조사](C02-reuse-audit.md)와 [전체 계획 C02](/Users/seunghanee/Documents/secumon/design/03-migration-plan.md:84)를 구체화한다. 선행 C01 A의 지원 플랫폼 검증 후 구현할 계획이며, 진행 중인 NAS 검증의 통과나 C01/C02 전체 완료를 뜻하지 않는다. 공통 스킬과 외부 모델/API 호출은 사용하지 않았다.

## 현재 연결에서 달라져야 할 점

| 현재 코드 | 확인한 동작 | 첫 구현에서 연결할 것 |
|---|---|---|
| [ConversationBinding](/Users/seunghanee/Documents/secumon/runtime/src/domain/conversation.ts:3) | 채널·대화방·사용자·전달 목적지를 연결한다. agentId/sessionId는 없다. | 인증된 담당·사용자와 지속 sessionId를 연결한다. 대화방 번호만으로 세션 접근권을 정하지 않는다. |
| [ConversationService.accept](/Users/seunghanee/Documents/secumon/runtime/src/application/conversation-service.ts:63) | binding/messageId로 workId를 정하고 state와 접수 응답을 commit한다. 입력은 구조화된 goal이며 사용자 메시지 원문 필드가 없다. | 실제 입력 원문과 입력 식별자를 먼저 영속 접수한 뒤 기존 작업 생성/명령으로 연결한다. 목표 설명을 사용자 발언으로 꾸며 복원하지 않는다. |
| [newWork](/Users/seunghanee/Documents/secumon/runtime/src/application/new-work.ts:5) | 새 목표·계획·근거·시도·장부를 작업별로 만든다. | 유지한다. 세션 연결과 적용된 입력 위치만 추가하며 X의 state 전체를 Y로 복사하지 않는다. |
| [LocalChannel](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/local-channel.ts:10) | SQLite에 전달된 응답만 저장한다. workId/deliveryId 중복을 막고 사용자·채널·대화방·labels로 조회한다. | 사용자 입력과 실제 전달된 응답을 함께 읽는 세션 이력과 영속 커서를 추가한다. 응답 원문·전달 상태의 기존 근거를 재사용한다. |
| [ContextCompiler.prepare](/Users/seunghanee/Documents/secumon/runtime/src/application/context-compiler.ts:156), [ContextFrameStore](/Users/seunghanee/Documents/secumon/runtime/src/application/context-store.ts:30) | 작업 정본에서 모델 입력을 만든다. 이전 프레임은 workId/목표/정책 등과 맞아야 한다. | 같은 세션의 허용된 문맥을 별도 입력으로 받는다. 이전 작업 프레임의 workId를 고쳐 재사용하지 않는다. |
| [ContextMemo/ContextHead](/Users/seunghanee/Documents/secumon/runtime/src/domain/context.ts:75) | memo는 항목의 포함/제외 이력이고 head는 작업 프레임을 가리킨다. 대화 요약 자체가 아니다. | 세션 문맥의 head와 작업의 contextHead를 구분한다. 이력 전체를 head에 넣지 않는다. |
| [PlanningRuntime의 의미 해시](/Users/seunghanee/Documents/secumon/runtime/src/application/planning-runtime.ts:43), [reserve](/Users/seunghanee/Documents/secumon/runtime/src/application/planning-runtime.ts:65), [adopt](/Users/seunghanee/Documents/secumon/runtime/src/application/planning-runtime.ts:231) | 목표·정책·계획 등을 고정해 늦은 응답을 검사한다. 현재 해시에 세션 입력은 없다. | 세션 필드만 추가하고 끝내지 않는다. 적용된 세션 입력 basis를 의미 해시·예약 입력·채택 검사에 포함한다. |
| [LocalWorkbench.accept](/Users/seunghanee/Documents/secumon/runtime/src/presentation/local-workbench.ts:114) | ConversationService와 별도로 newWork/ack/question을 직접 생성한다. coordinator는 프로세스 안의 WeakMap이다. | Web도 동일한 영속 접수 경로를 사용한다. 메모리 Map을 다중 프로세스 잠금이나 중복 방지 정본으로 취급하지 않는다. |
| [composeRuntime](/Users/seunghanee/Documents/secumon/runtime/src/application/compose-runtime.ts:42), [openAgentStores](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/agent-stores.ts:15) | 실행 책임과 담당별 저장소가 이미 분리돼 있다. file-journal 상태에서도 memory/channel은 SQLite다. | 세션 포트를 조합하고 C01에서 확인한 agentId를 주입한다. state backend에 따라 세션 의미를 바꾸지 않는다. |

## 식별자와 저장할 내용

`agentId`는 계속 살아 있는 담당, `sessionId`는 한 사용자와 이어가는 대화, `workId`는 그 안의 개별 업무다. 파일 경로는 담당 위치이며 ID를 대신하지 않는다. 사람의 `principalId`와 조직의 `tenantId`도 함께 검사한다.

세션 접근의 기본 키는 **tenantId + agentId + principalId + sessionId**다. 조회·추가·cursor·head·캐시·작업 연결에서 같은 경계를 사용한다. agentId는 `openAgentStores`에서 얻은 프로필로 정하고, 요청 JSON이 지정한 담당 ID를 그대로 신뢰하지 않는다. 사용자도 호스트가 확인한 actor를 사용한다. 같은 Knox 방이나 같은 문자열 sessionId를 가진 다른 사용자가 대화를 공유하는 기능은 기본으로 만들지 않는다.

| 개념/제안 이름 | 보존할 내용과 역할 |
|---|---|
| 세션 정보 `SessionRecord` | 소유 범위, 생성/명시 종료 상태, revision, 앞에 보여주는 활성 작업, 연결된 작업 목록의 조회 기준. X 완료는 세션 종료가 아니다. |
| 원문 이력 `transcript` | 사용자 원문, 구조화된 요청 종류/첨부 참조, 실제 응답 본문 또는 기존 전달 원문 참조, 역할, 수신/전달 상태, 출처 workId/messageId/deliveryId, 순서 번호. 모델 내부 추론이나 모든 tool 로그를 대화 말풍선으로 복제하지 않는다. |
| 접수함 `inbox` | 접수된 입력이 어느 작업/명령으로 적용되는지, 입력 digest와 처리 상태. 프로세스가 죽어도 다시 찾아 적용할 수 있는 기록이다. transcript와 별도 테이블이어도 같은 입력 ID로 연결한다. |
| 적용 위치 `appliedInputCursor` | 해당 작업이 실제로 반영한 입력까지의 위치. 채팅 UI가 어디까지 보여줬는지와 다르다. 입력 접수만으로 적용 위치를 앞당기지 않는다. |
| 세션 문맥 `sessionContextHead` | 이력의 어느 범위까지 반영했는지, 파생 문맥 참조/digest, head revision, 소유/정책 기준. 원문 정본이 아니라 다시 만들 수 있는 현재 창이다. |
| 작업 문맥 `WorkState.contextHead` | 기존 작업 프레임. 현재 목표·계획·근거와 선택된 세션 문맥 basis를 함께 고정한다. X와 Y는 각자의 head를 가진다. |
| 화면 조회 cursor | 어느 세션 이력 페이지까지 표시했는지. 세션 scope와 순서에 묶고 다른 담당/사용자의 cursor 재사용은 거절한다. UI cursor로 모델의 적용 위치를 갱신하지 않는다. |

`transcriptSequence`는 전체 대화 순서이고 `revision`은 CAS에 쓰는 버전이다. CAS는 ‘내가 읽은 버전이 아직 같을 때만 갱신’하는 검사다. 작업 입력 cursor, 세션 head 버전, 전체 이력 순서를 하나의 숫자처럼 혼용하지 않는다. 접수 확인·전달 상태 변경만으로 이미 실행 중인 모델 입력의 의미가 바뀌었다고 판단하지 않도록, **작업에 적용한 입력 basis**를 따로 둔다.

최근 대화는 기본적으로 해당 세션에만 속한다. 세션 유지 때문에 KnowledgeService.create를 자동 호출하지 않는다. 개인 장기기억은 담당별로 분리된 별도 저장 책임을 유지하고, 게시판·아카이브는 배치별 선택 기능이다. 과거 응답은 당시의 발언/출처로 표시한다. 과거 작업의 결론을 Y의 검증된 근거나 완료 조건으로 자동 승격하지 않는다.

## 저장 방식과 조합

첫 기본 구현은 **담당의 기존 `.secumon/channel.sqlite`를 대화 저장 영역으로 확장**한다. 세션/입력/작업 연결/head 테이블을 기존 `local_messages`와 분리한다. 연결·transaction 소유를 인프라 내부에서 정리하여 같은 DB에 있는 local 응답 영수증과 세션 응답 참조를 한 transaction으로 기록할 수 있게 한다. 기존 local_messages 본문을 세션 테이블에 다시 독립 정본으로 복사하지 않는다.

- 애플리케이션에는 `SessionRepository`와 신뢰한 세션 actor/담당 공급 포트를 둔다. SQL, 파일 경로, `DatabaseSync`를 ConversationService/ContextCompiler에 전달하지 않는다. `LocalChannel`의 전송/lookup 계약과 중복 방지를 재사용한다.
- `openAgentStores`의 channel owner 바인딩을 먼저 통과시킨 뒤 세션 저장을 연다. 파일 DB 복사에 대한 C01 소유 검증을 우회하지 않는다. row에도 scope를 넣어 다른 사용자/세션 혼합을 막는다.
- 상태가 SQLite이면 기존 state SQLite + channel SQLite, 상태가 file-journal이면 기존 파일 저널 + 같은 channel SQLite를 쓴다. **file-journal 상태 지원이 세션 이력까지 파일 저널로 구현했다는 뜻은 아니다.** 별도 세션 파일/문서·PostgreSQL 어댑터는 C03에서 같은 포트에 연결한다. 등록한 저장소 장애 때 임의 대체 정본을 만들지 않는다.
- 기존 대화 행은 지우지 않는다. sessionId가 없는 과거 작업/전달은 legacy로 읽을 수 있게 유지하되, 새 지속 세션에 자동 합치지 않는다. 같은 사용자가 명시적으로 연결한 과거 작업만 권한 확인 후 연결한다. 기존 사용자 입력 원문이 없으면 ‘원문 없음’으로 남긴다.
- `composeRuntime`에는 세션 의존성을 선택적으로 주입한다. 새 담당용 진입점은 반드시 이를 구성하고, 기존 비대화 엔진/합성 시험은 세션 없이도 동작한다. `services.inputs`는 현재 board 조합과 충돌 조건이 있으므로 세션 기능으로 덮어쓰지 말고 별도 세션 검증 포트로 연결한다.

## 하나의 실제 사용 흐름으로 끝내기

첫 단위는 저장소 메서드만 만들고 끝내지 않는다. **담당 디렉터리를 연다 → 세션을 연다/이어간다 → 원문을 접수한다 → X를 실행하고 응답한다 → 재시작한다 → 같은 세션에 Y를 접수한다 → Y의 실제 ContextPacket에서 이전 대화를 확인한다**까지 연결한다.

1. 호스트가 C01 프로필과 actor를 확인한다. sessionId를 명시하면 소유를 확인해 이어가고, 명시적 새 대화는 새 ID를 만든다. 기본 이어갈 세션 별칭도 담당·사용자·채널 경로에 묶어 영속 저장한다. 전역 `default` 한 개를 공유하지 않는다.
2. 요청 원문과 검증된 구조화 입력을 함께 접수한다. 같은 scope/messageId와 같은 digest면 원래 접수/작업 연결을 반환하고, 같은 ID에 다른 내용이면 충돌로 거절한다. 클라이언트는 재전송할 때 messageId를 유지한다.
3. 요청 종류는 첫 구현에서 `new work`, `existing work input/command`, `new session`처럼 명시적으로 받는다. X 완료 후 Y는 같은 세션의 새 work로 만들고, 기존 업무 수정은 명시 workId/목표 버전을 검사한다. 문장만 보고 의미를 해석하는 범용 모델 라우팅은 C04다. 실행 중 새 업무는 순서가 보이는 대기 입력으로 보존하고, 기존 업무 수정/취소는 기존 command 경로로 연결한다.
4. 기존 ConversationService/newWork와 WorkState commit/receipt를 사용한다. binding과 work의 conversation 정보에는 세션 scope/적용 입력 참조를 넣되 작업 저장 형식 전체를 세션 단위로 바꾸지 않는다. Web 합성 질문 준비처럼 현재 화면 전용 초기 설정도 검증된 애플리케이션 접수 경로로 옮기고, Web이 두 번째 접수 정본을 유지하지 않게 한다.
5. 접수 사실을 한 번 표시한다. 이 표시는 durable 접수 영수증에 대응한다. 실제 작업 적용·실행·전달 완료와 구분한다. 현재 CLI가 직접 출력하는 ack와 LocalChannel ack를 같은 접수 ID에 연결해 화면과 이력에서 중복 말풍선을 만들지 않는다.
6. X의 최종 응답은 기존 ConversationService.prepare → outbox → LocalChannel로 전달한다. 응답 이력에는 실제 표시된 text, 전체 artifact 참조, 출처 workId/goalRevision과 전달 상태를 연결한다. 준비된 응답·unknown 전달을 ‘사람에게 전달됨’으로 바꾸지 않는다.
7. Y의 ContextCompiler는 현재 작업 정본에 같은 세션의 최근 원문/응답과 세션 문맥 참조를 추가한다. 보호해야 할 현재 요청·명시적 제약은 임의 제외하지 않는다. 반환 packet/inputArtifact의 bytes를 실제로 검사하는 합성 planner로 연결을 확인한다.

현재 [agent CLI](/Users/seunghanee/Documents/secumon/runtime/src/presentation/agent-cli.ts:11)는 setup/status 중심이며 대화 실행 미연결을 표시한다. [기존 실행 CLI](/Users/seunghanee/Documents/secumon/runtime/src/presentation/cli.ts:111)와 [local-profile](/Users/seunghanee/Documents/secumon/runtime/src/presentation/local-profile.ts:25)는 합성 실행 기반이다. 첫 단위에서 이 실행 조합에 **C01 담당 저장소/세션을 전달하는 경로**를 연결한다. 임의 폴더의 synthetic 상태를 담당의 실사용 저장으로 오인하지 않는다. Web도 같은 세션 접수를 사용하고, sessionId/new-session 선택과 이력 조회의 최소 UI 연결을 포함한다. CLI/Web 전체 UX, Knox 실제 연결과 자연어 답변 품질은 C06/C04로 남긴다.

## 이력·작업 저장소 사이의 중단 처리

state와 channel SQLite가 서로 다른 DB이고 file-journal도 지원하므로 하나의 전역 SQL transaction이라고 가정하지 않는다. 재실행 가능한 접수 절차를 사용한다.

| 중단 위치 | 영속 기록과 재개 |
|---|---|
| 입력 접수 transaction 전 | 접수 완료로 응답하지 않는다. 같은 messageId로 재전송 가능 |
| 입력/inbox 기록 후, work 생성 전 | 기록에 고정한 workId/명령 ID로 다시 적용. 새 랜덤 업무를 또 만들지 않음 |
| work commit 후, 세션 연결 완료 전 | 기존 `StateRepository.receipt`와 동일 digest를 확인하고 세션 연결 상태만 마침 |
| 세션 연결 후 응답 전 | 같은 접수 영수증과 workId를 반환. transcript 입력/ack를 추가 생성하지 않음 |
| local 응답 저장 후 outbox 정산 전 | LocalChannel의 동일 workId/deliveryId lookup으로 확인. local 메시지와 세션 응답 참조는 같은 transaction으로 남음 |
| 프로세스 재시작 | pending inbox와 미정산 전달을 조회하여 위 절차를 재개. 비어 있는 새 세션을 암묵적으로 만들지 않음 |

세션의 입력별 적용 상태는 자신의 기대 버전으로 갱신한다. 늦게 복구된 X의 연결 완료가 이후 Y의 활성 작업 포인터를 덮지 않도록 입력 순서/현재 포인터 조건을 함께 검사한다. 세션 전체 revision 충돌 때 work를 다시 생성하는 방식은 쓰지 않는다.

여기서 ‘한 번’은 **한 입력 ID의 durable 접수·작업 명령 효과·local 응답 행이 각각 한 번만 존재하고, 끊긴 연결은 같은 ID로 복구된다**는 뜻이다. worker 실행·함수 호출·모델 호출이 물리적으로 딱 한 번이라는 뜻이 아니다. 외부 메신저 전송은 공급자의 중복 방지/조회 능력에 달려 있으며, 능력이 없으면 unknown을 보존한다. 수신자의 실제 열람도 local 저장 성공으로 증명하지 않는다.

## 문맥과 동시 입력의 버전 검사

세션 입력을 추가했다는 이유로 X의 contextHead를 삭제하지 않는다. 새 작업 Y는 자신의 frame을 만들지만 그 안에 동일 세션 문맥을 넣는다. 저장된 세션 이력과 head는 계속 이어지므로 ‘새 work = 대화 초기화’가 아니다.

- 첫 문맥 조합은 원문 기반이다. 최근 사용자·응답 구간을 제한된 크기로 읽고 출처/순서와 함께 packet에 넣는다. 모델 한도는 기존 ContextCompiler의 estimate/selection과 같이 검사한다. 첫 구현은 일반 모델로 자동 합의 요약을 만들었다고 주장하지 않는다. 필요한 내용이 창 한도를 넘으면 조용히 버리거나 새 세션으로 바꾸지 않고 명시적인 문맥 용량 상태와 재조회 참조를 남긴다. 장기 세션을 자동으로 계속 처리하는 compact는 다음 C02 단위다.
- 세션 head와 frame basis에는 `sessionId`, 소유 범위, 이력 반영 위치, head revision/digest, 관련 정책/입력 세대를 고정한다. artifact 참조 하나의 tenant/labels만 맞는다고 다른 담당/세션 문맥을 채택하지 않는다. 이전 응답을 조회할 때 현재 권한과 원출처 제한도 다시 검사한다.
- 모델 예약은 **작업에 적용된 session input basis**를 packet, inputArtifact, work의 의미 해시에 넣는다. 현재 semanticVersion 1/2는 대화 입력을 포함하지 않으므로 새 형식을 명시적으로 버전 관리한다. 이전 저장된 호출은 해당 버전으로 복구하고, basis 없는 과거 호출을 새 지속 세션 호출로 간주하지 않는다.
- 입력 수신은 먼저 durable inbox에 기록한다. ‘접수’와 ‘적용’을 구분하고, 적용할 때 기존 work revision/goal/control 검사와 함께 세션 입력 cursor/basis를 같은 work commit에 반영한다. 받은 순서대로 아직 적용하지 않은 입력이 있으면 그 세션의 새 모델 예약·응답 공개를 진행하기 전에 먼저 연결을 복구한다.
- 모델 입력 준비 중 새 입력이 적용되면 frame 게시/예약 CAS가 실패해야 한다. 모델 호출 중 목표 수정/취소가 적용되면 늦은 응답은 현재 basis/goal/control과 맞지 않아 채택하지 않는다. 이미 호출한 모델의 사용량·도구의 미확정 외부 효과는 기존 정산/복구 흐름에 남긴다.
- 세션 DB의 확인과 작업 commit이 서로 원자적이라고 주장하지 않는다. work commit이 입력 적용의 기준 시점이다. input/model 채택이 경합하면 동일 work revision/basis의 CAS 순서로 판정하고, 입력이 먼저 적용되면 이전 채택은 실패한다. 입력이 아직 inbox에만 있는 구간은 pending으로 표시하며 dispatch/outbox 전의 재확인으로 이어진다. 프로세스 안의 Map이나 lease 만료만으로 이 교차 저장 경합을 해결했다고 표시하지 않는다.
- 세션 head 후보는 기존 head revision과 이력 prefix(요약할 원문 범위)를 명시하여 CAS 게시한다. 느린 후보가 최신 head를 덮을 수 없다. 후보 준비 중 추가된 tail(나중 입력)은 별도로 남겨 다음 조합에 반드시 포함한다. CAS 실패로 원문 cursor를 앞당기거나 tail을 버리지 않는다. 첫 단위에는 stale head/새 tail 보존 계약과 합성 경합 시험을 포함하고, 실제 의미 요약·반복 compact 알고리즘은 후속에서 검증한다.

세션 문맥 검사만으로 이미 전송 중인 원격 도구 호출을 취소했다고 간주하지 않는다. 최신 지시 적용 이후의 dispatch·응답 공개 경계와 현재의 외부 효과 reconciliation을 유지하며, 플랫폼별 실제 중단 능력은 별도로 남긴다.

## 구현 순서와 인수 시나리오

아래는 **하나의 사용자 흐름을 완성하는 첫 구현 단위 안의 순서**다. 포트/메서드마다 새 챕터를 만들거나 저장소만 구현한 상태를 첫 단위 완료로 표시하지 않는다.

1. Session scope/원문/inbox/head/cursor 계약과 SQLite 저장을 만들고 C01 channel owner·LocalChannel 전송 기록에 연결한다. legacy를 자동 합치지 않는 전이 규칙까지 둔다.
2. ConversationService의 공통 접수/복구를 연결하고 기존 CLI·LocalWorkbench의 실제 입력과 명령을 같은 경로로 보낸다. outbox/local 전달을 세션 이력에 연결한다.
3. ContextCompiler/FrameStore/PlanningRuntime/Recovery에 세션 basis를 연결하여 Y의 실제 packet까지 전달한다. 모델 호출 없이도 조회/세션 재개가 가능해야 한다.
4. 같은 소스에서 아래 의미 시험과 기존 conversation/context/planning/workbench/state backend 회귀를 실행하고 결과를 기록한다. 로컬 합성과 실제 모델·메신저·Windows 검증을 구분한다.

| 검증 시나리오 | 반드시 확인할 결과 |
|---|---|
| A담당/U사용자/S세션: X에서 짧은 응답 형식 합의 → X 완료 → Y | Y packet에 원래 합의와 최근 응답이 source ID와 함께 존재. X/Y workId·목표·장부는 별도이고 세션 ID는 유지 |
| 프로세스 종료 뒤 같은 S로 Y 접수 | 원문/전달 이력·입력 cursor/head가 이어짐. 모델 호출로 기억을 복구하지 않음 |
| 같은 사용자/세션 문자열로 다른 담당, 같은 담당에서 다른 사용자, 명시적 새 대화 | 이력·head·작업 목록·cursor·캐시가 섞이지 않음. 위조한 agentId/actor/session 참조 거절 |
| 같은 messageId 재전송, 다른 내용 재사용, 서로 다른 두 입력 동시 접수 | 같은 내용 한 행/한 명령 효과, 다른 내용 충돌, 두 정상 입력은 모두 보존·순서 부여 |
| inbox 후/work commit 후/local 전송 후 실제 프로세스 중단 | 동일 ID/receipt로 복구. 입력·업무·응답 중복 없음. foreign 기록 변경 없음 |
| 지연시킨 합성 planner 도중 수정/취소 적용 | 이전 basis 응답은 채택되지 않고 소비한 자원은 남음. 새 요청은 누락되지 않음 |
| head 후보 준비 중 새 입력/다른 head 게시 | 낡은 후보의 덮어쓰기 거절 또는 검증된 prefix와 최신 tail 조합. cursor 앞당김·입력 소실 없음 |
| state=sqlite / state=file-journal 동일 시나리오 | 같은 세션 의미와 복구 결과. channel SQLite 유지가 명시되고 state backend 강제 이행 없음 |
| Web 접수 후 같은 세션 후속, CLI 재접속/최소 세션 선택 | 표면별 별도 newWork 접수로 되돌아가지 않음. 실제 사용자 입력 원문과 응답을 세션 순서로 조회 |
| 이력 한도·권한 축소·참조 부재 | 무제한 전량 프롬프트 주입 없음. 제한/부재를 표시하고 다른 세션이나 장기기억을 자동 대체하지 않음 |

## 이 첫 단위 이후에도 남는 인수 조건

C02 전체 완료에는 의미를 유지하는 증분 요약/반복 compact, 중요한 합의·미해결 의무·반증·원본 참조 보존, compact 도중 입력·취소·중단의 전체 경합 시험이 추가로 필요하다. 첫 단위의 최근 대화 전달 시험을 이 품질 시험으로 바꾸어 설명하지 않는다.

범용 자연어 업무 분류·메인 응답 프롬프트·사내 모델 호환/품질은 C04, 개인 장기기억·문서/PostgreSQL 세션 저장 확장은 C03, 채널 전체 UI·Knox 실제 연결은 C06에 남긴다. Windows 실제 저장 경계 검증도 C01 잔여 조건이다. 이번 문서는 그 기능이나 현재 진행 중인 NAS 전체 시험의 성공을 주장하지 않는다.
