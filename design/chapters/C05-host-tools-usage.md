# C05 호스트 읽기 도구 사용법

2026-09-07 · **구현·검증한 호스트 읽기 도구 조립의 사용 계약이다.** macOS Node24 신규54/54·관련356/356, 같은 소스의 NAS Linux 전체3,338/3,338을 확인했다. [결과](C05-host-tools-result.md) · [확정 증거](../../runtime/evidence/C05-host-linux-nas-20260907/verification.json). 아래 예제는 조립 방법이며 실제 사내 서비스나 실제 모델 품질의 검증을 뜻하지 않는다. C05 전체와 실제 연동은 후속 범위다.

## 호스트가 하는 일

여기서 **호스트**는 에이전트를 실행하는 프로그램이다. 리드 에이전트나 다른 모델을 뜻하지 않는다. 신뢰된 시작 프로그램이 모델 등록표와 선택적인 도구 조립 함수를 전달한다.

- `host.models`: 설정의 이름으로 모델 연결을 찾는 등록표. 모델 설정·입력 한도·전송과 종료를 맡는다.
- `host.tools.open(context)`: 해당 담당의 읽기 도구, 정책, 새 업무의 기본 자원 한도와 종료 함수를 반환한다.
- `context.agentId`: C01이 확인한 담당의 지속 ID. `root`는 현재 담당 디렉터리 위치이고, `scope`는 본체가 만든 담당 업무 범위다. 경로 문자열을 ID 대신 쓰지 않는다.

모델 등록 함수에는 권한이나 도구 인스턴스를 넘기지 않는다. HTTP 본문·사용자 발언·설정의 경로를 실행 모듈로 불러오는 기능도 없다. 현재 입구는 [AgentExecutionHost와 도구 검사](../../runtime/src/presentation/host-tools.ts), [모델 등록 계약](../../runtime/src/presentation/host-models.ts)을 사용한다.

현재 export는 `HostToolContext`, `OpenedHostTools`, `HostToolRegistration`, `AgentExecutionHost`, `resolveHostToolRegistration`, `openRegisteredHostTools`다. `AgentExecutionHost`는 기존 `AgentTurnHost`를 확장하고 선택적 `tools?: HostToolRegistration`만 추가한다. `OpenedHostTools`는 읽기 도구 배열, `Policy`, `Limits`, `close(): Promise<void>`를 반환한다. 아래 CLI/Web의 host 인자도 같은 타입이며 모델만 등록한 기존 호스트를 전달할 수 있다.

## 기존 읽기 어댑터를 조립하는 예

아래는 `runtime/src/` 아래에 시작 프로그램을 작성한다고 가정한 **현재 저장소 내부 경로 예제**다. 정식 설치 패키지의 exports는 C10에서 정할 사항이다. `modelHost`와 `openReadAdapter`는 배치 프로그램이 제공해야 하며, 이 문서는 실제 서비스 어댑터를 제공하지 않는다.

예제 어댑터는 `enterprise.read`라는 기존 `Tool`이고 목적지는 `local`, 읽을 자료의 라벨은 `public`이라고 가정한다. 실제 연결에서는 신뢰된 사용자 식별·자료 분류·목적지에 맞는 값을 명시해야 한다. 자료 라벨을 예제에 맞춰 바꾸면 안 된다.

```ts
import type { Tool } from './application/ports.js';
import type { AgentTurnHost } from './presentation/host-models.js';
import type {
  AgentExecutionHost, HostToolContext,
} from './presentation/host-tools.js';
import { runAgentTurnCli } from './presentation/agent-turn-cli.js';
import { openAgentWeb } from './presentation/agent-web.js';

type OpenReadAdapter = (context: Readonly<HostToolContext>) => Promise<{
  tool: Tool;
  close(): Promise<void>;
}>;

export function createExecutionHost(
  modelHost: AgentTurnHost,
  openReadAdapter: OpenReadAdapter,
): AgentExecutionHost {
  return {
    models: modelHost.models,
    tools: {
      async open(context) {
        const source = await openReadAdapter(context);
        return {
          tools: [source.tool],
          policy: {
            tenantId: 'example-company',
            principalId: 'example-user',
            allowedTools: [
              'enterprise.read', // 이 호스트가 명시적으로 허용한 도구
              'core.catalog.search', 'core.catalog.get',
              'core.evidence.find', 'core.evidence.get',
            ],
            allowedLabels: ['public'],
            allowedDestinations: ['local'],
            allowWrites: false,
          },
          limits: {
            toolCalls: 30, modelCalls: 16, tokens: 1_000_000,
            replans: 8, wallTimeMs: 3_600_000,
          },
          close: () => source.close(),
        };
      },
    },
  };
}

export async function runCli(agentDirectory: string, host: AgentExecutionHost) {
  // 이 함수를 직접 부를 때 args에 'chat' 접두사는 넣지 않는다.
  await runAgentTurnCli([
    'ask', '--directory', agentDirectory, '--provider', 'registered',
    '--message-id', 'example-request-1', '--text', '허용된 자료를 확인해줘.',
  ], host);
}

export async function startWeb(agentDirectory: string, host: AgentExecutionHost) {
  // 호출자는 반환된 app.close()를 자신의 종료 절차에 연결한다.
  return openAgentWeb([
    '--directory', agentDirectory, '--provider', 'registered', '--port', '0',
  ], host);
}
```

담당의 `config.json`에는 `model.profile`을 `modelHost.models`에 등록한 정확한 이름으로 지정한다. 기존 설정의 다른 값과 담당 ID는 유지한다. `local-contract-v1`을 가진 [기본 로컬 호스트](../../runtime/src/presentation/local-contract-model.ts)를 모델 등록표로 재사용할 수는 있지만, 그것은 정해진 문장·도구만 처리하는 합성 예제다. 위의 임의 요청과 `enterprise.read`를 자유롭게 선택하는 실제 모델로 바뀌지는 않는다.

필요하면 시작 프로그램이 `openAgentTurnProfile(directory, { provider: 'registered' }, host)`를 직접 호출할 수 있다. CLI/Web은 같은 프로필 조립을 사용한다. 도구 등록은 명시적 `synthetic` 모델 선택과도 독립적으로 전달되지만, 그 모델의 고정 규칙 제한은 그대로다. 등록 모델의 주턴·compact 연결은 [등록 모델 사용법](C04-registered-model-usage.md)을 따른다.

## 등록과 권한은 별개다

본체는 기존 [Tool 계약과 검증 콜백](../../runtime/src/application/tool-contracts.ts)을 재사용한다. `effect: 'read'`만 허용하며 외부 어댑터가 `core.*` ID나 `core` 제공자를 대신할 수 없다. 동일 ID·버전 중복도 거절한다. 스키마·메타데이터와 호출 함수를 고정하지만, 어댑터 내부 상태나 외부 자료까지 불변으로 만드는 것은 아니다.

`policy.allowedTools`에는 등록한 도구가 **자동으로 추가되지 않는다**. 내장 도구도 필요한 것만 명시한다. 목록에 이름을 적는 것만으로 미등록 외부 도구를 설치하거나 불러오지는 않는다.

| 필요한 기능 | 명시할 내장 도구 ID |
|---|---|
| 도구 검색·정확한 계약 조회 | `core.catalog.search`, `core.catalog.get` |
| 이미 저장한 근거 찾기·원문 조회 | `core.evidence.find`, `core.evidence.get` |
| 호출 기록 조회 | `core.calls.find`, `core.calls.get` |
| 기억 조회 | `core.memory.search`, `core.memory.get` |
| 스킬 검색·읽기 | `core.guidance.find`, `core.guidance.load` |

내장 도구의 목적지는 `local`이다. 모델과 외부 도구의 실제 목적지, 자료 라벨도 각각 허용 범위에 있어야 한다. `skills.mode: 'off'`이면 호스트가 허용했더라도 `core.guidance.*`를 제외한다. 도구 연결이 스킬 끄기를 무효화하지 않는다.

`host.tools`를 생략하면 기존 로컬 합성 도구 구성을 유지한다. 반면 `tools.open()`이 유효한 `tools: []`를 반환하면 외부 도구가 없는 구성으로 사용하며 `fixture.read`를 보충하지 않는다. 허용한 내장 도구와 내부 저장 기능은 별개다. 잘못된 등록이나 열기 실패도 합성 도구로 대체하지 않고 오류로 끝난다.

## 담당 범위, 원문과 종료

어댑터는 `context`에 맞는 소스와 자신의 연결 수명을 열어야 한다. 같은 ID의 도구를 여러 담당에 배치할 수 있지만, 다른 담당의 원문·근거를 현재 담당의 라벨이나 scope로 다시 붙여 허용 자료처럼 만들면 안 된다. 원본 참조·출처·버전·검증 콜백은 기존 도구 결과 검증 흐름에 남긴다. 세션·개인 기억의 tenant/agent/principal 경계를 도구 등록으로 합치지 않는다.

실행에는 프로필의 현재 권한과 종료 신호가 연결된다. 코어의 `createExecutionAuthority({ actor, scope, signal, disclosure? })`는 전체 actor와 업무 scope, 선택적인 disclosure 정책을 복사·동결하고 살아 있는 취소 신호를 함께 보관한다. 일반 프로필이 이를 생성하므로 위의 호스트 예제에서 따로 발급할 필요는 없다. `disclosure`는 어떤 목적지·전송 표면에 어떤 라벨을 내보낼지와 공개 횟수·크기를 제한하는 정책이다.

권한을 좁혀 다시 열면 저장된 옛 업무의 원 정책 전체가 현재 허용 범위에 들어가는지 검사한다. 더 넓은 옛 정책을 몰래 수정하거나 좁은 조회 사본만 보고 실행하지 않는다. 모델 주턴·계획·compact, 도구 최초 호출과 `context.authorize`, 채널 send/lookup, 문맥 복구가 이 권한 참조를 사용한다. 비동기 대기 후 추가 작업을 수행하는 어댑터는 `context.authorize` 재검사와 `signal` 취소 계약을 지켜야 한다. 이 선언과 검사는 임의 호스트 코드에 대한 OS 샌드박스가 아니다.

직접 런타임을 조립할 때만 `composeRuntime`의 선택적 `executionAuthority` 입력을 사용한다. 실행 권한 참조가 없는 기존 런타임은 제한 필드가 있는 actor에 `workflow_scoped_execution_not_supported`를 반환하는 기존 검사를 유지한다. 일반 CLI/Web은 전체 제한을 가진 `profile.actor`를 전달한다. `profile.executionActor`는 현재 코드에서 tenant/principal만의 채널 식별자이므로 workflow 실행에 대신 전달하지 않는다.

늦게 도착한 응답의 **정산과 본문 채택은 별개**다. 취소 뒤 받은 모델 응답에서 형식 검증을 통과한 사용량 보고값은 기존 호출에 정산하되, 채택할 수 없는 본문은 `model_authorization_changed` 오류로 저장한다. 보고값을 모르면 0으로 꾸미지 않는다. 유효한 늦은 도구 결과의 실행 기록 역시 보존할 수 있지만 취소된 권한으로 그 근거를 채택하지 않는다. 반면 형식·스키마·증명을 통과하지 못한 도구 출력은 기존 `invalid_tool_result` 응답으로 정규화한다. 잘못된 출력의 원문 바이트를 모두 보존하는 기능은 아니다.

오류로 정산한 모델 본문은 새 유효 권한으로 재접속해도 채택할 수 없다. 읽기 도구 결과는 거절/채택을 확정하기 전에 새 유효 권한으로 재개하면 원 정책·목표·출처 검사를 거쳐 채택할 수 있다. 이미 `failed`로 확정한 attempt가 자동으로 복원되는 것은 아니다.

`limits`는 새 업무의 기본 호출·토큰·시간 한도다. 프로필 재열기나 목표 변경이 기존 업무의 사용량·예약·마감을 초기화하지 않는다. 모델 입력 창 크기와도 별개다.

CLI는 실행 흐름 뒤 프로필을 닫고, Web의 `close()`는 서버의 기존 drain 뒤 프로필을 닫는다. 프로필은 먼저 취소 신호를 보내고 모델 → 도구 → 저장소 순서로 정리를 시도한다. 반복 종료에는 같은 Promise를 사용한다. `closeAgentTurnResources`는 단일 오류를 그대로 전달하고, 최초 실패와 독립 정리 실패가 겹치면 최초 오류를 cause로 한 `AggregateError`에 함께 남긴다. factory가 반환하기 전 열다 실패한 부분 자원은 factory가 직접 정리해야 하며, 다른 담당의 공유 연결을 잘못 닫지 않도록 소유권을 정해야 한다.

이 취소 신호와 DB commit을 하나로 원자화하지는 않는다. 마지막으로 관측한 상태·권한을 호출 및 채택 경계에서 확인하는 보장이다. 실행 중 직접 `profile.close()`를 호출해도 모든 백그라운드 응답을 정산한 다음 저장소가 닫힌다는 완전한 drain 보장은 없다. 늦은 사용량 정산 인수는 저장소가 열려 있는 조건을 사용하며, 이미 닫힌 저장소에 대한 정산 성공을 주장하지 않는다.

**프로필 종료는 세션 삭제가 아니다.** 같은 담당·사용자·허용된 채널의 세션으로 다시 접속하면 저장된 원문과 문맥을 이어 쓴다. CLI/Web의 `--session ID`와 새 대화 선택을 구분하고, 종료한 프로필 객체를 다시 실행에 쓰지 않는다.

## 이번 범위 밖

실제 모델/API 시험은 중단 상태다. 이번 조립만으로 사내 인증·SIEM/EDR·Knox나 실제 MCP 연결이 제공되지 않는다. 쓰기 도구와 외부 효과 복구, 동적 MCP 등록은 후속 범위이며 기존 관련 구현을 재사용한다. Windows native 연결·PostgreSQL·설치 패키지 공개 역시 이 사용법으로 완료되지 않는다.

실제 연결 위치: [일반 프로필](../../runtime/src/presentation/agent-turn-profile.ts), [CLI](../../runtime/src/presentation/agent-turn-cli.ts), [Web](../../runtime/src/presentation/agent-web.ts). 최종 빌드·시험 결과는 별도 C05 검증 기록으로 확인해야 한다.
