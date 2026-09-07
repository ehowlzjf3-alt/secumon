# C10 PostgreSQL 담당의 엔진 버전 관리

2026-09-08 · checkpoint367. C06~C10 구현 정리에서 빠져 있던 PostgreSQL 담당의 check/pin/update 연결을 보완했다. 호스트가 등록된 DB pool을 공급하며 기존 로컬 관리 경로도 유지한다.

공개 API는 [agent-postgres-lifecycle.ts](../../runtime/src/infrastructure/agent-postgres-lifecycle.ts)의 `checkAgentPostgresLifecycle`과 `pinAgentPostgresEngine`이다. 기존 엔진 release·pin, 로컬/DB 관리 잠금, PG export·백업 검증을 재사용한다. 설정된 용도별 버전·고정 테이블/열과 혼합 로컬 저장소의 호환을 확인하고, 변경 시 현재 pin과 결합 백업을 대조한다. 새 형식 이관과 프로세스 재실행은 별도다.

release에는 선택적 `compatibility.postgres`를 추가했다. 현재 구현은 이전 release 형식을 로컬용으로 계속 읽으며 PG 지원 선언이 없는 엔진은 PG 담당의 대상으로 거절한다. 현재 선언은 installation 2, binding/state/knowledge/channel 1이다. 목적별 1은 PG 등록 계약으로 SQLite의 schema 번호와 별개다. [호스트 예제](../../runtime/examples/postgres-host.mjs)의 check/pin/update와 [사용법](C03-postgres-usage.md)을 연결했다.

check도 offline 상태에서 관리 잠금을 획득·반환한다. 실제 PG installation과 등록을 검사하며 DB 형식을 만들거나 수정하지 않는다. pin은 최초 고정에 사용한다. update는 expectedPrevious(예상 현재 엔진 지문)와 원 백업을 요구하며, PG 원 페이지의 시각을 포함한 전체 논리 지문·담당/등록·현재 pin·로컬 원문을 대조한다. 최종 게시까지 같은 관리 잠금을 유지하고 기존 no-replace 게시로 pin 기록을 추가한다. 같은 엔진 지문은 기록을 추가하지 않는다.

새 관리 API는 기존 transfer 용량 한도를 그대로 따른다. PG commit 결과가 불명인 경우 해당 fence를 자동 해제하지 않으며 원 오류와 정리 오류를 보존한다. 오류 뒤에는 실제 pin과 관리 상태를 조회해야 한다. 반환값의 `recoveryRequired:true`는 기존 실행 영수증과 미확정 외부 효과를 확인할 필요가 있다는 뜻으로, 새 업무 실행이나 DB 복원 성공을 뜻하지 않는다.

검증은 [V10-18](C06-C10-verification-plan.md)에 별도로 기록했다. 최종 통합 build2(session12407)는 exit0이며 예제 `node --check`도 exit0이다. 앞서 대기 중이던 C01 시험 준비 코드와 CLI 호출 함수 분리는 build1(session69196, exit0)에 포함됐고 최종 빌드에도 포함됐다. 새 등록/재등록 시험 22개와 기존 시험4파일은 준비만 했으며 실행하지 않았다. 실제 PG·엔진 전환·플랫폼·모델/API 검증도 미실행이다. [증거와 소스 지문](../../runtime/evidence/implementation-handoff-checkpoint.json).
