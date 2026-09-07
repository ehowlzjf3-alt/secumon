# 구현 연결 후 순차 검증

현재 checkpoint372: C01 선택80개·C02 선택35개는 이전 결과를 유지한다. C03 선택222개와 C04 선택158개를 확인했으며 실행별 소스 지문은 각각 보존했다. 다음은 [C03의 명시 잔여 인수](C03-remaining-acceptance.md)이며 [C05 기존 시험과 연결 공백](C05-ordered-verification-preparation.md)도 준비했다. 전체 목표와 현재 Linux/native Windows·실제 연동·최종 통합은 미완료다. 아래 checkpoint369 이하의 상태는 당시 기록이다.

2026-09-08 · checkpoint369. C01·C02 로컬 대상 확인 완료·C03 순차 검증 진행. 기능 연결 뒤 검증·수정하는 사용자 지시에 따른 다음 실행 순서다. 통합 빌드 통과를 동작 인수로 바꾸지 않는다. 기존 시험·실패 원로그·C05 동결 후보를 재사용하고 변경한 소스에서 필요한 범위만 실행한다.

| 순서 | 확인할 사용자 결과 | 기준 목록 |
| --- | --- | --- |
| C01 | 두 담당의 격리, 같은 폴더 재호출/이동, 복사 중복 ID, clone, setup와 복원 재등록 | [호스트 ID 구현·검증](C01-host-identity-registration-implementation.md), 기존 C01 결과 |
| C02 | 작업 완료 후 같은 세션을 이어가며 compact/재시작에도 현재 작업과 과거 원문을 구분 | 기존 C02 지속 세션/compact 결과와 시험 |
| C03 | 대화·개인 기억·업무 근거 분리, 기본/선택 저장소, 이관·복원 | [SQLite 회복 검증](C03-sqlite-recovery-implementation.md), 기존 C03 기억/이관 결과 |
| C04 | 가설·계획·검증·재계획과 빠른 응답·명시 목표 변경 | 기존 일반/복합 턴·등록 모델·문맥 창 시험 |
| C05 | 도구·기억·스킬 선택/퇴출, 원응답 보관/정산·재개, 컴퓨터 유즈 | [쓰기·컴퓨터 호스트 검증](C05-write-computer-host-implementation.md), 보존한 C05 후보 |
| C06–C10 | 대화·배치, 게시판·아카이브, 동료·반론·자원, 사건·상시 임무, 설치·버전·복원 | [별도 V06–V10 목록](C06-C10-verification-plan.md) |

## 현재 결과와 다음 실행: C03

C01은 macOS/arm64 Node24의 **7파일80/80**, 별도 **동시 CLI8개씩20회**, build5 exit0·구조188개/위반0을 확인했다. 반복 횟수·자식 수를 고유 시험 수에 더하지 않는다. [C01 결과](C01-ordered-verification-result.md) · [증거](../../runtime/evidence/C01-ordered-checkpoint.json).

C02는 기존 지속 세션·compact4파일 **30/30**과 `persistent-session-presentation.test.ts`의 실제 CLI·Web **5/5**, 총 **고유35개 통과**다. C02 build1(session24669)도 exit0이다. 첫30개와 뒤5개는 서로 다른 소스 지문에서 실행했으며 [결과](C02-ordered-verification-result.md)와 [증거](../../runtime/evidence/C02-ordered-checkpoint.json)에 각 실행·빌드 지문을 남겼다. 시험용 임시 등록표와 trusted work host 옵션 전달만 연결했고 세션 판정은 유지했다.

현재 **C03 개인 기억·이관·복구 검증을 진행 중**이다. 이 문서의 확정 집계는 checkpoint369까지이며 C03 후속 결과는 별도 기록한다. 현재 Linux/native Windows·최종 통합과 C03~C10 검증·전체 goal은 미완료다. C06~C10 지원 경로 구현 완료와 상세 검증 별도 정책, 실제 모델/API·외부 서비스 연결 중단을 유지한다.

## checkpoint368 당시 진행 이력


C01은 macOS/arm64 Node24에서 최종 **7파일 80/80**, build5 exit0, 구조188개·위반0이다. 별도 **동시 CLI 8개씩 20회** 최초 실행도 확인했으며 반복 횟수를 고유 시험 수에 더하지 않는다. [C01 결과](C01-ordered-verification-result.md) · [최종 증거](../../runtime/evidence/C01-ordered-checkpoint.json). target1~3과 진단 실패 원로그는 수정 근거로 보존한다. 이 결과는 현재 Linux/native Windows나 최종 통합 회귀의 통과가 아니다.

C02의 기존 `sqlite-sessions.test.ts`, `session-flow.test.ts`, `session-compact-flow.test.ts`, `session-compact-source-boundaries.test.ts` 4파일 target1은 **TAP 30/30 통과**다. [원로그](../../runtime/evidence/C02-ordered-target1.log). 지속 세션·반복 compact·다음 작업의 독립 장부와 원문 경계를 기존 fixture로 확인했다. presentation 후속은 root의 실행 준비 단계이며 아직 통과로 계산하지 않는다. 해당 결과 뒤 필요한 소규모 교정과 C03 이후 검증으로 이어간다.

C06~C10의 채택한 지원 경로 구현은 완료 상태를 유지하며 상세 검증은 아래 별도 목록에 남긴다. C01의 남은 플랫폼/통합 확인, C02 후속과 이후 챕터, 전체 goal은 미완료다.

## checkpoint367 당시 C01 시험 준비 이력

아래는 실행 전 계획을 보존한 이력이며 현재 상태는 위 checkpoint369 결과를 따른다.

기존4파일의 임시 등록표 주입과 새 identity 등록13개·복원 재등록9개 시험을 이미 작성했다. 전용 CLI launcher도 실제 홈 대신 임시 등록표를 주입한다. 모두 최종 통합 빌드에 포함했으며 시험은 아직 실행하지 않았다. 아래 순서에서 재작성 없이 사용한다.

1. 기존 `agent-profile`, `agent-stores`, `agent-clone`, `agent-backend-binding` 시험의 준비 코드를 재사용한다. 호스트 등록표는 담당/엔진 밖 임시 폴더를 trusted 인자로 주입한다. 사용자 실제 홈 등록표에 시험 ID를 만들거나 HOME을 바꾸지 않는다.
2. 새로 연결한 같은 객체 재열기/rename, 전체 복사본 거절, 새 ID clone, 무쓰기 status, 동시 최초 claim, 손상 head, 복원 후 명시 rebind·같은 operation 재시도를 좁게 검증한다. 실패하면 해당 동작을 수정하고 영향 있는 시험만 다시 실행한다.
3. 실제로 수정한 범위의 build/core 타입/계층 검사를 실행한다. C01을 통과했다는 이유로 과거 전체 회귀를 매번 반복하지 않고 C02로 진행한다.

원 DB 복구는 전용 임시 fixture에서만 검증한다. 검증 시 발견하는 실제 미구현은 새 기능을 빼는 대신 관련 챕터의 revision으로 처리한다. 전체 인수 결과에는 구체적인 명령·소스 지문·환경·pass/fail/not-run을 남긴다.

전체 통합과 현재 Linux 회귀는 관련 챕터 확인 후 묶어 실행한다. native Windows 링크/로드/실행은 실제 환경 결과가 필요하다. 모델/API 중단은 유지하며 실제 사내 MCP·Knox·A2A·PostgreSQL 연결·배포 조건은 별도 미검증으로 남긴다. 환경 부재로 독립적인 로컬 검증을 멈추지 않는다.
