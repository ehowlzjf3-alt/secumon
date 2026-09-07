# P3-01 MCP collections 최종 범위 감사

2026-09-06. [계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-collections-plan.md), 현재 제품 source와 시험, root가 저장한 build4/관련 검증 로그 및 사례 기록을 읽었다. 이 감사에서 제품·시험·기존 기록을 수정하거나 build·시험·MCP·모델·사내 서비스를 실행하지 않았다. 이 문서만 추가했다.

현재 범위에서 확정된 correctness blocker는 발견하지 못했다. 계획한 **로컬 MCP collection 연결 및 명시 재개 단위**는 구현·시험 범위가 맞는다. 전체 native verify와 최종 보존 기록의 완료 여부는 root의 별도 결과로 판정해야 한다. P3-01 전체 및 전체 재설계를 완료했다고 올리는 근거는 아니다.

## 읽어서 확인한 실행 근거

- [최종 관련 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-collections-targeted-final.log): 127 tests, 127 pass, 0 fail/cancelled/skipped, 24,692.220667 ms. 13,648 bytes, SHA256 `34cfceea0b203209c1b4ea936a0a78533e7adfefe2a5a1eae523a6777818fada`. 이번 신규 48개는 MCP 통합 26 + 실제 worker 복구 6 + 공통 page proof 16이며, 127 전체를 신규 MCP 실제 실행 수로 표현하면 안 된다.
- [사례 기록 폴더](/Users/seunghanee/Documents/secumon/runtime/evidence/mcp-collections-final): JSON 32개 = MCP 통합 26 + 실제 복구 6. 모두 codeDigest `1f91312db65578b0ac46d52104527993aab1a2b85c9c29ca18e90de64ceed77a`이며 현재 [build manifest](/Users/seunghanee/Documents/secumon/runtime/dist/build-manifest.json)의 sourceDigest와 같다. 이것은 저장 pin의 대조이며 이 감사에서 전체 source/build를 다시 해시 검증했다는 뜻은 아니다.
- 복구 6개는 SQLite/file-journal 각각 intent·partial·page를 포함한다. 기록 모두 worker SIGKILL, 이전/새 peer PID의 ESRCH, client.closed=true, activeCalls=0, tempCleaned=true를 담는다. 이 값은 시험이 수행한 확인의 저장 결과다. 감사자가 같은 PID를 나중에 다시 조회한 결과로 바꾸어 서술하지 않는다.
- 첫 복구 6/6 로그는 증거 기록 추가 전 판본이다. 사례 JSON은 build4 이후 최종 관련 실행에 연결한다. 이 문서 작성 시 전체 native verify의 최종 성공은 확정하지 않았다.

## 계획 기준과 실제 수용 범위

| 기준 | 확인한 구현·시험 | 남겨야 할 범위 구분 |
| --- | --- | --- |
| 두 업무군 × 두 저장소의 실제 SDK 수집 | [MCP 통합 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/mcp-read-collections.test.ts)의 documents/observations 정상·partial 재개, 원응답 저장·오프라인 검증 | 모델 추론·실제 사내 자료로 업무 목표를 달성한 시험이 아니다. fixture facts는 available 목표를 자동 충족하지 않게 설계됐다. |
| 성공 항목 보존과 요청 identity | query 변경, snapshot 변경, cursor loop 거절과 partial의 b만 재조회. 실제 복구에서도 a 또는 a/b의 item 전체·근거·ref·시각 불변 및 새 requestId를 단언 | total/중복 ID/inputDigest/byte의 세부 부정 행렬은 기존 pure reducer/core 시험도 재사용한다. 모두 실제 MCP fault mode로 전개했다고 쓰지 않는다. |
| 개별 원응답 proof와 현재성 | [adapter](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-read-collections.ts)의 raw envelope→응답 receipt→원 intent head→원 dispatch task→projector 재계산. [page proof 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/read-page-proof.test.ts)은 빈 page·부모 원본 유실·callback 교체·마지막 원본 철회와 compact/restore를 검증 | 실제 MCP의 raw 변조·빈 원본 유실·reopen/adopt와 fake core의 compact/currentness 검증을 합친 증거다. 모든 소비 경계 × 모든 실제 MCP fault의 전 조합은 아니다. |
| 대기 뒤 권한·등록 재검사 | 실제 MCP 통합은 전송 전과 reply 이후 정책 확대를 각각 call 0/1, evidence 0, 응답 receipt 없음으로 구분. core는 pause 및 async 등록 교체를 확인하고 기존 durable 시험이 cancel·policy·goal/generation 등을 보완 | 실제 SDK 응답 지연 중 goal/cancel/generation 각각을 이번 새 MCP 통합에서 모두 실행한 것은 아니다. `after-reply`는 client가 받은 reply를 host wrapper에서 보류한 절단점이다. |
| 실제 재시작 | [복구 시험](/Users/seunghanee/Documents/secumon/runtime/src/tests/mcp-read-collections-recovery.test.ts) 3절단점 × 2 backend, 새 owner/client/registry, 기존 lease·work deadline 보존 | 실제 SIGKILL은 durable intent 후 wire 전, accepted partial 후, accepted 비최종 page 후다. 아래 미검증 절단점을 합쳐 전체 crash matrix 완료라고 하지 않는다. |
| 예산·한도·불명 비용 | intent도 누적 maxCalls에 남고, 재개 뒤 0 remaining에서 새 successor를 만들어도 추가 wire 0. normalized response/원 envelope/체크포인트 한도는 각각 적용 | logical tool dispatch, durable call intent, accepted response, 실제 tools/call과 원격 내부 작업량의 분모가 다르다. 실패·불명 원격 작업량은 0으로 추정하지 않는다. |

## 마지막 등록 교체 경합 확인

[ReadCollections.execute](/Users/seunghanee/Documents/secumon/runtime/src/application/read-collections.ts)는 첫 await 전에 RegisteredTool을 캡처한다. guard는 현재 등록 객체와 동일한지 확인하며, 합성 authorize는 Broker 검사 뒤 checkpoint 원본을 기다린 다음 마지막 state/guard/head 검사를 한다. Broker도 선택한 entry가 바뀌었는지 검사한다. 따라서 같은 definition/version을 가진 새 entry로 대체해 digest 비교만 통과시키는 이전 경합은 현재 source에서 막힌다.

양 저장소 회귀는 post-Broker intent-head get 안에서 실제 provider refresh를 발생시키고 replaced=true, providerEpoch=2, source requests=0, originals=0, adopted=false를 단언한다. 최종 127개 로그에 두 회귀가 포함된다. 등록 entry 검사는 로컬 동작 중의 pin이며, callback 코드 자체를 원격으로 인증하는 attestation은 아니다.

## 완료 뒤에도 유지할 한계

1. **서버 실행·원응답 저장·accepted head는 별개다.** 원격 handler가 성공했거나 `mcp-page:<attempt>:<request>` 응답 receipt가 있어도 accepted checkpoint CAS 전이면 최신 collection call은 intent다. 기존 재개는 이를 unknown으로 상속하고 새 requestId로 명시 조회한다. 옛 receipt를 찾아 자동 수락하는 복구 기능은 없다. 따라서 accepted head에 들어간 success의 재조회 방지를 보장하며, 원격에서 한 번 성공한 모든 항목의 exactly-once를 보장하지 않는다.
2. **실제 SIGKILL 미검증 절단점이 남는다.** wire 이후·응답 전, decoded 원응답 receipt 이후·accepted head 전, complete head 이후·outer result 전, received 이후·adopt 전은 이번 MCP worker 6개에 없다. complete orphan·stored result 관련 기존 core 시험과 인접 MCP 경계는 도움이 되지만 실제 MCP peer가 포함된 해당 kill 시험을 대체하지 않는다. 전원 차단 시험도 아니다. worker marker는 fsync하지만 peer audit은 writeSync 기반 관측 로그이므로 전원 차단 내구성 증거로 쓰지 않는다.
3. **rate-limit은 cooldown이 아니다.** 이번 실제 `rate-limit` fixture는 도구 전체 isError다. 원본 보존·실패/partial·예산 소진·자동 재호출 없음까지만 검증한다. Retry-After, 기한 내 재시도 스케줄, 항목별 rate_limited 응답은 검증하지 않았다. fixture에 item-error/forbidden/late mode 또는 schema enum이 존재하는 것과 해당 mode를 이번 통합에서 실행한 것은 다르다.
4. **첫 snapshot은 opaque source token이다.** 첫 수락 뒤 snapshot 동일성과 actual raw→projection 관계를 인증한다. host mapper가 최초 token을 fixture 전체 데이터 hash와 비교하거나 value를 독립 oracle 값에 대조하지는 않는다. paged cursor가 반드시 특정 순서의 ID 묶음을 뜻한다는 독립 인증도 없다. host 선택 집합·최종 고유 ID/known total 검증과 원격 snapshot 진실성을 구분한다. collection exhausted는 업무 전체 coverage나 Goal 만족과 동일하지 않다.
5. **원본·비용·외부 범위는 제한된다.** 원자료는 SDK decoded JSON envelope이며 wire byte capture가 아니다. 현재 원본·receipt·계약 검사는 저장소 간 분산 락이 아니며, 원본 재검증의 로컬 I/O 비용은 원격 호출 절약과 별도다. 새 client generation은 프로세스 전역 단조 번호가 아니다. 기존 marker 없는 source에는 새 page proof 보장을 소급하지 않는다. HTTP/OAuth·사내 MCP·legacy profile·Knox·실제 모델/API/키 사용은 계속 미실행 범위다.

## 다음 작은 로컬 단위 제안

우선 **저장된 MCP 응답 영수증의 명시 정산**을 별도 계획으로 다루는 것이 복구 계약과 가장 가깝다. 옛 request/intent/원 dispatch/현재 actor·goal·policy·generation·contract·원 deadline·예산을 그대로 검증해 기존 응답을 수락할지, 현재처럼 unknown+새 요청으로 남길지 먼저 정한다. 새 requestId에 옛 응답을 붙여 새 관측으로 만들면 안 된다.

실행한다면 두 backend에서 raw receipt commit 직후 SIGKILL, accepted head ACK 유실, 원본 변조/권한 변경을 좁은 수용 기준으로 삼는다. 저장 응답을 정산한 경우 추가 tools/call=0, 같은 operation의 call budget 불변, 단일 successor, 원 observedAt/recordedAt 보존을 확인한다. 이 범위가 선택되지 않으면 현재 unknown 정책을 유지하고 해당 crash 경계만 먼저 추가해도 된다. cooldown scheduler나 일반 운영 MCP 연결은 이 정산 단위와 섞지 않는다.
