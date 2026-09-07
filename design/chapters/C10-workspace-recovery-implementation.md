# C10 체크포인트 원문의 별도 workspace 복구

2026-09-08 구현 기록. 잠금이나 미완료 게시 때문에 원 workspace를 열 수 없는 상황에서, 확정된 checkpoint artifact를 새 디렉터리에 재구성하는 host 경로를 추가했다. 원 workspace의 `.lock`, canonical 파일, pending에는 접근하거나 쓰지 않는다. 영수증 없는 원자료를 추정해 채택하거나 원위치 잠금을 해제하는 기능은 아니다.

## 구현과 재사용

[WorkspaceCheckpoints.restoreInto](../../runtime/src/application/workspace-checkpoints.ts)는 기존 `authorized/permitted/sources/fresh`와 artifact 읽기·원문 확인을 사용한다. 기존 서비스의 optional `inputs`도 전달하여 공유 입력의 현재성 검사를 유지한다. 선택한 checkpoint마다 기존 `checkpoint-<basis digest>` ID, `state.receipt(workId, checkpointId)`의 command digest, 영수증 state에 있는 동일 checkpoint를 확인한다. 현재 checkpoint·권한·자료 generation·출처가 유효한지도 다시 검사한다. 같은 attempt/path에 다른 원문이나 속성을 지정하면 게시 전에 충돌로 거절한다.

체크포인트 영수증은 artifact를 포함한 상태 commit의 증거다. 원 workspace 잠금의 PID/소유자·lease 또는 개별 파일 게시의 성공 증거로 사용하지 않는다. 상태, 목표, attempt, 예산, 사용량, 새 checkpoint를 쓰지 않는다. 원 workspace의 stage/read/list/cleanup도 호출하지 않는다.

[agent-workspace-recovery.ts](../../runtime/src/infrastructure/agent-workspace-recovery.ts)는 두 API를 제공한다.

```ts
recoverAgentWorkspace(host, {
  operationId, workId, checkpointIds, destination,
}) // -> { directory, manifest }

openRecoveredAgentWorkspace(host, {
  directory, expectedDigest,
}) // -> { workspace: WorkspaceStore, manifest, close() }
```

`host`는 신뢰된 `agentId/services/actor/assertCurrent`다. 이 모듈은 profile이나 별도 stores/maintenance를 열지 않는다. [host-workspace-recovery.ts](../../runtime/src/presentation/host-workspace-recovery.ts)는 기존 profile 수명·identity와 원 profile root 바깥의 명시 목적지를 확인하며, 진행 중인 요청과 열린 복구 store를 종료 때 drain한다. 파일을 복사하기 위해 모델이나 도구를 호출하지 않는다.

복원은 부재인 새 private destination에만 허용한다. 기존 `FileWorkspaceStore`의 파일 schema·checksum·base64·원문 SHA·작업별 해시 경로·잠금·게시를 재사용한다. 복원된 원문과 현재 checkpoint를 다시 확인하고 store close를 마친 뒤 `recovery.json`을 마지막으로 게시한다. 실패한 디렉터리와 게시 결과가 불명확한 파일은 보존한다. 실패 위치를 강제로 고치지 않고 새 목적지로 재시도한다. 완료 manifest가 없으면 재열기 API가 정상 store를 반환하지 않는다.

선택은 checkpoint 128개 이하, 파일 하나 1MiB 이하, 중복 파일을 제외한 합계 16MiB 이하이며 manifest는 4MiB 이하다. 기존 기본 workspace 용량을 넘는 대형/범용 아카이브 복원으로 확장하지 않는다.

## 실제 host 소비 경로

기존 profile의 `workspaceRecovery.recover/open` 또는 host factory로 결과를 재열면 실제 `WorkspaceStore`를 얻는다. host는 기존 `composeRuntime` 호출에 `workspaceFiles: recovered.workspace`를 명시해 `WorkspaceCheckpoints.read` 및 동일 checkpoint `restore`에 사용할 수 있다. 기본 agent workspace 경로와 원본 선택을 자동 변경하지 않는다. 구체 호출 예시는 [workspace-recovery.md](../../runtime/examples/workspace-recovery.md)에 있다.

반환 store는 manifest에 있는 work/attempt/path만 허용한다. `read/list`와 기존 bytes·tenant·labels·generation이 같은 idempotent `stage`만 가능하다. 새 파일·다른 원문·`removeAttempt`는 거절한다. 각 소비에서 현재 checkpoint receipt·권한·공유 입력·원문을 재검증한다. `close()`는 새 요청을 막고 진행 중 비동기 읽기/검증을 기다린 뒤 파일 store를 닫으며, 주작업과 close 오류를 함께 보존한다.

이는 **복구된 원문을 조회하고 동일 원문을 복원하는 제한된 저장소**다. 새 실행용 scratch workspace로 자동 전환하지 않는다. 후속 실행의 새 attempt와 workspace는 host가 기존 방식으로 별도 선택해야 한다. 과거 unknown attempt, 외부 효과, 전송, 작업 완료 여부는 변하지 않는다.

## 검증 상태와 남은 경계

이번 담당자는 테스트를 작성하거나 실행하지 않았고, 실제 Windows·NAS·DB·원자료 복구를 수행하지 않았다. 통합 TypeScript 컴파일은 root의 별도 기록을 따른다. 구현 사실과 회귀/플랫폼 검증 완료를 구분한다.

후속 검증은 정상 checkpoint 새 디렉터리 복원·재열기, receipt/원문 손상, 권한·공유 입력·generation 변경, 동일 path 충돌, manifest 전후 중단, 원 lock/pending 불변, scope 밖 접근·다른 stage·cleanup 거절, close와 비동기 읽기 경합을 포함해야 한다. Windows의 process-crash 정책은 POSIX directory fsync나 전원 장애 내구성과 같다고 주장하지 않는다.

원 lock의 소유를 알 수 없거나 게시 결과가 불명확하면 원자료를 그대로 둔다. 영수증 없는 파일의 임의 회수, 살아 있는 잠금 탈취, stale 자동 삭제, 원위치 강제 복구, 상태/업무/예산의 소급 변경은 이번 지원 범위 밖이다.

상위 통합 확인: 최초 build1(20293) exit2의 manifest nullable 타입을 교정한 [build2](../../runtime/evidence/C10-workspace-recovery-build2.log)(95310)는 actual exit0이다. [소스·빌드 지문과 원로그](../../runtime/evidence/C10-workspace-recovery-checkpoint.json)를 보존했다. 상세 동작 시험이나 실제 복구 실행은 하지 않았다.
