# MCP 대기 실행 경계 읽기 검토

2026-09-06. 현재 구현과 필요한 core 경계만 읽었다. 원본/과거 증거 전체 비교, 제품 수정, 빌드, 시험 실행은 하지 않았다. 이 문서는 실행 통과 기록이 아니다.

## 차단 결함 1건

[read-waits.ts](../src/application/read-waits.ts)의 `candidates()`가 `readProgress.phase === 'partial'`와 `successorAttemptId === null`을 원본 검증 **이전**에 사용한다. `validateReadWaits()`도 같은 후보 필터를 사용한다.

현재 goal/scope의 대기 parent에서 요약의 phase만 `complete`로 바꾸거나 successor에 존재하지 않는 ID를 넣으면 해당 parent가 후보에서 사라진다. 새로운 task ID와 동일 query를 쓰고 readResume를 생략하면 scheduling hint와 authoritative wait 검증이 모두 그 parent를 건너뛴다. 새로운 수집의 parent 경로도 원래 checkpoint를 읽지 않으므로, 대기 시각 전 새 예약·dispatch·원격 호출을 차단할 근거가 빠진다. 이는 저장 요약 변조를 fail-closed로 다룬다는 이번 요구의 누락이다. 테스트로 실행한 재현은 아니며 현재 호출 연결을 읽어 확인했다.

권장 수정은 원본 검증 후보와 scheduling 후보를 분리하는 것이다. 현재 goal/scope에서 검토된 대기 지원 도구가 만든 terminal read checkpoint를 요약 phase/successor로 먼저 제외하지 않고 읽는다. 검증된 checkpoint의 phase/시각으로 판단하고, successor 필드만으로 활성 대기를 없애지 않는다. 재조회 chain의 역사적 parent가 더 이상 실행할 작업이 아니라는 사실과, 원본을 검증 대상에서 제거하는 일을 구분해야 한다.

회귀는 정상 partial parent의 `retryAt` 삭제·값 변경뿐 아니라 `phase=complete`, 가짜 successor를 각각 적용하고, readResume 없는 새 task ID/동일 query에서 예약·tools/call·model call이 증가하지 않는지 확인하는 것이 필요하다. 원본 불일치를 발견하면 새 작업을 성공 처리하거나 조기 재시도하지 않는다.

## 연결이 확인된 정상 경계

| 현재 요구 | 읽기 확인 |
| --- | --- |
| due 전 호출 0 / 정각 자격 | `readWaitControl`과 `assertReadWaitReady`가 `now < retryAt` 동안 차단한다. reserve 전과 commit 직전, dispatch 직전, 수집 실행 시작/원격 authorize 경로에 검사가 연결된다. 실제 통과는 통합시험 결과가 필요하다. |
| 같은 query의 task ID 우회 | query digest에 tool ID/version/input을 사용하고 task ID는 넣지 않는다. scheduling은 요약 query, authoritative 검사는 원 checkpoint query를 사용한다. 위 후보 필터 결함을 제외하면 이름을 바꾼 새 task도 원 대기에 걸린다. |
| 독립 작업 진행 | domain `decide`는 개별 task의 wait를 모으고 다음 ready task를 검사한다. 모든 가능한 작업이 기다릴 때만 가장 이른 wake를 반환한다. 기존 budget·의무·terminal 차단을 무시하는 동작은 아니다. |
| 모델 반복 억제 | `decideExecution`은 실행할 작업 없이 replan으로 떨어지는 경우 현재 수집 대기를 반환한다. `PlanningRuntime.reserve`도 replan 필요 여부와 원본 wait를 검사한다. 기한·취소·pause 처리는 기존 control 우선순위를 유지한다. |
| 고정 시각의 근거 | `ReadCheckpoints.progress`는 요약 retryAt/query/phase/count와 checkpoint를 대조한다. replay는 원응답에서 retryAt을 다시 만들고 과거 dispatch도 그때의 barrier 이후인지 확인한다. 단, 후보가 제외되면 이 검증에 도달하지 못하므로 위 수정이 필요하다. |
| 현재 상태·등록 | `validateReadWaits`는 원본 검증 뒤 전체 현재 state digest와 등록 entry identity를 다시 확인한다. reserve/dispatch의 beforeCommit 경로에서도 재검사한다. 원격 전송과 정책 변경이 하나의 분산 트랜잭션이라는 주장은 하지 않는다. |

검토 파일: [read-waits.ts](../src/application/read-waits.ts), [execution-decision.ts](../src/application/execution-decision.ts), [control.ts](../src/domain/control.ts), [execution-runtime.ts](../src/application/execution-runtime.ts), [planning-runtime.ts](../src/application/planning-runtime.ts), [read-checkpoints.ts](../src/application/read-checkpoints.ts), [read-collections.ts](../src/application/read-collections.ts). 판정 시점 이후 루트의 수정 여부와 실제 시험 결과는 별도로 확인해야 한다.
