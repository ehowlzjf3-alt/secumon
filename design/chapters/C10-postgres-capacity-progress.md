# PostgreSQL 용량 확인 진행 기록

2026-09-09 · checkpoint407 실제 검사·결과 기록 완료 · 기준 ad472ce4965be98ce027449347a768c9ffd8eeae. 아래 중간 연결·다음 행동은 당시 기록이며 최신 상태는 마지막 절을 따른다.

- 작업 트리는 깨끗한 checkpoint406에서 시작했다. 제품 변경 없이 마지막 기존 V10-07 용량 검사 실행기를 준비 중이다.
- NAS private root `/tmp/secumon-postgres-405.sJ1Huq`와 runtime/data의 소유자·0700 권한, `/tmp` 약5.7GiB 여유 공간을 확인했다. PG status exit3(`no server running`)을 실제로 관측했다.
- 첫 SSH master는 `ControlMaster=yes`와 `-M`을 중복 지정해 ask 모드가 되었고 새 세션을 거절했다. 실제 명령/PID94935를 확인해 종료한 뒤 `-M` 없이 전용 master를 다시 열어 조회에 성공했다. DB 제품/시험 실패가 아니며 당시 DB 검사는 실행 전이었다. 인증정보는 저장하지 않았다.
- 현재 전용 연결은 `/tmp/secumon-pg-capacity.GggVPz/control`이다. 새 DB `secumon407_capacity_source`와 새 case를 사용하며 405/406 원자료와 최종 복원 fence는 변경하지 않는다.
- 다음 행동은 중지된 PG 명시 시작·독립 DB 생성, 실행기 동결/전달 후 직렬 실행이다. 시험 종료 시 이번 서버·SSH를 종료하고 실제 관측값으로 이 기록을 갱신한다.

## 최종 실행과 종료

PG 명시 시작 뒤 PID1949037을 확인하고 독립 DB를 생성했다. 실행기 SHA `ca4048626b7dd2a88fc278c98e7e8a87d2fb6e2b18f7c4b07fecacff758b233e`와 기존 macOS/Linux 소스·컴파일 지문 일치를 확인했다. 제품 build를 변경하거나 다시 만들지 않았다.

첫 직접 실행은 exit0, 로그0바이트였고 case 미생성·fixture 프로세스 부재를 실제 확인했다. 성공이나 live wait로 세지 않았다. 동일 동결 fixture를 진입/반환 로그가 있는 Node import wrapper로 실행한 handle93915는 실제 단계 로그·private result.json·최종 exit0을 반환했다. 무출력 첫 실행의 원인은 확정하지 않았다. 빈 로그도 `C10-postgres-capacity-run1.log`에 보존했다.

실제 입력224개/67,200,000UTF-8바이트에 대해 기존 백업의 `postgres_transfer_limit` 거절, 부분29페이지/66,490,644바이트와 로컬 복사본 보존·완성 manifest 부재·inspect 거절을 확인했다. 원18테이블467행, 업무/개인기억/원대화/영수증과 모든 입력의 원문·pending 상태, host identity 기록이 유지됐고 DB/로컬 관리 잠금은 해제됐다. 상세 원문은 private DB에만 있고 공개 결과에는 개수·지문·바이트만 담았다.

두 결과 파일/로그를 로컬로 보존한 뒤 서버를 정상 종료했다. stop exit0, status exit3/no server running, PID1949037·postmaster.pid 부재를 확인했다. SSH master 종료 exit0, 로컬 control 디렉터리 제거 exit0이다. 405/406 원자료와 복원DB fence를 그대로 두었다.

현재 준비된 환경에서 남은 기존 필수 검사는0묶음이다. [결과](C10-postgres-capacity-result.md)와 [체크포인트](../../runtime/evidence/checkpoint407.json), 중앙 잔여 목록을 저장하고 Git으로 마무리한다. 전체 goal은 외부 환경 인수가 남아 active다. 이전 goal turn과 이번 단위는 실제 결과와 원격 기록을 추가한 progress이며 반복 blocker로 세지 않는다.
