# 관측 이력 보존과 구간 이어가기

2026-09-09 · checkpoint401.

새 관측 저장에는 자동으로 적용된다. 사용 중인 SQLite/file-journal/PostgreSQL 포트를 유지하고 개인기억이나 대화 저장소를 새로 만들지 않는다. 실제 실행 검증은 이번 SQLite/file-journal 로컬 범위다.

`seen`은 현재 구간의 사건 ID·본문 해시 목록이고, `seenHistory`는 과거 구간의 확정된 원영수증으로 가는 연결이다. 컨텍스트를 버리거나 과거 사건을 잊는 동작이 아니다. 오래된 ID가 다시 도착하면 원기록을 대조한다. 과거 자료가 누락되거나 현재 권한에서 차단됐으면 정상적으로 계속 처리됐다고 표시하지 않는다.

이전 버전에서 `closed/event_capacity`로 멈춘 개별 업무 관측만 호스트의 `profile.missions.continueAfterCapacity(workId, ruleId)`로 명시적으로 재개할 수 있다. `workId`는 해당 업무 ID, `ruleId`는 그 업무에 등록한 관측 규칙 ID다. 현재 상태를 조회한 뒤 호출하며 별도의 새 CLI 명령은 아니다. 활성 관측·취소/완료된 업무·다른 종료 사유를 이 API로 다시 열지 않는다. 일반 등록 재전달도 용량 종료를 해제하지 않는다.

현재 참조 목록에서 사라진 관측 checkpoint도 원 파일과 원 명령 영수증에 남는다. 현재 디렉터리의 저장량을 줄이려고 과거 파일·영수증을 임의로 이동하거나 삭제하면 이력 조회가 끊길 수 있다. 백업·복원·저장소 이행은 기존 lifecycle 기능으로 수행하며, 이번에 축소한 참조와 원자료가 함께 보존되는 인수는 C10에 이어 둔다.

[결과](C09-retained-history-result.md) · [남은 확인 목록](../REMAINING-ACCEPTANCE.md).
