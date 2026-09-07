# C05 collection staging 작업 상태

2026-09-07. **제품에 적용하지 않았고 빌드/시험하지 않은 준비 사본이다.** NAS offline attempt2 session54736의 제품 source fe438…/build f6c070… 동결을 유지한다. 각 manifest의 originalSha256을 대조한 뒤에만 별도 통합할 수 있다.

앞서 작성한 local-consume-design의 공개 opaque permit 4메서드 제안은 채택하지 않는다. root와 읽기 검토를 거쳐 더 작은 `ReadCollections.assertCompleteResume`와 `consumeComplete`를 선택했다. `isCompleteResumeCandidate`는 동기 제어의 힌트일 뿐이며, 실제 예약/dispatch의 비동기 원문 검증을 대신하지 않는다. Broker의 invoke 내부에서 경로를 한 번 정하고 같은 ReadCollections의 source 인자 없는 메서드를 호출한다. partial 원문이면 child 게시 전에 거절하고 일반 Tool.execute/fetch/reuse로 돌아가지 않는다.

현재 사본에 작성한 부분:

- 기존 collection binding 검증을 snapshotReadCollectionBinding으로 추출하고 optional availability를 wrapper에 전달.
- read-waits의 검증 결과에서 이미 읽은 complete checkpoint도 반환하는 내부 경계를 추가. 기존 validateReadWaits/assertReadWaitReady API 동작은 유지하고 normal execute와 complete 경로는 같은 검증에서 읽은 parent를 재사용.
- complete parent/query/contract/manifest 검증 및 기존 child checkpoint 구성을 공유. 로컬 경로는 child 게시 전과 projection 후 Broker의 원 실행 권한 확인을 명시 호출.
- compose에서 같은 ReadCollections를 ExecutionRuntime/Broker에 주입. reservation/dispatch는 현재 revision/등록을 유지하며 checkExecution의 connection 항목만 구분. 정상 회계/receive/adopt 유지.
- collection의 received 채택, 만료 처리, 원 response 정산을 compact/context보다 앞의 bounded 단계에 연결. 기존 recover의 만료 부분만 추출하고 effect recovery를 조기에 호출하지 않음.
- ReadReconciliation의 원문/commit 경계에 host execution authority 검사 연결.

아직 반드시 할 일:

1. **partial offline 제어는 미구현**이다. 단순 progress.partial만으로 기다리게 하면 안 된다. raw nonfinal 정산 뒤 attempt는 failed여도 checkpoint.phase가 running일 수 있다. batch 영구 실패/한도 소진/intent-only를 정상 연결 대기로 숨기지 않고, 원 checkpoint의 nextRequest 가능성과 현재 plan의 정확한 task/query/tip을 검증해야 한다. 독립 available task를 우선하고, 미래 retryAt은 원 wait를 유지한다.
2. Runtime reserve/dispatch에서 complete proof 검사가 다른 비동기 guard보다 너무 일찍 끝나지 않는지 최종 순서를 검토한다. 동일 등록/current state 재검사를 유지할 것.
3. local publish/current·projection 이후 raw/host 권한/상태/등록 경합, source callbacks 0, 부모 실패/원 owner/논리 호출1·transport0, concurrent successor와 재시작을 실제 시험으로 작성·검증해야 한다.
4. Windows 담당이 root staging을 읽기 검토 중이다. metadata는 optional resumeMode와 legacy marked-input의 실제 원문 확인, linux는 stored collection/MCP host factory를 각 staging에 작성 중이다.
5. 기존 성공 unit의 원로그 회수/SSH 정리/최종 proof/문서 updater 실행이 끝난 뒤 staging 원본 SHA·diff를 대조하여 통합한다. 이 사본 자체를 구현 완료나 검증 통과로 표시하지 않는다.

실제 모델/API·사내 MCP·Knox·native Windows 시험은 수행하지 않았다.
