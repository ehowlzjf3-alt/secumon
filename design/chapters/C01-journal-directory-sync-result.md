# C01 저널 디렉터리와 동기화 연결

2026-09-07 · 저널 디렉터리·sync 연결의 POSIX 범위 구현·검증 완료 · C01 전체 미완료

파일 저널이 열어 둔 저장소의 전체 폴더(root), 업무별 폴더(work), 부모 폴더(parent)를 호스트 파일 경계의 참조로 관리하도록 연결했다. 참조에는 처음 검사한 실제 디렉터리의 식별 정보가 들어간다. 이후 경로가 다른 폴더로 바뀌면 새 폴더를 조용히 받아들이지 않고 거절한다. POSIX에서는 경로를 다시 검사하는 방식이며, 계속 열린 OS 핸들에 접근을 고정한 구현은 아니다.

## 구현한 연결

- 기존 숫자형 dev/ino 맵을 어댑터가 발급한 디렉터리 참조로 바꿨다. 기존 업무 해시 키와 관측한 폴더의 맵은 유지하며, 참조를 갱신할 때 이전 식별을 확인한다.
- 부모는 root를 만들기 전에 sync 용도 참조로 확보한다. 부모가 공개 읽기 가능한 폴더여도 기존처럼 허용한다. root와 work의 소유·private 권한 검사는 별도다.
- 저널의 디렉터리 동기화는 공통 `syncDirectory`에 연결했다. 생성자는 root → parent, 업무 조회·게시 확인은 work(있는 경우) → root → parent 순서를 유지한다.
- `beforeSync`는 실제 디렉터리 fsync 직전에 호출하는 호스트 알림이다. 저널은 여기서 기존 시도 카운터를 증가시킨다. 검사·열기 실패는 동기화 시도로 세지 않고, 실제 fsync 호출 실패는 시도로 센다. 알림 자체가 실패하면 fsync를 실행하지 않는다.
- 일반 파일의 fsync, 후보 파일 게시, 레코드 형식·해시·owner, 영수증과 동일 명령의 중복 방지, 캐시·재생은 기존 구현을 재사용했다.

## 폴더 경합 보강

| 상황 | 보강한 동작 |
| --- | --- |
| 관측했던 업무 폴더가 재생 직후 사라짐 | 새 폴더를 만들지 않고 unavailable로 거절 |
| 처음 만든 업무 폴더가 바로 사라짐 | nullable 결과나 후속 잘못된 경로 호출 대신 원 ENOENT를 보존한 unavailable |
| 목록에서 관측한 빈 업무 폴더가 읽는 도중 교체됨 | 빈 결과를 반환하기 전에 기존 참조를 재확인하여 changed로 거절 |
| 부모나 sync할 객체가 검사와 실행 사이에 교체됨 | 기존 참조와 열린 객체를 확인하고 해당 동기화를 거절 |

공통 검사에서 디렉터리 부재를 null로 받은 경우에는 원래 ENOENT 객체가 남아 있지 않다. 이 경우 code·syscall·path를 담은 합성 cause를 사용한다. 이미 받은 실제 ENOENT/EIO는 원 객체를 유지한다. 원래 errno와 stack까지 복원한 것으로 표현하지 않는다.

## 저장 실패의 의미

기록 게시와 동기화 성공은 별개다. 기록을 게시한 뒤 fsync나 디렉터리 재확인이 실패하면 기존 `journal_commit_unknown`을 유지하고 원 오류를 cause로 남긴다. 게시된 기록을 지워 되돌리거나 실패를 곧바로 미실행으로 바꾸지 않는다. 후속 조회와 같은 명령의 재시도로 이미 게시된 결과를 확인한다.

공통 동기화는 이전보다 부모·열린 객체·경로를 추가 검사한다. 기존 시도 카운터와 공통 I/O 진단을 구분하며, 이번 연결을 I/O 감소나 성능 향상으로 주장하지 않는다. 실제 전원 차단의 내구성은 별도 검증 대상이다.

## 검증 결과

첫 root/work 단위는 macOS Node 24에서 빌드와 관련 **151/151** 시험을 통과했다. 중간 소스 식별값은 `658bca43c0959d14434a1ebfa67591fa20dfb305680321ab1136d7890975c383`이고, [해당 단위 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-journal-directory-verification.json)에 저장했다. 이 결과를 이후 sync 수정본의 통과로 사용하지 않는다.

두 단위를 연결한 최종 소스는 NAS Debian 12 / Linux 6.12.30+ / x64 / ext4 / Node 24.20.0에서 2026-09-06T17:15:56.730Z에 검증을 마쳤다.

| 검증 | 최종 결과 |
| --- | --- |
| NAS 전체 회귀 | **2,638/2,638 통과**, 실패·취소·skip·todo 0 |
| NAS 관련 시험 | **166/166 통과** |
| macOS 관련 시험 | **166/166 통과** |
| 빌드·코어 타입 | 통과 |
| 계층 검사 | 125파일·위반 0, 실제 CLI fixture 4개 기대값 일치 |
| 합성 업무 fixture | 4시나리오·22판정 통과 |
| 최신 소스의 별도 macOS 전체 시험 | 미실행 |
| Windows native·실제 모델/API·사내 MCP/Knox | 미실행 |

새 시험은 root/work 참조·경합 8개, 공통 sync 관측 7개, 저널 sync 연결 8개로 총 23개다. 일부 경합 시점과 EIO는 격리된 시험 프로세스에서 주입했다. 실제 rename·mkdir·삭제와 fsync를 수행한 경우도 구분해 검증했으며, 주입한 EIO를 실제 디스크 장애로 표현하지 않는다. 기존 실제 프로세스 중단·재개 시험도 전체 회귀에 포함됐다.

최종 소스 식별값은 `07bc725fa221ab3f9b9932d90044a44174c08f117795c7e0427d5bb388e37899`, 빌드 식별값은 `269e60def932d32739e12f3ac1c241832bb80bf1c1e8018ca7444ac104b011a0`이며 산출물은 1,113파일이다. 원 로그 8개를 회수하여 로컬 소스·빌드 및 정적 자산 7개와 대조했다. [확정 검증 기록](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-journal-sync-verification.json) · [NAS 원 실행 결과](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-journal-sync-linux-nas-20260907/final/result.json).

sync build1의 시험 helper 타입 오류는 입력 확인 뒤 문자열을 보관하는 방식으로 수정했고 build2가 통과했다. 실패 로그도 보존했다. 중간 소스의 151개 결과와 최종 소스 결과를 분리했으며, 두 변경의 전체 검증은 합친 최종 소스로 한 번 실행했다. lint 명령은 저장소에 설정되어 있지 않다.

시험 프로세스 잔여 0, 전용 루트 0700, 기본 Node 18 유지와 SSH 종료를 확인했다. 전용 Node 24·시험 폴더·캐시는 보존했다. [정리 확인](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-journal-sync-linux-nas-20260907/cleanup.json). 실제 전원 차단 내구성이나 모든 Linux 파일시스템의 동작을 검증한 것은 아니다.

## 남은 연결

다음은 [파일 작업공간의 디렉터리·잠금·동기화 연결](/Users/seunghanee/Documents/secumon/design/chapters/C01-workspace-file-boundary-plan.md)이다. 파일 workspace/artifact의 남은 읽기·게시 경계, 프로필·저널의 생성·게시, Windows ACL·핸들·게시/flush 구현, 수동 복사 ID의 실행 소유권과 호스트 쓰기 경계도 남아 있다. 작업을 가로지르는 지속 세션과 이후 C02~C10도 전체 goal에 포함되어 있다.
