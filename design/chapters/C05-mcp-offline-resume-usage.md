# MCP 서버 없이 저장 응답으로 재개하기

<!-- C05-MCP-OFFLINE-FINAL-PROOF: 28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9 -->
2026-09-07 · **지원 POSIX의 이번 단위 인수를 확인했다. macOS Node24 신규 145/145·관련 847/847, NAS Linux Node24 신규 145/145·관련 847/847·전체 3,601/3,601 통과.** C01 SQLite/file-journal에서 실제 로컬 stdio peer를 닫은 뒤 별도 CLI 자식 프로세스 2사례와 실제 localhost HTTP 4사례를 확인했다. HTTP는 저장 응답 복구·재열기와 미호출 작업의 연결 대기→명시 온라인 재열기를 각각 두 저장 방식에서 확인했다. 온라인 전환은 원 work/session/goal/plan/task를 보존하고 tools/call 한 번으로 완료하며, 같은 명령 재전송은 추가 호출·정산·답변을 만들지 않는다. 실제 브라우저 렌더링 시험은 아니다. [결과](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-result.md) · [계획](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-offline-resume-plan.md) · [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C05-mcp-offline-linux-nas-20260907/verification.json). 아래 TypeScript 예제는 설명용 조립이며 예제 자체를 별도 실행한 결과로 확대하지 않는다.

`stored_only`는 MCP 서버를 열지 않고 **같은 담당에 보관된 원응답·영수증을 검증하는 모드**다. 모델 연결을 끄는 설정이나 서버리스 배포를 뜻하지 않는다. 여기서 호스트는 에이전트를 실행하는 신뢰된 시작 프로그램이다.

## 시작 프로그램에서 모드 선택

[createMcpHostTools](../../runtime/src/presentation/mcp-host-tools.ts)는 다음 두 형식 중 하나를 받는다.

| 모드 | 필수 입력과 동작 |
|---|---|
| `mode: 'online'` 또는 mode 생략 | `config`, `bindings`, `policy`, `limits`. 실제 stdio 서버를 열고 도구 계약을 발견한다. `origin`은 함께 넣지 않는다. |
| `mode: 'stored_only'` | `origin: { endpointId, protocolVersion }`, `bindings`, `policy`, `limits`. 현재 호스트의 저장 전용 도구를 조립하며 MCP 클라이언트·서버 발견·새 호출은 만들지 않는다. `config`는 함께 넣지 않는다. |

다음은 `runtime/src/` 아래 시작 프로그램을 가정한 저장소 내부 import 예제다. `models`, `config`, `bindings`, 정책과 한도는 배치 프로그램이 미리 검토해 제공해야 한다. 실제 서비스 어댑터나 인증 설정은 이 예제가 제공하지 않는다.

```ts
import type { Policy, Limits } from './domain/model.js';
import type { AgentTurnHost } from './presentation/host-models.js';
import type { AgentExecutionHost } from './presentation/host-tools.js';
import type { McpReadBinding } from './infrastructure/mcp-read-tools.js';
import {
  MCP_PROTOCOL_VERSION, type McpStdioConfig,
} from './infrastructure/mcp-stdio-client.js';
import { createMcpHostTools } from './presentation/mcp-host-tools.js';

export function storedAndOnlineHosts(
  models: AgentTurnHost['models'], config: McpStdioConfig,
  bindings: readonly McpReadBinding[], policy: Policy, limits: Limits,
): { stored: AgentExecutionHost; online: AgentExecutionHost } {
  return {
    stored: { models, tools: createMcpHostTools({
      mode: 'stored_only',
      origin: { endpointId: config.endpointId, protocolVersion: MCP_PROTOCOL_VERSION },
      bindings, policy, limits,
    }) },
    online: { models, tools: createMcpHostTools({
      mode: 'online', config, bindings, policy, limits,
    }) },
  };
}
```

`origin`은 원래 MCP 연결의 식별자다. 프로토콜은 현재 클라이언트가 지원하는 `MCP_PROTOCOL_VERSION`을 사용하며, 지원하지 않는 값을 추측해 바꾸거나 자동 협상하지 않는다. 온라인 서버가 없거나 발견에 실패했다고 저장 전용 모드로 자동 전환하지도 않는다.

이는 **명시적 호스트 등록**이다. CLI 사용자나 HTTP 요청이 원격 실행 파일·계약·projector를 주입하는 새 옵션은 없다. 한 등록에는 한 endpoint·provider의 단순 읽기 binding을 넣는다. `policy.allowWrites`는 false여야 하며, `allowedTools`에 등록한 도구가 자동 추가되지는 않는다. 원 라벨을 낮추거나 예전 정책을 일반 실행 권한으로 재사용하지 않는다.

## 같은 담당의 CLI·Web에 전달

기존 [runAgentTurnCli](../../runtime/src/presentation/agent-turn-cli.ts)와 [openAgentWeb](../../runtime/src/presentation/agent-web.ts)에 위의 `stored` 또는 `online` 호스트를 전달한다. 담당 디렉터리의 `config.json`에 있는 `model.profile` 이름은 `models` 등록표와 일치해야 한다. 모드 전환을 위해 담당 ID·세션·업무 ID나 저장 디렉터리를 새로 만들지 않는다.

```ts
import type { AgentExecutionHost } from './presentation/host-tools.js';
import { runAgentTurnCli } from './presentation/agent-turn-cli.js';
import { openAgentWeb } from './presentation/agent-web.js';

export async function resumeSaved(
  directory: string, sessionId: string, workId: string, host: AgentExecutionHost,
) {
  // 함수에 직접 넘기는 인자에는 'chat' 접두사를 넣지 않는다.
  await runAgentTurnCli([
    'resume', '--directory', directory, '--provider', 'registered',
    '--session', sessionId, '--work', workId,
  ], host);
}

export function startSavedWeb(directory: string, host: AgentExecutionHost) {
  return openAgentWeb([
    '--directory', directory, '--provider', 'registered', '--port', '0',
  ], host); // 호출자가 반환된 app.close()를 종료 절차에 연결한다.
}
```

서버를 다시 사용할 때는 기존 프로필·Web 앱을 닫고 `online` 호스트로 같은 담당을 연다. 온라인에서는 실제 발견과 현재 계약 검사가 다시 필요하다. 등록 객체의 필드를 나중에 바꾸어 연결 상태를 변경하지 않는다. CLI는 호출 종료 시 프로필을 닫고, Web은 `close()`로 정리한다. 저장 전용 도구가 C01 저장소를 직접 닫지는 않으며 프로필 종료는 세션 삭제가 아니다.

## 원응답 재개와 새 실행의 차이

- **같은 binding·정확한 버전이 필요하다.** remote 이름·스키마, projector ID·버전, endpoint·프로토콜로 만든 버전과 전체 definition 지문을 원 호출과 대조한다. 기본 버전 문자열만 맞추거나 과거 파일에서 미등록 계약을 자동 복원하지 않는다. projector 의미가 바뀌면 호스트가 그 버전을 올려야 한다.
- 공식 dispatch·intent·response 영수증과 원문 바이트가 있으면 기존 검증 경로를 사용한다. 원문은 SDK가 해석한 MCP 응답 JSON이다. 파일만 남았거나 intent만 있는 상태를 디렉터리 탐색·재호출로 복구하지 않는다.
- 입증된 원 호출의 **사용량 정산과 지금 본문을 읽거나 근거로 채택하는 것은 별개**다. 원문·소유자·삭제 세대·현재 권한·목표·출처 검사를 유지한다. 취소·명시 실패·후속 시도로 확정된 결과를 되살리지 않으며, 이미 알려진 사용량은 반복 합산하지 않는다. 상태·이력 조회 자체가 정산 명령으로 바뀌지는 않는다.
- 저장 전용 계약은 보관 증명에 남지만 새 모델 호출 목록과 도구 검색의 실행 후보에서는 빠진다. 같은 id/version의 직접 catalog 조회나 새 reserve/dispatch도 실행 허가를 주지 않는다. 허용된 내장 원문 조회 도구와 다른 독립 작업은 별개다.
- 새 읽기가 필요한 준비된 작업은 `wait`, `reason: 'connection_required'`로 기다린다. 새 시도·논리 호출을 추가하지 않는다. 이미 만들어진 **미송신 예약은 원 owner·lease까지 유지**하며, lease가 만료되면 기존 회수 규칙으로 예약분을 돌려준다. 연결 대기를 nonretryable 실패로 바꾸어 작업의 재시도 기회를 소비하지 않는다. 이미 송신한 호출의 기록을 소급 지우거나 기존 예산·마감을 초기화하지 않는다.

`lease`는 기존 시도에 부여한 유효 시간이다. 저장 원응답 처리와 사용량 보완을 먼저 확인한 뒤, 필요한 대화 정리·문맥 복원·이후 작업으로 이어가는 기존 순서를 사용한다. 권한이나 원 사용자 요청을 읽을 수 없으면 단순 연결 대기로 숨기지 않고 해당 검증 오류를 유지한다.

다음 후보는 collection(여러 항목 수집)·페이지·대기의 일반 입구 연결이다. 검토 메모를 준비했으며 제품은 미착수다. 문맥 조회 비용 개선도 현재성 검사를 유지하며 별도 측정·인수한다. [후속 연결 메모](/Users/seunghanee/Documents/secumon/design/chapters/C05-mcp-collections-entry-notes.md) · [비용 검토](/Users/seunghanee/Documents/secumon/design/chapters/C05-context-cost-review.md). C05 전체와 C01~C10 전체 goal은 미완료다. 실제 모델/API 시험은 중단 상태이며 모델 의미 품질·사용량·취소·tokenizer 적합성, 사내 MCP·Knox·운영 배포는 미검증이다. native Windows runtime/file의 미구현·미연결 부분과 검증, PostgreSQL 구현·검증도 남아 있다. 설치 패키지의 공개 exports는 C10 후속이다.

이전 사용법 초안의 검증 대기 문장(당시 기록): 일반 CLI·HTTP가 이 조건을 끝까지 지키는지는 이번 단위 인수에서 확인할 사항이다. collection·페이지·대기 도구의 일반 오프라인 재개, 실제 모델/API와 사내 서비스, Windows native 연결, PostgreSQL 구현·검증은 완료하지 않았다. 실제 모델/API 시험은 중단 상태다. 설치 패키지의 공개 exports는 C10 후속이며, C05 전체와 전체 goal도 미완료다.
