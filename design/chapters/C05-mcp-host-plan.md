# C05 다음 단위: 일반 입구에 MCP 읽기 연결

2026-09-07 · **최초 일반 입구 연결 구현과 macOS Node24 신규30/30·관련572/572·build/core/계층 검증을 완료했다. 같은 소스의 NAS Linux 신규30/30·관련572/572·전체3,368/3,368와 필수8단계·원로그 회수·정리를 완료했다.** [현재 결과](C05-mcp-host-result.md) · [사용법](C05-mcp-host-usage.md). 아래 조립 설계는 구현에 반영되었고, 끝의 raw 복구·권한 변경·offline·페이지/대기 범위는 필수 후속으로 유지한다. C05 전체와 전체 목표는 미완료이며 실제 모델/API 시험은 중단 상태다.

사용자는 같은 담당의 CLI 또는 Web에 요청하고, 담당에게 연결된 MCP 원자료로 답변을 받는다. 프로필을 다시 열면 원문·업무·근거를 이어 사용하며, 이미 받은 결과를 보여 주기 위해 `tools/call`을 반복하지 않는다. 첫 연결은 사내 서비스 대신 기존 로컬 MCP 시험 서버 프로세스로 검증한다. 모델도 명시적인 구조화 전송 대역이다.

## 권고: 도구 factory에 기존 보관 포트를 전달하고, 같은 계약 목록에 게시

[HostToolContext](../../runtime/src/presentation/host-tools.ts)는 담당 ID·root·scope만 가진다. [createMcpReadTool](../../runtime/src/infrastructure/mcp-read-tools.ts)의 15·44행과 [createMcpReadCollection](../../runtime/src/infrastructure/mcp-read-collections.ts)의 18·51행은 공통으로 `state`, `artifacts`, `digester`, `clock`을 요구한다. 여기서 보관 포트는 **업무 상태·영수증을 읽고 기록하는 인터페이스와 원응답 파일을 보관하는 인터페이스**다. MCP 전용 DB를 여는 방식으로 이 공백을 메우지 않는다.

`HostToolRegistration.open(context, assembly?)`에 호스트 전용 두 번째 인자를 추가한다. 기존 직접 helper 호출을 위해 선택 인자로 두되, provider source를 반환하는 새 경로는 실제 assembly가 필수다. 가짜 저장소 기본값은 만들지 않는다. 기존 context의 데이터 형식과 한 인자 factory는 유지한다. 모델 factory에는 기존 담당 ID·목적·스킬 모드만 전달한다.

```ts
// 구현된 공개 타입의 핵심 필드. 실제 선언은 host-tools.ts를 따른다.
interface HostToolAssembly {
  readonly custody: Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'clock'>;
  readonly schemas: SchemaCompiler;
  readonly signal: AbortSignal;
}
interface HostProviderTools {
  readonly provider: string;
  readonly source: ProviderToolSource;
  readonly limits?: Pick<ProviderRefreshOptions, 'maxPages' | 'maxTools' | 'maxBytes'>;
}
// 기존 OpenedHostTools의 tools/policy/limits/close를 유지하고 선택적으로 추가한다.
// providerSources?: readonly HostProviderTools[];
```

이 인자는 C01이 이미 연 **동일한 담당 저장소 객체**를 사용한다. DB 경로나 SQL 연결, 개인 기억·세션 서비스, planner를 추가로 넘기지 않는다. state 포트에는 기존 MCP의 `transact`에 필요한 쓰기 기능이 있으므로 이 연결 자체를 읽기 전용 저장소나 보안 샌드박스라고 부르지 않는다. 신뢰된 호스트의 조립 포트이고, 저장소 종료의 소유자는 계속 프로필이다. factory는 클라이언트만 종료한다. `signal`은 프로필 수명의 취소 신호를 공유한다.

현재 [openAgentTurnProfile](../../runtime/src/presentation/agent-turn-profile.ts)은 도구 factory를 연 뒤에 digester·schemas·clock을 조립한다. 이 순서만 앞당겨 MCP와 코어가 같은 인스턴스를 받게 한다. 별도 ID 체계·업무 장부·모델 조립기는 만들지 않는다.

## 실제 조립 순서와 수정 위치

1. **담당 보관 포트 연결.** `presentation/host-tools.ts`와 `agent-turn-profile.ts`에서 두 번째 인자와 선택적 provider source를 전달·고정한다. 함수가 담긴 포트를 `structuredClone`하지 않고, 소유한 참조와 필요한 메서드를 고정한다. 같은 프로필이 MCP에도 코어에도 같은 state/artifacts를 전달하는지 시험한다.
2. **MCP 전용 작은 호스트 helper.** 신규 `presentation/mcp-host-tools.ts`에서 신뢰된 실행 코드의 `McpStdioConfig`, `McpReadBinding[]`, 정책·한도를 받는다. `McpStdioClient`와 `createMcpProviderSource`를 만들고 `tools: []`, `providerSources`, `close`를 반환한다. 명령·인자·환경·projector는 사용자 원문·HTTP·설정의 임의 모듈 경로에서 가져오지 않는다. 환경과 실행 파일 경계는 기존 클라이언트 검사를 그대로 사용한다.
3. **기존 계약 목록에 한 번 게시.** `composeRuntime`이 반환한 `contracts`에 `refreshProviderTools`를 호출한 다음에만 프로필을 외부로 반환한다. `ToolCatalog`는 이 같은 contracts를 참조하므로 두 번째 카탈로그를 만들지 않는다. source 목록이 불완전하거나 실패하면 기존 게시를 보존하고, 초기 조립이라면 프로필을 반환하지 않고 소유 자원을 정리한다.
4. **일반 CLI/Web 인수.** 기존 `runAgentTurnCli(args, host)`와 `openAgentWeb(args, host)`에 helper가 만든 호스트를 주입한다. 별도 MCP 요청 API나 별도 대화창을 추가하지 않는다. 일반 요청→계획 검사→도구→근거 답변을 현재 세션·outbox로 끝낸다.

provider 갱신은 전체 provider 목록을 교체한다. 따라서 한 provider를 고정 `tools`와 `providerSources`에 나눠 소유하거나, 둘 이상의 source가 같은 provider를 소유하는 등록은 거절한다. 초기에는 담당을 열 때 등록된 source를 한 번 갱신한다. 실행 중 자동 polling·재연결·등록 변경 UI는 넣지 않는다. 재접속은 새 프로필 수명에서 다시 발견하고 게시하는 과정이다.

**source 경로도 호스트 읽기 제한을 거쳐야 한다.** [refreshProviderTools](../../runtime/src/application/provider-tool-snapshot.ts)는 provider 이름·스키마·페이지·개수·바이트·epoch를 검사하지만 호스트 정책의 읽기 전용 제한까지 대신하지 않는다. source의 각 page에 기존 host tool 검사를 적용해 `write`, `core.*`, core provider, 잘못된 콜백을 거절한 뒤 기존 refresh에 넘긴다. 정책에 도구 ID나 core 권한을 자동 추가하지 않고 `skills.off`의 최종 차단도 유지한다. 기존 검사 로직을 작은 함수로 재사용하며 새 스키마 계층은 만들지 않는다.

## 원응답·재접속·복구의 정확한 범위

| 기존 경계 | 그대로 재사용할 동작 | 이번 단위에서 주의할 점 |
|---|---|---|
| [MCP 읽기 어댑터](../../runtime/src/infrastructure/mcp-read-tools.ts) 121–166행 | `mcp-intent`→MCP 호출→원응답 artifact→`mcp-response` 영수증→검증 가능한 ToolResult | 보관하는 것은 SDK가 해석한 MCP 응답이며 wire 원본 바이트가 아니다. `content`, `structuredContent`, 원출처·계보·입력/정책/목표 지문을 대조한다. projector와 원문을 분리한다. |
| 같은 파일 94–118행 | 원응답·dispatch·intent·response·계약을 다시 읽어 결과 증명 | 서버 세대가 바뀌었다는 이유만으로 과거 원응답을 새 원자료로 만들지 않는다. endpoint/protocol/remote 계약/projector 버전이 바뀌면 기존 계약 지문으로 과거 결과를 검증할 수 없을 수 있다. 이때 재조회로 몰래 덮지 않는다. |
| [McpStdioClient](../../runtime/src/infrastructure/mcp-stdio-client.ts) 124–150·205–234행 | 발견 시 명시한 원격 계약 대조, 실제 stdin 전송 직전 authorize, bounded call, 소유 프로세스 close | discovered 목록에 다른 도구가 있어도 호스트 binding에 없는 도구는 연결하지 않는다. 재접속의 initialize/tools-list와 실제 tools-call 수를 따로 센다. |
| [Provider 갱신](../../runtime/src/application/provider-tool-snapshot.ts) 47–76행 | 완전한 목록만 기존 epoch에 CAS 게시 | 실패·혼합 revision·중복·상한 초과는 부분 목록으로 기존 도구를 지우지 않는다. 원격 서버 전체가 원자적 snapshot이라는 보장은 아니다. |
| [호스트 수명](../../runtime/src/presentation/agent-turn-profile.ts) | 종료 신호→모델→도구→기존 stores 정리 | 조립 실패·MCP close 실패도 기존 복수 오류 보존을 사용한다. 별도 DB close나 모든 late response의 완전 drain을 추가한 것으로 표현하지 않는다. |

첫 재접속 인수에서는 서버를 새로 열고 발견할 수 있어야 한다. 완료 결과의 재표시에서 `tools/call=0`을 검증하되, 이 단계의 `initialize/tools/list=0`이나 서버 없이 모든 CLI/Web 이력 열기를 보장하지 않는다. [기존 offline 증명 시험](../../runtime/src/tests/mcp-read-tools.test.ts)은 저장된 envelope의 session으로 어댑터를 복원한다. 이것을 일반 프로필의 offline 열기까지 연결하는 작업은 후속이며, 새 seed DB를 만들지 않고 같은 원응답/계약을 사용해야 한다.

또한 단순 읽기의 `mcp-response`만 게시되고 실행기의 `result_received`가 아직 없는 구간은 페이지의 stored-response 복구와 같지 않다. 현재 단순 읽기는 intent가 있는 같은 attempt의 재호출을 거절한다. 이번 단위의 중단 인수는 **실행기 결과가 received인 경계**와 완료 후 재접속으로 잡고, intent만 있거나 raw 영수증만 있는 중단을 자동 복구한다고 주장하지 않는다.

현재 MCP 어댑터는 wire 응답 뒤에도 authorize를 검사하므로 권한이 사라지면 원응답 게시 전에 거절할 수 있다. 호스트 도구 단위의 유효 ToolResult 사용량 보존은 그 전에 어댑터가 throw한 경우까지 포괄하지 않는다. 이 경우 wire 호출 관측과 업무에 확정된 사용량을 구분하며, 전체 원응답·비용을 무조건 복구하는 규칙으로 넓히지 않는다.

## 페이지·대기가 나중에도 같은 연결부를 쓰는 방법

보관 포트 네 개는 단순 읽기와 collection이 이미 공유하므로 이번 인자를 그대로 사용할 수 있다. 다만 `createMcpReadCollection`의 반환값은 `Tool`이 아니라 **ReadCollectionBinding**이다. 이를 임의 캐스팅해 `tools`에 넣거나 MCP helper 안에서 두 번째 `ReadCollections`를 만들지 않는다.

후속 collection 연결에서는 `OpenedHostTools`의 선택적 `collectionTools: ReadCollectionBinding[]`를 기존 [composeRuntime.collectionTools](../../runtime/src/application/compose-runtime.ts) 60·95·143행에 전달하면 된다. 코어가 자신의 `ReadCollections`를 가리키는 `createReadCollectionTool`을 이미 조립한다. 페이지 한도·manifest·checkpoint·실패 항목 재시도·dueAt 대기는 기존 [read-collections](../../runtime/src/application/read-collections.ts), [read-waits](../../runtime/src/application/read-waits.ts), [read-reconciliation](../../runtime/src/application/read-reconciliation.ts)을 재사용한다. 첫 단순 읽기 구현에서 사용하지 않는 collection 필드를 먼저 추가할 필요는 없다.

collection을 provider 갱신과 함께 넣을 때는 동일 provider의 단순 도구와 collection을 한 목록으로 소유해 부분 교체로 collection을 퇴출시키지 않아야 한다. 기존 `createMcpProviderSource`는 단순 binding 전용이므로 collection을 그 인수에 섞지 않는다. [페이지 시험](../../runtime/src/tests/mcp-read-collections.test.ts)의 `createReadCollectionTool(binding, () => composed.readCollections)` 게시 예시를 그때 재사용한다.

[대기 복구](../../runtime/src/tests/mcp-read-waits-recovery.test.ts)와 [실제 중단 후 정산 복구](../../runtime/src/tests/mcp-read-settlement-recovery.test.ts)는 저장된 raw receipt에서 peer 재호출 없이 복구하고, 필요한 다음 요청만 명시적으로 보낸다. 후속 일반입구 시험도 이 의미를 유지한다. 같은 포트를 제공할 수 있다는 설계 검토와 그 사용자 흐름의 구현 완료를 구분한다.

## 작은 인수 묶음과 종료 기준

| 인수 | 독립 기대값 |
|---|---|
| 실제 stdio→일반 CLI, SQLite/file-journal | [기존 시험 서버](../../runtime/src/tests/helpers/mcp-fixture-server.ts)와 [고정 계약](../../runtime/src/tests/helpers/mcp-fixture-contracts.ts)을 사용한다. 모델 대역은 전달된 실제 도구 ID/해시 포함 버전을 선택한다. wire audit 1회, 원응답의 고정 값, 투영된 근거, 최종 답변이 일치한다. fixture.read 대체나 모델 문장을 근거로 등록하지 않는다. |
| 실제 localhost HTTP | 요청 본문에는 원문·mode·request ID만 보낸다. 서버에만 등록표를 주입한다. 접수·실행·결과를 현재 세션에 기록하고 HTTP의 command/env/projector/권한 주입은 거절한다. |
| 결과 received/완료 뒤 재접속 | 같은 담당 ID·세션·원문·영수증·원응답을 보존한다. 새 source를 열어도 과거 tools-call 수가 늘지 않고 중복 답변·정산이 생기지 않는다. 새 서버 발견 횟수는 별도 관측한다. |
| 두 담당의 보관 분리 | 같은 도구 ID·원격 이름을 쓰되 서로 다른 시험 서버 자료를 준다. factory의 custody는 각 C01 stores와 동일하고, 다른 담당의 work/원응답이 검증·대화에 섞이지 않는다. |
| 계약·원자료 실패 | 원격 manifest/projector 버전 변경, 저장된 raw 변조, 도구 오류/부분 응답에서 완료 근거를 만들지 않는다. 실패한 목록 갱신이 기존 목록을 삭제하지 않고, 금지된 계약은 wire 호출 전에 거절한다. |
| 수명·종료 | 정상 종료와 discovery/조립 실패에 소유 peer의 PID 종료·임시 폴더 정리를 관측한다. 한 담당 close가 다른 담당 peer를 닫지 않는다. 최초 오류와 독립 cleanup 오류를 보존한다. |

기존 MCP·provider 목록·원응답 검증 시험을 다시 구현하지 않고 새 조립 차이만 시험한다. 제품 변경 후 새 인수, 영향받은 기존 MCP/read/provider/host 회귀, repository build·core·계층 검사를 해당 최종 pin으로 수행한다. 새로운 실행 증거는 현재 호스트 연결 증거와 분리한다. 실제 사내 MCP·인증·모델 API·Knox, 네이티브 Windows, 범용 offline 등록·페이지/대기 UI까지 이 단위 성공으로 완료 처리하지 않는다.

이 연결이 끝나면 사용자는 코어를 재조립하지 않고 호스트 helper를 기존 일반 입구에 꽂아 MCP 읽기를 사용할 수 있다. 설치 관리자·새 도구 언어·백그라운드 감시기·별도 승인 단계를 만드는 방향으로 범위를 넓히지 않는다.

## C05 MCP 후속 필수 순서

위 인수의 종료는 **최초 일반 입구 연결 완료**만 뜻한다. `result_received` 이후와 완료 후 재접속만 검증하고 C05 MCP 전체를 완료로 닫지 않는다. 다음 항목은 선택적 개선이 아니라 전체 목표에 남겨 둔 필수 후속 단위다.

1. **단순 읽기의 raw 수신 뒤 중단 복구.** 원응답 artifact 또는 `mcp-response`를 남긴 뒤 실행기의 `result_received` 전에 실제 프로세스를 중단하는 경계를 연결한다. 같은 담당의 dispatch·intent·응답·계약을 다시 검증하여, 증명이 충분한 저장 응답을 기존 실행 영수증으로 복구한다. 서버 재호출·원문 중복·사용량 이중 정산이 없어야 한다. artifact만 있고 귀속 증명이 부족하거나 intent만 남은 경우는 확정된 수신과 구분하여 명시적으로 대기·실패를 반환한다. 별도 복구 장부로 빈틈을 가리지 않는다.
2. **전송 뒤 권한 변경 시 수신과 채택 분리.** 허용된 실제 전송 이후 권한이 줄거나 취소된 경우에도, 도착한 응답을 원 호출에 귀속시켜 보호된 저장소에 보존하는 경계와 현재 권한으로 본문·근거를 채택하는 경계를 분리한다. 원 호출 계약에서 유효하고 귀속이 확인된 known usage만 기존 장부에 한 번 정산하며, 사용량 누락·잘못된 귀속을 0이나 확정 비용으로 꾸미지 않는다. 현재 권한에서 채택은 차단하고, 이후 적법한 재개에서는 기존 목표·출처·정책 재검증 및 확정된 실패 상태를 따른다. 늦은 응답·중복 수신·정산 직전 중단을 로컬 peer로 검증한다.
3. **서버 없는 offline 재개.** 앞선 저장 응답 복구를 일반 프로필 열기·CLI/Web에 연결한다. 저장된 계약·원응답과 현재 호스트 권한을 검증하여 기존 이력·완료 결과 조회 및 복구 가능한 received 결과의 처리를 서버 발견 없이 수행한다. 이 인수에서는 peer process 시작과 initialize/tools-list/tools-call 모두 0이어야 한다. 새 원자료가 필요하거나 보관된 계약·증명이 부족하면 연결 필요·복구 불가를 명시한다. 낡은 도구 목록을 현재 사용 권한으로 간주하지 않는다.
4. **페이지·대기·복구의 일반 입구 인수.** 위 연결부에서 기존 collection·wait·reconciliation을 재사용하여 중단된 페이지와 저장된 응답을 이어 처리한다. 이미 받은 페이지의 재전송·이중 정산 없이 필요한 다음 요청만 실행하는지 확인한다. 앞 절의 재사용 가능성 검토만으로 이 흐름을 통과 처리하지 않는다.

각 후속 단위는 해당 변경과 실제 중단·권한 경합·재개 증거로 따로 종료한다. 앞 단위의 합성 성공이나 기존 어댑터 단위 시험을 다음 사용자 흐름의 검증으로 대신하지 않는다. 이 순서는 구현 계획이며 현재 해당 복구 경계가 구현·검증됐다는 뜻이 아니다.


## 2026-09-08 — collection 일반 입구 확정 결과

[최종 결과](C05-mcp-collections-entry-result.md)와 [확정 증거](../../runtime/evidence/C05-mcp-collections-linux-nas-20260908/verification.json)에 로컬 183/519 및 Linux 183/519/3691 통과를 기록했다. 문맥 선택 수렴과 원근거 최초 조회 준비 진전은 이번 기능 교정이다. 실제 I/O·토큰·지연 절감률은 측정하지 않았다. 다음 [페이지별 응답 보관·정산](C05-mcp-collections-custody-plan.md)은 A staging만 작성 중이며 별도 미검증이다. 아래·앞선 진행 수치와 미결정 내용은 당시 기록으로 유지한다.
