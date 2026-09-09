# PostgreSQL 복구 조건 진행 기록

2026-09-09 · checkpoint406 실행·결과 기록 완료. 기준 커밋 b9bb7b5bef4db393ac2b3e673041c3f7fd4898fc. SQLite 전체 실행과 journal 단계 재개가 성공했고 서버·SSH를 종료했다. 아래 중간 핸들과 실행 상태는 당시 기록이며 다시 실행하는 지시가 아니다. 최신 상태는 마지막 절과 결과 문서를 따른다.

## 현재 환경과 실행

- 새 전용 SSH master: `/tmp/secumon-pg-recovery.zafd5Z/control`. 인증정보는 파일에 저장하지 않았다. 최초 BatchMode 접속은 인증 실패했고 기존 승인된 계정으로 연결했다.
- 보존된 PG data: `/tmp/secumon-postgres-405.sJ1Huq/data`. 이전 서버 종료 상태를 확인한 뒤 명시 시작했고 현재 관측 PID는 1941468이다. 서버 로그는 private root의 `evidence/server406.log`다.
- runtime: `/tmp/secumon-postgres-405.sJ1Huq/runtime`, Node `/home/shaneee/secumon-linux-test.pCJ0bd/node-v24.20.0-linux-x64/bin/node`. PG15.18·별도 pg8.23.0·private Unix socket만 사용한다.
- 현재 SQLite source/restore DB: `secumon406_sqlite_source`, `secumon406_sqlite_restore`. 이전 정상/실패 DB는 유지했다.
- 첫 case: private root의 `cases/recovery-sqlite-run1`, 로그 `evidence/recovery-sqlite-run1.log`. 시작 후 terminal handle 43281을 받았다. 다음 행동은 이 핸들/로그의 실제 상태 확인이며 관측 지연만으로 다시 시작하지 않는다.

## 동결된 실행기

`C10-postgres-recovery-fixture.mjs`가 공통 원자료·실제 pool·오류 주입/조회·결과를 관리한다. 이행/엔진/백업 모듈을 작성·동결하고 구문 확인 후 NAS에 전달했다. 실제 실행은 직렬이다. 제품 소스와 컴파일 변경, 새 build/core/전체 회귀 실행은 없다.

공통 실행기는 시작 시 source/build 및 네 실행기 지문을 로그에 남기고, 원문 전체는 private case의 `original-records.json`에 보존한다. 이행·엔진 단계를 통과하면 각 결과도 따로 저장한다. 단계 중단의 증거와 전체 정상 종료를 구분한다.

복원 뒤 마지막 옛 migration apply 거절은 원 업무 자료를 지우지 않지만 과거 operation의 DB fence를 남기는 기존 계약이다. 시험이 통과해도 그 fence를 임의 해제하지 않는다. 후속 원자료 조회는 같은 operation의 명시 maintenance 읽기와 구분한다.

실제 모델/API 중단, 기존 성공 경로 비반복, 원 실패/자료 보존을 유지한다. 종료 시 이번 서버와 SSH를 정리하고 관측값을 갱신한다.

## 첫 실제 결과

SQLite recovery run1은 전체 exit0이다. 같은 operation의 네 이행 경계, 실제 schema/지원선언/관리잠금 거절, pin 게시 후 COMMIT 전 예외와 check 회복, snapshot 중 동시 commit, manifest 마지막 게시, 백업·복원 COMMIT 응답 예외와 재개, 원 업무/기억/세션/영수증 보존까지 통과했다. 원 로그는 `runtime/evidence/C10-postgres-recovery-sqlite-run1.log`에 저장했다.

file-journal DB 생성 때 처음 입력한 socket 경로에 `405-405` 오타가 있어 접속 실패했다. DB를 생성하기 전 실패이며 경로를 고쳐 `secumon406_journal_source` / `secumon406_journal_restore`를 만들었다. 제품/시험 실패로 세지 않는다. 현재 `cases/recovery-journal-run1`을 같은 동결 실행기로 수행 중이고 terminal handle은 90746, 로그는 private root의 `evidence/recovery-journal-run1.log`다.

제품 변경·재빌드·통과한 정상 흐름 재실행은 없다. SQLite 중단/재개 모듈 구간은 약0.683초, 엔진 약12.540초, 백업/복원 약4.362초로 관측했다. 단회 시험 구간 시간이며 전체 업무 응답·운영 성능 지표가 아니다.

## Journal 비교 교정과 단계 재개

Journal 첫 실행은 이행의 네 경계와 최종 canonical 원자료 대조까지 통과한 뒤 `engine_entry_original_record_digest`에서 실패했다. 원 로그는 `C10-postgres-recovery-journal-run1-failed.log`에 보존했다. FileJournal의 StoredEvent 구성은 commandId→sequence, PG schema의 재구성은 sequence→commandId 순서이므로 같은 값도 JSON.stringify 기반 지문은 달라진다. 엔진 진입 비교만 deepEqual로 바꿔 값·타입·배열 순서·원문을 비교하고, 보존한 원본 JSON의 보고용 지문은 유지했다.

공통 시험 실행기에 `SECUMON_PG_RESUME_AFTER=migration` 한 단계의 명시 재개를 추가했다. 기존 case·agentId·backend·네 경계 결과·activated operation, 보존 원본 지문·현재 PG 원행·원본 페이지 SHA·fence 해제를 확인하고 기존 이행을 다시 실행하지 않는다. 엔진 단계가 아직 시작되지 않은 case에만 적용한다. 새로운 제품 resume API가 아니다.

현재 재개는 같은 case와 DB 쌍이며 로그는 private root의 `evidence/recovery-journal-resume1.log`, terminal handle 51963이다. 보존한 SQLite 전체 통과도 반복하지 않는다. 실제 재조회에서 deepEqual이 통과하면 위 속성 순서 원인이 확정되며, 그 전까지 전체 journal 복구 성공으로 세지 않는다.

## 최종 상태와 다음 한 묶음

Journal resume1은 exit0이며 실제 PG 원자료의 구조 비교와 원본 페이지 SHA/행 대조를 통과했다. 첫 실행에서 통과한 이행 결과와 재개 결과를 함께 보존했다. 제품 소스 수정·재빌드·전체 회귀·SQLite 성공 경로 반복은 없다. 최종 macOS/NAS 소스·컴파일 지문과 실행기 다섯 파일이 일치한다. [checkpoint406](../../runtime/evidence/checkpoint406.json)에 실제 판본·결과·한계를 기록했다.

PG fast stop exit0, 후속 status exit3(`no server running`), 기존 PID1941468 및 postmaster.pid 부재를 확인했다. 전용 SSH master와 로컬 control 디렉터리도 종료·제거했다. 두 source DB의 fence는 해제됐지만 마지막 과거 migration apply 거절로 복원 DB의 원 operation fence는 보존했다. 이를 일반 가동 가능한 상태로 표시하지 않는다. 원문·DB·성공/실패 로그·백업은 NAS private 임시 경로에 남았다.

**현재 준비된 환경의 남은 기존 필수 검사는 V10-07의 PG 전체 전달 64MiB 한도 한 묶음이다.** 실제 `sessions.receive`에 유효한 pending 입력을 저장하고 백업이 `postgres_transfer_limit`으로 거절되는지, 원자료와 미완성 백업이 보존되는지 확인한다. 예비 구성은 입력당 `'가'.repeat(100000)`의 UTF-8 300,000바이트이며 224개면 텍스트만 67,200,000바이트로 한도를 넘는다. 현재 scope·goal revision과 기존 Sha256Digester를 사용하고 입력을 적용·실행·정산하지 않는다. 새 실행 때 보존된 환경 존재와 서버 상태를 먼저 확인한다.

이 한 묶음과 기록·Git 마무리 후 현재 환경에서 가능한 검증을 마감한다. Windows·운영 PG 역할/TLS·사내 MCP/Knox/A2A·실제 앱·운영 규모/복구 목표·선택 시범 운영은 기존 외부 인수로 남는다. 실제 모델/API는 중단 상태다. 모든 파일 쓰기 지점이나 혼합 조합을 새 필수 검사로 늘리지 않는다. 전체 goal은 active이며 외부 인수 완료로 표시하지 않는다.
