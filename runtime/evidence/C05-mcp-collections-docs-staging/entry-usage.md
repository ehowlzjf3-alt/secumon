# C05 — MCP 수집 일반 입구 사용법

@@MARKER@@
@@VERIFIED@@. 아래 코드는 호스트가 실제 API를 조립하는 구조 예시다. 이 예제 자체를 실행한 운영 연결 증거가 아니다. 실제 인수는 고정 합성 모델과 로컬 stdio peer를 사용했으며 [결과와 범위](@@ROOT@@/design/chapters/C05-mcp-collections-entry-result.md)에 기록했다.

## 호스트가 등록하는 것

호스트는 현재 C01 담당과 모델 등록 이름, 허용 정책, 도구 계약·원격 schema·projector·manifest를 정한다. 사용자 원문이나 HTTP 요청으로 실행 파일, 환경 변수, 권한, projector를 받지 않는다. `createMcpHostTools`는 신뢰된 호스트 코드가 호출한다. 임의 모듈 동적 로더나 사용자 설정만으로 실행 가능한 등록은 아니다.

`McpHostToolsOptions`는 공통 `bindings`, 선택적 `collectionBindings`, `policy`, `limits`와 실행 방식의 합집합이다. online은 `config: McpStdioConfig`를 받고 `mode`를 생략할 수 있다. 저장 전용은 `mode: 'stored_only'`와 `origin: {endpointId, protocolVersion}`을 받고 `config`는 받지 않는다. 하나의 등록은 한 endpoint/provider만 사용한다. 수집만 등록하려면 `bindings: []`와 비어 있지 않은 `collectionBindings`를 쓴다.

각 `McpReadCollectionBinding`에는 definition, remote, projectorId/projectorVersion, manifest, project가 필요하다. definition의 수집 계약과 현재 원격 schema가 일치해야 한다. 같은 ID의 다른 버전이나 원문 파일의 존재만으로 과거 계약을 임의 등록하지 않는다. 등록 배열·정책·한도는 복사·고정된다.

```ts
import { createMcpHostTools } from './dist/presentation/mcp-host-tools.js';
import { MCP_PROTOCOL_VERSION } from './dist/infrastructure/mcp-stdio-client.js';
import type { AgentExecutionHost } from './dist/presentation/host-tools.js';

// models, approvedPlainBindings, approvedCollectionBindings, policy, limits,
// stdioConfig는 시작 프로그램이 검증해 제공한 값이다.
const onlineHost: AgentExecutionHost = {
  models,
  tools: createMcpHostTools({
    mode: 'online', config: stdioConfig,
    bindings: approvedPlainBindings,
    collectionBindings: approvedCollectionBindings,
    policy, limits,
  }),
};
const storedHost: AgentExecutionHost = {
  models,
  tools: createMcpHostTools({
    mode: 'stored_only',
    origin: { endpointId: stdioConfig.endpointId, protocolVersion: MCP_PROTOCOL_VERSION },
    bindings: approvedPlainBindings,
    collectionBindings: approvedCollectionBindings,
    policy, limits,
  }),
};
```

위 import는 runtime에서 시작하는 호스트 TypeScript 코드의 구조 예시다. 미리 등록한 `models`의 이름은 담당의 `config.json`에 있는 `model.profile`과 일치해야 한다. `--provider registered`는 이 등록을 선택하며 등록이 없으면 거절한다. stored_only는 MCP peer를 열지 않는다는 뜻이다. 별도로 등록한 모델까지 네트워크 없이 실행된다는 보장은 아니다.

실제 일반 프로필은 `HostToolAssembly`로 같은 C01의 state/artifacts/digester/clock과 schema compiler, 수명 signal을 전달한다. 수집용 별도 DB를 열거나 저장소 소유를 도구 등록에 넘기지 않는다. 혼합 online 등록의 단순 읽기·수집은 한 발견 session을 공유한다. 저장 전용 등록은 client 생성·tools/list·tools/call을 하지 않는다. 원응답을 읽기 전에 현재 계약과 증명은 검증한다.

## CLI와 HTTP에서 재개하기

일반 CLI의 `runAgentTurnCli(args, host)`를 같은 담당·대화·업무 ID로 호출한다. CLI가 각 호출의 프로필을 닫는다. 등록된 모델의 compact를 사용하므로 registered에 `--compact-provider`를 덧붙이지 않는다.

```ts
import { runAgentTurnCli } from './dist/presentation/agent-turn-cli.js';

await runAgentTurnCli([
  'status', '--directory', agentDirectory, '--provider', 'registered',
  '--session', sessionId, '--work', workId, '--json',
], storedHost);
await runAgentTurnCli([
  'resume', '--directory', agentDirectory, '--provider', 'registered',
  '--session', sessionId, '--work', workId, '--json',
], storedHost);
```

status/history 조회는 실행 명령과 구분한다. 실행 재개는 만료된 원 실행권과 현재 업무·대화·담당을 검증한 뒤 저장 정산부터 이어 간다. 원래 owner를 바꾸거나 현재 거절된 사용자 원문을 일반 공개 요청으로 통과시키지 않는다. 같은 ID의 반복 재개는 원응답·원시도·정산·대화를 중복하지 않는다.

일반 Web은 같은 host를 `openAgentWeb(args, host)`에 전달한다. 브라우저·HTTP 요청은 기존 현재 session/work 검사와 Origin/CSRF 경계를 사용한다. 아래 서버 수명은 호출자가 소유하며 `close()`로 닫는다.

```ts
import { openAgentWeb } from './dist/presentation/agent-web.js';

const opened = await openAgentWeb([
  '--directory', agentDirectory, '--provider', 'registered',
  '--session', sessionId, '--port', '0',
], storedHost);
if (!opened) throw new Error('web_not_opened');
try {
  await hostOwnsServerLifetime(opened.server); // 호스트가 서버 사용 수명을 기다린다.
} finally {
  await opened.close();
}
```

`openAgentWeb.close()`는 서버 종료 뒤 프로필 자원을 닫는다. online registration은 자신이 연 MCP client를 닫고, 저장 전용 registration은 peer를 소유하지 않는다. 같은 C01 저장소는 프로필 수명에서 닫으며 등록 도구가 중복 닫지 않는다. 다른 담당의 발견·종료가 현재 담당의 세션을 대신하지 않는다.

## 완전한 저장 결과와 부분 결과

입력의 `readCollections[].resumeMode: 'stored_complete'`는 현재 검증된 완전 checkpoint를 소비할 수 있다는 모델용 안내다. 실행 권한이나 부모 성공 표시는 아니다. 모델은 원 query와 parent/head를 잇는 기존 `readResume` 후속 계획을 명시해야 한다. 저장 상태와 원문이 달라졌거나 계약·권한이 현재 유효하지 않으면 예약·실행·채택 단계에서 거절한다. marker 없는 구형 요청·응답 proof를 새 marker 때문에 무효화하지 않는다.

완전 후속은 저장 원문을 다시 검증해 로컬에서 소비한다. 논리 도구 호출 1회와 정상 회계는 유지하고 원격 fetch는 0회다. 원 부모는 failed 상태와 원 owner를 유지한다. 근거 ID 조회·요약·최종 답변은 별도 단계이며 새 모델 호출은 기존 modelCalls/tokens 예산을 따른다. 모델이 완료라고 말했다는 이유만으로 목표를 완료하지 않는다.

다음 페이지나 실패 항목 재요청이 필요한 부분 수집은 stored_only에서 `connection_required`로 기다린다. 반복 명령이나 marker로 online을 자동 선택하지 않는다. 호스트가 기존 프로필을 닫고 같은 endpoint/계약의 online host로 명시 재열기한 뒤 동일 업무를 재개한다. 현재 원 snapshot/cursor와 실패 항목을 다시 확인하며 성공한 부분을 전부 재호출하지 않는다. 업무와 무관한 실행 가능한 단계는 기존 제어 규칙에 따라 진행할 수 있다.

@@ENTRY@@

## 문맥과 반복 조회의 의미

@@IMPROVEMENTS@@ 실제 입력 한도를 다시 확인하며 필수 문맥과 원문을 생략하는 성능 우회는 없다. 근거의 표시 ID·시각을 바꾸거나 파생 사본을 다시 조회해 반복 제한을 풀지 못한다. 최초 유효 카드·본문 조회의 준비 진전은 업무 완성과 별개다.

@@NEXT@@ 이 사용법의 저장 결과 재개를 collection의 전송 후 권한 철회와 사용량 보존까지 검증한 것으로 확대하지 않는다. 전체 원문 검증과 반복 조회 비용은 [비용 검토](@@ROOT@@/design/chapters/C05-context-cost-review.md)에 남겼으며 이번에 실제 I/O·token·지연 절감률을 측정하지 않았다.

@@REMAINING@@ 전체 순서는 [MCP 계획](@@ROOT@@/design/chapters/C05-mcp-host-plan.md), 이번 구조와 남은 필수 단위는 [수집 일반 입구 계획](@@ROOT@@/design/chapters/C05-mcp-collections-entry-plan.md)을 따른다.
