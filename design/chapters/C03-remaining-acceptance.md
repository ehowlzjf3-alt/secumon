# C03 명시 복구의 남은 인수

2026-09-08 · checkpoint373. [V03-R01~08](C03-sqlite-recovery-implementation.md)의 요구와 실제 시험을 대조했다. 선택한 누적 고유 **233개(222+11) 통과**는 아래 미확인 항목까지 완료했다는 뜻이 아니다. [target12](../../runtime/evidence/C03-ordered-target12.log)의 신규11개와 [target13](../../runtime/evidence/C03-ordered-target13.log)의 기존2개 재실행을 구분하며, 후자는 고유 수에 더하지 않는다. 이전 실행별 소스 범위는 [체크포인트](../../runtime/evidence/C03-ordered-checkpoint.json)에 보존한다. R02/R03의 명시 로컬 사례는 아래 근거로 닫고, 이미 실행한 항목을 다음 작업에 다시 넣지 않는다.

| 기준 | 확인한 범위 | 남은 범위 |
| --- | --- | --- |
| R01 | state/memory/channel 실제 임시 hot-journal 복구와 원본 보존 | 현재 Linux/native Windows·운영 데이터 인수 |
| R02 — 로컬 확인 | foreign/missing owner(테이블·행), 필수 테이블 부재, 문서 fence 불일치, WAL/SHM·super-journal 거절; file-journal state·PG state/knowledge/channel 선택의 로컬 prepare 거절. target8/11/12 | 명시된 로컬 거절 사례 없음. PG 선택 검사는 무연결 설정 검사이며 실제 서버 인수·플랫폼 검증을 대신하지 않음 |
| R03 — 로컬 확인 | 실제 원본/후보 복사 중단·같은 ID 재개·각4회 시도 상한; 원 main/journal 동일 bytes·다른 inode 교체와 같은 inode 내용 변경, 동일 operation 다른 kind 거절·자료 보존. target11/12 | 명시된 로컬 사례 없음. POSIX 임시 파일/프로세스 범위이며 native Windows·최종 통합은 별도 |
| R04 | POSIX main 퇴역 링크·journal 퇴역·후보 링크·완료 기록 게시 뒤 실제 중단4개 | 아직 개별 중단하지 않은 전후 지점 및 Windows no-replace 재개 |
| R05 | pending 일반 실행/다른 관리 차단, 죽은 lease 회수 후 pending 유지 | 플랫폼별 최종 회귀 |
| R06 | 요청/응답 일치·중복·시간/출력 한도·종료 관측14개 ChildStub 계약; 기존 deadline/abort2개의 late 정상 응답 거절 재실행(target13) | 실제 후보 worker/DB close 오류가 관리 흐름으로 전파되는 경계, worker-unobserved 기록과 maintenance 유지·후속 차단. 이벤트 재실행을 실제 OS/DB 오류 관측으로 확대하지 않음 |
| R07 | 완료 뒤 정상 변경된 DB를 과거 복구 receipt가 덮지 않음 | 실제 외부 도구 시도/효과 영수증을 가진 업무에서 자동 성공·재실행 없음 |
| R08 | 기존 개인 기억·문서·이관·CLI/Web의 선택 회귀 | 새 sqlite-recovery CLI prepare/apply/status, 현재 Linux/native Windows·최종 통합 |

다음 로컬 후보는 R06의 **실제 후보 worker 오류 → 관리 흐름의 원 오류/원본 보존**, **종료 미관측 → worker-unobserved·maintenance 유지/후속 차단**이다. 기존 이벤트14개와 target13의 late 응답 재실행은 이 연결의 대체 증거가 아니다. R04의 현재 실제 중단4지점 밖의 전후 경계, R07의 외부 도구 시도/효과 영수증 보존, R08의 새 복구 CLI도 별도 잔여다. 이미 통과한 전체 묶음을 단순 누적 수를 늘리기 위해 반복하지 않는다.

C04의 [선택158개](C04-ordered-verification-result.md)는 확인했다. C03의 이 목록을 보존하면서 이어갈 C05의 [호스트 연결·기존 후보](C05-ordered-verification-preparation.md)도 준비했다. 실제 모델/API 중단과 전체 목표 미완료를 유지한다.
