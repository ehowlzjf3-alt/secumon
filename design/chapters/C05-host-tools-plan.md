# C05 호스트의 읽기 도구·권한을 일반 입구에 연결

2026-09-07 · **이 작은 단위의 구현·검증을 완료했다.** macOS Node24 신규54/54·관련356/356, 같은 소스의 NAS Linux 신규54/54·관련356/356·전체3,338/3,338과 필수8단계·원로그회수·정리를 확인했다. [결과](C05-host-tools-result.md) · [확정 증거](../../runtime/evidence/C05-host-linux-nas-20260907/verification.json). 아래는 실제 구현에 맞춘 실행계획과 계약이다. 선행 [C04 확정 결과](C04-goal-change-result.md)는 별도 역사로 보존한다. C05 전체와 전체 goal은 미완료이며 실제 모델/API 시험 중단을 유지한다.

목표는 담당마다 다른 읽기 도구를 주어도 같은 CLI/Web·세션·계획 검사·실행·답변 흐름을 쓰게 하는 것이다. 호스트는 에이전트를 실행하고 필요한 연결을 조립하는 프로그램이다. 새 도구 엔진이나 새로운 에이전트 조직을 만들지 않는다.

## 연결 전에 확인한 공백과 재사용

| 현재 코드 | 확인한 사실 | 이번 연결 |
|---|---|---|
| [일반 프로필](../../runtime/src/presentation/agent-turn-profile.ts)의 `openAgentTurnProfile` | `local/operator`, 허용 라벨·목적지·도구와 기본 한도가 코드에 고정돼 있다. 모델을 등록해도 `documents-simple.json`의 `doc-current`와 `FixtureReadTool`을 항상 만든다. | 신뢰된 호스트가 제공한 도구·권한으로 이 조립 부분을 대체할 수 있게 한다. |
| [모델 호스트](../../runtime/src/presentation/host-models.ts)의 `AgentTurnHost` | 등록표는 모델만 제공하고 모델 factory에는 담당 ID·목적·스킬 모드만 전달한다. | 모델 등록의 책임을 유지한다. 도구나 권한을 모델 factory의 반환값으로 받지 않는다. |
| [런타임 조립](../../runtime/src/application/compose-runtime.ts)의 `composeRuntime` | `services.tools`를 기존 core 도구와 합치고 카탈로그·자원·실행기를 조립한다. | 호스트의 도구를 기존 배열 입력에 연결한다. |
| [도구 계약](../../runtime/src/application/tool-contracts.ts)의 `snapshotTool`·`ToolContracts`, [카탈로그](../../runtime/src/application/tool-catalog.ts) | 계약과 콜백 고정, 스키마·중복 검사, 권한별 검색·정확한 계약 조회가 있다. | 같은 검사와 선택 로딩을 사용한다. 새 등록 언어나 전체 명세 상시 주입은 만들지 않는다. |
| [복합 조사 인수](../../runtime/src/tests/complex-agent-turn.test.ts)의 `open` | 다른 자료를 쓰기 위해 시험 안에서 stores·모델·도구·`composeRuntime`을 직접 조립한다. | 일반 입구에서도 그 조립이 가능하도록 연결한다. 복합 추론 자체를 다시 구현하지 않는다. |

위 표는 착수 당시의 공백과 채택한 재사용 방향이다. 현재 소스에는 `host.tools` 분기, 전체 actor 전달, 프로필 수명에 묶인 실행 권한이 연결돼 있다. 연결 뒤의 편의성·호출 감소·성능은 아직 측정한 결과가 아니다. 등록 모델의 앞선 합성 성공과 C04 목표 변경의 검증을 C05 성공으로 옮겨 적지 않는다.

## 실행 권한 연결에서 확인한 추가 경계

기존 WorkflowRuntime은 제한 필드가 있는 actor를 의도적으로 거절한다. 하위 모델·도구가 저장된 업무 정책으로 실행하므로 이 거절만 제거해서는 담당의 현재 권한을 보장할 수 없다. 일반 프로필이 전체 actor·담당 scope·종료 신호를 묶은 불변 실행 권한을 발급하고, 기존 조립 입력에 선택적으로 전달한다. 이는 프로필 수명에 묶인 권한 참조이며 새 자원 예산이나 영속 장부가 아니다.

주턴·계획·compact의 실제 모델 호출, 도구 최초 호출과 후속 `authorize`, 결과 전송·조회, 문맥 복원 경계에서 원 정책 전체와 현재 권한을 검사한다. 마지막 비동기 출처 확인 뒤에는 원 상태를 다시 읽고 바로 호출 직전에 종료 여부를 확인한다. 라벨·도구·목적지·쓰기 허용뿐 아니라 선택적 `disclosure`의 전송 표면·라벨·공개 횟수/크기도 기존 `disclosurePolicyNarrows`로 비교한다. 현재 호스트에 disclosure 제한이 있는데 옛 업무에 없거나 더 넓으면 거절한다.

lease는 여기서 **현재 프로필이 살아 있는 동안의 실행 권한 참조**다. lease가 없는 기존 경로는 제한 필드가 있는 actor에 `workflow_scoped_execution_not_supported`를 반환하는 검사를 유지한다. 새 권한 확인용 추가 저장소 재조회도 lease가 있는 경로에만 적용했다. 좁게 가린 조회 사본으로 넓은 원 정책을 허용하지 않으며, 상태 저장소 전체 읽기를 차단하지 않는다.

모델 응답 수신 시 권한이 사라졌다면 본문을 `model_authorization_changed` 오류 응답으로 바꾸면서 검증 가능한 `inputTokens`·`outputTokens` 보고값을 정산한다. artifact 저장이나 commit 전 검사 중 권한이 바뀌면 기존 최대 8회 수신 재시도로 현재 권한에서 다시 정산한다. 정산과 본문 채택은 별개이며, 보고값이 없거나 응답 형식 자체를 검증할 수 없으면 사용량을 0으로 확정하지 않는다. 유효한 늦은 도구 결과의 실행 기록도 수신할 수 있지만, 취소된 권한으로 근거를 채택하지 않는다. 이 동작의 결정적 회귀는 작성됐고 실행 결과는 아직 확정하지 않았다.

오류 응답으로 정산된 모델 본문은 새 lease로도 다시 채택할 수 없다. 읽기 도구 결과는 영구 폐기 규칙을 추가하지 않았다. 거절/채택을 확정하기 전에 새 유효 lease로 재개하면 원 정책·목표·출처 검사를 통과한 결과를 채택할 수 있다. 이미 `failed`로 확정한 attempt를 자동으로 되살린다는 뜻은 아니다.

## 첫 범위와 권한

첫 단위는 **호스트가 직접 등록한 일반 읽기 도구**다. 기존 `Tool` 계약과 지원 중인 POSIX 저장 경계를 사용한다. 내장 기억·원문·실행 장부 저장은 기존대로 동작한다. 여기서 읽기 전용이라는 말은 새 외부 도구의 효과 범위를 뜻하며, 에이전트가 내부 상태를 저장하지 않는다는 뜻이 아니다.

- 실행 프로그램의 정적 TypeScript 조립에서만 도구·권한을 전달한다. 사용자 원문, HTTP 본문, 임의 파일 경로·URL을 실행 모듈이나 권한으로 해석하지 않는다. 최초 단위에 설정 스키마 변경, 도구 설치 관리자, 실행 중 등록 교체는 필요 없다.
- 모델 등록과 도구·권한 등록을 분리한다. 모델은 전달받은 정확한 도구 계약 안에서 계획을 제안하고 기존 검사기·실행기가 처리한다. 도구 등록 정보도 독립적인 증거나 접근 권한의 근거가 아니다.
- 새 호스트 도구는 `effect: 'read'`만 허용하고 이번 호스트 정책의 `allowWrites`는 `false`로 고정한다. 계약 위반, 내장 `core.*` 이름/제공자 차용과 중복 등록을 거절한다. 필수 검증 콜백을 제거하거나 임의 성공값으로 대신하지 않는다.
- 호스트를 지정하지 않은 기존 명시적 합성 경로는 호환성을 유지한다. 호스트가 도구 조립을 제공했다면 그 결과가 실패하거나 잘못됐을 때 `fixture.read`로 조용히 돌아가지 않는다. 유효한 빈 도구 목록은 직접 답변용 구성이며 합성 도구를 자동 추가하지 않는다.
- `skills.mode: off`와 내장 core 도구의 기존 선택 규칙을 유지한다. 외부 도구를 등록했다는 이유로 개인 기억의 소유 범위, 아카이브 등록, 게시판 게시 권한을 확대하지 않는다.

`effect: 'read'` 선언과 계약 검사는 임의 호스트 코드에 대한 OS 샌드박스가 아니다. 호스트와 어댑터 구현은 신뢰된 실행 프로그램의 일부다. 실제 파일·프로세스 격리와 Windows 지원은 기존 C01 경계를 따르며 이번 연결로 보장을 확대하지 않는다.

## 현재 저장소의 공개 TypeScript 계약

아래 타입은 [presentation/host-tools.ts](../../runtime/src/presentation/host-tools.ts)에 실제 export되어 있다. `Tool`은 application 포트, `Policy`·`Limits`는 domain 타입을 재사용한다. 정식 설치 패키지의 exports 확정과 지원 완료를 뜻하지는 않는다.

```ts
interface HostToolContext {
  readonly agentId: string; // C01에서 확인한 담당의 지속 ID
  readonly root: string;    // 검증된 담당 디렉터리의 현재 위치
  readonly scope: string;   // 본체가 만든 담당 업무 범위
}
interface OpenedHostTools {
  readonly tools: readonly Tool[];
  readonly policy: Policy;  // 현재 호스트 권한과 새 업무의 기본 정책
  readonly limits: Limits;  // 새 업무에 줄 기본 한도
  close(): Promise<void>;
}
interface HostToolRegistration {
  open(context: Readonly<HostToolContext>): Promise<OpenedHostTools>;
}
interface AgentExecutionHost extends AgentTurnHost {
  readonly tools?: HostToolRegistration;
}
```

현재 함수는 `openAgentTurnProfile(directory, options = {}, host?: AgentExecutionHost)`, `runAgentTurnCli(args, host: AgentExecutionHost = createLocalContractHost())`, `openAgentWeb(args, host: AgentExecutionHost = createLocalContractHost())`다. 기존 모델만 가진 `AgentTurnHost`도 선택적 tools가 없는 형태로 전달할 수 있다. `resolveHostToolRegistration`은 선택을 고정하고, `openRegisteredHostTools`는 열린 도구·정책·한도를 검증한다. application/domain에서 presentation이나 특정 DB 구현을 import하지 않는다. 정식 패키지 exports와 전역 설치는 C10 범위다.

코어의 [execution-authority.ts](../../runtime/src/application/execution-authority.ts)는 `createExecutionAuthority({ actor, scope, signal, disclosure? })`와 `ExecutionAuthority`를 export한다. 인자의 `actor` 타입은 `WorkActor`이지만 실행 시 tenant/principal과 라벨·도구·목적지 배열, `allowWrites`가 모두 있어야 한다. 반환된 actor·scope·disclosure는 복사·동결되며 `signal`은 취소 상태가 바뀌는 참조로 유지한다. `composeRuntime({ executionAuthority, ... })`가 이를 `RuntimeServices.executionAuthority`에 전달한다. 일반 프로필은 호스트 도구를 생략한 합성 구성에도 이 권한을 발급한다.

본체가 C01 소유권을 확인한 뒤 context를 만들고 factory를 한 번 연다. 모델 factory와 달리 도구 factory는 자기 담당 위치를 받을 수 있지만, 다른 담당의 stores나 사용자 원문을 통째로 전달받지는 않는다. 반환된 정책·한도·도구 메타데이터를 검증·복사하고 메서드를 바인딩해 등록 정보와 호출 대상을 고정한다. 도구 자체는 기존 `snapshotTool` 경로를 사용한다. 이 고정이 콜백 내부 상태나 외부 자료까지 불변으로 만든다는 뜻은 아니다. 동작 버전·자료 신선도는 기존 어댑터 계약을 따른다.

정책의 사용자·테넌트와 라벨·목적지·도구 제한에서 기존 `WorkActor`를 조립한다. CLI의 workflow 호출과 Web의 `LocalWorkbench` 생성에는 전체 `profile.actor`를 전달한다. 현재 반환 타입의 `profile.executionActor`는 이름과 달리 채널 binding에 쓰는 tenant/principal만의 식별자이며 실행 권한 대체용이 아니다. [WorkflowRuntime 검사](../../runtime/src/application/workflow-runtime.ts)는 전체 actor 검사와 프로필 lease를 함께 사용한다.

## 담당·원문·근거를 유지하는 방법

담당 ID와 stores는 [기존 `openAgentStores`](../../runtime/src/infrastructure/agent-stores.ts)가 소유한다. 호스트는 ID, 세션 저장소, 기억 저장 경로를 대체하지 않는다. root는 위치이고 ID는 내부의 지속 식별자다. 디렉터리를 옮겨 같은 담당을 열면 같은 기록을 사용하며, 복제해 새 ID를 받으면 다른 담당으로 등록된다. 호스트의 선택도 경로 문자열만으로 담당 정체성을 대신하지 않는다.

같은 모델·사용자를 쓰는 담당 두 개라도 세션·원문·개인 기억의 기존 `tenant/agent/principal/session` 경계를 보존한다. 한 프로세스에서 여러 담당을 열 때 도구 factory 수명과 정리 대상도 담당별로 나뉜다. 동일한 도구 ID를 사용할 수 있지만 각 담당의 실제 소스·정책·계약 버전은 그 담당의 열기 결과에 속한다.

읽기 결과는 기존 도구 응답 저장 → 결과 검증 → 근거 채택 → 현재 문맥 → 답변 검토·전달을 거친다. 도구 설명이나 모델 문장을 근거로 만들어 넣지 않는다. 어댑터가 반환한 원문·원본 참조·계보·버전·라벨을 임의로 지우거나 현재 담당에 맞게 다시 붙여 권한을 통과시키지 않는다. 새 자료는 호스트 소스가 처음부터 올바른 범위로 제공해야 한다.

재접속해 권한이 좁아졌으면 옛 업무의 넓은 정책으로 조회·실행하지 못해야 한다. 기존 전체 actor 검사와 원문·근거·도구의 현재성 검사를 사용하고 저장된 업무 정책을 몰래 덮어쓰지 않는다. 도구 행동이 달라지면 어댑터의 기존 버전 규칙을 따른다. 초기 한도 설정은 새 업무에만 쓰며, 기존 업무의 사용량·예약·마감과 목표 변경의 한도 보존 의미는 유지한다.

## 자원 수명과 실패

호스트 factory가 성공하면 그 `close`를 프로필의 기존 정리 목록에 추가한다. 프로필 `close()`는 먼저 권한 signal을 취소하고 모델 → 도구 → 저장소 순서로 각 정리를 시도한다. CLI는 실행 흐름 뒤 프로필을 닫고, Web은 서버의 기존 drain을 거친 뒤 프로필을 닫는다. [기존 `closeAgentTurnResources`](../../runtime/src/presentation/host-models.ts)는 단일 오류를 그대로 던지고, 복수 오류는 최초 오류를 cause로 한 `AggregateError`에 함께 남긴다. 같은 프로필의 반복 `close`는 같은 완료 Promise를 사용한다.

factory가 반환하기 전에 실패했다면 자신이 연 부분 자원을 factory가 정리해야 한다. 반환 후 본체 검증이나 모델 열기가 실패하면 본체가 받은 도구 자원을 정리한다. 다른 담당이 쓰는 공유 자원을 닫지 않도록 소유/참조 수명은 호스트 구현이 명시한다. 새 전역 종료 관리자나 별도 실행 장부는 만들지 않는다.

signal 취소와 DB commit은 하나의 원자적 작업이 아니다. 보장은 마지막으로 관측한 원 상태·현재 권한을 호출/채택 경계에서 검사하는 범위다. 직접 `profile.close()`와 실행을 동시에 호출했을 때 모든 백그라운드 응답을 정산한 뒤 저장소를 닫는 완전한 drain도 제공하지 않는다. 늦은 정산의 인수는 저장소가 열려 있는 조건을 사용한다.

초기화·정리 오류 보존을 모든 실패 응답의 원본 바이트 보존으로 확대하지 않는다. 도구 결과의 형식·스키마·증명을 검증할 수 없으면 기존 실행기는 `invalid_tool_result`로 정규화해 저장하며, 임의의 잘못된 출력 전체를 보존하지 않는다. 유효한 원문 참조와 근거는 기존 계약에 따라 저장·검증하고 실패를 성공 근거로 바꾸지 않는다.

## 구현 순서와 현재 상태

1. **호스트 계약과 검사 — 구현, 검증 중.** `presentation/host-tools.ts`의 타입·열기·검증과 기존 도구 snapshot을 연결했다.
2. **일반 프로필과 권한 수명 — 구현, 검증 중.** 호스트 분기, 정책에서 파생한 actor/기억 제한, 모델·도구·stores 정리 및 새 `execution-authority.ts`를 연결했다. 실행·계획·도구 broker·outbox·문맥 복구가 같은 lease를 사용한다.
3. **CLI/Web — 구현, 검증 중.** 두 입구의 호스트 인자와 전체 actor 전달을 연결했다. HTTP에서 권한·모듈을 주입하는 필드는 추가하지 않았다.
4. **관련 회귀와 기록 — 진행 중.** 호스트 계약·프로필·권한 경합·CLI/localhost HTTP 시험을 작성했다. 첫 빌드 종료 코드 0만 확인했으며, 신규·관련·Linux 최종 동일 소스 검증 결과는 별도로 연결한다. C04 확정 결과를 C05 성공으로 계산하지 않는다.

카탈로그·세션·기억 포트와 저장 형식은 재사용했다. 확인된 scoped 실행 공백 때문에 선택적 코어 권한 참조와 호출 직전 검사를 구현 범위에 추가했다. 새 권한 DB나 자원 장부는 만들지 않았다. 외부 서비스 접속 등 별도 승인이 필요한 행동은 구분한다.

## 완료 기준

| 인수 | 확인할 결과 |
|---|---|
| 두 담당·하나의 일반 입구 | 같은 등록 모델과 사용자라도 서로 다른 로컬 읽기 소스를 받는다. CLI와 실제 localhost HTTP에서 접수→정확한 도구 호출→원본 저장→근거 답변을 확인한다. 다른 담당의 세션·원문·근거는 보이지 않는다. |
| 재접속과 권한 축소 | 같은 담당을 다시 열어 허용된 기록을 이어 쓰고, 금지 도구·라벨·목적지와 다른 담당/사용자의 조회·실행은 거절한다. 거절한 도구의 실제 호출 수는 0이다. 새 호스트 기본 한도가 기존 사용량·마감을 초기화하지 않는다. |
| 등록 실패와 호환 | 빈 도구 구성, 기존 모델 전용 호스트와 명시 합성 경로가 유지된다. 잘못된 계약·중복/core 이름·write 도구·실패한 factory는 거절하고 합성 fallback을 만들지 않는다. |
| 원문과 결과 | 유효한 도구 결과·답변·원본 참조를 대조한다. 잘못된 출력은 기존 `invalid_tool_result` 정규화 경계로 저장하고 성공 근거로 채택하지 않는다. 알려진 모델 사용량 정산과 본문 거절을 구분한다. 유효 자료 재사용에는 기존 계약을 적용한다. |
| 수명 | 성공·초기화 중간 실패·복수 cleanup 실패에서 각 소유 자원을 필요한 횟수만 닫고 원 오류를 보존한다. 한 담당 종료가 다른 담당의 도구를 닫지 않는다. |
| 모델과의 분리 | 모델 factory에는 권한·도구 인스턴스를 넘기지 않는다. 모델 입력에는 현재 허용된 계약만 들어간다. HTTP/원문으로 등록을 바꾸려는 입력은 거절한다. |

첫 흐름은 네트워크 없는 결정적 모델 전송과 로컬 읽기 대역으로 검증한다. 같은 본체에 다른 도구를 조립할 수 있다는 계약 증거이며 실제 모델의 도구 선택 품질·사내 권한·외부 통신 성공 증거가 아니다. 단순 답변에 가설·스킬·긴 계획을 추가하는 시험 조건을 넣지 않는다.

## 다음 범위와 종료선

쓰기 도구와 미확정 외부 효과, 실제 MCP 연결·동적 카탈로그 갱신·배치/페이지 최적화, 도구/기억/스킬 선택 비용, 컴퓨터 유즈와 Knox는 각각 기존 C05/C06 이후 범위에서 진행한다. 이미 있는 MCP·페이지·효과 복구 구현을 이번에 다시 만들지 않는다. 실제 서비스 접속과 모델/API 재개는 이 계획의 승인에 포함되지 않는다.

위 일반 입구의 읽기 연결과 인수를 끝내면 이 작은 단위는 닫는다. Windows·PostgreSQL·실제 모델 품질의 미완료 항목 때문에 같은 조립을 반복 구현하지 않고, 반대로 그 항목을 완료로 표시하지도 않는다. 전체 기준은 [통합 계획 C04/C05](../03-migration-plan.md), [작업 목록](../implementation-backlog.json), [등록 모델 결과](C04-registered-model-result.md), [목표 변경 결과](C04-goal-change-result.md)을 따른다.
