# C05 다음 단위: MCP 전송 뒤 권한 변경과 원응답 보존

<!-- C05-MCP-CUSTODY-FINAL-PROOF: 3783a0a1f5ba3a4eea5a9a2231d5def3dbaf44a163c4444b8e559642283e463c -->
**MCP 전송 후 권한 변경의 원응답 보관·사용량 정산**을 연결했다. 허용한 읽기를 보낸 뒤 권한이 바뀌어도, 실제 받은 원응답과 입증된 사용량을 원 담당·원 시도에 보관하고 정산한다. 본문을 지금 보여 주거나 근거로 채택하는 권한은 따로 검사한다. 정상 저장 결과의 수신·채택 또는 거절/정산 → 필요한 compact(긴 대화 정리) → 문맥 체크포인트 복원 → 이후 작업 순서를 유지하며, 일반 run 진입에서 사용량 보완을 한 번의 유한한 과정으로 연결했다. **macOS Node24 신규 121/121·관련 775/775, NAS Linux Node24 신규 121/121·관련 775/775·전체 3,544/3,544 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-result.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-plan.md) · [MCP 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-linux-nas-20260907/verification.json). 보관 원문은 SDK가 해석한 MCP 응답 JSON이다. sent는 로컬 전송 시도 표시이며 원격 실행·성공·과금의 증명이 아니다. 입증되지 않은 측정값은 unknown(null)으로 남긴다. 원문 파일만 있거나 intent(호출 의도 기록)만 있으면 영수증을 만들어 복구하거나 자동 재전송하지 않는다. 원문·원 영수증·owner·자료 세대를 유지하며 현재 본문 검사를 느슨하게 하지 않는다. 서버를 다시 발견(tools/list)하는 현재 시작 경로는 유지되므로 서버 없는 재개는 아직 아니다. 다음 구현은 MCP 서버 없는 일반 CLI·Web 재개이며 설계 확정·제품 미착수다. 호스트가 명시한 저장 전용 도구에서 기존 보관·본문 검증을 재사용하고, 새 연결이 필요한 작업은 기다리며 다른 독립 작업은 진행하는 경계를 연결한다. 일반 입구의 collection(여러 항목 수집)·페이지·대기 복구와 문맥 조회 비용 개선도 후속이며, 원문·권한의 현재성 검사를 유지한다. [다음 구현 계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [사전 검토 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-notes.md) · [MCP 전체 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 판단·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file 연결의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

공개된 원 사용자 요청을 그대로 읽을 수 있는 재개는 보호 raw를 문맥에서 제외한 유효한 blocked 체크포인트를 반환할 수 있다. 이는 업무 완료나 보호 본문 채택이 아니다. 원 사용자 요청 자체를 읽을 수 없으면 사용량 정산 뒤에도 session_current_input_unavailable로 거절한다. GET·상태 조회·SSE는 읽기만 하며 정산은 명시 실행·명령에 연결한다.

같은 실행 측정값과 일치하는 기존 정산 이벤트·영수증을 확인한 시도는 정산 선별에서 raw 재조회를 생략한다. 정상 null 필드가 남았다는 이유로 반복 정산하지 않는다. 이 생략은 본문·문맥의 별도 원문 검증을 없애지 않으며 성능 개선 수치는 측정하지 않았다.

프로필 종료는 새 실행을 막고 모델·도구 연결을 닫은 뒤 기존 pending 수신을 기본 최대 5초 마무리하고 stores를 닫는다. 이 5초는 실행기 pending 마감이며 임의 호스트 close까지 포함한 전체 종료 상한이 아니다. 취소 신호와 DB commit의 원자화, 전원 손실 내구성을 보장하지 않는다.

최종 지원 POSIX 계약 인수를 확인했으며 다음 서버 없는 재개는 아직 구현하지 않았다. 아래 “구현 중”·“제품 미착수”·“권고” 표현과 연결부 표는 해당 시점의 설계 및 구현 기록이다. 이번 최종 범위와 실제 한계는 [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-sent-authority-result.md)를 따른다.

## 착수 및 구현 중 계획 이력

**현재 구현 연결 완료·통합 검증 중 — checkpoint316.** 최종 소스의 macOS Node24 신규121/121·관련775/775와 build/core/계층 검증은 실제 종료0이다. NAS Linux는 build·신규·관련·core·계층·CLI계층6단계를 통과하고 전체 시험(exec32757)을 실행 중이다. 최종 Linux 성공·원로그 회수·정리·proof와 문서 갱신은 남아 있다. [현재 재개 기록](../IMPLEMENTATION-RESUME.md)과 [결과 초안](C05-mcp-sent-authority-result.md)을 따른다. 아래 첫 검증 실패와 “제품 미착수” 표시는 과거 착수 시점 기록이다.

<!-- C05-MCP-RECOVERY-NARRATIVE-PROOF: f2fbe8a2e971f29bf182a9cf018d8122ef38b1c7996628e4e6b8da1b4e926960 -->

2026-09-07 · **선행 단순 원응답 복구의 지원 POSIX 검증은 완료했고, 이 전송 후 권한 변경 단위는 제품 미착수다.** 선행 결과는 macOS Node24 신규 55/55·관련 421/421, NAS Linux Node24 신규 55/55·관련 421/421·전체 3,423/3,423 통과. 같은 소스·빌드의 필수 8단계·회수·정리가 [복구 확정 증거](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json)로 확정되었다. [선행 결과](C05-mcp-response-recovery-result.md)를 보존하고 아래 좁은 계약을 확정한 뒤 다음 제품 구현을 시작한다. 실제 모델/API 시험은 계속 중단 상태다.

판단 근거는 [후속 소스 검토 기록](../../runtime/evidence/C05-mcp-sent-authority-source-review.json)에 분리했다. 해당 기록의 Linux 수치는 작성 당시 진행 중 관측으로 보존한다. 현재 선행 검증 결과는 위 확정 증거를 따르며, 선행 통과를 아래 새 권한·보관 기능의 구현 증거로 사용하지 않는다.

사용자가 허용한 조회가 이미 전송된 다음 권한을 줄였다고 해서, 프로그램이 실제로 받은 원응답과 측정값까지 없었던 일로 만들면 안 된다. 반대로 과거 전송 권한이 현재 본문 열람·근거 채택·새 조회를 허용하는 것도 아니다. 이번 단위는 **이미 시작한 단순 읽기 한 건의 수신을 마무리하는 권한**을 분리한다. 새 DB나 정산 장부, 별도 에이전트·승인 흐름을 만들지 않는다.

## 착수 전 구현에서 확인한 연결부

| 실제 코드 | 현재 보장과 남은 공백 |
|---|---|
| [ToolBroker.invoke](../../runtime/src/application/tool-broker.ts) | 원 dispatch와 현재 상태·호스트 실행 권한을 검사하고 `Tool.execute`에 `authorize`를 전달한다. 이 콜백은 실행 가능 상태·현재 정책·취소 신호·lease/deadline·계약·입력의 현재성을 모두 요구하므로, 보호된 원응답 보관을 허용하는 별도 권한이 아니다. `hooks.entered`는 도구 함수 진입 관측이며 실제 MCP 전송의 증명이 아니다. |
| [McpStdioClient.call / GuardedStdio.send](../../runtime/src/infrastructure/mcp-stdio-client.ts) | 실제 전송 직전 같은 authorize를 다시 검사한다. `sent`와 toolCalls는 `super.send` 직전의 로컬 전송 시도 표시다. 원격 서버의 실행·완료·과금 확정이 아니다. SDK request가 이미 resolve된 뒤에도 `check(session, signal)`이 실패하면 받은 값을 반환하지 않는다. request 자체의 reject와 이 후속 검사 실패를 분리할 필요가 있다. |
| [createMcpReadTool.execute](../../runtime/src/infrastructure/mcp-read-tools.ts) | client.call 뒤, artifact 저장 뒤, response 영수증 commit 전에 실행용 authorize를 반복한다. 따라서 응답을 실제 받았어도 권한 축소로 원문을 게시하지 못하거나 artifact만 남을 수 있다. `guard` 역시 과거 goal/policy와 현재 값의 완전한 일치를 요구한다. |
| 같은 어댑터의 envelope / original / projectResult | envelope v1·`mcp-intent`·`mcp-response` 및 원래 라벨의 artifact가 정본이다. 보관하는 것은 **SDK가 해석한 MCP 응답 JSON**이며 wire 프레임 바이트가 아니다. 원문 검증과 현재 근거로 가공하는 projector를 분리해 재사용할 수 있다. |
| [ExecutionRuntime.receiveOnce / adoptOnce](../../runtime/src/application/execution-runtime.ts) | 이미 반환된 유효 ToolResult는 원 시도에 수신하고 사용량을 기록한다. 현재 라벨이 줄어든 경우의 제한적인 usage 보존과 이미 received인 결과의 권한 취소 정산이 있다. 어댑터가 원응답 게시 전에 throw한 경우까지 보존하는 기능은 아니다. |
| [StoredToolResults](../../runtime/src/application/stored-tool-results.ts) | 현재 권한·목표·계획·입력이 동일한 원응답을 검증해 본문 복구 티켓을 발행한다. 권한 취소 후 보관·정산을 위해 이 검사를 느슨하게 하면 안 된다. 이미 확정된 수신·거절·실패를 되살리지 않는 기존 경계도 유지한다. |
| [ContextRecovery.refs / snapshot](../../runtime/src/application/context-recovery.ts), [authorizedWork](../../runtime/src/application/work-resources.ts) | authorizedWork는 정책을 현재 actor와 교집합으로 좁히지만 artifact 목록을 지우지 않는다. ContextRecovery는 기본적으로 자료 수명상 차단된 ref만 제외하고, 현재 허용 라벨 밖의 ref가 있으면 `resume_policy_insufficient`로 멈춘다. 따라서 보호된 raw를 원 라벨로 추가하는 것만으로는 일반 재개까지 연결되지 않는다. |
| [openAgentTurnProfile.close](../../runtime/src/presentation/agent-turn-profile.ts), [MCP host close](../../runtime/src/presentation/mcp-host-tools.ts) | 프로필 종료 신호를 보내고 모델·도구·stores를 닫는다. MCP close는 소유 peer를 정리한다. 이것만으로 종료 전에 도착한 모든 원응답의 로컬 저장까지 끝났다고 보장하지 않는다. |

[기존 실행 권한 시험](../../runtime/src/tests/execution-authority.test.ts)의 늦은 도구 결과 보존은 이미 ToolResult를 반환하는 대역의 검증이다. [이번 복구 실행기 시험](../../runtime/src/tests/stored-result-runtime.test.ts)은 이미 received인 결과의 거절·정산과 새 본문 복구의 권한 취소를 검증한다. 두 결과를 전송 후 MCP 원응답 보존의 완료 증거로 확대하지 않는다.

## 다섯 가지 판정은 분리한다

| 판정 | 이번 단위의 기준 |
|---|---|
| 실행 권한 | 지금 새 요청을 전송하거나 계속 실행해도 되는가. 현재 정책·실행 권한·취소 신호를 적용한다. 권한이 없으면 추가 전송은 0회다. |
| 수신 관측 | 동일 요청의 SDK 응답을 실제로 받았는가. 서버 audit나 sent=true만으로 응답이 도착했다고 추정하지 않는다. |
| 저장 권한 | 신뢰된 실행 호스트가 원 호출의 결과를 **그 담당의 원래 보관 영역에만 추가**할 수 있는가. 현재 사용자에게 본문을 공개하거나 과거 정책으로 일반 조회를 우회하는 권한이 아니다. |
| 현재 근거 채택 | 현재 goal/plan/input/자료 수명/권한에서 그 내용을 사용할 수 있는가. 권한 취소·목표 변경·기한 만료 등 기존 채택 차단을 유지한다. |
| 사용량 정산 | 원 시도에 귀속되는 측정값이 무엇인가. 원 dispatch의 논리 toolCalls 1회를 유지하고, 입증된 transportCalls만 같은 attempt.execution에 한 번 기록한다. 알 수 없는 값은 null이다. |

여기서 저장 권한은 신뢰된 호스트 내부의 좁은 역할이다. 현재 HostToolAssembly가 받은 state/artifacts 자체는 쓰기도 가능한 포트이므로, 이를 OS 샌드박스나 악성 플러그인 격리라고 부르지 않는다. 모델·HTTP·CLI 원문으로 저장 권한 객체나 과거 Policy를 지정할 수 없게 한다.

## 권고 구현안: 기존 수신 경로에 보호된 마무리만 연결

**1. 실제 응답 관측을 먼저 고정한다.** `McpStdioClient.call`에서 SDK request가 유효한 bounded JSON으로 resolve된 사실과 이후 현재 실행 권한 실패를 구분한다. 요청의 고정 session/endpoint/원격 이름·입력과 응답을 대조하며, 현재 연결 세대가 바뀌었다고 과거 응답에 새 세대를 써넣지 않는다. 원래 전송 직전 검사는 그대로 둔다. SDK request가 취소·오류로 reject되면 수신된 본문이 없는 것으로 기록한다. 뒤늦은 응답을 기다리려고 취소를 무시하거나 무기한 Promise를 남기지 않는다.

캡처는 요청별로 고정한다. 클라이언트는 여러 call을 동시에 허용하므로 공유 `lastReply` 같은 값으로 귀속을 추정하지 않는다. 한 요청의 실패로 연결이 닫혀도 다른 요청 각각의 “값을 받았음/없음”과 전송 관측은 구분한다. 현재 envelope v1의 `recordedAt`은 read-tools에서 응답 뒤 authorize를 마친 후 잡는 호스트 시각이다. 이를 과거 데이터까지 SDK resolve 시각으로 재해석하지 않는다. 새 구현에서 캡처 시각을 더 일찍 고정한다면 그 시점과 v1 호환을 명시하며, 영수증의 `updatedAt`도 물리 commit 완료 시각이 아닌 트랜잭션 준비 시각이라는 의미를 유지한다.

`sent=true`는 이 코드가 관측한 전송 시도 1회이며 원격 성공이나 청구 비용이 아니다. `McpCallError.sent=false`처럼 해당 클라이언트가 입증한 전송 전 거절은 0회다. 임의 예외를 무조건 sent=true 또는 0으로 바꿔 known usage로 채택하지 않는다. 원래 예외와 독립 close 실패를 보존한다. 크기·형식 한도 때문에 보관하지 않은 본문도 “원문 보존 완료”로 표시하지 않는다.

**2. 실행용 authorize와 보관용 확인을 나눈다.** ToolBroker가 원 dispatch와 승인된 실행 entry를 잡았을 때, 해당 호출에 한정된 보관 확인 함수를 내부적으로 발행하는 안을 권고한다. Tool 실행 context의 선택 기능으로 전달하되 기존 도구의 execute/authorize 계약은 유지한다. 정확한 심볼은 구현 직전 확정한다. 필요한 기능은 다음뿐이다.

- tenant·agent 저장소 소유·work·attempt·원 owner·dispatch 지문·task/input/계약 지문을 고정한다. 다른 업무·담당·사용자로 이동한 저장소에는 게시하지 않는다.
- 원 호출의 bounded envelope와 대응 response 영수증을 같은 소유 영역에 추가하는 용도로만 사용한다. 원문 덮어쓰기·임의 경로·새 네트워크 호출·새 배정은 허용하지 않는다.
- 현재 실행 권한 취소나 goal 변경은 본문 채택을 막지만, 그 사실만으로 원 호출에 귀속되는 수신의 보관을 막지 않는다. 원래 라벨과 tenant를 유지하며 현재 라벨로 낮추지 않는다.
- 자료 삭제·수명 세대 변경과 저장소 소유 변경은 별도 저장 거절이다. 삭제된 자료를 과거 권한으로 되살리지 않는다. 보관 불가를 명시하고 내용이 없는 안전한 측정 정보만 보존할 수 있는지 별도로 판정한다.
- 한 번 발행한 확인 객체도 매 게시 시 실제 dispatch·intent·현재 저장소 소유·자료 수명과 대조한다. 프로세스 재시작 후에는 호출자가 주는 토큰으로 인수하지 않고 저장된 영수증에서만 근거를 재구성한다.

MCP 어댑터는 전송 뒤의 authorize를 단순 삭제하지 않는다. `mcp-response`를 쓰는 구간에만 이 제한된 보관 확인을 적용하고, response receipt의 기존 원자적 게시와 바이트·해시 검사를 재사용한다. **이번 범위는 원 envelope v1과 정상 응답의 기존 해시/버전을 유지한다.** v1로 귀속과 측정값을 입증할 수 없는 임의 예외를 유효 응답으로 게시하지 않고, 기존 실패·unknown 측정 상태를 보존한다. 불확정 상태를 표현하려고 값을 꾸미거나 과거 v1을 일괄 재작성하지 않는다.

**3. 원문 공개 없이 정산하는 좁은 경로를 둔다.** 어댑터 내부의 원문 검증을 `original`과 공유하되, 정산용 결과는 원문·facts·projected output을 반환하지 않고 원 dispatch/response 귀속 증명과 usage만 반환한다. 이 기능을 기존 `restoreResult`의 “현재 권한으로 본문을 복원한다”는 의미에 섞지 않는다. 범용 실행기는 MCP 영수증 이름을 하드코딩하지 않고, 도구가 제공한 영수증을 검증하는 작은 선택 콜백/확인 객체를 사용한다.

현재 권한에서 본문 사용이 불가능하면 `receive:<attemptId>`의 기존 수신 구조로 **본문 없는 거절 결과와 입증된 usage**를 기록하고, 근거를 채택하지 않는 방향을 우선한다. 이때 기존 proof validator를 무조건 true로 만들지 않는다. 보호된 정산 증명으로 검증한 원 시도·영수증·측정값만 허용하는 실행기 내부 경로가 필요하다. `Attempt.owner`, lease/deadline, goal·plan, 원 예산은 바꾸지 않고 paused/cancelled/blocked/종료 상태와 그 사유도 보존한다. 업무를 자동 ready로 바꾸지 않는다.

이미 receive/adopt가 끝난 경우에는 원 결과 artifact나 영수증을 다른 내용으로 덮지 않는다. 이미 있는 측정값과 같으면 재전송을 수렴시키고, 충돌하면 오류로 멈춘다. 앞서 확정된 실패의 unknown 측정값을 보완해야 하는 경우에도 본문·상태·adopted는 유지하고 **같은 attempt.execution의 측정 필드만** 기존 state transaction/영수증으로 보완한다. 이 최소 보완이 필요하다면 현재 `tool-execution-usage.ts`에 일관된 병합 규칙을 두며, 새 비용 장부를 만들지 않는다. known 값을 뒤의 unknown으로 지우거나 서로 다른 known 값을 합산하지 않는다.

**4. 보관된 정본과 현재 문맥의 ref 목록을 구분한다.** raw는 state/artifact 정본에서 보존하되, 현재 문맥에는 읽을 수 있는 참조만 투영한다. 여기서 투영은 “정본을 지우거나 라벨을 바꾸는 것 없이, 이 사용자에게 보여 줄 목록을 계산한다”는 뜻이다. 보관 전용 raw 여부는 원 호출·수신 영수증으로 확인한다. 라벨이 안 맞는 모든 ref를 일괄 숨겨 필수 근거·의존성의 손상까지 정상으로 만드는 변경은 금지한다. state의 실제 지문과 저장된 영수증은 원 상태 기준을 유지하고, 현재 context/ResumePacket에 원문·가공 facts·사용 불가 ref가 끼지 않는지 재검증한다.

현재 작업 policy 자체가 적법하게 좁혀졌고 추가된 보호 raw만 문맥에 불필요한 경우에는 그 raw 때문에 checkpoint 전체가 막히지 않게 한다. 반대로 저장된 실행 policy가 현재 actor/host 권한보다 넓은 경우의 기존 `resume_policy_insufficient`·실행 거절은 유지한다. `authorizedWork`의 정책 교집합을 영구 저장하거나 그 검사를 삭제해서 재개를 강제하지 않는다. CLI/Web은 허용되는 상태 조회에서 원문 없이 “수신 보관됨/내용 사용 불가/측정 정산됨”과 실제 stop 사유를 보여 주고, 권한이 없는 재실행은 명시적으로 거절해야 한다. 이 두 경우를 같은 일반 입구 인수로 확인한다.

**5. close는 로컬 수신 마무리와 순서를 맞춘다.** 새로운 전송을 먼저 막고 소유 transport를 종료한다. 이미 캡처한 원응답의 로컬 게시·정산 Promise는 기존 실행기 pending 추적을 재사용해 유한 시간 안에 마무리한 뒤 stores를 닫는다. 실행 권한 취소 신호를 저장 완료 허가로 그대로 재사용하지 않는다. 마감 시각을 넘긴 작업은 미확정·cleanup 실패를 보존하며, stores를 닫은 뒤 late callback이 다시 기록하거나 성공했다고 보고하지 못하게 보관 수명도 닫는다. 새로운 상시 worker나 일반 목적의 무한 drain 서비스는 만들지 않는다.

## 수신·불확정·거절의 결과표

| 관측한 상태 | 보관·정산 | 현재 근거·다음 행동 |
|---|---|---|
| 전송 직전 권한 거절 | 유효한 전송 전 관측이면 transportCalls 0. 응답 본문 없음. | 추가 전송·근거 없음. |
| 전송 시도 뒤 SDK request가 취소/실패, 응답 없음 | 입증된 로컬 전송 시도만 기록. 원격 성공·실행 여부는 불확정. | 응답을 만들어 내거나 같은 attempt를 재전송하지 않는다. |
| SDK 응답을 받았고 게시 전에 실행 권한 축소/취소 | 동일 보관 소유·자료 수명이 허용하면 원 라벨의 envelope와 response receipt 보존. known usage 기록. | projector 출력의 본문 공개·근거 채택을 차단하고 원 업무 상태 유지. |
| artifact만 있고 response 영수증 없음 | 귀속이 확정된 수신으로 인수하지 않는다. 고아 파일 검색으로 정본을 찾지 않는다. | 선행 복구의 정지 경계 유지. |
| response 영수증 뒤 정산 전 프로세스 중단 | 새 프로세스가 같은 담당의 보관 권한과 원 영수증을 검증해 같은 시도에 한 번 정산. 새 tools/call 0회. | 현재 권한이 없으면 본문 없는 정산만. 이미 확정된 취소/실패를 되살리지 않는다. |
| 이미 received/adopt/거절 영수증 존재 | 기존 수신·정산을 우선하고 원문/영수증을 덮지 않는다. 동일 측정값은 중복 차감하지 않는다. | 기존 거절 상태를 권한 회복만으로 자동 채택하지 않는다. |
| 현재 goal/plan/입력 변경, 새 attempt 진행 | 귀속 가능한 옛 호출의 보관·정산만 원 attempt에 수행한다. | 새 목표·새 시도의 근거나 완료 상태를 덮지 않는다. |
| 자료 삭제 세대 변경·다른 소유자·손상·크기 초과 | 보호된 보관 자체를 거절하거나 명시된 제한만큼 실패 정보를 남긴다. 원문 보존을 성공으로 표시하지 않는다. | 과거 정책을 대입해 삭제·소유 경계를 우회하지 않는다. |

## 작은 구현 순서와 검증 기준

1. `mcp-stdio-client.ts`에서 실제 request resolve와 이후 권한 실패를 분리한다. 실제 stdin 관측·SDK 응답 관측·기존 close 실패 경계를 시험한다. 전송 직전 거절 검사는 그대로 통과해야 한다.
2. `tool-broker.ts`/`ports.ts`의 좁은 보관 확인과 `mcp-read-tools.ts`의 원응답 게시를 연결한다. 새 보관 확인은 도구 정의 지문이나 모델 입력에 추가하지 않는다. 원문 보관과 현재 가공·채택이 분리되는 실제 단순 읽기 한 건을 먼저 끝낸다.
3. `execution-runtime.ts`와 필요한 작은 정산 helper에서 기존 receive·usage·거절 경로를 연결한다. 보호된 증명 발행/검사에 `tool-contracts.ts`의 콜백 고정·strict shape와 선행 StoredToolResults의 영수증 재검사 방식을 재사용한다. 기존 본문 복구의 현재 권한 검사를 완화하지 않는다.
4. `context-recovery.ts`의 보관 전용 ref와 현재 문맥 ref 투영을 필요한 범위에서 연결한다. 기존 work 조회의 actor/host 권한 및 필수 근거 검증은 유지하고, CLI/Web 상태·stop·재개까지 확인한다. 이어 `mcp-host-tools.ts`/`agent-turn-profile.ts` close의 로컬 수신 마감만 연결한다. 별도 transport·보관 저장소를 조립하지 않는다.

필수 새 인수는 아래 경합을 작은 묶음으로 작성한다. 기존 MCP 프로토콜/스키마/provider 전체 시험을 복제하지 않는다.

- **실제 로컬 stdio MCP + C01 SQLite/file-journal:** 전송 직전 취소는 wire 0; 응답 관측 뒤·artifact 게시 뒤·response commit 직전의 정책 축소/authority abort는 원문 보존 여부·원 라벨·현재 evidence/output 비공개·known usage를 각각 확인한다. server audit의 tools/call 1과 원격 성공 판정은 구분한다.
- **불확정 구간:** 응답 없이 취소/연결 단절/close 실패, 임의 transport 예외, 한도 초과에서는 완료 응답을 만들지 않고 unknown/known/0의 근거를 보존한다. 모든 모르는 수치를 0으로 만드는 시험은 금지한다.
- **현재성·중복:** 원 owner receive와 보호된 정산 경합, 두 재개 실행기, 이미 실패/received/adopted인 상태, 이후 새 goal/attempt를 검증한다. 동일 호출·영수증·측정값은 한 번만 반영되고 다른 결과를 기존 정본에 덮지 않는다.
- **실제 SIGKILL:** response receipt 게시 뒤 정산 전, 정산 commit 뒤 반환 전의 원 worker를 부모가 IPC 관측 후 종료한다. 재개 시 원문·영수증·한도·원 owner가 보존되고 추가 전송/측정 합산이 없다. raw-only 중단은 별도 복구 불가 기대값을 유지한다.
- **보관 수명:** close 중 이미 캡처한 응답의 기록 완료와 마감 초과를 분리한다. 소유 peer만 닫고 원 오류와 cleanup 오류를 보존하며, stores close 뒤 추가 게시가 없다.
- **노출·삭제:** 라벨/도구/목적지 권한 축소, 자료 수명 변경, 다른 tenant/agent/work/attempt ref를 확인한다. CLI/Web/model/context/개인기억에 보호된 원문이나 가공 facts가 섞이지 않는다.
- **실제 일반 입구:** policy가 적법하게 좁혀진 같은 담당에서 protected raw 보존→known usage 정산→CLI/Web status/stop→재개를 수행한다. 보관 전용 ref만 제외된 checkpoint의 현재 참조 목록과 원 정본의 불변을 확인한다. 저장 policy가 새 호스트보다 넓으면 실행 거절을 유지한다. 필수 근거의 접근 불가·소실을 같은 필터로 숨겨 성공시키지 않는다.

선행 Linux 검증은 완료되었다. 이 다음 단위는 아직 제품 미착수이며, 구현 후 최종 소스에서 새 인수·관련 MCP/host/execution/복구 회귀·build/core/계층 및 유한 Linux 통합 검증을 수행해야 종료할 수 있다. 이번 문서 갱신은 그 다음 검증을 실행한 것이 아니다. 서버 없는 일반 입구, collection/페이지/대기, 쓰기·컴퓨터 유즈, 실제 사내 MCP/Knox·모델 품질·Windows/PostgreSQL은 별도 후속으로 유지한다. 전체 순서는 [C05 MCP 후속 필수 순서](C05-mcp-host-plan.md#c05-mcp-후속-필수-순서)를 따른다.

## 이번 구현에서 확정한 좁은 계약

- `authorizeResponseCustody`는 원 호출이 끝날 때 폐기되는 호스트 확인 함수다. 새 실행 권한을 부여하지 않으며 원 소유·dispatch·자료 세대만 확인한다.
- 새 `mcp-response` 영수증의 data에 `custody: { schemaVersion: 1, outcome, transportCalls }`를 추가한다. outcome은 정상 반환·post-check 실패 뒤 캡처·응답 없는 측정 실패를 구분한다. 원 envelope v1과 도구 정의/버전은 유지하고 기존 영수증 서명도 읽는다. 이는 새 저널 metadata이며 기존 저널을 재작성하지 않는다.
- 옛 failure.sent=true는 generic 예외도 1로 바꾸던 구형 코드의 모호함이 있어 새 사용량 전용 복구에서 unknown으로 취급한다. 새 영수증은 실제 McpCallError의 로컬 전송 관측과 captured reply를 구분한다. 임의 예외는 원응답이나 known1로 게시하지 않는다.
- `recordStoredUsage`는 원 시도의 execution 필드만 같은 상태 저장소에 보완한다. 기존 receive/결과/채택 영수증을 바꾸지 않고, 이후 receive도 known 측정을 unknown으로 덮지 않는다. 본문 검증기를 우회해 true로 만들지 않는다.
- 문맥 투영은 현재 읽을 수 없으면서 다른 필수 ref로 쓰이지 않는 보관 전용 raw만 검증 후 제외한다. 원 상태 지문과 파일은 보존한다. 보호 raw가 있는 드문 경로의 조회 비용은 아직 최적화/계측하지 않았다.
- 종료는 실행 취소→모델·transport 정리→기존 pending 최대5초 마무리→저장소 정리로 연결한다. 마감 뒤 보관 확인과 결과 게시를 거절한다. 실제 종료 경합 인수는 아직 작성·검증 중이며 완료 보장이 아니다.

## 재시작 연결의 구현 결정 — checkpoint312 준비

직전 goal 턴은 첫 로컬 통합 검증과 확인된 시험 준비/기대값 교정을 완료한 progress다. 다음 연결에서는 기존 정상 본문 수신·채택 기회를 먼저 유지하고, 첫 compact/문맥 복원 전에 원 시도의 사용량만 확인하는 호스트 pass를 한 번 수행한다. 이 pass는 시작 때의 후보 ID 목록을 고정하고 각 ID를 한 번씩 처리한다. 새로 추가된 시도를 같은 pass에서 계속 추적하지 않으며 개별 증명 경합은 기존 최대8회 재검사를 따른다. 매 추론 step에서 반복하지 않는다. 정상 측정에도 null인 필드가 있으므로 null을 미정산 표지로 쓰지 않는다. 읽기 비용은 이번 인수에서 계수하고 C05 조회 비용 개선에서 별도 측정한다.

업무 생성 시각·사용자·담당 호스트 scope·대화 session scope를 고정하고 게시 직전까지 확인한다. 현재 실행 권한과 구분된 보관 소유 확인만 적용하며, 원문이나 가공 facts는 반환하지 않는다. 일반 run의 기존 실행 authorize는 그대로 둔다. Web의 명시 제어 명령 뒤에도 같은 pass를 사용하되 GET/SSE/CLI status에는 붙이지 않는다. 새로운 공개 복구 명령이나 상태 저장소는 추가하지 않는다.

이미 사용량만 정산된 미수신 시도는 기존 `tool-usage:<attemptId>:<source>` 정산 영수증을 검증한 경우에만 정상 본문 복구 후보가 될 수 있다. 기존 unknownExecution 조건을 무조건 제거하지 않는다. 본문 복구의 현재 권한·목표·입력·상태·기한·출처 검사를 유지하며, 이미 받은 거절/실패 결과를 되살리지 않는다. 원 시도 정산과 본문 수신이 서로를 막지 않는지 별도 회귀로 확인한다.

실제 stdio 응답 뒤 raw/response/usage commit의 SIGKILL 인수와 실제 프로필 전체 close 인수는 별도 시험 파일로 작성한다. 새 일반 workflow·CLI/Web 인수까지 통합한 뒤 빌드/선정 검증을 실행하고 최종 소스의 Linux 검증으로 이어간다.
