# C05 — MCP 전송 후 권한 변경과 원응답 보관 결과

<!-- C05-MCP-CUSTODY-FINAL-PROOF: 3783a0a1f5ba3a4eea5a9a2231d5def3dbaf44a163c4444b8e559642283e463c -->
**MCP 전송 후 권한 변경의 원응답 보관·사용량 정산**을 연결했다. 허용한 읽기를 보낸 뒤 권한이 바뀌어도, 실제 받은 원응답과 입증된 사용량을 원 담당·원 시도에 보관하고 정산한다. 본문을 지금 보여 주거나 근거로 채택하는 권한은 따로 검사한다. 정상 저장 결과의 수신·채택 또는 거절/정산 → 필요한 compact(긴 대화 정리) → 문맥 체크포인트 복원 → 이후 작업 순서를 유지하며, 일반 run 진입에서 사용량 보완을 한 번의 유한한 과정으로 연결했다. **macOS Node24 신규 121/121·관련 775/775, NAS Linux Node24 신규 121/121·관련 775/775·전체 3,544/3,544 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-result.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-plan.md) · [MCP 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-linux-nas-20260907/verification.json). 보관 원문은 SDK가 해석한 MCP 응답 JSON이다. sent는 로컬 전송 시도 표시이며 원격 실행·성공·과금의 증명이 아니다. 입증되지 않은 측정값은 unknown(null)으로 남긴다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 영수증을 만들어 복구하거나 자동 재전송하지 않는다. 원문·원 영수증·owner·자료 세대를 유지하며 현재 본문 검사를 느슨하게 하지 않는다. 서버를 다시 발견(tools/list)하는 현재 시작 경로는 유지되므로 서버 없는 재개는 아직 아니다. 다음 구현은 MCP 서버 없는 일반 CLI·Web 재개이며 설계 확정·제품 미착수다. 호스트가 명시한 저장 전용 도구에서 기존 보관·본문 검증을 재사용하고, 새 연결이 필요한 작업은 기다리며 다른 독립 작업은 진행하는 경계를 연결한다. 일반 입구의 collection(여러 항목 수집)·페이지·대기 복구와 문맥 조회 비용 개선도 후속이며, 원문·권한의 현재성 검사를 유지한다. [다음 구현 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [사전 검토 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-notes.md) · [MCP 전체 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

최종 근거의 소스 지문은 `d662de55a414015e5fb4f26b189cc6ec3874d222c68736fd38eec53fa5402580`, 빌드 파일 지문은 `c2831de467ff14f3843203000d1141f89fec691208b6fb5864e72c6e2eb70c69`, 파일 수는 1,743다. Linux 종료는 `2026-09-07T13:31:04.906Z`이며 필수 8단계와 원로그 9개 회수를 확인했다. 관측 가능한 전용 root의 프로세스 0개와 SSH 종료를 확인했지만, 읽을 수 없던 같은 UID 프로세스 2개·범위 미확정 2개가 있으므로 시스템 전체 프로세스 부재를 주장하지 않는다. 로컬 전체 회귀는 이 최종 소스로 별도 실행하지 않았고 Linux 전체 결과와 구분한다.

공개된 원 사용자 요청을 그대로 읽을 수 있는 재개는 보호 raw를 문맥에서 제외한 유효한 blocked 체크포인트를 반환할 수 있다. 이는 업무 완료나 보호 본문 채택이 아니다. 원 사용자 요청 자체를 읽을 수 없으면 사용량 정산 뒤에도 session_current_input_unavailable로 거절한다. GET·상태 조회·SSE는 읽기만 하며 정산은 명시 실행·명령에 연결한다.

같은 실행 측정값과 일치하는 기존 정산 이벤트·영수증을 확인한 시도는 정산 선별에서 raw 재조회를 생략한다. 정상 null 필드가 남았다는 이유로 반복 정산하지 않는다. 이 생략은 본문·문맥의 별도 원문 검증을 없애지 않으며 성능 개선 수치는 측정하지 않았다.

프로필 종료는 새 실행을 막고 모델·도구 연결을 닫은 뒤 기존 pending 수신을 기본 최대 5초 마무리하고 stores를 닫는다. 이 5초는 실행기 pending 마감이며 임의 호스트 close까지 포함한 전체 종료 상한이 아니다. 취소 신호와 DB commit의 원자화, 전원 손실 내구성을 보장하지 않는다. 잘못된 도구 결과는 기존 invalid_tool_result로 정규화될 수 있어 모든 실패 본문을 그대로 저장한다고 표현하지 않는다. 실제 로컬 stdio peer와 C01 SQLite/file-journal의 중단·종료 계약 인수이며, 합성 모델의 정해진 답변을 실제 모델 품질로 해석하지 않는다.

중간 실행 이력: [new3](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-new3.json) 120개 중 113 통과·7 실패 ([원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-new3.log)) → [new4](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-new4.json) 121개 중 116 통과·5 실패 ([원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-new4.log)) → [related-entry1](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-related-entry1.json) 5개 중 5 통과·0 실패 ([원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-related-entry1.log)). new3는 고정 clock 변경을 시도한 시험 준비와 미전송 예약의 not_invoked 선별 누락을 교정했다. new4의 입구 실패는 시험 서버의 기존 최대 1,000,000을 넘긴 sentinel 8675309를 867539로 고친 시험 자료 변경이며 제품 변경으로 설명하지 않는다. 이 중간 묶음을 최종 집계에 더하거나 그 소스 지문을 최종 지문으로 바꾸지 않는다. 이전 초기화·MCP 정체의 원인 미확정 범위도 이전 증거에 남긴다.

아래의 “검증 중”·실패 후 대기 표시는 작성 당시 기록이다. 최종 확인 범위는 위 증거를 따르며, 당시 구현 설명과 원로그는 보존한다.

## 최초 결과 초안과 중간 검증 기록

**최신 검증 상태 — checkpoint316:** 최종 소스의 로컬 신규121/121·관련775/775와 build/core/계층은 통과했다. NAS32757은 앞6단계를 통과하고 전체 회귀를 실행 중이다. 아래 build6/new3 및 교정 기록은 중간 이력이며 최종 전체 성공이 아니다. [현재 checkpoint](../../runtime/evidence/C05-mcp-custody-implementation-checkpoint.json)와 최종 proof를 구분한다.

**구현을 연결했고 최종 검증 중이다. 이 단위·C05·전체 goal의 완료 기록은 아니다.** 사용자가 허용한 읽기를 보낸 뒤 권한을 줄이거나 작업을 취소해도, 실제 받은 원응답과 확인된 사용량을 원 담당의 저장소에 보관할 수 있게 했다. 현재 본문 열람·근거 채택·새 전송 권한은 별도로 검사한다.

작성 기준으로 [build6](../../runtime/evidence/C05-mcp-custody-build6.json), [core2](../../runtime/evidence/C05-mcp-custody-core2.json), [architecture2](../../runtime/evidence/C05-mcp-custody-architecture2.json)는 Node 24.20.0에서 종료 0이다. 이어 같은 소스의 [new3](../../runtime/evidence/C05-mcp-custody-new3.json)는 **120개 중 113 통과·7 실패, 종료 1**이었다. 각 단계의 소스 불변과 직접 생성한 프로세스 그룹 종료를 기록했다. 실패 교정 후 build7/new4와 최종 관련 회귀·NAS/Linux 검증은 아직 통과로 확정하지 않는다. 아래 인수 설명은 현재 작성된 시험의 범위이며, 별도 결과가 없는 항목은 실행 성공을 뜻하지 않는다.

| build6에 기록된 항목 | 값 |
|---|---|
| 소스 지문 | `a85b2ce7e8c6a172afb0a869bbca70b41d54dac986865d5ea8ef97cb7c2cc8d2` |
| 빌드 파일 지문 | `dcf66e91b472228531794d86e2ea7333e2bf0de3215198b2bf7518aba0540d4a` |
| 빌드 파일 수 | 1,743 |
| 같은 소스의 신규 시험 종료 | `2026-09-07T13:02:53.664Z` — new3, 종료 1 |

위 지문은 build6/new3 실행 당시의 근거다. 후속 교정 소스의 검증 지문으로 재사용하지 않는다. new3의 입구 시험 5개는 고정된 clock의 함수를 바꾸려는 시험 준비 오류였고, 예약 종료 시험 2개는 실제 예약의 `not_invoked` 기록을 제외 조건이 놓친 제품 오류였다. 입구 시험은 해당 테스트 프로세스의 시각 기준을 조정하고 제품의 고정 clock은 유지하도록 교정했다. 예약 선별은 제품과 통계 집계를 함께 보강했으며 교정 후 검증은 아직 확정하지 않는다. [원 로그](../../runtime/evidence/C05-mcp-custody-new3.log)를 보존한다.

설계 의도와 착수 전 상태는 [계획](C05-mcp-sent-authority-plan.md)에 보존한다. 선행 [단순 원응답 복구 결과](C05-mcp-response-recovery-result.md)의 Linux 통과는 이번 변경을 검증한 결과로 합치지 않는다.

## 사용자가 보게 되는 동작

한 번 전송한 요청에서 받은 자료를 원래 라벨로 보관하고, 같은 시도에 측정값을 기록한다. 라벨은 자료를 볼 수 있는 권한의 표식이다. 현재 권한이 좁아졌다는 이유로 자료의 라벨을 낮추거나, 과거 정책을 현재 사용자에게 적용해서 본문을 보여 주지 않는다.

| 상황 | 현재 연결한 처리 |
|---|---|
| 전송 전에 권한이 없음 | 기존 전송 직전 검사가 거절한다. 입증된 미전송은 0으로 기록하며 응답 본문을 만들지 않는다. |
| 응답을 받은 뒤 권한 축소·취소·목표 변경 | 원 호출의 소유·식별·자료 세대가 유효하면 원응답과 수신 영수증을 보관한다. 현재 본문 사용은 거절하고 원 시도의 측정값만 보완한다. |
| 정상 수신 영수증 뒤 프로그램 중단 | 정상 본문 복구를 먼저 시도한다. 현재 권한·목표·계획·입력·기한·출처가 맞아야 수신·채택할 수 있다. |
| 사용량만 정산한 뒤 프로그램 중단 | 정확한 정산 영수증을 추가로 입증한 미수신 시도는 정상 본문 복구에 다시 들어갈 수 있다. 이미 실패·거절·채택된 결과를 되살리지는 않는다. |
| 파일만 있고 수신 영수증이 없음 | 정산·본문 복구의 근거로 인정하지 않는다. 저장 폴더를 뒤져 고아 파일을 정본으로 승격하거나 같은 요청을 자동 재전송하지 않는다. |
| 이미 정산된 시도를 다시 재개 | 현재 측정값과 같은 정산 영수증을 확인하면 정산 선별에서는 원응답을 다시 읽지 않는다. 알 수 없는 측정 필드가 남아 있어도 반복 정산하지 않는다. 본문·문맥 검증에 필요한 별도 원문 조회는 유지한다. |

`receipt`는 어떤 명령이 어떤 상태를 저장했는지 확인하는 영수증이다. 파일 존재나 서버의 요청 접수만으로 수신 영수증을 대신하지 않는다. 보관하는 원문은 **SDK가 해석한 MCP 응답 JSON**이며 네트워크 프레임 원바이트는 아니다.

## 보관·사용량·본문의 경계

[MCP 클라이언트](../../runtime/src/infrastructure/mcp-stdio-client.ts)는 요청별 응답 관측을 잡은 뒤 기존 연결·취소 검사를 계속한다. 공유된 마지막 응답으로 다른 요청의 결과를 추정하지 않는다. [ToolBroker](../../runtime/src/application/tool-broker.ts)의 `authorizeResponseCustody`는 원 호출이 살아 있는 동안의 보관 확인 함수다. 원 담당 저장소·work·attempt·원 owner·dispatch·입력·계약·자료 세대를 고정하며 새 도구 실행이나 현재 본문 공개를 허용하지 않는다. `attempt`는 같은 업무 안에서 실제로 배정된 도구 실행 시도 한 건이다.

[읽기 어댑터](../../runtime/src/infrastructure/mcp-read-tools.ts)는 원 envelope v1과 도구 정의/버전을 유지한다. 새 수신 영수증의 `custody` metadata는 정상 반환(`returned`), 응답 관측 후 후속 검사 실패(`captured`), 응답 없는 전송 실패(`failure`)를 구분한다. `captured` 결과는 재접속 뒤에도 정상 반환 본문으로 승격하지 않는다. 정상 반환 원문의 나중 복구 역시 별도 현재성 검사를 통과해야 한다.

| 측정 | 해석 |
|---|---|
| `budget.used.toolCalls` | 이미 배정·전송 처리한 논리 시도의 사용량. 복구했다고 한 번 더 차감하지 않는다. |
| `attempt.execution.implementationCalls` | 도구 구현 진입에 대한 기록. 원격 서버의 성공이나 과금 확정이 아니다. |
| `transportCalls` | 이 클라이언트가 관측한 로컬 전송 시도. 확인된 전송 전 거절은 0, 입증된 전송은 1, 알 수 없으면 null이다. |
| 그 밖의 null 필드 | `internalOperations`, `imageBytes`, `waitMs` 등을 측정하지 못했다는 뜻이다. 0이나 미정산 표시로 해석하지 않는다. |

구형 영수증도 읽되, 옛 `failure.sent=true`가 임의 예외와 섞였던 모호함을 새 known 1로 승격하지 않는다. 새 영수증은 실제 전송 관측을 확인하고, 임의 예외만으로 유효 원응답이나 측정값을 만들지 않는다. [병합 규칙](../../runtime/src/application/tool-execution-usage.ts)은 unknown을 known으로 보완하고 기존 known을 뒤의 unknown으로 지우지 않는다. 같은 값은 유지하고 서로 다른 known 또는 실행 방식이 충돌하면 거절한다. 두 값을 합산하지 않는다.

[StoredToolUsages](../../runtime/src/application/stored-tool-usage.ts)와 [recordStoredUsage](../../runtime/src/application/execution-runtime.ts)는 원 dispatch와 수신 영수증, 정확한 원문 참조·바이트·SHA-256을 검사한다. 이 경로는 현재 목표·취소 상태·라벨 축소만을 이유로 과거 시도의 정산을 막지 않는다. 대신 원 work/사용자/시도 소유와 자료 세대가 바뀌거나 원문이 차단·손상되면 새 정산 증명을 거절한다. 정산 영수증 `tool-usage:<attemptId>:<source>`를 같은 상태 저장소에 남기며, 기존 결과 파일·receive/adopt 영수증·업무 목표와 상태를 바꾸지 않는다.

본문을 다루는 [StoredToolResults](../../runtime/src/application/stored-tool-results.ts)는 이보다 좁다. usage-only 미수신은 위 정산 영수증과 현재 execution이 정확히 맞아야 후보가 되며 기존 현재 권한·출처 검사를 그대로 거친다. 예전 lease 만료 영수증과 현재 시도의 execution 차이는 입증된 정산 부분만 허용한다. `lease`는 원 실행자가 일을 맡아 둘 수 있는 시간이며, 만료를 새 owner나 새 전송으로 덮어쓰지 않는다.

## 일반 재시작과 화면 연결

[WorkflowRuntime](../../runtime/src/application/workflow-runtime.ts)은 기존 정상 수신·채택 기회를 먼저 유지하고, 필요한 compact와 문맥 복원 전에 사용량 보완 pass를 한 번 수행한다. pass는 이번 재개에서 확인할 시도 목록을 고정한 유한 순회다. 매 추론 step마다 모든 원문을 다시 읽지 않으며, 처리 도중 새로 생긴 시도를 계속 따라가지 않는다. 예약만 했다가 취소·만료되어 실제 dispatch가 없는 시도는 자동 선별에서 제외한다. 오류명만으로 제외하지 않고 미호출·결과 없음·미채택 조건을 함께 확인한다. 실제 실행이 같은 오류명을 반환한 경우에는 사용량 통계에서 빼거나 0으로 바꾸지 않는다.

[기록 선별 함수](../../runtime/src/application/stored-usage-records.ts)는 확인할 invoked 측정 후보가 있을 때 기존 work events를 한 번 읽고, 명령 지문·실제 영수증·원 work 생성 시각/사용자·시도 식별·현재 execution·시각/수정 번호를 대조한다. 원문·도구 콜백은 읽지 않는다. 이미 확정된 통계를 확인하는 이 단계는 이후 자료 삭제만으로 과거 정산 기록을 없애지 않는다. 이는 삭제된 본문의 재사용 허가가 아니다. 조회 중 현재 상태가 바뀌면 새 상태에서 한도 안에서 다시 선별한다. 기존 events 전체를 읽는 비용과 추가 원문 검증 비용은 후속 C05 계측 대상이다.

CLI의 기존 `resume`과 Web의 명시 제어 명령 뒤에 이 경로를 연결했다. 새 공개 복구 명령은 없다. [Web 조회·명령](../../runtime/src/presentation/local-workbench.ts)의 GET/SSE/view와 CLI `status`에는 정산 쓰기를 붙이지 않았다. 일반 run의 기존 실행 권한 검사는 그대로이며, 더 좁거나 취소된 호스트의 보관 소유 확인이 현재 실행 권한을 대신하지 않는다.

[일반 입구 인수](../../runtime/src/tests/mcp-custody-entry.test.ts)는 두 상황을 구분한다. 공개 라벨의 원 사용자 요청을 그대로 유지하고 보호된 도구 원문만 제외할 수 있으면, SQLite CLI가 유효한 **blocked 문맥 체크포인트를 반환하는 재개**를 시험한다. 이는 명령 처리가 성공했다는 뜻이며 업무 완료·보호 본문 채택 성공은 아니다. 원 사용자 요청 자체도 현재 권한으로 읽을 수 없으면 사용량을 보완한 뒤 `session_current_input_unavailable`로 재개를 거절한다. 요청 라벨이나 원본을 바꿔 통과시키지 않는다. Web HTTP 인수는 조회가 상태를 바꾸지 않고 명시 취소가 한 번 정산하며, 재접속·같은 명령 재전송에서도 대화·정산이 중복되지 않는지 확인하도록 작성했다. 실제 브라우저 렌더링 인수와는 다르다.

현재 일반 프로필을 열면 `tools/list` 발견 과정이 있다. 저장 결과의 `tools/call` 재전송 0회와 서버 없는 일반 입구는 별개다. 직접 저장소/어댑터만 조립하는 회복 시험의 discovery 0회를 일반 CLI/Web의 오프라인 시작 보장으로 확대하지 않는다.

## 종료와 실제 중단 인수

[프로필 close](../../runtime/src/presentation/agent-turn-profile.ts)는 수명 신호를 취소하고 새 실행을 막은 뒤 모델·도구 transport를 정리한다. 이어 기존 실행기의 pending 수신을 기본 최대 5초 마무리하고 저장소를 닫는다. 마감 초과는 `executor_close_unconfirmed`, 늦은 게시 실패는 별도 오류로 남기며 보관 수명을 닫은 뒤 다시 성공을 게시하지 못한다. 이 5초는 실행기의 로컬 pending 마감이며, 임의 호스트 모델의 close까지 포함한 전체 종료 시간 보장은 아니다. 취소 신호 검사와 DB commit이 원자적이라는 주장도 하지 않는다.

[전체 프로필 종료 인수](../../runtime/src/tests/mcp-custody-profile-close.test.ts) 4개와 [실제 SIGKILL 인수](../../runtime/src/tests/mcp-custody-crash.test.ts) 6개를 작성했다. 전자는 실제 로컬 MCP peer 종료→캡처 원문 마무리→C01 stores close 순서, 마감 초과 뒤 늦은 게시 거절, 원 오류와 독립 cleanup 오류 보존을 다룬다. 후자는 SQLite/file-journal 각각에서 raw 게시 후·response 영수증 후·usage commit 후 프로세스를 실제 종료하고 다른 프로세스에서 원 시도만 정산하도록 구성했다. 원 peer 감사와 추가 호출 0, 원문·영수증·owner·예산 보존을 별도로 비교한다. **이 초안은 새 묶음의 최종 실행 결과를 아직 확정하지 않는다.**

잘못된 도구 출력은 기존 규칙대로 `invalid_tool_result`로 정규화하여 저장할 수 있다. 따라서 모든 실패 본문을 그대로 보존한다고 표현하지 않는다. 보관 가능한 bounded MCP 원응답, 전달하는 안전한 실패 결과, 원 예외와 cleanup 오류의 내부 보존은 서로 다른 경계다.

## 수치 한도와 검증 상태

원 MCP 보관 envelope와 사용량 증명의 raw 상한은 **512 KiB**, 일반 저장 결과 복구의 정규화된 result 상한은 **1 MiB**다. MCP 클라이언트의 `maxMessageBytes`는 별도 호스트 설정이며 기본 256 KiB이므로 더 작은 전송 한도가 먼저 적용될 수 있다. 상한 초과·손상·영수증 부재를 성공 보존으로 표시하거나 원문 fallback으로 우회하지 않는다. 선별 경합과 개별 정산의 상태 경합은 각각 최대 8회이며 무한 재시도하지 않는다.

| 근거 | 확인 범위와 상태 |
|---|---|
| [첫 검증 기록](../../runtime/evidence/C05-mcp-custody-first-validation-note.md) | build1 타입 실패, new1 80/82, 두 시험 준비 교정 뒤 new2 82/82를 역사로 보존한다. |
| [new2 로그](../../runtime/evidence/C05-mcp-custody-new2.log)·[JSON](../../runtime/evidence/C05-mcp-custody-new2.json) | 당시 7파일의 82/82 통과. 현재 13파일로 확장한 신규 인수의 통과는 아니다. |
| [related1 로그](../../runtime/evidence/C05-mcp-custody-related1.log)·[JSON](../../runtime/evidence/C05-mcp-custody-related1.json) | 당시 693개 중 685 통과·8 실패. 원응답 게시를 허용하는 새 계약과 기존 artifact 0 기대값의 불일치를 보존했다. |
| [related-mcp2 로그](../../runtime/evidence/C05-mcp-custody-related-mcp2.log)·[JSON](../../runtime/evidence/C05-mcp-custody-related-mcp2.json) | 기대값 교정 후 해당 MCP 읽기 파일만 28/28. 서로 다른 소스의 실행을 합쳐 현재 전체 통과로 세지 않는다. |
| build6/core2/architecture2 | 위 동일 소스에서 종료 0 확인. 새 기능의 통합 실행·Linux 검증을 대신하지 않는다. |
| [확장 new3 로그](../../runtime/evidence/C05-mcp-custody-new3.log)·[JSON](../../runtime/evidence/C05-mcp-custody-new3.json) | 13파일의 120개 중 113 통과·7 실패. 취소/건너뜀 0. 교정 후 전체 성공으로 간주하지 않는다. |
| 후속 build7/new4·최종 관련 회귀 | 교정 소스의 최종 종료 JSON·집계 확인 대기. 현재 [신규 선택 목록](../../runtime/evidence/C05-mcp-custody-new-files.json)은 13파일이다. |
| 이번 단위 NAS/Linux 확정 증거 | 미확정. 최종 동일 소스의 실행·원로그 회수·소유 프로세스/SSH 정리까지 확인한 뒤 연결해야 한다. |

로컬 응답·모델 대역과 실제 로컬 stdio 프로세스는 구조와 수명 경계를 시험한다. 실제 사내 MCP/Knox, 실제 모델 의미 품질·API 호출, native Windows 실행/파일 바인딩, PostgreSQL은 이번 완료 범위가 아니다. 서버 없는 일반 입구, collection/페이지/대기, 쓰기·컴퓨터 유즈 확장과 조회 비용 개선도 [기존 후속 순서](C05-mcp-host-plan.md#c05-mcp-후속-필수-순서)에 남긴다.
