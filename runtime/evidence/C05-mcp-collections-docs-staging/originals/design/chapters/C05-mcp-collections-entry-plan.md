# C05 MCP collection·page·wait 일반 입구 구현 계획

2026-09-07 · **구현 전 계획. C05 완료나 새 검증 결과가 아니다.** [선행 읽기 메모](C05-mcp-collections-entry-notes.md)를 현재 ports·collection 실행기·host/profile 호출부에 맞춰 좁혔다. 제품·시험·HTML은 변경하지 않았고 빌드·시험·SSH를 실행하지 않았다. 선행 offline NAS `98882`의 전체 시험은 부모 작업이 관측 중이며, 그 결과를 이 계획의 통과 근거로 사용하지 않는다.

사용자 인수는 같은 담당의 일반 CLI/Web에서 여러 페이지를 읽고, 받은 항목과 원응답을 보존하면서 대기·중단·재접속을 이어 가는 것이다. 온라인 호출과 저장 자료의 처리를 분리하되 기존 세션·업무·collection 장부를 그대로 쓴다. 새로운 core 도구 언어, 두 번째 DB, 별도 scheduler는 만들지 않는다.

## 이번 계획에서 선택하는 조립

**collection이 포함된 endpoint는 프로필을 여는 동안 한 번 발견하고, plain 도구와 collection binding을 함께 기존 compose에 넣는다.** 기존 plain 전용 helper는 그대로 둔다. 실행 중 provider 자동 갱신은 이 단위에 넣지 않는다.

[HostToolAssembly](../../runtime/src/presentation/host-tools.ts) 12행은 같은 C01 state/artifacts/digester/clock·schema·수명 signal을 이미 제공한다. [composeRuntime](../../runtime/src/application/compose-runtime.ts) 60·95·143행은 `collectionTools`를 자신의 `ReadCollections`에 연결한다. 따라서 factory에 실행기·contracts·모델을 추가로 주입할 필요가 없다. `ReadCollectionBinding`을 `Tool`로 캐스팅하거나 가짜 runner로 검사하지 않는다.

다음은 **제안하는 공개 타입 변경**이며 아직 소스에 없다. 기존 호출을 유지할 수 있는 선택 필드만 추가한다.

```ts
// application/ports.ts: 기존 두 필드는 유지
interface ReadCollectionBinding {
  definition: ToolDefinition;
  source: ReadCollectionSource;
  readonly availability?: ToolAvailability; // 생략 시 기존 실행 가능 의미
}

// presentation/host-tools.ts: tools/policy/limits/providerSources/close 유지
interface OpenedHostTools {
  // ...기존 필드
  readonly collectionTools?: readonly ReadCollectionBinding[];
}

// presentation/mcp-host-tools.ts: 기존 bindings와 mode union 유지
interface McpHostToolsCommonOptions {
  readonly bindings: readonly McpReadBinding[];
  readonly collectionBindings?: readonly McpReadCollectionBinding[];
  readonly policy: Policy;
  readonly limits: Limits;
}
```

collection 전용 등록은 `bindings: []`와 비어 있지 않은 `collectionBindings`를 사용한다. 두 배열이 모두 비었으면 기존과 같이 거절한다. collection 배열이 없거나 비어 있으면 기존 plain 경로를 그대로 탄다. `bindings`를 union으로 바꾸거나 기존 이름·필수 인자를 바꾸지 않는다. `mode: 'stored_only'`에는 기존 `origin`을 사용하고 `config`를 허용하지 않으며, mode 생략은 기존 online 의미다.

### 등록 시 고정과 검증

[createReadCollectionTool](../../runtime/src/application/read-collections.ts) 27행의 definition/schema·필수 callback 검사와 함수 캡처를 작은 `snapshotReadCollectionBinding(binding)` 함수로 추출하는 안을 권고한다. 원 함수와 host의 collection 경로가 이를 함께 호출한다. 원 source의 `this` 의미, optional 필드 생략, 함수 참조 고정과 frozen 반환은 보존한다. availability도 한 번 읽어 유효한 값만 고정한다. 새 저장 스키마를 만들거나 검사만을 위해 실제 `ReadCollections`를 생성하지 않는다.

`openRegisteredHostTools`는 collection 배열이 제공되면 실제 assembly를 요구한다. 고정된 binding에 기존 host의 read-only·금지 core·중복 `(id, version)` 검사를 적용한다. 최종 input/output schema compile은 기존 `ToolContracts`가 한다. plain 도구와 collection의 ID 충돌을 함께 검사하고, 두 종류를 합친 provider 집합과 `providerSources` 사이의 중복 소유도 거절한다. 도구를 policy에 자동 추가하지 않고 `skills.off` 필터와 host 권한 축소를 유지한다.

MCP helper는 definition/remote/projector/manifest/deferral 함수와 deferral 설정을 등록 시 고정한다. 한 endpoint·한 provider, 합산 binding 수 1~1,000, 중복 원격 이름 거절을 유지한다. collection을 추가하면서 발견·definition 크기 한도가 빠지지 않아야 한다. 기존 plain provider 경로의 로컬 게시 기본 한도는 1,000개·4MiB이고 원격 발견은 별도로 client의 list/message 한도를 적용한다([provider-tool-snapshot.ts](../../runtime/src/application/provider-tool-snapshot.ts) 47행). 새 혼합 경로도 최소 이 한도를 유지하고, 한도를 넘는 경우 compile/프로필 반환 전에 거절한다. 구체적인 공통 상수 추출 여부는 구현 시 최소 diff로 선택한다.

### 같은 endpoint의 plain+collection을 함께 등록하는 순서

1. helper 등록 시 전체 trusted binding을 고정·검사한다. 이때 peer를 시작하지 않는다.
2. online `open`은 client 하나를 소유하고, 두 종류의 remote 계약을 합쳐 `discover(expected, lifetimeSignal)`을 **한 번** 호출한다. discover 내부의 여러 tools/list 페이지는 기존 bounded 검증을 따른다. 도구별 discover는 세대를 바꾸므로 하지 않는다.
3. 같은 반환 session으로 `createMcpReadTool`과 `createMcpReadCollection`을 모두 만든다. 하나라도 실패하면 소유 client를 닫고 원 오류와 cleanup 오류를 보존한다.
4. `{tools: plainTools, collectionTools, policy, limits, close}`를 반환한다. 이 provider의 `providerSources`는 반환하지 않는다. 기존 plain-only online 경로는 계속 `{tools: [], providerSources, close}`를 사용한다.
5. `agent-turn-profile.ts`의 기존 compose 호출에 `collectionTools: [...openedTools.collectionTools]`를 선택적으로 추가한다. 같은 `ToolContracts` 초기 생성에서 전체 목록을 compile한 뒤에만 프로필을 외부로 반환한다. 다른 provider source가 있다면 기존처럼 이후 갱신하되 위 중복 소유 검사를 통과해야 한다.

여기서 원자적 등록은 **새 프로필이 일부 도구만 가진 채 외부에 반환되지 않는 것**이다. 원격 서버의 tools/list 전체가 외부 변경과 원자적이라는 주장도, 여러 프로필/DB를 아우르는 transaction도 아니다. 기존 열린 프로필과 새로 여는 프로필은 각자 client 수명을 소유한다. 새 open 실패로 이전 프로필의 목록을 덮지 않는다. sourceRevision이 필요한 실행 중 동적 혼합 갱신은 후속으로 남기며, 그 경우에는 두 종류를 한 완전한 provider 목록으로 변환·게시해야 한다.

## 저장 전용 factory의 공개 형태

현재 온라인 함수의 인자·반환형은 그대로 보존하고 다음 함수를 추가하는 안으로 좁힌다.

```ts
// infrastructure/mcp-read-collections.ts
createMcpReadCollection(binding, session, client, services, schemas): ReadCollectionBinding;
createMcpStoredReadCollection(
  binding: McpReadCollectionBinding,
  origin: McpStoredOrigin,
  services: Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'clock'>,
  schemas: SchemaCompiler,
): ReadCollectionBinding;
```

`McpStoredOrigin`은 [mcp-read-tools.ts](../../runtime/src/infrastructure/mcp-read-tools.ts)의 기존 endpointId/protocolVersion 타입을 재사용한다. 저장 전용은 지원 protocol 상수와 명시 host endpoint를 검사한다. 온라인 session의 generation/discoveryDigest를 만들어 내지 않고, 보관된 envelope의 historical session은 원문 그대로 검증한다.

내부 공통 builder는 원 remote/projector/manifest/deferral·definition 구성과 `original`/`proof`/`projectResponse`/restore 검증을 한 번만 가진다. online branch만 실제 session/client를 갖고 fetch를 구현한다. stored branch는 `availability: 'stored_only'`를 반환하고 fetch 직접 호출에는 명시 `mcp_stored_only` 오류를 던진다. 정상 코어는 그 전에 새 실행을 차단해야 하므로 이 오류를 `read_source_failed`로 소비하며 페이지 intent를 추가하는 것이 정상 경로가 되어서는 안 된다.

다음 기존 형식은 바꾸지 않는다.

- bindingDigest에 들어가는 remote, projector ID/version, endpoint/protocol, responseRecovery, coverage, deferral 설정과 definition version suffix.
- envelope v1, 원 session/recordedAt, `mcp-page:<attemptId>:<requestId>` command와 responseData digest.
- `ReadResponseRestoreResult`와 `restoreReadResponse`·page/deferral/manifest 검증 callback. restore는 원 receipt와 request intent를 검증하며 fetch·discover를 호출하지 않는다.

host stored-only open은 plain/stored collection factory를 같은 origin으로 조립한다. client 생성·peer 시작·initialize/list/call·온라인 fallback은 모두 없다. 정책과 현재 원자료 권한 검사는 그대로이며, 임의 old session을 현재 연결 권한으로 간주하지 않는다.

## availability 전달과 선행 복구의 최소 연결

`createReadCollectionTool`은 binding의 optional availability를 정의 바깥 Tool 필드로 전달한다. [ToolContracts](../../runtime/src/application/tool-contracts.ts) 173·203·216행의 구분을 유지한다. `callable`과 `checkExecution`은 새 호출을 차단하고, `readManifest`·`validateReadPage`·`validateReadDeferral`·`restoreReadResponse`는 현재 권한과 원 proof를 확인하는 데 사용한다. 정의·계약 digest에 availability를 추가하지 않는다.

일반 workflow의 현재 순서는 plain 저장 복구→compact→최초 ContextRecovery→execution step이다([workflow-runtime.ts](../../runtime/src/application/workflow-runtime.ts) 98·112행). collection reconciliation은 `recover`/`step`에만 있고, plain 선행 helper는 collection을 제외한다([execution-runtime.ts](../../runtime/src/application/execution-runtime.ts) 674·713·743행). raw page receipt 뒤 죽은 running attempt는 최초 session capacity 오류 때문에 실제 정산에 도달하지 못할 수 있다.

권고 순서는 **기존 plain 저장 복구→collection 저장 정산→기존 usage pass→compact→첫 context**다. execution의 작은 내부 경로가 한 번에 collection attempt 하나만 처리하고, 기존 workflow `maxSteps`/`onStep` 계산을 따른다. 메서드의 최종 이름은 아래 미결정 완료 경계와 함께 정한다.

- 이미 received인 collection 결과는 기존 `adopt`와 checkpoint proof로 처리한다. 새로운 결과를 만들지 않는다.
- 만료된 running collection은 기존 만료 transaction의 의미로 terminal 상태를 만든 뒤 `ReadReconciliation.reconcile`을 호출한다. 만료 전 다른 owner의 attempt는 건드리지 않는다.
- terminal collection의 원 request intent/미정산 head는 기존 reconciliation을 호출한다. 원 head가 실제 바뀌거나 만료 처리가 진행됐을 때만 continue로 계산한다. absent/변경 없음에 같은 후보를 계속 반복하지 않는다.
- 현재 paused/cancelled/failed/completed는 재개시키지 않고 명시 blocked도 보존한다. 현재 actor/host authority 확인 없이 이 경로를 호출하지 않는다. 원 권한·goal·source generation·receipt·registry 재검증은 기존 복구 코드에 남긴다.
- 새 reserve/dispatch/model이나 일반 effect 복구를 호출하지 않는다. 현재 `recover`의 마지막은 `services.effects.recover`를 부를 수 있으므로 이를 통째로 선행 helper로 호출하지 말고 기존 collection 만료/정산 부분만 좁게 재사용한다. 새 영수증 체계는 필요 없다.

이 선행 정산은 **checkpoint 복구**다. 아래의 결과 채택까지 완료했다고 취급하지 않는다.

## 구현 전 결정이 필요한 두 경계

### 완전 checkpoint의 저장 전용 결과 채택

[기존 실제 중단 시험](../../runtime/src/tests/mcp-read-settlement-recovery.test.ts) 170~244행의 기대값을 기준으로 삼는다. raw receipt를 정산한 부모는 failed/lease_expired·result null·adopted false를 유지한다. 최종 페이지도 명시 `readResume` successor를 submitPlan→reserve→execute→adopt하여 결과가 된다. 이 successor는 원 operation/root attempt·snapshot·한도를 이어 받고 **fetch는 0회**지만, 기존 업무 장부의 successor toolCall은 1회 늘어난다. 물리 호출 0과 도구 실행 회계 0을 같은 의미로 취급하지 않는다.

그런데 진짜 stored-only Tool을 붙이면 이 successor도 `requireCallable`에서 막힌다. 그러므로 factory+availability+선행 reconciliation만으로 “저장된 최종 페이지로 일반 답변 완료”를 인수할 수 없다. 부모 failed를 성공으로 소급 수정하거나 availability를 전역 available로 바꾸는 안은 제외한다.

권고 방향은 **현재 task/readResume와 원 complete checkpoint를 검증한 로컬 successor 소비 경계**다. 최소한 동일 goal/plan/query/계약, 현재 labels·destination·host authority, 정확한 parent head·manifest·source snapshot, 미연결 successor, 의무·한도·현재성, 원 page/deferral proof를 확인해야 한다. 완전 head만 허용하고, 일반 Tool.execute/fetch를 호출하지 않는 내부 경로에서 기존 완료 parent→child checkpoint→project 부분을 재사용한 뒤 normal receive/adopt로 이어가는 안을 우선 검토한다. source/registry/head가 바뀌면 다시 검사하며 새 원격 요청으로 전환하지 않는다.

다음 선택은 아직 확정하지 않는다: 일반 요청에서 이 successor task를 누가 생성하는지, 기존 plan의 명시 successor만 소비할지, reserve/dispatch의 내부 진입을 어떻게 기존 guard와 공유할지. 현재 control/checkExecution은 동기이며 원 proof는 비동기다. 비동기 proof를 동기 callback에 넣거나 이전에 계산한 `complete: true` 한 값으로 reserve·송신 검사를 우회하지 않는다. 이 계약과 결정적 경합 시험을 먼저 정한 뒤 구현한다. 해결 전에는 온라인 재개나 정산 성공으로 해당 offline 완료 인수를 대체하지 않는다.

### 부분 부모의 연결 대기와 재계획

[domain/control.ts](../../runtime/src/domain/control.ts) 59행은 마지막 attempt에 readProgress가 있으면 그 task의 allocation gate 전에 건너뛴다. 따라서 부분 부모만 남은 상태는 새 availability 검사에 닿지 않고 `plan_cannot_complete_goal`로 갈 수 있다. [execution-decision.ts](../../runtime/src/application/execution-decision.ts) 28행의 `readWaitControl`은 기한 전 replan을 wait로 바꾸지만, 기한 이후 연결 필요까지 대신하지 않는다.

인수 기준은 명확하다. 검증된 대기 기한 전에는 원 retryAt을 유지하며 새 모델·successor·call을 만들지 않는다. 기한 뒤 새 페이지가 필요하고 stored-only이면 연결 필요로 멈추고 원 partial 자료를 완료로 만들지 않는다. 온라인 명시 재개 후에는 원 cursor/snapshot 또는 retryIds만 이어 간다.

아직 선택할 부분은 partial parent를 식별하는 비동기 checkpoint 검사와 동기 control의 연결 위치다. 이미 succeeded/adopted인 과거 collection 때문에 새 업무 전체를 연결 대기로 만드는 광범위 필터는 피한다. 현재 task/query·원 head·후속 연결 여부를 묶고, 독립적으로 실행 가능한 다른 task를 잘못 막지 않아야 한다. 첫 미결정 로컬 successor 경계와 함께 정리하며 별도 모델 추론 예외나 저장된 summary flag만으로 판단하지 않는다.

## 구현과 검증 순서

1. **앞의 두 미결정 경계를 먼저 결정한다.** 실제 저수준 재개 계약을 유지하는 최소 방법을 선택하고, 최종 페이지와 부분 부모 두 실패를 독립 기대값으로 고정한다.
2. **factory/host 조립을 연결한다.** `ports`, `read-collections`, `host-tools`, `mcp-host-tools`, `mcp-read-collections`, `agent-turn-profile`가 중심이다. compose는 기존 인자를 그대로 쓰며, 배열 readonly 타입 조정 외 새 조립기를 만들지 않는다. plain-only 등록·온라인 API·원 digest 회귀를 유지한다.
3. **기존 정산을 일반 workflow 앞에 연결한다.** execution/reconciliation/workflow의 최소 부분만 수정한다. 제어·모델에 영향을 주는 변경은 미결정 경계가 요구하는 곳만 추가한다.
4. **실제 일반 입구로 끝낸다.** 아래 소수 통합 인수와 영향받은 기존 collection/wait/recovery/host/availability 회귀를 root가 최종 source pin으로 검증한다. NAS·기존 proof·updater를 이번 계획 작성 때문에 반복하지 않는다.

| 인수 | 독립 기대값 |
|---|---|
| mixed 등록과 기존 plain 호환 | 한 endpoint discover에서 두 종류 모두 등록, 동일 registry에서 사용. 마지막 collection schema/contract 실패에도 일부 프로필 반환 없음·소유 peer 정리. plain-only helper 결과와 원 definition/digest는 유지. |
| SQLite/file-journal 온라인 일반 요청 | 실제 stdio fixture의 고정 item·cursor·source snapshot·원 labels와 최종 답변의 근거가 일치. batch 실패 항목만 재요청하고 원 성공 항목은 동일하게 보존. |
| 실제 page receipt SIGKILL→stored-only CLI와 HTTP | 새 프로세스의 client/peer/initialize/list/call 0. 원 receipt·request·owner·lease·operation·한도 보존, 선행 정산 한 번. 완전 head는 결정한 로컬 소비 경계로 답변까지, 부분 head는 연결 대기로 귀결. |
| deferral/항목 대기→reopen→online | 원 retryAt 유지, 기한 전 신규 모델·할당·wire 0. 기한 후 stored-only 연결 대기, 명시 online open 후 필요한 request만 실행. 같은 request/receipt/usage/응답 재전달은 중복되지 않음. |
| 첫 context 용량과 동시 재개 | raw page receipt가 있어야 복구 가능한 상태에서 compact/첫 context보다 먼저 정산. 다른 프로세스의 동일 head 복구, registry/권한/head 변경과 beforeCommit 경합에서 중복 successor·부당한 채택 없음. |
| 손상·권한·미수신·새 업무 | raw/manifest/endpoint/projector 변경은 거절. intent-only와 artifact-only를 완료나 재송신 허가로 바꾸지 않음. 다른 담당의 자료, 과거 완료 collection, 별개 정상 task가 현재 재개 판정을 오염시키지 않음. |

기존 [collection](../../runtime/src/tests/mcp-read-collections.test.ts), [wait 복구](../../runtime/src/tests/mcp-read-waits-recovery.test.ts), [settlement 복구](../../runtime/src/tests/mcp-read-settlement-recovery.test.ts) fixture를 재사용하되 이미 있는 저수준 조합을 전부 복제하지 않는다. 모델은 명시 구조화 대역이고, 제품에 고정 업무 분기를 넣지 않는다. CLI만 통과하고 HTTP는 조회만 했거나, 실패 반환만 확인하고 최종 페이지의 실제 답변은 하지 않은 결과를 전체 인수 통과로 기록하지 않는다.

## 필수 후속과 완료 경계

collection fetch는 아직 plain의 요청별 decoded capture·`authorizeResponseCustody`를 쓰지 않으며, 예전 generic throw의 sent 추정도 남아 있다([mcp-read-collections.ts](../../runtime/src/infrastructure/mcp-read-collections.ts) 185행). **페이지별 post-send 원응답 보관·원 호출 회계와 현재 본문 채택의 분리는 필수 후속**이다. request/intent head별 귀속, 수신 시각, 늦은 응답·close, 증명된 사용량과 unknown을 따로 정해야 한다. 구형 receipt의 sent를 새 known proof로 소급 해석하지 않는다.

이번 단위가 끝나더라도 모든 전송 후 권한 상실 복구, 실제 사내 MCP/모델 품질, 배포·인증, native Windows, C05 전체나 전체 goal을 완료로 표시하지 않는다. 두 미결정 핵심을 남겨 둔 현재 문서는 착수 전 계획이며, 아직 구현·검증되지 않았다.
