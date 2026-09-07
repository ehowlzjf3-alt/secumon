# C05: 요청별 decoded 응답 캡처 계약 제안

2026-09-07 · [전송 뒤 권한 변경 계획](../../design/chapters/C05-mcp-sent-authority-plan.md)의 첫 단계만 구체화한 미구현 노트다. 제품·시험은 변경하거나 실행하지 않았다. 현재 Linux 검증 결과를 선반영하지 않는다.

**권고: 기존 `call`에 선택적 동기 관측 콜백을 추가한다.** 정상 `McpReply`, 기존 `McpCallError(code, sent)` 생성, `ports.ts`의 `Tool.execute/authorize`, envelope v1은 그대로 유지한다. 새 결과 API나 별도 수신 worker는 만들지 않는다. 다음 선언은 `infrastructure/mcp-stdio-client.ts`에만 추가할 계약 초안이다.

```ts
export interface McpDecodedResponse {
  readonly session: Readonly<McpSession>;
  readonly requestDigest: string; // digest({ session, name, input })
  readonly observedAt: number;    // SDK await 직후의 호스트 clock 관측값
  readonly json: string;          // 검증된 SDK decoded value의 JSON, wire bytes 아님
  readonly byteLength: number;    // json의 UTF-8 byte 수
  readonly transportCalls: 0 | 1; // 기존 로컬 send 경계 진입 횟수
}
export interface McpCallContext {
  signal: AbortSignal;
  authorize: () => Promise<void>;
  capture?: {
    now(): number;
    decoded(value: Readonly<McpDecodedResponse>): undefined;
  };
}
export type McpCallStage =
  | 'request' | 'response_validation' | 'capture' | 'post_response';
export type McpCallErrorOptions = ErrorOptions & {
  stage?: McpCallStage;
  cleanupError?: unknown;
};
// McpCallError(code: string, sent: boolean, options?: McpCallErrorOptions)
// super(code, options); stage/cleanupError는 제공된 경우에만 보존한다.
// call(session, name, input, context: McpCallContext): Promise<McpReply>
```

현재 [call의 SDK await 뒤](../src/infrastructure/mcp-stdio-client.ts:217)에만 연결한다. `capture`의 함수와 수신자를 call 진입 시 고정하고, 기존의 요청 입력/session 사본과 requestDigest를 그 호출의 지역 변수로 유지한다. SDK await가 resolve된 직후 첫 다른 await 전에 `capture.now()`를 읽는다. 값은 음이 아닌 safe integer여야 하며, 기존 `services.clock.now()`를 호스트가 제공한다. 임의 `Date.now()`와 혼합하거나 v1 `recordedAt`을 이 시각으로 소급 해석하지 않는다.

이어서 기존 `JsonSchema.parse`로 JSON 값만 허용하고 직렬화한 UTF-8 bytes가 `maxMessageBytes` 안인지 확인한다. generic JSON 검증은 업무 결과의 의미 검증이 아니다. 유효한 경우에만 session 사본과 관측 객체를 동결하여 `capture.decoded`를 **한 번 동기 호출**한 뒤 기존 `check(captured, budget.signal)`을 그대로 수행한다. JSON 문자열은 immutable이라 호출자가 본문을 변조할 수 없다. 검증 전·초과 크기 본문은 콜백에 넘기지 않는다. 콜백은 지역 변수 보관만 맡는다. 반환형을 `undefined`로 두어 TypeScript의 `void` 자리에 async 함수가 들어가는 것을 막고, 실행 시에도 반환값을 검사하며 await하지 않는다. 콜백 실패도 정상 응답으로 바꾸지 않는다.

| 경계 | 호출자에게 남길 사실 |
|---|---|
| SDK request reject (`request`) | 캡처 0회. 원 cause와 실제 dispatch.sent를 보존. 나중 응답을 기다리거나 내용을 추측하지 않음. |
| SDK resolve 후 JSON/크기 실패 (`response_validation`) | 캡처 0회. 응답값을 받았으나 보관 조건을 충족하지 못함. 기존 크기 오류 의미 유지. |
| 관측 시각/콜백 실패 (`capture`) | 해당 원 cause 보존. 콜백이 throw하면 호출 성공 아님. |
| 유효 캡처 후 세션/abort 검사 실패 (`post_response`) | 지역 캡처는 남지만 call은 기존처럼 실패. 반환받은 원문이 현재 사용 가능한 답변이라는 뜻은 아님. |
| 위 실패와 shutdown 실패가 겹침 | 기존 외부 `mcp_close_unconfirmed` code와 sent는 유지하되, `cause`에 최초 오류, `cleanupError`에 종료 오류를 함께 둠. 캡처를 지우지 않음. |

SDK reject 뒤의 `sent=true`는 전송되었을 가능성이 있는 로컬 시도이며 write 성공·원격 실행·과금 증명이 아니다. 일반 임의 예외를 새 측정값 0/1로 승격하지 않는다. 여러 call의 캡처·오류·close 영향은 각 지역 변수에 남기고 공유 `lastReply`를 두지 않는다. 관측 콜백은 post-check 전에 실행되므로 모델·도구 응답·로그/UI 전달용으로 노출하지 않는다.

후속 `mcp-read-tools.execute`는 `let captured`와 `capture: { now: () => services.clock.now(), decoded: value => { captured = value; } }`를 호출에 전달하고 requestDigest/session을 재대조할 수 있다. **첫 단계에서는 이를 영속 저장하거나 현재 authorize를 우회하지 않는다.** 보관 권한·별도 사용량 증명·lifecycle·response receipt·close 전 유한 정산은 다음 단계에서 연결한다. 최소 회귀는 post-check 취소/세대 변경 뒤 캡처 유지, SDK reject 캡처 없음, 한도/비정상 JSON, 서로 다른 동시 두 요청의 귀속, 최초 오류+close 오류 보존이다.
