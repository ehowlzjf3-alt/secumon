# C03 D3 — SQLite 백업 후보와 재개 경계

2026-09-07 · 설치된 타입·공식 소스의 읽기 전용 조사 · 구현과 실제 백업 시험은 미실행

[이관 계획](C03-personal-memory-migration-plan.md)과 [착수 전 검토](C03-personal-memory-migration-review.md)의 백업 경계를 구체화한다. **백업 전용 자식 프로세스에서 소유 확인 → 읽기 snapshot → SQLite backup → 대조·지문 계산을 수행**하고, 검증한 후보를 덮어쓰기 없이 게시하는 방향으로 정리했다. 기존 담당을 실행하는 서비스나 일반 파일 라이브러리를 새로 만들지 않는다.

이 문서에서 확인한 것은 API·현재 소스의 동작이다. snapshot과 backup의 결합, 제한값, 중단 복구의 실제 보장은 앞으로 합성 DB로 입증해야 한다. D1/D2의 기존 시험 결과를 D3 백업 검증으로 사용하지 않았다. 사용자 DB, 임시 DB, NAS에 접속하거나 DB를 열지 않았고 제품·시험·빌드 파일을 수정하지 않았다.

## 1. 확인한 Node24 계약

설치 경로는 `runtime/.tools/node-v24.20.0-darwin-arm64`다. 로컬 API 문서는 없어 공식 Node 저장소의 **v24.20.0 tag**를 확인했다. 설치된 `@types/node`는 **24.13.3**이므로 런타임의 정확한 patch와 같다고 보지 않는다. 필요한 `readOnly`, `timeout`, `backup`, `StatementSync.iterate`는 [설치 타입](../../runtime/node_modules/@types/node/sqlite.d.ts)에 있다.

| 확인한 사실 | 이번 설계에 적용할 조건 |
|---|---|
| `backup(sourceDb, path, {source, target, rate, progress})`는 `Promise<number>`를 반환한다. source는 열린 연결이고 기존 target 내용은 덮어쓴다. | `source/target` DB 이름은 `main`으로 고정한다. 정식 백업이나 재개 때 발견한 파일을 backup의 target으로 넘기지 않는다. |
| `rate`는 초당 속도가 아니라 한 번에 복사할 페이지 수다. fd·stream·AbortSignal·용량 제한 옵션은 없다. | JavaScript stream처럼 조각을 받아 쓰는 API로 해석하지 않는다. 후보 수명과 제한은 작은 호스트 helper가 관리한다. |

위 계약은 [Node v24.20.0 API 문서](https://github.com/nodejs/node/blob/v24.20.0/doc/api/sqlite.md#L1196)와 설치 타입을 대조했다. 전체 DB를 `serialize()`나 `readFile()`로 올려서 전달할 이유가 없다.

정확한 버전의 [BackupJob 구현](https://github.com/nodejs/node/blob/v24.20.0/src/node_sqlite.cc#L453)은 같은 source SQLite handle을 전달하고 native thread pool에서 페이지를 복사한다. 대상은 경로로 열며 배타 생성·no-follow 옵션을 노출하지 않는다. 마지막 batch에서는 progress를 생략할 수 있고, 동기 callback이 던진 오류는 정리 후 Promise 거절로 전달한다. callback 반환 Promise는 기다리지 않는다. 따라서 **progress만으로 완료·용량·취소를 판정하지 않는다.** [공식 회귀 시험](https://github.com/nodejs/node/blob/v24.20.0/test/parallel/test-sqlite-backup.mjs#L193)에도 한 batch일 때 callback 0회와 callback throw가 포함되어 있다. 이 upstream 시험을 여기서 실행한 것은 아니다.

## 2. source를 고정해서 읽고, fence는 새 transaction에서 결정한다

백업 전용 worker는 일반 `openAgentStores()`나 `bindAgentDatabase()`를 호출하지 않는다. 두 경로는 정상 초기화 과정에서 파일·owner·스키마를 만들 수 있다. 관리 작업은 원 DB가 없거나 미소유 상태면 먼저 거절해야 한다.

1. 호출한 담당 profile, 실제 memory 경로, 실행 중지 조건을 확인한다. [preflightKnowledgeStore](../../runtime/src/infrastructure/sqlite-knowledge-owner.ts#L56)와 [inspectAgentDatabaseOwner](../../runtime/src/infrastructure/agent-database-owner.ts#L56)의 기존 검사를 재사용한다. 첫 범위는 `mode:'agent'`이며 shared DB를 인수하지 않는다.
2. 새 전용 `DatabaseSync(source, {readOnly:true, timeout:5000})`를 열고 `BEGIN` 다음에 **main의 owner를 실제 조회**한다. [assertKnowledgeStoreOwner](../../runtime/src/infrastructure/sqlite-knowledge-owner.ts#L43)를 같은 handle에서 다시 실행하므로 앞선 검사 결과만 신뢰하지 않는다. 부모 참조와 source의 lstat 식별값도 열기 전후에 비교한다. `SELECT 1`만으로 main의 읽기 기준이 고정됐다고 보지 않는다.
3. 그 transaction에서 스키마·페이지 크기와 개수·원 record/receipt/head/index 지문을 읽는다. 모든 iterator를 마친 뒤 **transaction은 유지한 채 같은 handle로 backup**한다. 중간에 source를 갱신하거나 COMMIT하거나 다른 용도로 공유하지 않는다.
4. backup Promise가 성공 또는 실패로 끝난 다음 source transaction을 닫는다. 원 오류와 ROLLBACK/close의 추가 오류를 함께 보존한다. 타임아웃이 났다는 이유로 실행 중인 backup의 source handle을 먼저 닫지 않는다.
5. 검증된 백업이 준비된 뒤, 이관 조립자가 별도의 새 writer transaction에서 현재 owner·논리 지문을 다시 읽고 동일할 때만 source fence를 commit한다. 읽기 transaction을 쓰기로 승격하지 않는다. 변경됐으면 기존 manifest를 덮어쓰지 않고 새 preview로 돌아간다.

WAL의 읽기 transaction은 다른 연결이 나중에 commit해도 원 snapshot을 유지한다. `BEGIN` 뒤 실제 읽기로 이를 고정하고 종료 뒤 새 transaction에서 최신값을 보는 것은 [SQLite 격리 문서](https://www.sqlite.org/isolation.html)의 계약이다. **이 snapshot을 Node backup이 같은 기준으로 복사한다는 결합은 공식 구현에 근거한 설계 판단이며, 별도 writer를 둔 실제 회귀 시험이 필요하다.** 일반 online backup의 자동 재시작 동작만으로 preview 시점과 같다고 가정하지 않는다. [SQLite online backup](https://www.sqlite.org/backup.html).

main 파일만 복사하면 WAL에 남은 commit을 빠뜨릴 수 있다. 읽기 전용 연결도 WAL 조정용 sidecar가 필요할 수 있고, 오래 열린 reader는 WAL 정리를 지연할 수 있다. 원 sidecar를 지우거나 live DB에 `immutable`을 붙여 이를 우회하지 않는다. 오프라인 조건과 아래의 전체 시간 제한을 함께 둔다. [SQLite WAL 수명](https://www.sqlite.org/wal.html). hot journal 때문에 소유 확인이 불가능하면 현재 `agent_storage_recovery_required` 의미대로 원본을 보존하고 중단한다.

## 3. 첫 지원 상한과 메모리 사용

아래 값은 **첫 관리 작업의 보수적 지원 범위 제안**이다. 실제 NAS 처리량, 최적 메모리 사용량이나 최적 속도를 측정해서 얻은 값이 아니다. 일반 에이전트의 업무 예산과도 별개다.

| 제안값 | 적용 방법과 한계 |
|---|---|
| 백업 DB 최대 **256MiB** | snapshot의 `page_count × page_size`를 BigInt로 계산해 시작 전에 검사한다. progress의 totalPages와 완료 후 반환 page 수·실제 후보 크기도 대조한다. 개인 기억만 아니라 업무 기억·색인·빈 페이지를 포함하는 전체 memory DB 상한이다. 초과하면 명시 거절하며 VACUUM, 일부 row 제외, 자동 제한 확대를 하지 않는다. |
| `rate:256` | 4KiB 페이지이면 batch당 약 1MiB, 64KiB 페이지이면 약 16MiB의 논리 페이지 범위다. 페이지 크기를 4KiB로 고정하지 않는다. 이 숫자는 native 메모리·RSS나 초당 I/O 상한이 아니다. [SQLite 페이지 크기](https://www.sqlite.org/pragma.html#pragma_page_size). |
| 전체 worker deadline **60초** | 부모가 단조 시계로 측정한다. worker의 progress에서는 경과 시간·페이지 수만 동기 검사하고, callback이 안 오는 경우도 부모가 종료시킨다. 종료 요청만 보내고 끝내지 않고 실제 자식 종료를 회수한 다음 후보를 검사한다. 시간 초과는 성공이 아니며 느린 환경의 지원값은 후속 측정으로 결정한다. |
| 개별 seed·namespace·root 상한은 D1/D3 계약 재사용 | [documentLimits](../../runtime/src/infrastructure/document-knowledge-codec.ts#L10)의 256KiB 파일, 64MiB namespace, 경로 수와 pending 한도를 별도로 검사한다. DB가 256MiB 이하여도 seed 영수증 묶음이나 전체 경로 수가 초과하면 이관 불가다. |

256MiB는 완료 DB의 크기 상한이다. WAL·journal·후보 보존분까지 포함한 디스크 사용량이나 엄격한 RSS 상한으로 설명하지 않는다. preview에 원 main/sidecar 크기와 대상 여유 공간을 따로 표시하고 ENOSPC를 원 오류로 보존한다. 별도 OS quota를 구현하지 않은 첫 단위에서 물리 디스크 초과를 완전히 예방한다고 주장하지 않는다.

메모리에 전체 결과를 쌓지 않도록 관리 열거는 정렬된 키 순서의 `iterate()`와 누적 hash를 사용한다. row 경계·컬럼 이름·타입·길이를 hash 입력에 넣어 단순 문자열 연결의 모호성을 없앤다. 전체 `.all()`, 전체 JSON 배열, 전체 DB Buffer를 만들지 않는다. 개인 seed는 **본문을 가져오기 전 길이 검사**와 기존 seed 상한을 적용한다. 보존 대조만 필요한 큰 업무 컬럼은 SQLite의 BLOB 길이와 고정 크기 `substr` 조각으로 지문을 누적할 수 있다. 이 작은 전용 경로로 큰 단일 컬럼도 JavaScript에 통째로 반환하지 않도록 한다. SQLite 내부 cache·정렬 작업의 메모리까지 일정하다는 보장은 별도 측정 대상이다.

## 4. 후보 파일은 자신이 새로 만든 것만 쓴다

operation 아래 새 attempt용 private 디렉터리와 후보 이름을 만든다. 부모/디렉터리 참조·엔진 금지 경계는 기존 HostMetadataFiles/HostFileMutations로 검사한다. source·sidecar·문서 target과 동일하거나 이를 대체하는 경로, symlink, foreign owner는 거절한다.

후보는 `O_CREAT|O_EXCL|O_NOFOLLOW`, mode `0600`으로 **처음 만든 빈 파일**만 허용한다. descriptor는 SQLite가 대상에 접근하기 전에 fsync·close한다. 그때 기록한 파일 식별값을 backup 직전·직후 다시 비교한다. 디렉터리는 `0700`이고 다른 operation의 기존 파일을 덮어쓰거나 재사용하지 않는다. Node의 path 기반 open 내부에는 no-follow를 강제할 수 없으므로 이것을 openat 기반의 완전한 경합 방지로 과장하지 않는다. 같은 권한의 외부 프로세스가 경로를 바꾸는 한계와 사후 거절을 명시한다.

backup이 실행되는 동안 대상에 두 번째 SQLite 연결을 열거나 해시·fsync용 raw fd를 열고 닫지 않는다. progress에서 SQL을 실행하지도 않는다. SQLite는 backup 중 destination의 다른 API 접근을 제한한다. [SQLite backup 수명](https://www.sqlite.org/c3ref/backup_finish.html).

**기존 source SQLite 파일에는 raw fd를 열고 닫지 않는 규칙을 유지한다.** [현재 코드의 주의사항](../../runtime/src/infrastructure/agent-database-owner.ts#L77)은 같은 프로세스의 SQLite 잠금을 다른 fd의 close가 해제할 수 있기 때문이다. 원 파일의 타입·동일성은 lstat로, 내용과 snapshot 지문은 SQLite로 확인한다. 새 후보의 초기 fd는 연결 전에 닫고, 후보의 streaming hash/fsync는 후보의 모든 SQLite 연결이 닫힌 뒤 수행한다. [SQLite POSIX 잠금 주의](https://www.sqlite.org/howtocorrupt.html#posix_advisory_locks_canceled_by_a_separate_thread_doing_close).

## 5. 실제로 읽어 검증한 뒤, 덮어쓰기 없이 게시한다

1. backup 성공과 부모/파일 식별을 확인한다. 후보가 단일 DB로 다시 열리는지 확인하며, source WAL을 후보 옆에 복사해 맞추지 않는다. 후보에 journal mode 정리가 필요하면 **이 operation이 새로 소유한 후보에 한해서만** 별도 연결로 `journal_mode=DELETE`를 확인하고 정상 close한다. 이는 source 설정을 변경하는 절차가 아니다. 후보의 미반영 sidecar를 직접 지우지 않는다.
2. 후보를 읽기 전용으로 다시 열어 owner·지원 스키마·`integrity_check`와 원 snapshot의 논리 manifest를 전수 대조한다. 개인 정본/원 receipt/audit/head/index뿐 아니라 업무 row도 포함한다. source의 원 JSON bytes 지문과 seed의 표현 지문을 구분한다. mode 정리 등으로 바뀔 수 있는 물리 DB bytes를 원 main 파일과 같아야 한다고 요구하지 않는다.
3. 모든 후보 SQLite 연결을 닫은 뒤 크기를 재검사하고 streaming SHA-256·파일 fsync·후보 부모 fsync를 수행한다. 결과 manifest에는 operation, agentId, source 논리 지문, 검증한 스키마/row 개수, 실제 page 수와 크기, 백업 파일 hash, 사용 Node/SQLite 버전을 고정한다. 전체 원문을 manifest나 IPC 로그에 중복 저장하지 않는다.
4. 같은 파일시스템의 정식 백업 경로에 **no-overwrite link**로 게시한다. `rename()`으로 기존 정식 백업을 대체하지 않는다. link 뒤에는 부모 sync, 자기 후보 정리, 관련 부모 sync와 최종 동일성 검사를 수행한다. 임시 두 hardlink는 이 게시 수명 안에서만 허용한다. 정상 owner 검사의 `nlink===1` 규칙을 넓히지 않고, 재개 때 자기 후보를 식별해 정리한 뒤 정식 백업을 검사한다.
5. 검증된 정식 DB의 hash·논리 manifest에 묶인 작은 완료 영수증을 마지막에 게시한다. DB와 영수증 두 파일이 한 번에 원자 게시된다고 표현하지 않는다. **정식 파일 존재만으로 backup ready가 아니다.** 게시 직후 오류는 published/unknown으로 남기고, 같은 operation의 재관찰·sync·영수증 확인 뒤에만 다음 source fence 단계로 진행한다.

작은 intent/완료 JSON에는 기존 [HostFileMutationScope.publish](../../runtime/src/infrastructure/host-file-mutations.ts#L25)를 사용한다. DB 파일 게시에는 전용 helper가 필요한데, 이 메서드가 bytes만 받는다는 이유로 DB를 읽어 넘기지 않는다. 기존 공통 참조·directory sync와 [FileMutationFault의 publication/cleanup/errors/cause](../../runtime/src/infrastructure/host-file-mutations.ts#L5) 의미를 재사용한다. backup 복사 오류와 게시 오류를 구분하고, 정리 오류로 첫 오류를 덮지 않는다.

## 6. SIGKILL과 같은 operation 재개

| 마지막으로 확인한 경계 | 재개 행동 |
|---|---|
| backup 진행 중 종료, timeout, 복사 오류 | Node 내부 backup 포인터나 페이지 진행률을 복원하지 않는다. 부모가 자식 종료를 확인하고 불완전 후보를 보존한다. 같은 operation 아래 새 attempt 후보를 사용한다. snapshot이 preview와 달라졌으면 그 사실을 먼저 반환한다. |
| 복사 완료 뒤 검증/파일 sync 전에 종료 | 파일 존재·크기만으로 완료 판정하지 않는다. 저장된 intent와 원 manifest에 맞는 전수 검증을 다시 통과해야 한다. hot journal이나 식별 불명으로 읽을 수 없으면 정식 게시 없이 새 후보 경로로 재시도한다. |
| 정식 link 뒤 sync/후보 정리/완료 영수증 전에 종료 | 정식 파일을 덮어쓰지 않는다. 같은 operation, 고정 manifest, 후보/정식 파일 관계를 대조하고 미완료 barrier만 마친다. 다른 내용·소유자이거나 게시 여부를 해소할 수 없으면 복구 필요다. |
| 완료 영수증까지 존재 | 영수증에 연결된 파일·owner·hash·논리 지문과 필요한 barrier를 확인해 같은 백업을 재사용한다. 새 snapshot으로 그 백업을 덮어쓰지 않는다. |

고아 후보는 무조건 삭제하지 않는다. 재시도마다 남은 후보 개수·총 bytes를 preview에서 계산하고 관리 상한을 넘으면 명시 중단한다. 아직 검증하지 않은 후보 정리 자동화나 범용 archive 관리 기능을 추가하지 않는다. source fence 이후에는 이미 고정한 백업과 operation을 사용하고, 더 최신 source로 백업을 바꿔치기하지 않는다. 첫 D3는 fence 후 cancel을 제외하고 같은 operation resume만 지원한다.

`Promise.race()`로 timeout만 반환한 채 native backup을 뒤에서 계속 쓰게 두는 구현은 피한다. 제한 시간의 종료·실제 child exit·후보 불명 상태를 한 수명으로 관리한다. 실제 SIGKILL은 자식 프로세스 중단 시험이며 전원 장애 내구성이나 Windows native 검증이 아니다.

## 7. 구현 전에 입증할 최소 항목

- **읽기 기준:** WAL에만 있는 committed row를 포함하고, 고정 BEGIN 뒤 다른 연결의 commit이 발생해도 source manifest와 backup이 같은 원 snapshot인지 확인한다. 이후 새 fence transaction은 바뀐 source를 거절해야 한다.
- **상한·수명:** 한 batch에서 progress가 0회인 경우, 최대 page size, 256MiB 경계, callback throw, 진행 없는 대기와 60초 worker 종료를 검증한다. 오류 뒤 실제 프로세스·연결이 남지 않아야 한다. 큰 DB Buffer 미생성, 최대 RSS, 페이지 수·파일 크기·elapsed는 각각 기록한다.
- **소유와 실패 보존:** foreign/unowned/missing/hot-journal source, 기존 backup, 후보/부모 교체, link·fsync·정리 EIO에서 원본 bytes와 원 cause가 보존되는지 확인한다. 기존 SQLite 잠금이 raw fd close 때문에 풀리지 않는 회귀도 유지한다.
- **실제 중단:** 복사 중, 검증 후 파일 fsync 경계, 정식 link 후 영수증 전 실제 자식 SIGKILL을 주입한다. 같은 operation 재개가 하나의 검증된 백업으로 수렴하고 기존 정식 파일을 대체하지 않아야 한다.
- **전환 연결:** backup만 존재하거나 manifest가 다른 상태에서는 fence/activation으로 진행하지 않는다. 원 기억·영수증·업무 row 대조 실패를 성공으로 처리하지 않는다. 원문 메시지나 새 업무·모델·도구 호출은 생기지 않아야 한다.

이는 **작은 D3 전용 backup worker와 게시 helper의 구현 계획**이다. 256MiB 지원 상한과 60초/256페이지 기본값의 실환경 적합성, pinned read transaction과 Node backup의 결합, 후보 단일 DB 정리와 장애 후 복구는 아직 확인하지 않았다. 실제 DB 복원·Windows native·공유 파일시스템·전체 담당 복원 기능이 구현되었다는 뜻이 아니다.
