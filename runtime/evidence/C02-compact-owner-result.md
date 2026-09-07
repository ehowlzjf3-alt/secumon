# C01 SQLite owner 존재 관측 경합 — C02 회귀 중 최소 수정

관측일: 2026-09-07 KST. 실행 환경: macOS arm64, Node v24.20.0.

## 관측과 원인 구분

- 원 NAS build2 전체 회귀의 `separate CLI processes initializing concurrently settle on exactly one identity`가 `agent_storage_owner_missing`으로 실패했다. 원 CLI는 오류 코드만 출력하므로 NAS에서 실제 throw한 줄은 아직 확정하지 않았다. 이 작업은 NAS를 실행하거나 기존 원격 실행을 변경하지 않았다.
- 로컬 결정적 경계 주입에서는 main 파일의 실제 첫 ENOENT 관측 후 실제 정상 owner DB와 WAL/SHM을 만들고 그 ENOENT를 반환했다. 수정 전 `agentDatabaseExists`가 main 부재와 나중 sidecar 존재를 혼합해 `agent_storage_owner_missing`을 던지는 것을 stack으로 확인했다.
- `SqliteSessionRepository`의 compact 추가 스키마는 첫 요약 게시에서만 생성하며 CLI `init`은 이를 호출하지 않는다. 현재 증거는 기존 파일 존재 관측 문제이며 compact migration의 직접 실패를 나타내지 않는다.

## 변경 범위

- `src/infrastructure/agent-database-owner.ts`: 처음 main 관측이 없었던 경우에만 sidecar 검사 후 동일 `checkFile`로 main을 한 번 더 확인한다. 일반 파일/단일 링크/private mode/UID 검사를 유지한다. SQL owner 판정, 초기화 권한 marker, 기존 파일의 identity 검사, SQLite transaction 및 WAL 정책은 변경하지 않았다.
- `src/tests/agent-database-owner.test.ts`, `src/tests/helpers/agent-database-owner-worker.ts`: 기존 fixture에 5개 경계 시험 추가. 정상 경합은 state/memory/channel 각각 검증한다.
- 그 외 제품 소스는 변경하지 않았다. 이 문서와 실행 스크립트, 로그, exit, pin 및 manifest만 evidence에 기록했다.

시험 주입은 격리 subprocess의 lstat/owner 조회 반환 경계에 한정된다. 파일 생성·삭제와 SQLite owner/WAL은 실제 로컬 파일시스템에서 수행했다. 정상 경합의 경쟁 주체를 별도 프로세스로 실행한 시험은 아니며, 기존 8개 CLI 프로세스 초기화 회귀도 별도로 함께 통과했다.

## 실행 결과

| 실행 | 결과 | 증거 |
|---|---|---|
| 최초 baseline build | exit 2: 새 시험 worker의 `StatementSync.all` overload 타입 오류 1건 | `C02-compact-owner-baseline-build-type-error1.log`, `-exit.json` |
| 시험 wrapper 타입 수정 후 baseline build | exit 0 | `C02-compact-owner-baseline-build.log`, `-exit.json`, `-pin.json`, `-manifest.json` |
| 정상 경합 시험만 baseline 실행 | 1개 중 1개 예상 실패, exit 1; stack의 `agentDatabaseExists` 확인 | `C02-compact-owner-baseline-race.log`, `-exit.json` |
| 최소 제품 수정 후 fixed build | exit 0 | `C02-compact-owner-fixed-build.log`, `-exit.json`, `-pin.json`, `-manifest.json` |
| 관련 5개 시험 파일 1회 실행 | 43/43 통과, 실패·skip 0, exit 0 | `C02-compact-owner-fixed-tests.log`, `-exit.json` |

첫 빌드 타입 오류는 SQL에 인자를 전달하지 않는 기존 호출에 맞춰 인자 없는 wrapper로 수정했다. 실패 로그를 별도로 보존했으며 성공으로 집계하지 않았다. 최초 실패 빌드는 build manifest 생성까지 도달하지 않았으므로 해당 시도의 성공 pin은 없다.

수정 전 sourceDigest: `006889e99c19880b8bd55cc100e60f4a5090f5d078920317098e799945863eff`.

수정 후 sourceDigest: `2193685e0a64d0f88e40113b2838afc03c8c24b8430d6a6c36847613b77e0967`.

관련 시험 파일은 agent-database-owner, agent-profile, agent-profile-concurrency, agent-stores, agent-state-binding-recovery이다. 신규 경계는 정상 owner 경합, foreign owner 거절, unowned 업무 데이터 보존/거절, orphan sidecar 보존/거절, 이미 관측한 main 삭제 거절/재생성 없음이다. 기존 POSIX SQLite lock 유지, hot rollback journal 보존, owner snapshot 및 실제 초기화 중단 복구도 이 실행 범위에 포함된다.

전체 로컬 회귀, 추가 NAS 실행, native Windows, 실제 모델/사내 API는 이 단위에서 실행하지 않았다. NAS 원래 실패의 정확한 throw 지점 및 Linux 수정본 회귀는 이 로컬 결과만으로 완료를 주장하지 않는다.
