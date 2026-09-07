# Linux와 Windows 배포 지원

2026-09-06 · 사용자 지정 필수 대상 · macOS는 개발 환경

## 지원 목표와 현재 증거

제품 본체와 설치/상주 실행은 Linux와 네이티브 Windows를 지원 대상으로 둔다. WSL 전용 실행을 Windows 지원으로 대체하지 않는다. 현재 개발 호스트는 macOS이며, 사용자 승인 NAS Debian 12/x64/ext4에서 최종 수정본 전체 **2,491/2,491**, 관련 106/106 시험과 빌드·타입·계층·fixture를 검증했다. [Linux 실제 검증 기록](/Users/seunghanee/Documents/secumon/design/chapters/C01-linux-nas-validation.md). Windows는 실행 전이며 [파일 경계 구현 계획](/Users/seunghanee/Documents/secumon/design/chapters/C01-windows-file-boundary-plan.md)에 현재 수정점을 정리했다. C01 전체나 설치/상주 운영 지원을 완료로 표시하지 않는다. 남은 배포판/Windows 버전·CPU·파일 시스템/서비스 계정은 실제 연결 전에 확정한다.

## 기존/신규 코드에서 찾은 변경 대상

| 영역 | 현재 확인한 가정 | 필요한 구현/검증 |
| --- | --- | --- |
| 경로 | Linux 실제 시험 통과, 루트 인접 basename/계층 검사 구분자 수정 | Windows 드라이브·UNC·대소문자·예약 이름·공백/한글, junction/링크를 실제 호스트에서 검증 |
| 권한 | metadata/작업/저널 저장에서 mode 0600/0700·UID 검사 | Linux 권한과 Windows ACL을 각각 확인. Windows에서 검사를 생략하고 동등한 격리를 주장하지 않음 |
| 원자 저장 | 임시 파일 fsync→덮어쓰기 없는 link→디렉터리 fsync | OS별 원자 게시/교체와 재시작/중단/전원 장애 보장 범위를 구분. 지원하지 않는 sync를 조용히 성공 처리하지 않음 |
| 저장소 | Node SQLite와 파일 저널/작업 저장 | 로컬 파일 시스템 기준 동시 열기·잠금·WAL·복원, SQLite/파일/PostgreSQL 적합성 |
| 프로세스 | 기존 CLI/SIGINT/SIGKILL 중심 시험 | Windows 종료/자식 프로세스 회수·공백 경로·서비스 종료와 Linux 신호/서비스 동작 |
| 설치 | npm bin 등록 후보 | Linux 실행 권한/명령과 Windows 명령 shim, 설치 제거/버전 교체/사용자 데이터 보존 |
| 상시 운영 | 논리적 담당과 실행 프로세스 구분 | Linux 서비스 관리와 Windows 서비스 관리 어댑터. 자동 관리자 권한 요구/설치는 하지 않음 |
| 컴퓨터 유즈 | 로컬 Chrome DOM 예제의 이전 결과 | OS별 브라우저/GUI·세션 잠금·원격/비대화형 환경을 실제 지원 범위로 검증 |

Node 24 공식 문서는 Windows의 chmod가 POSIX의 소유자/그룹/기타 권한 구분을 제공하지 않으며 O_DIRECTORY/O_NOFOLLOW 등도 같은 형태로 제공되지 않는다고 설명한다. 따라서 현재 POSIX 검사를 그대로 Windows 보장으로 사용하지 않는다. [Node 24 파일 시스템 문서](https://nodejs.org/docs/latest-v24.x/api/fs.html).

## 실행 순서

1. C01의 현재 초기화·저장 조합을 로컬에서 검증하되 POSIX 의존 위치와 미지원 경로를 명시한다.
2. C01 다음 단위에서 호스트 파일/권한/내구성의 OS별 어댑터 경계를 도입하고 경로·파일 종류·동시성 시험을 준비한다. 설정 파일로 검사를 무력화하는 우회는 기본 지원으로 삼지 않는다.
3. Linux/Windows에서 동일한 프로필 생성·재호출·이동/복제·부분 복구·동시 초기화·담당 분리 시험을 실행한다. 현재 이용 가능한 실제 실행 환경이 없으면 준비된 코드와 실행 명령/미검증 항목을 남긴다.
4. C03 저장소, C05 컴퓨터 유즈, C06 패키지/채널, C09 상시 임무, C10 서비스/업데이트/복원을 각각 실제 대상에서 확인한다.

macOS 로컬 통과, 다른 OS 분기를 흉내 낸 단위 시험, 실제 Linux 실행, 실제 네이티브 Windows 실행을 별도 결과로 기록한다. 운영체제 정보가 빠진 시험 결과를 전 플랫폼 통과로 올리지 않는다.
