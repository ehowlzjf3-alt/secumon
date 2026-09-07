# 다음 로컬 챕터 추천: 기존 MCP 재사용 adapter

2026-09-06 · backlog와 runtime 소스 읽기 검토 · 코드/서비스/모델 실행 없음

**다음 작업은 P3-01의 선행 로컬 단위인 ‘TypeScript MCP adapter와 실제 로컬 프로토콜 fixture’를 권한다.** 계측 Chrome의 입력 경계를 더 세분하는 대신, 이미 구현한 단일 에이전트 코어에 기존 외부 도구를 연결하는 공통 경계를 채운다. 사내 MCP 업무 로직을 다시 만들지 않고, 확인된 명세를 나중에 연결할 자리를 구현하는 작업이다.

이 로컬 단위를 완료해도 P3-01의 실제 사내 MCP 연결, P3-03 Knox, 실제 모델 품질 조건을 완료로 표시하지 않는다. 모델/API 키 시험 취소와 사내 MCP 명세 미제공 조건은 유지한다. 새 명세·전용 환경·접근 범위가 확인되기 전에는 사내 서버를 호출하지 않는다.

## 현재 위치

`design/implementation-backlog.json`의 검토 당시 상태는 다음과 같다. 진행 중인 Web driver 결과가 아직 반영되기 전의 backlog를 읽었으므로 아래 표는 해당 원장 상태를 그대로 기록한다.

| 항목 | 원장 상태 | 다음 작업 선택에 주는 의미 |
|---|---|---|
| P3-01 기존 MCP의 실제 adapter | not_started | 실제 MCP 명세·환경과 G-DATA가 외부 선행조건이다. 연결용 공통 로컬 adapter는 먼저 준비할 수 있다. |
| P3-02 Web과 CLI 업무 화면 | in_progress, local_contracts=verified | 로컬 화면과 같은 업무 상태를 조회하는 경로가 이미 있다. 실제 모델/조직 인증 조건은 별도다. |
| P3-03 Knox 대화 연결 | not_started | P3-01/02에 의존한다. 수신 인증·사람/방 ID·발송/오류/대조 계약이 미제공이다. |
| P3-04 컴퓨터 유즈 adapter | in_progress, local_contracts=partially_verified | 현재 계측 Chrome 챕터가 진행 중이다. 본 검토는 그 최종 시험 결과를 판정하지 않는다. |
| P4-01 두 에이전트와 게시판 | not_started | P2-05/06과 P3-01에 의존한다. 개인 관측·공유 entity·충돌/철회·대화 상한을 실제 도구와 연결해야 한다. |
| P4-02 A2A 업무 계약 | not_started | P4-01과 선택 상대의 실제 계약이 필요하다. |
| P4-03 상시 임무와 사건 기반 재개 | not_started | P4-01과 P3-01에 의존한다. 외부 수집 cursor와 재개 의미가 먼저 필요하다. |
| P4-04 협업 통합과 비용 검증 | not_started | P4-01/02/03 뒤에 같은 문제의 단일/다중 에이전트 비교를 수행한다. |

P3-01과 P3-03, P4를 한 번에 섞기보다 MCP의 연결 경계를 먼저 검증하는 것이 의존관계에 맞는다. Knox를 먼저 구현하면 미제공된 메시지 ID·조회·중복 방지 계약을 추측해야 한다. 게시판/A2A를 먼저 확대하면 기존 도구 재사용 경계가 빈 상태에서 역할과 메시지 수만 늘어날 수 있다.

## 소스에서 확인한 재사용 대상과 빈 부분

`runtime/src` 파일 목록과 MCP/Knox 문자열을 검색했다. MCP client, MCP transport, MCP 전용 Tool adapter 구현은 없다. `runtime/package.json` 의존성은 AJV와 Zod이며 MCP SDK 의존성은 없다. Knox는 conversation channel enum과 관련 조회 시험에 존재하지만 실제 수신·발송 adapter는 없다.

반면 다음 공통 기능은 구현되어 있으므로 복제할 이유가 없다.

| 기존 파일 | 다음 adapter에서 재사용할 책임 |
|---|---|
| `application/ports.ts` | Tool/ToolDefinition, ReadCollectionSource, MessageSink와 저장소 중립 포트 |
| `application/provider-tool-snapshot.ts` | bounded 목록 준비, 중복/cursor/혼합 revision 검사, 완료된 목록의 일괄 교체 |
| `application/tool-contracts.ts`, `tool-catalog.ts` | provider/id/version, schema, 허용 도구/목적지/labels, 선택적 명세, 계약 교체 fence |
| `application/tool-broker.ts` | 현재 업무·목표·예약·계약·예산·권한·공개 상한 검사 후 실제 adapter 진입 |
| `application/read-collections.ts`, `read-collection-validation.ts` | 확인된 페이지/증분 계약의 장부와 명시적 재개 |
| `application/execution-runtime.ts`와 공통 store/artifact 포트 | 예약/dispatch/수신/채택, 비용·늦은 결과·취소·재시작 |
| `application/conversation-service.ts`, `outbox.ts` | 향후 Knox의 수신 업무 연결과 전달 장부. MCP transport 자체와 혼합하지 않는다. |

`design/chapters/P0-reuse.md`는 SIEM/EDR·자산 MCP와 Knox MCP가 사용자 설명상 존재하되 archive 밖이며 실제 명세가 없다고 명시한다. 원본 Python 도구나 PostgreSQL 구현을 새 코어로 복사하는 방향은 이 결정과 맞지 않는다.

## 추천 단위의 범위

제품 바깥층에 MCP client transport와 Tool adapter를 두고, host가 설치한 명시 binding으로 기존 도구를 연결한다. 첫 실행 대상은 새 합성 문서/관측 자료를 제공하는 로컬 MCP 서버다. 대역 메서드만 호출하는 시험에 그치지 않고 실제 클라이언트↔로컬 서버 프로토콜과 중단/재접속을 확인한다. 첫 transport는 고정 실행 파일과 인자를 host가 지정한 stdio 후보가 가장 작은 범위이며, 실제 MCP가 다른 transport를 쓰면 별도 adapter로 확장한다. 모델은 실행 명령·환경 변수·임의 URL을 선택하지 않는다.

첫 업무 도구는 읽기 전용 1–2개로 한정한다. 범용 연결 wrapper와 특정 도구의 결과 해석을 분리한다. 문서/관측 두 합성 업무를 같은 wrapper에 넣되, 서버의 설명문이나 자유 형식 텍스트가 자동으로 Evidence 또는 완료 판정이 되지 않도록 한다. 원응답은 artifact로 보존하고, 명시 schema와 출처가 있는 mapping만 구조화 근거로 채택한다. 지원하지 않는 이미지/resource 참조는 자동 다운로드하지 않고 명시 거절 또는 제한된 raw artifact로 남긴다.

서버가 제공한 annotation은 권한이나 효과 보증이 아니다. effect, labels, destination, 허용 input/output, 캐시/페이지/재시도 가능 여부는 검토한 host binding이 결정한다. 쓰기 효과·중복 입력 대조와 Knox 발송은 실제 계약을 확인할 다음 단위로 남긴다.

도구 목록의 wire pagination과 기존 `ProviderToolSource.revision`도 자동으로 같은 의미라고 가정하면 안 된다. adapter는 확인한 목록 snapshot 의미에 맞춰 준비해야 한다. 공급자가 원자적 revision을 제공하지 않으면 host 승인 manifest와 변경 감지 정책을 사용하며, 원격 목록이 원자적으로 일치한다고 주장하지 않는다. 부분 실패가 기존 등록 목록을 폐기하거나 새 미승인 도구에 권한을 주어서는 안 된다.

## 착수 선행조건

- P3-04 계측 Chrome 단위의 소스·검증·기록을 먼저 고정하고, 다음 계획을 별도 챕터로 저장한다.
- 다음 구현 착수 때 공식 MCP 명세와 공식 TypeScript SDK의 호환 버전·지원 transport·취소/응답 의미를 확인해 pin한다. 이번 읽기 검토에서는 최신 규격이나 SDK 버전을 조사하거나 단정하지 않았다. JSON-RPC/MCP 프로토콜 자체를 임의 재구현하지 않는다.
- 합성/public 자료만 사용하는 로컬 실행 파일·인자·도구 allowlist·schema·등급/목적지·응답/페이지/동시 호출/시간 상한을 명시한다. 실제 모델·API 키·사내 endpoint가 없어도 이 범위는 정의 가능하다.
- 사내 연결은 별도 명세와 전용 테스트 범위 확인, G-DATA, transport/auth handle·취소·rate limit·cursor·부분 오류·효과 대조 계약을 통과한 뒤에만 진행한다. 이 외부 조건을 로컬 fixture로 대체하지 않는다.

## 완료 기준 — 다섯 가지

1. **실제 로컬 MCP 왕복**: 선택한 규격/SDK를 고정하고 로컬 서버 연결, 목록 읽기, allowlist의 1–2개 도구 호출을 수행한다. 문서와 관측 두 합성 업무가 공통 runtime을 사용하며, 서버 업무 로직을 코어에 복제하지 않는다. 모델/사내 서버/Knox 호출은 0이다.
2. **현재 계약과 공개 권한 유지**: 미승인 도구, schema/effect/version 변경, 다른 tenant/목적지/labels, 목록 부분 실패와 변경 중 호출을 제한한다. 목록/schema/원응답도 신뢰되지 않은 자료로 처리하고 자유 텍스트를 실행 지시나 Evidence로 승격하지 않는다.
3. **한 장부에 정확한 수명 기록**: 두 저장소에서 reserve→dispatch→receive/adopt, 취소/timeout/늦은 응답/프로세스 중단·재접속이 기존 장부를 사용한다. 실제 protocol call 수와 미관측 사용량을 구분하고, 전송 후 ACK 유실을 확인된 미호출로 바꾸거나 자동 재전송하지 않는다.
4. **bounded 목록·결과·페이지**: 도구/페이지/byte/시간/동시성 상한, 반복 cursor, malformed/초과 응답, 제한/부분 오류를 검증한다. 업무 데이터 pagination은 명시 지원하는 도구만 기존 read-collection에 연결하고 listing cursor와 섞지 않는다. 단일/페이지 호출 수와 실제 bytes를 기록한다.
5. **완료와 미완료를 분리한 결과**: 로컬 protocol 시험, 합성 업무 결과, 두 저장소 복구, 공개 화면의 결과/오류를 기록하고 client/server를 종료한다. P3-01에는 완료된 로컬 선행 범위를 추가하되 사내 MCP·Knox·실제 모델 조건은 미충족으로 유지한다. 다음 실제 binding에 필요한 정보 목록을 산출물로 남긴다.

이 챕터는 P3-01의 일부 기반을 실제 코드와 프로토콜로 채우며, 이후 Knox 전달 adapter와 P4의 역할별 수집·게시판 작업이 공유할 진입점을 제공한다. 전체 재설계의 다음 구현 대상으로 추천하지만, 본 문서 작성 자체가 새 구현이나 외부 실행을 시작한 것은 아니다.
