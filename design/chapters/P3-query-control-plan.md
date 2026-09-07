# P3-02 세 번째 단위: 조회 비용과 동시 편집

2026-09-06 · 개념 → 계획 → 구현 → 검증 → 학습 기록

## 문제와 배울 개념

화면에 표시할 카드 수와 저장소가 읽는 양은 다르다. 기존 Web 목록은 모든 업무 ID를 가져오고 표시 가능한 20개를 찾을 때까지 조회했다. 진단은 모든 이벤트 본문을 읽고 마지막 50개만 표시했다. 파일 저널은 조회마다 전체 기록을 해석하고 상태를 다시 만들었다.

목표 revision과 실행 제어 revision도 다르다. 사용자가 목표 편집 폼을 연 뒤 다른 채널에서 모드를 변경하면 목표 revision은 같을 수 있다. 제출 전 화면 재조회만으로는 재조회와 커밋 사이의 변경을 막지 못한다. 같은 상태 변경 트랜잭션에서 두 revision을 검사해야 한다.

## 변경 계약과 순서

1. StateRepository에 `recentEventMetadata(workId, {throughRevision, limit})`와 `conversationWorkPage({tenantId, principalId, channel, conversationId, cursor?, limit})`를 추가한다. 이벤트는 지정 revision까지 최신 최대 50개 메타데이터와 생략 수, 업무는 한 페이지 최대 20개 후보와 다음 내부 커서를 반환한다. 전체 감사/재생 메서드는 유지한다.
2. SQLite는 트랜잭션 안의 비파괴 schema migration과 이벤트 메타데이터/대화 바인딩 인덱스를 사용한다. journal은 디렉터리 키 순서의 최대 limit개 후보만 이력을 확인한다. 빈 후보 페이지도 다음 커서로 진행한다. 각 adapter의 순서는 안정적이어야 하며 adapter 간 물리 순서가 같을 필요는 없다.
3. journal cache는 매 읽기의 본문 hash, 권한, 디렉터리/store identity, chain, fsync 검사를 생략하지 않는다. 검증된 prefix의 JSON/schema/상태 재생을 재사용하고 append만 해석한다. cache 크기를 제한하고 재시작/퇴거 후 전체 검증으로 돌아간다. cold/warm 본문 I/O와 metadata 열거는 여전히 이력에 비례하므로 상수 비용이라고 주장하지 않는다.
4. WorkView의 읽기 전용 포트와 composition을 연결한다. 진단은 metadata 전용 조회를 사용하고 현재 권한/근거/상태의 재검사를 유지한다. Web 목록은 한 후보 페이지만 소비하고 각 반환 카드를 재검사한다. 외부 커서는 내부 정렬키/숨겨진 업무 ID를 노출하지 않는 인스턴스별 상한·만료가 있는 handle이다. 만료/다른 인스턴스의 커서는 명시 오류이며 목록 갱신으로 다시 시작한다.
5. 모든 goal 변경 명령에 expectedControlRevision을 필수로 한다. 코어 mutator 안에서 현재 goal/control을 검사하므로 CAS 재시도에도 오래된 편집을 거부한다. CLI는 명시 control revision을 받고 Web은 사용자가 편집한 draft의 revision을 보낸다. 같은 요청의 중복 영수증 의미는 유지한다.

## 완료 기준과 검증

- 세 저장소의 최근 이벤트/페이지 계약, revision 경계, 빈 페이지 전진, 잘못된 cursor, Unicode ID, 재시작, SQLite migration과 동기 갱신을 확인한다.
- journal의 warm cache에서도 변조·삭제·교체·권한·동시 append·fsync 실패를 거부하거나 현재 상태로 반영하는지 확인한다. Node 파일 읽기 bytes와 재해석/재생 수를 분리해 실제 절감 범위를 기록한다.
- Web 목록에서 권한 없는 후보가 많아도 한 호출이 무제한 진행하지 않으며, 권한이 철회된 anchor 없이 다음 페이지로 진행하는지 확인한다. 현재 권한과 근거 재검사, 조회의 commit/put/send 0을 유지한다.
- 두 영속 adapter에서 stale control, CAS 경합, 동일 요청 재시도, 누락 revision, 성공 revision 증가와 CLI/Web 입력 계약을 확인한다.
- 관련 targeted 시험 이후 고정 Node의 전체 `npm run verify`를 실행한다. 원본 1,973파일·dependency lock·이전 검증 기록을 보존하며 새 증거와 소스/빌드 대응을 저장한다.

전체 P0–P6 목표와 외부 선행 조건을 유지한다. 중단한 키 탐색/실제 모델 시험이나 미제공 MCP·Knox·운영 adapter 연결을 재개하지 않는다. 이번 단위의 로컬 통과가 실제 모델 품질이나 전체 P3 배치를 검증한 것은 아니다.
