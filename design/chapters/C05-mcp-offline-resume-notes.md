# C05 MCP 서버 없는 재개: 다음 구현 메모

2026-09-07 · **설계 메모이며 제품 미착수다.** 작성 시 전송 후 보관·정산 단위의 로컬 신규 120개 중 113개 통과·7개 실패를 확인했고 해당 교정과 일반 workflow 연결이 진행 중이다. 그 묶음의 실제 중단 6개와 프로필 종료 4개는 통과했지만 최종 통합·Linux 결과를 선반영하지 않는다. 아래 작업은 선행 단위의 최종 검증 이후 착수한다. [최초 MCP 계획](C05-mcp-host-plan.md) · [현재 사용법](C05-mcp-host-usage.md) · [전송 후 권한 변경 계획](C05-mcp-sent-authority-plan.md).

목표는 **MCP 서버가 없어도 같은 담당의 CLI·Web에서 보관된 이력과 결과를 읽고, 증명 가능한 원 호출의 사용량·받은 결과를 이어 처리하는 것**이다. 서버리스 배포나 모든 모델·네트워크를 끈 실행을 뜻하지 않는다. 모델 등록은 별도이며 인수에는 기존 로컬 결정적 모델을 사용한다.

## 확인된 공백과 이미 있는 경계

| 현재 코드 | 확인한 동작과 재사용 범위 |
|---|---|
| [`openAgentTurnProfile`](../../runtime/src/presentation/agent-turn-profile.ts) | C01 stores와 실제 보관 포트를 조립한 뒤, 모든 `openedTools.providerSources`에 `refreshProviderTools`를 실행하고 나서 프로필을 반환한다. 따라서 상태 조회만 하더라도 이 초기화에 성공해야 한다. |
| [`createMcpHostTools`](../../runtime/src/presentation/mcp-host-tools.ts) → [`createMcpProviderSource.list`](../../runtime/src/infrastructure/mcp-read-tools.ts) | 클라이언트 생성 자체는 프로세스를 시작하지 않는다. source의 `list`가 `client.discover`를 호출할 때 서버 시작·발견이 필요해진다. 서버가 없으면 프로필 초기화가 실패한다. |
| [`refreshProviderTools`](../../runtime/src/application/provider-tool-snapshot.ts), [`ToolContracts`](../../runtime/src/application/tool-contracts.ts) | 목록을 유한하게 모아 provider 하나를 epoch CAS로 게시한다. 계약과 콜백의 소유자는 이 한 등록 목록이다. 별도 오프라인 카탈로그나 저장소가 필요한 상황은 아니다. |
| [`createMcpReadTool`](../../runtime/src/infrastructure/mcp-read-tools.ts)의 `original`, `restoreUsage`, `restoreResult`, `validateResult` | 공식 dispatch/intent/response와 정확한 artifact 참조·바이트·SHA·binding 지문을 재검증한다. 과거 envelope의 실제 session을 사용하며, 현재 reader의 연결 generation/discoveryDigest가 과거와 같을 필요는 없다. endpoint와 protocol 및 계약은 일치해야 한다. |
| [`StoredToolUsages`](../../runtime/src/application/stored-tool-usage.ts), [`ExecutionRuntime.recordStoredUsage`](../../runtime/src/application/execution-runtime.ts) | 원 호출 귀속과 삭제 세대가 유효할 때 known usage만 기존 attempt/영수증에 보완한다. 취소·축소 권한을 새 실행 권한으로 바꾸거나 본문을 반환하지 않는다. `reconcileStoredUsages`와 [`WorkflowRuntime`](../../runtime/src/application/workflow-runtime.ts)의 일반 진입 연결은 선행 단위에서 검증 중이므로 다시 만들지 않는다. |
| [`StoredToolResults`](../../runtime/src/application/stored-tool-results.ts), execution의 receive/adopt | 본문 복구에는 현재 실행 권한·도구 계약·목표·계획·세션/기억 출처와 기존 수신 조건이 필요하다. `restoreUsage` 성공만으로 본문을 받을 수 없다. 이미 처리된 결과, 취소·명시 실패·새 시도를 되살리지 않는다. |
| [`ContextRecovery`](../../runtime/src/application/context-recovery.ts), [`runAgentTurnCli`](../../runtime/src/presentation/agent-turn-cli.ts), [`LocalWorkbench`](../../runtime/src/presentation/local-workbench.ts) | 원문 보관용 참조와 현재 공개할 문맥을 구분하는 선행 교정을 재사용한다. CLI의 세션/채널 귀속 검사와 Web의 actor·origin/CSRF·명령 영수증 검사를 우회하는 복구 API를 만들지 않는다. |

[`mcp-custody-crash-worker`](../../runtime/src/tests/mcp-custody-crash-worker.ts)는 실제 stdio 응답 뒤 종료한 담당을 새 프로세스의 reader로 열어 사용량만 회복한다. 이 증거는 **일반 CLI/Web가 서버 없이 열림을 아직 증명하지 않는다.** 기존 [`mcp-stored-result-recovery`](../../runtime/src/tests/mcp-stored-result-recovery.test.ts)의 일반 프로필 재접속은 다시 서버를 발견한다.

## 가장 작은 완결 단위 권고

**신뢰된 시작 프로그램이 선택하는 MCP `stored_only` 모드를 추가한다.** 명칭은 구현 전 확정하되 기본 온라인 동작은 유지한다. `createMcpHostTools`의 고정 등록 옵션에서 선택하고 같은 `runAgentTurnCli(args, host)`·`openAgentWeb(args, host)`에 주입한다. 첫 단위에는 임의 사용자 원문·HTTP가 endpoint, 실행 파일, projector, 과거 계약을 등록하는 기능과 자동 연결 실패 fallback을 넣지 않는다.

1. **서버 연결 없이 현재 호스트의 저장 증명 reader를 조립한다.** `mcp-read-tools.ts`의 기존 검증/투영 함수를 재사용하는 작은 reader factory를 둔다. 입력은 현재 호스트가 고정한 binding과 endpoint/protocol 및 기존 assembly다. 가짜 발견 성공이나 임의 generation/discoveryDigest로 새로운 실제 session을 만들지 않는다. 과거의 실제 session은 원 영수증과 envelope에서 검증한다. 지원 protocol은 기존 클라이언트와 한 정의를 공유한다.
2. **같은 provider source가 완전한 로컬 등록 목록을 게시한다.** stored-only 분기는 `McpStdioClient`를 시작·발견하지 않고 현재 등록 binding의 reader들을 반환한다. source revision은 이 로컬 등록 목록의 지문이며 원격 최신 목록 관측으로 설명하지 않는다. 기존 host page 검사·refresh 상한·provider 중복·epoch CAS·ToolContracts를 그대로 통과시킨다. DB, artifact, 카탈로그, 모델 조립기를 추가하지 않는다.
3. **저장 증명과 새 호출 가능 상태를 분리한다.** reader를 목록에 넣는 것만으로는 부족하다. 현재 `ToolContracts.check`는 저장 결과의 권한 검증과 reserve/dispatch가 함께 사용하고, `visible`은 모델 후보에도 쓰인다. 따라서 현재 정책을 비우거나 definition을 바꾸는 방식은 정상 저장 결과까지 무효화한다. 권고는 definition 밖에 호스트가 고정하는 작은 실행 가능 상태를 두고, `snapshotTool`에서 검증·캡처하는 것이다. 기존 계약 조회/증명은 유지하고, **새 예약 전·dispatch 전·Broker 진입**에서 stored-only의 새 호출을 거절한다. 모델의 새 도구 선택·catalog search에도 이를 반영하되, 기존 결과를 검증하는 exact id/version 조회를 없애지 않는다. 단순히 `execute`에서 throw하는 것만으로 끝내지 않는다. 그 경우 이미 attempt/논리 호출 예산을 소비할 수 있다.
4. **일반 재개가 기존 수신·정산까지 끝나게 연결한다.** CLI/Web의 상태·이력 조회는 기존 보호 투영을 사용한다. 명시 run은 선행 workflow의 usage 회복과 이미 받은 결과 처리를 사용한다. 증명이 충분하고 현재 권한도 유효한 원 응답은 기존 receive/adopt로 진행한다. 새 원자료가 필요한 지점은 `connection_required`에 해당하는 명시 상태로 멈추며 새 attempt·호출 예산·peer를 만들지 않는다. 온라인으로 다시 여는 것은 별도 명시 선택이고, 실패한 과거 결과를 새 요청으로 몰래 바꾸지 않는다.

실행 가능 상태의 정확한 타입·오류 이름은 **미확정 제안**이다. 저장 형식·ToolDefinition 지문에 추가할 필요는 없으며, 기존 호스트 콜백의 고정 관례를 따른다. 온라인 도구는 필드가 없으면 기존 동작을 유지한다. 이 상태는 허용 정책보다 권한을 넓히지 못한다. 저장된 call input의 도구 목록도 새 전송 직전에 현재 실행 가능 상태를 다시 검사해야 한다.

## 오프라인에서 허용할 것과 금지할 것

| 상황 | 처리 |
|---|---|
| 공식 response + 원 dispatch/intent + 현재 같은 binding | 삭제 세대·owner·원 attempt·원 바이트가 유효하면 usage 정산 후보. 이미 정산한 값은 반복 합산하지 않는다. |
| 취소/라벨 축소 뒤 보호된 raw | 사용량만 보완할 수 있다. 원 정책은 호스트 내부 귀속 증명에만 사용하며 CLI/Web 본문·근거·모델 문맥에는 현재 권한을 적용한다. 차단 사유와 stop 상태를 보존한다. |
| 정상 received 또는 복구 가능한 response, 현재 권한/목표/출처 유효 | 기존 본문 복구·채택·outbox 현재성 검사를 전부 통과한 경우만 이어 처리한다. 저장소 열기 성공이 결과 현재성의 증명은 아니다. |
| raw 파일만 있거나 intent만 존재 | 공식 수신 영수증 없음. 디렉터리 탐색·파일 추측·강제 영수증 생성·사용량 0 확정 없이 기존 unavailable 의미를 유지한다. |
| 새 도구 실행 또는 새로 읽은 자료가 필요한 요청 | 저장된 계약을 원격 실행 허가로 쓰지 않는다. 연결 필요로 정지하며 MCP 시작/발견/호출 0, 새 attempt/예약·정산 증가 0을 확인한다. |
| 손상·외부 소유·삭제 세대 변경·계약 불일치 | 단순 연결 필요와 구별해 거절한다. 재발견·새 조회로 검증 실패를 덮지 않는다. |

## 목록과 버전에서 놓치면 안 되는 점

- **binding 지문:** 현 `createMcpReadTool`은 remote 이름/입출력 schema, projector ID/버전, endpointId, protocolVersion을 bindingDigest에 넣고 도구 버전에 suffix를 붙인다. base version이 같아도 이 중 하나가 바뀌면 과거 attempt의 exact version 조회가 실패해야 한다.
- **전체 definition 지문:** description·labels·destination 등은 suffix에 모두 들어가지 않더라도 `contractDigest`로 확인한다. 같은 id/version 문자열이라는 이유로 과거 결과를 새 정의에 붙이지 않는다.
- **삭제된 binding:** 현재 호스트가 등록하지 않은 과거 도구를 저장 원문·모델 packet에서 자동 복원하지 않는다. 최초 단위는 같은 현재 binding을 요구하며 과거 버전 reader 자동 보존은 제외한다. 필요한 과거 계약 등록은 별도 명시 설계다.
- **새 서버 세대와 원격 최신성:** generation/discoveryDigest는 원 호출 영수증과 envelope 사이에서 검증한다. 재접속마다 provider epoch/source revision이 달라지는 사실을 과거 자료 위조로 취급하지 않는다. 반대로 로컬 등록 목록을 만들었다고 원격 서버가 여전히 같은 도구/자료를 제공한다고 주장하지 않는다.
- **온라인 재전환:** 실제 발견 실패·remote schema 변경·mixed revision은 기존 실패 의미를 유지한다. 실패한 발견을 offline 성공으로 바꾸지 않는다. 같은 provider의 static tools와 source를 중복 등록하거나 provider 일부만 갱신하지 않는다.
- **같은 버전으로 projector 구현 교체:** 함수 코드는 현재 지문에 포함되지 않는다. 신뢰된 호스트가 의미 변경 때 projectorVersion을 올릴 책임은 기존과 동일하며 이 단위가 임의 호스트 코드 변조를 검출한다고 주장하지 않는다.

## 예상 수정 파일과 필요한 인수

제품의 중심은 `presentation/mcp-host-tools.ts`, `infrastructure/mcp-read-tools.ts`의 작은 reader 조립부다. protocol 공유가 필요하면 `mcp-stdio-client.ts`의 기존 상수를 한 곳에서 export한다. 실행 가능 상태는 `application/ports.ts`·`tool-contracts.ts`의 호스트 메타데이터와 `execution-runtime.ts`·`tool-broker.ts`의 새 호출 gate에 한정한다. 모델 후보를 만드는 `context-compiler.ts`/`context-packet.ts`와 `tool-catalog.ts`, 저장된 모델 요청을 보내는 planning 경계의 필요한 선택 지점만 검토한다. `agent-turn-profile.ts`는 기존 source 게시·수명 재사용이 우선이며 새로운 저장소나 compose 분기는 만들지 않는다. CLI/Web는 현재 입구를 유지하고 연결 필요 상태의 짧은 설명만 추가한다.

| 인수 묶음 | 새 차이만 검증 |
|---|---|
| SQLite/file-journal, 실제 CLI 재접속 | 온라인 로컬 peer에서 원문/영수증 생성 후 종료. 서버 실행 경로를 사용할 수 없는 환경에서 stored-only host로 상태/이력/명시 run. peer 시작·initialize·tools/list·tools/call 모두 0, 원 agent/session/receipt/raw/usage·답변 중복 없음. |
| 실제 localhost HTTP 재접속 | 같은 저장 상태로 Web 열기·snapshot·이력·명시 run, 현재 권한에서 허용된 결과만 반환. foreign actor/session/work와 origin/CSRF 기존 거절 유지. 브라우저 렌더링 통과와 구별한다. |
| 저장 단계와 제어 상태 | response만 있음, 이미 received/정산/완료, cancel+narrowed 상태를 나눠 usage-only와 본문 처리 차이를 확인한다. 현재 단위의 실제 SIGKILL fixture를 재사용하고 전체 crash suite를 복제하지 않는다. |
| 공식 영수증 없는 raw, 새 읽기 필요 | 전자는 복구 불가, 후자는 연결 필요. orphan 탐색·새 attempt·새 논리 예산·모델이 제안한 도구의 실제 전송 0. 이미 예약된 과거 tool/model 입력도 현재 gate를 우회하지 못한다. |
| 계약·소유·삭제 | binding 제거, projector/remote schema/endpoint/protocol 변경, 같은 버전의 definition 변경, 다른 담당·원문 변조·삭제 세대 변경 거절. 원 usage와 과거 실패 상태를 새 결과로 바꾸지 않는다. |
| 기본 온라인 회귀와 수명 | 기존 온라인 discovery/실행/페이지 상한·완전 목록 게시 유지. offline close는 peer를 정리했다고 꾸미지 않고 실제 0개이며 C01 stores와 모델의 기존 close 책임은 그대로다. |

위 일반 입구 인수를 같은 최종 소스로 로컬과 Linux에서 마친 뒤에만 **MCP 서버 없는 단순 저장 응답 재개 연결**을 완료로 기록한다. collection/페이지·대기 일반 입구, 임의 과거 계약 자동 관리, 실제 사내 MCP/모델/API, Windows native, 설치·배포 전체와 C05 전체 완료는 이 게이트에 포함하지 않는다.
