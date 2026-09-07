# P3-01 MCP adapter 기록 helper 준비

새 helper와 입력은 최종 실행값이 없는 초안이다. 제품·시험·기존 정본을 수정하지 않았고 설치·build·MCP 실행도 하지 않았다. `ready:false`, null 및 `not_run` 항목을 통과로 해석하면 안 된다.

- helper: `runtime/evidence/P3-mcp-adapter-record.cjs`
- 미확정 입력: `runtime/evidence/P3-mcp-adapter-verification-input.json`
- 생성할 새 정본: `runtime/evidence/P3-mcp-adapter-local-verification.json`
- 기준 계획: `design/chapters/P3-mcp-adapter-plan.md`

## 이전 기록과 의도한 의존성 변경

v0.38 정본 202,932 bytes·1,950 통과를 SHA256 `e4a7d322d62135b1628209d3e386d64f0b3b91a1f42924275b0f915e38488725`로 고정했다. dependency-before JSON도 5,956 bytes, SHA256 `36f997a932890f4a2857b62d65f290c5c5269f953d875a8f914a3e7c91588432`로 고정한다.

기존 정본·고정 로그·artifact 체인은 당시 해시로 대조한다. 옛 `sources/buildFiles/buildManifest`의 pin을 현재 파일에 적용하거나 기존 정본을 재생성하지 않는다. 이번 lock은 `dependencyLockUnchanged:false`와 `dependencyChange.intentional:true`를 함께 기록한다.

최종 입력에는 다음을 실제 설치 관측으로 채운다.

1. 최종 package/lock SHA256과 정확한 설치 명령·exit code·고정 로그. helper는 설치를 실행하지 않는다.
2. 승인한 직접 의존성 delta. client 2.0.0 제품/server 2.0.0 개발은 초안에 포함했다. core를 직접 import하여 추가한다면 그 exact version과 category를 `allowedDirectChanges`에 명시한다. 초안이 변경을 자동 승인하지 않는다.
3. 기존 lock entry 중 수정·삭제된 경로를 독립 검토한 뒤 `reviewedModifiedExistingPackages`/`reviewedRemovedExistingPackages`에 정확히 적는다. 추가·수정·삭제의 전체 내용과 resolved/integrity는 helper가 새 기록에 보존한다.
4. helper는 설치된 client/server의 package metadata와 lock의 exact 2.0.0을 대조한다. 이 검사는 설치된 모든 package 본문의 공급망 attestation이나 재설치 성공을 뜻하지 않는다.

## 최종 시험과 관측 입력

`verify`와 `targeted`는 실제 command/log/exitCode/testsPassed를 채운다. skip이 있으면 별도 수와 이유를 남긴다. 작업 목록의 새 `new_test_groups` 합과 `additional_tests`는 `최종 testsPassed - 1950`이어야 한다. 별도 protocol 실행 수가 이미 전체 npm 시험에 포함됐으면 두 번 더하지 않는다.

`protocol`, `recovery`, `shutdown`은 각각 summary JSON, log 목록과 실제 JSON field 검사를 지정한다. `checks` 형식은 `[{"pointer":"/passed","equals":true}]`이다. JSON pointer `/a/0/b` 및 `~0`/`~1` escape를 지원한다. 성공·실제 SDK stdio 여부·오류/skip·서버 호출/재시도·종료 등 핵심 필드를 실제 summary에서 검사하도록 채운다.

protocol/recovery summary에는 관측에 사용한 code digest가 있어야 한다. `sourceDigestPointer`를 실제 필드에 맞추며 최종 code/build digest와 같아야 한다. 파일명이나 `passed:true` 선언만으로 SDK 실행을 입증했다고 표시하지 않는다. `observation`은 루트가 선언한 의미·분모이며, 실제 summary 검사와 hash를 함께 보존한다.

첫 범위는 host 승인 **read-only stdio**다. 프로토콜 버전은 협상된 실제 값을 채운다. HTTP/OAuth, 실제 사내 MCP, 쓰기 효과 대조, ReadCollections resume는 false/미검증으로 남긴다. 취소 알림을 원격 실행 취소 완료로 표현하지 않으며 stored-result 재채택이 다시 tools/call을 보내지 않는지 확인한다.

논리 tool call, 연결/listing/protocol request, 원격 내부 작업량, byte, wait를 구분해 `costDenominators`에 기록한다. 모르는 원격 비용은 0으로 바꾸지 않는다. decoded SDK JSON 보존과 raw wire byte 보존도 구분한다.

## 작업 목록과 최종 실행

초안 revision은 v0.39이며 최종 루트 값을 사용한다. helper는 `P3-01 status=in_progress`, `local_contracts=partially_verified`, `actual_mcp=local_stdio_verified`, `actual_model=not_run`, 전체 완료 작업 9개와 남은 범위를 요구한다. 실제 사내 명세·인증/G-DATA를 이번 로컬 통과로 충족 처리하지 않는다.

`acceptanceEvidence`에는 실제 신규/관련 시험 경로를 넣는다. 최종 원본 1,973개, 문서/작업 의존/JSON/guidance, source/build stamp와 소유 프로세스/임시 파일 정리가 확인된 뒤에만 `ready:true`로 바꾼다.

아래 명령은 준비 작업에서 실행하지 않았다. workspace 루트에서 루트 담당자가 최종 확정 후 실행한다.

```sh
runtime/.tools/node-v24.20.0-darwin-arm64/bin/node runtime/evidence/P3-mcp-adapter-record.cjs --input runtime/evidence/P3-mcp-adapter-verification-input.json
```

helper는 이번 새 정본만 쓴다. 기존 정본·source·dist·lock에는 쓰지 않으며 build/test/install/프로세스 시작 명령을 호출하지 않는다. 최종 실행 시 source 또는 증거가 바뀌면 실패하고, 실패를 이전 성공 기록으로 덮지 않는다.

## 초안 자체 확인과 종료 증거 주의

Node 24.20.0의 `--check`로 새 helper 문법을 확인했고 미확정 입력 JSON도 parse했다. helper main, build, 시험, 설치, MCP 프로세스는 실행하지 않았다. 실제 최종 기록 생성은 여전히 미실행이다.

설치 직후 읽기 대조에서는 승인한 client/server 2.0.0 두 직접 추가와 lock의 새 전이 entry 13개가 확인됐으며 기존 non-root entry 수정·삭제는 없었다. 이전 v0.38 정본 및 설치 전 snapshot 해시는 위 고정값과 같았다. 최종 helper는 이 중간 관측 대신 최종 package/lock을 다시 검사한다.

설치된 SDK의 `StdioClientTransport.close()`는 마지막 SIGKILL을 보낸 뒤 실제 exit/close를 끝까지 기다리지 않으며 내부 process 참조도 먼저 비운다. 따라서 adapter snapshot의 `pid:null` 또는 `processCloses` 증가만으로 `ownedProcessesStopped:true`를 채우면 안 된다. 소유 fixture의 pid를 시작 시 보존하고, 시험 종료 단계에서 실제 프로세스 종료를 별도로 관측한 결과와 로그를 shutdown summary에 남긴다.
