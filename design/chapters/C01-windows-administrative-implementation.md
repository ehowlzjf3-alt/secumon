# Windows 공유 저장소·이관·복원 연결

2026-09-08 · checkpoint362. C06~C10 구현 우선 방침에 따라 checkpoint361에서 남긴 Windows 저장소 연결 네 항목을 작성했다. 실제 Windows 실행과 동작 검증은 이후에 수행한다.

| 연결한 범위 | 구현 내용 |
| --- | --- |
| 공유 게시판·knowledge·아카이브 | 기존 등록 factory에서 native SQLite guard와 파일 stream을 사용한다. 원문·영수증·개인 저장소 격리는 유지한다. [상세](C07-windows-shared-storage-implementation.md) |
| 개인 기억 snapshot·fence·백업·이관 | 실제 SQLite 연결이 원 파일을 보유하며, backup 함수는 내부 원 연결을 사용한다. 검증한 candidate를 같은 객체로 게시하고 기존 완료 영수증과 연결한다. [상세](C03-windows-memory-migration-implementation.md) |
| PostgreSQL 이관의 로컬 원본 | [postgres-transfer.ts](../../runtime/src/infrastructure/postgres-transfer.ts)의 SQLite 연결·저널 원문 읽기와 [agent-postgres-migration.ts](../../runtime/src/infrastructure/agent-postgres-migration.ts)의 원 저장소 쓰기 차단을 Windows 파일 경계에 연결했다. |
| 같은 복원 작업 재개 | 원 복원 marker와 backup digest로 후보 이름을 정하고, 원문과 후보의 정확한 앞부분을 대조한 뒤 이어 쓴다. 일반 복원과 PostgreSQL 결합 복원에 연결했다. [상세](C10-windows-pending-recovery-implementation.md) |

## 저널 형식 전환

이관 작업에 저장된 원 `format.json`의 길이·SHA256을 확인한다. 원 파일을 같은 디렉터리의 작업별 보존 이름으로 옮긴 뒤 새 형식을 게시한다. 두 단계 사이에 멈춰도 같은 이관 작업의 원본·후보·최종 파일을 다시 대조할 수 있다. 기존 자료의 revision과 원 영수증을 다시 만들지 않는다.

재개는 저장한 source manifest와 같은 자료에만 허용한다. 복구 과정에서 만든 것으로 입증한 보존 원본·후보만 기존 manifest의 형식 파일 위치로 환산한다. 다른 자료 변경이나 정식 파일과 후보의 동시 존재는 충돌로 남긴다. 새 형식이 확인되기 전에는 PostgreSQL 이관의 유지보수 차단을 풀지 않는다.

## 공통 경계

기존 native addon에 ABI4를 추가했다. `recoverableCandidate`는 기존 후보의 객체 식별자·길이·변경 표식이 모두 같을 때만 이어 쓰며, `moveRegular`는 원문을 대조한 원 파일을 덮어쓰기 없이 이동한다. `syncRegular`와 `publishExisting`은 검증된 SQLite backup 파일의 동일성을 유지한다. 경로나 파일 handle을 모델 입력에서 받지 않는다.

Windows의 내구성은 기존 **process-crash** 정책이다. 파일 flush와 게시 상태를 기록하지만 directory fsync·전원 장애 내구성을 제공한다고 표시하지 않는다. 일반 stream 파일 1GiB·복원 tree 4GiB·journal 기본 64MiB, 개인 기억 backup 256MiB·4회 시도·60초 한도를 유지했다.

## 확인과 다음 작업

통합 컴파일의 최종 결과·대상 소스·원로그는 [체크포인트](../../runtime/evidence/C01-windows-administrative-checkpoint.json)에 기록한다. Windows 대상 cargo check는 DLL 링크·Node 로드·Windows 실행 시험이 아니다. 실제 DB 이관·backup/restore·상세 회귀·장애 주입·모델/API·사내 서비스·SSH/배포는 이번 단계에서 실행하지 않았다.

checkpoint361의 네 저장소 잔여는 이 단위에서 연결했다. C10 backlog의 **작업공간 중단 복구**는 별도 제품 미구현으로 확인했으며 다음 구현이다. 이미 작성한 C06~C09와 C10 설치·버전·백업의 상세 확인은 [별도 검증 목록](C06-C10-verification-plan.md)에 유지한다. 전체 C01~C10 goal은 진행 중이다.
