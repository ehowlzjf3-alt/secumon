# C10 실제 PostgreSQL 인수 범위 감사

2026-09-09 · checkpoint405 · 정상 경로 fixture와 기존 인수 조건의 대응표

**실제 NAS PostgreSQL 정상 경로는 두 backend 모두 최종 성공했다.** SQLite run3와 file-journal run2는 각각 exit 0이며 최종 `postgres_real_acceptance: passed`를 기록했다. 이관부터 엔진 관리·결합 백업·별도 빈 DB 복원·rebind·새 reconciliation·재열기까지 실행했다. 아래 표는 이 정상 경로에서 확인한 범위이며, V10-06/07/08/18의 모든 분기가 완료되었다는 뜻은 아니다.

| 실제 실행 | 개인 기억 | 업무 / 업무 영수증 | PG 페이지 / 행 | 최종 로그 |
| --- | --- | --- | --- | --- |
| SQLite run3 | documents | 2 / 21 | 18 / 67 | [성공 원본](../../runtime/evidence/C10-postgres-sqlite-run3.log) |
| file-journal run2 | SQLite | 2 / 21 | 18 / 71 | [성공 원본](../../runtime/evidence/C10-postgres-journal-run2.log) |

초기 실패도 보존한다. SQLite run2는 NAS 홈 디렉터리 권한 `0777`로 엔진 묶음 준비 중 `lifecycle_directory_unsafe`가 발생했고, 환경 교정 뒤 run3가 통과했다. [실패 원본](../../runtime/evidence/C10-postgres-sqlite-run2-failed.log). journal run1의 페이지 지문 비교 실패는 파일 commit 순서와 SQL key 순서의 차이였다. [실패 원본](../../runtime/evidence/C10-postgres-journal-run1-failed.log). 최종 fixture의 [sameOriginalTransferRows](../../runtime/evidence/C10-postgres-real-pages.mjs)는 양쪽 원본 페이지 SHA를 각각 확인하고, 중복 개수를 유지한 모든 원행을 비교하도록 교정했다. [진단 로그](../../runtime/evidence/C10-postgres-originals-diagnostic.log)는 journal run1과 보존된 SQLite run3 모두 이 비교를 통과했음을 기록한다. 교정 뒤 journal은 전체 run2를 실행했고, SQLite는 전체를 재실행하지 않고 기존 전체 성공과 추가 원자료 진단을 함께 사용한다.

기준은 [V10-06/07/08/18](C06-C10-verification-plan.md), [이관·백업·복원 fixture](../../runtime/evidence/C10-postgres-real-fixture.mjs), [엔진 check/pin/update fixture](../../runtime/evidence/C10-postgres-real-engine-fixture.mjs)이다. 기존 조건을 나누어 기록한 것이며 새 필수 시험을 추가하지 않는다.

| 기존 조건 | 실제 정상 경로에서 입증한 범위 | 이 fixture로 입증하지 않는 기존 항목 |
| --- | --- | --- |
| V10-06 이관 | 같은 operation의 prepare·완료된 apply 재시도, 이관 대기 중 일반 open 차단, PG 원행과 업무·기억·대화 영수증·세션/compact 및 로컬 원문 보존. 선택한 로컬 backend의 과거 writer 거절, 기존 완료 업무의 중복 run에서 상태·영수증·사용량·PG 자료 불변. | prepare/import/원자료 차단/activation 도중 중단 후 재개, 동시 writer·DB 유지보수, 이전 엔진의 installation 2 차단. 완료 후 재시도를 중간 중단 복구로 바꾸지 않는다. |
| V10-07 결합 백업 | 변경이 없는 시험 자료에서 실제 PG snapshot·백업 manifest·각 페이지와 로컬 원문을 대조하고 완성된 백업을 다시 검사. | 동시 변경 중 같은 시점 보장, manifest 마지막 게시의 중단 경계, 중간 파일·실패 정리, 용량 경계, COMMIT 결과 불명 차단. |
| V10-08 복원 | 별도 빈 DB의 같은 등록·원 경로로 복원, 완료된 같은 operation 재시도와 복원 nonce 보존, 원 담당·백업 보존. 명시 rebind 전 및 새 reconciliation 전 일반 open 차단. 대조 후 반복 재열기에서 원 자료·영수증과 PG 내용 불변. | 복원 진행 중 marker 차단·중단 재개, 늦은 외부 효과·삭제/철회 자료 대조, 복원 후 과거 migration 관리 명령 거절. 복원 후 중복 run 명령 자체는 다시 호출하지 않는다. |
| V10-18 PG 엔진 관리 | 실제 installation 2와 선택 purpose의 check, 최초 A pin·동일 pin 무변경, B check/update, 잘못된 expectedPrevious와 과거 pin의 백업 거절. 새 B 백업에 현재 pin 포함, PG·로컬 원문·등록 보존, 정상 관리 종료 뒤 DB 접근 가능. | PG 미지원 release·installation/binding/purpose 불일치 거절, 선택하지 않은 모든 혼합 저장 구성, 동시 local/DB 유지보수 경합, no-replace pin 게시 중단·실제 head 복구·COMMIT 불명 시 fence 유지. |

해석의 한계는 다음과 같다.

- 두 backend는 각각 실제 성공 로그를 갖는다. SQLite 전체 실행과 helper 교정 후 journal 전체 실행·SQLite 추가 진단은 검증 구성이 다르므로 같은 fixture 판본의 전체 재실행으로 합치지 않는다.
- 복원의 host floor는 담당·백업 밖 별도 파일의 일치 입력으로 시험한다. 운영 환경의 최신 삭제·권한 철회 판단을 검증한 것은 아니다.
- reconciliation은 보존한 원 PG 전체 페이지와 로컬 합성 read/channel 원자료를 실제 조회·비교한다. 사내 서비스의 외부 실행·전달 결과 대조로 확대하지 않는다.
- 이 fixture에는 SIGKILL·COMMIT 응답 유실 주입이 없다. 실제 모델/API 및 native Windows 검증도 포함하지 않는다.

이번 감사 문서 갱신에서는 기존 실행 결과만 읽어 반영했다. 제품 변경·추가 시험 실행·V10 항목 전체 완료 판정은 수행하지 않았다.
