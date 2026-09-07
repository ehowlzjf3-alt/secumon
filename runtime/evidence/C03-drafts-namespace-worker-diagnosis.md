# D2 attempt-3 #113 — namespace 경합과 자식 오류 관측

2026-09-07 · 원로그 분석, 로컬 진단 두 개, 회귀 소스 작성 · 수정본 빌드/시험은 root 확인 전

원 [drafts-targeted.log:694](C03-drafts-linux-nas-20260907/attempt-3/drafts-targeted.log#L694)의 #113은 약 12.2초 뒤 `ABORT_ERR`로 끝났다. 이는 부모의 `once(message)` 12초 대기에서 발생했다. 당시 helper는 premature exit와 message 대기를 연결하지 않았고, abort 오류에 child stderr/exit/받은 메시지를 붙이지 않았다. **원 NAS 실패에서 자식이 왜 메시지를 보내지 못했는지는 이 로그만으로 확정할 수 없다.** 앞선 same-ID 시험은 통과했지만 그것이 different-ID 실패 원인을 설명하지 않는다.

## 관측한 두 진단

| 관측 | 결과와 해석 |
|---|---|
| 기존 build3의 실제 different-ID worker 두 개를 gate에서 경쟁시킨 단회 로컬 실행 | 양쪽 `committed`, exit 0, stderr 없음, namespace head 2. [원 스크립트](C03-drafts-namespace-worker-diagnostic.mjs)와 [결과 JSON](C03-drafts-namespace-worker-diagnostic.json)에 받은 IPC·exit·컴파일 파일 지문을 남겼다. 기존 NAS 경합 원인이 사라졌다는 근거가 아니다. |
| 같은 build3 public commit에서 pending-only 목록 뒤 실제 canonical hardlink를 만드는 결정적 단회 실행 | `DocumentFiles.pending → #scan → #snapshot → commit`에서 `metadata_read_unsafe`가 실제 발생했다. [원 스크립트](C03-drafts-namespace-stale-list-probe.mjs)와 [결과 JSON](C03-drafts-namespace-stale-list-probe.json)에 원 stack과 모듈 지문이 있다. 정상 inode의 링크 수가 2로 변했지만 captured names에 canonical peer가 없어서 발생하는 독립 namespace 결함을 입증한다. NAS #113과 같은 원인이었다고 단정하지 않는다. |

두 진단은 Node24.20.0의 현재 dist를 사용했으며 source pin은 `6ba26f7b1f070e6429c16644b5af2a196582613125bdcc71dba8fb529d9f2f92`에 속한다. 일반 pair와 결정적 fixture를 각각 한 번만 실행했고 반복 stress는 하지 않았다. 자식 종료·임시 fixture 정리를 마쳤다. 모델·실서비스·NAS 호출은 없었다.

## 최소 변경과 검증 대기

[document-knowledge-boundaries.test.ts](../src/tests/document-knowledge-boundaries.test.ts)의 부모 helper는 spawn 직후 IPC를 구독해 먼저 온 메시지를 보관한다. stderr가 닫힌 실제 close에서 대기자를 거절하고, timeout에도 mode·pid·exit·받은 메시지·stderr를 남긴다. 12초 메시지 제한과 15초 자식 종료 제한을 늘리지 않았다. 각 대기 timer는 응답·종료·정리 때 제거한다.

[document-knowledge-worker.ts](../src/tests/helpers/document-knowledge-worker.ts)는 contention의 준비 신호를 최초 한 번만 보낸다. 재시도 때 준비 신호를 결과 메시지로 잘못 받지 않도록 했다. early IPC 두 개를 child close 후 읽고 실제 exit 23/stderr를 확인하는 회귀 하나와, 실제 pending/canonical link 사이에 늦게 온 두 번째 기억이 commit되어 재오픈 후 두 기억/head 2를 유지하는 회귀 하나를 추가했다. 전역 host 읽기 주입은 별도 worker 안에만 있으며 가짜 metadata나 제품 hook을 사용하지 않는다.

제품 수정은 별도 담당의 [DocumentFiles.read](../src/infrastructure/document-knowledge-owner.ts)에 있다. `unsafe/read`일 때 같은 directory ref로 bounded names를 다시 관측해 목록이 달라진 경우에만 원 cause를 가진 `changed/read`로 반환한다. caller가 snapshot을 처음부터 검증하게 하며, 옛 목록에 새 peer를 끼워 넣어 읽기 권한을 넓히지 않는다. 이 공통 수정으로 owner와 namespace 경계가 같은 원칙을 사용한다.

이 문서는 수정본 회귀 통과 기록이 아니다. root의 build4와 관련 시험이 필요하며, 기존 NAS #113의 실제 child 오류가 유실됐다는 한계는 그대로 남긴다. 이후 같은 실패가 생기면 개선한 helper의 원 exit/stderr를 근거로 판단해야 한다.
