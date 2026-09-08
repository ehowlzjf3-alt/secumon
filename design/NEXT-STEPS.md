# 다음 작업

2026-09-08 · checkpoint381. C09 사건/상시 담당 로컬 단위의 신규 고유44개와 직접 관련91개, 합계135개를 소스별로 확인했다. [결과](chapters/C09-missions-ordered-result.md) · [체크포인트](../runtime/evidence/checkpoint381.json). 게시 전 기준선은 c8ffdfc7이다. 135개 전체의 최종 소스 재실행은 아니며 C09와 전체 goal은 진행 중이다. 실제 모델/API 시험은 중단 상태이고 이번 외부 서비스 연결은0회다.

완료 단위의 코드·문서·검증 결과·남은 작업을 함께 커밋하고 origin에 푸시한다. [저장소 규칙](../AGENTS.md).

## 바로 이어갈 일

1. **같은 문제의 단독/협업을 독립 프로필에서 각각 실행해 비교**한다. 기존 [동료 입구 fixture](../runtime/src/tests/peer-deployment-entry-fixture.ts)의 실제 등록 경로와 별도 SQLite를 재사용하고, 같은 문제·모드·정답 기준으로 원 상태·전달·참여자별 사용량을 수집해 비교기에 넣는다. 지금의 fixture 원장 집계와 구분한다. 일반 응답의 responseRequirement와 평가기의 criteria:[] 관계는 이 실행에서 확인할 정적 후보다. 아직 재현된 결함으로 기록하거나 평가 통과를 위해 상태를 가공하지 않는다.
2. **게시판과 임무를 같은 프로필/업무에 연결한 인수**를 추가한다. [게시판 fixture](../runtime/src/tests/board-deployment-entry-fixture.ts)와 [상시 담당 fixture](../runtime/src/tests/resident-missions-entry-fixture.ts)를 재사용해 두 provider의 알림·커서 보존과 한쪽 빈 조회/등록 철회의 영향을 확인한다. 이번 sentinel 보존 시험으로 이 결합을 대신하지 않는다. 다중 임무 rule의 종료 정리와 업무 완료→종료 체크포인트 게시 사이 실제 중단 복구도 별도 미검증 경계로 유지한다.
3. 이어 **C10 설치·버전·복구**의 [검증 항목](chapters/C06-C10-verification-plan.md)을 진행한다. 기존 설치 fixture를 재사용해 check→첫 pin→오프라인 backup→같은 릴리스의 다른 설치 경로로 update→기존 신원/세션/기억 재열기를 좁게 연결하고, 기존 npm/오프라인 설치 시험을 다시 만들지 않는다. 실제 모델/API 시험 중단은 유지한다.
4. C06 브라우저 렌더링·실제 사용자 조작, 현재 Linux/native Windows와 최종 통합은 별도 인수다. 로컬 HTTP bytes·대역·macOS 설치로 대신하지 않는다.
5. C05 신뢰된 정책 재허용 → 명시 resume → 저장 수집 결과 소비의 전체 흐름을 인수한다. 차단/정산·독립 successor 시험만으로 완주를 주장하지 않는다. [결과와 한계](chapters/C05-collection-permission-resume-result.md).
6. 개인 기억을 선택한 HTTP 완료의 지연과 권한 설정을 검토한다. 기존 fixture20초를 넘겨60초 대기로 기능을 확인한 것이며 성능 개선은 아니다. 현재 호스트 allowWrites와 실제 write/computer 등록 결합, 기억 전용 허용의 사용성을 함께 살핀다.

## 이번에 마친 범위

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
