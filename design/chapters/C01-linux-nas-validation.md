# C01 Linux NAS 실제 검증

2026-09-06 · 사용자 승인 NAS 테스트 · 검증 및 연결 종료

## 목적과 범위

현재 C01 담당 디렉터리 초기화·식별·기본 SQLite 저장 조합과 기존 런타임 전체 시험을 실제 Linux에서 실행했다. 최종 수정본 **2,491/2,491 통과**, 실패/취소/skip/todo 0이다. 실제 모델/API 시험 중단은 유지하며, 사내 MCP·Knox 연결이나 운영 배포 시험으로 해석하지 않는다. Windows는 별도로 검증해야 한다. [확정 결과](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-linux-native-verification.json).

## 환경과 격리

- Debian GNU/Linux 12, Linux 6.12.30+, x86-64, glibc 2.36.
- CPU 6개, RAM 약 15 GiB. NAS 기존 Node v18.20.4는 변경하지 않고 테스트 폴더에 Node v24.20.0을 풀어 사용한다.
- 원격 전용 폴더: `/home/shaneee/secumon-linux-test.pCJ0bd`.
- 임시 데이터·npm 캐시·빌드·시험 로그는 전용 폴더에 둔다. 시스템 패키지/서비스/방화벽/기존 데이터는 변경하지 않는다.
- 테스트 파일 병렬 수는 2, 프로세스 우선순위는 nice 10으로 제한한다. 개별 시험의 동시 초기화 시나리오는 그대로 실행한다.
- 테스트 저장 볼륨은 ext4. 관측 mount 옵션에 `nobarrier`가 있으므로 파일 fsync 성공이나 프로세스 복구 통과를 전원 장애 내구성 증명으로 확대하지 않는다.
- 접속 비밀번호는 프로젝트 파일이나 증거 로그에 저장하지 않는다.

## 소스와 실행 파일 확인

전송 대상은 `runtime/src`, `scripts`, `fixtures`, `guidance`, `package.json`, `package-lock.json`, TypeScript 설정 두 파일과 시험에 필요한 고정 합성 IO 기준 자료 5개다. 기준 자료는 기존 fixture의 SHA-256과 대조한 333,125 bytes다. 기존 담당 DB·실제 설정·API 키·원본 압축 자료는 전송하지 않았다. Linux에서 lockfile로 `npm ci --ignore-scripts --no-audit --no-fund` 후 빌드했다.

- 최초 sourceDigest: `0f49c4cacef25a517f21a31c4e361c1c8da77490fb5f962f7092a41b4d26d0aa`.
- 최초 소스 압축본 SHA-256: `ee22f5ab8b9beebd2d9ff81098daac03bb4d8362182cb5816ef28eca406a4e0a`.
- 최종 sourceDigest: `987e6cc8d2e22d1cef9606af7eba69f8a297f34e58e23cb8efc91b4cb5fa5709`.
- 최종 소스 압축본 SHA-256: `1f0e27d8851d8563464bfe578ee156749319021d99ed7bcffcf6565684e7662f`.
- Linux Node 배포본 SHA-256: `2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2`.
- 추가 guidance 압축본 SHA-256: `4493e0e8be358ba60f52919cf43280e7d7b2f34cbda39b14a3d4f9c0fd9ed860`.
- 배포본과 체크섬 출처: [Node 공식 v24.20.0 배포](https://nodejs.org/dist/v24.20.0/). 공식 체크섬을 HTTPS로 가져와 전송 파일을 대조한다.

## 확인한 환경 차이

SFTP 전송 뒤 테스트 폴더·전송 파일이 mode 0777로 관측됐다. 원인은 아직 확정하지 않았다. 전용 폴더에만 chmod 0700을 적용했고, 이후 SSH에서 직접 만든 하위 디렉터리와 파일은 umask 077에 따라 0700/0600이었다. NAS 사용자 홈의 권한은 변경하지 않았다. 설치/전송 도구가 만든 디렉터리는 실제 권한을 재확인해야 한다.

## 검증 순서와 결과 기록

1. Linux에서 새 빌드와 source/build pin 확인.
2. C01 담당 프로필·저장 조합 및 기존 CLI 시험 24개. 최종 수정본은 경로/MCP/state-query를 포함해 관련 106개.
3. 코어 타입 검사와 계층 의존성 검사.
4. 저장/복구/협업/컴퓨터 유즈 대역 등을 포함한 전체 `*.test.js` 시험. 일반 `npm run verify`의 시험 목록을 사용하되 동시 파일 실행 수를 2로 지정한다.
5. 저장소 기존 fixture 명령 및 최종 source/build pin 재확인.

첫 실행은 Linux 새 빌드와 source/build pin 대조 성공, 관련 시험 19/24 통과·5실패였다. 실패한 기존 합성 CLI 5개는 전송 목록에서 `guidance/catalog.json`을 빠뜨린 시험 준비 오류였다. openLocalProfile 직접 진단에서 해당 파일 ENOENT를 확인했고 제품 코드를 수정하지 않고 기본 지침 두 파일을 보충했다. 현재 code pin은 guidance를 포함하지 않으므로 지침 파일 해시를 별도 기록한다. C06 설치 산출물/검증 manifest에는 코드 외 필수 자산도 포함해야 한다.

보충 뒤 관련 24/24·타입·계층 검사가 통과했다. 첫 전체는 2,426/2,468 통과·42실패로, MCP 대역의 macOS 임시 경로 40건, IO 기준 자료 누락에 따른 모듈 등록 실패 1건, timestamp 변경을 가정한 시험 1건이었다. 경로·시험 준비를 수정한 두 번째 전체는 2,490/2,491 통과·1실패였다. journal 읽기 중 임시 링크 제거가 같은 tick에 일어날 때 재확인되지 않아 nlink 비교와 결정적인 회귀 시험을 추가했다.

최종 전체 실행은 2026-09-06T14:52:05.797Z 종료했다. **2,491/2,491·관련 106/106**, 빌드·코어 타입·계층 125파일/위반 0·계층 CLI fixture 4개·합성 4시나리오/22판정이 통과했다. 실제 명령과 로그 해시, 소스/빌드 및 정적 자산 7개의 해시를 검증 JSON에 저장했다. lint는 미설정이다. 변경 없는 소스의 전체 시험을 반복하지 않고 실제 실패 수정 뒤에만 재검증했다.

초기 준비 실패는 `attempt-1/`, 첫 전체 실패는 `baseline/`, 두 번째 전체 실패는 `attempt-2/`, 최종 통과 로그는 `final/`에 보존한다. 모두 `runtime/evidence/C01-linux-nas-20260906/` 아래다. [수정 내용과 범위](/Users/seunghanee/Documents/secumon/design/chapters/C01-portability-result.md).

2026-09-06T14:52:53.882Z 잔여 시험 Node/npm 프로세스 0개, 시험 루트 0700, 기본 Node v18.20.4를 확인했다. tmp에는 Node compile cache만 남았고 전용 시험 폴더는 재사용을 위해 보존했다. SSH 제어 연결을 종료했다. [정리 관측](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-linux-nas-20260906/cleanup.json). 이 결과는 해당 Debian/x64/ext4 환경의 현재 계약 검증이며 모든 Linux 파일 시스템이나 전원 장애·네이티브 Windows·제품 설치/운영 완료를 뜻하지 않는다.
