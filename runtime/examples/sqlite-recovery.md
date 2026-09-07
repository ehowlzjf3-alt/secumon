# 중단된 SQLite의 명시 복구

일반 실행에서 `agent_storage_recovery_required`가 발생해도 자동으로 DB를 수정하지 않는다. 이 관리 경로는 원 DB와 rollback journal이 함께 남아 있는 경우의 정상 SQLite 복구를 지원한다. 운영 담당과 구형 엔진·직접 DB 연결을 중지한 뒤 사용한다.

```sh
secumon-agent lifecycle sqlite-recovery-prepare --directory /srv/agents/agent1 --operation <UUID> --kind state --offline --json
```

`kind`는 `state`, `memory`, `channel` 중 하나다. 파일 경로는 담당 설정에서 결정한다. 출력의 `preparedDigest`, `originalPath`, `candidatePath`와 검증 결과를 확인한다. 이 시점에는 원 DB를 바꾸지 않았다.

```sh
secumon-agent lifecycle sqlite-recovery-apply --directory /srv/agents/agent1 --operation <동일-UUID> --digest <preparedDigest> --offline --json
secumon-agent lifecycle sqlite-recovery-status --directory /srv/agents/agent1 --operation <동일-UUID> --json
```

적용 중 중단되면 같은 UUID와 지문으로 apply를 재개한다. 살아 있는 실행/유지보수 lease는 거절한다. 이전 프로세스 종료를 확인한 뒤 기존 `lifecycle recover-leases --directory ... --offline`을 사용할 수 있지만 이 명령은 SQLite pending 표식을 없애지 않는다. 임의로 pending/journal을 지우거나 새 DB를 만들어 오류를 덮으면 안 된다.

원문과 영수증은 `<담당>/.secumon/sqlite-recovery/<UUID>/`에 남는다. 미완료 원본 복사/후보는 덮어쓰지 않고 다음 빈 시도 폴더를 사용하며 원본/후보 각각 최대 4개다. 적용 때 원 main/journal도 같은 부모의 `.retired-<UUID>` 이름으로 보존한다. 성공한 뒤에도 자동 삭제하지 않는다.

같은 작업의 완료 receipt를 다시 조회하는 것은 현재 DB를 다시 복구하거나 확인하는 행동이 아니다. 원 DB가 이후 정상 업무로 변경될 수 있다. 복구된 업무의 외부 효과와 미확정 사용량은 기존 런타임에서 대조해야 한다.

호스트 프로그램은 `prepareAgentSqliteRecovery`, `applyAgentSqliteRecovery`, `readAgentSqliteRecovery` API를 사용할 수 있다. 앞의 두 API의 마지막 인자는 trusted `{identityRegistryDirectory?: string}`이며 모든 담당에서 같은 호스트 등록 경로를 사용한다. 테스트는 담당·엔진과 분리된 임시 등록 경로를 주입한다. 사용자 메시지나 담당 config로 등록표를 교체하지 않는다.

WAL/SHM 혼합·여러 DB의 super-journal·분실 journal·외부 owner·손상 데이터 salvage는 이 명령의 지원 범위가 아니다. 실제 DB 복구 및 플랫폼 시험은 아직 실행하지 않았으며 [별도 검증 목록](../../design/chapters/C03-sqlite-recovery-implementation.md)을 따른다.
