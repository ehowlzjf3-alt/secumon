# 실제 PostgreSQL 중단·재개 결과

2026-09-09 · checkpoint406 · 기준 b9bb7b5bef4db393ac2b3e673041c3f7fd4898fc.

**SQLite/file-journal 원본의 기존 PG 중단·동시성·호환 조건을 확인했다.** SQLite run1은 전체 exit0이며, journal은 첫 실행의 이행 통과 결과를 보존하고 비교문 교정 뒤 엔진부터 재개해 exit0이었다. 제품 소스와 core 의존성 변경, 재빌드 및 전체 회귀 반복은 없다.

| 원본 구성 | 원자료 | 검증 구성 |
| --- | --- | --- |
| SQLite + 문서 개인기억 | 업무2·영수증21·세션/compact·18테이블67행 | recovery-sqlite-run1 |
| file-journal + SQLite 개인기억 | 업무2·영수증21·세션/compact·18테이블71행 | recovery-journal-run1의 이행 + journal-resume1 |

검사문 수를 독립 시험 개수로 더하지 않는다. 두 구성 모두 실제 PG15.18과 Node24.20.0, 별도 pg8.23.0을 사용했다. 모델은 기존 합성 제공자만 사용했고 실제 모델/API와 운영 서비스 호출은0이다.

## 이번에 확인한 기존 조건

- **V10-06:** 준비 기록 게시, PG import COMMIT, 첫 channel SQLite retirement COMMIT, activation 게시 뒤 각각 예외를 주입했다. 같은 operation으로 재개하며 원 operation·페이지·업무/기억/대화/영수증·세션/compact를 보존했다. 두 구성에서 첫 purpose 이후의 부분 퇴역을 확인한 것이며 file-journal header의 모든 syscall 경계를 시험한 것은 아니다.
- **V10-18:** 실제 installation/binding 불일치, PG 지원 없는 시험용 release와 선택 purpose 미지원, 기존 local/DB 관리 잠금을 거절했다. pin 게시 후 fence 해제의 UPDATE는 실제 실행하고 COMMIT 전 예외를 주입했다. 실제 pin은 B, DB fence는 원 operation임을 확인하고 같은 operation의 check로 검증·해제했다. 정상 원자료·첫 pin·백업·등록은 보존했다.
- **V10-07:** 첫 snapshot 페이지 뒤 별도 실제 연결에서 유효한 session alias를 추가·commit했다. 기존 snapshot에는 없고 새 snapshot에는 있는 것을 확인한 뒤 정확한 임시 행만 제거했다. 백업 중 정상 writer를 거절했고, 원문/페이지 복사 후 최종 manifest 전에 중단하면 불완전 폴더가 보존되며 유효 백업으로 받아들여지지 않았다.
- **V10-07/08:** DB maintenance 획득 및 복원 import의 실제 COMMIT 뒤 응답 대신 예외를 발생시켰다. 원 fence·복원 진행 marker/nonce·원행을 확인한 뒤 같은 operation으로 백업/복원을 재개했다. 신원 재연결과 새 원자료 대사 뒤에도 원 업무·기억·세션·영수증·백업을 보존했다.
- **V10-08:** 마지막 과거 migration apply는 `agent_postgres_migration_receipt_missing`으로 거절됐다. 원 업무 자료는 그대로이며 복원 DB의 과거 operation fence를 남기는 기존 계약을 확인했다. 그 fence를 임의 해제하거나 일반 운영 가능 상태로 표시하지 않았다. 원 source DB의 fence는 해제됐다.

DB 반영 후 응답 예외와 COMMIT 전 예외를 구별한다. 위는 실제 PostgreSQL에 연결한 client/파일 API 예외 주입이다. 실제 신호 종료·전원 장애·물리 네트워크 단절의 증거로 바꾸지 않는다.

## 관측된 시험 오류와 재개

Journal의 이행 최종 canonical 비교는 통과했지만 engine 진입의 JSON.stringify 지문 비교가 실패했다. FileJournal event의 commandId→sequence 속성 순서와 PG schema의 sequence→commandId 순서 차이였다. 값·타입·배열 순서·원문을 비교하는 deepEqual로 시험 한 줄을 교정했고 제품 digest 계약은 유지했다.

진행 중 보존한 `original-records.json`, `migration-result.json`과 현재 담당/operation·실제 PG 원행·원본 페이지 SHA·해제된 fence를 다시 대조했다. 실제 재조회가 구조 비교를 통과해 속성 순서 원인을 확인했다. 시험용 `SECUMON_PG_RESUME_AFTER=migration`으로 아직 엔진 단계가 시작되지 않은 case만 이어갔다. 이미 통과한 이행과 SQLite 전체 흐름은 반복하지 않았다. 보고된 `originalRecordsDigest`는 보존한 baseline JSON의 지문이며 모든 저장소 재직렬화가 같은 바이트라는 뜻이 아니다.

첫 journal DB 준비의 socket 경로 오타는 연결 전 실패였고 올바른 경로로 바로잡았다. 첫 journal 시험 실패 로그와 재개 로그를 모두 보존했다. 미완료/실패 기록을 성공 횟수로 더하지 않았다.

## 실행본·종료·남은 작업

시작/종료 시 기존 소스 지문 `34d86285b32363dd4d4c498885820725e43cf54b7705bfbca3c0c0883ac0f6a2`, 컴파일 지문 `7e55006e4b89076e3492649aa1234f0ec51ed07492acbd011ef47378a39055d3`, 2,616개 파일의 일치를 확인했다. 마지막 macOS/NAS 실행기 지문도 일치한다. 시작 로그의 판본과 journal 재개 판본은 다르며 미변경 이행/백업 모듈 및 제품 결과는 재사용했다.

두 실행과 DB pool을 종료하고 PostgreSQL을 정상 종료했다. status exit3 / no server running, PID1941468 및 postmaster.pid 부재, 전용 SSH master 종료를 확인했다. 원문·부분/완성 백업·DB·실패 자료는 `/tmp/secumon-postgres-405.sJ1Huq`에 보존했다. 임시 경로라 영구 보관을 보장하지 않는다.

다음 독립 확인은 **기존 V10-07의 PG 전체 전달 64MiB 한도**다. 실제 `sessions.receive`로 유효한 pending 사용자 입력을 저장해 한도 거절·원자료/미완성 백업 보존을 확인할 수 있다. 적용하지 않은 입력을 applied로 표시하지 않는다. 검사 조합을 새로 늘리지 않는다.

운영 자료량·삭제/철회·늦은 실서비스 효과, native Windows, 사내 MCP/Knox/A2A·실제 앱·선택 시범 운영은 현재 결과만으로 완료하지 않는다. 실제 모델/API 시험 중단을 유지한다. 예외 주입의 한계를 새로운 무제한 시험 목록으로 바꾸지 않는다. 전체 C10/goal은 active다.

근거: [checkpoint406](../../runtime/evidence/checkpoint406.json), [SQLite 로그](../../runtime/evidence/C10-postgres-recovery-sqlite-run1.log), [journal 첫 로그](../../runtime/evidence/C10-postgres-recovery-journal-run1-failed.log), [journal 재개 로그](../../runtime/evidence/C10-postgres-recovery-journal-resume1.log), [요구 대조](C10-postgres-recovery-audit.md), [현재 잔여](../REMAINING-ACCEPTANCE.md). 일반 PG 사용 조건은 [기존 사용법](C10-postgres-real-usage.md)을 재사용한다.
