# P3-01 학습·구현: MCP 단발 읽기와 원본 검증

2026-09-06 · v0.39 · 로컬 단발 읽기 검증 완료, P3-01 진행 중

## 이번 챕터에서 배운 것

MCP 연결 성공은 서버와 통신했다는 뜻이다. 그 응답을 업무의 근거로 채택할 수 있는지는 별도 문제다. 이번 구현은 **승인 manifest → 현재 권한 검사 → 호출 의도 저장 → MCP 호출 → 원응답 보존 → host 해석 → 근거 채택**을 기존 런타임에 연결했다.

서버는 원자료를 반환하고, host가 검토한 mapper가 허용된 값만 facts로 옮긴다. 서버의 설명문·annotations·URL·오류 텍스트는 권한을 늘리거나 자동으로 사실이 되지 않는다. `sourceId/lineageId`는 자료의 출처를 가리킨다. 같은 자료를 두 번 읽어도 독립 근거 두 개로 세지 않는다.

오랫동안 실행되는 에이전트는 재시작 뒤 모든 도구를 다시 호출하면 안 된다. 이번 단발 adapter는 같은 attempt의 호출 의도를 한 번 저장한다. 이미 시작한 attempt는 숨겨진 재호출을 거절하고, 받은 응답은 원본과 해석 규칙을 다시 확인하여 사용한다. 연결이 끊겼을 때 명시적으로 다시 discovery하는 것은 이전 호출의 성공 확인이나 자동 재실행을 뜻하지 않는다.

## 구현과 재사용 경계

- [stdio client](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-stdio-client.ts)는 공식 SDK의 프로세스·프레이밍·파서를 사용한다. 고정 host executable/arguments/cwd/environment와 승인 도구 집합, 세대·크기·페이지·동시성·시간 한도를 적용한다.
- [읽기 Tool 연결](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-read-tools.ts)은 기존 ToolContracts·Broker·transaction·ArtifactStore·receive/adopt를 재사용한다. mapper revision과 원격 schema·endpoint/protocol을 host 계약 version에 결합한다.
- [Broker](/Users/seunghanee/Documents/secumon/runtime/src/application/tool-broker.ts)는 adapter 내부 대기 뒤 사용할 현재 권한 검사 callback을 제공한다. SDK의 마지막 stdio send 직전까지 이를 적용한다. 원격 전송과 상태 저장소의 정책 변경을 하나의 원자 transaction으로 만드는 것은 아니다.
- [합성 서버](/Users/seunghanee/Documents/secumon/runtime/src/tests/helpers/mcp-fixture-server.ts)는 문서와 관측 두 도구만 제공한다. 일반 코어에 SOC·SIEM 필드를 추가하지 않았다.

TypeScript SDK client/server **2.0.0**, MCP **2026-07-28**로 고정했다. client는 제품 의존성, server는 개발 fixture 의존성이다. 직접 의존성 2개와 lock 전이 패키지 13개가 추가됐고 기존 non-root lock entry는 수정·삭제하지 않았다. 이전 v0.38 정본과 설치 전 snapshot은 별도로 보존한다.

SDK의 최신 규격과 호환 동작은 설치 소스를 확인해야 했다. 이 버전은 wire의 `resultType: complete`를 검사한 뒤 반환 JSON에서 그 discriminator를 제거한다. 따라서 보존하는 원본은 **SDK가 정규화한 응답 JSON과 host envelope**다. 네트워크 패킷 원문으로 표현하지 않는다. 자동 input_required 처리와 응답 cache를 사용하지 않도록 구성했고 실제 input_required 교환 자체는 이번 시험에 포함되지 않았다.

## 정상·실패·재개 검증

최종 관련 **58/58**, 실패·취소·skip 0, 6007.401917ms다. 새 읽기 통합 28개·stdio client 14개와 기존 Broker 회귀 16개를 합친 분모다. 전체 native 검증도 **1,992/1,992**, 실패·취소·skip 0, 274506.735333ms로 통과했다. 코어 타입 검사·안쪽 계층98파일/위반0·합성4시나리오/22판정이 통과했다. [전체 검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-local-verification.json)을 기준으로 한다.

문서/관측 × SQLite/file journal의 네 정상 셀에서 원본 보존·facts 채택·offline proof 재검증을 확인했다. partial은 완전 coverage 조건을 충족하지 못하고 error/invalid는 근거를 만들지 않는다. 원본 변조·다른 attempt 원본·변경한 facts도 거절한다. 같은 출처의 반복 조회는 `minIndependentSources=2`를 충족하지 못한다.

대기 중 pause·정책 확대는 전송 0회다. 실제 응답 뒤 취소·자료 등급 철회는 원본 게시와 채택을 막는다. 목록 중 변경·중복·schema 불일치·반복 cursor·페이지 상한은 완전한 provider snapshot으로 게시되지 않는다. 목록 갱신만으로 새 도구를 자동 승인하지 않는다.

부분 종료를 포함한 두 오류를 고쳤다. 첫째, actor와의 교집합 정책만 비교하면 정책 확대가 감춰져 전송 뒤에야 응답이 거절될 수 있었다. 정본 정책 digest도 비교하도록 했다. 둘째, 전송 후 프로세스 종료 확인 오류가 sent=false로 바뀌어 사용량을 0으로 기록할 수 있었다. 전송 사실을 유지하고 명시적 종료 재확인을 허용했다. 소유 PID의 존재 확인만 일회성 오류로 주입하는 회귀로 확인한다.

재개 시험은 같은 Node 프로세스에서 저장소와 ExecutionRuntime을 다시 열고 저장 결과를 채택하는 범위다. 서버를 닫은 후 새 ToolContracts/validator를 구성하여 proof도 재검증한다. 실제 worker 프로세스의 강제 종료·전원 장애 복구까지 완료했다고 표시하지 않는다. peer crash는 fixture의 `process.exit(23)`이다. 지연 응답은 handler 완료 후 전송 대기 상태에서 취소·연결 종료되어 수신되지 않았다.

원본 body가 손상되면 채택을 거절하며, 기존 commitWithArtifacts는 거절 상태의 저장도 차단할 수 있다. 원본 무결성을 복구하거나 기존 lifecycle 절차로 격리해야 한다. 이를 자동 복구하거나 원본을 삭제하는 기능은 추가하지 않았다.

## 호출 비용을 읽는 방법

| 업무 | 상태 저장소 | 논리 도구/MCP call/서버 handler | 전체 요청 frame | 목록 page | 요청 frame bytes | decoded 목록+call bytes |
| --- | --- | --- | --- | --- | --- | --- |
| 문서 | SQLite | 1 / 1 / 1 | 4 | 1 | 1,156 | 1,764 |
| 문서 | file journal | 1 / 1 / 1 | 4 | 1 | 1,156 | 1,764 |
| 관측 | SQLite | 1 / 1 / 1 | 4 | 1 | 1,159 | 1,771 |
| 관측 | file journal | 1 / 1 / 1 | 4 | 1 | 1,159 | 1,771 |

각 셀은 단일 실행이다. 전체 요청 4개에는 discovery·구독·목록·도구 호출이 포함된다. frame bytes는 직렬화한 전송 시도량이며 전송 성공 확인량이 아니다. decoded bytes는 SDK가 반환한 목록과 call JSON을 세며, 폐기된 decoded call도 포함한다. 협상·알림 응답과 실제 stdout 수신 bytes 전체는 아니다. 원격 내부 작업·이미지·대기 계측을 알지 못하는 ToolUsage 필드는 null로 남긴다. 모델 호출은 0이고 속도 개선률이나 모델 품질은 측정하지 않았다.

[프로토콜 관측](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-protocol-final.json) · [재개/오류 관측](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-recovery-final.json) · [종료 관측](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-shutdown-final.json). 최종 별도 관측은 44개 fixture record, 자식 프로세스 45개 시작/종료다. 두 fixture 외 환경 설정 시험은 test log로 확인하며 이 분모에 합산하지 않는다.

## 실습과 다음 순서

관련 시험을 직접 실행하고 두 정상 업무의 원본/근거/호출 수 차이를 비교할 수 있다.

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm run build
node --test dist/tests/mcp-read-tools.test.js dist/tests/mcp-stdio-client.test.js
```

실습 질문은 세 가지다. 같은 source의 재조회 두 번이 왜 독립 근거 둘이 아닌가? 취소 알림을 보냈다는 사실과 원격 실행이 멈췄다는 사실은 어떻게 다른가? 저장된 성공 응답의 원본이 사라지면 다시 채택할 수 있는가? 해당 부정 대조 시험과 artifact proof를 같이 읽으면 답을 확인할 수 있다.

다음 소단위는 **기존 ReadCollections와 MCP의 batch/page 연결, cursor·snapshot·부분 실패·명시적 resume**다. cooldown/rate-limit scheduling과 전 페이지를 모은 업무 coverage 집계는 아직 지원한다고 표시하지 않는다. 사내 MCP 명세에 맞춘 host 승인 protocol profile(legacy 포함), HTTP/OAuth·인증·운영 자료·쓰기 효과·Knox는 별도 단계다. P3-01은 부분 검증/진행 중이며 전체 P0–P6 목표는 계속된다. 실제 모델/API 실험 취소를 유지한다.

공식 참고: [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [stdio 규격](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio), [도구 규격](https://modelcontextprotocol.io/specification/2026-07-28/server/tools). [챕터 계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-mcp-adapter-plan.md).

수정 전 중간 읽기8/22·18/22·audit 환경0/24·수정후24/24와 관련57/57을 보존한다. 종료 확인 오류 수정 전 전체 실행은 exit143으로 중단했고 소유15개 PID 잔여0을 확인했다. 최종 제품/시험 소스의 검증 후 수정은 하지 않았다.
