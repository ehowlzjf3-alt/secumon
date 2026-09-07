# Collection profile drain 인수 후보

정본 적용 전 staging 시험이며 아직 빌드·타입 검사·실행하지 않았다. 새 시험 파일은 `src/tests/mcp-collection-custody-profile-close.test.ts` 하나이다. 기존 `mcp-custody-profile-close.test.ts`의 공개 메서드 forwarding/gate와 `mcp-collection-entry-fixture.ts`의 실제 host 등록, C01 초기화, stdio 서버·audit를 재사용한다. 새 서버·모델 구현·제품 hook은 추가하지 않는다.

SQLite/file-journal 각각 두 경계, 총 4개를 작성했다.

- 정상 drain: 실제 SDK 응답을 담은 collection raw artifact의 put이 게시된 직후 반환을 보류한다. `profile.close()`가 host signal을 abort하고 실제 모델/stdio 자원을 닫은 뒤 `runtime.finishClose()`에 들어왔음을 관측한다. store가 아직 열린 동안 raw 반환을 허용하면 원 page receipt, 빈 오류 result의 receive, known transportCalls 1 정산이 drain 종료 전에 완료되어야 한다. 원 dispatch/intent/head/owner/lease/raw는 보존하고 모델·compact·projector·추가 도구 호출, 페이지 채택, read reconciliation은 없어야 한다.
- drain 기한 경과: 같은 raw gate를 실제 기본 5초 finishClose 한도 동안 보류한다. `executor_close_unconfirmed`와 C01 store 종료를 확인한 다음 raw 반환을 허용한다. 보관 수명이 이미 끝났으므로 page/receive/usage의 늦은 게시가 없어야 한다. 종료 직전 상태, 다시 연 store의 상태·영수증·event·raw bytes, 실제 peer audit가 동일해야 하며 새 실행/정산도 거절되어야 한다.

`finishClose` wrapper는 인자 없는 기존 호출을 그대로 전달한다. 시험용 짧은 timeout, fake clock, executor 실행 대체, SDK 응답 대체, SIGKILL은 사용하지 않는다. 실제 stdio peer의 start/close audit와 PID ESRCH를 확인하며 임시 profile/store를 정리한다. 이것은 public CLI/HTTP 흐름이나 전원 장애 검증은 아니다. Windows 담당의 실제 SIGKILL 인수와 범위를 분리했다.

검토한 현재 연결은 `agent-turn-profile.close`의 abort/beginClose → model.close → tools.close → finishClose → stores.close, `ToolBroker`의 호출별 custody callback, collection intent-bound custody guard, `ExecutionRuntime`의 receive 후 collection usage 보완이다. 이 범위에서 구체적인 추가 구현 결함을 찾지 못했다. 종료 신호와 DB commit이 원자적이라는 보장은 추가하지 않았으며, 시험은 실제 await 경계에서 유한 drain과 만료 이후 거절을 관측한다. 최종 동작은 Root의 통합 시험 결과로 확인해야 한다.
