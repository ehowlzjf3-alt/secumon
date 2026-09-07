# C05 collection custody B 인수 staging

신규 helper 1개와 시험 3개를 작성한 상태이며 제품에 적용하거나 실행하지 않았다. 정적 등록 기준 18개 시험이다. 빌드·타입 검사·시험·SSH·네트워크 실행은 root가 통합 후 담당한다.

| 제품 적용 예정 경로 | 정적 사례 수 | 범위 |
| --- | ---: | --- |
| `src/tests/mcp-collection-accounting-fixture.ts` | helper | A의 실제 저장소·Broker·ReadCollections fixture를 재사용한다. 두 번째 요청의 decoded capture 뒤를 유한 barrier로 고정하고 원 영수증/ref만 관찰한다. |
| `src/tests/stored-read-usage.test.ts` | 6 | 진행 중 부분합 금지, pause/deadline 축소와 원 lease의 구분, received에 의한 호출 집합 종료, ticket 발행/원 소유자/영수증 검증, 무관 ref 제외, 후반 영수증 조회에서 이미 읽은 head의 실제 삭제·치환 거절. |
| `src/tests/mcp-collection-accounting.test.ts` | 6 | lease가 닫은 두 호출의 null→known 정련, 같은 head에서 늦은 영수증 발견, 두 runtime의 정산 경합·멱등성, 부모 두 호출과 자식 한 호출의 분리, 기존 결과·영수증·예산 보존, known 측정 충돌 거절. |
| `src/tests/mcp-collection-custody-context.test.ts` | 6 | 취소·라벨 축소 뒤 종료된 원 호출의 증명된 custody만 투영 제외, 두 저장소 reopen, 현재 running head/result/evidence의 required 우선, 무관 보호 ref와 손상 영수증 거절. |

실제 SQLite/file-journal 저장소를 사용하지만 C01 일반 profile/CLI/HTTP 입구 시험은 아니다. 이 B 묶음의 응답은 기존 A fixture의 고정 decoded transport다. 실제 SDK/stdio capture는 A의 별도 사례이며 B의 18개를 실제 원격 전송 검증으로 표현하지 않는다.

공유 A fixture와 기존 시험은 수정하지 않았다. 각 회계 검사에서 실제 source callback 계수와 원 byte/ref/receipt를 비교한다. accounting만 변경할 수 있는 필드는 원 attempt.execution 및 해당 트랜잭션의 revision/updatedAt으로 한정한다. 새 dispatch/adopt/근거 생성/추가 논리 호출을 허용하지 않는다.

정본 `ExecutionRuntime.recover`의 비가시 readProgress 본문 재조정 생략을 사용한다. fixture는 recover 오류를 catch해서 성공으로 바꾸지 않는다. 일반 workflow의 captured-only 복구 경로, SIGKILL, 일반 입구 reopen, lifecycle 삭제 정책 확대는 별도 인수이며 이 파일들이 새 API를 가정하지 않는다.

barrier는 실제 두 번째 capture 또는 두 정산 commit 도착에 묶었다. 각각 20초/10초 제한이 있고 finally에서 해제·배출한다. 시험별 상한은 최대 45초다. 영수증이 없는 고아 파일을 찾아 복구하는 경로는 없다.

`manifest.json`은 새 파일과 읽은 의존 파일의 handoff 시점 지문이다. 제품 전후 불변 증명이나 빌드 pin이 아니며, 과거 A 검증 결과를 B의 검증 결과로 승격하지 않는다.
