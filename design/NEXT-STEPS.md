# 다음 작업

2026-09-08 · checkpoint385. 동일 전역 입구에서 담당별 등록 엔진을 선택하고 공통 확장 호환을 검사하도록 연결했다. 같은 build2 소스에서 신규26개·관련161개, 총187개 통과·코어 타입 exit0·계층199개/위반0. 실제 설치 B로 기존 업무를 재개했고 도구 호출은1회로 유지했다.

[결과](chapters/C10-launcher-extensions-result.md) · [사용법](chapters/C10-launcher-extensions-usage.md) · [체크포인트](../runtime/evidence/checkpoint385.json). 실행 중인 빌드·시험은 없다. 완료 단위를 문서/결과/미완료 항목과 함께 커밋하고 origin에 푸시한다.

## 바로 이어갈 일

1. [C10 고정 전달 형식과 compact 세션의 버전 전환](chapters/C10-launch-envelope-plan.md). 구 입구는 담당을 선택하는 외곽 형식만 읽고 새 옵션은 선택 엔진이 해석하게 한다. 같은 실제 A/B로 compact된 세션·원 이력·기억·후속 업무 연속성을 확인한다.
2. 신규 setup 완료 전에 최초 pin을 고정한다. npm/개발 경로는 원본을 수정하지 않고 호스트 소유 release를 준비한다. 중단/동시성을 다루고 기존 무핀 담당·clone·restore와 구분한다.
3. C10 저장 schema 이행·미확정 외부 효과·복원/패키지 효율·현재 Linux/native Windows·실제PG·운영 및 최종통합.
4. C09 취소/목표변경/일시정지·저널 응답 불명·이력 비용, C05 권한 재허용 이후 완주, C06 기억 HTTP/권한/브라우저 인수를 유지한다.

실제 모델/API 중단을 유지한다. 사내 MCP/Knox/외부 A2A·실제 PostgreSQL과 운영 배포는 로컬 대역/선언 검사와 구분한다. 자동 최초 pin과 구 입구가 모르는 옵션 전달은 이번 구현에 포함되지 않았다. 전체 C10/goal은 미완료다.

## 이전 기록 — checkpoint384 이하

아래의 다음 행동·미실행 표현은 해당 시점의 기록이며 위 현재 계획을 우선한다.

2026-09-08 · checkpoint384. C10의 실제 코드가 다른 두 호환 시험 release 설치/전환과 기존 업무 재개를 확인했다. 신규3개·관련11개, 합계14개가 통과했다. build1 통합1/관련11, build2 교정2의 소스별 기록이며 전체14개를 최종 소스에서 재실행한 것은 아니다. 제품 코드는 재사용했고 신규 시험과 문서를 추가했다.

완료 단위의 코드·문서·검증 결과·남은 작업을 함께 커밋하고 origin에 푸시한다. [저장소 규칙](../AGENTS.md).

## 바로 이어갈 일

1. **C10 전역 실행기와 확장 호환 연결**: [전환 계획의 후속 절](chapters/C10-version-transition-plan.md)을 따른다. npm 전역 입구에서 담당별 pin으로 엔진을 선택하는 연결, 공유 확장 API 호환 선언과 기동/check/pin/update 검사를 구현한다. 설치 B를 명시 실행한 이번 시험을 이 두 기능의 완료로 세지 않는다. 기존 등록 캡처·권한·부분 정리·wire/data 버전 계약을 재사용한다.
2. C10의 저장 schema 이행·compact된 세션 전환·미확정 외부 효과 대조, 현재 Linux/native Windows·실제 PostgreSQL·운영 설치/registry·최종 통합을 [별도 인수](chapters/C06-C10-verification-plan.md)로 이어간다. 오프라인 묶음의 개발용 의존성 복사 비용도 검토한다.
3. C09 완료 복구34개 범위 이후의 취소·목표 변경·일시정지 의미, 파일 저널 응답 불명 주입, 장기 사건 조회 비용을 확인한다.
4. C05 정책 재허용→명시 resume→저장 수집 결과 소비의 완주를 확인한다.
5. C06 개인 기억 HTTP 지연·권한/기억 전용 허용 사용성과 실제 브라우저 렌더링을 확인한다. 실제 사내 MCP/Knox/외부 A2A는 로컬 대역과 구분한다. 실제 모델/API 중단을 유지한다.

## 이번 확인 범위

설치 A의 원 사용자 입력·명시 개인 기억·미완료 조회를 보존하고 check→pin→backup→B update→동일 신원/세션/기억 재열기→B CLI 원 업무 resume을 실행했다. 실제 B formatter 표시를 확인했고 모델1→2회·도구1→1회로 조회를 반복하지 않았다. SQLite와 file-journal+documents의 백업/lease/호환 거절, 현재 자료 백업을 요구하는 엔진 되돌리기와 자료 보존도 확인했다.

최종 build2 exit0·Node v24.20.0 darwin arm64·2,343파일 대조 일치, sourceDigest ceb819314182bc90259dab9a79c636fc31a6dff2ab276068c3af57e70702cd2a다. core1 exit0·구조198개/위반0은 build1 기록이며 이후 제품 변경 없이 경계 시험 한 파일만 교정했다. [결과](chapters/C10-version-transition-result.md) · [체크포인트](../runtime/evidence/checkpoint384.json) · [소스 대조](../runtime/evidence/checkpoint384-final-source.json).

최초 신규 실행은 통합1통과/경계2실패였다. 후자의 SQLite SHM/빈WAL 비교를 교정한 build2에서2/2를 확인했다. DB본문·내용 있는WAL·원문·pin 비교는 유지한다. 현재 제품 코드와 실제 통합 fixture는 build1 뒤 바꾸지 않았다.

C10과 전체 goal은 진행 중이며 활성 빌드·시험은 없다. 메인 프롬프트는 구현·연결돼 있으나 실제 모델 품질은 미검증이다.

직전 checkpoint383의 완료 복구34개는 [결과](chapters/C09-mission-terminal-recovery-result.md), checkpoint382의 독립 담당 비교/결합115개는 [해당 결과](chapters/C09-integrated-trials-result.md)에 보존한다. 이번14개와 합쳐 최종 전체 재실행으로 표시하지 않는다.

아래는 앞선 checkpoint381 사건/상시 담당 단위의 기록이다. [결과](chapters/C09-missions-ordered-result.md) · [체크포인트](../runtime/evidence/checkpoint381.json).

- C09 신규44개: 원천5개는 build2, 협업 집계6개·임무 진전6개·접수 직후 실제 SIGKILL 복구1개는 build3, 호스트 등록6개는 build4, 임무 runtime9개·일반/상시 입구6개·읽기 확인/완료5개는 build6에서 통과했다. 직접 관련91개는 build3 기록이다.
- 최종 build6·core3 exit0, 구조196개/위반0·target5 20/20이다. sourceDigest 5b49e467fc9dd617a01d5f6d005524aa7e6f6c974e21148d33a4706e8ebfd064, [대조 기록](../runtime/evidence/checkpoint381-final-source.json) 2,295파일 일치다. 전체135개를 최종 소스에서 다시 실행한 것은 아니다.
- 일반 목록→원문→답변이 기본 무진전 한도3에서 도구2회·로컬 시험 모델3회로 완료됐다. 실제 채택한 원문 조회의 알림만 확인 처리하고 원문·다른 알림을 보존한다. 실제 완료 영수증→종료 체크포인트/점유 해제→reopen과 오염 영수증 거절을 확인했다. 읽은 내용을 독립 근거나 개인 기억으로 자동 승격하지 않는다.
- 같은 세션의 사건별 업무·담당별 저장소 분리, 재전달·compact/reopen과 접수 직후 실제 SIGKILL 복구를 확인했다. 현재 협업 비교는 기록된 fixture 원장의 집계만 검증했고 실제 모델의 협업 품질을 평가하지 않았다.

아래는 앞선 checkpoint380 A2A 단위의 기록이다. [결과](chapters/C09-a2a-ordered-result.md) · [체크포인트](../runtime/evidence/checkpoint380.json).

- A2A 신규39개: 전송18개는 build3, 일반 입구5개·호스트 등록10개는 build4, 준비 진전6개는 build5에서 통과했다. 첫 접수에서 모델 실행0→명시 실행→원 결과 조회, 재전달·caller 격리·후속 질문·취소를 확인했다.
- 직접 관련59개: 예산 도구 입구6개는 build3, 공통 진전53개는 build5다. 최종 build5 exit0, sourceDigest `37894d96703ada4ff913021bb32d165cfc1b35fa21f34814550631d9ae9bc325`, [대조 기록](../runtime/evidence/checkpoint380-final-source.json) 2,256파일 일치다. 코어 타입 exit0·구조195개/위반0이며 전체98개를 최종 소스에서 다시 실행한 것은 아니다.
- 엄격한 A2A 입력 계약, 등록/전송 수명과 늦은 응답, 조회/취소의 원 task ID 검사를 교정했다. native A2A 준비 진전으로 실제 send→plan→get을 연결하되 동일 요청·응답 반복은 기본 무진전 한도3을 초기화하지 않는다. 준비 진전은 독립 근거나 목표 완료가 아니다. 앞선 실패·진단과 시험 교정은 보존했다.

아래는 앞선 checkpoint379에서 마친 경계다. 당시 게시 전 기준선은 3d75c031이다. [결과](chapters/C08-remaining-boundaries-result.md) · [체크포인트](../runtime/evidence/checkpoint379.json).

- 후속 신규5개: 명시 반환 전/부분 실행 뒤 정산·새 배정2개, 실제 세션 요약·활성 요청 재접속2개, 접수 후 실제 SIGKILL과 원 ticket의 명시 재개1개. 제품 변경 없이 시험 기대값과 시험용 모델의 자원 배정 계산을 교정했다.
- 공유 fixture 직접 영향11개도 통과했다. 신규4개는 build3, SIGKILL1개와 영향11개는 build2 기록이다. 소스별 결과를 최종 한 소스의 전체 재실행으로 합치지 않는다.

아래는 앞선 checkpoint378에서 마친 연결이다.

- 동료: 독립 담당의 양방향 상담, 사용자별 상주 세션과 요청별 임시/검토 세션, 반론 후 자체 판별 관측·재평가, compact/reopen 뒤 원 ticket·예산 재사용.
- 내부 전달: peer/local의 원 세션 답변, 같은 전달 ID의 세션·담당 변조 거절과 원문·대화 불변. 새 ID까지 재발급하는 신뢰된 호스트의 모든 오용을 검증한 것은 아니다.
- 분리 원장: 정확한 담당/작업 주소, 실제 SQLite 배정·실행·증액·정산, 모르는 사용량의 보류, 하드 한도 거절. 개인 기억과 수신자 원문을 합치지 않는다.
- 효율과 권한: 스키마/응답 계약과 자원 준비 진전을 교정했다. 반복 조회·자체 비용은 진전이 아니며, 승인 거절은 원 계획에 선언한 제한 재시도로만 이어진다. 같은 task의 재개에 새 planner 호출이나 카운터 초기화가 필요하지 않다.

메인 프롬프트는 [공통 범용 지침 파일](../runtime/src/infrastructure/agent-turn-prompt.ts)로 구현돼 [등록 모델 어댑터](../runtime/src/infrastructure/structured-agent-turn.ts)에 연결돼 있다. [현재 설명](chapters/prompt-generality-review.md)과 같이 실제 모델 응답 품질은 미검증이다. C01~C06 이전 결과는 각 실행 소스의 기록이며 이번에 반복 실행하지 않았다.

실제 PostgreSQL·사내 MCP/Knox·A2A 상호운용·registry 게시·버전 간 업그레이드·운영 설치는 미실행 범위를 유지한다. 활성 빌드·시험은 없다. 세션은 이어가되 목표·근거·실행 영수증·자원 장부는 작업별로, 신원·설정·기억·대화는 담당별로 분리한다.
