# C08 반환·활성 배정·동료 접수 중단 인수

2026-09-08 · checkpoint379 · 이번 로컬 단위 검증 완료. 기준선 `3d75c031f53e4c62a244832b2f4b21043429805f`. [계획](C08-remaining-boundaries-plan.md)과 [실행 체크포인트](../../runtime/evidence/checkpoint379.json)를 함께 본다. 전체 goal과 C08 운영 환경 인수는 미완료다.

## 확인할 동작

- **반환·새 배정 2개:** 수신 에이전트가 원문을 읽기 전 또는 한 번 읽은 뒤 명시적으로 반환한다. 런타임은 이미 호출한 사용량을 정산하고, 후원자는 반환된 배정을 다시 활성화하지 않고 기존 한도 안에서 새 작업에 새로 배정한다. 중복 명령·재접속은 원 반환 영수증과 사용량을 보존한다. 상주 대화는 계속 남는다.
- **활성 배정과 압축·재접속 2개:** 실제 세션 요약의 게시·중복 요청·호출 비용·다음 모델 입력을 확인한다. 양쪽 작업 문맥의 축소 frame 저장은 요약 게시와 구별한다. 원 배정 또는 미해결 증액 요청을 유지하고 다시 연 뒤 원 목표·한도·원문·영수증으로 실행을 이어간다.
- **접수 직후 실제 프로세스 종료 1개:** 수신 담당의 원 요청 접수가 끝나고 발신 담당의 ticket 보관이 끝나기 전에 자식 프로세스를 SIGKILL로 종료한다. 새 프로세스가 실제 원 요청·영수증을 확인하고 기존 30초 실행 소유권의 만료를 기다린 뒤 명시적인 `core.peer.resume`으로 같은 수신 작업의 답변을 받는다. 호출자 전체 목표의 자동 재계획·완료를 검증하는 사례는 아니다.

모든 모델 전송은 결정적인 로컬 대역이다. SQLite 담당 둘을 실제로 열며 서로의 개인 기억이나 원문을 합치지 않는다. POSIX 프로세스 종료 시험은 Windows에서 이유를 표시하고 건너뛴다.

## 실행 기록

- build1은 신규 compact 시험의 타입 오류 5개로 종료했다. 실제 compact 입력 인자와 세션 타입 구분만 고쳤으며 제품 코드는 변경하지 않았다.
- build2는 Node v24.20.0에서 exit0. 소스 지문 `974f97933107298e92a201a41340031f1a9c058ddb93a2523576b210a534d017`.
- target1은 16개 중14개 통과·2개 실패, exit1이다. 실제 SIGKILL 복구1개와 기존 예산 입구6개·동료 입구5개는 통과했다. 신규 시험 두 곳을 수정한 뒤 해당 파일만 다시 실행했다.
- compact 첫 실패는 사용량이나 배정의 변경이 아니라 `childStateRevision`이 원 수신자 상태 버전으로 동기화된 것을 예상하지 못한 시험 오류다. 전체 grant를 비교하되 정확한 원 상태 버전으로의 갱신을 검사하도록 수정했다.
- 두 번째 반환 사례는 고정 build2에 읽기 전용 진단을 붙여 재현했다. 새 배정 자체는 정상 진전으로 처리되었지만 후원자 사용4회+이전 자식 사용1회+새 배정3회가 원 재계획 한도8회를 모두 차지했다. 이후 실행 계획 제안이 `budget_replans_exhausted`로 거절되고 기본 무진전3회에서 멈췄다. 시험용 모델이 공개된 현재 총사용·배정 정보를 보고 자신의 현재·다음 계획 몫 2회를 남긴 뒤 기존 배정량 이내에서 새 자식의 재계획 몫을 결정하도록 수정했다. 런타임 제한·원 목표·사용량을 바꾸는 수정이 아니다.

- build3은 exit0이며 수정된 compact·반환 두 파일의 target2 **4/4 통과**, exit0이다. 제품 소스는 변경하지 않았다. build3 소스 지문은 `22e72c6cc895d503d7f48c7ab565b29b80b4ed636e2b1fd66a0d28cc89b51019`이며 2,232개 출력이 manifest와 일치했다.
- 이번 단위는 **신규 고유5개 + 직접 영향 회귀11개 = 고유16개 통과**다. SIGKILL과 기존11개는 build2, 신규 compact/반환4개는 build3에서 확인했다. target1의 실패·진단·재실행을 새로운 고유 사례로 합산하지 않는다. 모든 시험을 최종 소스에서 반복한 결과도 아니다.
- 원로그: [build1](../../runtime/evidence/C08-boundaries-build1.log), [build2](../../runtime/evidence/C08-boundaries-build2.log), [target1](../../runtime/evidence/C08-boundaries-target1.log), [반환 진단](../../runtime/evidence/C08-return-progress-diagnostic.log), [build3](../../runtime/evidence/C08-boundaries-build3.log), [target2](../../runtime/evidence/C08-boundaries-target2.log), [최종 소스 확인](../../runtime/evidence/checkpoint379-final-source.json).

앞선 C08 선택199개·관련47개는 각 소스에서의 이력으로 유지한다. 이번 실행과 중복 합산하지 않는다. [앞선 결과](C08-ordered-verification-result.md).

## 이후

이번 로컬 경계를 마친 뒤 [C09 준비 문서](C09-ordered-verification-preparation.md)의 A2A 등록·왕복·재전달·담당 격리부터 진행한다. 실제 모델/API 중단은 유지한다. PostgreSQL, 실제 사내 MCP/Knox·외부 A2A, 현재 Linux/native Windows, C06 브라우저와 C10 운영 설치·버전 전환, 최종 통합은 아직 별도 인수다.
