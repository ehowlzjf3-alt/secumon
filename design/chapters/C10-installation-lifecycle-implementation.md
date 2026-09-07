# C10 설치·명시 업데이트·운영 복원 구현 메모

2026-09-08. 구현 우선 단위이며 상세 검증, 실제 배포·운영 이관 완료 기록이 아니다.

`secumon-agent lifecycle help`에 실제 로컬 제품 경로를 추가했다. `bundle`은 현재 빌드된 엔진, 고정 package/lock, 실행 의존성, UI 및 guidance/fixture 자산을 새 디렉터리로 복사하고 SHA256 manifest를 마지막에 게시한다. `install --digest`는 전달받은 묶음 전체를 대조한 뒤 새 경로에 설치한다. 네트워크·패키지 설치 프로세스는 실행하지 않는다. Node >=24.20.0 <25와 묶음을 만든 OS/CPU가 일치해야 한다. release digest가 실제 파일 내용을 고정하며 package의 개발 버전 문자열만으로 동일성을 판단하지 않는다. `npm run bundle:offline -- --destination ...`은 빌드 후 사용할 수 있다.

로컬 저장소의 `pin`/`update`는 기존 config를 덮어쓰지 않고 `.secumon/engine-pins/00000001.json`부터 이전 영수증 지문을 잇는다. update는 현재 release SHA, 현재와 같은 자료를 가진 백업, 대상 배포/설정/SQLite·file-journal·문서 형식 호환을 요구한다. 같은 release의 다른 설치 경로도 실행할 수 있다. 엔진 되돌리기는 같은 명시 update 경로이며 저장 자료를 되돌리지 않는다. 현재 지원되지 않는 저장 형식은 거절하며 임의 SQL 변환을 수행하지 않는다. 실제 저장 스키마 전환은 기존 저장소의 제한된 이행 경로를 유지한다. PostgreSQL 선택 담당도 checkpoint367에서 별도 호스트 check/pin/update를 연결했다. PG 지원 선언·실제 등록/버전·결합 백업을 확인하며 상세 결과는 [PG 엔진 전환](C10-postgres-engine-implementation.md)에 있다.

일반 `openAgentStores`는 bind 이전에 실행 lease와 버전 gate를 통과하고, 저장소 close가 모두 성공한 뒤 자기 lease를 해제한다. 유지보수는 gate 게시→현재 lease 부재 확인으로 새 open과 상호 배제한다. `--offline`은 이 프로토콜을 모르는 구형 엔진·직접 DB writer도 중지했다는 운영자의 명시 확인이다. 기동 중인 외부 프로세스를 강제 종료하지 않는다. crash 후 남은 lease는 `recover-leases --offline`에서 같은 host의 PID가 실제로 없는 경우만 회수한다. PID 재사용/외부 host는 보수적으로 거절한다.

`backup`은 정본 원문/대화/개인 기억/진행 상태/체크포인트/효과 영수증 및 담당 디렉터리의 나머지 자료를 1MiB 버퍼로 복사하고 복사 전후 tree 지문을 대조한다. SQLite main/WAL/journal은 오프라인 상태 그대로 보존하고 재생성 가능한 알려진 SHM 및 운영 lease만 제외한다. 자료 전체를 메모리 Buffer로 읽지 않는다. 최초 관리작업의 지원 한도는 총 4GiB·파일당 1GiB·100,000항목이며 성능 측정값은 아니다. 링크·특수 파일·타인 소유·공유 쓰기 권한은 거절한다. 백업 manifest가 없는 부분 산출물은 유효한 백업이 아니다.

`restore --digest`는 원 canonical 담당 경로가 존재하지 않을 때만 원 ID와 자료를 복원한다. 복사 중 marker가 일반 profile open을 차단하고 전체 지문/ID 대조 후 marker를 제거한다. 기존 담당 데이터를 삭제하거나 덮어쓰지 않는다. 과거 백업 복원 이후에는 백업 뒤 생성된 자료가 포함되지 않으며 외부 송신/쓰기 효과도 취소되지 않는다. 기존 runtime의 원문·효과 영수증 복구와 현재 권한 검사를 그대로 통과해야 새 실행으로 진행한다. 명령이 자동으로 업무나 모델을 실행하지 않는다.

checkpoint360~366의 구현 정리 기준으로 PostgreSQL 저장소 snapshot과 로컬 원문을 묶는 `backupAgentPostgres`/`restoreAgentPostgresBackup` 및 관리 호스트 입구는 연결돼 있다. [postgres-host.mjs](../../runtime/examples/postgres-host.mjs)의 `backup`/`inspect-backup`/`restore`가 해당 API를 호출하며, 복원에는 호스트가 독립 보관한 `currentFloor`, 명시 provisioning된 대상, 원 담당·원 경로·동일 등록을 요구한다. 같은 operation의 PG 결합 복원 재개도 구현됐고, checkpoint362에서 Windows 복원 후보 이어 쓰기를 연결했다. [PG 백업·복원 상세](C10-postgres-backup-implementation.md) · [checkpoint360 결과](C01-C03-migration-backup-result.md). 실제 PostgreSQL 백업·복원 성공의 증거는 아니다.

이번 지원 범위 밖 추가 운영 기능은 배포물 서명/공급망 신뢰, 임의 외부 모델·도구·채널 시스템 자체의 백업, 확장 플러그인별 버전 이행, live 백업, 다른 canonical 경로로의 담당 이전, 지원한 동일 operation 밖의 임의 부분 복원, 제거 프로그램이다. 실제 CLI·동시성·SIGKILL·용량/오류 주입 및 NAS/플랫폼 상세 검증, 제한 시범과 운영 이관은 별도 미검증 항목이다. 부분 설치·백업·복원은 보존되며 임의 자동 삭제하지 않는다. 구형 DB 복원을 '엔진 rollback'이라고 부르지 않는다.

제품 파일: `application/agent-lifecycle-contracts.ts`, `infrastructure/agent-lifecycle{,-files,-lease}.ts`, `infrastructure/agent-engine-release.ts`, `presentation/agent-lifecycle-cli.ts`; 기존 profile/store/CLI/package는 좁은 연결만 추가했다. 기존 C05 후보·증거·NAS 관리 도구는 수정하지 않았다.
