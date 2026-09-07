# C05 MCP collection·page·wait 일반 입구 연결 준비

2026-09-07 · **다음 구현 단위 제안이며 구현·실행 결과가 아니다.** 제품과 시험은 동결 상태로 읽었다. 서버 없는 단순 읽기 단위의 NAS 실행 `98882`는 작성 시 진행 중이며, 이 메모에서 감시하거나 검증을 반복하지 않았다. [기존 호스트 계획](C05-mcp-host-plan.md)의 페이지·대기 후속을 현재 소스에 맞춰 구체화한다. 그 문서에 남은 단순 읽기 raw/custody/offline의 초기 미구현 설명은 역사적 범위이며, 현재 collection의 미구현 범위와 구분한다.

사용자가 일반 CLI/Web에서 여러 자료를 요청하면, 담당은 이미 받은 항목을 보존하면서 다음 페이지나 실패한 항목만 이어 읽어야 한다. 서버가 기다리라고 한 경우에는 원응답에서 검증한 시각까지 대기한다. 서버 없이 다시 열었을 때도 저장된 페이지를 검증·정산할 수 있어야 하며, 새 요청이 필요하면 연결 필요를 알린다. 페이지 수집 완료와 사용자의 최종 답변 완료는 계속 별개다.

## 실제로 재사용할 경계

| 현재 코드 위치 | 이미 있는 기능 | 일반 입구에서 남은 연결 |
|---|---|---|
| [mcp-read-collections.ts](../../runtime/src/infrastructure/mcp-read-collections.ts) 23·51행 | `McpReadCollectionBinding`, `createMcpReadCollection`이 manifest·page projector·선택적 deferral projector를 고정한다. 반환값은 `ReadCollectionBinding`이다. | 현재 factory는 실제 발견한 `McpSession`과 call client를 요구한다. 일반 프로필 등록과 서버 없는 factory는 아직 없다. |
| [read-collections.ts](../../runtime/src/application/read-collections.ts) 27·192행 | `createReadCollectionTool`이 binding을 코어 실행기로 연결한다. 같은 collection 장부가 요청 intent, 원 manifest, source snapshot, cursor, 항목 결과, 한도와 successor를 관리한다. | host helper에서 새 `ReadCollections`를 만들거나 binding을 `Tool`로 캐스팅하지 않는다. |
| [compose-runtime.ts](../../runtime/src/application/compose-runtime.ts) 60·95·143행 | `collectionTools`를 자신의 `ReadCollections`에 연결하고 기존 `ToolContracts`에 등록한다. 반환값에도 그 실행기가 있다. | [agent-turn-profile.ts](../../runtime/src/presentation/agent-turn-profile.ts) 138행의 compose 호출은 아직 collection binding을 전달하지 않는다. |
| [read-reconciliation.ts](../../runtime/src/application/read-reconciliation.ts) 97행, [ToolContracts](../../runtime/src/application/tool-contracts.ts) 216행 | 원 `mcp-page` 영수증과 request intent를 검증한 `restoreReadResponse`로 미정산 응답을 기존 checkpoint에 반영한다. 등록 교체·상태 변경을 재검사한다. | plain 도구의 `restoreResult`/`restoreUsage`에 collection을 끼우지 않는다. collection의 기존 정산 경로를 일반 재개에서 도달 가능하게 한다. |
| [read-waits.ts](../../runtime/src/application/read-waits.ts) 18·30·63행 | `readWaitControl`은 일정 힌트이며, 실제 할당·전송 전에 원 checkpoint와 deferral/page 증명을 다시 읽는다. 기한 전 재요청을 차단한다. | 별도 wait 어댑터나 타이머 서비스를 만들 필요가 없다. 실제 파일명은 `mcp-read-waits.ts`가 아니라 collection의 `deferral`과 이 코어 파일이다. |
| [mcp-host-tools.ts](../../runtime/src/presentation/mcp-host-tools.ts) 15·26·40행, [host-tools.ts](../../runtime/src/presentation/host-tools.ts) | 현재 helper는 plain binding만 받으며 collection을 명시 거절한다. 같은 C01 custody/schema/signal, 정책·한도, 소유 client의 종료를 이미 제공한다. | collection 전달 형태와 availability 전달이 필요하다. 모델 factory에 저장소를 노출하거나 두 번째 DB를 열 이유는 없다. |

페이지 입력은 이미 `query: task.input`과 `read: {requestId, cursor, snapshot, retryIds, itemLimit}`로 구성된다. batch/paged, 전체 deferral, 항목별 retry는 이 계약을 따른다. endpoint 이름이나 특정 보안 업무를 코어 분기로 추가하지 않고, 호스트가 등록한 범용 binding/projector가 원격 결과를 이 기존 형식으로 해석한다.

## 권고하는 최소 구현 단위

**한 endpoint의 collection 등록부터 일반 CLI/Web의 온라인 진행·저장 응답 재개·기한 대기까지 한 단위로 연결한다.** 먼저 호스트가 연 client에서 신뢰된 원격 계약 목록 전체를 발견·검증하고, collection binding을 기존 `composeRuntime.collectionTools`로 넘기는 방식이 가장 작다. 같은 endpoint에 plain 도구도 있다면 같은 발견 결과에서 조립하여 한 등록이 목록 전체를 소유한다. 프로필이 반환되기 전에 모두 검증되어야 하며 발견 실패나 일부 계약 불일치는 부분 도구 목록으로 성공하지 않는다.

필요한 수정은 다음 연결에 한정한다. 공개 필드명이나 새 factory 이름은 아직 확정하지 않는다.

- `presentation/host-tools.ts`와 `agent-turn-profile.ts`: 호스트가 반환한 collection binding을 고정·검사하여 기존 compose 인자로 전달한다. read-only·금지 core·중복 ID/provider·정책·skills 제한을 일반 도구와 동일하게 적용하고, source callback이나 custody 포트의 소유권을 바꾸지 않는다.
- `presentation/mcp-host-tools.ts` 또는 작은 인접 helper: plain helper의 기존 옵션과 동작을 보존하면서 collection 등록을 조립한다. manifest/projector/deferral 함수와 데이터는 등록 시 고정한다. 각 프로필이 자기 client만 종료하고 조립 오류와 cleanup 오류를 함께 보존한다.
- `infrastructure/mcp-read-collections.ts`: 원응답 검증·투영 부분을 온라인 호출과 분리하여 명시적 저장 전용 조립에서도 재사용한다. 다음 절의 기존 지문·원문 형식은 유지한다.
- `application/ports.ts`와 `read-collections.ts`: collection binding에서 만들어지는 Tool까지 연결 가능 여부를 전달할 최소 경계를 정한다. 새 장부나 별도 실행기를 만들지 않는다.
- `execution-runtime.ts`/`workflow-runtime.ts`는 기존 복구의 호출 순서가 실제 일반 입구에서 막힐 때만 좁게 연결한다. 일반 CLI/Web에는 기존 host 주입과 `workflow.run`/상태 조회를 재사용한다.

현재 `providerSources`는 compose 이후 `refreshProviderTools`로 **provider 전체**를 게시한다. 따라서 같은 provider의 plain 도구를 기존 source에 남기고 collection만 고정 목록에 넣으면 안 된다. 위 권고의 초기 발견·고정 조립을 택할 때도 두 목록을 함께 소유하는 검사가 필요하다. 실행 중 갱신이 꼭 필요한 후속 요구가 생기면 기존 실행기의 `createReadCollectionTool` 변환을 거친 완전한 provider 목록 한 번 게시로 확장한다. 이번 연결만을 위해 새 provider framework나 두 번째 카탈로그를 만들지 않는다.

## 저장 전용과 대기의 보존 조건

`createMcpReadCollection`의 binding 지문에는 remote 계약, projector ID/version, endpoint/protocol, `stored-response-v1`, coverage와 deferral 설정이 들어간다(65행). online/stored-only를 바꾼다는 이유로 이 지문이나 definition version을 바꾸면 과거 task/checkpoint가 다른 도구가 된다. envelope v1의 session·원 recordedAt, `mcp-page:<attemptId>:<requestId>` 영수증과 그 digest 형식도 유지해야 한다.

현재 `capturedSession`은 호출·새 envelope 생성 외에는 저장 원문을 검증할 때 endpoint/protocol 대조에 사용된다(138·185·192행). 따라서 단순 읽기의 [명시적 stored origin 조립](../../runtime/src/infrastructure/mcp-read-tools.ts) 61행처럼, 검증에 필요한 출처와 온라인 세션 수명을 분리할 여지가 있다. 기존 envelope에서 읽은 historical session을 보존하고 현재 host binding/endpoint/protocol을 검사하되, 가짜 `McpSession`, 실패하는 dummy client, 임의 discovery 결과를 생성하지 않는다. 서버 없는 경로에서는 client 생성·peer 시작·initialize/list/call이 모두 없어야 한다.

현재 `ReadCollectionBinding`에는 availability가 없고 `createReadCollectionTool`도 이를 전달하지 않는다. 저장 전용 source의 `fetch`만 throw하게 만들면 충분하지 않다. collection 실행기는 fetch 전에 새 request intent를 게시하고, fetch 예외를 `read_source_failed`로 처리한다([read-collections.ts](../../runtime/src/application/read-collections.ts) 228행 이후). 새 할당·전송은 기존 `ToolContracts.checkExecution`과 broker 경계에서 연결 필요로 막고, 저장된 page/deferral/response 증명 검사는 계속 허용하도록 연결해야 한다. 가용성은 정의·계약 지문 밖의 host 정보로 유지한다.

원응답 영수증이 없다는 `absent`는 성공·빈 페이지·수집 끝을 뜻하지 않는다. intent만 남거나 artifact만 있는 상태, 손상·잘못된 귀속은 기존 unknown/복구 거절 의미를 유지하고 같은 request를 몰래 재전송하지 않는다. 유효 raw receipt가 있으면 원 request와 intent head를 재검사한 뒤 기존 reconciliation을 사용한다. 저장 전용에서 최종 페이지까지 정산할 수 있다면 추가 송신 없이 완료 근거를 만들고, 다음 페이지가 필요하면 연결 대기로 남긴다.

대기 시각은 원 `recordedAt + retryAfterMs` 또는 원 항목의 retryAt을 사용한다. 재접속 시각으로 다시 미루지 않는다. 기한 전에는 successor·새 모델·MCP 호출을 만들지 않고, 기한 이후에도 저장 전용이면 연결 필요를 유지한다. 사용자가 온라인으로 명시 재개했을 때만 원 cursor/snapshot 또는 실패 retryIds로 필요한 다음 요청을 보낸다. 기한 대기와 연결 대기가 겹칠 때 표시 우선순위는 기존 제어 의미를 확인한 뒤 정하며, 자동 접속이나 백그라운드 polling으로 해결하지 않는다.

## 구현 전에 확인할 두 경계

**초기 문맥보다 늦은 collection 복구.** [WorkflowRuntime.run](../../runtime/src/application/workflow-runtime.ts) 98행의 선행 복구는 `settleStoredResult`이며, [ExecutionRuntime](../../runtime/src/application/execution-runtime.ts) 713행은 collection을 제외한다. collection reconciliation은 `recover`와 `step`에서 실행된다(674·743행). 따라서 일반 입구에서는 최초 compact/context 복원보다 뒤에 도달할 수 있다. 이미 있는 저수준 복구 시험을 통과했다는 사실만으로 용량 제한이 있는 일반 재개도 된다고 판단하지 않는다. 저장 응답을 먼저 정산해야 실제 첫 checkpoint가 가능해지는 fixture로 이 순서를 확인하고, 필요하면 기존 reconciliation만 앞당기는 좁은 경로를 둔다. 새 reserve/dispatch/model을 선행 복구에 섞지 않는다.

**collection의 전송 후 권한 상실은 아직 plain custody와 다르다.** [mcp-read-collections.ts](../../runtime/src/infrastructure/mcp-read-collections.ts) 185행의 call은 decoded capture를 전달하지 않고, 응답 뒤 authorize가 실패하면 raw/response 게시에 도달하지 않는다. 일반 예외를 sent로 취급하는 이전 failure 기록도 남아 있다. 그러므로 이번에 기존 page receipt를 서버 없이 복구하더라도, plain의 `authorizeResponseCustody`·known usage 회복까지 collection에 적용됐다고 주장할 수 없다. 우선 현재 권한에서 읽을 수 있는 저장 페이지의 복구를 연결하고, **페이지별 decoded 수신 보관·정산 권한 분리는 필수 후속**으로 남긴다. 이를 함께 구현하려면 request/intent head별 보관 권한과 회계 계약을 별도로 검토해야 하며, 구형 sent 값을 소급하여 확정 사용량으로 해석하지 않는다.

## 일반 입구 인수 범위

기존 [collection 시험](../../runtime/src/tests/mcp-read-collections.test.ts), [wait 중단 복구](../../runtime/src/tests/mcp-read-waits-recovery.test.ts), [원응답 정산 복구](../../runtime/src/tests/mcp-read-settlement-recovery.test.ts)의 fixture/계약/독립 기대값을 재사용한다. 마지막 시험은 가짜 무송신 call 포트와 과거 session으로 저장 복구를 조립한다. 이는 코어 증거이지 일반 프로필의 명시 stored-only 연결 증거가 아니므로, 새 인수는 실제 호스트 조립을 통과해야 한다.

| 사용자 흐름 | 반드시 확인할 차이 |
|---|---|
| 온라인 일반 요청→여러 page→근거 답변 | 실제 로컬 stdio와 구조화 모델 대역으로 원 item 값·순서·출처·source snapshot·exhausted/coverage를 대조한다. 모델이 말한 완료나 성공 항목 일부를 전체 수집 완료로 취급하지 않는다. |
| batch 부분 실패→재개 | 성공 항목과 원 artifacts는 그대로이고 실패 retryIds만 요청한다. 원 operation/root attempt, 남은 한도, successor와 usage가 이어지며 새 업무로 초기화하지 않는다. |
| 전체 deferral 또는 항목 대기→종료→다시 열기 | 원 retryAt 유지, 기한 전 새 할당·모델·call 0, 기한 뒤 명시 online 재개에서 필요한 요청만 1회 수행한다. 시스템 시간을 바꾸지 않고 기존 Clock 포트의 시험 제어를 사용한다. |
| 실제 raw receipt 게시 뒤 SIGKILL→저장 전용 재개 | 기존 request가 다시 전송되지 않고 같은 raw/intent 증명으로 한 번 정산된다. 최종 페이지면 기존 일반 답변 경로로, 비최종이면 다음 연결 대기로 이어진다. 새 프로세스에서 peer 시작·initialize/list/call 0을 직접 관측한다. |
| 저장 전용 대기→명시 online 열기 | 저장된 과거 session을 가짜 현재 세대로 꾸미지 않는다. 최초 필요한 다음 페이지/실패 항목만 전송하고 이미 정산한 request·usage·답변은 중복되지 않는다. |
| 실제 CLI와 localhost HTTP | CLI뿐 아니라 HTTP에서도 저장 응답 재개와 연결 대기 중 적어도 하나씩 실제 흐름을 통과한다. view/status는 읽기이며, page/cursor/projector/권한을 HTTP 임의 값으로 주입하지 않는다. |
| 계약·원자료·담당 경계 | endpoint/protocol/projector/manifest 변경, raw 변조, 현재 권한 축소와 다른 담당 자료는 복구로 덮지 않는다. 원자료·원 영수증을 보존하며 완료와 추가 호출을 차단한다. |

핵심 보관·재개 흐름은 실제 C01 SQLite/file-journal 두 backend에서 확인한다. 기존 저수준 오류 조합을 전부 복제하지 않고 새로운 host/profile/일반 입구 차이와 실제 중단 경계에 집중한다. close·discovery 실패는 기존 소유 수명/오류 보존을 재사용한다. 새 검증 선택과 실행은 구현 후 최종 source pin에서 조율하며, 이 메모 작성 중에는 수행하지 않았다.

이 단위의 종료는 일반 입구의 collection/page/wait 연결과 그 범위의 저장 복구까지다. 실제 사내 MCP·실제 모델의 자료 해석 품질·인증 배포·native Windows, 페이지별 전송 후 권한 상실의 보관/회계 후속이나 C05 전체 완료를 뜻하지 않는다.
