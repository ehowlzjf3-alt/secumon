# C05 collection MCP — 응답 뒤 보관·사용량 후속 경계 검토

읽기 검토만 수행했다. 현재 collection 입구 단위의 완료 범위에 추가하는 요구가 아니라 **명시적으로 유보된 다음 단위**다. 부모가 보고한 현 상태는 교정 후 신규 41/41 통과, 관련 회귀 실행 중이다. 이 메모는 새 실행·재현·Linux 최종 통과를 주장하지 않는다. 제품·시험·staging은 변경하지 않았다.

## 확인한 누락

- `src/infrastructure/mcp-read-collections.ts:208–210`: `client.call`에 request-local `capture`를 전달하지 않고, 정상 반환 또는 오류를 받은 직후 `await authorize()`를 실행한다. 이때 취소·현재 권한/정책·목표·lease 등이 바뀌면 이미 반환받은 `reply.value`와 전송 관측값을 envelope/영수증에 남기기 전에 종료할 수 있다. `:221`의 raw 게시 뒤 authorize 및 `:222–226`의 response transaction beforeCommit도 같은 현재 실행 권한이므로, raw만 남고 정확한 `mcp-page:<attemptId>:<requestId>` 영수증이 없는 경우가 가능하다.
- `src/infrastructure/mcp-stdio-client.ts:263–285`: SDK resolve 후 유효 JSON/크기 검사와 선택 capture를 거쳐 마지막 session/abort 검사를 한다. collection은 capture를 설치하지 않으므로 마지막 검사 실패 시 이미 SDK가 반환한 decoded value도 `McpCallError`만 남기고 잃는다. **SDK가 먼저 reject하여 value 자체가 없는 경우는 수신 완료가 아니다.** collection의 `:209`는 비-McpCallError도 보수적으로 sent=true로 분류하므로, 미래 known usage 증명에서 이 추론을 직접 관측값으로 승격하면 안 된다.
- `src/application/read-collections.ts:312–329`: source에 전달하는 authorize는 원 intent/head와 현재 실행 권한을 함께 검사하며 source 실패 뒤에도 current 검사를 한다. 반환되지 않은 page의 usage를 일반 실행 결과에 자동 복원하는 경로는 없다. `read-checkpoints.ts:226–235`는 **현재 attempt 소속** accepted/deferred response의 사용량만 합산하고, intent/unknown 또는 값 부재는 null로 남긴다. 따라서 위 손실은 현재 page/head 복구만으로 알려진 전송 수가 자동 정산되는 문제가 아니다.

## 재사용할 부분과 최소 연결

1. plain `mcp-read-tools.ts:258–315`의 request-local immutable capture, 원 session/requestDigest/관측시각/bytes 검증, raw 게시 전후·영수증 beforeCommit 보관 검사, returned/captured/failure 구분을 재사용한다. captured 이후 실패는 원문 보관만 허용하고 정상 page/deferral로 바꾸지 않는다. 기존 collection envelope v1의 `recordedAt`은 post-authorize 시점이다. 새 capture 관측값을 연결할 때 기존 저장 자료의 시각 의미를 소급 변경하지 않는다. 어느 시각도 물리 commit 완료시각이나 원격 실행 확정을 뜻하지 않는다.
2. 현재 `tool-broker.ts:120–123`은 collection에 `authorizeResponseCustody`를 발행하지 않으며 `ports.ts:149–151`의 source.fetch context와 wrapper도 이를 전달하지 않는다. 미래 연결은 기존 Broker의 원 dispatch/work/tenant/principal/attempt/contract/dataGeneration 및 유한 execute 수명 검사를 재사용하고, **원 page의 requestId·request/query·intentHead·session**을 추가 고정하는 좁은 보관 검사여야 한다. 현재 실행 authorize를 느슨하게 바꾸지 않는다. 자료 삭제 세대·원 소유자/dispatch 손상은 거절하고, 보관은 새 fetch·현재 projector·근거 채택 권한을 주지 않는다.
3. 기존 `mcp-read-collections.ts:141–185`의 정확한 response receipt→ref→원 bytes/SHA→dispatch/intent/head 검증 및 기존 ReadReconciliation을 재사용한다. 다만 기존 original은 현재 goal/policy/visibleArtifact를 요구하므로 **일반 page 검증은 유지하고** 원 호출 사용량을 읽는 호스트 보관 증명과 구분해야 한다. raw 파일 탐색은 복구가 아니다. optional witness 등 실제 receipt 확장 형식은 아직 결정·구현하지 않았다.
4. plain `StoredToolUsages.candidate(:40–47)`와 `ToolContracts.restoreUsage(:110–118)`는 collection/readProgress를 명시 제외한다. 이 제외만 삭제하거나 각 page 사용량을 attempt 전체 합계처럼 기존 known 값에 병합하면 안 된다. 기존 checkpoint의 `(attemptId, requestId)`/원 intent와 응답 영수증에 묶어 **자기 attempt의 각 호출을 한 번만 합산**하고 inherited 부모 호출은 다시 더하지 않는 연결이 필요하다. 논리 도구 예약·남은 호출 한도는 늘리지 않는다. `ContextRecovery:55–67`의 보호 raw 제외도 현재 plain 보관 증명만 사용하므로, 원 라벨 raw를 state.artifacts에 추가하기만 하면 권한 축소 후 일반 재개가 막힐 수 있다. 검증된 보관 전용 ref의 문맥 투영까지 같은 작은 단위에서 연결한다.

## 가장 작은 후속 인수

- `mcp-read-collections.test.ts`의 기존 실제 MCP fixture를 확장: 원 reply 반환 뒤와 raw 게시 뒤 권한 축소/취소를 주입한다. 정확한 page receipt+원 bytes/라벨 보존, projector·현재 page 채택·새 전송 0, 원 관측 전송 수 한 번을 확인한다. owner/generation/원 intent 교체는 반대로 게시 거절을 확인한다. plain `mcp-response-custody.test.ts`의 경계 주입 방식을 재사용한다.
- client의 기존 decoded capture 시험을 collection request와 연결: SDK resolve 후 postcheck 실패와 resolve 전 reject를 구분하고, 동시 두 request의 captured value/receipt가 섞이지 않는 한 사례를 둔다. invalid/oversized 응답을 유효 raw로 인정하지 않는다. `transportCalls=1`은 로컬 전송 경계 진입이며 원격 실행·과금 확정이 아니다.
- `mcp-read-settlement-recovery.test.ts` 및 기존 worker의 실제 SIGKILL/유한 cleanup 틀 재사용: 권한 축소 상태에서 raw-only와 response-receipt 이후를 구분하고, 새 process에서 추가 peer call 없이 usage-only 복구를 비교한다. final/nonfinal/deferral 원문과 head 의미를 유지하고 두 복구자·재호출에서도 page별 중복 정산이 없어야 한다. 이미 정상 정산된 page를 함께 둬 합계 덮어쓰기와 부모/자식 중복을 잡는다.
- 기존 일반 입구 custody/context 시험의 한 사례를 collection에 연결: 보호 raw를 공개하지 않고 status/stop/reopen이 가능하며 cancelled/blocked 상태와 원 예산을 유지한다. 이 연결 없이 raw 보관만 구현한 것을 전체 단위 완료로 표시하지 않는다.

## 읽은 소스 지문

관측시각: 2026-09-07T15:15:57.197409+00:00

- `runtime/src/infrastructure/mcp-read-collections.ts`: `ba7398f4908e6b83c2c2d1e4bfb395bd6585f45df9ec5ddb9abe349520ed1508`
- `runtime/src/infrastructure/mcp-read-tools.ts`: `71fdc29b40e75bd87db3c13e0bdd84fb55b0ebe5440836f146abda0e079ee9c2`
- `runtime/src/infrastructure/mcp-stdio-client.ts`: `759a970aa9c3f32dd5b5b9669de8901bafb59f4b7bf16037f3ae7ab7e63d18d3`
- `runtime/src/application/tool-broker.ts`: `c27f2b5877c645a411c434c521536ec8aa43291bf0a09db401a91e48b296d028`
- `runtime/src/application/ports.ts`: `a05319935d8db6ced11f808c3bf7736d38caa22224b802490f09116924b67e26`
- `runtime/src/application/read-collections.ts`: `d10955ecfcb008974287ec6aae6a63cfeafcf2c642a5913959858c1720485472`
- `runtime/src/application/read-checkpoints.ts`: `359bc3988483b53d2da47b0489f9b6444ff4def2cc6f5b8db85031c5d5f130fd`
- `runtime/src/application/stored-tool-usage.ts`: `dff0c6777d96367404ff0836b25a99ea4883e6da820ccb0c2c3bcdddb36b8e56`
- `runtime/src/application/tool-contracts.ts`: `23fcab37da66e52cc5e441ceece3db9089cfd61db502cafbb1d1c0b74d23fb3e`
- `runtime/src/application/context-recovery.ts`: `c6d179318cc2c660d58b26aa6355e6951cdb5c151abb91d9d5aa09f1cdc2d06a`
