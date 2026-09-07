# P3-04 로컬 Web driver 학습·구현 결과

2026-09-06 · v0.38 · 로컬 구현·정상/실패/복구 검증 완료

## 이번에 배운 개념

실제 Web 도구는 승인, 입력, 저장, 확인을 구분해야 한다. 이 네 시점이 같은 프로세스에 있는 합성 driver와 달리, 런타임에서 승인한 뒤 브라우저 메시지가 이동하고 DOM 이벤트가 발생하며 앱 서버가 저장한다. 응답을 못 받았다는 사실만으로 입력이 없었다고 판단할 수 없다.

이번 경로는 `intent 저장 → 현재 런타임 승인 → typed browser 명령 → renderer의 현재 화면/권한 검사 → DOM 입력 → 앱과 영수증 동시 저장 → 새 화면 확인`이다. 저장 응답이 깨지면 `unknown → 현재 읽기 권한으로 영수증 조회 → 정산 → 입력 없는 verify`로 이어간다. 모델의 긴 대화문을 다시 넣지 않아도 저장된 작업·증거·진행 장부로 이어가는 실제 예다.

## 구현과 재사용

- [Web driver](../../runtime/src/infrastructure/instrumented-web-computer-driver.ts): host가 주입한 Playwright Page에 고정된 typed 명령을 전달한다. 모델이 JavaScript나 URL을 고르지 않는다. 입장 시 요청을 복사하고 같은 operation을 다시 전송하지 않는다.
- [실제 폼과 DOM bridge](../../runtime/src/infrastructure/local-web-computer-page.ts), [localhost 앱 서버](../../runtime/src/infrastructure/local-web-computer-fixture.ts): Query/Search/Note/Save, 실제 DOM 관찰·focus/ref·epoch, 앱 저장과 영수증, 사람 인계와 직렬 저장을 구현했다.
- 기존 ComputerDriver·observe/act/continue/verify·Broker·상태/원본 저장소·영수증 정산·compact 검사를 재사용했다. core에 Query/Note나 Playwright 의존성을 넣지 않았다. 본체는 여전히 PostgreSQL과 Python에 의존하지 않는다.
- `renderer-gated-dom-v1`이라는 입력 보장을 도구 계약 digest에 고정했다. 기존 driver가 필드를 생략하면 기존 계약 형태를 유지한다. DOM 자동화를 native OS 입력으로 표시하지 않는다.
- [실습용 실행 진입점](../../runtime/src/presentation/local-web-computer.ts)과 `computer:fixture`, `verify:computer-web` 명령을 추가했다. Playwright는 host 설치본을 주입하고 package-lock 의존성은 바꾸지 않았다.

## 계획과 완료 기준에 대한 결과

| 확인 대상 | 관측 결과 |
|---|---|
| 실제 브라우저와 공통 runtime | Chrome152.0.7977.76 + Playwright1.62.1, SQLite/file-journal 모두 동일 목표 완료 |
| stale 화면/ref, 초점, 숨김·비활성·중복 요소, 부분 관찰 | 실제 DOM 입력0·앱 입력0, 승인 callback 중 rerender도 차단 |
| DOM 입력과 앱 저장 | 정상 메모 목표에서 DOM 입력2·앱 입력2·저장1을 각각 확인 |
| 응답 불확실성과 재개 | Save 저장후 잘린 JSON 응답 → unknown → 정확한 영수증 → verify, 두 저장소 모두 추가 입력/저장0 |
| reload·앱 재개 | 새 epoch가 과거 lease를 거절, 과거 operation을 not_applied로 재분류하지 않음. 서버를 닫고 같은 저장 파일로 다시 열어 앱/영수증 보존 확인 |
| 사람 입력과 UI 호환 | 지연된 첫 응답 중 연속 타이핑 보존, 비신뢰 DOM 이벤트도 사람 입력으로 처리하며 agent lease 해제·agent receipt0 |
| 화면 | 앱 Browser에서 fill·검색·저장·제어권 반환, 1280/390/320px 가로 넘침0, 최신 입력/저장값 보존 |
| 정리 | 자동 시험의 fixture19개와 테스트 브라우저 종료. 별도 UI 탭·서버 종료, viewport 복원, 해당 로컬 포트 연결 거절 확인 |

별도 [실제 browser gate](../../runtime/evidence/P3-local-web-driver-browser-verification.json)는 **17/17, 실패·취소·skip0, 12,083.736208ms**다. 일반 native 시험 분모에 이 17개를 더하지 않는다. [새 계약/adapter 시험](../../runtime/evidence/P3-local-web-driver-targeted-final.log)은 **20/20**이며, 6개 assurance와 14개 adapter 경계를 다룬다. 전체 Node24.20.0 npm run verify는 **1,950/1,950, 실패·취소·skip0, 267380.279834ms**로 통과했다. 코어 타입 검사·안쪽 계층98파일/위반0·합성4시나리오/22판정도 통과했다.

## 같은 목표의 호출 비용 비교

처음부터 note=reviewed를 저장하고 현재 savedNote를 확인하는 같은 목표를 비교했다. 개별 방식도 첫 fill의 최신 관찰을 다음 Save에 재사용한다. 불필요한 observe를 추가하여 기준선을 부풀리지 않았다. 모든 셀은 입력2·저장1·모델 호출0으로 완료했다.

| 저장소 | driver | 개별 도구 호출 → batch | 관찰/입력 RPC → batch | 실행 관측 ms: 개별 → batch |
|---|---|---:|---:|---:|
| SQLite | 합성 | 3 → 2 | 7 → 6 | 422.4 → 289.0 |
| SQLite | Web | 3 → 2 | 7 → 6 | 451.2 → 342.0 |
| file-journal | 합성 | 3 → 2 | 7 → 6 | 917.5 → 670.9 |
| file-journal | Web | 3 → 2 | 7 → 6 | 938.0 → 740.9 |

Web에서 세션 획득/반환을 포함한 browser bridge 명령은 **13→10**, renderer의 HTTP 호출은 **10→8**이었다. 표의 RPC는 ToolUsage가 집계한 observe/act 등 호출로, 전체 네트워크 비용과 같은 분모가 아니다. 모델 왕복 감소를 실측한 것도 아니다. 이미지 입력은 사용하지 않았으며 UI QA의 스크린샷은 별도다. 각 셀1회 로컬 관측이므로 일반적인 속도 향상률이나 p95를 주장하지 않는다. [8셀 원자료](../../runtime/evidence/P3-local-web-driver-comparison.json)에 시간·DOM/HTTP/앱 지표를 따로 저장했다.

## 구현 중 발견하고 고친 것

1. 승인 await 중 원본 요청이 바뀔 수 있어, 입장 시 snapshot으로 identity·전송·응답 비교를 고정했다. 전송후 미관측 내부 비용은0 대신 null로 남긴다.
2. 설치된 Playwright의 기본 bundled browser는 없어 첫 gate가 시작에 실패했다. 추가 설치 없이 독립 Chrome 세션을 명시했다. 사용자 브라우저 프로필을 사용하지 않았다.
3. 무응답 socket 종료는 Chromium이 같은 HTTP 요청을 재시도할 수 있었다. 앱의 operation 중복 방지는 저장을 반복하지 않았다. 이후 ‘저장후 응답 본문 유실’은 잘린 JSON으로 별도 주입하여 unknown 흐름을 검증했다.
4. reload 뒤 비어 있는 renderer 캐시가 과거 applied 작업을 not_applied로 바꿀 수 있었다. 과거 epoch/surface는 unknown을 유지한다.
5. 과거 ACK/SSE가 아직 저장하지 않은 최신 글자를 덮을 수 있었다. 사람 쓰기를 순서대로 보내고, 정확한 최신 ACK 이전에는 dirty 입력을 보존한다. 사람 쓰기의 불확실 실패 뒤에는 다음 Save를 자동 실행하지 않는다.
6. 앱 Browser의 일부 fill은 isTrusted=false 이벤트를 발생시켰다. 유효한 non-pending 폼 입력을 사람 편집으로 받아 제어권을 해제하고 저장한다. 이 경로로 agent 영수증이 생기지 않음을 확인했다. 진행 중 전체 검증은 이 수정 때문에 명시 중단하고 최종 코드를 다시 검증한다.

중간 실패/중단 로그는 `runtime/evidence/P3-local-web-driver-*`에 보존했다. 과거 검토 문서의 당시 finding과 최종 수정 결과를 구분한다.

## 직접 따라 해보기

```sh
cd /Users/seunghanee/Documents/secumon/runtime
export PATH="$PWD/.tools/node-v24.20.0-darwin-arm64/bin:$PATH"
npm run computer:fixture
```

출력된 localhost URL을 열어 메모를 저장한다. `Ctrl+C`로 서버를 닫는다. 기본은 메모리 저장이며 파일 유지가 필요하면 `SECUMON_FIXTURE_STATE_FILE`에 명시 경로를 준다. 이 페이지는 학습용 앱이며 일반 업무 웹이나 사내 화면이 아니다.

현재 host의 실제 browser 시험은 다음과 같다. 다른 host는 설치한 Playwright entry와 지원 browser channel을 지정한다. 경로가 없으면 자동 설치/성공 skip 없이 실패한다.

```sh
export SECUMON_PLAYWRIGHT_MODULE=/Users/seunghanee/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs
export SECUMON_BROWSER_CHANNEL=chrome
export SECUMON_WEB_EVIDENCE_DIR="$PWD/evidence/my-web-lesson"
npm run verify:computer-web
```

## 한계와 다음 챕터

브라우저의 renderer 안에서는 마지막 검사와 DOM 입력을 같은 동기 구간에서 실행한다. host 승인과 RPC 도착 사이의 즉각적인 권한 철회까지 원자적으로 보장하지는 않는다. 전송후 취소는 진행 중 입력을 되돌렸다는 증거가 아니며 unknown/조회 경로가 필요하다. 영수증은 이 계측 앱의 저장 의미이고 일반 사이트의 성공문구로 만들 수 없다.

native OS 입력·일반 사내 사이트, 서버 SIGKILL/전원차단·fsync 장애, 다중 프로세스 세션 소유권, 장기간 영수증 보관과 무제한 운영 성능은 이번 실제 browser 검증에 포함하지 않았다. 영수증/operation은256개로 제한하며 확실한 이력 없이 자동 퇴거하지 않는다. v1 continuation 및 입력 전 관찰 중단 정산, 깊은 계보의 반복 원본 I/O 개선도 후속 과제다. 실제 모델/API 실험은 중단 상태다.

P3-04는 부분 검증/진행 중, 전체 P0–P6 목표도 진행 중이다. 다음 로컬 챕터는 **P3-01 기존 MCP 재사용 adapter와 실제 로컬 protocol fixture**다. 기존 카탈로그·Broker·장부를 재사용하며 사내 MCP/Knox 명세를 추측하지 않는다. [다음 단위 검토](../../runtime/evidence/P3-local-web-driver-next-chapter-review.md)와 [이번 계획](P3-local-web-driver-plan.md)을 참고한다.

구현 의미 확인에 사용한 공식 문서: [Playwright page.evaluate](https://playwright.dev/docs/api/class-page#page-evaluate), [MDN Event.isTrusted](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted), [HTMLElement.click](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/click). 관측값은 위 로컬 실행 기록에 근거한다.
