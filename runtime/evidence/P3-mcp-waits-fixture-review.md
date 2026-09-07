# MCP rate-limit 대기: fixture·adapter 설계 검토

작성 기준: 2026-09-06, v0.40의 2,040개 시험 기록을 보존한 상태에서 읽기만 수행했다. 이 문서는 다음 소단위의 제안이며 구현·실행 결과가 아니다. 제품 소스, 기존 fixture, 검증 기록은 변경하지 않았다. SDK 설치·서버 실행·모델·사내 서비스·외부 API·키 접근을 하지 않았다.

## 결론

**서버의 rate-limit 힌트를 호스트가 승인한 binding에서만 해석하고, 원응답에 결합된 `notBefore`를 한 번 기록하는 방식**을 권한다. 대기는 성공한 자료나 완료 근거가 아니며 재시도 권한도 아니다. 시간이 되었다는 사실은 명시적인 read resume의 자격 하나만 충족한다. 실제 새 호출에는 현재 권한, 원자료 proof, 남은 호출 수와 최초 deadline을 다시 검사해야 한다.

v0.40의 두 helper는 보존하고 별도 wait fixture/contracts를 추가하는 편이 좋다. 기존 raw schema에 필드를 소급해서 넣으면 binding digest와 과거 raw→page proof의 의미가 바뀐다. 기본 동작을 유지하는 조건부 확장도 가능하지만, 버전별 schema·mapper·실행 파일 선택을 모두 분리해야 하므로 이번 작은 학습 단위에서는 이점이 적다.

## 설치된 공식 SDK에서 확인한 범위

검토 대상은 설치된 `@modelcontextprotocol/{core,client,server}` 2.0.0과 현재 pin인 `2026-07-28`이다. 외부 문서를 조회하지 않았으므로 이후 표준 개정이나 다른 SDK까지 일반화하지 않는다.

| 관찰 | 설계에 주는 의미 |
| --- | --- |
| core의 `ResultMetaObjectSchema`는 구현별 `_meta` 키를 통과시키는 loose object다. | namespaced 힌트를 운반할 수 있다. 키가 존재한다고 scheduler가 실행해도 된다는 뜻은 아니다. |
| core와 modern wire의 `CallToolResultSchema`는 `structuredContent`와 `isError`를 각각 허용한다. | strict하게 광고한 도구별 output schema 안에 버전이 있는 rate-limit 데이터를 실을 수 있다. 두 필드가 공존하는 것 자체는 프로토콜에 어긋나지 않는다. |
| 검토한 schema·공개 타입·README에서 tools/call의 공식 `retryAfter`, `retry_after`, `Retry-After` 필드를 찾지 못했다. | 이번 단위는 공식 retry scheduling 기능의 연결이 아니라 호스트가 검토한 응답 계약이다. |
| client의 `TooManyRequests`는 OAuthErrorCode 안에 있고 주석도 custom/non-standard라고 한다. `SdkHttpError`는 non-OK HTTP transport 응답용이다. | stdio 도구 호출의 rate-limit 힌트로 추정하지 않는다. HTTP 429 처리까지 검증했다고 말할 수 없다. |
| server의 `validateToolOutput`은 `result.isError`이면 검증을 건너뛴다. | whole-tool 오류의 structuredContent는 **호스트에서 반드시 별도로 검증**해야 한다. 서버 SDK가 출력 계약을 보증한다고 가정하면 안 된다. |

근거: [core README](../node_modules/@modelcontextprotocol/core/README.md), [core schema](../node_modules/@modelcontextprotocol/core/dist/auth-CUe6YdwF.mjs), [client modern wire schema](../node_modules/@modelcontextprotocol/client/dist/src-D_zzAWoS.mjs), [client 오류 타입](../node_modules/@modelcontextprotocol/client/dist/index-D4xIIEF6.d.mts), [server output 검증](../node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs). 배포된 bundle 파일명은 설치 버전에 종속된다.

## 현재 adapter와 연결할 때 필요한 변화

[mcp-read-collections.ts](../src/infrastructure/mcp-read-collections.ts)의 `projectPage`는 현재 `isError:true`를 mapper 호출 전에 거절한다. 원응답 envelope에는 request·intent head·binding·goal/policy·generation·기록 시각이 보존되지만, binding의 `project`는 structuredContent만 받는다. 따라서 오류 문자열을 파싱해서 우회하기보다 다음 두 분기를 명시적으로 분리해야 한다.

- 정상 page: 기존 raw→page proof와 host manifest/lineage 검사를 유지한다. rate-limit 항목은 미완료로 남기고 Evidence를 만들지 않는다.
- 검토된 whole-tool wait: 명시적으로 opt-in한 binding만 raw envelope의 `isError`와 별도 오류 schema를 함께 검사한다. 가짜 빈 ReadPage를 만들지 않고 proof가 있는 대기 결과로 반환한다.

`McpStdioClient.call`의 일반 protocol/transport 실패는 현재 고정 오류로 좁혀진다. timeout, crash, HTTP처럼 보이는 문구, 자유 형식 text에 “429”가 있다는 이유로 대기를 만들지 않는다. 판별 가능한 새 structuredContent가 없으면 기존의 오류/불확실 경로를 유지한다. 사내 서버가 이 계약을 지원한다는 가정은 없다.

[domain/control.ts](../src/domain/control.ts)의 `Obligation.dueAt`은 해당 시각에 도달하면 `obligation_overdue`로 차단되는 **기한**이다. 이를 재시도 가능 시각으로 그대로 사용하면 의미가 반대가 된다. 또한 현재의 `retryWakeAt`/진행 실패 backoff에는 개별 원응답·source request proof가 없다. 표시용 wake 시각을 재사용하더라도 권위 있는 값은 별도의 검증된 read wait 기록이어야 한다.

## 권장 raw 계약

첫 단위는 **structuredContent 하나를 canonical 경로로 선택**한다. `_meta` 방식은 회사별 호환 adapter를 검토할 때 추가할 수 있으나 자동 fallback은 넣지 않는다. MCP 예약 namespace에 프로젝트 전용 의미를 넣지 않는다.

새 fixture의 whole-tool 응답 예:

```ts
{
  isError: true,
  content: [{ type: 'text', text: 'fixture_rate_limited' }],
  structuredContent: {
    version: 2,
    kind: 'rate_limit',
    dataset: 'documents-v1',
    requestId: '<현재 read request ID>',
    cursor: null,
    snapshot: null,
    retryAfterMs: 2500
  }
}
```

`cursor`와 nullable `snapshot`은 **현재 요청의 값을 정확히 되돌려 준다**. whole-tool wait가 새 데이터 snapshot을 확정하거나 cursor를 진행시키지 않는다. 적용 대상은 그 요청 전체이며 서버가 임의 work ID, item inputDigest, host deadline 또는 wakeAt을 지정하지 않는다. 요청/응답/정규화 대기의 관계는 호스트 raw envelope에 묶는다.

정상 page는 별도의 `version:2, kind:'page'` branch로 두고 기존 page metadata/records 구조를 유지한다. 항목 오류는 다음처럼 제한한다.

```ts
{ outcome: 'error', record: null,
  error: { code: 'rate_limited', retryable: true, retryAfterMs: 2500 } }
```

host output schema는 모든 object를 strict로 하고 page/wait branch를 분리한다. `isError:true`+page 또는 `isError:false`+rate_limit은 거절한다. 항목 wait는 `error/rate_limited/retryable:true/record:null` 조합만 허용하며 성공 기록에 대기 힌트를 붙이는 것을 거절한다. 일반 temporary·forbidden의 error branch에 retryAfterMs를 허용하지 않는다.

지연 값은 밀리초 단위의 양의 safe integer로 제한한다. 예제 상한은 host policy의 60,000ms처럼 작게 고정할 수 있으며 이것은 MCP 표준 상한이 아니다. 0, 음수, 소수, 숫자 문자열, boolean/null, 과대값, 알 수 없는 단위, 시각 덧셈 overflow를 거절한다. `Infinity`/`NaN`은 JSON wire로 표현할 수 없으므로 mapper/schema 단위 부정 입력과 실제 wire malformed 사례를 구분한다. 상한이나 최초 deadline을 넘는 값을 더 이른 시각으로 clamp하여 재시도하지 않는다.

별도 binding에서 `_meta`를 지원한다면 정확한 검토 namespace/버전/strict schema만 허용한다. 그 binding에서 같은 힌트를 두 canonical 위치에 동시에 보내거나 전체/항목 힌트가 충돌하면 거절한다. 그 외 임의 metadata/text는 실행 권한으로 승격하지 않는다. 이번 fixture의 기본 경로에서는 `_meta`의 retry처럼 보이는 내용만으로 대기를 만들지 않는 부정 대조가 충분하다.

## 영속 시각·예산·재개

1. 현재 request에 대한 응답을 받고 권한을 확인한 뒤 host 기록 시각을 한 번 정한다. 기존 envelope의 `recordedAt`을 원점으로 쓰면 이는 네트워크 첫 바이트 시각이 아니라 **호스트가 응답을 기록한 시각**이다. `notBefore = recordedAt + retryAfterMs`와 원본 ref/digest를 같은 대기 관계에 저장한다.
2. 같은 raw/receipt를 재검증하거나 compact·restore·store reopen할 때 `now + retryAfterMs`로 다시 계산하지 않는다. 동일 응답 중복 게시가 시각·deadline·호출 예산·wait allowance를 초기화하면 안 된다.
3. 새 정당한 원격 호출이 다시 rate-limit이면 새 request/receipt에 근거한 다음 대기를 만들 수 있다. 처음부터 이어지는 maxCalls, 최초 deadline, 누적 대기/대기 횟수 한도를 유지한다. 단순 polling/새 planner task로 초기화하지 않는다.
4. 도달 전에는 model call 0, tools/call 0이다. 도달 후에도 자동 반복 루프를 숨기지 않는다. host scheduler의 명시 wake 처리나 승인된 `readResume`가 현재 상태를 확인하여 새 request를 예약한다. 시간 알림 자체는 실행 권한이 아니다. 대기 중 장기 MCP RPC나 worker lease를 붙잡고 sleep하는 구조는 피한다.
5. 현재 core는 같은 부분 페이지의 **모든 미완료 항목을 함께 재조회**한다. 항목별 notBefore가 다르면 전체 재조회는 최대값까지 기다려야 한다. 최소값에 깨워 나머지를 먼저 재시도해서는 안 된다. 더 이른 항목만 분리 실행하려면 별도 subset-resume 계약이 필요하다. forbidden 항목을 rate-limit 대기로 숨기지 않는다.
6. 처음 실행 시 사용한 source snapshot/cursor/manifest와 성공한 prefix는 보존한다. 대기 자체는 page 수, coverage, evidence 또는 source 독립성의 증가가 아니다. 실제 시도한 tools/call은 rate-limit 응답이어도 소비한 호출 수에 포함한다.
7. 재시작 후 시계 비교는 core가 정한 host clock 의미를 따른다. 가상 clock 회귀가 실제 시스템 시계 보정/NTP에 대한 보장을 검증한 것으로 표현하지 않는다.

대기의 보호 참조에는 원 attempt·원 request·intent head·response receipt/raw artifact·정규화 mapper/binding·goal/policy/generation·대상 pending IDs가 필요하다. 모델에는 필요한 업무 상태와 재개 가능 시각만 명시 projection한다. 원격 text, 과거 raw 응답 또는 임의 지시를 자동으로 복사하지 않는다.

## 현재 권한과 proof 소비 경계

- 받은 응답이라도 authorize/CAS 시점에 goal·policy·pause/cancel·generation·head가 바뀌면 새 대기를 게시하지 않는다. 오래된 응답으로 현재 작업의 시각을 바꾸지 않는다.
- wake 이후 실제 전송 직전에도 기존 authorize callback을 사용한다. 재접속한 새 MCP 세션의 도구 목록과 binding 승인이 필요하다. 과거 raw 검증에 live 세션이 필요한 것은 아니다.
- 저장 raw/receipt가 삭제·변조되거나 읽기 권한이 철회되면 대기를 unavailable/blocked로 처리한다. proof를 잃었다는 이유로 wait를 제거하고 일찍 호출해서는 안 된다. 조회·resume·result 검증에서 같은 원본 관계를 확인한다.
- 이미 확인된 성공 prefix를 유지하되, 근거가 사라진 결과를 그대로 채택하지 않는다. 새 request가 이전 성공 item을 재전송하거나 다른 query/snapshot으로 대체하는 것은 기존 경계대로 거절한다.
- 대기 저장 전 종료되어 durable wait가 없는 경우를 자동으로 “rate-limit 확인됨”이라 하지 않는다. v0.40의 intent/unknown 및 명시 resume 계약을 유지하고, 고아 원응답의 정산은 별도 범위로 남긴다.

## fixture와 회귀 권장안

새 `mcp-wait-fixture-contracts.ts` / `mcp-wait-fixture-server.ts`를 권한다. v0.40 [contracts](../src/tests/helpers/mcp-collection-fixture-contracts.ts)·[server](../src/tests/helpers/mcp-collection-fixture-server.ts)는 유지한다. 유한 ID a–d, 문서/관측 원자료 값·source lineage·snapshot 의미는 그대로 재사용할 수 있지만 새 output schema와 mapper version은 별도로 고정한다. audit는 host tmpdir에만 쓰고 stdout은 프로토콜만 출력한다.

기본 mode는 normal, whole-rate-limit, item-rate-limit, malformed, conflicting, late 정도면 충분하다. 원격 대기 테스트 때문에 실제로 수 초 sleep하지 않는다. 정상 응답으로 바꾸는 조건은 host가 관리하는 새 peer mode 또는 명시 fixture control로 정하고 audit에 남긴다. 재접속 때마다 초기 오류 횟수를 리셋하는 메모리 counter로 복구 성공을 우연히 만들지 않는다. late-response 취소 시험만 짧고 한도가 있는 전송 지연을 별도로 사용한다.

| 축 | 핵심 대조와 관측 |
| --- | --- |
| whole-tool 오류 | 검토된 wait branch만 대기로 기록; 자유 text 오류·기존 v0.40 rate-limit은 임의 자동 대기/성공으로 승격되지 않음; 페이지/Evidence 추가 0 |
| 항목 부분 결과 | A 성공/B rate-limit 후 A의 body·시각·Evidence 불변; B만 재조회; 같은 snapshot·cursor·total 유지; 서로 다른 지연 두 개는 최대 시각까지 호출 0 |
| 입력 부정 대조 | 단위/타입/범위/overflow, missing field, 부정 isError 조합, 성공+hint, retryable=false+hint, 요청 ID/cursor/snapshot mismatch를 거절 |
| 중복·충돌 | 같은 receipt 재독해 시 notBefore 불변; 등록된 두 hint 위치 또는 whole/item 모순 거절; 알 수 없는 `_meta`/text는 authority 아님 |
| 고정 원점 | clock 1,000에서 delay 5,000 수신 → notBefore 6,000; 2,000에서 reopen/compact해도 6,000; 5,999에서 RPC/model 0; 6,000 이후 명시 resume만 새 request |
| 반복 대기·한도 | 다음 실제 응답의 대기는 새 receipt; 최초 deadline/call budget/누적 대기 한도 유지; deadline 이상 wake는 추가 RPC 없이 정지; old/new attempt로 우회 금지 |
| fresh 응답·권한 | 응답 이전/이후 권한 철회 및 다른 runtime의 pause/cancel/goal 변경; stale reply가 wait 게시 못 함; wake 후 전송 직전 철회는 tools/call 0 |
| proof 손실 | 같은 work revision에서 raw/receipt 삭제·변조 후 restore/resume 차단; wait 제거 후 조기 재조회 0; 현재 독자 권한 축소도 대조 |
| 재시작 | 양 저장소 reopen + 새 client/peer에서 원 시각/성공 prefix/남은 예산 보존; reopen 자체 RPC 0; 필요한 실제 worker SIGKILL 한 단계는 별도 소유 프로세스만 종료 |
| 늦은 응답 | cancel/lease 만료 이후 지연 응답이 새 wait/성공 근거를 게시하지 않음; audit handler-ready와 response-sent, host 수락을 서로 구분 |

최종 기록에는 실제 tools/call, SDK session/프로토콜 호출, 대기 결정 수, 명시 resume 수, virtual clock 이동과 실제 지연을 나누어 쓴다. fixture audit만으로 일반적인 외부 네트워크 부재를 증명하지 않는다. MCP SDK의 stdio 운반·호스트 대기 계약을 시험할 수 있지만 사내 서버 지원, 실제 API rate-limit 정책, 모델 품질, 운영 스케줄러 가용성을 검증한 것은 아니다.

참고 baseline: [v0.40 local verification](P3-mcp-collections-local-verification.json), [기존 adapter 검토](P3-mcp-collections-adapter-review.md), [기존 fixture 설계](P3-mcp-collections-fixture-review.md). 이 검토는 baseline 2,040개 시험을 재실행하거나 현재 상태에서 다시 통과했다고 선언하지 않는다.
