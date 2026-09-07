# C03 SQLite의 명시 복구 연결

2026-09-08 · checkpoint366. 기존 정상 시작의 읽기 전용 owner 검사와 SQLite/파일/PostgreSQL 선택을 유지하면서, 중단된 단일 SQLite rollback journal을 관리 명령으로 복구하는 경로를 추가했다. 실제 DB를 복구한 결과가 아니라 제품 연결 기록이다.

## 동작과 구현

`prepare`는 현재 담당과 선택된 로컬 DB를 확인하고 원 main/journal을 보존한다. 보존 영수증을 게시한 뒤 별도 후보를 복사해 SQLite의 정상 rollback을 수행한다. `apply`는 사용자가 지정한 준비 결과 지문과 같은 복구 ID를 받아 후보를 정본으로 게시한다. `status`는 과거 영수증을 읽으며 현재 DB가 과거 후보와 같다고 주장하지 않는다.

- [관리 흐름](../../runtime/src/infrastructure/agent-sqlite-recovery.ts): 담당·호스트 등록·원 디렉터리 객체·저장 선택을 고정한다. 기존 maintenance lease를 유지하고 `intent → original → prepared → pending → complete` 기록을 사용한다. 원문 복사/후보 시도가 중단되면 기존 파일을 보존하고 같은 operation의 다음 빈 시도 폴더를 사용한다. 원본·후보 각각 최대 4개다.
- [파일 처리](../../runtime/src/infrastructure/agent-sqlite-recovery-files.ts): 원 파일 identity/크기/SHA256을 대조하며 파일당 최대 1GiB, 1MiB 청크로 처리한다. 원 DB와 journal은 적용 시에도 별도 퇴역 이름으로 보존한다. POSIX의 두 이름/같은 inode 중단과 Windows의 기존 no-replace 게시를 재사용한다. 후보의 정본 게시가 이미 끝났으면 정확한 후보 지문으로 이어간다.
- [후보 검증](../../runtime/src/infrastructure/agent-sqlite-recovery-validation.ts): 기존 담당 owner 검사와 실제 저장 엔진의 스키마 조건을 이용한다. state/memory/channel의 필수 테이블·열, 지원 버전, 무결성과 문서 개인 기억 fence를 검사한다. 저장소 생성자를 호출해 스키마를 새로 만들거나 owner를 채우지 않는다.
- [전용 프로세스](../../runtime/src/infrastructure/agent-sqlite-recovery-process.ts): recover는 후보에만, verify는 후보 또는 게시된 정본의 읽기 전용 확인에 사용한다. 기본/상한 60초, 응답 64KiB 한도다. 요청 일치·검증된 응답·exit 0·close를 모두 확인한다. 중단 후 실제 종료를 관측하지 못하면 작업 기록과 maintenance lease를 남겨 후속 개설을 막는다.
- [진입 차단](../../runtime/src/infrastructure/agent-lifecycle-lease.ts): pending 동안 일반 runtime과 다른 관리 작업의 lease 취득을 막는다. 같은 operation/preparedDigest의 명시 apply만 이어갈 수 있다. 기존 `recover-leases`는 pending을 삭제하지 않는다.
- [관리 CLI](../../runtime/src/presentation/agent-lifecycle-cli.ts): `sqlite-recovery-prepare`, `sqlite-recovery-apply`, `sqlite-recovery-status`를 추가했다. 일반 `repair`의 설정 복구 의미는 유지한다. [사용법](../../runtime/examples/sqlite-recovery.md).

정상 완료 후에도 원 보존본과 퇴역 파일은 자동 삭제하지 않는다. rollback으로 미커밋 변경이 취소되므로 원 DB와 결과의 bytes가 달라질 수 있다. 업무·시도·자원·외부 도구 영수증을 새로 생성하지 않으며, 외부 효과 대조는 기존 실행기의 책임으로 남긴다.

## 지원 범위

활성 로컬 SQLite의 `state`, `memory`, `channel`을 선택한다. PostgreSQL로 선택한 용도와 file-journal state, 진행 중인 이관/복원은 거절한다. 원 main과 유효 rollback journal이 모두 필요하며 WAL/SHM 혼합, super-journal 의존성, 임의 손상 DB salvage는 이번 경로로 처리하지 않는다. 같은 호스트 등록과 명시 offline 조건은 유지한다.

SQLite는 읽기 전에 hot journal을 처리하며 여러 DB의 트랜잭션에는 super-journal이 관여할 수 있다. 따라서 후보를 열기 전에 원 파일의 rollback 헤더와 journal의 끝 표식을 확인한다. [SQLite 잠금·복구 설명](https://www.sqlite.org/lockingv3.html), [공식 파일 형식](https://www.sqlite.org/fileformat2.html#the_rollback_journal).

Windows는 기존 native 파일 어댑터의 process-crash / `directorySynced:false` 계약을 사용한다. 실제 Windows 동작·전원 장애 내구성·운영 데이터 복구가 검증됐다는 뜻은 아니다. 호스트의 offline 확인에는 구형 엔진과 직접 DB 클라이언트 중지도 포함된다.

## 검증 상태와 다음 작업

원로그·소스와 빌드 지문은 [checkpoint366](../../runtime/evidence/C03-sqlite-recovery-checkpoint.json)에 기록한다. 상세 동작/장애/플랫폼 시험, 실제 복구, 모델/API와 사내 연결은 실행하지 않았다.

아래 항목은 이후 검증 목록이며 아직 통과 결과가 아니다.

- [ ] V03-R01 실제 state/memory/channel rollback fixture의 원본 보존과 정상 owner/schema/무결성 확인.
- [ ] V03-R02 foreign/missing owner, 잘못된 선택·schema, 문서 기억 fence 불일치, WAL/SHM/super-journal 거절.
- [ ] V03-R03 준비 단계 중단과 원본·후보 최대 4개 시도, 원본 교체/내용 변경·동일 operation 다른 kind 충돌.
- [ ] V03-R04 main 퇴역 전후, journal 퇴역, 후보 게시, 완료 기록 전후 중단과 같은 ID 재개. POSIX link 2개와 Windows no-replace 상태를 각각 확인.
- [ ] V03-R05 pending에서 일반 runtime·다른 관리 작업 거절, 죽은 lease 회수 후에도 pending 유지.
- [ ] V03-R06 worker timeout/abort/잘못된 응답/중복 응답/late response/close 오류·종료 미관측에서 원 오류와 원본 유지.
- [ ] V03-R07 완료 후 정상 작업으로 변경된 DB와 과거 receipt를 구분하며 외부 도구 효과를 자동 성공/재실행으로 바꾸지 않음.
- [ ] V03-R08 기존 lifecycle·저장 선택·개인 기억·일반 CLI를 관련 회귀로 확인하고 Linux/native Windows 결과를 구분.

기존 미구현 목록의 C01 중복 ID와 C03 명시 SQLite 복구 연결까지 작성했다. 다음은 C01부터 순서대로 검증/수정하는 단계다. C01~C10 전체 요구의 완료 감사·운영 인수와는 구분한다.

최초 build1의 타입 연결 오류4개를 교정한 build2가 exit0이고, 같은 operation/kind 거절을 보완한 최종 build3(session24021)도 actual exit0이다. 상세 시험은 실행하지 않았다.
