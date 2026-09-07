# C05 — MCP 서버 없는 일반 재개 결과

<!-- C05-MCP-OFFLINE-FINAL-PROOF: 28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9 -->
**MCP 서버 없는 일반 재개와 명시 온라인 재열기**를 연결했다. 신뢰된 시작 프로그램이 저장 전용 모드를 명시하면 MCP 서버를 시작하거나 발견하지 않고 같은 담당의 저장 응답과 영수증을 검증해 일반 CLI·Web에서 재개한다. 새 읽기가 필요하면 연결을 기다리고, 같은 담당을 온라인으로 다시 열어 기존 목표를 이어 실행한다. **macOS Node24 신규 145/145·관련 847/847, NAS Linux Node24 신규 145/145·관련 847/847·전체 3,601/3,601 통과**. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-result.md) · [계획과 이력](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [저장 전용 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-usage.md) · [MCP 호스트 사용법](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-usage.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-linux-nas-20260907/verification.json). 저장 계약과 새 호출 가능성을 구분하며 원문·현재 권한·목표·출처 검사는 유지한다. raw 파일만 있거나 intent 영수증만 있으면 응답 영수증을 만들거나 재전송하지 않는다. 보관·사용량 정산 성공은 본문 채택이나 업무 완료의 허가가 아니다. 자동 연결 실패 fallback과 모델까지 포함한 무네트워크 실행을 뜻하지 않는다. 다음 후보는 collection(여러 항목 수집)·페이지·대기의 일반 입구 연결이다. 검토 메모를 준비했으며 제품은 미착수다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도 측정·인수한다. [후속 연결 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-notes.md) · [전체 MCP 순서](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-host-plan.md) · [조회 비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다.

C01 SQLite/file-journal에서 실제 로컬 stdio peer를 닫은 뒤 별도 CLI 자식 프로세스 2사례와 실제 localhost HTTP 4사례를 확인했다. HTTP는 저장 응답 복구·재열기와 미호출 작업의 연결 대기→명시 온라인 재열기를 각각 두 저장 방식에서 확인했다. 온라인 전환은 원 work/session/goal/plan/task를 보존하고 tools/call 한 번으로 완료하며, 같은 명령 재전송은 추가 호출·정산·답변을 만들지 않는다. 실제 브라우저 렌더링 시험은 아니다.

소스 지문 `fe438a3d25a33c43b3b7403b9b584df78eef86f044aadf9c7102cd6969798a15`, 빌드 파일 지문 `f6c07038312ab9a9db5b94f70ef3caa106ee104d12aaa00146dc29d47c3d745f`, 파일 수 1,758의 같은 빌드에서 확인했다. Linux 종료는 `2026-09-07T14:48:57.769Z`이며 필수 8단계와 원로그·결과 9개 회수, 관측 가능한 전용 root 프로세스 0개 및 SSH 종료를 확인했다. 접근 불가 peer 2개와 범위 미확정 2개는 남으므로 시스템 전체 프로세스 부재를 주장하지 않는다. 최종 소스의 로컬 전체 회귀는 별도 실행하지 않았고 Linux 전체와 구분한다.

첫 로컬 실행 이력: [new1](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-new1.json) 143개 중 143 통과·0 실패 ([원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-new1.log)) → [related1](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-related1.json) 847개 중 833 통과·14 실패 ([원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-related1.log)). new1은 당시 선택 파일의 통과 기록이며, related1의 실패는 context-dispatch의 종전 늦은 거절 기대를 새 조기 취소 경계에 맞춘 회귀와 구분한다. 원 입력·정책·dispatch 부재 검사는 유지했고 HTTP 입구 인수를 추가한 뒤 최종 소스로 다시 검증했다. 첫 실행의 지문·종료·로그를 바꾸거나 최종 통과 수에 더하지 않는다. 선행 [custody 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-custody-linux-nas-20260907/verification.json)의 Linux 3,544/3,544는 당시 결과로 보존한다.

## 첫 Linux 실패와 시험 경계 교정

첫 Linux 전체 회귀(attempt 1)는 3,600개 중 3,595 통과·5 실패로 exit 1 종료했다(`2026-09-07T14:18:41.404Z`, v24.20.0). 당시 소스 `761bfb504e747fea69af87527cb727f9aad8816374ecda9cc2179fcaefd66fb8`, 빌드 파일 `88524788c9306dee0acdf77b1c485c34d1699f452d4793a79e9a0f4e780e8248`, 파일 1,758개다. 이 [실패 결과](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-linux-nas-20260907/attempt-1/result.json)와 [전체 원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-linux-nas-20260907/attempt-1/all-tests.log)는 최종 proof의 priorAttempts·files에 보존되어 있다. 원로그의 실패 이름은 다음과 같다.

- sqlite: disclosure revoked during stored model input read stops the final transport
- file-journal: disclosure revoked during stored model input read stops the final transport
- effect proofs: losing proof during model input read prevents actual planner entry and still settles the dispatched call
- cancel during input artifact read prevents transport invocation and releases the known unused token reservation
- goal during input artifact read prevents transport invocation and releases the known unused token reservation

새 dispatch 전 입력 읽기에 시험의 첫 읽기 hook이 먼저 걸린 경계였다. 세 시험 파일의 기존 전송 전 제어 사례를 정확한 원 입력·저장된 running call·model-dispatch 영수증과 digest에 묶었고, reserved 읽기는 즉시 반환하도록 교정했다. 원래 호출 0·사용량 정산·사용자 상태·입력 보존 검사를 유지했고, effect proof의 dispatch 이전 소실은 별도 사례로 추가했다. 제품 가드는 변경하지 않았다. [교정 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-fixture-correction-result.json), [집중 시험 runner](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-related-native-fixes1.json), [집중 원로그](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-related-native-fixes1.log)에서 v24.20.0·exit 0·68/68 통과와 실행 전후 같은 최종 소스/빌드 지문을 대조했다. 이 세 파일은 updater가 별도로 확인한 로컬 보완 증거이며 최종 proof.files에 포함된 증거가 아니다. 교정 기록의 pending·nativeRecheck 문구는 그 기록 작성 당시 상태로 남긴다. 집중 수를 최종 신규·관련·Linux 전체 수에 더하지 않는다.

모델 dispatch의 저장 입력 artifact 읽기 1회가 추가됐고 반복 원문·이벤트 검증 비용도 남는다. 이번 결과로 성능 개선 수치를 주장하지 않는다.

아래의 “진행 중”·Linux 미확정 표시는 작성 당시 초안이다. 최종 확인 범위는 이 상단의 실제 증거를 따르며 이전 진단·원로그는 보존한다.

## 구현 중 초안과 첫 검증 이력

2026-09-07 · **구현·검증 중.** 현재 로컬 Node 24.20.0의 build2·core2·architecture2가 종료 0이며, 새로 선택한 10개 파일의 new2는 **145/145**, 관련 67개 파일의 related2는 **847/847**, context-dispatch 교정 확인은 **16/16 통과**했다. 신규 선택에는 신규 시험과 변경한 기존 회귀가 함께 있다. NAS attempt1(exec 98882)은 13:58:29.952Z에 시작했고, root의 현재 관측은 build·신규 단계 통과 후 관련 단계 진행이다. 이번 Linux 최종 집계·회수·종료 감사·verification proof는 아직 확정하지 않았다. 첫 new1 143통과와 related1 847중833통과/14실패는 아래에 별도 이력으로 보존한다. C05 전체·전체 goal 완료를 뜻하지 않는다. [계획](C05-mcp-offline-resume-plan.md) · [사용법](C05-mcp-offline-resume-usage.md).

같은 담당의 저장 응답을 검증하는 데 MCP 서버의 새 발견이 반드시 필요하던 연결을 분리했다. 호스트가 `stored_only`로 명시해 연 프로필은 MCP client나 peer를 만들지 않고 기존 원응답을 처리한다. 새 자료가 필요한 작업은 연결을 기다리며, 호출할 수 있는 독립 작업은 진행할 수 있다. 온라인 연결 실패를 자동으로 저장 전용 성공으로 바꾸는 기능은 아니다.

## 실제 연결한 계약

[createMcpHostTools](../../runtime/src/presentation/mcp-host-tools.ts)는 기존 `{mode?: 'online', config, bindings, policy, limits}`와 새 `{mode: 'stored_only', origin, bindings, policy, limits}`를 구분한다. `origin`은 현재 호스트가 지정한 `endpointId`와 지원하는 `protocolVersion`만 받는다. 모순되는 config/origin, 임의 generation·discoveryDigest를 거절한다. 저장 전용은 고정한 static tools를 반환하고 `providerSources`를 만들지 않는다. 한 등록의 endpoint/provider와 단순 읽기 binding 제약, 쓰기 금지 정책도 유지한다.

[createMcpStoredReadTool](../../runtime/src/infrastructure/mcp-read-tools.ts)은 온라인 factory와 같은 내부 구현을 사용한다. remote 계약·projector ID/버전·endpoint·protocol의 binding digest, 버전 suffix와 전체 definition 지문을 동일하게 계산한다. 가짜 온라인 세션을 만들지 않고, 과거 generation·discoveryDigest는 원 envelope와 intent 영수증에서 대조한다. 현재 호스트에 없는 과거 도구를 저장 파일이나 사용자 원문에서 자동 등록하지 않는다.

C01 state/artifact/clock/digester와 기존 dispatch·intent·response, `restoreResult`·`restoreUsage`·`validateResult`를 재사용한다. **새 DB, 복구 장부, 담당 config 버전, 원 envelope·영수증 형식은 추가하지 않았다.** 원문은 SDK가 해석한 MCP 응답 JSON이며 네트워크 패킷 원본이라는 뜻은 아니다. 기존 512 KiB envelope 상한, 정확한 artifact 참조·SHA-256·소유·삭제 세대·시간 순서와 현재 본문 권한 검사를 유지한다. 원문 파일만 있거나 intent만 있는 경우는 디렉터리 탐색이나 원격 재호출로 보완하지 않는다.

저장 전용 reader는 C01 저장소의 소유자가 아니다. 프로필이 전달한 포트를 사용하고 자신의 close로 저장소를 닫지 않는다. 도구 lease가 닫힌 뒤에도 살아 있는 기존 포트를 통한 보관 정산 마무리를 허용하지만, 실제 저장소를 닫고 다시 연 경우 낡은 reader를 새 handle로 자동 연결하지 않는다. 프로필 종료와 실행 중인 모든 비동기 작업의 완전한 drain을 새로 원자화한 것은 아니다.

## 새 호출과 받은 응답을 구분한다

`Tool.availability`는 definition 밖의 선택 호스트 메타데이터다. 생략은 기존 실행 동작을 유지하며 `stored_only`는 저장 증명에 사용할 계약만 남긴다. [ToolContracts](../../runtime/src/application/tool-contracts.ts)의 `get/check/visible`은 과거 계약 검증 의미를 유지하고, 새 `callable(policy)`·`checkExecution(task, policy)`가 호출 가능성을 검사한다. 계약·권한 오류를 먼저 확인하므로 권한 없는 도구를 연결 대기로 숨기지 않는다.

Catalog 검색과 새 모델 입력의 `options.tools`, active tool IDs, 정책의 활성 도구 부분집합은 callable 정의만 사용한다. 완료한 의존 작업·관측 결과·출처 계약은 문맥에 남는다. [ContextCompiler](../../runtime/src/application/context-compiler.ts)와 [AgentTurnCalls](../../runtime/src/application/agent-turn-runtime.ts)의 송신 검사를 별도로 두었으므로, 같은 definition이 저장 전용이 됐다는 이유만으로 이미 running/received인 모델 응답의 알려진 사용량이나 답변 증명을 무효화하지 않는다.

[PlanningRuntime](../../runtime/src/application/planning-runtime.ts)은 도구 등록 revision을 검사·materialize 캐시에 반영한다. 모델 예약의 편집·게시 직전, dispatch 차감 전, 모든 비동기 검사 뒤 transport 진입 직전에 고정 입력의 도구가 여전히 호출 가능한지 확인한다. 미송신 예약은 `model_tools_changed`로 기존 취소·예산 반환 경로를 사용하며 원 입력 artifact를 고쳐 쓰지 않는다. dispatch를 이미 기록했지만 실제 모델 송신 전에 막힌 경우는 기존 장부의 modelCalls 1을 유지하고 알려진 token 0을 정산한다. availability 변경 전 이미 송신한 응답은 기존 수신·채택 검사를 따른다.

도구의 reserve/dispatch·Broker 최종 진입도 같은 현재 실행 검사를 사용한다. [실행 제어](../../runtime/src/application/execution-decision.ts)와 Workflow 최종 결과까지 `wait / connection_required`를 유지한다. 준비된 작업 중 연결이 필요한 후보를 건너뛰고 다른 실행 가능한 작업을 선택한다. 이미 있는 미송신 예약은 원 owner·lease를 유지하고, 연결이 돌아오거나 원 lease가 만료될 때 기존 규칙으로 진행·반환한다. 실제 전송 후 `reservation_expired`나 `reservation_cancelled`라는 오류를 받은 시도까지 미송신 예약으로 제외하지 않도록 maxAttempts 판정도 맞췄다.

정상 저장 결과의 수신·채택 또는 거절/정산 → 필요한 compact → 문맥 체크포인트 복원 → 이후 작업 순서를 유지한다. 연결 대기 때문에 불필요한 자동 compact를 새로 예약하지 않으며, 명시 compact 요청 자체를 막지는 않는다. 상태 GET·이력 조회는 정산 명령으로 바뀌지 않았다. 알려진 원 호출 사용량의 보완과 현재 본문 읽기·채택은 계속 별개다.

## 실제 CLI 2개·HTTP 4개의 범위

[mcp-offline-entry.test.ts](../../runtime/src/tests/mcp-offline-entry.test.ts)는 SQLite와 file-journal 각각 아래 세 흐름을 실행했다. 모든 원응답 준비와 명시적 온라인 재연결은 실제 로컬 stdio MCP peer를 사용한다. 모델은 호스트가 명시 등록한 결정적 합성 제공자이며 실제 모델 API를 호출하지 않는다.

| 일반 입구 | 준비와 실제 관측 |
|---|---|
| CLI, 저장 방식별 1개 | 온라인 원 호출의 raw·response 영수증을 저장하되 runtime receive는 아직 없는 상태에서 프로필과 실제 peer를 종료한다. 원 lease가 지난 시각에 새 CLI 자식의 `status`는 상태를 변경하지 않고, `resume`은 같은 원 attempt를 복구·채택해 고정 답변을 전달한다. 원 dispatch/intent/response·raw bytes·사용자 입력·목표·계획을 보존한다. toolCalls 1, transportCalls 1, 새 답변 modelCalls 1이며 반복 resume에서 attempts·사용량·이력은 증가하지 않는다. |
| localhost HTTP 원응답 복구, 저장 방식별 1개 | raw·response는 있고 runtime receive는 없는 상태에서 peer를 종료한다. GET은 상태를 바꾸지 않고 명시 run이 같은 원 attempt를 복구·채택해 답변을 전달한다. 원 ID·dispatch/intent/response·raw bytes·입력·목표·계획·세션을 보존한다. toolCalls/transportCalls/답변 modelCalls는 각각 1이며, 앱을 닫고 새로 열어 같은 명령을 보내면 duplicate로 응답하고 재호출·재정산·대화 중복을 만들지 않는다. |
| localhost HTTP 연결 대기→온라인 재열기, 저장 방식별 1개 | 온라인 발견 뒤 미호출 계획만 저장하고 peer를 종료한다. 저장 전용 GET은 상태를 바꾸지 않으며, 명시 run과 앱 재열기 뒤 같은 명령도 `connection_required` 대기·attempt/예약/모델 호출 추가 0을 유지한다. 그 앱을 닫고 호스트가 명시한 online 설정으로 같은 담당·세션을 열면 실제 peer 발견과 `tools/call` 1회로 원 작업을 완료한다. toolCalls/transportCalls/답변 modelCalls는 각각 1이고 같은 명령 재전송은 이력·사용량을 늘리지 않는다. |

저장 전용 구간에는 client의 discover/call/close를 호출하면 시험이 실패하도록 하고, 기존 peer 감사 로그의 **전체 bytes가 그대로**인지와 원 peer PID 종료를 확인한다. 명시적 online 전환 이후에는 실제 새 peer의 호출 1회와 종료를 별도로 확인한다. 이 6개는 실제 브라우저 관찰, SIGKILL·전원 중단, CLI를 통한 online 전환까지 확인한 시험은 아니다. 온라인 전환 시 이미 있는 미송신 예약의 1회 dispatch, 예약 만료와 독립 작업 진행은 별도 [실행기 회귀](../../runtime/src/tests/tool-availability-runtime.test.ts)에서 현재 C01 저장소와 합성 호출 대역으로 확인했다.

현재 145개 묶음에는 저장 reader/host의 원문·계약·정산 거절, [모델 경합 14개](../../runtime/src/tests/model-tool-availability.test.ts), catalog/provider 교체, Broker 비동기 경합, 기존 보관 결과·사용량 검사가 포함된다. 손상·소유·삭제 세대·다른 binding과 본문 권한 거절을 서버 부재라는 이유로 느슨하게 하지 않았다. 시험 선택 전체는 [10개 파일 목록](../../runtime/evidence/C05-mcp-offline-new-files.json)에 남겼다.

## 현재 확인한 증거

| 항목 | 이 초안에서 확인한 결과 |
|---|---|
| Node | 로컬 macOS 실행 wrapper에 `v24.20.0` 기록 |
| build2 | `npm run build`, exit 0, source 전후 동일. [JSON](../../runtime/evidence/C05-mcp-offline-build2.json) · [로그](../../runtime/evidence/C05-mcp-offline-build2.log) |
| core2 | `npm run typecheck:core`, exit 0, source 전후 동일. [JSON](../../runtime/evidence/C05-mcp-offline-core2.json) · [로그](../../runtime/evidence/C05-mcp-offline-core2.log) |
| architecture2 | `npm run check:architecture`, exit 0. [JSON](../../runtime/evidence/C05-mcp-offline-architecture2.json) · [로그](../../runtime/evidence/C05-mcp-offline-architecture2.log) |
| new2 | TAP tests/pass 145, fail/cancelled 0, wrapper exit 0. 13:53:45.688Z 종료. [JSON](../../runtime/evidence/C05-mcp-offline-new2.json) · [원로그](../../runtime/evidence/C05-mcp-offline-new2.log) |
| related2 | TAP tests/pass 847, fail/cancelled 0, wrapper exit 0. 13:56:48.785Z 종료. [JSON](../../runtime/evidence/C05-mcp-offline-related2.json) · [원로그](../../runtime/evidence/C05-mcp-offline-related2.log) |
| context-dispatch 교정 | 16/16, fail/cancelled 0, wrapper exit 0. related2에 포함된 시험의 좁은 확인이며 별도 신규 개수로 합산하지 않는다. [JSON](../../runtime/evidence/C05-mcp-offline-related-context1.json) · [원로그](../../runtime/evidence/C05-mcp-offline-related-context1.log) |
| Linux | root 관리 exec 98882에서 같은 pin으로 실행 중. 이번 전체·회수·종료 감사·최종 proof는 미확정. |

현재 확인한 source digest는 `761bfb504e747fea69af87527cb727f9aad8816374ecda9cc2179fcaefd66fb8`, build의 `filesDigest`는 `88524788c9306dee0acdf77b1c485c34d1699f452d4793a79e9a0f4e780e8248`, `fileCount`는 1758이다. new2·related2·교정 확인 wrapper는 이 세 값의 실행 전후 동일성, 자식 exit/stdio close와 직접 만든 process group의 부재를 기록했다. 독립적으로 다른 group으로 옮긴 후손까지 모두 없다는 보장은 포함하지 않는다.

첫 동결 source `5be670d9bfdefbc5cc54d96b267b78131e05ffb7464ed335406c52601ebc51b4` / filesDigest `0a3a3214ef6c4e5f6ff81251d5cf8198056bd14475ab1e37d150ba4346c36ef6`의 [build1](../../runtime/evidence/C05-mcp-offline-build1.json)·[core1](../../runtime/evidence/C05-mcp-offline-core1.json)·[architecture1](../../runtime/evidence/C05-mcp-offline-architecture1.json)과 [new1 143/143](../../runtime/evidence/C05-mcp-offline-new1.json)·[원로그](../../runtime/evidence/C05-mcp-offline-new1.log)는 그대로 보존한다. [related1](../../runtime/evidence/C05-mcp-offline-related1.json)은 최종 847중833통과/14실패, exit 1이었다.

[related1 원로그](../../runtime/evidence/C05-mcp-offline-related1.log)의 14실패는 두 저장 방식에서 도구 제거·버전·schema·labels·destination 및 guidance 변경을 넣은 [context-dispatch](../../runtime/src/tests/context-dispatch.test.ts)에서 발생했다. 모두 기존 helper의 `status: rejected` 기대와 실제 `cancelled`가 달랐다. 그 앞의 실제 송신 0과 adopt false 검사는 통과했다. 새 송신 검사가 dispatch 차감 전에 기존 definition/guidance 불일치까지 발견하므로, 올바른 결과는 미송신 `cancelled / not_called`와 모델 호출 차감 0이다. 원입력 bytes·현재 policy 보존, dispatch 영수증·답변 artifact 부재, 예약 반환까지 강화하여 기대값을 교정했고, 현재 pin의 좁은 16/16과 related2 847/847에서 확인했다. 제품의 거절을 느슨하게 하거나 원본을 새 계약으로 고쳐 보내는 수정은 하지 않았다. 최초 실패 assertion 뒤의 usage·budget 값은 그 실패 로그에서 확인한 값으로 소급하지 않는다.

선행 [MCP 연결 proof](../../runtime/evidence/C05-mcp-linux-nas-20260907/verification.json), [저장 응답 복구 proof](../../runtime/evidence/C05-mcp-recovery-linux-nas-20260907/verification.json), [전송 후 보관·정산 proof](../../runtime/evidence/C05-mcp-custody-linux-nas-20260907/verification.json)는 각각 별도 소스의 확정 이력이다. 선행 Linux 전체3544·v0.65를 이번 offline 소스의 전체 통과로 옮겨 쓰지 않는다. 이번 결과의 최종화는 같은 pin의 Linux 검증·로그 회수·종료 관측을 기다린다.

## 비용과 남은 범위

고정 입력의 도구 목록을 검사하려고 reserved 상태의 비compact 모델 dispatch에서 입력 artifact 읽기 1회를 추가했다. 메모리 저장소의 get일 수도 파일-backed 읽기일 수도 있으며 실제 읽기 bytes·시간은 아직 측정하지 않았다. 기존 보관 proof의 반복 원문 검사도 그대로 남는다. [조회 비용 검토](C05-context-cost-review.md)에 후속 관측 범위를 추가하며, 연결 없는 재개가 곧 검증 I/O 감소라는 주장은 하지 않는다.

현재 호스트가 지원하는 단순 읽기 binding을 명시한 경우의 재개다. MCP 서버가 임의로 끊기는 것을 자동 판별하거나 연결 실패 뒤 fallback하지 않는다. 저장된 결과로 업무를 마무리할 수 없으면 필요한 모델·다른 도구는 별도 가용성이 필요하다. 서버 없는 MCP 재개가 모든 외부 의존성 없는 실행을 뜻하지 않는다.

collection·페이지·대기 도구의 일반 입구 연결, 조회 비용 개선은 후속이다. 실제 모델의 의미 품질·토큰 추정·사용량·취소, 사내 MCP/Knox·실서비스 호출, native Windows runtime/file binding 연결과 검증, PostgreSQL 구현·검증은 완료하지 않았다. 실제 모델/API 시험 중단을 유지한다. 기존 프로세스 중단 시험과 이번 정상 close/reopen 인수도 구분하며, 원문의 의미를 합성 모델이 일반적으로 이해했다고 주장하지 않는다.
