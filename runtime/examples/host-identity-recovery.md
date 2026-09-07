# 복원 완료 뒤 호스트 identity 재등록

`rebindRestoredAgentHostIdentity`는 기존 호스트 registry에 등록된 담당을 **동일 agentId·원래 경로에 복원한 뒤**, 새 디렉터리 객체로 명시적으로 재등록하는 호스트 API다. 일반 open, 최초 identity 등록, 다른 경로로 복제하는 API와 구분한다. 업무 실행이나 외부 효과를 재시도하지 않는다.

호스트는 정상 엔진과 직접 writer를 먼저 중지하고, 기존 registry head digest와 허용한 backup digest를 별도로 확인해야 한다. archive는 registry 및 복원 디렉터리와 겹치면 안 된다. `engineDirectories`는 실제 호스트 시작 설정에 고정한 엔진 경로 목록이다. 메시지나 모델 응답에서 registry·엔진 경로를 받지 않는다.

아래는 `runtime/examples`에 둔 호스트 모듈을 기준으로 한 호출 예다. 경로와 두 digest는 운영자가 검토한 실제 값으로 넣는다. 이 예제는 실행하지 않았다.

```js
import { rebindRestoredAgentHostIdentity } from '../dist/infrastructure/agent-host-identity-recovery.js';

const expectedBackupDigest = '<검토한 백업의 64자리 SHA256>';
const expectedHeadDigest = '<복원 이전 호스트 registry head의 64자리 digest>';
const hostIdentity = Object.freeze({
  registryDirectory: '/srv/secumon-host/identities',
  engineDirectories: Object.freeze(['/opt/secumon/runtime']),
});

const registered = await rebindRestoredAgentHostIdentity({
  kind: 'local',
  directory: '/srv/agents/operator',
  backupDirectory: '/srv/backups/operator-verified',
  operationId: `local:${expectedBackupDigest}`,
  expectedBackupDigest,
  expectedHeadDigest,
  offline: true,
}, hostIdentity);

// 호스트 관리 화면에는 등록 결과만 표시한다. 업무를 자동 재개하지 않는다.
console.log({ agentId: registered.record.identity.agentId, headDigest: registered.digest });
```

로컬 백업은 `restoreAgentBackup`이 남긴 `.secumon-local-restore-complete.json`의 결정적 operationId를 사용한다. PostgreSQL 백업은 `kind: 'postgres'`와 `restoreAgentPostgresBackup`에 실제 전달했던 복원 operationId를 사용한다. **PostgreSQL 백업 생성 operationId와 복원 operationId는 다르다.** PG 완료 기록은 `.secumon-postgres-restore-complete.json`이다. 두 종류 모두 `.secumon-restore-in-progress.json`이 남아 있으면 거절한다.

adapter는 다음 경계를 유지한다.

- 기존 inspect 함수로 archive manifest·data 파일을 다시 읽으며, PostgreSQL은 각 transfer page의 원문 SHA·크기·행 수·manifest도 검증한다. 현재 로컬 파일은 백업 entries와 일치해야 한다. 기존 백업에서 제외한 유지보수/runtime lease·SHM과 해당 완료 marker만 별도로 취급한다.
- 원 identity와 config identity, agentId, originalRoot, engine pin, 완료 operation, backup digest가 모두 일치해야 한다. registry 게시 전후에도 원문과 현재 디렉터리 객체, 소유한 유지보수 lease를 재검사한다. 큰 백업은 기존 1 GiB/file·4 GiB/tree 한도 안에서 스트림으로 반복 확인하므로 비용이 파일 총량에 비례한다.
- 기존 runtime 또는 maintenance lease가 있으면 거절한다. 죽은 PID라도 여기서 lease를 회수하지 않으며, 알 수 없는 잠금·pending·원 백업을 삭제하지 않는다.
- 기대 head가 달라지면 거절한다. 게시 결과가 불명확할 때는 등록 이력을 확인하고, 동일 복원 operation·backup·이전 head로 재호출한다. helper가 이미 게시한 동일 재등록 기록을 확인할 수 있으며 다른 작업을 강제로 덮어쓰지 않는다. 종료 오류는 원 실패와 함께 보존한다.

완료 marker가 없는 과거 로컬 복원은 이 API로 등록할 수 없다. 새 완료 기록을 남기는 명시 복원 경로가 필요하며, adapter가 과거 성공을 추정하거나 marker를 만들어 주지 않는다. 복원 이후 원 파일에 새 쓰기가 생긴 경우에도 전체 대조가 거절할 수 있다.

이 API는 외부 PostgreSQL에 접속하지 않는다. snapshot 원문과 기존 복원 완료 기록의 연결을 검증할 뿐, 현재 외부 DB 행이나 보관된 backup 이후의 잊기·철회를 새로 입증하지 않는다. 복원 시에는 [PostgreSQL 백업·복원 계약](../../design/chapters/C10-postgres-backup-implementation.md)의 별도로 보존한 restore floor와 대상 DB 검증이 필요하다. 재등록이 성공해도 미확인 효과와 업무 상태는 기존 runtime recovery의 책임으로 남는다.

구현만 연결했으며 실제 복원·registry 게시·동시 경합·Windows·DB 시험과 빌드는 이 작업에서 실행하지 않았다.
