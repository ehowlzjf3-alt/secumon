# Collection body disposition 정적 검토와 Workflow 회귀 후보

이 파일과 인접한 시험은 staging 후보이다. 정본 적용·타입 검사·빌드·시험·SSH 실행은 하지 않았다. 비교 원본은 `../../C05-mcp-collections-custody-body-disposition-before1/`이며, 검토 시점의 원본/정본 SHA는 `manifest.json`에 기록한다.

검토한 변경에서 구체적인 회귀 결함은 찾지 못했다. `ports.ts`와 `ToolContracts.restoreReadResponse`는 본문 없는 `custody_only`와 세 reason만 허용한다. `mcp-read-collections.ts`의 새 receipt marker 경로는 `custodyOriginal`으로 원 dispatch, task, intent, 응답 receipt, 원 owner와 work incarnation, 데이터 세대, 정확한 raw bytes/SHA 및 시각 순서를 검사한 뒤 분기한다. `captured`와 `failure`, 원 lease/deadline 이후의 `returned`는 페이지를 투영하지 않는다. marker 없는 legacy는 기존 `original` 검증과 오류를 그대로 사용한다.

`ReadReconciliation`은 복원 callback 전후의 현재 상태·계약·checkpoint·실행 권한 검사를 유지하며, 검증된 `custody_only`이면 부모 상태와 head를 그대로 반환한다. callback의 오류나 손상은 absent로 바꾸지 않는다. `ExecutionRuntime.recover/settleStoredCollection`의 metadata 검사는 현재 비가시 progress의 본문 재조회만 건너뛰며, 이후 별도 사용량 증명을 대체하지 않는다. 만료 처리와 usage 정산은 각각 기존 명령이며, 한 transaction으로 합쳐졌다는 보장은 없다.

새 `src/tests/mcp-collection-custody-resume.test.ts`는 기존 A fixture의 실제 SQLite/file-journal 저장소, 실제 collection/Broker/capture callback, 결정적 decoded transport를 재사용한다. 저장소를 닫고 다시 열어 stored-only source로 새 runtime을 조립하며, 실제 프로세스 강제 종료·stdio peer·CLI/HTTP 또는 실제 모델/API의 검증을 주장하지 않는다.

- 두 저장소 × captured failure, typed sent failure, late returned = 6개: 응답 receipt는 있으나 checkpoint는 intent인 상태에서 `Workflow.run(maxSteps:1)`을 실행한다. onStep이 만료 처리 뒤·usage pass 전에 한 번 호출되고, 이후 원 attempt의 실행 사용량만 `invoked/implementationCalls 1/transportCalls 1`로 보완됨을 요구한다. 알 수 없는 나머지 metric은 null이다.
- 원 owner/lease, goal/plan/budget, intent head와 전체 checkpoint, dispatch/intent/response 영수증 및 raw bytes 보존을 대조한다. 페이지 투영·추가 fetch/transport·모델 호출·새 attempt·결과 채택·read reconciliation 게시가 없어야 한다. 재개 packet에도 채택된 결과나 근거가 없고, 반복 사용량 정산은 원 event를 늘리지 않아야 한다. 원문 참조 자체의 삭제를 요구하지 않는다.
- wrong intent digest와 raw 파일 치환 = 2개: 같은 일반 Workflow 입구가 `read_reconciliation_invalid`로 거절해야 한다. 선행 만료 명령은 보존하지만 onStep 성공 보고·usage event·본문 복원은 없어야 한다. 이 기대는 손상을 보관 전용으로 완화하는 구현을 허용하지 않는다.

실행은 Root가 최종 통합 소스에서 수행한다. 현재 8개는 작성된 인수 시나리오 수이며 통과 수가 아니다. 사용량만 검증하는 Windows B 단위의 원문 fence/receipt 경합 시험은 이 파일에서 중복 작성하지 않았다.
