# C05 MCP 읽기의 일반 입구 연결 결과

2026-09-07 · **구현과 macOS·NAS Linux 검증 완료.** C05 전체와 C01–C10 목표는 미완료다. 실제 모델/API 시험 중단을 유지한다.

담당의 일반 CLI 또는 Web에서 요청하면 등록된 MCP 도구로 자료를 읽고, 기존 근거 검증과 대화 흐름으로 답변한다. MCP를 위해 별도 에이전트나 기억 DB를 만들지 않았다. 호스트는 에이전트를 시작하는 프로그램이며, 리드 에이전트라는 뜻이 아니다.

## 이번에 연결한 부분

| 구분 | 구현과 목적 |
|---|---|
| 재사용 | 기존 MCP stdio 클라이언트·읽기 어댑터·도구 목록·계약 검증·원응답 artifact·호출 영수증·실행기·세션·대화 전달을 그대로 사용한다. |
| 수정 | [호스트 도구 조립](../../runtime/src/presentation/host-tools.ts)에 기존 담당의 state/artifacts/digester/clock과 스키마 검사기·취소 신호를 전달한다. state는 업무 상태와 영수증, artifacts는 원응답 파일의 보관 인터페이스다. |
| 수정 | [일반 프로필](../../runtime/src/presentation/agent-turn-profile.ts)이 동일 저장소를 MCP와 코어에 전달하고, 기존 도구 목록에 검증된 공급자 계약을 게시한 뒤 프로필을 반환한다. 모델에는 저장소 객체를 전달하지 않는다. |
| 신규 | [MCP 호스트 helper](../../runtime/src/presentation/mcp-host-tools.ts)는 신뢰된 시작 코드의 서버 설정·도구 binding·정책·한도를 받는다. binding은 원격 도구와 내부 계약 및 결과 해석 함수를 연결하는 등록 정보다. |
| 수정 | [공급자 목록 갱신](../../runtime/src/application/provider-tool-snapshot.ts) 실패 시 공개 오류 문구를 유지하며 내부 원인 오류를 보존한다. 정리 실패와 최초 실패를 구분하기 위한 변경이다. |

한 helper는 한 endpoint(연결 대상)·한 provider(도구 공급자)를 소유하며 여러 도구를 연결할 수 있다. 담당을 열 때마다 별도 MCP 프로세스 수명을 갖는다. 여러 연결 대상은 호스트에서 여러 provider source를 조립할 수 있다. 같은 provider를 고정 목록과 동적 목록에 나누거나 둘 이상의 목록이 중복 소유하면 거절한다.

원격 목록에도 기존 읽기 전용·내장 이름·콜백 검사를 적용한다. 도구 발견이 사용자 권한을 늘려 주지는 않는다. `company` 공급자의 도구 이름은 `company.mcp.document.read`처럼 공급자 이름으로 시작해야 한다. 사용자 메시지나 HTTP 요청으로 실행 파일·환경·권한·해석 함수를 등록할 수 없다.

## 확인한 사용자 흐름

- SQLite와 파일 journal 담당에서 실제 로컬 MCP 프로세스의 자료를 읽고, 원자료 값 → 투영한 근거 → 최종 답변이 일치했다. 모델은 정해진 요청만 처리하는 구조화 대역이다.
- 별도 CLI 프로세스와 localhost HTTP에서 접수·실행·답변을 기존 세션에 기록했다. 두 입구의 재접속에서 `tools/call`은 증가하지 않았고 원문·답변·사용량이 중복되지 않았다.
- 결과를 받은 상태에서 프로필을 닫고 다시 열어 완료했다. 원 dispatch·intent·response 영수증과 원응답 artifact를 다시 검증했다.
- 같은 도구 이름을 쓰는 두 담당에게 서로 다른 원자료를 주고, 저장소와 답변이 섞이지 않으며 한 담당의 종료가 다른 담당의 MCP 프로세스를 닫지 않는지 확인했다.
- 계약·projector 버전 변경은 과거 응답의 근거 채택을 차단했다. 발견 실패, 최초 오류와 정리 오류, 중복 종료, 권한·취소·잘못된 등록 경계도 검사했다.

재접속 시 MCP 프로세스를 새로 시작하고 `initialize`·`tools/list`로 계약을 다시 발견한다. **자료 읽기 중복 방지와 서버 없는 offline 재개는 다른 기능**이다. 이번 결과에는 offline 재개가 포함되지 않는다.

## 로컬 검증 근거

macOS Node 24.20.0에서 `npm run build`, `npm run typecheck:core`, `npm run check:architecture`를 통과했다. 계층 검사 159파일·위반 0, 신규 4파일 **30/30**, 관련 46파일 **572/572**, 실패·취소·skip 0이다.

[신규 원로그](../../runtime/evidence/C05-mcp-new2.log) · [관련 원로그](../../runtime/evidence/C05-mcp-related1.log) · [실제 종료 관측](../../runtime/evidence/C05-mcp-tool-exit-observations.json) · [소스·빌드 지문](../../runtime/evidence/C05-mcp-local-build2-pin.json).

소스 `45f9b1a119186cf5da63139145ab1c48f11c32491a46e2c717519114de7172cd`, 빌드 `a0f873e8bcb9721d672911c149b49df5f7b9256093a774e9544aec4afe8c0f83`, 빌드 파일 1,668개다. 지문은 검증한 코드와 실행한 파일이 같은지 대조하기 위한 값이다.

첫 신규 시험은 19통과·11실패였다. 공용 시험 등록의 공급자 이름이 도구 이름과 불일치한 것이 원인이었다. 공급자만 `company`로 교정했으며 제품의 이름 검사는 완화하지 않았다. [첫 원로그](../../runtime/evidence/C05-mcp-new1.log)와 [첫 종료 기록](../../runtime/evidence/C05-mcp-new1.json)을 보존한다.

## Linux 검증 결과

같은 소스를 NAS Linux/Node24에서 신규 **30/30**, 관련 **572/572**, 전체 **3,368/3,368**으로 검증했다. build·신규·관련·core·계층·CLI 구조·전체·fixtures의 필수 8단계가 모두 종료 코드 0이다. native exec22557는 2026-09-07T11:16:55.467Z에 종료했다. 원로그와 결과 9개를 회수하고 해시를 대조했으며, 관측 가능한 전용 프로세스 0·SSH 종료·private 제어 폴더 정리를 확인했다. 접근 불가 같은 UID peer 2개의 범위는 미확정이고 시스템 전체 프로세스 부재로 확대하지 않는다. 시스템 Node18과 기존 자료는 유지했다.

[확정 증거](../../runtime/evidence/C05-mcp-linux-nas-20260907/verification.json) · [실행 메타데이터](../../runtime/evidence/C05-mcp-linux-nas-20260907/run-metadata.json) · [원로그 회수](../../runtime/evidence/C05-mcp-linux-nas-20260907/final-collection.json).

## 남은 필수 범위

[실행 계획](C05-mcp-host-plan.md)의 다음 순서를 유지한다: 단순 원응답 수신 뒤 `result_received` 전 중단 복구 → 전송 뒤 권한 변경 시 원응답·확인된 사용량 보존과 본문 채택 분리 → 서버 없는 offline 재개 → 일반 입구의 페이지·대기·복구 연결. 기존 어댑터 시험 통과가 이 사용자 흐름까지 증명하지는 않는다.

범용 도구의 선택·기억/스킬 로딩·문맥 정리 비용 개선, 컴퓨터 유즈, 쓰기 도구, 실제 모델 판단·usage·취소·tokenizer, 실제 사내 MCP/Knox, native Windows, PostgreSQL, 운영 배포도 전체 계획에 남는다. 이번 고정 모델 대역 시험은 자연어 처리 품질이나 실제 모델 연결 검증이 아니다.
