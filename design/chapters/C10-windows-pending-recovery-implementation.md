# C10 Windows 동일 복원 작업의 pending 재개

2026-09-08 구현 기록이다. 이전 [Windows lifecycle 연결](C10-windows-lifecycle-implementation.md)의 일반 파일 복사에, 원래 복원 작업과 원문으로 확인된 pending만 이어 쓰는 경로를 추가했다. 이번 담당자는 테스트·Windows 실행·DB 연결·SSH·빌드를 수행하지 않았다. 컴파일 결과는 root의 통합 기록과 구분한다.

## 실제 연결

[windows-lifecycle-recovery.ts](../../runtime/src/infrastructure/windows-lifecycle-recovery.ts)의 `restoreWindowsLifecycleTree`는 기존 복원 marker, 작업 식별자, backup digest, agentId, 정본 target root와 archive entry를 결합한다. 파일마다 `.secumon-restore-<sha256>.pending` 하나를 계산하여 직접 조회한다. 디렉터리에서 발견한 임의 pending을 검색 결과만으로 삭제하거나 성공 자료로 채택하지 않는다. 별도 영속 장부나 모델 도구 API를 만들지 않는다.

[agent-lifecycle.ts](../../runtime/src/infrastructure/agent-lifecycle.ts)의 Windows 일반 복원은 같은 원경로·backup digest·agentId의 marker가 남은 경우에만 기존 target을 재개한다. 일반 복원 작업 식별자는 `local:<backup digest>`이며 기존 marker 저장 형태는 유지한다. POSIX 일반 복원의 기존 목적지 거절 의미는 바뀌지 않는다. [agent-postgres-backup.ts](../../runtime/src/infrastructure/agent-postgres-backup.ts)는 기존 explicit operationId와 PG marker를 그대로 사용하여 import 전후 local tree를 같은 경계로 확인한다. PostgreSQL snapshot·현재 floor·maintenance·same-operation import 계약은 유지한다.

동일 복원 root의 동시 실행은 기존 native `lockRegular`의 독점·delete-on-close lock으로 분리한다. marker 원문과 유지 중인 root/조상 handle을 파일 처리 전후와 게시 직전에 다시 확인한다. 정상 target이 이미 있으면 archive의 전체 bytes/hash와 같을 때만 재사용한다. 같은 작업의 candidate도 함께 존재하면 `lifecycle_restore_candidate_conflict`로 중단하며 둘 중 하나를 임의로 삭제하지 않는다.

## 원문과 candidate 증명

[windows-lifecycle-files.ts](../../runtime/src/infrastructure/windows-lifecycle-files.ts)는 source 전체 SHA256·길이가 archive entry와 같은지 확인하면서 candidate의 모든 byte가 source의 정확한 앞부분인지 1MiB 이하 chunk로 비교한다. candidate가 더 길거나 한 byte라도 다르면 재개하지 않는다. 아직 빈 candidate도 이 검사를 통과해야 한다.

새 ABI4 [streams.rs](../../runtime/native/windows-files/src/windows/streams.rs)의 `recoverable_candidate(target,candidate,maximum,expected)`는 expected가 없으면 `CREATE_NEW`만, 있으면 기존 파일의 private ACL·일반 파일·단일 link와 `identity/kind/bytes/changeToken` 전체가 이전 관측과 같을 때만 독점 재개한다. truncate하지 않고 EOF에서 이어 쓴다. TypeScript 읽기와 native 재열기 사이에 바뀐 object를 그대로 쓰지 않는다. 기존 `createCandidate`의 이름·정리 동작은 바뀌지 않는다.

이어 쓰면서 source 전체를 다시 읽고 digest를 확인한다. 실제 원문이 변했으면 `prepare/publish`로 넘어가지 않는다. 완전한 원문을 확인한 뒤 파일 flush·현재성 확인·no-replace rename을 거치고, 게시된 파일 전체 bytes/hash와 identity를 다시 확인한다. 복사 종료 뒤 source와 destination tree도 원 archive와 비교한다. 이 경로의 추가 source 읽기 비용은 prefix 검증·쓰기 시 현재성 확인을 위한 비용이다.

복구용 candidate는 정상 close나 실패 뒤에도 보존하며 다음 같은 작업이 prefix를 다시 입증한다. 기존 일반 candidate의 확실한 미게시 cleanup은 유지한다. 파일 1GiB, 전체 tree 4GiB, chunk 1MiB, 항목 100,000개 및 기존 native 경로·디렉터리 한도를 유지한다. 파일 전체를 Buffer로 만들지 않는다.

## 중단 상태와 한계

- marker 게시 이후 candidate 생성 직후·부분 쓰기·prepare 뒤 중단은 동일 이름과 원문 prefix 대조로 재개할 수 있도록 구현했다.
- rename 결과가 불명확한 경우 candidate만 남았으면 검증 후 재개하고, 완전한 canonical target만 남았으면 원문 전체 확인 후 재사용한다. 둘 다 존재하거나 둘 중 하나가 손상됐으면 명시 충돌/검증 오류로 남긴다.
- marker가 게시되기 전에 끝난 설치·복원, 다른 operation이나 다른 backup의 candidate, 이전 random `.secumon-init-<uuid>.pending`의 귀속을 원 marker만으로 추측하여 회수하는 동작은 없다. 작업을 증명하지 못하는 잔재는 유지하며 정상 복원 완료로 간주하지 않는다.
- `process-crash` 정책을 사용하며 파일 flush를 directory fsync 또는 전원 장애의 namespace 내구성과 같다고 표시하지 않는다. lock의 프로세스 종료 정리와 전원 장애 뒤 잔재 처리도 같은 보장으로 합치지 않는다.
- 전체 tree 검증·기존 identity/engine/PG 확인·marker 제거가 끝나야 정상 open으로 넘어간다. 외부 효과 재전송이나 모델 자동 실행은 하지 않는다.

## 남은 검증 목록

모두 미실행 항목이다. root의 이번 컴파일과 실제 Windows 검증은 별도 증거가 필요하다.

1. 실제 Windows에서 candidate 생성 직후, 부분 chunk 뒤, prepare 뒤, rename 뒤 각 프로세스 강제 종료와 같은 marker 재개.
2. candidate 한 byte 변조·길이 초과·source 변조·다른 backup/operation·정식 target과 candidate 동시 존재에서 무삭제·미완료 유지.
3. prefix 관측과 native reopen 사이 파일 교체·ACL/reparse/link 변경 거절 및 같은 작업 동시 진입 독점.
4. 4MiB 초과 및 1GiB 경계의 원문 정확성·유한 메모리·파일 한도, target 기존값 무교체.
5. 일반 복원과 PG 복원의 원경로·marker·same-operation 연결, 원 오류/close 오류 보존, POSIX 기존 동작.
