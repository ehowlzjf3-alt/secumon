# C03 명시 복구의 남은 인수

2026-09-08 · checkpoint372. [V03-R01~08](C03-sqlite-recovery-implementation.md)의 요구와 실제 시험을 대조했다. 선택222개 통과는 아래 미확인 항목까지 완료했다는 뜻이 아니다. 이미 실행한 준비 중단·시도 상한·문서 fence·super-journal은 다음 작업에서 제외한다.

| 기준 | 확인한 범위 | 남은 범위 |
| --- | --- | --- |
| R01 | state/memory/channel 실제 임시 hot-journal 복구와 원본 보존 | 현재 Linux/native Windows·운영 데이터 인수 |
| R02 | foreign owner, 필수 테이블 부재, 문서 fence 불일치, WAL/SHM·super-journal 거절 | owner 테이블/행 부재, file-journal state·PostgreSQL로 선택한 용도의 로컬 prepare 거절 |
| R03 | 실제 원본/후보 복사 중단·같은 ID 재개·각4회 시도 상한 | 원 main/journal 동일 bytes·다른 inode 교체, 같은 inode 내용 변경, 같은 operation의 다른 kind 요청 거절과 자료 보존 |
| R04 | POSIX main 퇴역 링크·journal 퇴역·후보 링크·완료 기록 게시 뒤 실제 중단4개 | 아직 개별 중단하지 않은 전후 지점 및 Windows no-replace 재개 |
| R05 | pending 일반 실행/다른 관리 차단, 죽은 lease 회수 후 pending 유지 | 플랫폼별 최종 회귀 |
| R06 | 요청/응답 일치·중복·시간/출력 한도·종료 관측14개 ChildStub 이벤트 계약 | timeout/abort 뒤 late 응답, 후보 worker/DB close 오류가 관리 흐름으로 전파되는 경계, worker-unobserved 기록과 maintenance 유지·후속 차단 |
| R07 | 완료 뒤 정상 변경된 DB를 과거 복구 receipt가 덮지 않음 | 실제 외부 도구 시도/효과 영수증을 가진 업무에서 자동 성공·재실행 없음 |
| R08 | 기존 개인 기억·문서·이관·CLI/Web의 선택 회귀 | 새 sqlite-recovery CLI prepare/apply/status, 현재 Linux/native Windows·최종 통합 |

다음 작은 단위는 R02/R03의 선택·원본 현재성 거절이다. 기존 임시 fixture를 재사용하고 변경된 제품 동작이나 미확인 요구에 맞는 최소 시험을 추가한다. R06의 모의 이벤트 검증과 실제 OS/SQLite 오류는 구분한다. 이미 통과한 전체 묶음을 단순 누적 수를 늘리기 위해 반복하지 않는다.

C04의 [선택158개](C04-ordered-verification-result.md)는 확인했다. C03의 이 목록을 보존하면서 이어갈 C05의 [호스트 연결·기존 후보](C05-ordered-verification-preparation.md)도 준비했다. 실제 모델/API 중단과 전체 목표 미완료를 유지한다.
