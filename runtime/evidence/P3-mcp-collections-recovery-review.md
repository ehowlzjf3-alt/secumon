# P3-01 MCP collections: 실제 worker 종료와 명시 재개 검토

2026-09-06 · 읽기 기반 설계 검토다. 제품 source, 시험, helper, SDK 또는 기존 기록을 변경하지 않았고 build·시험·MCP·모델·사내 서비스를 실행하지 않았다. 이 문서만 새로 저장했다.

기준 v0.39 [MCP adapter 정본](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-local-verification.json)은 현재 227,451 bytes, SHA256 `d3ba4b2d35f26b7a630e208e44d7c38c74c17861255e5821d3f5e4c2bc45677f`, 1,992 통과와 일치한다. P3-01 전체는 in_progress, 로컬은 partially_verified다. 이 수치는 이전 단위 결과이며 아래 collections 실행의 통과 수가 아니다. 원본 1,973개 보존 조건을 유지하고 최종 단계에서 다시 해시 대조한다. 이번 읽기에서는 원본 1,973개를 다시 순회하지 않았다.

## 재사용할 정본과 최소 연결점

1. [ReadCollections](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collections.ts:145)는 초기 head, 각 request intent, 수락/거절 head를 work CAS로 게시한다. source.fetch는 intent commit 뒤에만 실행한다. 부모가 terminal 상태이고 정확한 head가 현재 tip이며 successor가 없을 때만 명시 TaskSpec.readResume를 받는다. 첫 successor head와 부모 successorAttemptId를 같은 CAS에서 저장한다. 새 task/attempt가 부모의 query/contract/limits/goal/policy/generation을 바꾸면 거절한다.
2. [ReadCheckpointReader](/Users/seunghanee/Documents/secumon/runtime/src/application/read-checkpoint-store.ts:130)는 v1 snapshot과 v2 증분 record를 읽어 논리 checkpoint를 복원한다. 현재 artifact index·권한과 원본 get을 요구하며 base/raw 유실을 이전 head나 새 fetch로 보충하지 않는다. record 16 MiB, record chain 64 MiB/10,000개, 세션 cache 16 MiB, 공유 materialization 64 heads/16 MiB의 기존 제한을 유지한다. 공유 cache는 authority cache가 아니며 새 FileArtifactStore/새 프로세스의 재검증을 건너뛰는 근거가 아니다.
3. [ReadCheckpoints](/Users/seunghanee/Documents/secumon/runtime/src/application/read-checkpoints.ts:79)는 parent chain 최대 64, 정확한 tip/dispatch receipt/현재 policy·goal·generation, source refs, accepted raw ReadPage replay와 마지막 현재성 검사를 한다. 원 head 또는 raw/source 유실은 필수 원본 유실이다. 재생성 가능한 context frame처럼 취급하지 않는다.
4. 기존 [실제 process crash 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/read-collections.test.ts:116)은 이미 child가 source.fetch 진입 후 실제 SIGKILL되는 것을 검증한다. 부모 lease 만료 recover는 read attempt를 failed/effectState=none으로 정산하고, 명시 successor에서 옛 intent를 unknown으로 남기며 새 requestId를 쓴다. 이번 추가는 fake fetch를 실제 SDK stdio peer와 원본 mapper로 바꾸고 더 뒤의 저장 절단점을 검증하는 것이다.
5. 기존 단발 createMcpReadTool은 collection을 거절하며 MCP intent/response ID도 attempt 단위다. 그대로 감싸면 여러 페이지가 같은 ID에 충돌한다. 이번 binding은 requestId별 endpoint/remote method/query/ReadRequest/schema/projector pin을 가진 MCP decoded envelope를 보존해야 한다. 기존 ReadCall.response는 **정규화된 ReadPage 원본**이므로 MCP decoded 원본과 이름·역할을 분리한다.
6. 현재 ReadCollectionSource.fetch context 타입에는 Broker authorize가 없다. 최소한 optional authorize를 source까지 명시적으로 전달하고, MCP stdin 전송 직전 기존 Broker 검사를 호출해야 한다. 구조적 extra property가 현재 object spread에 우연히 남는 데 의존하지 않는다. ReadCollections의 page별 current 검사와 current authority/효과/예산 재검사도 함께 유지한다.
7. 기존 replay는 normalized ReadPage까지 인증한다. 새 mapper가 만든 Page와 decoded MCP envelope의 관계는 host binding의 별도 검증으로 연결해야 한다. 현재 request intent의 정확한 receipt/head, work/attempt/requestId, 입력·계약·projector digest 및 모든 원본 ref를 대조하고 host mapper 재계산 결과가 같아야 한다. parent checkpoint를 읽는 준비 경계와 result/copy/context 소비 경계에서도 이 관계를 확인해야 한다. 원본이 있다는 사실만으로 그 Page의 의미를 인증하지 않는다. 새 protocol 전용 core 장부를 추가하는 대신 기존 collection head와 원본 참조 closure를 사용한다.

## worker/peer fixture 구성

상위 test는 소유한 임시 폴더, 두 backend 중 하나, fixed synthetic manifest와 고정 시계를 준비한다. **worker A**가 새 repository/ArtifactStore/ToolContracts/ExecutionRuntime/McpStdioClient를 만들고 승인된 SDK **peer A**를 stdio로 실행한다. 상위 test는 worker PID와 discovery 뒤 peer PID를 보관한다. 아래 위치의 marker를 확인한 뒤 worker A만 SIGKILL하고 실제 exit event를 기다린다.

marker는 host가 정한 경로에 `wx`·0600으로 한 번 쓰고 file fsync와 directory fsync 뒤 IPC로 알린다. 최소 필드는 backend, stage, work/attempt/request ID, 현재 canonical head ID·revision, leaseUntil, logical clock, worker/peer PID, 관측한 server handler count다. 서버의 handler-entered/response-ready marker도 해당 audit 쓰기를 fsync한 뒤 통지한다. 단순 sleep 시간이나 버퍼에만 남은 stdout 문자열로 durable 절단점을 추정하지 않는다. 이는 프로세스 종료 복구 시험이지 전원 차단·파일시스템 전체 내구성 attestation은 아니다.

worker가 죽어도 peer는 별도 프로세스다. stdin EOF 후 종료하거나 늦은 응답 쓰기를 시도할 수 있으므로 peer A의 실제 종료를 확인한다. 정해진 시간 내 끝나지 않으면 **저장한 소유 PID만** 종료하고 확인한다. 전체 시스템 이름 검색·일괄 pkill을 쓰지 않는다. 실패 시에도 두 PID와 임시 파일 정리를 finally로 수행한다. SDK close 또는 pid:null은 실제 종료 관측을 대체하지 않는다.

**worker B**는 다른 owner ID와 새로운 모든 service 객체를 만들어 장부를 연다. 기존 lease의 owner를 갈아끼우거나 실행/조회 timeout을 늘리지 않는다. lease 만료 전에는 old attempt의 재전송 0, 만료 후에는 명시 recover, 이어 새 task/attempt의 readResume로 진행한다. 테스트 logical clock만 필요한 시점까지 전진하되 원 work.deadlineAt 이내의 양성 대조와 이후의 거절을 나눈다. 동일 process의 reopen이나 같은 ToolContracts 객체 재사용만으로 이 조건을 대신하지 않는다.

McpStdioClient.generation은 instance 내부 카운터이므로 새 client가 같은 숫자로 시작할 수 있다. 재시작 증거는 worker/peer run identity와 실제 종료·생성, durable requestId의 불일치로 확인한다. generation 증가만을 cross-process identity oracle로 사용하지 않는다. data sourceSnapshot도 서버 PID와 분리한다. 같은 고정 fixture 데이터는 새 프로세스에서도 같은 snapshot/cursor 의미를 유지하고, 데이터 버전 변경 모드만 snapshot을 바꾼다.

## 절단점별 필수 판정

아래 표는 계획이다. 각 절단점은 SQLite와 file journal에 적용하며, marker 이후 실제 worker 종료를 확인한다. 이미 동작이 같은 인접 저장 단계는 한 시험에서 wrapper의 정확한 cut point를 고정해 묶을 수 있지만 어떤 단계였는지는 기록해야 한다.

| 절단점 | 재시작 때 canonical 장부 | 허용되는 명시 재개와 필수 단언 |
| --- | --- | --- |
| 1. dispatch/초기 checkpoint 후, 첫 request intent 전 | running read, calls=0. 초기 head가 없을 수도 있으므로 marker로 구분 | 기존 attempt를 실행하지 않는다. 만료 recover 뒤 head가 있으면 같은 operation의 readResume, 없으면 새 정상 read. 아직 page 호출이 없었던 것과 logical tool dispatch 비용을 구분한다. |
| 2. request intent CAS 후, 실제 stdin 전송 전 | 마지막 call=intent, calls=1, 원 requestId·시간·head 존재, peer handler 0 | successor에서 옛 call=unknown, 새 requestId로만 전송. durable intent 비용은 보수적으로 보존하며 handler 0 관측만으로 기존 장부를 삭제/환불하지 않는다. |
| 3. wire 전송/peer handler 진입 후, decoded 응답 저장 전 | intent 유지, peer handler 1, accepted page 없음 | 기존 call은 unknown. 새 discovery/session과 새 requestId로 미완료 범위만 요청한다. 새 요청 전 오래된 attempt/요청/IPC 재생은 전송 0. read의 조회 결과 불명이지 write effect unknown 의무가 아니다. |
| 4. decoded MCP 원본 또는 normalized ReadPage artifact put 후, accepted head CAS 전 | 마지막 published head는 intent. 파일 또는 별도 MCP response receipt가 있어도 collection에는 미수락 | 미게시 후보 파일을 scan해서 현재 head로 채택하지 않는다. 기본 경로는 unknown+명시 새 요청이다. accepted head CAS가 실제 완료되고 ACK만 유실된 경우에는 저장 head를 다시 읽어 5–7번으로 판단하며 요청을 중복하지 않는다. |
| 5. partial page의 accepted head CAS 후, outer result 전 | pending에 A success/B partial·error·not_run, call accepted, cursor 미전진 | 부모 terminal 정산 뒤 successor의 retryItems는 B의 정확한 ID/digest만. A 재요청·재관측 0, A output/evidence ID·artifact·observedAt·recordedAt 불변. B의 partial 원응답은 최종 success로 바뀌어도 기존 raw artifact로 보존한다. |
| 6. 비최종 성공 page accepted head CAS 후, 다음 intent 전 | 확정 page/cursor와 성공 항목 존재, 아직 다음 call 없음 | successor가 고정 nextCursor/snapshot으로 다음 요청 1회. 이전 페이지/항목은 재요청하지 않는다. sourceSnapshot 변경·cursor loop·query 변경이면 기존 결과와 섞지 않고 거절한다. |
| 7. exhausted complete head CAS 후, outer ToolResult 저장 전 | complete checkpoint, adopted=false/resultArtifact 없음 | 기존 [complete orphan 경로](/Users/seunghanee/Documents/secumon/runtime/src/tests/read-checkpoints.test.ts:85)를 사용한다. 만료 recover와 명시 successor 후 **source.fetch/tools/call 0**, 기존 items·calls·원시각 그대로 재투영. registry 구성 시 discovery가 필요하면 그것은 별도 계수하고 모든 MCP request가 0이었다고 쓰지 않는다. |
| 8. result_received CAS 후, adopt 전 | received, resultArtifact와 collection proof 존재 | 새 runtime이 현재 권한·원본을 검사해 같은 result를 한 번 adopt한다. 새 request·새 tool dispatch 불필요. client/server를 정지한 상태의 검증이면 실제 tools/call 0을 관측한다. 단순 파일 읽기 성공을 채택 성공으로 대신하지 않는다. |

가장 먼저 2·3·5·7·8번을 두 backend의 실제 kill/새 worker로 구현하면 전송 전, 전송 후 불명, 부분 완료 보존, complete orphan, received adoption의 차이를 확인할 수 있다. 4번은 raw 후보 저장과 canonical head 게시를 혼동하지 않는 장애 주입으로 추가한다. 1·6번은 인접 phase의 양성 대조로 비용을 제한할 수 있다.

## 성공 항목의 의미와 unknown 한계

중복 방지의 기준은 **canonical accepted checkpoint에 수락된 성공 항목**이다. peer가 처리했거나 응답을 보냈어도 accepted head가 없으면 worker는 그 성공을 authoritative collection state로 알지 못한다. 따라서 3·4번에서 새 명시 read가 같은 미확정 원격 항목을 다시 조회할 수 있다. 이것을 전체 exactly-once 또는 모든 서버 성공 항목의 재조회 금지로 표현하면 안 된다.

그보다 강하게 decoded MCP response receipt가 있는 경우에도 원격 재조회를 금지하려면, **기존 request identity에 연결된 저장 응답을 인증하여 accepted checkpoint로 정산하는 별도 복구 경계**가 필요하다. 기존 parent intent→unknown 상속 경로에 몰래 성공을 끼워 넣거나, 새 requestId를 옛 응답에 덧씌워 신선한 관측처럼 반환하지 않는다. 첫 단위는 기존의 보수적 경계를 유지하고 이 범위를 명시하는 편이 작고 검증 가능하다.

## 예산·실패·현재성 대조

- `ReadCheckpoint.calls.length`는 accepted/rejected/unknown/intent 전체 이력이며 operation 전체 maxCalls에서 빠지지 않는다. `ReadCollectionState.calls`는 accepted response 수다. 실제 전송 계수, peer handler 진입, logical tool attempt/dispatch, 미확인 원격 내부 비용과 서로 다른 분모다.
- maxCalls를 2처럼 작게 고정한 대조에서 crash intent 1개+successor 요청 1개 뒤 남은 호출 0을 확인한다. 추가 successor를 만들어도 세 번째 tools/call은 나가면 안 된다. 같은 requestId는 accepted뿐 아니라 전체 call history에서 중복을 거절해야 한다. 재시작한 SequenceIds가 옛 ID를 재사용하지 않도록 fixture namespace를 분리하거나 RandomIds를 사용한다.
- 각 successor의 일반 runtime tool reservation/dispatch는 기존 work budget을 소비한다. complete orphan의 transportCalls=0은 logical tool budget을 자동 환불한다는 뜻이 아니다. projection usage는 자기 attempt의 raw responses만 합하며 부모의 usage를 자식에 중복 청구하지 않는다. unknown/rejected 호출의 모르는 비용을 0으로 바꾸지 않는다.
- nonretryable 미완료 항목은 read_retry_forbidden으로 거절한다. malformed page, ID/digest set 불일치, known total mismatch, snapshot 변경, 페이지·항목·byte·chain 상한에서도 성공 부분을 완성된 전체로 승격하지 않는다.
- old owner/lease, 원 work deadline, parent budget grant 철회, current policy/goal/data generation, 현재 tool/projector 계약, 누락·변조·denied raw/base를 각각 한 번은 부정 대조한다. 회복 helper가 이 gate를 끄거나 한도를 늘려 통과시키지 않는다.
- compact를 끼운 경우에도 tip의 readProgress와 정확한 parent head pin이 남아야 한다. derived context 유실은 재구성할 수 있지만 collection 원본 유실을 새 MCP 호출로 메우는 fallback은 금지한다.

## 보존할 관측과 완료 상태

향후 최종 기록은 worker/peer별 시작·종료, stage marker, canonical 전후 state/receipt/head digest, old/new request IDs, accepted/pending/unknown counts, peer가 받은 retryItems/cursor/snapshot, 원본 bytes/hash/관측시각 보존, 0회여야 하는 추가 전송을 고정한다. server audit의 sequence는 재시작마다 초기화될 수 있으므로 run identity와 함께 읽는다. 로그는 상한을 두고 synthetic 필드만 보존한다.

같은 저장 응답 replay와 새로운 실제 continuation을 서로 다른 사례·분모로 보고한다. 데이터 truth는 고정 fixture manifest로 판정하고 scripted 성공값이나 mapper 실행만으로 실제 서비스 정확도를 주장하지 않는다. 새 source/build pin, 두 backend 관련/전체 검증과 원본 1,973개 보존 대조가 완료돼야 이번 로컬 collections 범위를 verified로 기록할 수 있다. P3-01 전체 in_progress와 실제 모델·사내 MCP 미실행 조건은 유지한다. 검증 helper는 이번 작업에서 만들거나 실행하지 않았다.
