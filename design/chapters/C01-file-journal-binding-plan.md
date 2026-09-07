# C01 다음 단위 — 파일 저널을 담당 ID에 연결

2026-09-07 · 구현 전 계획 · 현재 제품 소스 읽기 전용 검토

이 문서는 `storage.state = "file-journal"`로 선택된 담당이 기존 파일 저널 구현을 사용할 수 있도록 연결하는 다음 단위의 계획이다. 현재 검증 중인 clone 제품 소스는 수정하지 않았다. 이 문서 작성으로 파일 저널의 담당 연결, 새로운 시험, NAS 검증 또는 C01 전체 완료를 주장하지 않는다.

## 사용자가 보게 될 결과

기본 상태 저장소는 계속 SQLite다. 파일 저널을 명시적으로 선택한 담당은 `.secumon/state-journal/`에 작업 상태·이벤트·전송 대기 기록·명령 처리 영수증을 저장한다. 개인 장기기억은 `memory/memory.sqlite`, 채널 메시지는 `.secumon/channel.sqlite`를 유지한다. 파일 저널 선택이 기억 저장 방식이나 대화 문맥의 의미를 함께 바꾸지는 않는다.

다른 담당의 저널 폴더나 DB를 복사해 연결하면 소유 담당 ID가 달라 열리지 않는다. 소유 정보가 없는 과거 저널도 새 담당이 자동 인수하지 않는다. 이미 사용하던 상태 저장 방식이 있는데 설정만 바꾸면 새 빈 저장소를 만들지 않고 이행이 필요하다고 알린다.

## 현재 코드에서 확인한 재사용 기반

| 관심사 | 확인한 구현 | 이번 단위에서의 사용 |
|---|---|---|
| 공통 상태 계약 | `StateRepository`의 get/commit/receipt/events/deliveries/조회/close | 계약과 추론 코어를 바꾸지 않고 저장 구현만 선택 |
| 저널 식별 | `format.json`의 kind/schemaVersion/storeId | 저장소 ID에 담당 소유 정보를 추가 |
| 레코드 식별 | 각 레코드의 storeId, previousHash, checksum, revision, commandId | 그대로 유지; 다른 저널 레코드를 섞으면 기존 검증에서 거절 |
| 원자 게시 | private candidate 작성 → 파일 sync → 덮어쓰기 없는 link → 디렉터리 sync | 헤더의 소유 정보도 같은 한 번의 게시에 포함 |
| 동시 기록 | revision 게시의 한 승자, duplicate/idempotency_conflict/conflict 구분 | 담당 연결 때문에 별도 작업 기록 알고리즘을 만들지 않음 |
| 중단 후 복구 | candidate/published/directory_synced 구분, journal_commit_unknown, 재조회와 같은 명령 재시도 | 소유 헤더가 추가되어도 기존 영수증·복구 의미 유지 |
| 파일 경계 | private 디렉터리·파일, UID, no-follow, 루트/작업 디렉터리 inode 확인, 읽기 전후 파일 안정성 확인 | 헤더 소유 검사와 결합; Windows 보장으로 확대 해석하지 않음 |
| 저장 방식 선택 고정 | 합성 로컬 프로필의 `resolveStateBackend` | 선택 고정·동시 선점·혼재 거절이라는 동작을 담당 경로에 맞게 재사용 |
| SQLite 담당 소유 | `agent_storage_owner`의 agent_id/kind/schema_version | 상태 SQLite 경로와 기억·채널 DB에 계속 적용 |

근거 코드: [파일 저널](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-journal-state.ts), [담당 저장소 조합](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/agent-stores.ts), [기존 저장 방식 고정](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/local-state-profile.ts), [경로 처리](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/local-file-paths.ts).

현재 파일 저널의 `storeId`는 “같은 저널의 기록인가”를 검사한다. 어느 담당의 저널인지는 표현하지 않는다. 따라서 정상 저널 폴더를 다른 담당 아래에 통째로 복사하면 저널 자체의 해시 연결만으로는 다른 담당임을 알 수 없다. 이 간극만 소유 바인딩으로 메운다.

## 선택할 소유 표현

담당용 저널은 `format.json`에 owner를 함께 저장하는 새 헤더 형식을 사용한다. 아래는 구현 시 확정할 최소 계약이다.

```json
{
  "kind": "long-horizon-file-journal",
  "schemaVersion": 2,
  "storeId": "저널 고유 UUID",
  "owner": { "agentId": "담당 고유 UUID", "kind": "state" }
}
```

- `storeId`는 저장소의 정체성, `agentId`는 담당의 정체성, `kind`는 저장 용도다. 경로 문자열을 소유자 ID로 쓰지 않으므로 담당 디렉터리를 이동해도 같은 소유로 연다.
- `JournalOptions`에 호스트가 전달하는 expected owner를 추가한다. 값은 `profiles.inspect()`로 확인한 담당 ID에서 가져오며 도구 입력이나 모델 응답으로 교체하지 않는다.
- owner 없이 사용하는 기존 합성/독립 저널은 현재 v1 헤더를 유지한다. 기존 시험을 무조건 v2로 바꾸어 호환 회귀를 숨기지 않는다.
- 담당 연결로 v1 저널을 열면 `owner_missing`에 해당하는 오류를 반환한다. 비어 있는 v1 format.json이라도 조용히 소유 정보를 덧붙이지 않는다. 기존 저널 인수는 이후 명시적인 이행 절차다.
- v2 헤더를 expected owner 없이 열거나, agentId/용도가 다른 owner로 열면 거절한다. 이전 엔진도 v2를 알 수 없으므로 v1처럼 열어 쓰지 못해야 한다.
- 저널 생성 시 소유 정보를 **헤더와 동시에** 게시한다. 헤더 생성 뒤 owner 파일을 추가하는 두 단계는 사용하지 않는다.
- 기존 레코드 schemaVersion은 헤더 버전과 별개다. v1 레코드의 storeId와 해시 연결을 재사용하며 기록 포맷 전체를 다시 만들 필요가 없다.
- `#check()`는 현재 헤더의 storeId뿐 아니라 형식과 expected owner도 다시 확인한다. 담당이 연결된 뒤 헤더 소유 정보가 바뀌어도 계속 읽거나 기록하지 않는다.

저널 안에 별도 `owner.json`을 추가하는 방식은 피한다. 현재 `#directories()`는 format.json·정상 pending·작업 해시 디렉터리만 허용하므로 별도 파일이 조회 동작을 깨뜨린다. 또한 owner와 format 두 파일의 생성 순서·부분 복구를 추가로 설계해야 한다. 단일 헤더의 새 버전이 더 작은 변경이다.

## 저장 방식이 조용히 갈라지지 않게 하는 연결

현재 담당 config는 편집할 수 있다. 단순히 `if file-journal then new FileJournalStateRepository(...)`만 추가하면 SQLite 사용 후 config 변경으로 빈 저널이 생길 수 있다. 첫 상태 저장 방식은 담당 메타데이터에 고정하고, 이후 설정과 다르면 이행 오류를 낸다.

최소안은 `.secumon/state-profile.json`에 `agentId`, `stateBackend`, 형식 버전을 한 번 게시하는 것이다. 이 표식은 “상태를 어떤 방식으로 저장하도록 배정했는가”이며 저장소 초기화 완료 증명은 아니다. 기존 `resolveStateBackend`의 동시 선점·재읽기·불일치 거절을 재사용하되, 현재 합성 경로 `state.sqlite`/`profile.json`을 담당 경로에 그대로 적용하지 않는다.

연결 순서는 다음과 같다.

1. 담당 profile이 ready인지 확인하고, state backend 요청을 해당 config에서 읽는다.
2. 기존 상태 표식과 `.secumon/runtime.sqlite` 및 sidecar, `.secumon/state-journal`의 존재를 확인한다. 둘 다 존재하거나 선택과 반대쪽 데이터가 있으면 새 저장소를 만들지 않는다.
3. 표식이 없는 기존 담당은 선택된 기존 저장소의 소유 정보를 **쓰기 없이 먼저 확인**한다. 현재 이미 연결된 SQLite의 owner가 담당 ID/용도와 일치하면 표식을 추가할 수 있다. 미소유 DB/저널·손상된 헤더·외국 담당 ID는 먼저 거절한다. 기존 SQLite에 새 표식을 붙이는 것은 DB 정체성 재발급이나 기록 이행이 아니다.
4. 완전 신규이거나 기존 소유 검증을 통과한 경우, 선택 표식을 덮어쓰기 없이 게시하고 실제 승자의 내용을 다시 읽는다. 다른 backend/담당이 선점했으면 자료를 보존하고 거절한다. 같은 담당·같은 backend의 초기화는 합류할 수 있다.
5. 선택된 상태 저장소를 연다. SQLite는 기존 owner 테이블 검사, 파일 저널은 expected owner가 포함된 생성/읽기 검사를 사용한다.
6. 기억·채널 SQLite를 기존 owner 검사로 연결하고, workspace/artifact 저장소를 재사용한다. 실패하면 열린 핸들을 모두 닫으며 이미 게시한 유효한 저장소/표식을 삭제해 되돌리지 않는다.

표식만 있고 저장소가 없는 중단은 같은 선택으로 다시 생성한다. 표식과 저장소 소유가 다르면 자동 수정하지 않는다. SQLite에서 파일 저널로의 실제 데이터 이동이나 반대 방향의 이행은 C03/C10 범위로 남긴다.

이 단위는 이미 선택된 config를 저장 어댑터에 연결하는 작업이다. 현재 일반 init CLI에는 state backend 선택 옵션이 없으므로, 최초 setup UI/설정 입력 확장은 별도 연결 사항으로 기록한다. 기존 DB가 생성된 뒤 config 편집만으로 변경할 수 있다고 안내하지 않는다.

## 중단과 동시 초기화에서 지킬 경계

| 발견한 상태 | 처리 |
|---|---|
| 저널 디렉터리 없음 / 비어 있는 신규 디렉터리 | expected owner가 포함된 새 헤더 게시 |
| 소유 헤더가 정상적으로 게시됨 | 같은 agentId·용도로 재열기; storeId 유지 |
| 헤더 후보 파일만 남고 게시된 헤더/작업 기록은 없음 | 안전한 초기화 후보인지 확인하고 같은 담당 초기화로 진행; 후보를 작업 기록으로 채택하지 않음 |
| format.json 없이 작업 기록 또는 알 수 없는 파일이 있음 | format/owner missing으로 거절; 새 storeId를 발급해 기존 기록을 가리지 않음 |
| v1 format.json 또는 다른 담당의 v2 format.json | 각각 미소유/소유 불일치로 거절; 원본 bytes 보존 |
| 두 프로세스가 같은 담당/저널을 처음 생성 | 헤더 원자 게시 승자의 storeId/owner를 모두 확인하고 합류 |
| 다른 owner가 같은 신규 저널을 선점하려 함 | 먼저 게시된 owner만 연결; 패자의 소유로 변경하지 않음 |
| 헤더 게시 후 디렉터리 sync 전에 프로세스 종료 | 재열기에서 게시 여부와 owner를 확인하고 동기화; 성공 응답 없이 완료되었다고 단정하지 않음 |
| 기록 게시 이후 응답 이전에 종료 | 기존 journal_commit_unknown/receipt 재조회 및 동일 명령 재시도 계약 유지 |

헤더를 읽을 때 일반 파일 여부·사이즈·권한·UID·읽기 안정성 검사에 소유 검증을 더한다. 외부 하드 링크는 거절하되, 게시 직후 중단으로 `format.json`과 같은 inode를 가리키는 정상 candidate가 남은 경우까지 일괄 거절하지 않는다. 기존 저널 후보 이름은 `UUID.pending`, 담당 setup 후보는 `.secumon-init-UUID.pending`이므로 파일 도우미를 공유한다면 허용 규칙을 명시적으로 구분해야 한다. 이름만 맞는 임의 파일을 소유 증거로 인정하지 않는다.

## 최소 구현 순서

1. **저널 헤더/옵션:** v1 독립 저널과 v2 담당 저널의 계약, expected owner 검사, 단일 헤더 게시/재읽기를 추가한다. root/work 경로, 기록 스키마, 캐시, 작업 조회 알고리즘은 유지한다.
2. **담당 상태 선택 표식:** 기존 로컬 프로필의 고정 의미를 담당 경로에 연결한다. 현재 SQLite 담당의 소유를 확인한 뒤 표식을 추가하는 호환 경로와, 미소유/혼재 거절을 먼저 시험한다.
3. **저장소 조합:** `openAgentStores`의 state 변수/반환 경계를 `StateRepository`로 일반화하고 config에 따라 두 구현을 선택한다. 기억·채널의 SQLite owner 바인딩과 자원 닫기는 유지한다. 도메인/플래너/실행 루프는 수정하지 않는다.
4. **담당·CLI 회귀:** 신규 파일 저널 담당 열기, 재열기, clone의 빈 파일 저널 생성, 오류 출력과 backend 고정을 검증한다. 기존 미연결 오류를 기대하던 시험은 실제 연결/불일치 시험으로 교체하며 단순 삭제하지 않는다.
5. **필수 검증·기록:** 아래 대상 시험과 저장소 회귀를 통과시킨 뒤 저장 계약 변경에 맞는 필수 전체 검증을 한 번 수행한다. Linux 실제 결과와 macOS 개발 결과를 소스 digest로 구분하고 Windows 미검증을 별도 표시한다.

예상 수정 경계는 `file-journal-state.ts`, `agent-stores.ts`, 담당 상태 표식 도우미 및 관련 시험이다. 기존 `local-state-profile.ts`의 동작을 바꿀 필요가 없으면 그대로 유지한다. 공통 코드 추출을 이유로 다른 프로필과 추론 코어를 넓게 재작성하지 않는다.

## 필요한 검증

| 사례 | 통과 기준 |
|---|---|
| 같은 ID/키를 쓰는 담당 A·B | 작업·이벤트·영수증·대화 조회가 각 저널에 분리되고 재열기 뒤에도 유지 |
| 기억/채널 유지 | state는 저널이지만 memory/channel DB는 기존 경로의 SQLite이며 owner가 해당 담당과 일치 |
| A 저널 폴더 전체를 B에 복사 | B를 열 때 owner mismatch로 거절; 복사본/원본 bytes 보존, 새 메모리·채널을 성공 연결했다고 표시하지 않음 |
| 다른 저널의 레코드만 끼워 넣기 | 기존 storeId/hash/revision 검증으로 읽기/재기록 거절; 최초 owner 검사만 통과했다고 데이터 무결성까지 통과로 보지 않음 |
| A의 memory/channel/state SQLite를 B에 복사 | 기존 소유 불일치 거절 유지; file-journal 연결이 SQLite 검사를 우회하지 않음 |
| 기존 v1 저널·미소유 DB | 빈 format만 있는 경우와 실제 기록이 있는 경우 모두 자동 인수하지 않음 |
| 헤더 누락/손상/다른 버전/owner 변경 | 자료 보존과 명확한 오류, 새 storeId 또는 빈 대체 저장소를 만들지 않음 |
| 같은 담당의 여러 프로세스 최초 열기 | 하나의 backend 선택·storeId·owner, 모두 같은 저장소 사용 |
| 서로 다른 backend/owner 선점 경쟁 | 한 선택만 배정되고 나머지는 불일치 오류; SQLite와 파일 저널 둘 다 생성되지 않음 |
| 후보/헤더 게시 경계에서 실제 프로세스 종료 | 안전한 동일 담당 재개, 미게시 후보를 완료로 오인하지 않음, 기록이 있는 미소유 폴더 재발급 금지 |
| 헤더/루트 symlink·외부 hardlink·권한/UID 문제 | 범위를 벗어난 파일 읽기/쓰기를 거절; 정상 중단 candidate 하드 링크는 구분 |
| 사용 중 루트/헤더 교체 | 기존 inode/storeId 검사와 새 owner 검사로 이후 접근 차단 |
| 기존 SQLite 담당 열기와 backend config 변경 | 기존 사용은 유지; 설정 변경만으로 새 빈 저널/SQLite를 생성하지 않음 |
| 파일 저널 config를 가진 담당 clone | 설정과 스킬만 복사, 새 agentId/storeId의 빈 저널·빈 SQLite 기억/채널, 원본 상태 불변 |
| 초기화 일부만 성공하고 후속 저장소 연결 실패 | 열린 핸들 해제, 이미 생성된 유효 데이터 보존, 재시도 시 같은 owner/backend로 연결 |

기존 재사용 시험은 [상태 저장소 공통 계약](/Users/seunghanee/Documents/secumon/runtime/src/tests/state-conformance.test.ts), [저널 결함/중단](/Users/seunghanee/Documents/secumon/runtime/src/tests/journal-fault.test.ts), [상태 선택 프로필](/Users/seunghanee/Documents/secumon/runtime/src/tests/state-profile.test.ts), [담당 저장소](/Users/seunghanee/Documents/secumon/runtime/src/tests/agent-stores.test.ts), [상태 조회](/Users/seunghanee/Documents/secumon/runtime/src/tests/state-query.test.ts)를 우선한다. 실제 시험을 실행한 뒤에만 결과를 기입한다.

## 이 단위의 보장 범위

이 변경은 담당과 저장소를 잘못 연결하는 사고를 막고 기존 저널을 선택 가능하게 만드는 것이다. 동일 OS 사용자에게 임의 셸/엔진 수정 권한까지 허용한 상황을 강한 보안 격리로 바꾸지 않는다. 전체 담당 디렉터리를 수동 복사해 동일 agentId를 두 곳에서 운영하는 문제는 호스트 등록/실행 소유권 경계에 남는다.

파일 저널이 SQLite보다 일반적으로 빠르다는 가정으로 기본값을 변경하지 않는다. 현재 저널은 따뜻한 캐시 상태에서도 과거 레코드 bytes를 읽고 해시를 확인한다. 이는 기존 무결성 계약이며 이 단위에서 성능 최적화를 위해 생략하지 않는다.

Linux/NAS 검증은 실제 해당 파일 시스템·프로세스 조건에서 수행한 결과로만 기록한다. 현재 POSIX 권한·no-follow·디렉터리 sync를 네이티브 Windows 보장으로 대체하지 않는다. Windows 파일 어댑터, 저장 이행/백업, 지속 세션, 실제 모델 품질은 각각 남은 계획으로 유지한다.

## 구현 중 확인한 SQLite 경계 — 2026-09-07

읽기 전용 소유 확인은 SQLite 스키마/소유 행을 변경하지 않는다는 뜻이다. WAL 모드의 읽기 전용 연결도 잠금 조정용 `-wal`/`-shm`을 만들 수 있으므로, 위 계획의 “쓰기 없이”를 모든 파일 bytes/디렉터리 무변경으로 일반화하지 않는다. 정본과 소유 정보를 인수하거나 이행하지 않는 것과 SQLite 조정 파일의 동작을 구분한다. [SQLite WAL 읽기 전용 조건](https://www.sqlite.org/wal.html#read_only_databases).

기존 DB의 소유 확인에 SQLite 바깥의 raw descriptor를 추가로 열고 닫지 않는다. POSIX에서는 그 close가 같은 프로세스의 다른 SQLite 연결이 가진 잠금을 해제할 수 있다. SQLite 연결과 경로 메타데이터 검사로 확인하며, 같은 OS 사용자가 임의 경로를 교체하는 공격까지 방어하는 것으로 확대하지 않는다. [SQLite 잠금 주의사항](https://www.sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_).

hot rollback journal처럼 DB를 먼저 복구해야만 소유 정보를 읽을 수 있는 경우는 `agent_storage_recovery_required`로 보존하고 중단한다. 저장 방식 표식만 믿고 출처 불명 DB를 writable로 열어 복구하지 않는다. 소유 확인 가능한 정상 저장소, 배정 후 빈 DB 생성 중단, 파일 저널 원자 게시 중단의 재개와 이 경계를 구분하며, 정식 복원/이행 절차는 C03/C10의 남은 연결 사항으로 기록한다.

동시 초기화에서 읽기 전용 owner 조회는 한 read transaction으로 묶는다. owner 없음과 일반 스키마 존재를 서로 다른 시점으로 읽어 정상 초기화를 잘못 거절하는 일을 피한다. 실제 재현된 WAL 모드 전환 잠금 오류는 owner 검증·commit 이후 제한된 BUSY 재시도로 처리한다. 업무 명령이나 모델 실행을 재시도하는 정책으로 확대하지 않는다.
