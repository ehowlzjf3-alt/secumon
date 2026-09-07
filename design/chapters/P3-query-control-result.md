# P3-02 조회 효율과 동시 편집: 학습·결과

2026-09-06 · v0.32 · 로컬 합성 자료 · 전체 1,536개 시험 통과

이번 단위는 화면 조회가 전체 사건 본문과 모든 표시 후보를 무제한 따라가지 않도록 바꾸고, 목표 편집 중 다른 채널의 실행 모드 변경을 덮어쓰지 않게 했다. [계획](/Users/seunghanee/Documents/secumon/design/chapters/P3-query-control-plan.md)에 따라 구현·실패 수정·복구 검증·비용 관측을 마쳤다. P3-02의 로컬 계약은 verified이며 전체 작업은 실제 모델 등 선행 조건이 남아 in_progress다.

## 배울 개념

**화면에 20개만 표시하는 것과 20개 후보만 검사하는 것은 다르다.** 이전 목록은 모든 업무 ID를 읽고 표시 가능한 카드를 찾을 때까지 진행했다. 이제 한 요청이 최대 20개 후보를 소비하고, 권한 때문에 모두 빠져도 다음 페이지가 있음을 표시한다. 다음 페이지는 사용자가 명시적으로 연다. 현재 권한·원본 검사를 생략해 얻은 절감이 아니다.

**캐시는 어떤 일을 생략하는지 설명할 수 있어야 한다.** 파일 저널의 warm 조회는 이미 검증한 기록의 JSON 해석과 상태 재생을 재사용한다. 기존 본문을 다시 읽고 해시를 확인하는 일은 유지한다. 그러므로 이번 개선을 전체 이력의 상수 비용 조회라고 부르지 않는다.

**목표 revision과 제어 revision은 서로 다른 변경을 나타낸다.** 목표 폼을 연 뒤 CLI에서 fast를 deep으로 바꾸면 목표 revision은 그대로일 수 있다. 화면의 제출 전 재조회만으로는 그 직후의 변경을 막지 못한다. 목표를 커밋하는 동일 변경 함수 안에서 두 revision을 검사하고, 저장 충돌 뒤 재시도에도 다시 검사해야 한다.

## 구현한 계약

| 영역 | 현재 동작 |
| --- | --- |
| 사건 진단 | `recentEventMetadata`가 표시 state revision 이하의 최근 최대 50개 `sequence/revision/type/at`와 생략 수를 반환한다. 사건 data 본문을 화면에 전달하지 않는다. |
| 대화 목록 | `conversationWorkPage`가 최대 20개 후보와 저장소 내부 cursor를 반환한다. WorkView는 반환할 카드의 현재 공개 조건을 다시 검사한다. |
| 외부 cursor | Web은 내부 키 대신 무작위 handle을 제공한다. 인스턴스당 최대 128개, 15분 수명이며 만료·다른 인스턴스에서는 명시 오류와 목록 갱신을 안내한다. 연결 해제된 anchor도 다음 페이지 진행을 막지 않는다. |
| SQLite | v1 및 개발 중간 v2에서 v3으로 트랜잭션 이행한다. 정본을 보존하고 작은 메타데이터·대화 연결 색인을 생성한다. 원본 테이블 trigger로 이미 열린 v1 writer의 정상 변경도 같은 트랜잭션에서 반영한다. |
| 파일 저널 | 원래 schema 1을 유지한다. 본문·권한·identity·chain·directory sync 검사 뒤 검증된 prefix를 재사용한다. 다른 writer가 추가한 기록만 새로 해석한다. |
| 목표 변경 | `expectedGoalRevision`에 더해 양의 안전한 정수 `expectedControlRevision`이 필수다. 오래된 제어 값이면 상태·사건·영수증을 바꾸지 않고 거절한다. |
| 화면 | 다른 채널 변경 때 작성 내용과 초점을 보존하고 제출을 막는다. 사용자가 최신 기준을 명시적으로 읽은 후 재제출할 수 있다. 빈 후보 페이지 안내와 현재 카드 수를 실제 목록에 맞췄다. |

코어 포트는 SQLite나 PostgreSQL을 요구하지 않는다. Memory·SQLite·파일 저널에 같은 조회 의미를 적용하되 adapter별 내부 순서는 다를 수 있다. cursor는 권한 증명이 아니며 여러 업무를 묶은 단일 시점 snapshot도 아니다. 진행 위치 앞에 추가된 업무는 목록 새로 고침으로 찾는다.

## 실제 검증과 실패에서 배운 점

[최종 로그](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-verify.log)의 Node 24.20.0 `npm run verify`는 exit 0, **1,536/1,536·실패 0**, 136301.29025ms다. 코어 별도 타입 검사·안쪽 계층 86파일/위반 0·합성 4시나리오/22판정도 통과했다. 이전 1,483개에 저장 조회 28·원자 제어 17·공개 조회 8개를 추가했다. 마지막 targeted도 53/53 통과다. 별도 lint 명령은 저장소에 없다.

새 시험은 오래된 revision·실제 CAS 경합·동일 명령 재확인·두 영속 저장소 재시작·CLI subprocess·로컬 HTTP 경로를 확인했다. 조회 시험은 revision 경계, 빈 페이지 전진, cursor 수명, anchor 연결 해제, 현재 권한 재검사와 조회 중 commit/put/send 금지를 확인했다. 저널에서는 cache가 있어도 변조·삭제·권한/identity 변경·동시 append·fsync 실패를 처리하고 관측 head가 늦은 ACK 때문에 뒤로 가지 않는지 확인했다.

중간 실패도 보존했다. 첫 targeted의 4개 실패는 CLI 음수 옵션 전달 문법과 접수 사건 수 기대값을 고쳤다. 두 번째의 7개 중 4개는 무효한 빈 binding fixture를 고쳤고, 3개는 실제 SQLite trigger 결함이었다. 복수 binding이 같은 대화 관계를 만들 때 중복 insert가 발생해 `SELECT DISTINCT`로 수정했다. 중간 v2 DB의 기존 trigger도 교체하도록 v3 이행 회귀를 추가했다. 정상 writer가 pending hardlink를 정리하는 metadata 경합은 한 번만 재읽고 계속 변하면 거절하도록 검증했다.

[독립 검토](/Users/seunghanee/Documents/secumon/design/chapters/P3-query-control-review.md)에서 발견한 기존 writer 색인 누락, cache 밖에 남는 record identity, 늦은 ACK의 head 역행, options의 신뢰된 조회 범위 덮어쓰기도 수정했다. 제품/시험 소스는 마지막 전체 검증 후 변경하지 않았다.

## 비용 관측

[고정 비용 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-read-cost.json)은 생성한 임시 자료만 사용했고 종료 후 삭제했다. [계측 스크립트](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-read-cost.mjs)도 원문으로 보존했다. 스크립트는 기존 결과의 덮어쓰기를 거절한다. 아래 값은 동일 업무 get의 관측이다.

| 기록 수 | 상태 | 해석/재생 기록 수 | 읽고 raw hash한 본문 bytes |
| --- | --- | --- | --- |
| 32 | 새 repository | 32 / 32 | 137,552 |
| 32 | 같은 repository 재조회 | 0 / 0 | 137,552 |
| 64 | 새 repository | 64 / 64 | 275,216 |
| 64 | 같은 repository 재조회 | 0 / 0 | 275,216 |

다른 인스턴스가 1개를 append한 뒤에는 새 1개만 해석·재생했고 현재 상태와 메타데이터가 일치했다. 재시작하면 전체 33/65개를 다시 검증·재생했다. 45개 업무의 journal 페이지당 이력 검사 후보는 20/20/5였으며, 마지막 5개만 해당 대화에 속한 경우 반환량은 0/0/5였다. 디렉터리 목록과 metadata 검사는 전체 업무 수에 비례해 남는다.

SQLite 실행 SQL과 EXPLAIN에서 사건 메타데이터·대화 연결의 covering index 사용을 확인했다. 목록은 21개 ID로 다음 페이지 존재를 판정하고 최대 20개를 반환했다. 새 조회 SQL은 전체 state/event body를 선택하지 않았다. 공개 카드의 현재성 확인에는 별도 WorkView/원본 조회 비용이 든다.

이 값은 Node 파일 읽기 bytes와 SQL 반환 행/JSON bytes다. 물리 디스크 I/O·OS cache miss·운영 처리량 측정이 아니다. cold는 새 repository의 빈 projection cache를 뜻한다. 단일 elapsed 관측을 운영 지연 개선율로 해석하지 않는다. 저널 기본 32MiB 상한은 직렬화한 projection의 계산값이며 JavaScript heap 전체 상한이 아니다. 관측 head·업무·디렉터리 bookkeeping은 관측한 업무 수에 비례한다.

## 실제 화면 관측

[브라우저 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-browser-verification.json)에 8개 확인과 PNG·DOM을 저장했다. 20개 후보가 비공개인 빈 페이지에서 더 보기를 눌러 나머지 3개를 표시했다. 목표를 편집하는 중 CLI로 fast→deep을 요청한 뒤 작성한 제목·초점을 유지하고 제출을 차단했다. 명시 재조회 후 목표 revision 3을 저장하면서 deep을 유지했다. 상세 조회가 카드를 다시 넣을 때 표시 수 1/실제 카드 1/빈 안내 숨김도 확인했다. 콘솔 오류는 0이며 임시 탭·서버를 종료했다.

이번 브라우저는 최종과 동일한 frontend와 최종 SQLite 이행 보완 전 임시 서버를 사용했다. 최종 DB schema 이행·원자성은 이후 repository/HTTP 시험의 근거를 따른다. 이전 [Web 15개 관측](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-web-browser-verification.json)의 390/320px·키보드·읽기 위치 검사를 모두 다시 했다는 뜻은 아니다. 이번 변경은 CSS/layout 정책을 바꾸지 않았다. 실제 Knox·사람의 읽음·조직 SSO·IME/스크린리더·분산 worker 검수는 포함하지 않는다.

## 직접 확인할 부분과 호환성

먼저 `status <work-id> --json` 또는 Web 상세에서 현재 목표와 제어 revision을 확인한다. 기존 실행 방법과 프로필 선택은 [runtime README](/Users/seunghanee/Documents/secumon/runtime/README.md)를 따른다.

```sh
node dist/presentation/cli.js change-goal <work-id> \
  --file goal.json --goal-revision <N> --control-revision <M> \
  --request-id <고유한-요청-ID>
```

같은 요청을 재확인할 때는 ID와 본문·두 revision을 그대로 사용한다. 오래된 편집을 최신 기준으로 새 제출할 때는 상태를 다시 읽고 새 ID를 사용한다. CLI 음수 값 검증을 실습할 경우 `--control-revision=-1`은 revision 검증에 도달하지만, 공백 뒤 `-1`은 옵션 parser가 먼저 거절할 수 있다.

필수 control revision이 없는 이전 goal 클라이언트 요청은 이제 거절한다. 과거 요청에 현재 revision을 자동 보충하지 않는다. 이미 저장된 예전 요청에 필드를 추가하면 digest가 달라 같은 요청 ID에서 충돌한다. 기존 사건 전체 조회와 감사/재생 API는 남아 있고 새 페이지 비용 상한을 갖는 API로 바뀐 것은 아니다.

## 다음 단위

P3-02 로컬 계약을 verified로 기록하고 전체 status는 in_progress, 완료 작업 수는 9개를 유지한다. 다음 독립 로컬 단위는 **P3-04 합성 컴퓨터 유즈 계약·runner**다. 관찰→행동→결과 확인, 짧은 묶음, 조건 대기, 세션 소유권과 사용자 인계를 작은 계획으로 구체화한다.

P2-04/P2-06의 로컬 계약을 재사용할 수 있으나 실제 OS/앱/브라우저·driver 선택, 실제 화면 권한, 실제 환경의 성공률·왕복·이미지·지연 비교는 미충족으로 남는다. 실제 모델/API 시험은 사용자 요청대로 중단 상태다. 사내 MCP·Knox·운영 컴퓨터 유즈·배포는 이번에 호출하지 않았다. [검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/P3-query-control-local-verification.json)에서 최종 source/build와 원본·이전 근거 보존을 대조한다.
