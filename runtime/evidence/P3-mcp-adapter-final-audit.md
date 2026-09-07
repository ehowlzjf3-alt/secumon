# P3-01 MCP adapter 최종 관련 기록 독립 감사

2026-09-06 02:59:40 UTC · Node 24.20.0 · 읽기·JSON parse·SHA256 대조만 수행했다. 제품/시험/dist/기존 정본을 수정하거나 build, 시험, MCP 서버 또는 외부 서비스를 실행하지 않았다. 이 문서만 새로 저장한다.

**이 시점 전체 `npm run verify`는 루트에서 진행 중이며 통과 미확정이다.** 아래 58/58은 수정 후 관련 시험의 고정 로그이고, 이전 전체 실행은 수정 전 판본에서 exit 143으로 중단됐다. 이전 실행을 현재 전체 통과로 대체하지 않는다.

## 마지막 client 수정 확인

- [call 실패 처리](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-stdio-client.ts:223)는 호출을 보낸 뒤 shutdown이 실패해도 `McpCallError('mcp_close_unconfirmed', dispatch.sent)`를 반환한다. cleanup 오류가 실제 전송을 `sent:false`로 낮추던 경로는 source 기준으로 해소됐다.
- [shutdown](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-stdio-client.ts:111)은 같은 closing promise를 공유하고, 그 promise가 실패했을 때 여전히 동일한 promise일 경우에만 null로 돌린다. 뒤의 명시 close는 종료를 다시 확인할 수 있으며, 기존 concurrent caller가 새 close promise를 지우지 않는다. 성공 시 promise를 유지해 processCloses를 중복 증가시키지 않는다.
- [응답 계측](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/mcp-stdio-client.ts:219)은 SDK가 반환한 decoded value의 byte 수를 현재 session/signal 검사 전에 계수한다. 이후 폐기한 decoded 응답도 포함한다. 이 수치는 전체 stdout wire byte나 SDK가 decode 전에 거절한 응답 byte를 뜻하지 않는다.
- [새 회귀](/Users/seunghanee/Documents/secumon/runtime/src/tests/mcp-stdio-client.test.ts:191)는 실제 owned fixture의 호출 후 종료 probe에 일회성 EPERM을 주입하고 sent=true/호출 1회/active 0/processCloses 0을 확인한다. 이어 명시 concurrent close 두 개, 실제 pid ESRCH, 최종 processCloses 1과 반복 close 불변을 확인하도록 저장돼 있다. 관련 최종 로그에 해당 시험이 포함돼 있다.

이 수정 범위에서 추가 확정 correctness blocker를 확인하지 못했다. 취소 notification 또는 SDK promise 종료를 원격 handler 취소 완료로 해석하지 않는 계약은 유지한다.

## 수정 후 관련 시험과 측정

고정 로그: [P3-mcp-adapter-targeted-final-v2.log](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-targeted-final-v2.log), 5,629 bytes, SHA256 `1a4941c64970f20c61c9a62f7afed733b82d0f1a1ff4da3afec6b97efa106638`.

- tests/pass 58, fail/cancelled/skipped 0, duration 6007.401917 ms.
- 분모: MCP read 28 + client 14 + 기존 Broker 16 = 58.
- `mcp-adapter-final-v2` JSON은 44 rows다. read 28 rows/28 test names, transport 16 rows/12 test names다. 한 client 시험이 여러 fixture를 쓰며, host config 및 환경 확인 시험은 이 fixture row 형식을 쓰지 않는다. 따라서 44를 별도 시험 수로 더하지 않는다.
- 모든 row의 test name이 관련 로그에 있고 codeDigest가 현재 pin과 같았다. 모든 row는 activeCalls 0, pid null, connected false, processStarts=processCloses 및 shutdown의 ownedProcessStopped/temporaryFilesCleaned true를 기록한다. 확인 실패 0이다. 이는 저장된 관측·시험 source 대조이며 이 감사가 프로세스를 다시 시작하거나 과거 pid를 재검사한 것은 아니다.

| row 집합 | rows | process starts / closes | tools/call 계수 / fixture handler 진입 | requestBytes | responseBytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| read / 두 backend | 28 | 28 / 28 | 26 / 26 | 33,812 | 60,728 |
| transport | 16 | 17 / 17 | 11 / 11 | 19,619 | 29,160 |

위 합계는 여러 정상·부정 fixture를 묶은 기술적 계수이며 처리량·지연 SLO가 아니다. requestBytes는 adapter send에서 serialize한 메시지, responseBytes는 계수 지점의 SDK-decoded list/call value이며 서로 같은 wire 분모가 아니다. 원격 내부 작업량을 0으로 추정하지 않는다.

44개 파일을 경로 순서대로 `{path,bytes,sha256}`로 만들고 기존 canonical JSON 규칙으로 해시한 집합 digest는 `586a5de287c02298fad17d1f6a7b316a2bf4d466aa4999a425beb7f3509e99bc`다.

## 현재 source/build pin

제품 module을 실행하지 않고 `evaluationCodePin/evaluationBuildFiles`와 같은 경로 순서 및 canonical SHA256 규칙을 파일 읽기에 적용했다.

- 현재 source codeDigest: `8efcfb9a66d80aace6fae6b2293e6033ff10b58dac9080bceac75ea3b0ede9fc`.
- 44개 row 및 `dist/build-manifest.json.sourceDigest`와 일치한다.
- code pin 대상 파일 287개, compiled 파일 822개. 이 287은 src/scripts/fixtures와 지정 package/config를 합한 code pin 분모이며 전체 문서/원본 파일 수가 아니다.
- 실제 compiled 파일 hash 목록과 build manifest가 일치하고, src.ts 각각에 대응하는 `.js/.js.map/.d.ts` mapping이 정확하다.
- compiled 목록 digest: `14c97386e46718a4ee0d2c0feeee89f33824e8bbdc08637671dead6e1f8ef4ef`.
- manifest Node와 감사 Node는 모두 v24.20.0이다. 이는 로컬 source/build 일관성 확인이며 cryptographic build attestation은 아니다.

## 중단 실행과 이전 정본 보존

[P3-mcp-adapter-interrupted-shutdown.json](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-mcp-adapter-interrupted-shutdown.json)은 281 bytes, SHA256 `c0c4d4db47d08f83cab7644160a448484bb527d74aaf40a597980cf1b7cd3031`이다. 2026-09-06 02:57:21 UTC에 이전 세션 exitCode 143, 소유 PID 15개와 remainingPids 빈 배열을 기록한다. 이 감사는 해당 저장 기록을 확인했고 중단된 live 로그를 최종 성공 로그로 고정하지 않았다.

| 보존 대상 | bytes | SHA256 / 결과 |
| --- | ---: | --- |
| v0.38 local-web-driver 정본 | 202,932 | `e4a7d322d62135b1628209d3e386d64f0b3b91a1f42924275b0f915e38488725` · 고정값 일치 |
| v0.38 전체 verify 로그 | 245,753 | `54f2d747bd5e4e9ebcac1786839236b2484432785df47def895ac530fce81b01` · 정본 pin 일치 |
| extraction manifest | 420,378 | `d4655e259eece6de1ec2537fdb7a4f79fe0faf07313ad8e1468cf8e85a572e3a` · 정본 pin 일치 |
| v0.37 continuation-runner 정본 | 190,463 | `26aaf65d6d106f0b1b7df696bb343da1e4f787c667f95925d9b3a9db39664127` · v0.38 parent pin 일치 |

manifest의 original 1 + parts 4 + joined 1 + extraction.files 1,967 = **1,973개**를 모두 현재 regular file 여부·크기·SHA256로 대조했다. 합계 **26,637,668 bytes**, 누락·크기·hash·파일 유형 불일치 **0**이다. 원문 내용은 출력하지 않았다. workspace `.git`과 runtime `.git`도 없다.

현재 package-lock은 이 MCP 단위의 의도한 SDK 추가로 변경됐으므로 v0.38 lock과 동일하다고 주장하지 않는다. v0.38 정본에 저장된 당시 lock pin과 정본 자체는 보존하며, 최종 dependency delta는 준비한 새 기록 helper에서 별도로 대조한다.

이 감사는 P3-01의 로컬 read-only stdio adapter 단위만 지원한다. 전체 재설계·실제 사내 MCP·HTTP/OAuth·쓰기 효과·모델 실행 완료를 뜻하지 않는다.
