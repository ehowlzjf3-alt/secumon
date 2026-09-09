# PostgreSQL 전달 용량 확인 결과

2026-09-09 · checkpoint407 · 기준 ad472ce4965be98ce027449347a768c9ffd8eeae.

**현재 환경에서 남았던 기존 V10-07의 64MiB 초과 처리 한 묶음을 실제 NAS PostgreSQL에서 통과했다. 현재 준비된 환경의 필수 검증을 마감한다.** 선택 운영 환경의 인수와 전체 goal 완료는 별개다.

| 확인 대상 | 실제 관측 |
| --- | --- |
| 환경 | PG15.18, Node24.20.0 Linux x64, 별도 pg8.23.0, private Unix socket, 독립 DB `secumon407_capacity_source` |
| 입력 | 기존 `sessions.receive`로 유효한 pending 입력 224개, 각 한글 100,000자/UTF-8 300,000바이트 |
| 전체 입력량 | 67,200,000바이트. 전체 전달 한도 67,108,864바이트(64MiB)를 텍스트만으로 초과 |
| 실제 백업 결과 | `postgres_transfer_limit` 거절, 완성 manifest 없음, 검사 API도 미완성 백업 거절 |
| 부분 백업 | 이미 게시한 29페이지/66,490,644바이트와 로컬 원문 복사본 보존. 미완성 검사 후에도 불변 |
| 원자료 | 18테이블 467행의 고정 컬럼·정렬된 원행 지문/개수, 업무·기억·대화·영수증, 224개 입력 원문·digest·pending 상태 전후 동일 |
| 관리 상태 | DB의 channel/knowledge/state 잠금 3개 모두 해제, 로컬 관리 표식 제거, 담당/host identity 기록 보존 |

새 SQLite/SQLite 개인기억 담당에서 최소 업무·원 대화·기억을 생성하고 정상 PG 이행으로 시험 자료만 준비했다. 완료한 복구/엔진/전체 회귀를 재실행하지 않았다. 모델/API·workflow run·tool 실행·운영 효과는 모두0이다. 대기 입력을 적용·실행·정산했다고 표시하지 않았다.

한도 초과 원본을 export로 다시 내보내면 같은 제한에 걸리므로, 기존 `TRANSFER_TABLES`의 고정 컬럼·키를 따라 실제 읽기 전용 cursor로 원행 SHA와 개수를 대조했다. 각 입력은 정식 SessionRepository로 다시 읽어 원문·상태를 확인했다. 한도를 완화하거나 가짜 원행을 넣지 않았다. 소스·core 의존성 변경, 재빌드·전체 시험 반복은 없다.

## 실행 증거와 범위

첫 직접 실행 명령은 exit0이었지만 로그0바이트·case 미생성·해당 프로세스 부재를 확인해 성공으로 세지 않았다. 같은 동결 실행기를 진입/반환 로그가 있는 `node --input-type=module`의 `await import('./evidence/C10-postgres-capacity-fixture.mjs')`로 실행해 실제 단계 로그·결과 파일·최종 exit0을 얻었다. 최초 무출력 종료 원인은 확정하지 않았으며 통과한 검사를 재현 목적으로 반복하지 않았다.

실행기 SHA는 `ca4048626b7dd2a88fc278c98e7e8a87d2fb6e2b18f7c4b07fecacff758b233e`다. 시작/종료 소스 지문 `34d86285b32363dd4d4c498885820725e43cf54b7705bfbca3c0c0883ac0f6a2`, 컴파일 지문 `7e55006e4b89076e3492649aa1234f0ec51ed07492acbd011ef47378a39055d3`과 2,616파일이 기존 판본과 일치했다. 실제 결과 파일과 stdout 최종 결과도 일치한다.

거절된 백업 구간은 단회 약2.870초였다. 이는 64MiB 초과 거절의 관측 시간이며 운영 백업 성능·규모·SLA의 증거가 아니다. 이번은 한 구성의 기존 용량 초과 인수이며 224개 입력·4개 검사문을 독립 시험 개수로 세지 않는다.

PG fast stop exit0, 후속 status exit3(`no server running`), PID1949037와 postmaster.pid 부재를 확인했다. 전용 SSH master도 종료했다. 시험 원문·DB·부분 백업은 `/tmp/secumon-postgres-405.sJ1Huq`에 보존했다. 임시 경로는 영구 보관을 보장하지 않는다. 405/406 자료와 복원 DB의 옛 operation fence는 변경하지 않았다.

이후 남은 것은 native Windows, 운영 PG 역할/TLS, 사내 MCP/Knox/A2A, 실제 앱, 운영 규모·보관·응답/복구 목표·삭제/철회·늦은 실제 효과, 선택 시범 운영의 환경 인수다. 실제 모델/API 중단을 유지한다. 새 syscall·혼합 조합 검사로 현재 검증을 다시 늘리지 않는다.

근거: [실행 로그](../../runtime/evidence/C10-postgres-capacity-launcher1.log), [실제 결과](../../runtime/evidence/checkpoint407-capacity-result.json), [체크포인트](../../runtime/evidence/checkpoint407.json), [실행기](../../runtime/evidence/C10-postgres-capacity-fixture.mjs), [현재 잔여](../REMAINING-ACCEPTANCE.md).
