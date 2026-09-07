# P3-01: 로컬 MCP adapter와 프로토콜 fixture

2026-09-06 · 상태: 로컬 단발 읽기 검증 완료, P3-01 진행 중 · 선행 정본: v0.38

## 배우려는 개념과 결과

MCP는 도구와 통신하는 규약이다. 업무 권한, 계획, 근거의 신뢰도와 완료 판정을 대신하지 않는다. 이번 챕터는 공식 TypeScript SDK로 로컬 합성 MCP 서버와 실제 통신하고, 기존 Tool/Broker/원본 artifact/receive/adopt 경계에 연결한다. Python, 별도 실행 장부, PostgreSQL 종속 코어는 추가하지 않는다.

학습 순서는 개념 → 계획과 완료 기준 → 구현 → 정상·실패·복구 검증 → 결과와 다음 실습 저장이다. 큰 항목은 한 번에 완료로 표시하지 않고 검증 가능한 소단위로 나눈다. 실제 사내 MCP·모델·Knox·운영 데이터는 이번 검증에 포함되지 않는다. 취소한 API/key 실험은 재개하지 않는다.

## 이번 구현 순서

1. 공식 SDK의 현재 안정 버전과 실제 설치 소스를 확인한다. `@modelcontextprotocol/client` 2.0.0을 제품 의존성, `@modelcontextprotocol/server` 2.0.0을 로컬 fixture 개발 의존성으로 정확히 고정한다. 필요하다면 SDK core 타입/transport 패키지도 직접 의존성으로 명시한다. 이전 lock과 정본을 보존하고 의도한 dependency delta를 기록한다.
2. 호스트 구성의 고정 executable/arguments/environment로 stdio 세션을 연다. 서버 목록은 상한 안에서 모두 읽고 승인 manifest와 대조한 뒤 한 번에 게시한다. MCP의 pagination을 원격 원자 snapshot으로 표현하지 않는다. transport/parser의 실제 byte·동시 요청 상한과 취소·종료 의미를 확인한다.
3. 승인한 읽기 도구를 기존 Tool로 연결한다. 모델 입력에서 프로세스·목적지·tenant·권한을 받지 않는다. 원격 schema와 host 출력 schema를 분리한다. adapter 내부 await 뒤 호출 직전 현재 권한을 다시 검사한다.
4. SDK가 해석한 원응답 JSON을 제한된 artifact로 보존하고 host mapper로 결과를 만든다. wire bytes와 decoded JSON은 구분한다. 원격 텍스트·annotations·resource URL은 권한이나 사실이 되지 않는다. 오류 원문을 보존해도 실패 ToolResult에는 evidence/artifacts를 넣지 않는 기존 계약을 지킨다.
5. 문서·관측 두 합성 읽기 도구를 실제 로컬 프로세스와 연결한다. 원본 재검증, 동일 출처의 lineage 보존, 부분 결과·오류·취소·늦은 응답·종료와 명시 재연결을 검증한다. 기존 ReadCollections의 pagination/resume 연결은 일반 단발 호출 경계가 확인된 뒤 별도 소단위로 진행하며 구현하지 않은 자동 cooldown·종합 coverage는 지원한다고 표시하지 않는다.

## 완료 기준

- 실제 SDK 연결·도구 목록·읽기 호출이 합성 fixture에서 동작하며 승인하지 않은 도구는 등록되지 않는다.
- schema/목록/응답 크기·동시성 한도 초과, 연결/목록 변경, 취소·늦은 응답은 고정 오류와 보수적인 coverage로 처리된다. 숨은 tools/call 재시도는 없다.
- 호출 직전 변경된 업무/정책/계약은 전송을 차단한다. 전송 후 취소는 원격 실행 취소 완료라고 기록하지 않는다.
- 성공 결과의 artifact와 projector를 재검증할 수 있고 원본 유실/변조/다른 attempt 대입을 거절한다. 실패 결과를 근거로 승격하지 않는다.
- SQLite와 file journal에서 정상 경로와 저장된 결과 재검증이 일치한다. RPC 횟수와 모르는 원격 내부 작업량을 구분한다.
- 소유한 프로세스와 임시 파일을 정리하고 관련 시험·전체 native 검증·코어 타입·architecture·fixture 결과를 저장한다. 미실행 검증은 통과로 표시하지 않는다.
- v0.38 기록과 원본 1,973개를 보존한다. 새로운 SDK 설치는 의도한 lock 변경으로 기록한다.

## 범위와 남는 제한

초기 연결은 host가 승인한 read-only stdio 서버에 한정한다. stdio 프로세스는 OS 보안 sandbox가 아니다. HTTP/OAuth·사내 인증·운영 접근·쓰기 효과 영수증·서버가 보고하지 않는 계약 변경은 추가 검증 대상이다. 프로토콜 협상과 취소는 pinned SDK 실제 동작을 시험한 범위만 주장한다. 모든 MCP 설명을 모델 context에 넣거나 새 도구를 자동 승인하지 않는다.

검토 노트: `runtime/evidence/P3-mcp-adapter-boundary-review.md`, `P3-mcp-adapter-fixture-review.md`, `P3-mcp-adapter-recovery-review.md`.

## 공식 자료

- [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [2026-07-28 stdio 규격](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [2026-07-28 도구 규격](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [SDK client 연결](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect.html)

공식 문서 설명과 실제 pinned package가 다르면 설치 소스와 로컬 wire 시험을 근거로 차이를 기록한다.
