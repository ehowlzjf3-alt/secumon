# 수집 전체성과 업무 완료 조건의 연결 검토

2026-09-06 · 현재 TypeScript 경로의 읽기 검토와 다음 구현 제안이다. 제품·시험·빌드는 변경하거나 실행하지 않았다. Python/압축 원본, 과거 코드와 역사 로그는 비교하지 않았다.

## 판단

**개별 Evidence.coverage를 유지하면서, 전체 수집이 필요한 Criterion에 선택적인 collection requirement를 붙이고 별도의 검증된 coverage gate를 소비하는 방향**을 권한다. 부분 수집의 성공 항목은 유효한 개별 근거로 남겨야 한다. B가 늦게 성공했다고 A의 coverage/body를 바꾸면 같은 Evidence ID의 불변성도 깨진다.

현재 코드가 보장하는 수집 프로토콜의 완결성과 “업무가 요청한 자료를 모두 확인했다”는 주장은 서로 다르다. 현재 Criterion에는 두 번째 의미를 표현할 query·snapshot·항목 집합 계약이 없다. 이는 다음 요구에 필요한 계약의 공백이며, 부분 결과의 개별 근거 채택 자체를 결함으로 볼 이유는 없다.

## 현재 코드 경로

1. [MCP mapper](../src/tests/helpers/mcp-wait-fixture-binding.ts)는 성공 record의 ReadItem.coverage와 observation.coverage를 `complete`로 만든다. 실패·대기 항목에는 Evidence가 없다. [adapter](../src/infrastructure/mcp-read-collections.ts)는 host의 tenant/scope와 sourceId/lineageId, 원응답 artifact·locator·recordedAt을 붙여 Evidence를 생성한다. 이때 complete는 그 **record의 완전성**이다.
2. [acceptPage](../src/application/read-collection-validation.ts)는 request/cursor/snapshot, 유일 ID, expected↔items, 개수/상한을 확인한다. batch는 host manifest 전체를 대조한다. paged는 페이지 체인·중복 방지와 known total을 대조한다. 부분 페이지는 성공 prefix를 유지하며 모든 미완료 항목을 재조회하기 전까지 다음 페이지로 진행하지 않는다.
3. [ReadCheckpoints.projection](../src/application/read-checkpoints.ts)은 complete checkpoint를 ToolResult.status/coverage=`success`/`complete`로 투영한다. partial checkpoint에서도 이미 성공한 항목의 Evidence는 그대로 반환한다. 이 ToolResult.coverage는 해당 수집 작업의 완결성이고 개별 Evidence의 coverage를 덮지 않는다.
4. [ExecutionRuntime.adopt](../src/application/execution-runtime.ts)는 원본/collection proof, 현재 계약·권한을 확인한 후 success와 partial 모두의 Evidence를 상태에 채택한다. [evidence-intake](../src/application/evidence-intake.ts)는 같은 ID의 다른 body를 거절한다. 완성된 수집의 별도 전체성 증명은 상태에 만들지 않는다.
5. [evaluateCompletion](../src/domain/completion.ts)은 goal의 key/equals 또는 present, **개별** Evidence.coverage, 독립 lineage 수와 반증·의무를 확인한다. ToolResult.coverage, 요청 query, checkpoint의 전체 항목 집합은 읽지 않는다. [control](../src/domain/control.ts)과 [conversation resultProof](../src/application/conversation-service.ts)도 이 완료 판정을 사용한다.

따라서 요청이 A/B/C/D 전체이고 goal의 실제 criterion이 `value=30`, `minIndependentSources=1`, `requireCompleteCoverage=true`라면, A가 성공하고 B가 대기하는 상태에서도 A만으로 현재 criterion은 충족될 수 있다. 단일 사실을 확인하는 criterion에는 맞지만, “전체 자료 확인”이라는 자연어 의도를 표현하지는 못한다. 이 정적 경로를 읽었으며 새 재현 시험을 실행한 것은 아니다.

`collection.record`의 present를 추가하는 것만으로도 전체 집합을 요구할 수 없다. 현재 present는 다른 값이 여러 개이면 반증으로 다루므로 A/B/C/D가 모두 존재한다는 집합 의미와 다르다. `minIndependentSources=4`로 item 4개를 표현해서도 안 된다. 현재 문서 fixture의 A/B/C/D는 같은 원출처 lineage이므로 독립 출처는 1개다.

## 이미 갖춘 범위와 남은 계약

| 구분 | 현재 의미 / 필요한 조건 |
| --- | --- |
| 전송 성공 | MCP 응답을 받음. 자료가 성공·완전하거나 업무 조건이 충족됐다는 뜻은 아님 |
| EOF | 검증된 cursor 체인이 끝났음. pending이 남으면 collection은 partial |
| 수집 complete | 현재 binding이 제시한 항목·페이지·total 계약을 모두 충족함 |
| 개별 Evidence complete | mapper가 해당 원기록을 완전한 관측으로 판단함. 다른 항목의 존재를 말하지 않음 |
| 업무 coverage | 승인된 goal/query가 요구한 전체 대상과 snapshot 범위가 검증된 수집으로 충족됨. 새 계약 필요 |
| 업무의 사실 판정 | 기존 criterion의 사실·반증·독립 출처 조건. coverage gate로 대체하면 안 됨 |

현재 두 MCP fixture는 유한 query.ids를 알고, mapper가 각 반환 ID의 요청 집합 membership와 total을 확인하며 core가 중복과 최종 개수를 검사한다. 이 조합은 해당 fixture의 요청 집합 전체를 대조할 수 있다. 일반 paged source의 `totalItems`는 nullable이고, 원격이 기록과 total을 함께 줄이면 일반 구조 검증만으로 누락을 발견할 수 없다. **서버가 말한 개수와 받은 개수가 같다는 사실만으로 업무 전체성을 인증하지 않는다.**

## 최소 구현 제안

### 요구를 고정하는 쪽

기존 Criterion에 optional collection requirement를 추가한다. requirement는 host가 승인한 goal revision/scope와 정확한 tool/binding·canonical query identity, coverage의 기준이 되는 manifest 또는 열거 계약에 결합한다. planner가 task ID를 바꾸거나 query를 일부만 선택해서 requirement를 축소할 수 없어야 한다. readResume의 task ID/request ID는 새로 생기지만 원 query·범위 identity는 유지한다.

첫 소단위는 **유한 manifest의 모든 항목 성공**을 지원하는 것이 가장 명료하다. 기존 fixture의 선택 IDs를 재사용하고 expected 집합과 실제 성공 집합을 정확히 비교한다. counts는 표시값이며 ID/digest 집합 비교를 대신하지 않는다. 새로운 SOC 전용 key나 source 종류를 generic core에 넣을 필요는 없다.

coverage requirement를 통과했다고 `value=30`이 모든 항목에서 참이라는 뜻은 아니다. 첫 의미는 “요청한 모든 자료를 수집했다”이고 기존 사실 criterion은 그대로 평가한다. “각 항목이 모두 특정 predicate를 만족해야 한다”까지 요구한다면 별도의 `all_items` 조건/항목별 사실 binding이 필요하다. 이를 단순 any-evidence criterion에 숨기지 않는다.

### 증명을 저장하는 쪽

WorkState에 optional **typed collection coverage proof index**를 두는 쪽을 권한다. 기존 item Evidence는 수정하지 않는다. index는 적어도 requirement ID, goal revision/scope, operation/attempt, query와 binding digest, source snapshot, denominator 종류/manifest digest, exact checkpoint ref 및 채택된 result ref를 연결한다. 실제 증명은 기존 checkpoint→각 원응답→host mapper 관계를 다시 검증하는 것이다. 같은 자료를 새로운 Evidence로 만들어 독립 출처 수를 늘리지 않는다.

facts 없는 별도 witness Evidence도 표현은 가능하지만, 기존 Evidence는 source/lineage/derivedFrom·접근·반증·독립성 규칙을 공유한다. 범위 검증을 넣기 위해 가짜 원출처를 만들거나, 사실이 없는 Evidence를 특별 취급하는 경로가 늘어난다. 별도 index는 gate의 의미가 분명하고 item Evidence와 혼동할 여지가 적다. 어느 방식도 저장된 boolean이나 summary만 읽어 완료를 승인해서는 안 된다.

raw response가 저장됐다는 사실, page가 장부에 수락됐다는 사실, checkpoint가 complete라는 사실, 결과가 현재 업무에 채택됐다는 사실을 단계별로 구분한다. **아직 checkpoint/result로 수락되지 않은 원응답을 복구하는 것만으로 coverage 완료를 만들지 않는다.** 복구는 동일 request/intent/proof 검사와 정상 수락·채택 경로를 거친 뒤 동일 gate에 도달해야 한다. root가 별도로 검토하는 저장 응답 정산과 이 지점에서 연결하면 된다.

### 소비와 무효화

- 완료 판정의 domain 함수는 pure로 유지한다. application에서 현재 원본·계약·goal·권한을 검증해 coverage 판정 입력을 만들고, criterion의 기존 사실 조건과 AND로 결합한다. source 원문은 모델 context에 자동 복사하지 않는다.
- execution complete와 model 준비뿐 아니라 conversation.prepare/result readiness, outbox send/lookup/close, 공개 work view, compact/restore에도 같은 current proof 경계를 사용한다. 일부 화면에만 coverage를 추가하면 서로 다른 완료 결과가 나온다.
- same revision에서 원본 blob 손실, 읽기 권한 축소, evidence 철회·정정, generation/goal/binding 변경이 생기면 index를 현재 증명으로 사용하지 않는다. 필요하면 보호 의무를 남기되, index를 지워 기존 fact criterion만으로 완료하도록 우회시키지 않는다.
- historical source의 정본 검증과 현재 독자의 공개 권한을 분리한다. actor에게 좁혀진 policy를 과거 immutable policy digest와 혼동하여 정상 증명을 거짓 무효화하지 않는다.
- 성공한 A와 새로 성공한 B를 같은 snapshot에서 합치는 명시 resume는 허용한다. 다른 query·snapshot의 부분 성공들을 모아 완전한 집합처럼 만드는 것은 첫 단위에서 거절한다.

## empty와 unknown total

**empty collection:** host가 승인한 expected 집합이 실제로 empty이거나 승인된 완전 열거 계약이 zero result를 입증하면 coverage gate 자체는 충족될 수 있다. 그러나 기존 fact criterion의 최소 독립 근거 조건까지 충족시킨 것으로 간주하지 않는다. “조회 전체성이 확인되었음”만으로 업무를 완료할 사용 사례가 필요하다면 별도 typed coverage-only criterion을 명시해야 한다. 기존 `key/equals/minIndependentSources`를 가짜 값으로 채우거나 빈 Evidence를 추가하는 방식은 피한다.

첫 소단위가 optional gate 추가에만 한정된다면 coverage-only criterion은 별도 후속으로 두어도 된다. 이때 문서에는 “empty 범위는 판정 가능하지만 기존 사실 criterion을 대신해 완료하지 않는다”라고 명시해야 한다. 현재 MCP fixture query는 최소 1개 ID이므로 empty 시험은 범위가 승인된 별도 empty manifest fixture가 필요하다.

**unknown paged total:** 정확한 host manifest가 있다면 wire total이 null이어도 집합 비교로 전체성을 판단할 수 있다. manifest가 없다면 stable snapshot+terminal EOF가 완전 열거를 뜻한다는 **검토된 source 계약**이 있어야 한다. 그 계약도 없다면 도구 수집의 EOF/complete는 유지하되 business coverage는 unknown/unavailable이어야 한다. remote total, annotations 또는 서버가 임의로 보낸 complete=true만으로 계약을 만들지 않는다. 첫 단위에서는 unknown-total 일반 서비스에 대한 완전성 지원을 주장할 필요가 없다.

## 최소 의미 있는 시험

1. 요청 A/B에서 A complete+B rate-limit: 개별 A 근거는 채택 가능하지만 collection requirement가 있는 업무는 미완료. requirement 없는 단일 사실 업무는 기존 의미 유지. 정확한 due 후 B만 명시 resume하면 전체 gate 통과, A의 ID/body/시각 불변.
2. 요청 A/B/C/D 대비 일부 응답의 조기 EOF·허위 작은 total, 다른 query의 완성된 수집, 다른 snapshot의 부분 집합 조합을 거절. 정상 문서 batch와 관측 paged의 exact 집합 대조는 통과.
3. 완전한 A/B가 같은 lineage이면 독립 출처 1로 유지. 전체 coverage 통과와 minIndependentSources=2 실패를 함께 확인. 독립 출처 조건과 대상 항목 개수를 분리한다.
4. 완성된 coverage index/summary만 위조하거나 원본·checkpoint를 교체/삭제하면 완료·모델 입력·채팅 결과·outbox·복원에서 현재 proof가 거절됨을 확인. 같은 revision에서의 원본 손실도 포함한다.
5. 원응답만 저장된 종료 지점에서 복구: 수락 전 coverage gate는 미충족. 동일 원응답을 정상 장부/결과로 정산한 뒤에만 gate가 갱신되고 재호출·중복 Evidence 없이 동일 판단을 얻는다.
6. 명시 empty manifest는 coverage의 전체성만 통과하고 일반 사실 criterion은 근거 부족. unknown total은 exact manifest가 있으면 통과, denominator/완전열거 계약이 없으면 EOF여도 business coverage 미확정. coverage-only criterion을 구현한다면 그 분기만 별도로 완료 대조한다.

시험은 현재 요구의 정상/실패·복구 계약을 검증한다. 원본 Python이나 과거 구현과의 동작 비교, 실제 사내 source의 완전성 또는 실제 모델 품질 검증은 포함하지 않는다.
