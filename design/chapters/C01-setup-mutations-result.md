# C01 최초 설정의 생성·게시·중단 재개

2026-09-07 · POSIX 설정 단위 구현·macOS 관련·NAS 전체 검증 완료 · C01 전체는 진행 중

담당 설정의 파일 생성부터 중단 후 재개까지 같은 범위에서 처리하도록 연결한다. 기존 담당 ID, 설정 형식, setup-operation 기록, 복제 manifest와 저장 어댑터를 재사용한다. 새 범용 트랜잭션 저장소는 만들지 않는다.

## 연결한 수명

`HostFileMutationScope`는 한 번의 설정 호출이 변경할 root와 부모 디렉터리 참조를 보관한다. scope는 변경 가능한 범위를 뜻한다. 본체 설치 영역과 겹치는 경로, 바뀐 부모·하위 디렉터리, 다른 scope에서 발급한 참조를 거절한다. POSIX 구현은 매번 경로와 실제 파일 객체를 재확인하며, 열린 디렉터리 핸들에 상대적인 원자 연산을 제공하는 것은 아니다.

- 디렉터리는 처음부터 private 권한으로 만들고 기존 권한을 자동 변경하지 않는다. 새 root의 부모도 동기화한다. 기존 디렉터리와 합류하는 create 요청 역시 부모를 동기화해 이전 중단의 미확정 저장을 복구한다.
- 파일은 같은 부모에 exclusive 후보를 만들고 bytes 쓰기 → 파일 fsync → 기존 파일을 덮어쓰지 않는 link 게시 → 자기 후보만 정리 → 부모 fsync → 내용/객체 재확인 순서로 저장한다.
- 정리와 부모 동기화를 독립적으로 시도한다. 부모나 후보가 바뀌어 소유를 확인할 수 없으면 바뀐 경로에서 다른 파일을 삭제하지 않는다.
- 게시 여부, 파일/디렉터리 동기화, 후보 정리 상태와 단계별 원오류를 `FileMutationFault`에 보존한다. 게시 후 실패는 `agent_metadata_publish_unknown`, 디렉터리 생성 후 실패는 `agent_directory_create_unknown`으로 전달한다. 단일 미게시 I/O 실패의 원인도 유지한다.
- `initialize`와 `clone`은 scope를 명시적으로 전달하고 마지막 검사 뒤 해제한다. 기존 operation/identity/config/setup을 안정적으로 읽으며, 다음 실행은 게시된 같은 ID를 사용한다. 이미 ready인 재호출에서도 root/metadata의 부모 저장을 확인한다. operation이 게시되기 전 중단에 영구 ID가 있었다고 가정하지 않는다.
- 스킬 복사와 state-backend 고정 파일도 같은 게시 helper를 사용한다. 직접 생성/게시 helper에 scope를 생략하면 쓰기를 거절한다. 모델/도구는 scope나 엔진 금지 경로를 발급하지 않는다.

## 검증 준비와 비용

공통 변경 연산13개와 공개 setup14개를 추가했고, 기존 회귀를 포함한 관련133개가 통과했다. 첫 관련시험130/133의 실패는 sync 경계 오류를 직접 비교하던 시험 관측기를 수정했다. 원 EIO와 경계 종류/연산을 함께 검사하며 제품의 원인 보존 코드는 유지했다. 실제 SIGKILL은 identity 후보 fsync 뒤, config 게시 뒤, 마지막 setup receipt 게시 뒤를 대상으로 한다. 이전 소스의 Linux 전체 2,710개 통과를 이번 변경의 증거로 사용하지 않는다.

저장 뒤 내용 확인과 부모 동기화가 추가되므로 I/O 감소를 주장하지 않는다. 완료된 workspace 읽기 최적화와 이 설정 수명의 내구성 보강을 구분한다. 추가 경로 확인은 OS 권한 격리나 전원 장애 검증을 대신하지 않는다.

## 남은 항목

[Windows native helper](C01-windows-native-progress.md)는 독립 구현과 Rust4개·Windows 대상 Cargo 검사·macOS addon 검사6개를 마쳤으며 현재 런타임의 Windows 거절을 해제하지 않았다. 실제 Windows ACL/핸들·저장 보장, 나머지 저장소 변경 경계와 본체 설치/도구 실행 권한 분리는 남아 있다. 실제 모델/API 시험 중단도 유지한다.

이 A 묶음이 검증되면 [다음 계획](C01-host-file-mutations-plan.md)에 따라 C02 지속 세션을 진행한다. C01 전체와 C01~C10 goal은 진행 중이다.

## 확정한 실행 결과

NAS Debian12/x64/ext4/Node24.20.0에서 **전체 2,737/2,737**, 관련133/133, 빌드·코어 타입·계층125파일/위반0·계층 CLI4개·합성 fixture4시나리오22판정이 통과했다. 실패·취소·skip·todo는0이다. macOS는 build2와 관련133/133을 실행했고 이 소스의 별도 전체시험은 실행하지 않았다. lint 명령은 구성되어 있지 않다. [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-setup-mutations-verification.json).

최종 source `7224d97d9706d38fe4930d375ad74ccb1eb32ed3a8accfb6e3472ed4bb6fea6e`, build `dcb50d2ce1523f9200fc7e3b27c383b5780c13ab95a162a354df61b3b44bc7c7`, 산출물1158개. 최초NAS 빌드는 macOS tar의 AppleDouble 부가파일로 소스 목록 검사에서 실패했으며 전체시험은 시작하지 않았다. 원 로그·archive를 attempt-1에 보존하고 부가파일414개를 확인·분리했다. `--disable-copyfile --no-xattrs`로 다시 전송한 뒤 로컬과 원격 소스의 일치를 확인했다. 검증기를 완화하거나 시험을 제외하지 않았다.

최종 전체 실행은 2026-09-06T19:07:48.481Z에 완료됐다. SSH 관찰 연결 종료 뒤 재연결한 2026-09-06T20:41:43.585Z에 원 결과/TAP와 소유프로세스0을 확인했으며 재실행하지 않았다. 원로그8개와 소스/빌드/정적자산7개를 대조하고 2026-09-06T20:41:59.664Z에 root0700·기본Node18·프로세스0 확인 및 SSH/socket/로컬 제어폴더 정리를 마쳤다. NAS 전용 Node24·시험 폴더·캐시·실패 증거는 보존했다.

Windows 모듈의 별도 소스8개 해시와 검사 증거도 확인했다. Rust 입력·정책4개, Windows 대상 Cargo check, macOS addon 거절6개 통과는 실제 Windows 파일 연산/ACL/중단 복구 검증을 의미하지 않는다.

A의 지원 POSIX 인수 조건을 충족했으므로 다음 구현은 [C02 지속 세션 계획](/Users/seunghanee/Documents/secumon/design/chapters/C02-persistent-session-plan.md)다. 기존 작업 엔진과 기억 저장소를 재사용해 원문 이력·세션 문맥·작업 상태를 분리하고, X 완료 후 Y의 실제 모델 입력까지 같은 대화를 이어준다. 실제 모델/API 호출 중단은 유지한다.
