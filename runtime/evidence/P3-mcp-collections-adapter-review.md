# P3-01 MCP collection adapter·개별 원응답 검토

2026-09-06. 저장된 source를 읽은 중간 검토다. 제품·시험·fixture를 수정하거나 build/typecheck/시험/서버를 실행하지 않았다. 아래 확인은 실행 통과 주장이 아니다. 이번 읽기에서 정상 연결을 막는 확정 제품 결함은 확인하지 못했다. 구현 중인 통합·복구 시험 결과는 별도로 확인해야 한다.

주 대상은 [mcp-read-collections.ts](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-read-collections.ts)와 [collection binding helper](/Users/seunghanee/Documents/secumon/runtime/src/tests/helpers/mcp-collection-binding.ts)다. 연결 경계의 판단을 위해 [ReadCollections](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collections.ts), [ReadCheckpoints](/Users/seunghanee/Documents/secumon/runtime/src/application/read-checkpoints.ts), [ToolContracts](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-contracts.ts)도 필요한 부분을 대조했다.

## 개별 원응답과 영속 요청의 결합

- envelope는 work/attempt/read request 전체, 당시 intentHead, input/contract/binding/goal/policy/generation, session, recordedAt을 가진다. 정상 응답뿐 아니라 알려진 전송 실패도 별도 envelope가 될 수 있다. 보존 대상은 SDK가 decode한 JSON이며 packet capture가 아니다.
- 응답 receipt 키는 attemptId와 requestId에 결합된다. proof는 현재 page.rawArtifact가 같은 receipt의 digest에 들어간 정확한 ref인지 확인한다. SHA256·byteLength·현재 공개 가능 ref/index를 확인한 뒤 envelope를 strict decode한다.
- dispatch receipt에서 **해당 call을 실행한 원래 task**를 찾고, taskDigest/inputDigest와 전체 task, contract/binding 및 당시 goal/policy/generation을 비교한다. 이후 response receipt 당시의 readProgress.head가 envelope.intentHead와 같은지 확인한다.
- intentHead를 실제 저장소에서 읽어 마지막 call이 동일 attempt/request의 `intent`인지 확인한다. 응답이 만들어진 시점에 아직 해당 intent였음을 현재 최신 head와 혼동하지 않는다. 현재 head는 나중에 다음 페이지나 successor로 진행할 수 있다.
- 마지막에는 같은 mapper로 page를 재생성해 **개별 normalized page 전체**를 비교한다. 본문 사실만 비교하거나 최종 merged page의 마지막 원본 한 개만 확인하는 방식이 아니다.

ReadCheckpoints는 상속된 call을 읽을 때 `call.attemptId`에 대응하는 origin.task를 넘긴다. 따라서 child의 새 task ID/readResume를 부모 원응답의 task로 잘못 비교하지 않는다. 원응답 ref는 checkpoint.artifacts에 보존되고, 빈 페이지도 page.rawArtifact를 통해 보호된다. reader.proofOriginal의 최종 integrity fence와 registry entry 동일성 검사도 연결돼 있다.

오프라인 proof는 저장된 envelope의 endpoint/protocol/binding과 영속 receipt를 검사한다. 새 프로세스의 session generation이 과거 값보다 커야 한다고 요구하지 않는다. **과거 자료의 검증**에는 과거 live MCP 세션이 필요하지 않으며, **새 호출**은 새로 승인된 현재 세션을 사용한다. 이 구분은 명시 재접속과 같은 snapshot 재개에 맞는다.

## 전송·응답 저장 권한

ReadCollections가 만든 authorize는 Broker current 검사에 더해 당시 intentHead, 마지막 intent request, owner/lease/현재 task·goal·policy·generation 및 successor 부재를 검사한다. MCP adapter는 이 callback을 fetch 진입, client의 실제 전송, reply 이후, 원본 put 이후 및 response transaction의 beforeCommit에서 사용한다. response transaction은 head가 그대로인지도 검사한다.

따라서 adapter 내부 await 뒤에도 원래 허가가 계속 유효하다고 가정하지 않는다. 단, 안전성은 **runner/Broker가 제공한 실제 authorize callback**과 정상 Tool 등록 경로를 합친 계약이다. 임의 host 코드가 source.fetch에 no-op callback을 직접 전달하는 경우까지 별도 인증 계층으로 막는 API는 아니다.

원본 blob put과 state CAS는 하나의 저장 transaction이 아니다. put 직후 권한 변경으로 CAS가 거절되면 미게시 blob이 남을 수 있다. 이를 accepted page/response receipt/근거가 게시된 것으로 세면 안 된다. 같은 이유로 원격 read가 이미 전달된 뒤 권한이 철회되면 전송 0이 아니라 **응답 미게시·미채택**으로 보고해야 한다.

## fixture·projection 정합성

현재 [새 fixture 계약](/Users/seunghanee/Documents/secumon/runtime/src/tests/helpers/mcp-collection-fixture-contracts.ts)과 mapper의 정상·부분 경로는 맞는다.

- 모델 입력은 strict `{ids}`이고 wire는 `{query,read}`다. retryItems의 host inputDigest는 원격에 보내지 않으며 retryIds만 전달한다. mapper가 `${family}:${id}`의 host key를 다시 만든다. 동일 query는 별도 queryDigest로 묶인다.
- dataset/requestId/cursor와 선택된 ID·total을 확인한다. success/partial의 sourceKey/rootSourceKey/revision/observedAt을 고정 fixture 자료에 대조한다. raw record를 Evidence 구조로 직접 받아들이지 않는다.
- partial `b`는 record를 보존하되 observations=[]이므로 Evidence를 만들지 않는다. 재조회 `b`의 success에서 처음 Evidence가 생긴다. 이미 성공한 `a`는 기존 collection merge가 그대로 보존하므로 Evidence의 ID/recordedAt/artifact가 바뀌지 않는다.
- Evidence ID가 requestId별로 다르더라도 lineage는 같은 고정 rootSourceKey다. 재조회나 alias가 독립 출처 수를 늘리지는 않는다. 현재 fixture의 `document:a`·`document:b`는 sourceId가 다르고 lineageId는 같다는 점을 완료 시험에서 반영해야 한다.
- retry 응답의 부족·추가·중복 ID, 초기 batch manifest 불일치, 페이지 간 ID 중복, snapshot/total/nextCursor 변경은 mapper와 기존 acceptPage의 결합에서 거절된다. source는 snapshot/cursor를 새 프로세스에서 재현하며 retry itemLimit이 1이어도 원 페이지 크기 2의 nextCursor/total을 보존한다.

## 범위를 제한해 표현할 항목

1. **snapshot 내용의 외부 인증과는 다르다.** 현재 helper mapper는 첫 raw.snapshot이 `collectionFixtureSnapshot`의 고정 dataset/query/content hash인지 직접 비교하지 않는다. 원 record의 고정 source/revision/시각은 검사하지만 value는 schema의 number로 받아들인다. 현재 보장은 첫 수락 snapshot 이후 동일성과, 실제 제공된 원응답에 대한 mapper 재검증이다. 고정 생성 dataset의 내용 hash까지 호스트가 별도로 인증했다고 주장하려면 최초 snapshot/value와 host fixture oracle의 대조를 추가해야 한다. 일반 운영 MCP의 snapshot 문자열도 그 자체로 자료 진실성을 증명하지 않는다.
2. **페이지 배치의 정확한 내용 인증과는 다르다.** paged는 반환 ID가 host 선택 집합에 속하고 total이 같으며 전체 완료 때 유일 ID 수가 total과 같음을 검사한다. 고정 fixture의 각 cursor가 반드시 어느 ID 묶음이어야 하는지까지 mapper가 직접 비교하지 않는다. 따라서 page order 의미가 필요한 배치에는 별도 source 계약이 필요하다. 현재 유한 selected ID 집합의 최종 누락 방지는 existing unique/total 검증과 함께 성립한다.
3. **rate-limit 모드의 실제 단위.** fixture `rate-limit`은 도구 전체 `isError`이고 `item-error`는 `temporary`, `forbidden`은 항목 오류다. raw schema에 `rate_limited`가 있어도 그 항목별 응답을 현재 mode가 생성하는 것은 아니다. 항목별 rate-limit의 실제 MCP 회귀를 주장하려면 해당 fault를 따로 추가해야 한다.
4. **실패 raw와 accepted page의 proof는 다르다.** isError/전송 실패 envelope는 work artifact와 receipt로 보존될 수 있지만 projectPage가 throw하므로 collection call은 rejected이고 normalized response는 없다. 현재 accepted page replay는 이 실패 envelope를 성공 근거나 accepted raw proof로 소비하지 않는다. 실패 raw의 존재를 성공 페이지 검증 수에 포함하지 않는다.
5. **성공 자료 개정 의미.** projector 함수의 의미는 호스트가 승인하고 projectorVersion으로 관리한다. callback 바이트 자체의 attestation은 아니다. record의 개정·파생 사본을 지원한다고 확대하지 않는다. 현재 partial Evidence를 만들지 않는 제한은 같은 ID body collision을 피하기 위한 명시적인 첫 단위 계약이다.

위 1–3은 현재 실제 fixture와 부합하는 좁은 보장으로 기록할 수 있으며, 첫 구현을 막는 확인된 결함으로 분류하지 않았다. 이후 결과 문서에서 더 강한 주장을 하려면 추가 대조가 필요하다.

## 우선 확인할 통합 부정 대조

원본 A가 있는 두 페이지에서 B의 normalized page에 A의 rawArtifact 또는 requestId/intentHead를 대입하면 거절돼야 한다. partial 뒤 새 worker에서 이전 task의 raw가 그대로 검증되고, B만 재조회되어 A의 모든 자료가 불변이어야 한다. 빈 페이지 raw 삭제와 정상 페이지 raw 삭제를 각각 검사해야 한다. 마지막 validator await 중 callback 교체 또는 raw 유실은 최종 publish/restore에서 거절돼야 한다. adapter 대기 중 정책 변경은 call 0, 실제 reply 이후 변경은 call 1·미게시로 구분해야 한다.

이 검토에서는 위 회귀를 실행하지 않았다. 같은 프로세스 저장소 reopen, 소유 worker SIGKILL, 소유 MCP peer 재시작은 서로 다른 검증이며 실제 실행된 단계만 결과에 기록해야 한다. 사내 MCP/HTTP/OAuth·모델/API·Knox·운영 자료는 이 검토 범위가 아니다.
