# C01 Windows 파일 경계 — 다음 구현 단위

2026-09-06 · 현재 소스 정적 검토 결과 · Windows 실행 검증 전

## 개념

운영체제마다 경로·권한·파일 저장 방식이 다르다. 에이전트의 목표·계획·실행·기억 코어는 이 차이를 알 필요가 없다. 담당 디렉터리에 대한 접근을 검사하는 호스트 파일 어댑터가 OS별 처리를 맡고, 위쪽 저장소는 검증된 담당 영역만 사용한다.

여기서 원자 게시란 중간에 잘린 내용이 아니라 이전 또는 새 파일 하나를 보이게 하는 것이다. 프로세스가 중단돼도 다시 열어 복구하는 것, 전원이 끊겨도 마지막 저장이 남는 것은 별도의 보장이다. OS별 차이를 단순한 성공 반환이나 옵션 하나로 숨기지 않는다.

## 실제 코드에서 확인한 수정점

| 우선순위 | 위치 | 현재 문제 | 수정 단위 |
| --- | --- | --- | --- |
| 높음 | file-agent-profile, agent-stores, file-workspaces, file-journal-state | mode 0700/0600 및 UID 검사가 Windows ACL 검증을 대신할 수 없음 | private root/파일 생성·검사의 OS 경계 추출 |
| 높음 | 위 파일들과 file-artifacts | O_NOFOLLOW/O_DIRECTORY와 디렉터리 fsync의 POSIX 가정 | 파일 종류·링크·원자 게시·flush capability 분리 |
| 중간 | agent-stores | 검사 후 SQLite가 경로를 다시 여는 사이 교체 가능성 | 루트 접근 제어·수명 중 경로 보호, DB/sidecar 재확인 |
| 중간 | file-artifacts | 다른 저장소보다 루트 식별/권한 고정이 약함 | 공통 검증 루트 적용 |
| 작음 | file-workspaces, file-journal-state | `absolute.slice(dirname(absolute).length + 1)`는 `/agent`와 `C:\\agent`처럼 부모가 루트이면 첫 글자를 자름 | basename 사용·파일시스템 루트 거부·POSIX/Windows 경로 단위 시험 |
| 작음 | file-journal-state | `/\/\d{16}\.json$/`로 journal 파일을 구분해 Windows 경로의 IO 계측이 잘못됨 | basename으로 파일명 판정 |

작은 경로 문제는 양 OS에서 재현할 수 있는 순수 함수로 먼저 수정한다. 파일 저장 경계는 한 번에 재작성하지 않고 기존 POSIX 구현을 추출한 다음 Windows 구현을 연결한다.

## 어댑터 방향

- 공통 경계 후보: private root 열기, regular file 읽기, private child 생성, 덮어쓰지 않는 게시, 원자 교체, 저장 보장 조회. 검증된 루트 객체를 사용해 저장소마다 임의 경로 검사 규칙이 달라지지 않게 한다.
- TypeScript 코어는 유지한다. Node만으로 필요한 Windows 핸들·ACL 검사가 안 되는 부분은 작은 Rust/C++ native 모듈 후보로 한정한다. 이 문서는 모듈 구현이나 Windows 검증 완료 기록이 아니다.
- Windows에서는 생성 시점부터 보호된 DACL을 적용하고 핸들의 owner SID·DACL을 확인한다. 파일마다 PowerShell/icacls 프로세스를 호출하는 구조는 정상 읽기 경로에 넣지 않는다.
- reparse point는 다른 경로로 연결되는 Windows 파일 객체다. 마지막 파일의 링크뿐 아니라 중간 junction 및 경로 교체도 확인한다. 핸들/파일 식별과 수명을 함께 다룬다.
- 게시 결과와 flush 결과를 나눈다. 게시 뒤 flush 실패를 무조건 미실행으로 되돌리지 않으며, 결과 미확정 상태에서 실제 파일을 조회하고 복구한다. 지원하지 않는 내구성은 명시적으로 반환한다.
- private 권한은 다른 OS 계정 접근을 제한한다. 같은 계정으로 실행되는 담당 간 분리는 범위가 고정된 도구·저장 포트가 기본이다. 임의 셸을 허용하면서 ACL만으로 완전한 상호 격리를 주장하지 않는다.

## 지원·검증 범위

첫 Windows 구현은 일반 사용자 계정과 로컬 NTFS 기준으로 검증한다. UNC/SMB·동기화 디렉터리·ACL 미지원 볼륨은 capability를 확인하기 전까지 같은 보장으로 표시하지 않는다. 배포 요구 자체에서 Windows를 제외하는 의미는 아니다.

필수 실제 시험: 담당 생성/재호출/이동/동시 초기화/부분 복구/DB 분리, 다른 일반 계정의 읽기·쓰기 차단, 상속 ACL/소유자 불일치/null DACL, symlink/junction/hardlink 및 중간 경로·sidecar 교체, 한글/공백/루트 바로 아래/대소문자/긴 경로, 열린 핸들·공유 위반, 게시 단계별 프로세스 종료와 재시작. 전원 장애는 별도 증거로 기록한다.

논리적인 workspace 경로는 이미 역슬래시·콜론·상위 이동을 거절하고 물리 파일명은 해시를 사용한다. Windows 예약 이름 검사는 실제 에이전트 루트 입력이나 파일 내보내기 경계에 적용한다.

## 근거

- Windows 권한과 파일 상수: [Node 24 파일 시스템 문서](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-constants).
- 파일·디렉터리 핸들과 reparse point: [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).
- 핸들의 보안 정보: [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo).
- 이동과 flush: [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw), [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers). MOVEFILE_WRITE_THROUGH만으로 POSIX 디렉터리 fsync와 동등하다고 판단하지 않는다.
