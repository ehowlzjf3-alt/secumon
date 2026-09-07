# 다음 작업

2026-09-08 · checkpoint371. 현재 소스와 전체 문서, 실행 증거를 함께 보존한다. 전체 goal은 미완료다. 최초 게시 `872fa50`의 상태와 이전 실패 원로그는 Git 이력 및 [작업 이력](WORKLOG.md)에 남아 있다.

작업 단위가 완료될 때마다 관련 코드·문서·검증 결과·남은 작업을 커밋하고 `origin`에 푸시한다. [저장소 규칙](../AGENTS.md).

## 바로 이어갈 일

1. C03의 [명시 SQLite 복구](chapters/C03-sqlite-recovery-implementation.md)에서 준비 중단·원본/후보 생성 시도 상한, 남은 documents fence·super-journal 거절 경계를 확인한다. 완료한 입구·이관·복구 게시 중단 시험은 반복하지 않는다.
2. C04의 chat CLI가 신뢰된 호스트 등록 경로를 전달하도록 보완한다. 기존 기본 호스트의 모델·도구 등록 기능을 유지한다. [후속 검증 준비](chapters/C04-ordered-verification-preparation.md)의 기존 시험에 임시 등록표를 주입하고 남은 입구·복합 작업·문맥·목표 변경을 확인한다.
3. 이후 C05 → C06 → C07 → C08 → C09 → C10 순서로 검증·수정한다. [순차 검증 계획](chapters/C01-C10-ordered-verification.md), [C06–C10 별도 검증 항목](chapters/C06-C10-verification-plan.md)을 사용한다.
4. 챕터별 로컬 검증 뒤 필수 통합 회귀와 Linux/native Windows를 확인한다. PostgreSQL·사내 MCP·Knox·A2A의 실제 환경 인수는 가능한 로컬 연결 검증과 구분한다. 모델/API 실제 시험은 사용자 지시로 중단 상태다.

## 현재 확정 상태

- C06–C10: 채택한 지원 범위의 기능 연결과 통합 빌드를 마쳤다. 상세 검증·운영 인수와 구분한다. [구현 결과](chapters/C06-C10-implementation-result.md)
- C01: 선택한 macOS 로컬80/80, 별도 동시8CLI 최초 실행20회 확인. [결과](chapters/C01-ordered-verification-result.md)
- C02: 지속 세션·compact·CLI/Web 선택35/35. 서로 다른 두 소스 지문의 실행 기록을 보존했다. [결과](chapters/C02-ordered-verification-result.md)
- C03: 선택 고유216개 통과. 이전 종료 hook 실패는 수정·재확인했고 실제 복구 게시 중단·재개4개를 포함한다. 마지막 build5는 통과했다. 실행별 서로 다른 소스 지문을 보존하며 재시험은 고유 수에 더하지 않는다. [결과](chapters/C03-ordered-verification-result.md) · [명령·원로그·소스 지문](../runtime/evidence/C03-ordered-checkpoint.json)
- C04: 기존 핵심5파일51/51 통과. 준비한 응답을 사용하는 로컬 시험으로 실제 모델 판단 품질 검증은 아니다. 후속 입구·복합·문맥·목표 변경 시험은 남아 있다. [결과](chapters/C04-ordered-verification-result.md)

코드는 특정 보안 업무·고정 리드/워커 구조에 묶지 않는다. 작업 완료 뒤 세션은 이어가되 목표·근거·실행 영수증·자원 장부는 작업별로 분리한다. 담당 디렉터리별 식별·설정·기억·대화 격리를 유지한다. 완성한 기능의 재구현이나 근거 없는 전체 시험 반복을 피한다.

Git에는 현재 소스·설계·검증 원로그·체크포인트를 보존한다. 로컬 자격증명, 의존성/컴파일 산출물, 원본 운송 압축파일, 생성한 DB·binary fixture는 제외한다. 문서에 남은 절대 경로나 제외 파일 링크는 과거 로컬 실행 당시의 증거 위치일 수 있다.
