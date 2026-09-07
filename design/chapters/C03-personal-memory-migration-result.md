# C03 D3 — SQLite 개인 기억의 문서 이관 진행 결과

2026-09-07 · Checkpoint265 · 지원 POSIX의 D3 구현·로컬 및 Linux 검증 완료. C03 전체와 전체 goal은 진행 중이다.

한 담당의 모든 사용자 개인 기억을 SQLite에서 문서 저장으로 옮기는 관리 명령을 연결했다. 기억 ID·최신 본문·원 영수증과 출처를 보존하며, 같은 세션과 compact 요약을 이어 쓴다. 업무 기억과 대화·작업 상태의 저장 방식은 유지한다. 초기 설정 파일을 덮어쓰지 않고 최종 activation(새 저장소를 선택하는 기록)으로 현재 개인 기억 저장소를 선택한다.

`memory-migrate preview`는 범위와 용량을 확인한다. `apply`는 확인한 snapshot 지문과 현재 데이터를 대조하고 검증된 백업을 만든다. 그 뒤 SQLite 개인 쓰기를 차단하고 문서 초기 기록을 복사·검증하여 전환한다. `resume`은 같은 작업 ID를 사용하고, `status`는 진행 상태를 보여 준다. 백업은 본문 전체를 메모리에 올리지 않는 전용 worker를 사용하며, 문서 importer는 초기 seed와 이후 일반 정정을 구분한다.

최종 소스는 macOS 신규 **38/38**·관련 **315/315**, NAS Linux 전체 **3,038/3,038**·신규 **38/38**·관련 **315/315**을 통과했다. NAS의 빌드·코어 타입·구조·CLI 구조 fixture·일반 fixture도 통과했으며 원로그/결과 9개를 회수해 해시를 대조했다. [확정 증거](../../runtime/evidence/C03-migration-verification.json). 실사용 DB·실제 모델/API·사내 서비스는 검증하지 않았다. Windows는 실행 연결 구현과 실제 검증이 모두 남아 있다.

- 초기 ID·설정·배정 파일과 대화/작업 DB 유지, compact 요약·동일 세션·원 명령 영수증 보존
- 문서 정본에서 새 정정, 초기 논리 revision과 이후 CAS 연결, tenant/principal 분리
- source fence 이후 기존 개인 쓰기 거절과 새 엔진의 업무 기억 유지
- 백업 진행 중 부모 SIGKILL, source fence 전후·seed·format·activation 전후의 실제 자식 종료와 같은 작업 재개
- 게시 후 fsync 오류의 원인·게시 상태 보존과 재개 시 동기화
- 담당 폴더 이동, 새 ID/storeId로 복제, 조회·복제의 원본 기억 파일 보존
- 이관 기록 소실이나 문서 target 누락이 SQLite fallback·빈 DB 초기화를 만들지 않는 경계

최종 검증 지문은 source `ec05dcfed7b088acb215327038a0f5fe98a9a7191f4f306274872c0252b1cfa7`, build `b2121d43b479389f3541dbcbfea5b7f79e12480ef3bac9a1719ebe258a5f46ef`다. NAS 종료 시각은 2026-09-07T04:05:40.422Z이며 관측 가능한 전용 프로세스 0과 SSH 종료를 확인했다. 접근 불가 같은 UID 프로세스는 별도 미확정 범위로 보존하므로 시스템 전체 프로세스 부재를 뜻하지 않는다.

첫 신규 시험은 29개 통과·6개 실패·1개 취소였다. 고정 합성 compact provider가 허용하지 않는 시험 입력, 공통 오류 계층을 빠뜨린 검사, Node24에서 부모 IPC disconnect 뒤 `close` 대신 실제 `exit`를 관측해야 하는 시험을 바로잡았다. 원 로그와 진단은 보존했다. 첫 기존 회귀는 312/315였으며, 추가한 SQLite 점검이 상태 조회·복제 중 WAL/SHM을 만드는 실제 회귀를 고쳐 최종 로컬 관련 시험 315/315에서 해당 회귀를 포함해 통과했다.

첫 지원은 로컬 POSIX 파일시스템의 오프라인 관리다. 전체 memory DB 256MiB·worker 60초·후보 최대4개는 지원 상한이다. 오래된 모든 프로세스의 종료와 외부 효과 대조는 운영자가 확인한다. 원 DB에 없는 과거 본문은 복원하지 않는다. fence 뒤 취소, 역이관, 원격 공유 파일시스템, PostgreSQL 이관은 이 단위에 포함하지 않는다. 활성화 후 문서 오류가 발생하면 조용히 SQLite로 돌아가지 않는다.

[설계 및 수용 조건](C03-personal-memory-migration-plan.md) · [이어가기](../IMPLEMENTATION-RESUME.md) · [전체 계획](../03-migration-plan.md)

첫 신규/관련 실패와 진단 원로그를 보존했다. D2의 macOS 초기화 및 MCP 정체 원인 미확정 관측도 이번 통과로 해소됐다고 표시하지 않는다. 문서 조회 시 전체 초기 기록 재검사 비용은 C05의 미측정 항목이며, 백업 후보 4개를 소진한 경우 자동 삭제·무한 재시도하지 않는다.

[사용 가이드](C03-memory-migrate-usage.md) · [남은 인수 범위](C03-remaining-acceptance-review.md) · [다음 C04 계획](C04-general-turn-plan.md)
