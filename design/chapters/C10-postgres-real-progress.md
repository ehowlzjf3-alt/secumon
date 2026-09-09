# 실제 PostgreSQL 인수 진행 기록

2026-09-09 · checkpoint405 정상 경로 검증 완료, 기존 복구/실환경 분기 미완료. 직전 goal turn은 checkpoint404 제품 변경·시험·결과·원격 push를 완료한 progress였다. PostgreSQL 실환경을 외부 연결 없이 실행할 수 있는지 확인했고 NAS에 기존 PostgreSQL 15.18 서버 실행 파일이 있어 진행한다. 전체 goal은 active다.

## 현재 확인한 환경

- macOS Docker CLI는 있으나 Desktop daemon socket은 없음. 실행하거나 설정을 바꾸지 않음.
- NAS PostgreSQL 15.18, 별도 Node 24.20.0, 선택 호스트 driver `pg@8.23.0`을 사용. driver는 별도 package/lockfile에 고정했고 install script를 실행하지 않음.
- 첫 NAS 홈 디렉터리는 `stat`상 0777이어서 initdb가 부트스트랩에서 거절함. 원 실패 로그는 `runtime/evidence/C10-postgres-initdb-home-failed.log`에 보존. 제품 실패가 아니라 시험 데이터 디렉터리 준비 실패임.
- 새 `/tmp/secumon-postgres-405.sJ1Huq`와 socket/cases는 실제 0700. initdb 성공. TCP listen address는 빈 문자열이며 Unix socket으로만 실제 연결·bound parameter 왕복을 확인함.
- source/restore를 나눈 빈 DB 4개를 새 cluster에 생성: `secumon405_sqlite_source`, `secumon405_sqlite_restore`, `secumon405_journal_source`, `secumon405_journal_restore`.

## 이어받을 때 필요한 현재 핸들

이 경로는 이번 개발 시험의 임시 자원이며 운영 기본 설정이 아니다. 먼저 `pg_ctl status`로 실제 상태를 확인하고 살아 있는 서버를 중복 실행하지 않는다.

- NAS private root: `/tmp/secumon-postgres-405.sJ1Huq`
- NAS runtime: `/home/shaneee/secumon-postgres-405.i3T9d0/runtime` — checkpoint404의 복사본. 기존 runtime은 보존했다.
- NAS Node: `/home/shaneee/secumon-linux-test.pCJ0bd/node-v24.20.0-linux-x64/bin/node`
- NAS pg_ctl: `/usr/lib/postgresql/15/bin/pg_ctl`
- NAS data: private root 아래 `data`; Unix socket: `socket`; port identifier: `55405`; user: `secumon_acceptance`
- NAS host driver manifest: private root 아래 `host/package.json`; cases/logs: `cases`, `evidence`
- 마지막 실제 관측: postmaster PID `1931931`, `pg_ctl status`가 running으로 확인됨.
- 로컬 전용 SSH control socket: `/tmp/secumon-pg-environment.CfoEjq/control`. 인증정보는 저장하지 않았다.
- 종료 명령: `pg_ctl -D /tmp/secumon-postgres-405.sJ1Huq/data -m fast -w stop`을 NAS에서 실행한다. 원문/백업/실패 자료는 보존한다.

## 현재 구현·검증 상태

제품 소스 변경과 새 빌드는 아직 없다. main `C10-postgres-real-fixture.mjs`와 실제 엔진 helper `C10-postgres-real-engine-fixture.mjs`는 작성·동결했고 로컬 syntax check를 통과했다. NAS source/compiled/native 지문은 `runtime/evidence/checkpoint405-build.json`에 기록했다. 실제 DB 환경 연결 성공을 migration/backup/restore/engine 관리 인수 통과로 세지 않는다.

SQLite 첫 실행은 0.33초에 `seed_local_originals` 단계에서 `ENOENT`로 종료했다. 원 로그는 `runtime/evidence/C10-postgres-sqlite-run1-failed.log`에 보존했다. NAS runtime 복사본의 필수 `guidance/` 디렉터리가 없었다. `openAgentLocalProfile → composeRuntime → GuidanceCatalog.create → FileGuidanceSource.listSnapshot → guidance/catalog.json 읽기` 경로와 부합하며 PG 이행을 시작하기 전이다. 제품 오류로 표시하지 않는다.

누락된 guidance 두 파일을 현재 로컬 runtime에서 NAS의 이번 복사본에 보충했다. 양쪽 SHA256은 catalog.json `f1b628d9d062d9d9c3ac2eadb2e962fcf46fd0c9b6e0fb1ffee96d4084add1fa`, evidence-review.md `e3c770b05cef3d9e96c5992d399d3c8eef0a238ab03cd8f9bd5c57bd47b81315`로 각각 일치한다. 보충 후 실제 DB 흐름은 아직 재실행하지 않았다. 실패한 담당 디렉터리는 보존한다.

다음 행동: 새 case 디렉터리에서 SQLite source/restore 한 흐름 실행 → 관측된 실패만 수정하거나 file-journal 흐름으로 이어감. 최초 실패는 PG 준비 이전이므로 기존 source/restore DB는 이행에 사용되지 않았다. 기존 로컬 전체 시험은 반복하지 않는다. V10-06~08/18의 미실행 중단·COMMIT 불명·동시성·운영 분기는 별도로 보존한다. 실제 모델/API 시험 중단을 유지한다.

## 남은 확인 범위에 대한 사용자 답변

checkpoint404 기준 기존 명명된 로컬 인수는 끝났다. 현재 진행 가능한 실제 PostgreSQL은 SQLite와 file-journal 두 원본 경로의 이행·재접속·엔진 관리·백업/복원 묶음이 남았다. 그 밖에는 Windows, 사내 MCP/Knox/A2A, 실제 앱 조작, 운영 규모와 시범 운영 조건이 필요한 인수가 남는다. 첫 실제 DB 흐름이 아직 통과하지 않았으므로 완료 시간이나 전체 완료율을 추정하지 않는다. 이 질문을 검증 중단 또는 새 검증 범위 추가로 해석하지 않는다.

## 재개 후 실제 관측

직전 turn은 누락된 guidance 파일을 보충하고 원 실패 로그·진행 기록을 저장한 progress다. 현재 서버 PID 1931931의 실행 상태를 다시 확인한 뒤 이어갔다.

- SQLite run2는 prepare/apply·같은 operation·PG 재열기·원문/기억/세션/영수증 보존·과거 writer 차단·중복 run 무변경을 지나 엔진 bundle 단계에서 종료했다. `lifecycle_directory_unsafe`와 stack은 홈 NAS runtime의 0777 권한 거절을 가리킨다. 원 로그 `C10-postgres-sqlite-run2-failed.log`를 보존한다. 흐름 전체 통과는 아니다.
- 실제 설치 bundle은 현재 사용자 외 쓰기 권한과 symlink를 허용하지 않는다. 이번 runtime을 `/tmp/secumon-postgres-405.sJ1Huq/runtime`에 복사하고 외부 쓰기/읽기 권한을 제거했다. node_modules 링크는 새 복사본 안의 실제 파일로 복사했다. 기존 엔진·의존성은 수정하지 않았다. runtime/node_modules/guidance의 0700을 확인했다.
- SQLite run2 담당과 DB를 보존하고 새 run3 case와 전용 DB `secumon405_sqlite3_source`, `secumon405_sqlite3_restore`로 실행 중이다. 실행 핸들/서버를 확인하지 않고 중복 시작하지 않는다. main fixture는 제한된 오류 코드·stack과 이행 단계 통과 요약을 추가해 다음 실패 시 이미 도달한 경계를 남긴다. 제품 소스·컴파일 변경은 없다.

현재 실제 실행 runtime 경로는 위 private root의 `runtime`이다. 다음 재개는 run3 로그와 실행 상태를 먼저 확인한다.

## 최종 관측

SQLite run3와 journal run2는 모두 exit0으로 전체 정상 흐름을 통과했다. journal run1은 원행 순서 차이의 시험 가정 실패였고 실제 원행 대조로 설명됐다. 교정한 비교 helper는 실패 journal과 이미 성공한 SQLite 원본에서도 확인했다. 제품 소스 변경0, build/core/전체 회귀 반복0이다. [최종 결과](C10-postgres-real-result.md)와 [checkpoint405](../../runtime/evidence/checkpoint405.json)를 현재 정본으로 따른다.

전용 PG 서버는 정상 종료했으며 status exit3/no server running, PID1931931 및 postmaster.pid 부재를 확인했다. 전용 SSH master도 종료하고 로컬 socket 폴더를 제거했다. 임시 data/runtime/cases는 보존했다. 위 중간 핸들은 모두 과거 기록이며 살아 있는 작업을 뜻하지 않는다. 후속 기존 PG 분기를 진행할 때는 해당 서버의 현재 상태를 먼저 읽고 필요한 경우 명시 시작한다.
