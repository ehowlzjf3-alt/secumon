# 중단된 작업공간의 확정 원문 복구

이 기능은 호스트 프로그램에서 호출한다. 모델 도구 목록이나 채팅 명령에 자동 등록하지 않는다. 담당의 `openAgentTurnProfile` 결과에 `workspaceRecovery`가 있으며 기존 저장소·권한·원근거 검사를 사용한다.

복구 입력은 호스트가 정한 업무 ID, 체크포인트 ID 목록과 **담당 디렉터리 밖의 새 경로**다. 체크포인트는 파일 원문을 상태 저장소에 확정한 기록이다. 옛 `.lock`이나 `.pending`이 그 체크포인트의 소유라고 추측하지 않으며 원 작업공간에는 쓰지 않는다.

```ts
// profile: 호스트가 기존 방법으로 연 담당. 모델/API를 새로 호출하지 않는다.
const saved = await profile.workspaceRecovery.recover({
  operationId: crypto.randomUUID(),
  workId: selectedWorkId,
  checkpointIds: selectedCheckpointIds,
  destination: recoveryDirectory,
});

// digest는 완료 manifest의 내용 지문이다. 재열 때 같은 복구 기록인지 확인한다.
const recovered = await profile.workspaceRecovery.open({
  directory: saved.directory,
  expectedDigest: saved.manifest.digest,
});
try {
  const checkpoints = new WorkspaceCheckpoints(profile.services, recovered.workspace);
  const file = await checkpoints.restore(selectedWorkId, profile.actor, selectedCheckpointIds[0]);
  const original = await checkpoints.read(selectedWorkId, profile.actor, file.attemptId, file.path);
  // original.bytes를 호스트의 후속 조사·자료 확인에 사용한다.
} finally {
  await recovered.close();
}
```

`WorkspaceCheckpoints`는 `dist/application/workspace-checkpoints.js`에서 가져온다. 독립 호스트가 코어를 직접 조립한다면 같은 `recovered.workspace`를 기존 `composeRuntime({ ...runtimeOptions, workspaceFiles: recovered.workspace })`의 작업공간 포트로 전달할 수 있다. 이때 원문·상태·권한을 확인하는 서비스는 원 담당의 것을 유지해야 한다.

복구 뷰는 선택한 업무·시도·경로의 원문 읽기와 **같은 내용의 복원**에 한정한다. 새 실행의 임시 파일을 쓰는 작업공간은 기존 방법으로 별도 선택한다. 복구 뷰를 원 담당의 기본 경로로 자동 전환하거나 알 수 없는 옛 시도를 다시 실행하지 않는다.

실패한 새 복구 디렉터리는 보존한다. 완료 manifest가 없는 위치는 복구 완료로 열리지 않으며 다른 새 경로로 다시 시도한다. 원문을 확정한 체크포인트가 없는 미완성 파일과 소유 불명의 잠금은 자동 수리 범위에 포함하지 않는다.

담당을 닫으면 진행 중 복구 호출과 열린 복구 뷰를 먼저 정리한 뒤 원 저장소를 닫는다. source 상태·권한·세대가 바뀌면 복구나 재열기를 거절한다. 실제 Linux/Windows·중단·동시 종료 검증은 별도 검증 단계에서 수행한다.
