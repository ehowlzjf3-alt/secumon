# C10 실제 PostgreSQL 중단·재개 인수 범위 감사

2026-09-09 · checkpoint406 · 기존 V10-06/07/08/18의 선택한 복구 분기

**현재 두 구성 모두 실제 NAS PostgreSQL 복구 흐름의 최종 성공을 확인했다.** SQLite recovery run1은 전체 실행으로, file-journal은 최초 실행에서 완료한 이관을 재검증하고 엔진 단계부터 재개해 exit 0과 `postgres_recovery_acceptance: passed`를 기록했다. 로그의 `checks`는 통합 흐름 안의 검사문 목록이며 독립 시험 개수로 합산하지 않는다.

| 구성 | 성공 증거 | 보존 자료 |
| --- | --- | --- |
| SQLite | [recovery run1 전체 성공](../../runtime/evidence/C10-postgres-recovery-sqlite-run1.log) | 업무 2개·업무 영수증 21개·PG 18개 테이블의 67개 행 |
| file-journal | [최초 실행의 이관 성공 및 이후 실패](../../runtime/evidence/C10-postgres-recovery-journal-run1-failed.log) + [이관 재확인 후 resume1 최종 성공](../../runtime/evidence/C10-postgres-recovery-journal-resume1.log) | 업무 2개·업무 영수증 21개·PG 18개 테이블의 71개 행 |

Journal 최초 실패는 `engine_entry_original_record_digest` 비교문에서 발생했다. file-journal의 `StoredEvent`와 PG schema의 `commandId`·`sequence` 속성 순서가 달라 JSON 직렬화 지문이 달랐으며, 앞선 이관의 canonical 비교는 이미 통과했다. 엔진 진입 비교를 `assert.deepEqual`로 교정했다. 재개 시 private `original-records.json`과 저장된 이관 결과, 실제 PG 원행·양쪽 원본 페이지 SHA·해제된 fence를 다시 확인한 뒤 엔진 단계부터 진행했다. 이관과 원 업무를 다시 실행하지 않았고, 실패 로그와 원자료는 보존했다.

두 결과의 제품 build 지문은 같지만 evidence fixture 판본은 다르다. Journal 재개에는 공통 fixture의 재개 입구와 엔진 비교문 교정이 반영되었으며, 각 로그의 `files`에 실제 사용 파일 SHA가 남아 있다. 이를 같은 fixture 판본의 두 전체 실행으로 합치지 않는다. 보고서의 `originalRecordsDigest`는 **보존한 기준 records의 JSON 직렬화 지문**이며 속성 순서와 무관한 내용 지문이 아니다. 복구 후 records 동일성은 구조 비교로, 원행과 페이지 무결성은 별도 원자료 비교와 SHA로 확인했다.

[checkpoint405 정상 흐름](C10-postgres-real-audit.md)은 기존 증거로 유지한다. 이번에는 [기존 인수 조건](C06-C10-verification-plan.md)의 남은 중단·재개 분기를 [공통 fixture](../../runtime/evidence/C10-postgres-recovery-fixture.mjs), [이관](../../runtime/evidence/C10-postgres-recovery-migration.mjs), [엔진 관리](../../runtime/evidence/C10-postgres-recovery-engine.mjs), [백업·복원](../../runtime/evidence/C10-postgres-recovery-backup.mjs)으로 확인했다. 새 제품 기능이나 인수 요구를 추가한 기록이 아니다.

| 기존 조건 | 이번 두 구성의 실제 실행·재개로 추가 입증한 범위 | 검증 결과의 적용 한계(추가 필수 목록 아님) |
| --- | --- | --- |
| V10-06 이관 | prepare 기록 게시 뒤 응답 예외, 실제 import COMMIT 뒤 응답 예외, 첫 channel SQLite 원자료 쓰기 차단 뒤 예외, activation 게시 뒤 예외에서 같은 operation으로 재개. 원 snapshot·operation·activation·업무/기억/대화 영수증·세션/compact 원자료를 유지하고, 대기/불명 상태에서 일반 open과 DB 접근을 차단. | 모든 원자료의 모든 중간 쓰기 지점, file-journal format/header 자체의 부분 게시, 실제 과거 엔진 실행에 대한 installation 2 차단. 첫 원자료 차단 지점은 channel SQLite이며 journal header 중단 시험으로 바꾸지 않는다. |
| V10-07 백업 | export 첫 페이지 뒤 별도 연결에서 유효한 임시 session alias를 실제 commit해도 진행 중 snapshot은 원 시점을 유지하고 새 조회만 변경을 관측. 임시 행은 정확히 삭제해 원자료를 복원. 백업 중 정상 저장 API 쓰기는 maintenance로 거절. 원문·전체 페이지 복사 후 manifest 게시 전 예외에서 미완성 폴더를 보존하고 백업 검사를 거절. maintenance 획득 COMMIT 뒤 응답 예외에서 fence를 유지하고 같은 operation으로 재개. | 용량 경계·운영 규모, 로컬 원문이 동시에 변경되는 경우의 결합 백업 재검사, 모든 중간 파일 쓰기/정리 지점. 이번 미완성 백업은 증거로 보존했으며 실패 폴더 자동 삭제를 입증한 것이 아니다. |
| V10-08 복원 | 빈 별도 DB에 실제 import COMMIT 뒤 응답 예외를 주입. 진행 marker·operation·nonce와 DB fence 유지, `agent_restore_incomplete`로 일반 open 거절, 같은 operation 재개 후 중복 행 없음. 명시 rebind와 새 원자료 대조 뒤 업무·기억·대화·context 원자료 재열기. 마지막 과거 migration apply는 `agent_postgres_migration_receipt_missing`으로 거절하며 원 업무 영수증을 보존. | 로컬 파일 복사 도중 모든 중단점, 늦은 실제 외부 효과·삭제/철회 대조, 운영 host floor의 최신 권한 판단. 복원 후 중복 run 명령 자체를 다시 실행한 검증은 아니다. |
| V10-18 PG 엔진 관리 | 실제 DB installation/binding 버전 불일치, PG 선언 없는 release·선택 purpose 미지원 거절. 기존 local/DB maintenance 소유자를 보존하며 관리 명령 거절. 새 pin 게시 후 fence 해제 transaction의 COMMIT 전 예외에서 실제 pin/head와 남은 fence를 확인하고, 같은 operation의 check로 새 pin 없이 fence 해제. PG·로컬 원문·등록·결합 백업 보존. | no-replace pin 파일 게시 도중 모든 중단점, 실제 엔진 해제 COMMIT 성공 뒤 응답 유실, 선택하지 않은 모든 혼합 저장 구성, 프로세스 간 동시 관리 경합의 모든 지점. |

예외의 의미를 구분한다. 이관 import·백업 maintenance 획득·복원 import는 **실제 COMMIT 성공 뒤 호스트 래퍼가 응답 예외를 발생**시켰다. 엔진 관리는 실제 fence 해제 UPDATE 뒤 **COMMIT을 보내기 전에 예외**를 발생시켜 실제 DB에서는 ROLLBACK했다. 후자를 “엔진 COMMIT 성공 뒤 응답 유실”로 기록하지 않는다. 파일 관련 지점도 기존 파일 API에서 예외를 주입했으며, 실제 SIGKILL·네트워크 단절·전원 장애를 실행한 것은 아니다.

**마지막 fence는 성공 판정과 별개다.** 복원·rebind·새 원자료 대조·정상 재열기를 확인한 다음, 과거 migration apply 거절을 마지막에 시험했다. 이 기존 계약은 과거 operation의 DB maintenance를 획득한 뒤 관리 영수증 부재로 거절하며 fence를 남긴다. 최종 로그의 `finalRestoredFences`는 따라서 비어 있지 않다. 원 업무 영수증이 유실되었다는 뜻도, 최종 복원 DB가 일반 가동 가능한 상태라는 뜻도 아니다. fixture는 이를 임의 해제하거나 완료로 간주하지 않았다. 원 source DB의 fence는 정상 해제된 상태다.

실제 모델/API·사내 서비스 효과 대조·native Windows·운영 용량·SIGKILL·전원 장애는 이번에 수행하지 않았다. reconciliation은 실제 PG와 보존된 로컬 합성 read/channel 원자료를 조회해 비교했으며, 사내 서비스 대조로 확대하지 않는다. 이번 감사 문서 작성에서는 기존 로그와 코드를 읽어 기록만 했고, 제품 수정·추가 실행·V10 전체 완료 판정은 하지 않았다.

현재 환경의 다음 필수 검사는 기존 V10-07 전체 전달 64MiB 한도 한 묶음이다. 위의 미관측 syscall·모든 혼합 구성·물리 장애를 새 필수 검사로 확장하지 않는다. 해당 한 묶음 이후에는 [남은 확인 목록](../REMAINING-ACCEPTANCE.md)의 선택 운영·외부 환경 인수를 구분해 남긴다.
