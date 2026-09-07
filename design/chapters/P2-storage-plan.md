# P2-01 — 두 번째 영속 구현으로 저장 계약 확인

2026-09-05 · 구현 계획 · P1-06/07 실제 모델 조건은 별도 유지

이번 질문은 “인터페이스 이름만 같은가, 저장 보장까지 교체되는가?”이다. 같은 코어가 상태·사건·outbox·중복 영수증을 하나로 커밋하고, 다른 프로세스에서 다시 읽을 수 있어야 한다.

## 선택과 구현 범위

[P0 ADR](/Users/seunghanee/Documents/secumon/design/chapters/P0-adr.md)에 후보로 기록한 파일 기반 영속 구현을 선택한다. SQLite를 계속 기본으로 두고 제한된 로컬 적합성 profile로 `FileJournalStateRepository`를 추가한다. 실제 PostgreSQL 서버/새 모델/사내 서비스 연결은 요구하지 않는다. 메모리 대역을 디스크에 덤프하는 시험으로 대신하지 않고 두 프로세스가 직접 경합하는 영속 저장소를 구현한다.

- 코어의 StateRepository 및 업무 규칙을 변경하지 않는다. 새 adapter, 공통 계약 시험, 외부 composition/profile 선택을 추가한다.
- work별 revision 번호의 불변 record에 CommitRequest 전체와 이전 기록 hash를 저장한다. 임시 파일 작성·fsync 뒤 배타적 hard link로 revision 이름에 공개해 CAS 승자를 결정한다. 상태/사건/전달/영수증을 별도 파일에 나누어 부분 커밋하지 않는다.
- `EEXIST` 이후 현재 영수증을 먼저 확인한다. 같은 명령/같은 digest는 최초 commit의 state를 반환하고 다른 digest는 idempotency conflict다. 다른 명령의 stale revision은 CAS conflict로 반환한다.
- 읽기에서도 공개된 record의 무결성을 검사하고 디렉터리 fsync를 수행해 공개 직후 아직 쓰기 호출이 완료되지 않은 기록을 내구성 확인 없이 반환하지 않는다. 신규 work/root 디렉터리의 부모 항목도 동기화한다.
- 공개 후 fsync/응답 실패는 완료 여부 불명으로 취급하고 record를 삭제하지 않는다. 같은 명령의 receipt 확인으로 대조한다. 공개 전 임시 파일은 현재 상태에 포함하지 않는다.
- root/work 경로·파일 형식·revision·chain hash·command 중복·work ID를 검사한다. 기존 심볼릭 링크와 열린 인스턴스가 관찰한 디렉터리 교체를 거부한다. hash는 무결성 확인이며 인증 서명이 아니다.

Node의 파일 API는 직접 내구성·CAS 계약을 제공하는 DB가 아니므로 adapter가 이를 조합해야 한다. `link`와 파일 동기화 API는 [Node 24 파일 문서](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseslinkexistingpath-newpath)와 [동기화 문서](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlesync)를 참고하되 동작 보장은 프로젝트 Node 24.20.0의 로컬 시험으로 확인한다.

## 검증 순서

1. SQLite/파일 저널에 동일 계약 suite를 적용한다. receipt 우선순위/역사 snapshot·원자적내용·입력/조회 복제·tenant/주체/대화 분리·event cursor·runnable 시간/시도/모델 상태를 비교한다.
2. 별도 프로세스의 같은 revision/같은 명령/서로 다른 digest 경합과 commit 후 SIGKILL·재시작·중복 재시도를 두 구현에서 확인한다.
3. 파일 adapter의 공개 전/공개 후 장애, 저장 내용/chain/경로 오류와 읽기 중 동시 append를 검사한다. 부정확한 partial success를 반환하지 않는지 확인한다.
4. CLI profile에서 명시적으로 backend를 선택한다. 기존 데이터 폴더에서 다른 저장소를 조용히 열어 업무가 사라진 것처럼 보이지 않도록 profile 선택을 검증한다. 기존 SQLite 사용은 유지한다.
5. 문서/합성 관측의 같은 workflow와 실패/재개 경로를 두 영속 구현에 적용한다. 범용 코어에 backend 분기가 없어야 한다.
6. 전체 npm run verify와 소스/원본/문서 검증을 실행하고 결과·측정 범위·남은 조건을 저장한다.

## 범위와 보장 한계

이 구현은 로컬 POSIX 파일 시스템의 제한된 적합성 실험이다. 공유 네트워크 파일 시스템, Windows, 대규모 처리량, 전원 상실은 검증하지 않은 범위다. SIGKILL은 프로세스 종료 시험이며 전원 차단 시험이 아니다. 전체 이력 읽기와 상태 복사에 따른 비용은 기록한다. 인덱스·압축/GC·장기 보존·백업 이행은 후속 단계다.

hash chain은 중간 누락/변조를 검출하지만 마지막 record 또는 전체 work directory의 삭제는 독립된 외부 head 기준 없이 정상적인 짧은 이력과 구분할 수 없다. 같은 UID의 악의적 파일 교체나 저장소 rollback까지 방어한다고 주장하지 않는다. 권한 경계와 백업/복원은 P2-06/P6에서 별도 검증한다.

P1-07의 실제 모델 완료 조건은 유지한다. 이번 구현의 로컬 적합성 통과를 실제 모델/사내 연동 검증으로 확대하지 않고, 선행 전체 작업 상태와 별도로 기록한다.
