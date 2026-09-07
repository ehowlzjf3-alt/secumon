# C01 파일 저널의 담당 연결과 저장 방식 고정

2026-09-07 · 해당 POSIX 구현 범위 및 NAS Linux 전체 검증 완료 · C01 전체 진행 중

## 이 단위의 결과

기존 파일 저널을 담당 디렉터리의 상태 저장소로 연결했다. 기본값은 SQLite다. 최초 상태 저장소를 열기 전에 `config.json`의 `storage.state`가 `file-journal`로 선택되어 있으면 `.secumon/state-journal/`을 사용한다. 한 번 선택한 방식은 `.secumon/state-profile.json`에 담당 ID와 함께 고정한다. 사용 후 설정만 바꾸면 빈 저장소를 만들지 않고 `agent_state_backend_mismatch`로 거절한다.

현재 일반 CLI `init`은 기본 SQLite 저장소를 바로 준비한다. 따라서 이 문서는 `init`을 실행한 뒤 config만 편집해 다른 저장 방식으로 전환하라는 안내가 아니다. 이 단위는 profile 초기화 API와 저장소 조합 사이의 선택 연결이며, 최초 CLI/setup 선택 입력은 C06, 기존 자료의 실제 이행은 C03/C10에 남아 있다.

| 구분 | 저장 위치/방식 | 이번 변경 |
| --- | --- | --- |
| 목표·작업 상태·이벤트·처리 영수증·전송 대기 | 기본 `.secumon/runtime.sqlite`, 선택 `.secumon/state-journal/` | 같은 `StateRepository` 계약으로 연결 |
| 개인 장기기억 | `memory/memory.sqlite` | SQLite 유지, 담당 소유 확인 |
| 채널의 저장 메시지 | `.secumon/channel.sqlite` | SQLite 유지, 담당 소유 확인 |
| 스킬·설정·작업 파일·산출물 | 기존 담당별 디렉터리 | 기존 구현 재사용 |

이 표의 채널 저장 메시지는 전체 사용자 입력 이력이나 작업을 가로지르는 지속 세션의 구현 완료를 뜻하지 않는다. 지속 세션과 compact 연결은 C02의 별도 작업이다.

## 담당이 섞이지 않는 방식

파일 저널 헤더 `format.json`의 v2 형식에 `storeId`와 `owner`를 함께 게시한다. `storeId`는 같은 저널의 기록인지를 확인하는 ID, `owner.agentId`는 담당의 ID다. 담당 디렉터리를 이동하면 ID를 유지하고, `clone`으로 복제하면 새 담당 ID와 빈 저장소를 만든다. 파일 경로 문자열을 소유자 ID로 사용하지 않는다.

헤더를 먼저 만들고 나중에 별도 소유 파일을 붙이지 않는다. 원자 게시 한 번에 형식과 소유자를 포함한다. 이후 접근에서도 헤더 형식·소유자·저널 ID를 다시 확인하므로 캐시에 자료가 있어도 owner 변경을 건너뛰지 않는다. 외부에서 전달된 owner 객체는 복사·동결하여 나중의 변수 수정이 권한을 바꾸지 않게 했다.

독립적으로 쓰던 v1 저널과 v1 작업 레코드는 계속 지원한다. 담당용으로 v1 저널을 열거나 다른 담당의 v2 저널을 복사해 연결하면 원본을 보존하고 거절한다. 기존 owner가 있는 SQLite 담당은 소유를 확인하고 상태 선택 표식만 추가할 수 있다. 이미 기록이 있거나 출처를 알 수 없는 빈 SQLite 파일을 새 담당이 자동 인수하지 않는다.

## 중단과 동시 실행

`state-profile.json`은 저장 방식 배정이며 초기화 완료 증명이 아니다. 표식 게시 후 프로세스가 중단되어 DB가 아직 없거나 빈 파일만 있어도 같은 담당·같은 방식으로 다시 준비한다. 두 초기화가 경쟁하면 하나의 표식과 소유 헤더로 합류하며, 다른 방식이나 소유자로 변경하지 않는다. 게시 직후 같은 inode의 정상 임시 링크가 남은 경우와 외부 하드 링크도 구분한다.

관련 시험에서 실제 SQLite WAL 모드 전환의 잠금 경쟁을 발견했다. 소유를 확인·commit한 초기화 단계에서 BUSY에만 제한적으로 재시도하여 전환을 마친 뒤 기존 저장 어댑터를 연다. 작업 명령이나 모델 호출을 임의로 재실행하는 변경은 아니다.

SQLite 소유 확인은 한 읽기 트랜잭션을 사용한다. 기존 DB를 SQLite 외부 raw descriptor로 별도 열고 닫지 않도록 하여, 같은 프로세스의 다른 연결이 가진 잠금이 풀리는 문제를 피했다. 외부 프로세스의 실제 쓰기 시도로 잠금 유지도 확인했다. [SQLite의 POSIX 잠금 설명](https://www.sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_).

## 복원 보장의 한계

읽기 전용 소유 확인은 정본의 스키마·소유 행을 변경하지 않는다는 의미다. SQLite는 이 과정에서 WAL 잠금 조정 파일을 만들 수 있다. 모든 파일과 디렉터리에 쓰기가 전혀 없다는 의미로 확대하지 않는다. [SQLite WAL 읽기 전용 조건](https://www.sqlite.org/wal.html#read_only_databases).

프로세스 중단 뒤 hot rollback journal 복구를 먼저 해야 소유를 조회할 수 있다면 `agent_storage_recovery_required`로 중단한다. 표식만 보고 출처 불명 DB를 writable로 열어 복구하지 않는다. 실제 강제 종료로 이 상태를 만들고, 올바른 담당과 다른 담당 모두에서 DB·저널 원본 bytes를 보존하는 거절을 확인했다. 자동 복원 절차는 C03/C10의 남은 구현이다.

같은 OS 사용자에게 임의 셸이나 엔진 수정 권한까지 주었을 때의 완전한 격리, 수동 폴더 복사로 중복된 ID의 실행 탐지, Windows ACL/핸들 경계, 네트워크 파일 시스템이나 전원 장애 내구성을 이번 결과로 주장하지 않는다.

## 검증 진행 기록

- macOS Node 24.20.0: 최종 build4 성공, 관련 시험 **192/192**, 실패·취소·skip·todo 0.
- 신규 시험 57개. 실제 강제 종료 12사례 중 자동 재개 10, 보존 후 거절 2를 확인하는 구성을 추가했다.
- 최초 build1은 타입 오류로 실패했다. build2 뒤 관련 시험1은 137/139로 두 실패가 있었다. 복사 fixture 권한과 재현된 WAL 전환 경쟁을 수정했다. build3은 시험 worker의 타입 오류로 실패했고 수정 후 build4를 통과했다. 과거 로그를 보존한다.
- 최종 소스 `80a2d62de7204e09a82e53dbf24a3e9e02cab00899f68dd59ade42fd9e848b80`, build `6acbc8d1a3c801fe85ea36e2ffd11789c92b529fab1b3cb25fd5d66cef0ea10b`, 1065파일을 고정했다.
- NAS Debian 12 / Linux 6.12.30+ / x64 / ext4 / Node24.20.0: 전체 **2,580/2,580**, 관련 **192/192**, 실패·취소·skip·todo 0. 빌드·코어 타입·계층 125파일/위반0·계층 CLI 4사례·합성 4시나리오/22판정 통과. 종료 2026-09-06T16:06:40.078Z. 파일 병렬2/nice10. lint 미설정.
- 회수한 원 로그 8개와 source/build, 정적 자산7개를 대조했다. [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-journal-binding-verification.json). macOS 전체 및 네이티브 Windows 시험은 이 수정본에서 실행하지 않았다.
- 시험 소유 프로세스 잔여0과 기존 Node18·시험 루트0700을 확인하고 SSH 연결을 닫았다. 전용 Node24/자료/캐시는 보존했다. NAS의 ext4 nobarrier 조건 때문에 프로세스 중단 복구를 전원 장애 검증으로 해석하지 않는다.

## 다음 연결

다음은 [공통 파일 경계의 첫 추출](/Users/seunghanee/Documents/secumon/design/chapters/C01-file-boundary-extraction-plan.md)이며 이어서 실제 Windows OS 어댑터를 연결한다. 최초 setup 선택, 소유 확인이 선행되어야 하는 복원/이행, 지속 세션은 각 챕터의 순서로 이어간다. C01 전체와 C01–C10 goal은 진행 중이다.

관련 코드: [저널 소유](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/journal-ownership.ts), [상태 방식 고정](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/agent-state-profile.ts), [SQLite 소유](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/agent-database-owner.ts), [담당 저장소 조합](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/agent-stores.ts).
