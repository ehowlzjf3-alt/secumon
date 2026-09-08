# C09 규칙 재사용과 사건 페이지 조회

2026-09-09 · checkpoint396. 실행 결과는 별도 결과 문서를 따른다.

## 같은 담당에서 다음 목표로 이어가기

`runtime.command(workId, commandId, actor, expectedGoalRevision, { kind: 'goal', goal, expectedControlRevision })`로 실제 목표를 변경한 뒤 `missions.register(workId, rule)`을 호출한다. 동일 rule.id를 써도 새 목표의 관측은 커서 0, 빈 사건/중복 확인 목록, 점유 없음으로 시작한다. 새 목표에서는 resourceId나 주기 등 규칙 내용도 새로 정할 수 있다. 담당·업무·세션·기억을 다시 만드는 절차가 아니다.

새 등록은 과거 목표의 닫힌 mission 규칙을 현재 목록에서 제외한다. 규칙 이름을 계속 바꾸어도 과거 목표가 현재 16개 한도를 소진하지 않는다. 현재 목표의 닫힌 규칙과 다른 provider의 규칙은 자동 제거하지 않는다. 따라서 현재 목록의 16개 한도는 계속 적용된다.

현재 목표에서 동일 ID/동일 내용의 재등록은 기존 상태를 반환한다. 같은 ID의 내용을 바꾸면 `mission_idempotency_conflict`다. 현재 목표에서 호스트가 닫은 규칙은 재등록으로 자동 재개되지 않는다. 같은 목표에서 삭제 세대가 달라진 checkpoint는 기존 조회 검사를 통과해야 하며 과거 데이터를 이어받지 않는다.

과거 source가 현재 호스트 구성에서 제거돼도 새 목표의 새 source 등록은 가능하다. 새 등록의 슬롯 정리는 과거 원문 조회를 요구하지 않는다. 원 사건과 checkpoint 파일, 발행 영수증, 원 목표 변경 명령의 영수증은 그대로 남는다. 과거 checkpoint 본문에는 당시 active 상태가 기록될 수 있고, 이후 goal 명령의 영수증이 종료를 기록한다. 과거 본문에 현재 상태를 덮어쓰지 않는다.

## 저장소 사건 조회 계약

호스트 내부 `StateRepository.eventPage(workId, query)`는 다음 조회를 지원한다. 이 포트 자체를 에이전트용 권한 없는 조회 도구로 노출하지 않는다. 호출하는 서비스가 담당·업무 권한을 검사해야 하며 임무 런타임은 기존 검사를 유지한다.

```ts
const query = { afterRevision: 10, throughRevision: 40, limit: 32, type: 'user_command' };
const first = await state.eventPage(workId, query);
if (first.nextBeforeSequence !== null) {
  const next = await state.eventPage(workId, { ...query, beforeSequence: first.nextBeforeSequence });
}
```

- revision은 저장된 업무 상태 번호, sequence는 그 업무의 사건 순번이다. 한 상태 변경에서 사건이 여러 개 나올 수 있으므로 서로 대체하지 않는다.
- afterRevision은 제외, throughRevision은 포함한다. 다음 페이지도 같은 throughRevision을 사용하면 이후 추가된 이력이 끼어들지 않는다.
- beforeSequence는 제외하며 사건은 최신 순으로 반환한다. limit은 1~128이다. type을 생략하면 종류를 가리지 않는다.
- 반환값은 원문 StoredEvent이며 요약/근거 승격/완료 판정이 아니다. nextBeforeSequence가 null이면 해당 조회 범위가 끝난 것이다.

임무의 제어 확인은 checkpoint 발행 뒤의 user_command만 페이지당 32개 조회한다. 완료 복구는 최신 완료 뒤의 허용된 종료 기록을 원 완료 영수증에 차례대로 적용해 현재 상태와 대조한다. 같은 검증 안에서 발행 영수증은 재사용하지만 저장 직전에는 다시 읽는다.

SQLite와 PostgreSQL은 SQL의 범위·종류·LIMIT를 적용한다. 파일 저장소는 매 조회 전체 원기록 읽기·해시 검사를 유지하고 반환·복제 본문만 줄인다. 전체 저장 공간이나 실제 물리 디스크 I/O가 일정해지는 기능은 아니다. 에이전트의 세션 compact 및 기억 선택과도 별개다.

PostgreSQL은 연결 어댑터 구현과 기록용 전송 대역 시험이며 실제 서버 검증은 남는다. 사용자 모델/API 시험 중단은 유지한다.
