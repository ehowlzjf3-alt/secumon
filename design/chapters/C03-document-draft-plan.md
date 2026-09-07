# C03 D2 — 편집한 Markdown 초안을 개인 기억 정정으로 적용

2026-09-07 · D2 지원 POSIX 검증 완료 · D3 후속 · C03 전체 진행 중

<!-- C03-D2-FINAL-PROOF: 60d7e65ea1dd57ebbb0ce5fb3268f259199e07ef36a034764b20669566c3037a -->

문서 저장을 선택한 담당에서 초안 생성 → 외부 편집기로 파일 편집 → 명시 적용 → 원문·기억 상태 확인 → 같은 ID로 재개하는 CLI/Web 흐름을 연결했다. 기본은 SQLite다. 같은 최종 소스의 NAS 실제 Linux에서 **전체 3,000/3,000·관련 306/306**을 통과했고, 원로그 8개 회수·관측 가능한 전용 시험 프로세스 0·SSH 종료를 확인했다. 다음은 D3의 기존 SQLite 개인 기억 명시 이관이며 아직 구현·검증하지 않았다. PostgreSQL·Windows 연결·문서 읽기 효율·실제 모델 품질은 남아 있고 C03 전체와 전체 goal은 진행 중이다.

[D2 구현 결과](C03-document-draft-result.md) · [최종 검증 근거](../../runtime/evidence/C03-drafts-verification.json) · [다음 D3 계획](C03-personal-memory-migration-plan.md). 아래는 착수 당시의 제안·설계 이력이다. 실제 배치는 `memory/drafts/<owner 지문>/<draftId>.origin.json`, `<draftId>.md`, `<applyId>.intent.json`의 평면 구조이며 별도 완료 파일 없이 기존 원문·정정 영수증으로 상태를 계산한다. 대상 원문만 반영하는 `inputOnly`를 연결했다. 제안 표의 다른 경로·완료 파일·일반 input/resume 설명은 현재 구현 계약으로 읽지 않는다.

[문서형 기억 계획](C03-document-memory-plan.md)의 D2를 다음 한 단위로 구체화한다. D1은 이후 같은 소스 Linux 전체 2,941/2,941·관련 199/199으로 검증했고 [결과](C03-document-memory-result.md)에 기록했다. 이 문서 자체는 D2의 구현 제안이며 전체 C03 완료를 판정하지 않는다. SQLite 개인 기억 기본값, 새 담당의 명시적 문서 선택, 업무 기억의 SQLite 저장은 유지한다.

## 1. 이번 단위가 끝났을 때 가능한 일

### 구현 준비에서 좁힌 선택

원 생성 근거(origin)와 고정 적용 내용(intent)만 영속 저장한다. 적용 준비·원문 반영·기억 반영 등의 상태를 별도 파일마다 기록하지 않고 기존 원문 접수 상태와 기억 명령 영수증에서 계산한다. 아래의 완료 기록은 첫 구현에서는 생략한다. 완료 파일 없이도 정확한 원 반영 버전을 확인할 수 있어야 한다.

파일 경계는 기존 HostMetadataFiles/HostFileMutations를 재사용하고, 초안은 문서 정본 밖 `memory/drafts`에 둔다. 작업 한 번의 편집·적용을 위해 새 저장 엔진이나 일반 작업 상태기계를 만들지 않는다.

읽기 검토에서 기존 SessionService.input이 같은 세션의 대기 입력 전체를 재개할 수 있음을 확인했다. D2는 대상 메시지만 다루는 제한된 재개 경로를 추가해 기존 처리 본문을 재사용한다. 먼저 처리할 다른 대기 입력이 있으면 명시적인 pending 상태로 멈추고, 초안 적용이 다른 새 업무를 수락하거나 실행하지 않게 한다. 기존 일반 resume 동작은 유지한다.

정정 명령 결과 조회는 `revisePersonalStatus(원래 정정 인자 전체)`로 원 receipt의 반영 버전과 허용된 현재 상태만 돌려준다. 조회는 원문을 접수하거나 정정하지 않는다. 기존 정정의 중복 응답도 최신 버전 대신 그 명령의 원 반영 버전을 반환하도록 범위를 좁혀 보완한다. 잊기·출처 소실 뒤에도 과거 성공 사실과 현재 본문 사용 가능성은 서로 다른 질문이다.

문서형 개인 기억의 현재 버전에서 편집용 `.md` 파일을 만들고, 일반 편집기로 제목·본문을 수정한 뒤 **이미 존재하는 대화와 업무를 지정해 적용**한다. 편집한 본문은 실제 사용자 입력으로 한 번 접수되고, 적용된 발언을 출처로 기억이 한 버전 바뀐다. 프로세스가 중간에 끝나도 같은 적용 ID로 원문 접수와 기억 게시를 이어서 확인한다.

초안 저장만으로는 기억이 바뀌지 않는다. 새 업무 생성, planner/tool 실행, 자동 compact, 기억의 자동 선택도 발생하지 않는다. D2는 기존 기억의 정정에 집중한다. 새 기억 생성과 잊기는 기존 명령을 사용하며, SQLite↔문서 이관·임의 파일 가져오기·자동 파일 감시·일반 문서 편집기는 만들지 않는다.

## 2. 이미 있는 계약과 실제로 부족한 부분

| 현재 연결 근거 | 재사용할 보장 | D2에서 보강할 부분 |
| --- | --- | --- |
| [local-personal-memory.ts:27](../../runtime/src/presentation/local-personal-memory.ts#L27), [동일 파일:44](../../runtime/src/presentation/local-personal-memory.ts#L44) | `new_input`은 SessionService에 원문을 적용한 뒤 `revisePersonal`을 호출한다. source message ID와 기억 command ID가 별도다. | 현재 호출 인자는 메모리에만 있다. 편집기 파일이 바뀌거나 사라진 뒤에도 같은 내용·ID·예상 버전으로 재개할 영속 적용 기록이 필요하다. |
| [session-service.ts:98](../../runtime/src/application/session-service.ts#L98), [동일 파일:69](../../runtime/src/application/session-service.ts#L69) | 같은 scope·messageId의 원문/명령 digest를 대조하고, inbox의 pending → 업무 명령 반영 → applied를 이어 간다. | 새 접수 체계를 만들지 않는다. 원래 expectedGoalRevision과 messageId를 저장해 재사용한다. 재시도 때 최신 목표 버전으로 몰래 바꾸면 같은 메시지의 digest가 달라진다. |
| [session-knowledge-sources.ts:32](../../runtime/src/application/session-knowledge-sources.ts#L32) | applied receipt, 실제 원문, 업무·세션 연결, owner와 현재 권한을 다시 검증한다. | 초안의 본문을 예전 발언의 quote로 위장하지 않는다. 편집된 본문은 새로 적용된 발언과 정확히 일치해야 한다. |
| [knowledge-service.ts:521](../../runtime/src/application/knowledge-service.ts#L521) | 개인 기억 owner, 명령 digest, base revision CAS와 현재 출처 검증을 거쳐 정정한다. | 현재 중복 분기는 **명령 영수증의 원래 revision이 아니라 현재 record.revision**을 반환한다. 정정 v2 뒤 v3 정정/잊기가 생긴 경우 D2가 v3를 자신의 결과로 표시하면 안 된다. 원 명령의 반영 버전을 읽는 작은 조회 계약이 필요하다. |
| [document-knowledge.ts:77](../../runtime/src/infrastructure/document-knowledge.ts#L77) | Markdown record+receipt가 확정점이며, get/receipt 선행 조회도 누락 witness·동기화를 복구한다. | 적용 진행 기록을 기억의 정본으로 사용하지 않는다. `기억 게시 중`이라는 표시만 보고 다시 쓰거나 성공 처리하지 않고 실제 기억 영수증을 재확인한다. |
| [local-workbench.ts:100](../../runtime/src/presentation/local-workbench.ts#L100), [동일 파일:111](../../runtime/src/presentation/local-workbench.ts#L111) | 관리 경로도 선택한 세션·업무의 권한을 확인하며, 기억 정정으로 기존 view가 숨겨져도 선택 해제/재선택이 가능하다. | 초안 적용도 같은 검사와 별도 관리 상태를 사용한다. 전체 업무 view가 최신인지가 적용 결과 조회의 유일한 조건이 되지 않게 한다. |

기존 `revisePersonal(new_input)`을 파일 읽기 뒤 한 번 호출하는 것만으로는 D2가 완성되지 않는다. **영속 적용 내용 고정, 원문 단계 복구, 원 명령의 정확한 게시 결과 확인**까지 한 흐름으로 연결해야 한다.

## 3. 파일과 ID의 역할

아래 경로와 API 이름은 구현 제안이다. 논리 owner는 `tenantId + agentId + principalId`이며 경로는 그 지문과 호스트가 발급한 UUID로 만든다. 파일에 적힌 owner나 임의 절대 경로를 권한으로 사용하지 않는다.

| 자료 | 제안 위치·내용 | 변경 의미 |
| --- | --- | --- |
| 편집 초안 | `memory/drafts/<owner 지문>/<draftId>.md` | 제목·본문만 사용자가 편집한다. 기존 문서 정본인 `memory/documents` 밖에 둔다. 검색·회상·frame에서는 읽지 않는다. |
| 생성 근거 | `.secumon/memory-drafts/<owner 지문>/<draftId>/origin.json` | 원 owner·storeId·memoryId·baseRevision·원 카드 지문과 지원 형식을 고정한다. 초안 헤더와 대조하며 사용자가 바꾼 식별 정보로 대상을 전환하지 않는다. |
| 적용 내용 | `.secumon/memory-draft-operations/<owner 지문>/<applyId>/intent.md` | 초안의 한 안정된 버전, 제목·정확한 본문·reason, 원 생성 근거, 대상 session/work, expectedGoalRevision, sourceMessageId, memoryCommandId, 전체 인자 지문을 **원문 접수 전에** 게시·동기화한다. |
| 적용 결과 | 같은 operation의 작은 완료 기록 | 검증한 원문 receipt 참조와 기억 명령의 반영 revision, intent 지문을 기록한다. 이 파일 없이 중단됐어도 실제 session/knowledge 영수증에서 복구한다. 본문은 넣지 않는다. |

`draftId`는 편집 파일, `applyId`는 명시 적용 요청, `sourceMessageId`는 대화 원문, `memoryCommandId`는 기억 정정을 구분한다. 뒤의 두 ID는 applyId에서 서로 다른 접두사로 결정적으로 만든다. 파일을 다시 열거나 응답을 다시 받는 때마다 새 ID를 발급하지 않는다. 호스트가 발급하는 최종 ID는 기존 기억 포트의 160자 한도 안에 둔다.

intent의 본문은 **실패한 작업을 재개하기 위한 고정 입력**이다. 활성 기억은 D1의 Markdown 게시 기록 하나에서만 조회한다. 대화 원문과 초안·intent에 같은 문자열이 남을 수 있으므로 물리적 중복 제거를 주장하지 않는다. D2에서 완료 기록·초안을 자동 삭제하지 않으며, 잊기 이후 이 보조 파일까지 물리적으로 지웠다고 표시하지 않는다.

편집기는 임시 파일 후 rename으로 저장해도 된다. 적용 순간 현재 경로의 private 일반 파일을 안정적으로 한 번 읽고 그 바이트를 intent에 고정한다. 적용한 뒤 편집 파일이 바뀌어도 `resume(applyId)`는 고정된 내용을 사용한다. 같은 applyId로 다른 제목·본문·reason·대상·버전을 다시 제출하면 충돌이다. 다른 편집을 적용하려면 새 적용 ID를 사용하고 현재 기억 버전부터 다시 확인한다.

## 4. 적용 및 재개 순서

1. **초안 생성:** 현재 trusted actor와 문서 backend/storeId를 확인하고 `personalKnowledge(actor).get(memoryId)`로 현재 카드를 읽는다. 원 카드의 버전·owner를 생성 근거에 묶어 초안을 게시한다. 이 단계에서는 대화, 업무, 기억 revision을 만들지 않는다.
2. **명시 적용 준비:** `draftId`, `applyId`, 이미 존재하는 `workId/sessionId`, `expectedGoalRevision`, reason을 받는다. Web은 현재 선택한 세션 경로와도 대조한다. base revision·현재 카드·수정 가능한 필드·본문 한도를 확인한 뒤 intent를 먼저 확정한다. 제목과 본문이 모두 그대로인 경우는 no-change 완료로 기록하고 입력/정정을 하지 않는다.
3. **기존 결과 우선 확인:** 재개라면 새 파일 읽기나 base revision 거절보다 먼저 같은 intent의 원 기억 명령 영수증을 확인한다. 이미 반영됐으면 원 반영 revision을 복원한다. 현재 기억이 더 높은 revision이거나 잊힌 상태라는 사실은 별도로 표시하며 과거 본문을 활성화하지 않는다.
4. **원문 접수·적용:** 아직 기억 영수증이 없으면 고정된 sourceMessageId, 본문, 원 expectedGoalRevision으로 기존 `SessionService.input`을 호출한다. 중복이면 기존 입력을 재사용하고, pending이면 기존 resume 경로로 마친다. 적용된 원문을 확인한 뒤에만 다음 단계로 간다. 새 작업을 만드는 `accept`, 세션 생성, workflow.run은 이 과정에서 호출하지 않는다.
5. **기억 정정:** 고정된 source 참조·memoryCommandId·baseRevision으로 기존 `KnowledgeService.revisePersonal`을 호출한다. 범용 source 검증과 CAS를 그대로 통과한다. D1의 게시 후 오류는 원 cause와 published/unknown 상태를 유지한다.
6. **완료 확인:** 같은 기억 명령의 영수증과 그 반영 버전을 다시 확인하고 완료 기록을 게시·동기화한다. 새 revision을 사용자가 이번 업무에서 선택할 수 있게 보여 준다. 기존 선택과 frame을 자동으로 새 revision으로 바꾸지 않는다.

처음 적용할 때 이미 목표 버전이 다르거나 업무가 끝났다면 원문을 접수하기 전에 거절한다. 준비 검사 직후 업무가 끝나는 경합은 기존 session command가 원문을 rejected로 남길 수 있다. 이 경우 기억을 고치지 않고 그 상태를 표시한다. 이미 applied된 입력 뒤 업무가 완료된 재개는 “새 입력을 보내기”와 구분하고, 저장된 원문과 현재 권한을 통해 계속 판단한다. 새 업무를 자동으로 만들거나 목표 버전을 올려 재전송하지 않는다.

다른 기억 정정이 원문 적용 직후 먼저 성공하면 CAS가 실패할 수 있다. 원문이 한 번 반영됐고 기억은 아직 바뀌지 않았다는 사실을 보존한다. 새 사용자 발언을 지우거나 같은 적용 요청을 현재 버전에 자동 재배정하지 않는다. 최신 기억에서 새 초안을 만드는 것은 별도 명시 행동이다.

## 5. 중단 경계별 체크포인트

| 중단 또는 경합 위치 | 재개에서 읽는 근거 | 결과 |
| --- | --- | --- |
| intent 후보 쓰기/게시/동기화 중 | 완전한 intent와 지문, FileMutationFault 상태 | 확정되지 않은 내용으로 원문을 접수하지 않는다. 기존 후보의 포괄 삭제는 하지 않는다. |
| intent 확정 뒤 원문 receive 전 | 같은 고정 인자 | 같은 sourceMessageId로 첫 접수. |
| 원문 receive 뒤 업무 반영 전 | SessionRepository.input의 pending, 기존 command receipt | 같은 입력의 기존 resume. 원문 행을 한 개 더 만들지 않는다. |
| 업무 반영 뒤 applied 표기 전 | 기존 업무 명령 영수증 + 같은 inbox 입력 | 같은 명령 중복을 확인하고 applied로 정리한다. |
| 원문 applied 뒤 기억 commit 전 | 원문 receipt·실제 history + 기억 명령 영수증 없음 | 원문을 재사용하여 같은 expectedRevision 정정. 권한/출처가 달라졌으면 거절하며 원문 보존. |
| Markdown 게시 뒤 witness 또는 sync 실패 | D1 record+receipt와 witness | 기존 get/receipt 복구로 게시 결과 확인. 옛 revision이나 SQLite로 우회하지 않는다. |
| 기억 반영 뒤 완료 파일/HTTP 응답 전 | 원 기억 command receipt의 반영 revision | 정정을 반복하지 않고 완료 상태 복원. |
| 완료 뒤 같은 applyId 재요청, 이후 다른 정정/잊기 존재 | 원 명령 영수증 + 현재 상태 | “이 요청은 v2에 반영됨, 현재는 v3/잊힘”을 구분한다. 현재 v3를 이 요청의 결과로 잘못 표시하지 않는다. |
| 두 프로세스가 같은 applyId로 다른 내용을 적용 | intent의 no-overwrite 게시와 전체 인자 지문 | 한 내용만 고정. 패자는 원문 접수 전에 충돌. 같은 내용이면 같은 message/command ID로 합류. |

대화 저장소와 기억 저장소를 하나의 원자 트랜잭션이라고 부르지 않는다. 의미는 **한 적용 ID의 원문과 정정이 각각 최대 한 번 반영되며, 둘 사이의 부분 완료를 영수증으로 재개한다**는 것이다. 상태 조회는 새 원문이나 revision을 만들지 않는다. 다만 D1의 논리 조회가 기존 게시의 witness·동기화를 복구할 수 있다는 저장 계약은 유지한다.

## 6. 구현할 최소 계약과 파일 경계

- **공통 초안 코덱/호스트 파일 어댑터:** 제한된 JSON 헤더와 UTF-8 Markdown 본문을 파싱한다. YAML 실행, include, HTML 렌더링을 추가하지 않는다. HostMetadataFiles 안정 읽기와 HostFileMutationScope의 private 생성·no-overwrite 게시·원 오류 보존을 사용한다. 코어에 파일 경로를 도입하지 않는다.
- **적용 조립 한 곳:** `createDraft / applyDraft / resumeApply / applyStatus`를 CLI/Web이 함께 사용한다. 기존 `local-personal-memory.ts`의 sourceReference→revise 흐름을 그대로 호출하거나 필요한 최소 부분만 공유한다. application 계층이 presentation을 import하는 역방향 연결은 만들지 않는다. 초안은 호스트 편의 기능이므로 runtime planner/executor를 새로 확장하지 않는다.
- **정확한 명령 결과 조회:** 개인 서비스에서 trusted actor·owner와 원 정정 인자를 검증해 같은 command digest의 receipt를 조회하는 작은 API를 제안한다. 반환은 `아직 없음 / 반영 revision / 현재 revision·활성 여부`와 필요한 참조뿐이다. 서비스의 private digest 계산을 UI나 파일 어댑터에 복제하지 않는다. tombstone/권한 축소 뒤 오래된 본문을 조회 결과로 노출하지 않는다. 조회 결과만으로 새 출처나 새 변경을 만들지 않는다.
- **세션 근거 확인:** `SessionRepository.input`, `SessionService.input/resume`, `KnowledgeUserSources.capture/current`를 재사용한다. UI에 필요하면 actor 검증을 거친 최소 상태 projection을 둔다. 새 inbox나 “초안 전용 가짜 사용자 발언” 테이블은 만들지 않는다.
- **표면:** CLI는 초안의 실제 절대 경로와 draftId를 보여 주고 `memory-draft-create`, `memory-draft-apply`, `memory-draft-resume/status` 정도로 연결한다. Web은 기존 개인 기억 카드에서 초안 ID와 대상 업무를 선택해 적용·상태·원문 출처를 확인한다. 서버 임의 파일 경로를 HTTP로 받거나 브라우저의 `file://` 접근을 요구하지 않는다. 파일 편집은 사용자의 편집기에서 수행한다.

신규 API 이름은 제안이다. 적용 조립과 정확한 receipt 조회가 함께 구현되어야 하며, 기능을 메서드별 별도 챕터로 나누지 않는다. D1 document repository/witness 형식·선택 router·기억 생애는 그대로 쓴다. 새 계층·일반 작업 엔진·독립 초안 데이터베이스는 요구하지 않는다.

## 7. 한도·오류·화면 표현

기존 [표면 schema](../../runtime/src/presentation/local-personal-memory.ts#L6)의 본문 10,000자, 제목 200자, reason 1,000자와 [서비스 schema](../../runtime/src/application/knowledge-contracts.ts#L84)의 더 안쪽 한도를 모두 적용한다. 여기서 자 수는 기존 JavaScript 문자열 길이이며 토큰 수나 UTF-8 bytes가 아니다. 본문은 앞뒤 공백·줄바꿈을 조용히 잘라 바꾸지 않고 입력과 quote에 같은 문자열을 쓴다. UTF-8 해석 실패·빈 본문·금지된 헤더 변경은 원문 접수 전에 거절한다.

초안/intent envelope의 bytes 상한은 D1의 256KiB를 상한으로 재사용한다. 초안 보관량은 활성 기억 namespace의 4,096개·64MiB와 **별도로** 제한해 서로의 한도를 몰래 소모하지 않게 한다. 최초 구현은 같은 수치를 별도 보관 한도로 두되 자동 절단·자동 정리·무제한 목록 스캔을 하지 않는다. 개인 기억을 frame에 선택할 때의 기존 8KiB 카드 한도도 유지한다. 파일에 저장됐다는 이유로 모델 문맥에 무조건 넣지 않는다.

일반 파일의 편집기 rename은 지원하지만 symlink, 외부 hardlink, 특수 파일, private 권한을 잃은 결과는 거절한다. 파일 권한을 자동으로 고쳐 인수하지 않는다. 명시 등록된 문서 backend만 D2 대상이며 SQLite 기본 담당에서 이 명령을 썼다고 저장방식을 바꾸지 않는다. 기존 POSIX 경로 재확인 한계, 전원 차단·네트워크 파일시스템·native Windows 미검증 범위도 유지한다.

관리 카드 또는 CLI 결과에서 `초안`, `적용 준비됨`, `원문 적용 대기`, `원문 반영됨·기억 미반영`, `기억 게시 결과 확인 필요`, `반영 완료`, `충돌/거절`을 구분한다. 상태를 바꿀 때마다 채팅 말풍선을 추가하지 않는다. 실제 편집 본문 원문은 대화 이력에 한 번 남고, 관리 결과는 카드의 같은 상태 영역에서 갱신한다. 실패 원인과 이어갈 applyId를 보여 주며 무조건 “다시 보내기”로 새 ID를 만들지 않는다.

## 8. 한 단위의 구현 순서와 인수

1. 코덱·생성 근거·intent 및 원 명령 결과 조회 계약을 정하고, stable read/no-overwrite 어댑터를 연결한다. 기존 개인 정정의 인자와 한도를 공유한다.
2. 초안 생성 → 실제 편집기 방식 rename 저장 → 명시 적용/재개 → 원문·기억 영수증 → 정확한 결과를 공통 조립에 구현한다. source가 이미 applied인 경우와 처음 접수할 경우를 같은 적용 기록으로 이어 간다.
3. 실제 CLI와 Web 개인 기억 카드에 연결하고 두 state backend에서 동일 문서 기억 흐름을 검증한다. 새 workflow/model/tool 호출은 0이어야 한다.
4. 결정적 중단·동시성 시험, 실제 child SIGKILL, 영향받는 세션/개인 기억/D1 저장 회귀와 해당 플랫폼 검증을 통합한다. 모든 기존 C03 시험을 새 파일에 복사하지 않는다.

필수 인수 시나리오는 다음과 같다.

- 새 원문 1개와 정정 1회, 같은 applyId 재전송·프로세스 재시작 후 개수 불변. intent 확정 전에 강제 종료하면 둘 다 0개.
- receive 뒤/업무 반영 뒤/원문 applied 뒤/기억 정본 게시 뒤/응답 전에서 각각 재개. 대표 경계는 실제 child SIGKILL로 검증하고 나머지는 원 연산을 전달한 결정적 실패 주입으로 보완한다.
- 같은 적용 ID의 다른 본문·목표·baseRevision, 두 프로세스 동시 적용, 오래된 초안, 다른 owner·담당의 ID, 바뀐 storeId, read-only actor, 종료된 업무·틀린 선택 세션을 거절한다. 준비 단계 거절에서는 원문·기억·새 업무가 생성되지 않는다.
- 원문이 applied된 후 다른 정정이 먼저 성공하면 부분 완료와 충돌을 표시한다. 정정 성공 후 다른 정정/잊기가 발생해도 이 적용의 원 반영 revision을 정확히 표시하고 오래된 기억을 살리지 않는다.
- 초안 변경·삭제·rename 뒤 `resume(applyId)`는 고정 intent로 동일 요청을 이어 간다. 같은 applyId의 새로운 내용 제출은 충돌이며, 사용자 편집 파일 자체를 복구 대상으로 덮어쓰지 않는다.
- 수정 전 선택/실제 저장 frame은 현재성 검사를 통과하지 못하고, 명시 재선택한 새 revision만 다음 frame에 들어간다. 원문 이력과 D1의 Markdown·witness는 보존하며 SQLite personal 파티션에 정본을 복사하지 않는다.
- CLI에서 출력한 경로를 실제로 편집하고 Web에서 같은 초안 적용·원문·결과·재개 ID를 확인한다. 화면 성공, 저장 성공, 새 모델의 의미 품질은 각각 구분한다.

D2 인수는 이 흐름의 구현과 해당 검증이 끝났을 때만 표시한다. 이 문서 작성으로 runtime 소스, 증거, 기존 D1 검증 pin을 바꾸지 않았다. D3 이관, 자율 기억 출처 확장, PostgreSQL, 임베딩, 공유 문서 저장소, 물리 삭제와 일반 파일 편집 UI는 이번 완료 조건에 넣지 않는다.
