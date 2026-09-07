# 다음 작업

2026-09-08 · checkpoint374. 현재 소스와 전체 문서, 실행 증거를 함께 보존한다. 전체 goal은 미완료다. 최초 게시 `872fa50`의 상태와 이전 실패 원로그는 Git 이력 및 [작업 이력](WORKLOG.md)에 남아 있다.

작업 단위가 완료될 때마다 관련 코드·문서·검증 결과·남은 작업을 커밋하고 `origin`에 푸시한다. [저장소 규칙](../AGENTS.md).

## 바로 이어갈 일

1. [C03 잔여](chapters/C03-remaining-acceptance.md)의 R04 명시 전후 중단 지점과 R07 외부 도구 시도/효과 영수증 보존을 격리된 로컬 fixture로 확인한다. 관리 오류 전파·종료 미관측 차단과 실제 복구 CLI는 이번에 확인했으므로 다시 미실행 목록에 넣지 않는다.
2. C05 collection의 custody-only 원응답을 가진 일반 CLI/HTTP 재개를 확인한다. 기존 complete/nonfinal/partial 입구와 이번 crash/drain10개의 확인 범위를 대체 증거로 확대하지 않는다. [C05 결과](chapters/C05-ordered-verification-result.md)의 선택662개는 기록된 소스 범위로 보존한다.
3. [문맥 비용 검토](chapters/C05-context-cost-review.md)의 현재 소스 기준선을 측정하고 중복 원문 조회 개선을 검증한다. 기존 유한 캐시와 현재성/권한 검사를 유지한다. 이후 [C06 준비](chapters/C06-ordered-verification-preparation.md)의 Knox 직접 입구·격리 설치·두 담당 배치부터 C06 → C07 → C08 → C09 → C10의 [검증 항목](chapters/C06-C10-verification-plan.md)을 확인한다.
4. 챕터별 로컬 검증 뒤 필수 통합 회귀와 Linux/native Windows를 확인한다. PostgreSQL·사내 MCP·Knox·A2A의 실제 환경 인수는 가능한 로컬 연결 검증과 구분한다. 모델/API 실제 시험은 사용자 지시로 중단 상태다.

## 현재 확정 상태

- C06–C10: 채택한 지원 범위의 기능 연결과 통합 빌드를 마쳤다. 상세 검증·운영 인수와 구분한다. [구현 결과](chapters/C06-C10-implementation-result.md)
- C01: 선택한 macOS 로컬80/80, 별도 동시8CLI 최초 실행20회 확인. [결과](chapters/C01-ordered-verification-result.md)
- C02: 지속 세션·compact·CLI/Web 선택35/35. 서로 다른 두 소스 지문의 실행 기록을 보존했다. [결과](chapters/C02-ordered-verification-result.md)
- C03: 선택 고유238개 통과. 이번 관리 전파3·실제 CLI2는 C05 build5에서 실행했다. 실제 worker close 뒤 오류 주입 및 관리 프로세스의 종료 이벤트 대역을 실제 OS 실패로 확대하지 않는다. [결과](chapters/C03-ordered-verification-result.md) · [증거](../runtime/evidence/C03-ordered-checkpoint.json)
- C04: 선택20파일 고유158개 통과. 기존51개와 이번107개는 서로 다른 빌드다. 준비한 응답·로컬 실행 연결을 검증했으며 실제 모델 품질 시험은 아니다. [결과](chapters/C04-ordered-verification-result.md)
- C05: 이전201·추가461, 선택 고유662개 통과. 도구/기억/스킬과 문맥 수명, MCP 원응답·재개·정산 및 중단/종료를 확인했다. build2/3/5의 실행 범위와 실패 후 교정을 구분한다. [결과](chapters/C05-ordered-verification-result.md) · [증거](../runtime/evidence/C05-ordered-checkpoint.json)

코드는 특정 보안 업무·고정 리드/워커 구조에 묶지 않는다. 작업 완료 뒤 세션은 이어가되 목표·근거·실행 영수증·자원 장부는 작업별로 분리한다. 담당 디렉터리별 식별·설정·기억·대화 격리를 유지한다. 완성한 기능의 재구현이나 근거 없는 전체 시험 반복을 피한다.

Git에는 현재 소스·설계·검증 원로그·체크포인트를 보존한다. 로컬 자격증명, 의존성/컴파일 산출물, 원본 운송 압축파일, 생성한 DB·binary fixture는 제외한다. 문서에 남은 절대 경로나 제외 파일 링크는 과거 로컬 실행 당시의 증거 위치일 수 있다.
