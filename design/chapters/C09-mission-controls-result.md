# C09 임무 제어 결과 기록

2026-09-08 · checkpoint393 · 기준선 `bf61a44`. **이번 로컬 구현·검증 단위 완료.** 최초 resume 결함을 수정한 같은 최종 build2에서 신규 11개와 직접 관련 31개, 합계 **42/42**가 통과했다. 실패·취소·건너뜀은 0이다. 직전 메인 프롬프트 질문 응답은 상태 설명이며 구현 진전으로 계산하지 않는다. 이번 단위는 현재 소스를 다시 확인하여 재개했다. C09 전체와 전체 goal은 미완료다. [계획](C09-mission-controls-plan.md) · [사용 흐름](C09-mission-controls-usage.md).

## 구현한 동작

- 호스트 resident에 관측 `pause(workId)`/`resume(workId)`를 연결했다. 규칙의 영구 종료인 `stop(workId)`, 호스트 driver 핸들을 닫는 `close()`, 프로필 종료, 개별 업무의 pause/cancel과 구분한다.
- 원 접수 영수증으로 사건과 업무의 관계를 확인한다. 목표가 변경된 사건 업무는 대기 큐에서 분리하고 `explicit_resume_required`를 반환하여 자동 실행하지 않는다. 기존 목표 변경·업무 실행 경로로 명시 재개한다.
- `MissionRuntime`의 취소·목표 변경 후 종료 메타데이터와 원 체크포인트를 맞췄다. 원 사건·커서·읽기 확인과 기존에 호스트가 종료한 규칙을 보존한다. 일시정지는 원 사건·대기 실행을 유지하고 점유를 해제하여 명시 재개와 연결한다.
- 기존 코어 명령·실제 완료 복구·지속 세션·개인 기억·저장 포트를 재사용했다. 관측 제어로 세션을 교체하거나 원 사건을 새로 접수하지 않는다.

제품 변경은 [mission-runtime.ts](../../runtime/src/application/mission-runtime.ts), [resident-missions.ts](../../runtime/src/application/resident-missions.ts), [host-resident-missions.ts](../../runtime/src/presentation/host-resident-missions.ts)에 연결했다. 이번 관측 제어 노출은 호스트 API이며 새 CLI/Web/Knox 명령·버튼은 구현하지 않았다. 최종 검증 범위와 남은 운영 경계는 아래와 같다.

## 실행한 검증

| 항목 | 현재 기록 |
| --- | --- |
| 최종 빌드·코어 타입 | build2/core2 exit0 |
| 최종 신규 인수 | target2 11/11. 업무 임무 제어 6개 + resident 제어 5개, 13,482.480916ms |
| 최종 직접 영향 회귀 | regression2 31/31. mission-runtime·원문 ACK·resident 입구·완료 마감 복구의 4개 시험 파일, 33,735.704666ms |
| 구조 검사 | architecture1 202개/위반0. 이후 변경은 선택적 `controlRevision`과 반복 제어 시험으로 import 관계가 같아 결과를 재사용했다. architecture2는 실행하지 않았다. |
| 최종 소스/산출물 대조 | build2의 2,493파일 대조 일치 |
| 커밋·푸시·원격 일치 | 문서 확정 뒤 root가 수행하고 중앙 기록에 남길 단계 |

신규 6개는 실제 workflow의 점유 해제와 업무 pause→명시 재개, cancel/goal 변경 후 추가 호출 없는 원 체크포인트 마감, idle·기존 호스트 종료 보존, 두 규칙의 원문 읽기 확인/reopen, 변경된 명령 영수증·현재 권한 거절을 확인했다. resident 5개는 pause/resume 반복과 재열기·동일 세션 유지, stop 후 resume 거절, 접수 후 또는 실행 중 목표 변경의 명시 재개 분리, 개별 업무 pause/cancel과 다음 사건의 독립성, poll 중 pause 후 늦은 page 거절과 같은 커서 재개를 확인했다.

42개 모두 같은 최종 build2에서 실행했으며 최초 결과와 중복 합산하지 않는다. 이번에는 SIGKILL 시험을 실행하지 않았고 이전 강제 종료 시험도 다시 실행하지 않았다. 로컬 callback·제어 경합·reopen 결과를 실제 프로세스 강제 종료나 실제 모델 품질 검증으로 확대하지 않는다.

[체크포인트](../../runtime/evidence/checkpoint393.json) · [최종 빌드](../../runtime/evidence/C09-mission-controls-build2.log) · [코어 타입](../../runtime/evidence/C09-mission-controls-core2.log) · [신규 11개](../../runtime/evidence/C09-mission-controls-target2.log) · [관련 31개](../../runtime/evidence/C09-mission-controls-regression2.log) · [구조 검사](../../runtime/evidence/C09-mission-controls-architecture1.log) · [최종 소스 대조](../../runtime/evidence/checkpoint393-final-source.json).

최종 sourceDigest는 `9b047577ef2c8fb4daea2747d2420dcfa4bf826da27dc54c715c11bb8474feca`, filesDigest는 `f7d975c3eabeefee37151b976eda5575398db11f93439943932be0eca6bc0069`다.

## 최초 실패와 수정

최초 build1/core1은 exit0이었으나 신규 11개 중 9개 통과·2개 실패였다. 당시 직접 관련 31개는 통과했다. 두 resident resume 실패는 실제 제품 결함이다. resume이 `suspended` 표식을 지우면 체크포인트 본문이 과거 active 본문과 같아졌다. 본문의 SHA에서 만든 commandId도 같아져 `transact`가 과거 명령의 중복으로 판단했고, 현재 paused 상태가 그대로 남았다. 시험 비교 조건을 완화하여 통과시키지 않았다.

선택 필드 `controlRevision`을 추가하여 실제 pause/resume 상태 전환마다 증가하도록 수정했다. 본문에 제어 전환 순서를 남겨 과거 active 체크포인트의 명령 ID를 재사용하지 않게 한다. 이미 같은 상태에서 다시 호출하는 pause/resume은 저장 변경 0회를 유지한다. 기존 첫 시험에 pause→resume 반복 2회를 추가하고 build2에서 신규 11개·관련 31개를 모두 확인했다. [최초 신규 실패 원로그](../../runtime/evidence/C09-mission-controls-target1.log)와 [최초 관련 결과](../../runtime/evidence/C09-mission-controls-regression1.log)를 보존한다.

검증은 실제 로컬 프로필/SQLite와 결정적인 로컬 callback을 사용했다. 격리된 개인 기억 카드 1개를 실제 저장한 자료 보존 경계를 포함하며, 기억 검색 품질이나 실제 모델 품질 검증으로 확대하지 않는다. 실제 모델/API·사내/외부 서비스 호출은 모두 0회다.

## 재사용하는 기존 결과

[checkpoint383 완료 복구](C09-mission-terminal-recovery-result.md)의 34개는 당시 최종 build3에서 실행한 역사 기록이다. 실제 완료 직후 SIGKILL과 남은 규칙 마감 복구를 포함하며, 이번 취소·목표 변경·일시정지의 새 검증 결과가 아니다.

[checkpoint381 사건 접수](C09-missions-ordered-result.md)의 135개는 여러 소스별 통과 기록이다. 같은 세션의 사건별 업무 분리, 원 접수 재사용, 늦은 관측 취소와 원문 읽기 확인 등의 근거로 재사용하되 현재 소스 전체 통과로 표시하지 않는다. 해당 문서에서 당시 미검증이었던 다중 규칙 완료 마감과 완료 직후 복구는 이후 checkpoint383의 결과를 따른다.

## 계속 남기는 항목

다음은 취소에 협조하지 않는 원천의 poll 중에도 영속 제어 명령을 즉시 중단 신호와 연결하는 일이다. 이 즉시 중단 연결과 과거 규칙 ID의 재사용은 아직 미구현이다. 이번의 늦은 응답 거절을 poll 자체의 즉시 중단 완료로 표시하지 않는다. 파일 저널 `journal_commit_unknown` 오류 주입, 긴 사건 이력의 조회 비용과 과거 규칙 관리도 남는다.

실제 모델/API 시험 중단을 유지한다. 현재 Linux/native Windows·실제 PostgreSQL·사내 MCP/Knox·외부 A2A·설치/운영·최종 통합, 기존 C05/C06 및 C10 잔여는 미완료다. 이 로컬 단위를 C09 전체나 전체 goal의 완료로 표시하지 않는다.
