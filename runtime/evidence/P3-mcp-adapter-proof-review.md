# P3-01 MCP 원본·proof·호출 권한 독립 검토

2026-09-06 · 현재 저장된 source와 시험을 읽은 검토다. 제품·시험·dist를 수정하거나 build, 시험, MCP 서버, 모델, 외부 서비스를 실행하지 않았다. 아래 정상 경로 확인은 실행 통과 주장이 아니다.

검토 범위는 `src/infrastructure/mcp-read-tools.ts`, `src/application/tool-broker.ts`, `src/application/ports.ts`와 직접 연결되는 receipt/receive/adopt/resource 검증이다. 종료 보완은 `src/infrastructure/mcp-stdio-client.ts`의 해당 부분만 재확인했다. StateRepository의 canonical state/receipt 무결성과 호스트가 승인한 binding/projector는 기존 신뢰 경계다.

## 발견 한 건과 수정 확인

**원 policy 확대가 최종 authorize에서 사라져 호출 후에야 응답을 거절할 수 있다.** [ToolBroker.authorize](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-broker.ts:59)는 `authorizedWork(..., dispatched.state.policy)`가 반환한 정책을 비교한다. 이 함수는 현재 canonical policy의 allowedLabels/allowedTools/allowedDestinations를 dispatch 당시 권한과 교집합으로 좁힌다. 따라서 `mcp-intent` commit 후 adapter가 기다리는 동안 canonical policy에 허용 label/tool/destination만 추가하면, 축소한 정책 digest는 기존 값과 같을 수 있다. 마지막 전송 검사가 이를 통과하는 반면 [MCP response guard](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-read-tools.ts:134)는 canonical policy 전체가 dispatch policy와 같아야 한다고 요구하므로 이미 호출한 뒤 응답 저장을 거절한다.

이는 권한 확대를 이용한 권한 초과 주장이 아니다. 계획의 정책 변경 시 전송 차단 조건과, adapter가 사용하는 입력·출력 policy pin 사이의 불일치다. 기존 disclosure policy가 없는 지원 경로에서 현재 `mcp-read-tools.test.ts` fixture 그대로 성립하며, disclosure가 있어도 allowedTools/allowedDestinations만 확대하는 경우 별도 확인이 필요하다.

최소 보완은 canonical policy digest를 dispatch/entry 기준과 비교하는 검사와 읽기 actor의 권한 축소를 구분하는 것이다. 마지막 비동기 검사 이후의 canonical revision 검사도 유지해야 한다. 두 backend의 기존 slowClient wait 시험을 재사용해 intent 저장 뒤 allowedLabels 또는 allowedTools를 하나 추가하고 실제 MCP tool 전송 0, 원본 response 미게시를 단언하는 회귀를 권한다. 이 검토에서는 실행 재현하지 않았다.

**수정 source 재확인: 해소됨.** 루트는 Broker.authorize 시작에서 raw state를 별도로 읽어 filtered current와 revision이 같은지, raw policy digest가 dispatch policy와 정확히 같은지 검사하도록 추가했다. 최종 revision 재검사도 유지한다. 양 backend의 wait 중 `expand-labels` 회귀가 저장된 것을 확인했다. 실행 결과는 이 검토에서 확인하지 않았다. 아래 정상 경로 설명은 이 수정 후 source를 기준으로 한다.

## 읽기 기준으로 유지된 경계

- [별도 response transaction](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-read-tools.ts:157)은 원본 envelope를 work.artifacts에 등록한다. 실패 ToolResult는 evidence/artifacts가 빈 배열이고 output도 비어 있다. 따라서 원본 보존과 실패의 근거 승격을 분리한다.
- [readProof](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-read-tools.ts:93)는 dispatch·intent·response receipt, response receipt 당시 마지막 ref, response digest, 현재 index/tenant/labels/blocked 상태, raw byteLength/SHA256, goal/policy/generation 및 task/contract/binding pin을 확인한다. 마지막으로 같은 host projector에서 재계산한 ToolResult를 비교한다. SDK나 MCP 서버를 재호출하는 경로는 없다.
- [binding version](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-read-tools.ts:49)은 remote schema, projector ID/version, endpoint 및 protocol을 반영한다. host definition 전체는 별도 contractDigest로 고정한다. handler 코드 자체의 불변성을 attest하지는 않으며, 의미가 바뀌면 호스트가 projectorVersion을 올리는 계약이다.
- wrapper가 SDK-decoded value의 `resultType` 부재를 허용하는 수정은 설치된 2.0.0 SDK decoder와 일치한다. decoder는 wire의 `resultType` 존재·complete 및 wire schema를 먼저 검사한 뒤 반환 객체에서 그 필드를 삭제한다. 따라서 wrapper의 absent 허용을 wire의 누락 discriminator 허용으로 해석하지 않는다. 명시된 다른 resultType은 계속 거절한다.
- intent는 실제 호출 전에 CAS로 기록되고, 같은 attempt의 기존 intent 또는 duplicate receipt가 있으면 새 call로 진행하지 않는다. ACK 유실 뒤 원격 재실행을 자동 허용하지 않는다.
- [새 authorize 포트](/Users/seunghanee/Documents/secumon/runtime/src/application/ports.ts:85)는 원격 전송과 policy 변경의 전역 원자성을 주장하지 않는다. Broker는 adapter 내부 대기 후에도 owner/status/task/goal/plan/generation/lease/budget/knowledge/effect/현재 tool entry와 disclosure를 다시 검사하도록 제공한다.
- 일반 receive/adopt는 custom validator를 호출하고, artifact 저장·commit 전 다시 검사한다. calls 복사 조회와 context source 검증에도 ToolContracts.validateResult가 연결되어 있다. lifecycle generation 변경과 blocked/denied ref는 MCP proof에서 거절한다.
- [종료 보완](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-stdio-client.ts:96)은 시작 시 보관한 owned pid를 사용해 SDK close 이후 ESRCH를 기다린다. 최대 2초 안에 확인하지 못하면 `mcp_close_unconfirmed`이고 확인한 뒤에만 processCloses를 증가시킨다. 앞 검토의 snapshot-only 종료 판단 문제를 source 기준으로 보완했다. 실제 종료 성공 여부는 담당 실행 로그로 확인해야 한다.

## 현재 시험에서 구분할 남은 확인

1. 현재 MCP 통합 시험의 pause는 실제 wire 전송 전 대기 구간이다. wire 진입 후 응답을 기다릴 때 cancel/goal/policy/generation 변경, artifact.put 도중 변경을 별도로 묶어 원본 response receipt 미게시·근거 미채택·숨은 재호출 0을 확인하면 원본 저장 guard를 직접 검증할 수 있다. raw artifact가 put 후 CAS 실패로 남은 경우에는 indexed/published 원본과 미게시 artifact를 구분한다.
2. label 철회, lifecycle generation 증가, 원본 삭제 및 host projector version/definition 교체 후 proof/copy 거절을 현재 MCP fixture로 확인할 수 있다. 기존 시험에는 raw 변조·다른 attempt·다른 projected facts·partial·동일 lineage 대조가 있지만 이 조합은 아직 보이지 않는다. 미실행 항목을 기존 generic 시험 통과로 대체했다고 기록하지 않는다.
3. 현재 `reopen` helper는 두 state backend와 ExecutionRuntime을 다시 열지만 메모리의 ToolContracts와 adapter 객체는 유지한다. 따라서 검증 주장은 **저장소 재개와 서버를 끈 상태의 동일 host validator 재검증**이다. 프로세스 전체 재시작 후 registry/binding을 새로 구성한 offline 복원을 검증한 것으로 표현하지 않는다. 그 범위가 필요하면 새 registry/adapter를 사용하고 tools/list와 tools/call이 모두 0임을 따로 확인한다.

위 정책 pin 불일치의 수정 후, 이번 읽기 범위에서 남은 확정적인 proof 위조·원본 label 완화·실패 근거 승격 결함을 확인하지 못했다. 원본 변조 후 adopt가 `artifact_unavailable`로 throw하는 시험 기대도 기존 commitWithArtifacts가 손상된 indexed 원본을 포함한 정산 commit을 거절하는 계약과 일치한다. 이를 원본 복구 성공으로 표시하지 않는다. 내부 MCP, HTTP/OAuth, 쓰기 효과, 자동 ReadCollections 재개 또는 모델의 실제 수행은 이 검토 범위가 아니다.
