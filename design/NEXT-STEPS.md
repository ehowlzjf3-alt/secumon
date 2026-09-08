# 다음 작업

2026-09-08 · checkpoint382. 신규17개·직접 관련98개, 합계115개를 소스별로 확인했다. build3 신규15/관련94, build4 신규1/관련4, build5 신규1이며 전체115개를 최종 소스에서 재실행한 것은 아니다. [결과](chapters/C09-integrated-trials-result.md) · [체크포인트](../runtime/evidence/checkpoint382.json). 기준선은 b2684ffa다. C09와 전체 goal은 진행 중이며 실제 모델/API 시험 중단·외부 연결0회를 유지한다.

완료 단위의 코드·문서·검증 결과·남은 작업을 함께 커밋하고 origin에 푸시한다. [저장소 규칙](../AGENTS.md).

## 바로 이어갈 일

1. **다중 임무 rule 종료 정리와 완료 후 중단 복구**를 확인한다. 실제 완료 영수증은 있지만 종료 체크포인트를 아직 게시하지 못한 경계를 원 receipt·원문과 대조해 재개한다. 기존 접수 직후 SIGKILL이나 정상 완료/reopen을 이 경계의 통과로 대체하지 않는다.
2. 이어 **C10 설치·버전·복구**의 [검증 항목](chapters/C06-C10-verification-plan.md)을 진행한다. 서로 다른 유효 release로 check→첫 pin→오프라인 backup→update→기존 신원/세션/기억 재열기를 연결한다. 같은 release를 다른 설치 경로로 제시하면 현재 구현은 변경 없음으로 반환하므로 실제 전환·백업 검사 인수가 아니다. 기존 설치·복원 fixture를 재사용하며 모델/API 시험 중단을 유지한다.
3. C06 브라우저 렌더링·실제 사용자 조작, 현재 Linux/native Windows와 최종 통합은 별도 인수다. 로컬 HTTP bytes·대역·macOS 설치로 대신하지 않는다.
4. C05 신뢰된 정책 재허용 → 명시 resume → 저장 수집 결과 소비의 전체 흐름을 인수한다. 차단/정산·독립 successor 시험만으로 완주를 주장하지 않는다. [결과와 한계](chapters/C05-collection-permission-resume-result.md).
5. 개인 기억을 선택한 HTTP 완료의 지연과 권한 설정을 검토한다. 기존 fixture20초를 넘겨60초 대기로 기능을 확인한 것이며 성능 개선은 아니다. 현재 호스트 allowWrites와 실제 write/computer 등록 결합, 기억 전용 허용의 사용성을 함께 살핀다.

## 이번에 확인한 범위

- 신규17개: 응답 평가8개·응답 재생2개·동료 진전4개·실제 독립 프로필 비교1개는 build3, 게시판/임무 신규2개는 build4와 build5에서 각각1개 통과했다. 관련98개는 build3의94개와 build4의 기존 게시판4개다. 최종 build5 exit0·필터1/1이고 [대조 기록](../runtime/evidence/checkpoint382-final-source.json) 2,319파일 일치, sourceDigest b5d6636cf326f936960fda3119ac62fdf41816580a566db53e15a094c033caf4다. core2 exit0·구조198개/위반0은 build3에서 확인했고 이후 제품은 바꾸지 않았다.
- 같은 질문에서 단독1업무는 도구1회·모델2회·토큰560·재계획0회, 협업2업무 합계는 도구2회·모델4회·토큰1120·재계획1회였다. 둘 다 완료했고 이 한 쌍에서 추가 성공 이득은 없었다. 로컬 시험 모델의 기록이며 실제 모델 비용·일반적 협업 품질 결론이 아니다.
- 원 proof 검증·채택된 native 동료 응답을 준비 진전에 연결하고 기본 무진전 한도3을 유지했다. 고정 정답·수집한 원 답변의 선택 평가와 재생, 유효 파생 인용을 연결하며 기존 독립 원문·반대 근거 기준을 유지한다. 게시판은 자기 자료 검증과 원 전체 snapshot 동시 변경 검사를 함께 유지한다.
- 마지막 결합은 도구5회·모델6회·토큰1680·재계획4회로 임무 원문 ACK→실제 게시판 인용 답글→답변/완료→closed 체크포인트·claim 해제→reopen을 통과했다. 앞선 실패와 fixture 교정 이력은 보존했으며 같은 경계를 반복 검증할 필요는 없다.

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
