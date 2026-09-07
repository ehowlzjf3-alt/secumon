# 로컬 Web fixture 최종 읽기 검토

2026-09-06. 코드 읽기만 수행했다. 제품·시험·dist 수정, 브라우저/서버 시작, 실제 모델/API 실행은 하지 않았다. 아래 판단은 단일 localhost 계측 앱과 프로그램이 발생시키는 DOM 이벤트 범위다. native OS 입력이나 일반 사내 사이트에 대한 검증이 아니다.

## 발견과 조치 상태

1. **reload 뒤 과거 applied operation을 not_applied로 재분류 — 소스 보완 확인, 실행 대기.** renderer의 `operations`는 reload하면 사라지지만 서버 영수증은 남는다. 새 driver로 이전 exact lease/request를 보내면 기존 코드는 lease 거절을 `not_applied`로 반환했다. 이전 synthetic driver의 `reopened full ledger cannot relabel an old applied command` 계약과 모순된다. 전달 뒤 최신 [page의 act](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/local-web-computer-page.ts:204)에 epoch/surface 불일치를 capacity/lease 검사보다 먼저 `unknown`으로 반환하는 보완을 확인했다. 실제 browser 회귀에서는 fresh lease 조회가 기존 applied 영수증을 찾고 입력/Save 횟수가 증가하지 않는 것을 함께 확인해야 한다. 이 검토에서는 실행하지 않았다.

2. **사람이 입력 중인 최신 DOM 값을 앞선 저장 응답이 되돌릴 수 있음 — 루트에 전달, 소스 검토 시점 미해소.** [handleInput](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/local-web-computer-page.ts:142)은 trusted 입력마다 `/api/human` 요청을 독립 전송한다. 응답과 SSE가 호출하는 [applyState](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/local-web-computer-page.ts:84)는 Query/Note의 `.value`를 서버 snapshot으로 무조건 덮는다. 앞선 글자 요청의 응답을 기다리는 동안 다음 글자를 입력하면 과거 snapshot이 최신 미저장 DOM을 되돌릴 수 있다. 그 사이 계속 입력하면 의도한 글자가 유실된다. 서버 revision의 단조 검사만으로는 아직 서버에 저장되지 않은 DOM 값을 보호할 수 없다. 최소 권고는 사람 입력의 전송 순서를 고정하고, 입력 중인 필드의 최신 generation/dirty 상태가 과거 ACK·SSE로 덮이지 않게 하는 것이다. 자동화 `pending`과 영수증 처리는 별도 기존 경계를 유지해야 한다.

두 번째 회귀는 첫 `/api/human` 응답을 지연한 상태에서 연속 타이핑하고, 지연 해제 전후와 최종 저장 뒤 DOM/앱의 문자열이 입력한 전체 문자열과 같은지 확인하는 것으로 충분하다. 관측만으로 실제 네트워크 요청 순서를 가정하지 않는다.

## 읽기로 확인한 보존 경계

- 서버의 `persist`는 앱 상태와 영수증을 한 JSON에 넣어 임시 파일 저장·file fsync·rename·directory fsync 순서로 게시한다. 오류가 나면 `storageUncertain`을 유지하고 이후 일반 작업을 거절한다. rename 후 실패를 rollback하거나 not_applied로 바꾸는 경로는 없다.
- `/api/effect`는 identity 중복을 먼저 확인하여 앱 입력/Save 카운트를 다시 올리지 않는다. 적용된 앱 상태와 영수증이 저장된 뒤 Save 응답을 잃게 하는 fault는 renderer에서 `unknown`이 된다. missing/conflicting 영수증 조회도 unknown이다.
- renderer는 view/ref/unique target/visible/enabled/focus/lease/deadline을 확인하고 target focus 뒤 다시 확인한 다음 같은 동기 구간에서 DOM 입력을 발생시킨다. `dispatched` 이후 예외와 저장 응답 실패는 unknown이다. DOM 입력 전에 거절된 새 operation만 not_applied로 분류한다.
- 새 document와 서버 재시작은 epoch를 증가시키고 과거 lease를 무효화한다. 영수증은 이전 epoch의 identity를 보존하며, 현재 same-work lease로 조회한다. 서버는 다른 work identity의 조회를 거절한다.
- 첫 `close()`는 readiness timer, pending control, stream, lease, 서버 연결을 정리하고 서버 close 완료를 기다린다. 동시 두 번째 `close()`는 `stopping` 때문에 즉시 반환하므로 모든 close 호출자가 같은 종료 완료를 기다리는 계약은 아직 아니다. 현재 순차 단일-owner teardown의 blocker로 분류하지 않았다.

## 실행 증거의 범위

현재 `local-web-computer.browser.ts`의 14개 시나리오에는 동일 목표 8셀, DOM/ref/focus/target 거절, 권한 callback 중 변경, page reload 뒤 과거 영수증 조회, Search 대기, 두 저장소의 Save 응답 유실→명시 대조→verify가 포함된다. 실제 실행 결과는 루트의 별도 browser 로그를 기준으로 해야 한다.

이 파일에는 같은 stateFile을 사용하는 **fixture 서버 재시작**과 rename/fsync 실패의 실제 browser 회귀가 없다. page reload 통과를 서버 프로세스 종료·전원 차단·물리 저장 실패 시험으로 확대하면 안 된다. temp 파일이 실패 뒤 남을 수 있으며, 서버 파일의 다중 프로세스 CAS나 적대적 동일 UID 교체는 이 cooperating fixture의 보장 범위가 아니다.

검토 중 읽은 소스 pin은 다음과 같다. 이후 루트 보완은 별도 최종 source/build pin으로 판단한다.

| 파일 | bytes | SHA256 |
|---|---:|---|
| `runtime/src/infrastructure/local-web-computer-fixture.ts` | 21194 | `476831c64724eab309cd9ea7352fd736952aef0f14ab05feda96f816b1577cfe` |
| `runtime/src/infrastructure/local-web-computer-page.ts` | 28045 | `fbfea273e2d1cf016f27f325db2df4d5387674b154b300bf93ade478d124e99f` |

P3-04의 로컬 진전 근거이며, 전체 계획 완료나 native driver 검증으로 표시하지 않는다.
