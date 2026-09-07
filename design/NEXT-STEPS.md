# 게시 시점의 남은 작업

2026-09-08 · checkpoint370. 사용자가 지정한 GitHub 저장소에 소스와 전체 문서를 먼저 게시하기 위해 구현·검증 진행을 여기서 저장했다. 전체 goal은 미완료다.

## 바로 이어갈 일

1. C03의 `personal-memory-draft-flow.test.ts`에서 병행 profile의 종료 hook이 임시 폴더 삭제 뒤 실행되어 발생한 `ENOENT`를 수정한다. 모든 profile을 먼저 닫고 fixture 폴더를 정리한 뒤 해당 시험만 재실행한다. 현재 156개 중155통과·1실패이며 실패 원로그를 지우지 않는다.
2. [C03 준비 목록](chapters/C03-ordered-verification-preparation.md)의 미실행 CLI/Web·초안 중단/재개·이관 흐름을 기존 시험으로 확인한다. 이미 통과한 묶음과 준비된 임시 registry 주입을 재사용한다.
3. [명시 SQLite 복구](chapters/C03-sqlite-recovery-implementation.md)의 나머지 거절·중단·pending·worker 종료 경계를 확인한다. state/memory/channel의 기본 실제 임시 복구 3종은 통과했지만 전체 장애 인수는 아니다.
4. C03 다음 C04 → C05 → C06 → C07 → C08 → C09 → C10 순서로 검증·수정한다. [순차 검증 계획](chapters/C01-C10-ordered-verification.md), [C06–C10 별도 검증 항목](chapters/C06-C10-verification-plan.md)을 사용한다.
5. 챕터별 로컬 검증 뒤 필수 통합 회귀와 Linux/native Windows를 확인한다. PostgreSQL·사내 MCP·Knox·A2A의 실제 환경 인수는 가능한 로컬 연결 검증과 구분한다. 모델/API 실제 시험은 사용자 지시로 중단 상태다.

## 현재 확정 상태

- C06–C10: 채택한 지원 범위의 기능 연결과 통합 빌드를 마쳤다. 상세 검증·운영 인수와 구분한다. [구현 결과](chapters/C06-C10-implementation-result.md)
- C01: 선택한 macOS 로컬80/80, 별도 동시8CLI 최초 실행20회 확인. [결과](chapters/C01-ordered-verification-result.md)
- C02: 지속 세션·compact·CLI/Web 선택35/35. 서로 다른 두 소스 지문의 실행 기록을 보존했다. [결과](chapters/C02-ordered-verification-result.md)
- C03: 선택156개 중155통과·1실패. 마지막 build는 통과했고 active 시험 프로세스는 없다. [결과](chapters/C03-ordered-verification-result.md) · [명령·원로그·소스 지문](../runtime/evidence/C03-ordered-checkpoint.json)

코드는 특정 보안 업무·고정 리드/워커 구조에 묶지 않는다. 작업 완료 뒤 세션은 이어가되 목표·근거·실행 영수증·자원 장부는 작업별로 분리한다. 담당 디렉터리별 식별·설정·기억·대화 격리를 유지한다. 완성한 기능의 재구현이나 근거 없는 전체 시험 반복을 피한다.

Git에는 현재 소스·설계·검증 원로그·체크포인트를 보존한다. 로컬 자격증명, 의존성/컴파일 산출물, 원본 운송 압축파일, 생성한 DB·binary fixture는 제외한다. 문서에 남은 절대 경로나 제외 파일 링크는 과거 로컬 실행 당시의 증거 위치일 수 있다.
