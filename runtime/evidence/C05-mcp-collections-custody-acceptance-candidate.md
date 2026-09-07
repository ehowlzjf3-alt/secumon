# Collection MCP custody — 다음 인수의 재사용 지도

**미구현 후속 단위의 인수 후보**다. 포트·증명 형식은 Linux 담당 설계와 root 결정 전이며, 아래의 새 관측 필드는 요구 의미이지 확정된 공개 API가 아니다. [선행 읽기 검토](C05-mcp-collections-post-send-custody-review.md)의 현재 collection 보관 누락을 대상으로 한다. 이번에는 이 문서만 작성했고 제품·helper·시험 코드·정본 문서 변경이나 실행·SSH는 하지 않았다. 현재 진행 중인 다른 단위의 통과 수를 이 인수의 증거로 사용하지 않는다.

## 재사용 지점

| 역할 | 현재 파일·심볼 | 그대로 쓸 부분 / 연결이 필요한 부분 |
|---|---|---|
| 실제 page 요청과 checkpoint | [mcp-read-collections.test.ts](../src/tests/mcp-read-collections.test.ts) `setup/prepare/invoke`, collectionBinding | 실제 stdio peer, 두 backend, 원 task/query/head와 page/item/failure 데이터를 재사용. source.fetch에는 현재 실행 authorize만 전달되므로 새 custody 관측은 아직 없다. |
| 보관 경계 주입 | [mcp-response-custody-fixture.ts](../src/tests/mcp-response-custody-fixture.ts) `createMcpResponseCustodyFixture`, `afterCapture/afterRaw/beforeResponseCommit` | 실제 C01/Broker/트랜잭션과 원 권한·owner·generation mutation, exact raw put 및 beforeCommit 시 CAS 경합 주입 방식을 재사용. **decoded client 자체는 대역**이다. plain의 단일 `rawRef`/response ID/카운터를 collection 두 요청 검증에 그대로 쓰지 않고 request별로 관측해야 한다. |
| 실제 SDK 캡처의 의미 | [mcp-response-capture.test.ts](../src/tests/mcp-response-capture.test.ts):48/73/83/93/116/152 | 실제 stdio의 정상 반환, capture 뒤 abort/list_changed, SDK pre-resolve reject, invalid JSON/크기, 두 동시 call 후 close 시험. collection의 전체 call context를 forwarding해서 같은 capture가 실제 사용됨을 연결한다. 클라이언트의 기존 방어 시험 전체를 복제할 필요는 없다. |
| 정상 raw receipt 복구 | [mcp-read-settlement-recovery.test.ts](../src/tests/mcp-read-settlement-recovery.test.ts):156,268,291,304와 [mcp-settlement-worker.ts](../src/tests/helpers/mcp-settlement-worker.ts) | `raw-receipt-complete/nonfinal/deferral`, 실제 commit 반환→원 receipt/intent 검증→fsync marker→IPC→SIGKILL, 새 owner의 offline 정산과 명시 successor, 두 복구자/예산 불변을 재사용. 기존 original proof는 같은 goal/policy를 요구하므로 권한 축소 뒤 **usage-only** 인수를 기존 page 채택 성공으로 대체할 수 없다. |
| 원 사용량만 보완 | [mcp-custody-runtime.test.ts](../src/tests/mcp-custody-runtime.test.ts):29,56,80,107,119,144 | unknown→known, 동일 원 영수증의 반복/두 accountant CAS, result/receive bytes 보존, known 충돌 및 stop 상태 보존 assertion. 현재 helper와 `recordStoredUsage`는 plain 계약이므로 collection에서 이 메서드가 그대로 지원된다고 가정하지 않는다. |
| C01 실제 종료·재개 | [mcp-custody-crash-worker.ts](../src/tests/mcp-custody-crash-worker.ts):106–160와 [mcp-custody-crash.test.ts](../src/tests/mcp-custody-crash.test.ts):33,86 | `raw/response/usage` 세 경계, 실제 reply 뒤 explicit cancel+labels 축소, 원 result/receipt/hash 비교, 새 process에서 execute/discover/call/projector0을 재사용. 새 page receipt 및 사용량 commit의 정확한 식별자는 계약 확정 뒤 연결한다. |
| 일반 입구·보호 투영 | [mcp-collection-entry-fixture.ts](../src/tests/mcp-collection-entry-fixture.ts) `ResponseBarrier/readEntry`, [worker](../src/tests/mcp-collection-entry-worker.ts):46, [entry](../src/tests/mcp-collection-entry.test.ts) `originals/noPeer`; [plain context](../src/tests/mcp-custody-context.test.ts)와 [plain entry](../src/tests/mcp-custody-entry.test.ts):233,260,283 | 실제 C01 profiles/CLI 새 process/HTTP reopen/원 source·dispatch·head 비교, 보호 raw를 body에 넣지 않는 검사, status 무쓰기와 명시 resume/cancel 정산을 결합. collection entry의 finite planner/compact는 그대로 새 custody 품질 증거가 되지 않는다. 이 단위의 usage-only 입구는 모델 호출0을 요구한다. |

## 기능별 최소 묶음

1. **반환된 reply와 캡처만 된 reply를 분리한다.** 실제 collection 최종 page 한 건에 (a) client.call 정상 반환 직후 권한 축소/취소, (b) SDK decoded capture 뒤 postcheck 실패를 주입한다. raw/원 라벨·정확한 page receipt·원 dispatch/task/session/request를 보존하고 현재 projector·page 채택·새 호출은 0이어야 한다. (b)는 원 실패를 유지하고 권한을 다시 열거나 process를 재개해도 정상 returned page로 승격하지 않는다. 비교 대조는 SDK resolve 전 reject와 sent=false/true, 일반 임의 오류다. decoded value가 없는 경우 원문 수신을 만들지 않고 직접 관측되지 않은 전송 횟수를 known으로 바꾸지 않는다. 유효하지 않거나 과대한 decoded JSON은 기존 capture 전 거절을 유지한다.

2. **보관을 허용하는 변경과 거절하는 변경을 같은 seam에서 대비한다.** afterCapture, raw put 반환 뒤, response beforeCommit에 권한/labels 축소·명시 취소를 놓아 원 보관은 유지하되 현재 read/evidence adoption은 막는다. 이에 대응해 principal/tenant 또는 원 attempt owner 변경, dataGeneration 증가, 원 dispatch/intent/head/request/contract 손상은 raw 참조/response/usage 게시를 거절한다. raw 파일만 먼저 생길 수 있으나 새 라벨로 재게시하거나 고아 파일을 재개 proof로 쓰면 안 된다. stable raw SHA/원 owner·lease·stop 상태와 구체 거절 위치를 함께 관측한다. 전체 mutation×seam 조합을 늘리기보다 원문 전·파일 후·CAS 전 세 경계에서 허용/거절을 한 쌍씩 배치한다.

3. **두 요청의 연관성을 증명한다.** 기존 실제 동시 capture 시험처럼 같은 session의 서로 다른 request 두 개를 겹치고 마지막 capture에서 한 call을 닫거나 취소한다. 현재 한 collection attempt는 page를 직렬 요청하므로, 실제 가능한 두 work/attempt를 같은 client/session에 연결한다. requestId뿐 아니라 attemptId·intentHead·query/session·requestDigest·raw SHA·관측시각·영수증을 교차 비교하고 A의 raw/usage를 B에 교환한 proof는 거절해야 한다. shared lastReply나 전역 counter 차분을 page 증명으로 사용하지 않는다. 정상 반환 한 건과 captured-failure 한 건이 섞여도 각 outcome을 유지한다.

4. **자기 attempt의 페이지 합계와 정상 page 정산을 구분한다.** 한 attempt에서 첫 nonfinal page는 이미 정상 정산하고 두 번째는 응답 뒤 권한이 줄어든 상태로 종료시킨다. 알려진 자기 page들의 전송 횟수만 한 번 합산하고 inherited 부모 호출을 더하지 않는다. final/nonfinal/deferral은 기존 세 stage fixture의 원 payload·coverage/cursor·retryAfter/receivedAt/dueAt을 재사용한다. 정상 권한에서는 원 page 복구/명시 successor가 그대로 되며, 권한 축소에서는 usage-only 기록이 collection complete/accepted page/retry deadline/새 attempt를 만들면 안 된다. deferral의 전송1과 받아들인 collection page 수0을 혼동하지 않는다. explicit successor의 logical tool call1과 저장 소비 transport0도 유지한다.

   **필수 공백:** 현재 plain known usage 병합은 모순되는 known1→known2를 거절한다. page1만 본 prefix를 attempt의 확정 전체1로 기록하고 나중에 page2를 더하는 방식은 그대로 적용할 수 없다. 새 proof가 미완료 prefix/전체 합계/측정 불가(null)를 어떤 조건으로 구분하는지 먼저 확정해야 한다. pending intent 또는 response 없는 page를 0으로 간주하지 않는다. 이 부분은 callback 형태가 결정되기 전 테스트에서 임의 expected 값을 정하지 않는다.

5. **정산의 중복·경합과 기존 결과 보존을 묶는다.** 위 두-page fixture에서 두 독립 runtime/복구자가 같은 원 증명을 읽고 실제 state CAS 경합을 일으킨다. page별 accounting source/영수증과 최종 attempt execution이 한 번만 반영돼야 한다. 기존 received/adopted/failed 결과가 있을 때 bytes/ref/receive receipt 및 evidence는 불변이고, known 모순은 거절한다. 취소/blocked/completed를 ready로 되돌리거나 예산·재시도 여유를 늘리지 않는다. 부모와 child에 같은 raw를 물려주어도 전송 측정이 두 attempt에 중복 귀속되지 않아야 한다.

6. **실제 SIGKILL은 세 게시 수명을 확인한다.** SQLite/file-journal에 대해 raw-only→receipt 전, response receipt 후→usage commit 전, usage commit 후→호출자 반환 전을 확인한다. 실제 collection peer 한 번 호출, actual committed 결과와 원 receipt를 확인한 marker, IPC를 받은 부모의 SIGKILL, 종료 후 새 process가 명시 stored_only binding으로 회복하는 순서다. 권한은 public 원 session을 읽을 수 있게 두되 수집 raw 라벨을 좁히고 stop 상태를 보존한다. raw-only는 absent/미확정, receipt가 있으면 계약상 입증 가능한 usage만, usage 이후는 exact idempotent를 요구한다. 디렉터리 스캔이나 marker 본문을 런타임 복구 입력으로 전달하지 않는다. marker는 외부 assertion 기준이다. final/nonfinal/deferral 전부×3cuts로 늘리기보다 정상 semantics는 묶음4, 게시 cut은 대표 final에서 양 backend로 분리한다.

7. **일반 reopen의 복수 보호 raw 투영과 수명을 끝까지 확인한다.** public session 원문과 라벨 축소된 raw 두 page를 가진 상태로 실제 CLI 새 process `status` 무쓰기→`resume` usage-only 및 HTTP view 무쓰기→명시 stop/cancel→서버 close/reopen/동일 command 재전송을 검증한다. proof가 입증한 **모든 보관 전용 raw**만 packet 참조에서 제외하고, state.artifacts/원 receipt는 보존한다. unrelated forbidden ref 또는 현재 evidence/result가 요구하는 ref를 숨겨 통과시키면 안 된다. 원 session 자체가 비가시이면 기존 입구 거절을 유지한다. peer audit 불변·discovery/fetch/call/projector/adopt/model0, 계정 한 번, stop 상태 유지가 기준이다. [profile close 시험](../src/tests/mcp-custody-profile-close.test.ts)의 afterRaw gate도 재사용해 정상 drain은 보관/정산 뒤 store close, 유한 timeout은 permit 폐기 뒤 추가 게시0을 대표 한 쌍으로 확인한다.

## 코드 작성 전에 확정할 관측 계약

- page 원본 관측: `(workId, attemptId, requestId, intentHead, session, requestDigest, observedAt)` 및 immutable JSON bytes/ref. returned / captured-postcheck-failure / decoded-absent를 구분할 영수증 증거. 기존 v1 timestamp의 의미를 소급 변경하지 않는다.
- 페이지 usage proof의 source ID/digest와 범위: 어떤 request들을 포함한 자기 attempt의 합계인지, 미측정 page/pending intent가 있으면 전체를 어떻게 표시하는지, 부모 inherited page 제외, 이미 회계된 prefix와의 관계. 논리 reservation·implementationCalls·로컬 전송 경계·원격 실행/과금은 별개다.
- 복수 custody-only ref를 읽는 계약: 현재 plain `StoredToolUsages`/ContextRecovery는 한 ticket의 artifact를 사용한다. collection에서는 두 raw의 증명·projection을 관측할 방법이 필요하며 helper의 단일 rawRef만으로 검증하면 누락을 못 잡는다.
- 실제 guard seam: 원 SDK capture 바로 뒤, 정확한 collection raw put 반환 뒤, 해당 page response state commit before/after, usage commit after를 request별로 구분한다. beforeCommit mutation은 실제 CAS conflict/재검사를 관측하고, postcommit marker는 actual committed/duplicate 의미를 명시한다.
- cleanup: 새 worker의 IPC ready/early exit/강제 종료/peer 종료를 모두 유한 처리한다. 최신 collection entry의 20초 ready·5초 exit/cleanup·16KiB stderr 및 CLI45초/HTTP30초 상한 패턴을 재사용한다. 이전 settlement helper의 무제한 `await exit`를 그대로 복사하지 않는다. 새 gate는 finally release, close 실패 원인도 보존한다.

이 목록은 테스트 소유권이나 API 확정이 아니다. plain 공통 capture 방어와 기존 정상 collection 복구 회귀는 재사용하고, 새 코드는 page 연관 보관·합계·보호 투영의 연결 공백에 한정한다.

## 포트 설계 담당의 후속 후보 공유 — 아직 미확정

Linux 담당은 원 mcp-page responseData의 optional custody witness `{schemaVersion:1,outcome,transportCalls,decodedAt}`와 envelope v1/definition/binding digest 보존, request+intentHead별 `source.restoreUsage`/`Tool.restoreReadUsage` 후보를 공유했다. 위 이름·필드는 채택 전 제안이다.

합계는 received/terminal 또는 원 lease 만료로 자기 attempt의 호출 집합이 닫힌 뒤에만 계산하고, 하나라도 불명이면 해당 측정값은 null로 두는 후보여서 실행 중 prefix를 known 합계로 먼저 기록하지 않는다. 묶음4/5는 이 종료 조건 직전·직후를 구분하고 새 intent가 더 생길 수 있는 동안 정산을 하지 않는지 관측하면 된다. captured outcome은 page/deferral로 복원하지 않는 후보도 위 인수와 일치한다.

ContextRecovery의 exact custodyRefs에는 복수 raw뿐 아니라 인증된 비필수 과거 checkpoint chain도 필요할 수 있다는 의견이다. 이 범위가 채택되면 묶음7에 **과거 체인만 필요한 경우 / 현재 결과·진행·근거가 요구하는 head인 경우**를 대조해야 한다. 모든 checkpoint 또는 비가시 ref를 일괄 숨기는 구현을 허용하는 뜻은 아니다. 원 영수증·체인 proof, 현재 required refs, 자료 삭제 세대 검사를 통과한 좁은 집합만 후보가 된다.

## 읽기 관측 지문

2026-09-07T16:03:54.325071+00:00

- `runtime/src/infrastructure/mcp-read-collections.ts`: `ba7398f4908e6b83c2c2d1e4bfb395bd6585f45df9ec5ddb9abe349520ed1508`
- `runtime/src/infrastructure/mcp-read-tools.ts`: `71fdc29b40e75bd87db3c13e0bdd84fb55b0ebe5440836f146abda0e079ee9c2`
- `runtime/src/infrastructure/mcp-stdio-client.ts`: `759a970aa9c3f32dd5b5b9669de8901bafb59f4b7bf16037f3ae7ab7e63d18d3`
- `runtime/src/application/read-checkpoints.ts`: `359bc3988483b53d2da47b0489f9b6444ff4def2cc6f5b8db85031c5d5f130fd`
- `runtime/src/application/tool-execution-usage.ts`: `51fd47840fd38adb3a0386a106ffc8d45d9a8b5a204e0693e23b4db9c35ba2d4`
- `runtime/src/application/context-recovery.ts`: `c6d179318cc2c660d58b26aa6355e6951cdb5c151abb91d9d5aa09f1cdc2d06a`
- `runtime/src/tests/mcp-response-custody-fixture.ts`: `009970dafc64304da1f35c45fc74f934144001aa85da35f1f6e29875c4bc0b71`
- `runtime/src/tests/mcp-response-custody.test.ts`: `ed4a08e0635a918db2a96f9baceb321d119f61c915f3d38d4e576fbafae87d92`
- `runtime/src/tests/mcp-response-capture.test.ts`: `04d6becee26361cd01e80e877f90a99eac7b08fe6e97e0fb22ad7d58c00e574f`
- `runtime/src/tests/mcp-read-collections.test.ts`: `1f8010f9a25a368e7fa3f1ee63de03ee61a499fb994e13530472713b31a96182`
- `runtime/src/tests/mcp-read-settlement-recovery.test.ts`: `bdae21f0850a25fce33588a5bb21e68f42ef99967164c47c527f12c485de932e`
- `runtime/src/tests/helpers/mcp-settlement-worker.ts`: `b03a890631ca25619c2ea2cf446e4af2900cb60d142877ea44be9f39d0e492c1`
- `runtime/src/tests/mcp-custody-runtime.test.ts`: `7694c97b8ba9432667f389dd6870a0a95a0cb351cc7181b7fab41ffc97a6fb7e`
- `runtime/src/tests/mcp-custody-crash-worker.ts`: `cc2ee69197867ec648be2f9105132d9d849641850f33e4f2fc0ab3417b3edd5f`
- `runtime/src/tests/mcp-custody-crash.test.ts`: `e34e9d0dd92c23561558e6d1d440456f0ba29086f08cb5f454714e30b8abfcc2`
- `runtime/src/tests/mcp-custody-context.test.ts`: `e858de0ec7c846d0112cf39bfe1f5634c265ec5b04734c425a81ca96f1743513`
- `runtime/src/tests/mcp-custody-entry.test.ts`: `808f9c6c83acc2adeabe188fdefb07c3fce02189254fee0d53be7cb55bc0f372`
- `runtime/src/tests/mcp-custody-profile-close.test.ts`: `3dd0484e6ea1b67f5ec5cfea5e7db9265216c659d823ebab2ca972f5366b20c2`
- `runtime/src/tests/mcp-collection-entry-fixture.ts`: `c106d3d90799d917e31222bcc1376ce5a8c74cc3e822d802f1dd2ad7366454d0`
- `runtime/src/tests/mcp-collection-entry-worker.ts`: `18fb7c8584fe409c08a44d086f856f4583cf27c4809618f6e904fe34cfac0900`
- `runtime/src/tests/mcp-collection-entry.test.ts`: `f1ea9451c9d2270076ce6d2dfec96655fabdf35553c36f4a9935ef378709205d`
