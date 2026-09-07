# ADR P0-001 — 첫 제품 구현 경로

2026-09-05 · 첫 구현 경로 선택 · 운영 배포 승인/검증은 아님

## 선택

TypeScript, Node.js 24.20.0 LTS, 작은 자체 상태 루프와 명시적인 포트를 사용한다. 첫 영속 adapter는 Node 내장 SQLite와 별도 artifact 저장 포트다. 코어에 DB/모델/채널 SDK를 넣지 않는다. 언어/도구 전면 번역 대신 필요한 계약·검증 자료를 옮긴다. 새 제품 실행에는 Python을 요구하지 않는다.

도구 체인은 TypeScript 6.0.3, @types/node 24.13.3, 실행 시 입력 검증은 application 계층의 Zod 4.5.4로 고정했다. domain에는 외부 라이브러리 import가 없다. TypeScript 7.0.2의 CLI 빌드는 통과했지만 설치 패키지의 JS export가 version 정보만 제공해 기존 Compiler API 기반의 계층 검사가 실패했다. 같은 검증 도구를 유지하면서 통과하는 6.0.3을 선택했다. 새 버전 이름만으로 전환하지 않고 빌드·검사 적합성을 기준으로 재평가한다.

호스트 기본 Node 25.8.0 대신 지원 중인 24 계열을 프로젝트 내 `.tools/`에 별도 설치했다. 공식 배포 archive의 SHA256을 공식 SHASUMS256.txt와 비교했고 시스템 기본 runtime은 변경하지 않았다. 출처 기록은 runtime/.tools/runtime-provenance.json에 있다. 다른 OS/CPU 지원은 해당 환경에서 확인 전이다.

## 비교와 근거

| 선택지 | 첫 구현 판단 | 실험 여부 |
|---|---|---|
| TS/Node + 자체 명령/상태 루프 | 기존 TS 플랫폼과 연결하기 쉽고 포트·실행 의미를 직접 검증 가능. 첫 경로로 선택 | 코어 판정/계약 및 로컬 저장 적합성 실행 |
| Python 코어 유지 | 기존 자산은 많지만 사용자의 Python 없는 제품 요구와 새로운 실행 구조에 맞춰 비교할 이점이 작음 | 기존 코드 정적 검토, 신규 Python 제품 미구현 |
| Rust 중심 코어 | 자원 격리/고부하 구성요소의 후보. 현재 작은 I/O 중심 경로에 다언어 빌드 비용을 먼저 추가하지 않음 | 성능 우위 실험 없음; 후속 필요 시 평가 |
| 외부 durable workflow 엔진 | 대규모 분산 배정/장기 대기에 후보. 초기에는 별도 서비스와 업무/엔진 상태의 이중 관리 범위를 줄임 | 설치/비교 벤치마크 없음; 기능 차이는 설계 검토 |
| 메모리 저장 대역 | 계약 시험에는 유용하지만 프로세스 종료 후 복원을 제공하지 못함 | P1 대역 예정, 영속 구현으로 선택하지 않음 |
| SQLite adapter | 별도 DB 서버 없이 원자성·CAS·사건/outbox·처리 영수증을 구현할 수 있음 | 실제 4개 저장 시험 통과 |
| PG 또는 파일 기반 다른 영속 구현 | 본체의 필수 의존성으로 두지 않음. P2-01 교체 적합성의 후보 | 아직 교체/동등 보장 시험 없음 |

모든 대안을 같은 환경에서 성능 비교했다고 주장하지 않는다. 작은 적합성 시험에서 확인한 것은 SQLite 커밋 후 SIGKILL/새 프로세스 복원, wake 조건, 두 프로세스의 동일 revision 충돌, 삽입 중 실패의 전체 rollback, 중복 command 영수증이다. 전체 업무 복구·외부 효과 조정은 P1/P6에서 더 검증해야 한다.

모델 포트는 자체 계약을 사용한다. scripted planner로 코어 규칙을 검증하고 실제 provider adapter는 capability와 자료 목적지를 명시해 주입한다. OpenAI 실험은 사용자 요청으로 종료됐으며 특정 모델을 운영 기준으로 채택하지 않았다. 사내 모델/API 명세가 들어와야 실제 적합성을 평가할 수 있다.

## 참고한 공식 자료

- [Node.js 지원 버전](https://nodejs.org/en/about/previous-releases): 지원 중인 LTS를 제품 기준으로 선택.
- [Node SQLite API](https://nodejs.org/api/sqlite.html): DatabaseSync API 참고. 이 페이지의 최신 버전과 프로젝트 고정 버전은 다를 수 있어 동작은 실제 24.20.0 시험으로 확인.
- [TypeScript 6.0](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html), [Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API): 사용 중인 빌드/정적 검사 인터페이스.
- [Zod 기본 사용](https://zod.dev/basics): safeParse 기반 실행 시 검증. 오류 원문 대신 고정 code와 필드 경로만 반환.
