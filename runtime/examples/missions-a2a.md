# 사건 대기와 A2A 배치

`features.missions`와 `features.a2a`는 각각 선택 기능이다. 신뢰된 시작 프로그램이 자료 공급자·상대 endpoint·권한을 등록한다. 모델은 endpoint나 인증 값을 도구 인자로 지정하지 않는다.

`createScheduledMissionRegistration`은 예약 사건을, `observationMissionSource`는 호스트의 기존 조회 함수를 변화 관측으로 연결한다. A2A를 함께 등록하면 해당 상대의 업무 상태를 관측하는 source도 임무에 연결할 수 있다. 본문은 검토 전 입력이며 개인 기억이나 검증된 근거에 자동 등록되지 않는다.

진행 중인 업무의 대기는 `profile.missions.register(workId, rule)` 후 `tick/drive`로 처리한다. 이미 끝난 업무 뒤에도 새 사건을 처리하려면 `profile.createResidentMissions({binding, policy, limits})`를 사용한다. 반환한 helper의 `register({rule, instruction, sessionId?})`가 내부 제어 업무 ID와 사건용 세션 ID를 돌려준다.

```ts
const resident = profile.createResidentMissions({ binding, policy: profile.policy, limits: profile.limits });
const registered = await resident.register({
  instruction: '새 사건의 원자료를 확인하고 필요한 조치를 판단한 뒤 결과를 설명한다.',
  rule: { id: 'review-events', sourceId: 'registered-source', resourceId: 'registered-resource',
    pollIntervalMs: 30_000, maxResumes: 64, maxIdlePolls: 4096, maxNoProgress: 3 },
});
await resident.drive(registered.workId, { signal: hostShutdown.signal, intervalMs: 1000, maxSteps: 64 });
```

호스트가 실제 등록한 source/resource ID를 사용한다. 내부 제어 업무는 별도 peer/local 세션에서 멈춘 상태로 유지하며 모델·도구 예산은 0이다. 사건용 세션에서는 매 사건이 독립 업무를 만들고 이전 대화 문맥을 이어간다. 원문·커서·사건별 접수 영수증은 기존 저장소에 남는다. 최근 중복 목록 밖의 사건도 원 접수 영수증으로 찾아 같은 업무를 다시 실행하지 않는다. 사건 업무가 질문 대기나 중단 상태이면 기존 업무 재개 경로로 이어간다. `profile.close()`는 drive 종료를 기다린 뒤 저장소를 닫는다.

A2A 발신은 `createJsonRpcA2aRegistration`과 `profile.a2a`/등록 도구를 사용한다. 수신은 호스트가 `a2aInbound:true`를 명시하고 상대를 인증한 뒤 `profile.openA2aHandler({callerId, actor, policy, destination})`를 만든다. handler의 `handle(version, jsonRpcRequest)`를 사내 HTTP/MCP 서비스에 연결하고 `run(taskId)` 또는 호스트 실행기를 통해 접수된 업무를 실행한다. 인증되지 않은 요청을 handler에 전달하지 않는다.

현재 A2A 1.0 JSON-RPC 구현은 SendMessage/GetTask/CancelTask, text/data, 상태·산출물의 제한된 부분이다. 수신 SendMessage는 `returnImmediately:true`로 접수 후 반환한다. streaming, push, file 전송을 지원한다고 표시하지 않는다. AgentCard helper도 지원 부분만 선언한다. listener·사내 인증·실제 상대와의 상호운용은 배치 환경에서 연결·검증해야 한다.

단독/협업 비교는 `collaboration-evaluation`의 `runCollaborationComparison` 또는 저장 결과를 받는 `compareCollaboration`을 사용한다. 기존 판정 기준을 재사용하고 모든 참여 업무의 원 사용량을 합산한다. 후원자 장부의 복사 수치를 다시 더하지 않으며, 빠진 참여자나 미확인 usage가 있으면 비용 비교가 완전하다고 표시하지 않는다. 이 예제 작성 중 실제 평가나 모델 호출은 실행하지 않았다.
