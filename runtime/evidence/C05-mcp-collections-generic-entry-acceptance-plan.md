# MCP collection 일반 입구 복구 인수안

2026-09-08 작성. 아래는 새 시험의 계획이다. 기존 Linux/로컬 결과를 다시 실행하거나 staged 후보의 성공을 주장하지 않는다. 제품 적용과 첫 통합 검증은 root가 맡는다.

권고 범위는 주요 4개와 정상 partial 1개다. 실제 C01 담당·세션·등록 host·stdio peer를 사용하고, 재개는 CLI 또는 localhost HTTP의 일반 경로를 통과한다. 합성 모델은 정확한 시험 문장과 현재 packet만 해석하며 모델/API 품질을 검증하지 않는다.

| 새 인수 | 저장 방식·입구 | 실제 중단 및 기대값 |
|---|---|---|
| 완료 응답 복구 2개 | SQLite/file-journal, 새 CLI child | `documents.batch` a,b의 실제 `mcp-page:<attempt>:<request>` receipt commit 뒤, 정규화/checkpoint 반영 전 worker SIGKILL. 저장 전용으로 열어 원문을 정산하고, 등록 모델이 현재 `stored_complete` 항목과 frontier의 원 query를 이용해 명시 `readResume` successor를 선택한다. 로컬 소비·채택 뒤 a,b 값 30씩에 근거한 답변. 새 peer/송신 0, child transport 0, child 논리 toolCalls +1. |
| 미완료 page 복구 2개 | SQLite/file-journal, localhost HTTP | `observations.page` a,b,c,d의 첫 a,b page raw receipt 뒤 SIGKILL. 저장 전용 일반 run이 정산 후 connection_required를 게시하고, 새 requestId 재실행·close/reopen에서도 같은 waiting을 유지한다. 모델/새 attempt/송신 증가 0. 명시 online host로 다시 열었을 때만 기존 snapshot/cursor의 c,d 한 page를 읽고 현재 근거로 완료한다. |
| 정상 adopted partial 1개 | SQLite, localhost HTTP | `documents.batch` item-error의 a 성공/b 재시도 가능 실패를 정상 receive/adopt한 뒤 종료. stored-only 재개를 두 번 실행해 adopted 부모가 빠지지 않고 connection_required를 유지하는지 확인한다. 명시 online 재개는 retryIds=[b]만 호출하고 a 원본을 보존한다. 강제 중단 case와 다른 정상 상태이므로 별도 1개로 둔다. |

완료 CLI 2개에 작은 실제 문맥창을 함께 넣는다. 최초 raw 접수 후 동일 세션에 정확한 긴 합성 후속 문장을 저장하고, 원 task/dispatch 전에 입력을 확정한다. 넓은 설정의 무쓰기 inspect로 필요한 입력과 전체 입력 크기를 한 번 기록하고, 필수 prompt/schema·최근 원문은 들어가지만 전체 tail은 들어가지 않는 host window를 고른다. 출력 예약도 포함한다. 원 provider의 구조화 요청 추정기를 그대로 사용하고 tokens=1 또는 임의 축약 packet을 사용하지 않는다. CLI 재개에서 실제 session_compact accepted call이 1개 이상, 이어지는 주턴 입력의 SessionContext v2·요약 참조·최신 raw·원 query/head가 맞아야 한다. 저장 source/history/원 response bytes는 동일해야 한다. ContextCompiler의 파생 frame compact와 실제 세션 요약 모델 호출을 구분한다.

재사용 위치와 새 소유 파일은 다음과 같다.

| 기존 코드 | 재사용 방법·한계 |
|---|---|
| [mcp-offline-entry.test.ts](../src/tests/mcp-offline-entry.test.ts:131) | CLI child의 `runAgentTurnCli`, HTTP login/cookie/CSRF와 `/api/works/:id/commands`, status/view 읽기 및 완료 뒤 중복 재개의 검증 패턴. private 함수라 새 fixture에 필요한 작은 부분만 옮긴다. 기존 plain 시험을 수정·재실행하지 않는다. |
| [mcp-agent-profile-helper.ts](../src/tests/mcp-agent-profile-helper.ts:29) | `initializeMcpAgent`의 실제 C01/backend 설정을 사용한다. 기존 model은 단일 id 원문만 받고 compact가 없으며 tools wrapper도 providerSources를 전제하므로 collection host로 그대로 사용하지 않는다. |
| [mcp-collection-binding.ts](../src/tests/helpers/mcp-collection-binding.ts:9), [fixture contracts](../src/tests/helpers/mcp-collection-fixture-contracts.ts:83) | 기존 manifest/projector/binding identity와 독립 기대값 a,b=30 / a,b,c,d=1을 재사용. 기존 [stdio server](../src/tests/helpers/mcp-collection-fixture-server.ts:67)의 normal/item-error 모드, call/requestId/retryIds/snapshot/cursor/audit를 사용한다. 서버·포맷 변경 없음. |
| [mcp-settlement-worker.ts](../src/tests/helpers/mcp-settlement-worker.ts:104), [settlement recovery](../src/tests/mcp-read-settlement-recovery.test.ts:207) | 실제 commit를 먼저 실행한 뒤 IPC ready에서 멈추고 부모가 SIGKILL하는 방식. 기존 worker는 low-level 저장소/ScriptedPlanner라 C01 일반입구 증거로 재명명하지 않는다. 새 worker는 host tool assembly의 같은 state 포트를 forwarding wrapper로 감싸며 두 번째 DB를 만들지 않는다. |
| [registered-agent-flow.test.ts](../src/tests/registered-agent-flow.test.ts:31), [StructuredAgentModel](../src/infrastructure/structured-agent-model.ts:26) | 동일 identity/caps의 구조화 turn+compact adapter와 전체 요청 추정/사용량 관측. exact synthetic compact extension으로 출처 인용을 남기고 기존 고정 prompt/schema를 재사용한다. |
| [read-complete-resume staged tests](C05-mcp-collections-staging/windows/src/tests/read-complete-resume.test.ts:123) | 부모 failed/원 owner/lease/원 receipt 유지, child checkpoint 관계, child의 transport0과 논리 호출 +1 기대를 공유한다. 이 low-level 후보도 현재 작성·통합 검증 중이다. |

새 파일은 `C05-mcp-collections-entry-acceptance-staging/src/tests/mcp-collection-entry.test.ts`, 같은 접두 `-fixture.ts`, `-worker.ts` 세 개를 권고한다. root가 staged 제품 통합을 소유하고, 이 인수 담당은 새 시험/host/worker만 소유한다. 제품 testhook 없이 host registration의 assembly를 새 객체로 감싸며 원 frozen clock/custody는 변경하지 않는다. 테스트 전용 Date.now 기준을 자식과 HTTP에 일치시키되 저장된 owner/lease/deadline/시각은 재작성하지 않는다.

worker는 원 commit 결과와 receipt를 확인한 marker에 work/session/입력/dispatch/intent/head/raw/digest/원 budget/owner/lease 및 worker/peer PID를 남긴다. 부모는 20초 ready 상한, 실제 SIGKILL exit 확인과 5초 종료 상한을 두고 stderr·원 실패를 보존한다. peer는 stdin 종료로 닫혀야 하며 audit close와 PID 소멸을 확인한다. 마지막 실패 cleanup도 소유한 PID만 대상으로 유한 종료한다. ready 이전 exit/error를 함께 관측하고 타이머를 정리한다. 저장 전용 구간은 audit bytes 불변과 discover/call/close 호출 금지로 peer 0을 확인한다. 생성자 횟수 자체는 이 입구 시험의 독립 관측값으로 꾸미지 않는다.

최종 기대값은 저장 구조와 사용자 응답을 함께 본다. 최초 사용자 메시지 1개, 원 goal과 입력 receipt 불변, 부모 실패를 성공으로 소급 변경하지 않음, child readResume/head/원 query의 정확한 연결, 채택한 facts의 raw ref, 완료 답변 1개, 재개 후 usage 중복 없음을 확인한다. 원 receipt 뒤 새 head/정산 receipt가 생기는 정상 변화는 허용한다. local consume은 manifest/project 검증을 할 수 있으므로 projector 0을 요구하지 않으며, 등록 Tool.execute/source.fetch/원격 wire를 새로 호출하지 않는지를 구분한다. 권한·원문 손상 거절의 세부 조합은 이미 작성된 코어 회귀에 맡기고 이 5개에 다시 펼치지 않는다.

남는 범위: 모든 CLI/HTTP×stage 조합, 실제 세션 raw-read 자체의 capacity 오류, 원문 손상과 모델 reply 사이 일반입구 경합, wait/deferral의 실제 dueAt 재연결, page 전송 뒤 권한변경 custody/usage는 이 5개의 완료 조건이 아니다. 특히 supplemental read-collection-context 시험의 5회 파생 compact/reopen은 실제 session summary 호출이나 일반 successor 실행을 포함하지 않으며 아직 이 메모에서 통과로 취급하지 않는다. 새 시험이 실패하면 원 결과를 남기고 제품 변경은 root와 별도 결정한다.
