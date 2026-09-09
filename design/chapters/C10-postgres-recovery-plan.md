# 기존 PostgreSQL 중단·동시성 조건 확인

2026-09-09 · checkpoint406 진행 중. 기준 b9bb7b5. 직전 goal turn은 두 실제 PG 정상 흐름·원자료 대조·결과·원격 push를 완료한 progress다. 전체 goal은 active다.

checkpoint405의 정상 흐름을 반복하지 않고, 기존 V10-06/07/08/18에 적힌 미실행 조건만 실제 PG와 기존 API로 확인한다. 제품 수정은 실제 실패가 확인됐을 때만 한다. 새로운 가상 경계나 운영 요건은 추가하지 않는다.

- **이행:** 같은 준비 담당에서 prepare 게시 후, import COMMIT 후, 첫 원 저장소 쓰기 차단 후, activation 게시 후 예외를 순서대로 주입하고 같은 operation으로 재개한다. SQLite와 file-journal 원본의 업무·영수증·세션/compact·기억을 대조한다. 이미 퇴역한 한 purpose 이후 재개와 journal header의 특정 syscall 중단은 구분한다.
- **엔진:** 실제 installation/binding 및 시험용 PG 지원 선언 불일치, local/DB 관리 잠금, pin 게시 후 해제 COMMIT 직전 예외와 실제 head/fence 조회·같은 operation의 check 회복을 확인한다. 필요한 최초 pin/현재 백업/update만 수행한다. 실제 COMMIT 성공 후 오류와 COMMIT 전 오류의 DB 결과를 혼동하지 않는다.
- **백업·복원:** snapshot 중 별도 연결의 정확한 시험행 추가/제거, 정상 writer의 maintenance 거절, manifest 게시 전 예외와 부분 폴더 보존, 유지보수 획득 COMMIT 후 예외·같은 백업 operation 재개, 복원 import COMMIT 후 marker/fence·같은 operation 재개를 확인한다. 원 자료 대조 후 마지막으로 옛 migration apply의 거절과 남는 관리 fence를 기록한다.

각 경계는 실제 DB에 연결한 시험용 client 또는 파일 API의 **예외 주입**이다. SIGKILL·전원 손실·실제 네트워크 단절 통과로 표시하지 않는다. 정상 경로는 checkpoint405의 유효한 결과를 재사용한다. 실제 모델/API 중단을 유지한다.

NAS의 보존된 private runtime/PG15.18/Node24.20.0/별도 host driver를 재사용한다. 직전 서버가 종료돼 있음을 pg_ctl status exit3으로 확인했다. 기존 성공·실패 DB/담당/백업은 보존하며 이번용 새 DB 쌍·담당 디렉터리를 만든다. 시스템 서비스·기존 Node·운영 DB는 변경하지 않는다.

root가 공통 실행기·실제 실행·수정·종료·증거·Git을 담당한다. 독립 모듈 작성은 이행/엔진/백업으로 나누되 실제 실행과 파일 API interception은 직렬로 한다. 작성자가 동결한 뒤 실행하며, 실행 중 제품이나 공유 fixture를 덮어쓰지 않는다.

기존 운영 용량·복원 목표·native Windows·사내 연동은 이번 자료만으로 완료하지 않는다. 모든 실제 통과/실패/미실행 조건을 따로 기록하고 완료한 단위를 push한다.
