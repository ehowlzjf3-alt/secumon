# 일반 collection 입구의 생략된 근거 다시 읽기

이 문서는 시험 fixture 교정이며 제품 코어의 변경이나 통과 결과가 아니다. 변경 파일은 [entry fixture](../src/tests/mcp-collection-entry-fixture.ts)와 [entry 시험](../src/tests/mcp-collection-entry.test.ts) 두 개다. worker, 기존 staging 사본과 manifest, 실패 로그는 보존한다. 새 빌드와 시험은 아직 실행하지 않았다.

## 확인된 실패

[new4 원로그](C05-mcp-collections-new4.log)에서 CLI 두 backend는 최종 `pending_obligation`으로 끝났다. [SQLite new5 진단](C05-mcp-collections-new5.log)과 [실행 기록](C05-mcp-collections-new5.json)은 다음을 실제로 확인했다.

- 원 부모는 `failed/lease_expired`로 남고, 명시 successor는 `succeeded/adopted`가 되었다.
- 현재 work에는 원 raw artifact를 참조하는 a와 b의 accepted 근거가 모두 남아 있었다.
- 최종 모델 입력의 `evidence`, `readCollections`, `tools`는 비어 있었다. fixture가 이 상태를 자료 확인 질문으로 처리했다.
- 모델 4회와 800 tokens는 이 합성 transport의 사용량이다. 실제 모델이나 tokenizer의 품질·비용 측정이 아니다.

new5는 source `99ea0159d679c623d068b31ba6f492d460cef44ce1452e988dff7b3b231d6738`, build `cec4f59ee513280b004be4369fdf920ab1c12d30940e482b886485c4eaf6c942`, 1,794 files에서 한 시험이 exit 1로 끝난 기록이다. 이번 교정은 그 실행 뒤에 작성되었다.

## 원인과 교정

[ContextCompiler](../src/application/context-compiler.ts)는 일반 응답 목표의 모든 근거를 항상 full로 고정하지 않는다. 필수 입력이나 기준이 참조하지 않는 근거는 좁은 창에서 생략될 수 있다. [readCollectionContext](../src/domain/context.ts)는 채택까지 끝난 complete child와 successor가 이미 있는 부모를 재개 후보에서 제외한다. 따라서 이번 상태는 successor 실패가 아니라, 모든 사실이 계속 `packet.evidence`에 보인다고 가정한 fixture의 한계였다.

fixture 정책에 기존 `core.evidence.find`와 `core.evidence.get`을 명시해서 추가한다. 모든 항목의 현재 값이 보이면 종전처럼 답한다. 값이 생략되었으면 실제 모델 입력의 evidence/reference 또는 성공한 find의 provenance card에서 sourceId와 실제 evidence ID를 얻는다. ID가 충분하지 않을 때만 `collection.record` 단서로 한 번 검색한다. ID를 얻으면 하나의 get 계획으로 요청한 모든 항목을 읽는다. 임의 UUID, work 내부 상태, 호스트 audit, 고정 값에서 ID나 답변을 만들지 않는다.

답변 분기는 계속 실제 최종 `packet.evidence`의 현재 scope, accepted, complete와 숫자 값을 요구한다. find card나 요약의 사실을 답으로 승격하지 않는다. get 결과를 모델이 직접 받은 이후 기존 compiler의 최근 요청 근거 보호가 실제 입력에 값을 다시 넣어야 한다. 카드가 없거나 내용이 불완전하면 질문으로 끝나며, fixture는 같은 open 동안 find 계획 1개와 get 계획 1개까지만 제안한다. 이 반복 방지는 메모리 안의 합성 분기 제한이며 재시작 가능한 새 장부가 아니다. 이 중간 검색 단계 자체를 SIGKILL로 재개하는 시험은 이번 범위에 없다.

## 보존할 인수

좁은 창의 `requiredTokens + 6000`, 출력 예약 2048과 실제 session 원문 길이는 그대로 둔다. 새로 허용한 도구 schema도 기존 실제 estimator와 동일한 보정 절차에 포함한다. 테스트가 요구하는 진짜 session compact, 원문 인용과 현재 tail 보존, 원 checkpoint/response/dispatch와 owner·lease 보존은 유지한다. 최종 값이 안 보이면 창을 넓히거나 근거 검증을 완화해 통과시키지 않는다.

collection 계보는 정확히 원 부모와 명시 successor 두 개로 검사한다. 후속 get 계획이 현재 plan을 바꾸므로 successor의 원 task는 해당 dispatch 영수증에서 읽는다. successor의 논리 tool call 증가분은 여전히 1이고 저장전용 transport 사용량은 0이다. 추가 local find/get의 dispatch, 채택, 결과, 논리 tool call과 모델 호출 수는 별도로 센다. core resource 결과의 transport meter는 현재 미보고(null) 계약을 유지하며, 실제 MCP 무송신은 peer audit 불변과 원 peer 종료로 증명한다.

각 get의 evidence ID가 바로 그 계획을 만든 실제 모델 입력에서 공개되었는지 확인한다. 최종 생성 답변의 원 모델 입력과 인용 ID를 저장소의 현재 근거와 대조하고, 종료 후 새 프로세스 resume가 추가 peer·모델·도구 호출 없이 같은 결과를 반환하는 기존 검증을 유지한다. HTTP 부분 수집의 반복 연결 대기와 명시 online 후속 페이지/실패 항목 재시도는 종전 조건 그대로다.

실제 모델/API, collection의 전송 뒤 권한 변경에 대한 새 custody, 최종 NAS 검증, C05 전체 완료는 이 수정으로 검증되었다고 주장하지 않는다.
