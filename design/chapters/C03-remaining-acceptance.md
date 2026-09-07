# C03 명시 복구의 남은 인수

2026-09-08 · checkpoint375. [V03-R01~08](C03-sqlite-recovery-implementation.md)의 요구와 실제 시험을 대조했다. 누적 고유 **243개(238+5) 통과**다. [target15](../../runtime/evidence/C03-ordered-target15.log)의 중단2·실제 로컬 도구 기록2개와 [target16](../../runtime/evidence/C03-ordered-target16.log)의 main 경로 제거 직후1개를 추가했다. 재실행은 고유 수에 더하지 않으며 실행별 소스 범위는 [체크포인트](../../runtime/evidence/C03-ordered-checkpoint.json)에 보존한다. 같은 최종 소스의 전체 재실행으로 확대하지 않는다.

| 기준 | 확인한 범위 | 남은 범위 |
| --- | --- | --- |
| R01 — 로컬 확인 | state/memory/channel 실제 임시 hot-journal 복구와 원본 보존 | 현재 Linux/native Windows는 별도 환경 인수. 운영 데이터 복구를 실행한 증거는 아님 |
| R02 — 로컬 확인 | foreign/missing owner(테이블·행), 필수 테이블 부재, 문서 fence 불일치, WAL/SHM·super-journal 거절; file-journal state·PG state/knowledge/channel 선택의 로컬 prepare 거절. target8/11/12 | 명시된 로컬 거절 사례 없음. PG 선택 검사는 무연결 설정 검사이며 실제 서버 인수·플랫폼 검증을 대신하지 않음 |
| R03 — 로컬 확인 | 실제 원본/후보 복사 중단·같은 ID 재개·각4회 시도 상한; 원 main/journal 동일 bytes·다른 inode 교체와 같은 inode 내용 변경, 동일 operation 다른 kind 거절·자료 보존. target11/12 | 명시된 로컬 사례 없음. POSIX 임시 파일/프로세스 범위이며 native Windows·최종 통합은 별도 |
| R04 — POSIX 로컬 확인 | main 퇴역 전·링크2개 상태·원 경로 제거 직후, journal 퇴역, 후보 링크2개 상태, 완료 기록 전후의 실제 중단7지점·같은 ID 재개 | 현재 Linux/native Windows no-replace 재개·최종 통합 |
| R05 | pending 일반 실행/다른 관리 차단, 죽은 lease 회수 후 pending 유지 | 플랫폼별 최종 회귀 |
| R06 — 로컬 전파 확인 | 기존 ChildStub14개와 late 응답2개 재실행; 실제 후보 worker의 DB close 후 주입 오류 및 schema+close 오류 보존, 실제 관리 프로세스 안의 종료 이벤트 대역으로 worker-unobserved·maintenance 유지/회수 후 다음 worker 차단3개(target14) | 주입한 close 오류와 모의 validator 종료 미관측은 실제 OS 실패 관측이 아님. 이 한계를 유지하며 로컬 관리 전파 사례는 확인 완료 |
| R07 — 로컬 확인 | 완료 뒤 정상 변경된 DB 보존; 실제 임시 파일 쓰기의 received/unknown 상태·효과 기록·정산을 복구/재열기/과거 apply에서 보존, 자동 완료·추가 실행0 | unknown은 실제 쓰기 뒤 응답 손실 주입. 실서비스 효과 확인 및 운영 데이터 복구 인수는 별도 |
| R08 — 로컬 CLI 확인 | 기존 선택 회귀 및 실제 agent CLI의 state hot-journal prepare/apply/status·반복·암묵 repair 거절·실제 중단 pending/lease 회수/정확한 ID 재개2개(target14) | 현재 Linux/native Windows·최종 통합은 별도 환경 인수 |

명시된 R04/R07 로컬 인수를 확인했으므로 이 항목과 R06 관리 전파·R08 CLI를 다시 미실행 목록에 넣지 않는다. 실제 OS close 실패나 validator 종료 미관측을 만들지 않은 한계, Linux/native Windows 환경 인수와 최종 통합은 별도로 유지한다. 이후 C05~C10의 진행 가능한 로컬 작업을 계속하며, 이미 통과한 전체 묶음을 단순 누적 수를 늘리기 위해 반복하지 않는다.

종료 미관측 marker의 현재 보장은 **다음 worker 호출 차단**이다. 같은 ID의 재시도는 이 검사 전에 다른 후보 사본을 준비할 수 있으므로 “추가 후보 파일도0개”를 이번 통과 결과에 포함하지 않는다.

C04의 [선택158개](C04-ordered-verification-result.md)는 확인했다. C03의 이 목록을 보존하면서 이어갈 C05의 [호스트 연결·기존 후보](C05-ordered-verification-preparation.md)도 준비했다. 실제 모델/API 중단과 전체 목표 미완료를 유지한다.
