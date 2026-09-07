# MCP 저장 응답 정산·복구 사전 검토

상태: 구현 전 읽기 검토. 현재 MCP collection, read checkpoint 및 소유 worker 복구 시험 소스만 확인했다. 제품·시험·dist 수정, 빌드·시험·프로세스 실행, Python 원본 및 역사 검증 기록 비교는 하지 않았다. 아래 항목은 수용 기준이며 통과 기록이 아니다.

## 결론과 최소 범위

원격 응답의 `mcp-page:${attemptId}:${requestId}` 영수증은 저장됐지만 마지막 collection call이 여전히 `intent`인 경우, **원래 attempt의 그 intent 한 건만 정산**하는 경로가 적합하다. 루트가 제안한 `ReadCollections.reconcile(workId, attemptId)`를 lease 만료 회복 뒤 호출하고, 결과 채택과 다음 원격 요청은 현재 권한으로 명시한 `readResume`에 남겨두는 방향에 동의한다.

새 경로는 내부 실행 조정 서비스다. actor 인자를 받지 않는 API를 외부 HTTP 명령으로 바로 노출하지 않는다. 이미 실행 중인 owner의 lease를 빼앗거나 연장하지 않고, terminal인 read/effect-none attempt의 **같은 마지막 intent·같은 head·미점유 successor**만 CAS로 갱신한다. 원래 result가 존재하면 이를 덮어쓰지 않으며, 채택된 결과나 이미 자식이 점유한 head를 소급 변경하지 않는다.

저장 응답의 유무와 유효성은 구분해야 한다.

| 저장 상태 | 정산 판정 | 다음 동작 |
| --- | --- | --- |
| `mcp-page` 영수증 없음 | 저장 응답 없음 | intent를 유지한다. 이후 명시 재개의 기존 `unknown` 상속 규칙을 적용한다. |
| raw blob만 있고 영수증 없음 | 저장 응답 없음 | blob 검색·추정 연결 없이 위와 동일하게 처리한다. |
| 영수증과 유효한 원응답 있음 | 원 request에 정산 가능 | 동일 call을 accepted/deferred로 변경하고 normalized response와 새 head를 게시한다. |
| 영수증에 transport failure 기록 있음 | 저장된 실패 | 정상 page와 구분한다. `sent`와 원 호출 비용의 불확실성을 보존하고 성공 자료를 만들지 않는다. |
| 영수증은 있으나 원본·pin·schema·projection 불일치 | 증명 불가 | absent/unknown으로 조용히 바꾸지 않고 명시적으로 거절한다. |

현재 `execute()`를 재호출하는 구현은 부적합하다. 기존 head가 있으면 `read_collection_already_started`로 거절하고, 정상 중간 page를 수락하면 다음 page를 자동 호출한다. 정산은 이 루프와 분리하여 한 번의 저장 응답 처리만 수행해야 한다.

## 현재 재사용점과 연결 제약

1. [MCP collection adapter](../src/infrastructure/mcp-read-collections.ts)의 private `projectResponse`와 `proof`를 재사용할 수 있다. `proof`는 원 dispatch, mcp-page 영수증 digest, raw SHA/size, intent head, 원 task/request, contract/binding, goal/policy/generation, endpoint/protocol, 원 기록 시각을 대조하고 동일 projector로 결과를 재계산한다. 현재 source 포트에는 저장 응답 조회가 없고 `fetch()`는 기존 영수증이 있으면 `mcp_collection_response_exists`를 던진다. 따라서 wire를 호출하지 않는 별도 optional callback이 필요하다.
2. [ReadCollections](../src/application/read-collections.ts)의 response schema/근거/ref 검사와 [v2 codec](../src/application/read-checkpoint-record.ts)의 `settle` 연산, `acceptPage` reducer를 재사용한다. 새 저장 형식이나 호출 원장을 만들 필요는 없다. 정상 중간 page 정산 결과의 `cp.phase='running'`은 수집이 더 남았다는 뜻이며, terminal 부모 attempt를 실행 중으로 되돌린다는 뜻이 아니다.
3. [ReadCheckpoints](../src/application/read-checkpoints.ts)의 dispatch 인증, current head/progress 대조, 원본 closure 읽기, raw page 재생 및 callback proof 검증을 유지한다. 정산 후보를 저장한 뒤에도 최종 원본·현재 상태·등록 entry를 재확인하고 같은 head/마지막 intent 조건으로 CAS한다.
4. 현재 `readResume`은 부모 `intent`를 `unknown`으로 상속한다. verifier는 이 규칙과 나머지 상속 call의 불변성을 검사한다. 이미 만들어진 자식에서 그 상속 call을 뒤늦게 accepted로 바꾸면 현행 계약을 위반한다. **자식 점유 전에 부모를 정산하고 새 부모 head를 명시하여 재개**하는 순서가 가장 작다.
5. [기존 실제 worker](../src/tests/helpers/mcp-collection-worker.ts)와 [복구 시험](../src/tests/mcp-read-collections-recovery.test.ts)은 intent 게시 전후와 accepted partial/page 게시 이후를 다룬다. mcp-page 영수증은 있지만 normalized page/head는 없는 구간은 별도 수용 시험이 필요하다. [wait worker](../src/tests/helpers/mcp-wait-worker.ts)도 이미 수락된 wait의 재시작을 검증하는 구조다.

## 정산 계약에서 고정할 조건

- **원 응답 출처:** 정확한 command ID의 영수증에서 raw ref를 얻고 event/data digest와 대조한다. 현재 artifact index의 동일 ref, tombstone/labels, raw byte size/SHA, 원 dispatch와 intent head를 모두 검사한다. 원 intent checkpoint 자체의 refs 검사만으로는 아직 그 closure에 포함되지 않은 MCP raw response를 인증할 수 없다.
- **원 request 불변:** operation/attempt/request ID, cursor, snapshot, retryItems, itemLimit, input·contract·projector/binding digest를 바꾸지 않는다. 새 request 생성, `calls` append, 성공 항목 재관찰, 새 관찰 시각 생성은 하지 않는다.
- **시간과 대기:** 재투영에는 원 envelope의 `recordedAt`을 사용한다. 원 source `observedAt`, evidence `recordedAt`, deferral/item `retryAt`을 보존한다. checkpoint `updatedAt` 및 정산 event 시각은 현재 시각일 수 있다. old lease/deadline은 그대로 두고, 만료 후 저장 자료 정산과 새 실행 허용을 분리한다. 정산 시점이 due 이후라면 새 2,500ms 창을 만들지 않는다.
- **현재 권한과 자료:** 원 task는 dispatch receipt에서 복원하고 현재 canonical goal/policy/generation, 현재 등록 definition과 callback을 재검사한다. 원본 삭제·권한 철회·binding 변경이면 정산을 거절한다. 저장된 과거 session generation을 새 live session generation으로 바꾸지 않는다. 원 binding/proof를 오프라인 검증하기 위해 새 MCP discovery를 요구하면 `추가 외부 호출 0` 주장은 성립하지 않는다.
- **늦은 원 실행과 자식 경합:** 현재 terminal 상태와 같은 head를 최종 CAS까지 확인한다. 이미 reserved됐지만 첫 child head를 아직 게시하지 않아 `successorAttemptId=null`인 자식이 존재할 수 있다. 부모 정산이 이기면 그 자식의 old-head resume은 wire 전에 거절돼야 하며, 예약 회복이 가능해야 한다. 자식 점유가 이기면 부모 정산이 거절돼야 한다.
- **멱등성과 비용:** 정산 command는 원 attempt/request/head에 고정한다. head CAS ACK 유실 후 재요청은 기존 영수증을 확인하고 두 번째 call·head 전이를 추가하지 않는다. operation `calls.length/maxCalls`, business tool/model 예약 수, 원 deadline을 증가·초기화하지 않는다. 원 응답의 transport 1은 원 호출의 비용이며 정산이나 자식의 신규 원격 호출 비용이 아니다. 불명 비용을 0으로 만들지 않는다. 저장소 read/hash 비용은 별도 로컬 비용으로 기록할 수 있다.
- **부분 결과와 완료:** accepted nonfinal page는 더 읽을 데이터가 남는다. partial/error/not_run은 미완료 항목을 유지하고, deferred는 원 wait를 유지한다. 정산 자체는 outer result를 채택하거나 업무 완료·전달을 만들지 않는다. complete checkpoint의 명시 자식 재개는 기존 원응답으로 결과를 구성할 수 있지만 wire를 다시 호출해서는 안 된다.

## 실제 SIGKILL 수용 경계

SQLite와 file-journal 각각 새 worker/저장소/임시 artifact store를 사용한다. 각 worker는 해당 영속 commit의 성공 뒤 marker를 파일과 디렉터리에 fsync한 다음 부모에게 준비 신호를 보내고 멈춘다. 부모는 그 시험이 소유한 worker만 SIGKILL하고 peer의 EOF 종료와 ESRCH를 관찰한다. reopen은 새 owner이며, 저장 정산 구간의 client `call`/`discover`, planner, sink는 호출 횟수 0을 단언한다.

| 경계 | 반드시 관찰할 결과 |
| --- | --- |
| 1. intent 저장 후 host의 mcp-page 영수증 저장 전 종료 | receipt 없음, intent 유지, 정산이 응답을 만들지 않음. peer가 처리했다는 audit만으로 accepted로 추정하지 않음. 이후 명시 새 request는 기존 unknown/cumulative maxCalls 규칙 유지. |
| 2. `mcp_collection_response_recorded` commit 성공 직후, 호출자에게 ACK 반환 전 종료 | 원 raw/receipt 및 intent는 존재. 만료 회복 후 정산으로 같은 call만 accepted가 됨. 원격 재호출 0, evidence ID/시각/입력 digest 보존. |
| 3. 정상 partial 또는 nonfinal response receipt 이후 종료 | 정산은 성공 항목을 그대로 보존하고 종료. 다음 명시 resume은 retryItems 또는 nextCursor만 처리하며 기존 성공을 다시 요청하지 않음. |
| 4. whole deferral 또는 item wait response receipt 이후 종료 | 정산 후 retryAt은 원 절대시각. due 전 모델·wire·자식 점유 0, due 이후 명시 재개만 가능. reopen·정산 시각으로 barrier가 재설정되지 않음. |
| 5. normalized response artifact 저장 후 새 head CAS 전 종료 | 정산 재시도는 canonical mcp-page 영수증을 다시 검증·재투영. 고아 normalized blob을 권위로 삼지 않고 동일 원 call 한 번만 수락. |
| 6. 정산 head CAS 성공 후 ACK 반환 전 종료 | 재시작 정산은 멱등 no-op/기존 영수증 결과. callCount·accepted request 목록·maxCalls·예산·원 deadline 불변. complete와 nonfinal 양쪽에서 정산이 다음 wire를 시작하지 않음. |

최소 실제 프로세스 시험은 2번을 두 backend에서 수행하고, 성공 partial과 deferral도 포함해야 한다. 1·5·6번은 같은 worker hook으로 확장 가능하다. 단순 같은 프로세스의 예외 주입만으로 SIGKILL·peer 종료·새 owner 복구를 검증했다고 기록하지 않는다.

## 별도 실패·경합 회귀

실제 프로세스 경계 외에 다음 로컬 회귀가 필요하다.

1. raw/intent/base 원본 유실·변조, raw ref 교체, receipt digest 또는 원 request 불일치가 present-but-invalid로 거절되고 원격 fallback이 없을 것.
2. raw 읽기 또는 normalized artifact put 중 goal/policy/generation·등록 callback이 바뀌면 정산 head가 게시되지 않을 것. 동일 definition 객체를 교체한 async 경계도 현재 등록 entry 고정을 확인할 것.
3. 정산 두 caller와 ACK 유실 재시도에서 call 한 건·정산 한 번만 남을 것. old-head 자식 reserve/claim과의 양쪽 승패에서 중복 wire가 없을 것.
4. original attempt가 아직 running/lease 유효, source head가 이미 consumed, result가 이미 채택된 경우 정산하지 않을 것. 만료됐어도 cancel/goal 변경/자료 철회로 현재 권한을 잃은 경우 과거 pin만으로 정산하지 않을 것.
5. transport failure envelope와 실제 정상 응답을 구분하고, 지원하지 않는 result/error/body를 성공 page나 새 `unknown` retry 허가로 바꾸지 않을 것.
6. 정산 후 [ReadCheckpoints](../src/application/read-checkpoints.ts)의 전체 proof/replay와 기존 `readResume`을 통과할 것. 원 page/request/성공 항목/사용량이 유지되고 새 자식의 비용만 별도로 계수될 것.

이번 단위의 완료 주장은 “소유한 로컬 MCP peer의 저장 응답을 원 intent에 추가 원격 호출 없이 정산하고 명시 재개하는 계약을 검증”으로 제한한다. 응답이 host 영수증에 남기 전에 중단된 호출의 복원, 원격 exactly-once, 원격 서비스 자체의 재시도·idempotency, 자동 background 실행, 실제 사내 MCP·모델 성능은 포함하지 않는다.
