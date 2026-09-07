# C04 등록 모델 연결 — 최소 계약 검토

2026-09-07 · [문맥 창 이후 검토](C04-after-window-review.md)를 구체화한 제안. 검토 과정에서는 제품·시험·설정 변경, 새 실행 및 외부 연결을 하지 않았다. 문맥 창 최종 검증은 이후 [3,209/3,209 통과와 정리 완료](C04-context-window-result.md)로 확정했다. 이 문서의 타입과 이름은 구현 전 제안이며 채택할 순서는 [구현 계획](C04-registered-model-plan.md)을 따른다.

권고는 **C01의 `model.profile` 이름을 호스트의 고정 등록표에서 찾고, 기존 일반 요청 조립에 `Planner` 한 개를 주입하는 것**이다. 등록표는 모델 구현을 찾는 수단이며 권한, 사용자 신원, 도구 실행기나 저장소를 제공하는 수단으로 만들지 않는다. CLI와 Web은 같은 조립 함수를 호출한다.

## 1. 기존 경계에서 바꿔야 할 최소 지점

| 실제 코드 | 현재 계약 | 필요한 차이 |
|---|---|---|
| [agent-profile-contracts](../../runtime/src/application/agent-profile-contracts.ts) | v1/v2 모두 `model:null \| {profile:string}`. 설정 조회의 `modelReady:false`는 실행 연결이 아니다. | 저장 schema·setup/clone 형식은 그대로 사용한다. 모델 등록·실행 준비 상태를 파일 조회에 소급 기록하지 않는다. |
| [agent-turn-profile](../../runtime/src/presentation/agent-turn-profile.ts) | synthetic만 허용하고 모델·고정 정책·읽기 fixture를 직접 조립한다. C01 저장소/세션/개인 기억 조립은 이미 있다. | 모델 생성 부분만 등록 factory로 분리한다. 기존 합성 분기는 유지하고 등록 이름으로 선택한 경우에만 새 분기를 사용한다. |
| [composeRuntime](../../runtime/src/application/compose-runtime.ts) | `services.planner`를 받지만 `PlanningRuntime` 생성 설정에는 `leaseMs`만 전달한다. | 선택적 `modelInputLimits: ModelInputRuntimeLimits`를 받아 `maxInputBytes/maxOutputTokens`를 기존 생성자에 전달한다. 일반 planning과 compact 전용 runtime 양쪽에 같은 값을 적용하고 생략 시 현재 기본값을 보존한다. |
| [StructuredAgentTurnAdapter](../../runtime/src/infrastructure/structured-agent-turn.ts) | 호스트 구성+transport, strict reply, prompt/신원/도구/공개범위 검사, 같은 요청 크기 추정을 제공한다. `propose`는 잘못된 경로를 거절한다. | 재사용한다. 직접 답변을 가짜 계획으로 변환하지 않는다. 새 compact 포장만 같은 계약에 붙인다. |
| [CLI](../../runtime/src/presentation/agent-turn-cli.ts), [Web 진입점](../../runtime/src/presentation/web.ts), [Workbench](../../runtime/src/presentation/local-workbench.ts) | 동일 profile을 사용하지만 provider 선택과 안내·model·compactProvider 타입이 synthetic에 고정돼 있다. | 프로필 선택은 시작 시 호스트에서만 한다. 실행 서비스와 표시 정보는 같은 반환 profile에서 얻는다. HTTP 요청 본문에 provider·정책·모듈 경로를 추가하지 않는다. |

`PlanningRuntime`의 현재 기본 출력 예약은 2,048, 요청 바이트 한도는 65,536이다. 작은 등록 모델의 출력 한도가 더 작으면 기본값을 묵시적으로 줄이지 않고 **호스트가 명시한 호출 한도**를 받아야 한다. 기존 [resolveModelInputLimits](../../runtime/src/application/model-input-budget.ts)가 모델 능력값과의 적합성을 검사한다. WorkState의 업무 소비 예산은 이 설정과 별개다.

## 2. 호스트 등록 factory의 타입 제안

다음은 새 프레임워크의 계층이 아니라 조립 함수에 넣을 작은 타입 경계다. `AgentTurnProfile`이라는 이름이 presentation 반환형과 겹치므로 아래 `PromptProfile`은 기존 application 타입의 import 별칭이다.

```ts
type PromptProfile = import('../application/agent-turn-types.js').AgentTurnProfile;

type RegisteredTurnPlanner = Planner & {
  readonly identity: ModelIdentity;
  readonly prompt: AgentTurnPrompt;
  readonly inputEstimation: ModelInputEstimationProfile;
  turn: NonNullable<Planner['turn']>;
  estimateTurnInput: NonNullable<Planner['estimateTurnInput']>;
  estimateContextPreview: NonNullable<Planner['estimateContextPreview']>;
};

interface OpenedHostModel {
  planner: RegisteredTurnPlanner;
  inputLimits: Readonly<ModelInputRuntimeLimits>;
  close(): Promise<void>;
}

interface HostModelRegistration {
  open(profile: Readonly<PromptProfile>): Promise<OpenedHostModel>;
}

type HostModelRegistry = ReadonlyMap<string, HostModelRegistration>;

type AgentTurnModelSelection =
  | { kind: 'synthetic'; compact: boolean }
  | { kind: 'registered' }; // 이름은 C01 config.model.profile에서 읽는다.

// 기존 openAgentTurnProfile을 이 경계로 확장하거나 작은 내부 함수로 분리한다.
openAgentTurnProfile(directory, selection, hostModels): Promise<AgentTurnProfile>;
```

`Planner.compact/estimateCompactInput`은 기존 선택 포트를 유지한다. 등록 제공자가 compact를 제공한다면 둘을 함께 제공하도록 초기 조립에서 확인하고, 없으면 compact 미지원으로 표시한다. 필요한 시점에 기존 `session_compact_unavailable` 경로로 멈추며 합성 요약으로 대체하지 않는다. 등록 분기의 `propose`는 현재 주 턴 어댑터처럼 잘못된 호출을 거절할 수 있다. 이전 planning 전용 업무를 새 주 턴 모델로 자동 이관하는 기능은 포함하지 않는다.

등록 이름은 정확한 Map 키로만 조회한다. C01의 기존 길이·문자 제약을 그대로 적용하고 경로, URL, 패키지 이름으로 해석하지 않는다. `model:null`, 없는 키, 중복 등록, 잘못된 반환 계약은 별도 등록 오류이며 fallback하지 않는다. 등록표와 DTO는 열린 프로필 안에서 복사·검증·고정한다. `ReadonlyMap` 선언이나 `Object.freeze`가 임의 호스트 callback의 내부 변경까지 막는 보안 경계라고 주장하지 않는다.

factory에는 담당 ID·목적·skills mode만 넘긴다. 원문, WorkState, 저장소, 자료 조회 권한을 넘기지 않는다. 모델 객체 구성과 로컬 추정기 등록만 수행하고, 모델 조회·연결 시험·warmup 호출은 하지 않는다. 사용자 원문을 받는 실제 `turn/compact`는 기존 `PlanningRuntime`의 예약·현재성 검사 뒤에서만 호출한다. `close`는 이미 연 호스트 자원 정리용이며 단순 로컬 대역에서는 no-op이면 충분하다.

## 3. 주 턴과 compact가 공유해야 할 계약

현재 [Planner](../../runtime/src/application/ports.ts)와 [입력 설정 지문](../../runtime/src/application/model-input-profile.ts)은 한 `identity/destination/capabilities/inputEstimation`을 가진다. 따라서 첫 등록은 **주 턴과 compact에 같은 모델 신원·목적지·능력 한도·호출 한도**를 사용한다. 목적별로 다른 모델을 라우팅하기 위해 core 계약을 넓히지 않는다.

- `inputEstimation.templateRevision`은 주 턴 포장과 compact 포장 및 고정 compact 지시문의 버전까지 포함한 통합 revision으로 등록한다. 한 목적의 포장만 바뀌어도 이 revision이 바뀌어야 한다. 각 estimate는 자신이 실제 보낼 전체 JSON 요청을 계산하고, 공통 지문은 그 두 포장의 등록 버전을 고정한다. 별도 compact prompt 지문 필드를 옛 ModelCall에 급히 추가할 필요는 없다.
- compact의 새 얇은 어댑터는 기존 `SessionCompactInputSchema`, `SessionCompactCandidateSchema`, 모델 응답·usage 정규화와 바이트 제한을 재사용한다. 고정 지시문은 정확 인용, 기존 retained 항목·반론·미해결 항목의 보존, 변경 근거와 원문 참조를 요구한다. 의미 보존의 최종 정확성은 실제 모델 평가 대상이고, 기계 검사가 모든 반론의 의미를 증명하지 않는다.
- **`SessionCompactInput.policyDigest`는 송신 권한이 아니다.** 이 입력에는 Policy 본문이 없다. 기존 [SessionCompactCalls](../../runtime/src/application/session-compact-runtime.ts)와 [PlanningRuntime](../../runtime/src/application/planning-runtime.ts)이 현재 원문·정책·목적지·취소를 검사한 뒤 전송한다. HTTP나 CLI가 compact transport를 직접 호출하는 경로를 만들지 않는다. policyDigest만 보고 자료 전송을 승인하는 로직도 넣지 않는다.
- 새 등록 프로필의 최소 버전에서는 같은 능력값을 두 목적에 적용한다. 실제 제공자의 목적별 한도가 다르면 호스트가 양쪽에 유효한 공통 한도를 명시하거나 등록을 거절한다. 한도·출력 예약을 런타임이 몰래 줄이지 않는다.
- 받은 응답·사용량은 등록 변경 때문에 지우지 않는다. 재시작 후 모델 identity/지시문/원문이 달라진 경우와 입력 한도만 달라진 경우를 기존 단계별 규칙대로 구분한다. 단순 재등록 이름 변경은 과거 call의 원 identity를 덮어쓰지 않는다.

## 4. C01 schema를 유지하는 선택과 초기 등록 방법

초기 사용 형태는 예를 들어 C01 config의 기존 필드 `"model":{"profile":"local-contract-v1"}`와 명시적인 `--provider registered`의 조합이다. 옵션 이름은 구현 시 확정하되 **registered 모드에는 별도 모델 이름 override를 먼저 넣지 않는 것**을 권한다. CLI와 Web이 서로 다른 우선순위로 이름을 고르는 문제를 줄인다. 기존 `--provider synthetic [--compact-provider synthetic]`는 그대로 유지하고 두 모드 옵션을 섞으면 거절한다. 등록 모드의 compact 사용 가능 여부는 해당 등록이 제공하는 포트에서 결정한다.

등록표는 다음 두 경우를 같은 함수 인자로 받을 수 있으면 충분하다.

1. **최초 실행·시험용:** 배포물의 고정 TypeScript 모듈이 로컬 결정적 structured transport를 정적 import하고 `local-contract-v1`을 등록한다. 기존 합성 예제와 마찬가지로 네트워크가 없으며 정해진 입력의 계약만 확인한다. 등록 경로를 통과했다는 사실을 실제 모델 연결로 표시하지 않는다.
2. **사내 호스트 조립용:** 호스트 프로그램이 설치된 런타임의 공개 진입 함수와 자신이 관리하는 transport를 정적 import하고 등록표를 인자로 넘긴다. 본체의 세션·메모리·실행 코드를 수정하지 않는다. 실제 transport의 네트워크 검증은 현재 범위 밖이다.

첫 단위에는 config에서 코드 경로를 받는 `import(path)`, 임의 모듈 loader, 실행 파일 검색, 환경변수로 모듈을 지정하는 방법을 추가하지 않는다. 기존 고정 경로의 모듈 로딩을 재작성하는 작업도 필요 없다. credentials·endpoint·헤더는 C01 `model.profile`, 업무 artifact, Web config에 넣지 않는다. 나중에 실제 호스트 transport가 필요할 때 별도의 호스트 설정이 책임진다.

설정 파일의 기존 `model` 값을 사용하는 것과 새 schema migration은 다르다. 기존 v1/v2 bytes의 기본값을 바꾸지 않고, read-only inspect는 계속 `modelReady:false`를 반환한다. 실행 조립의 `modelInfo`는 메모리상의 별도 상태다. clone은 기존 방식대로 profile 이름을 복사할 수 있지만 대상 호스트에도 같은 등록이 있다는 의미는 아니다.

## 5. CLI/Web을 같은 조립으로 연결

CLI `runAgentTurnCli(args, host)`와 Web의 실행 함수가 같은 `host.models` 및 동일한 프로필 여는 함수를 받게 한다. Web의 현재 최상위 `main()`에서 argv 처리/프로필 조립을 작은 호출 가능한 함수로 분리하면 고정 호스트 entrypoint도 재사용할 수 있다. 별도 HTTP agent loop를 만들지 않는다.

```text
호스트가 등록표 구성
  → CLI/Web 시작 옵션의 synthetic 또는 registered 선택
  → 기존 C01 initialize/inspect 및 저장소 실행 gate
  → model.profile 이름 조회, PromptProfile로 factory open
  → 기존 정책/도구/원문 저장소 + Planner + inputLimits로 composeRuntime
  → CLI: AgentTurnService / WorkflowRuntime
     Web: agentTurnWorkbenchProfile / LocalWorkbench / startWebServer
```

미등록은 가능하면 DB 열기·업무 접수 전에 판별한다. 모델 구성을 먼저 열었다가 C01 저장소 gate가 실패하면 model.close를, 저장소까지 열고 후속 조립이 실패하면 둘 다 정리한다. 한 정리 실패 때문에 다른 정리를 건너뛰지 않고 최초 오류와 정리 오류를 보존한다. 모델 factory는 생성/종료만 관리하며 저장소 정본이나 작업 resume를 대신하지 않는다.

공개 표시 정보는 예를 들어 `{selection:'synthetic'|'registered', profileName:string|null, identity, compact:boolean, execution:'deterministic_fixture'|'host_transport'}`면 충분하다. `host_transport`는 로컬 연결 객체가 구성됐다는 뜻이며 실제 접속 시험 통과가 아니다. `modelReady:false`를 덮어쓰거나 모든 registered를 “실제 모델”로 표시하지 않는다.

현재 `WorkbenchConfig.profile/model`, `WebCompactStatus.provider`, `localCompactStatus`와 CLI/Web 안내문에는 synthetic literal이 있다. 새 등록을 허용하면서 이 표현을 그대로 남기면 잘못된 설명이 된다. 같은 `modelInfo`의 비밀 없는 투영을 읽도록 좁게 수정하고, 기존 합성 응답의 모양은 가능한 한 유지한다. 일반 요청 HTTP schema에는 여전히 requestId/mode/rawText만 둔다. 프로필 선택·등록표 열람·임의 transport 호출은 HTTP 기능으로 추가하지 않는다.

## 6. 모델 등록과 권한을 섞지 않는 경계

첫 모델 등록 단위의 기본 호스트 배치는 기존 local 사용자·local 채널과 명시된 읽기 fixture 정책을 유지해도 된다. 다른 도구를 테스트할 때는 호스트가 기존 `Tool[]`를 조립에 주입하면 충분하다. 등록 모델의 이름으로 actor·allowedTools·allowedLabels·allowWrites가 바뀌는 구조는 피한다. `composeRuntime`이 추가하는 core resource/knowledge 도구와 중복 등록하지 않고 `skills=off` 때 지침 도구와 본문 차단을 유지한다. 일반 도구/정책 등록 제품화는 별도 C05/C06 범위다.

현재 `executionActor`는 호스트의 전체 실행 신원이고, `WorkflowRuntime`은 축소 권한을 가진 actor 실행을 거절한다. 따라서 **임의 요청 actor의 제한을 지워 executionActor로 만드는 기능을 등록 factory에 넣으면 안 된다.** 현 로컬 고정 호스트 권한에서만 기존 방식을 유지한다. 나중에 호스트 정책을 외부 설정으로 변경 가능하게 할 경우, 과거 저장 업무의 넓은 정책을 축소된 현재 호스트가 그대로 실행하지 못하도록 기존 정책 변경 명령 또는 실행 거절 gate가 먼저 필요하다. 이번 모델 연결이 다중 사용자 인증이나 동적 권한 변경을 구현했다고 주장하지 않는다.

## 7. 다음 구현에 필요한 확인만

- 동일 C01 모델 이름을 CLI와 Web이 같은 등록으로 열고, schema v1/v2와 storage/setup/clone은 그대로 읽는다. 미등록·잘못된 등록은 호출 전에 거절한다.
- 등록 factory는 원문/저장소에 접근하지 않고 입력 profile의 목적·ID·skills를 고정 prompt에 반영한다. 등록된 한도는 compose를 거쳐 실제 `ModelCall.inputProfileDigest`와 출력 예약에 반영된다.
- 로컬 structured turn→실제 읽기→structured compact→후속 답변/재시작 한 흐름을 기존 저장소로 확인한다. JSON/usage 오류와 등록 변경의 작은 경계는 기존 adapter/runtime 시험을 재사용한다.
- status/history/GET 재접속은 모델 호출을 시작하지 않는다. registered의 로컬 결정적 실행과 미시험 host transport를 화면·CLI가 정확하게 구분한다.
- 등록 없음과 생성 중 실패에서 원 오류·정리 오류·열린 자원 수명을 확인한다. scope/세션/정책 검사와 기존 출처 검사를 생략하는 직접 호출은 없어야 한다.

실제 모델 API·사내 모델·tokenizer 정확도·요약 의미 품질은 여전히 미검증이다. PostgreSQL, native Windows runtime/file binding 연결·실기 검증, Knox, 독립 반론 에이전트는 이번 등록 계약의 선행 조건이나 완료 항목에 넣지 않는다. 확정된 문맥 창 증거를 보존하고 위 계획의 다음 구현에 한해 소스 동결을 해제한다.
