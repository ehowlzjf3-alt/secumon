# C01 작업 파일 안정 읽기와 중복 조회 제거

2026-09-07 · 구현·macOS 관련 검증·NAS Linux 전체 검증 완료 · C01 전체는 진행 중

작업 파일 목록을 가져올 때 같은 파일을 두 번 열고 파싱하던 흐름을 한 번으로 합쳤다. 개별 조회와 목록 조회가 같은 레코드 검증을 사용하며, 읽는 도중 파일의 실제 객체·크기·변경 정보가 달라졌는지도 공통 파일 어댑터에서 확인한다.

## 구현한 변화와 재사용

- [`file-workspaces.ts`](/Users/seunghanee/Documents/secumon/runtime/src/infrastructure/file-workspaces.ts)의 `#serialized`는 기존 files 폴더 참조를 사용해 제한된 안정 읽기를 요청한다. 처음부터 없는 파일과 열었던 파일의 소실을 구분하며, 파일 변경 오류는 `workspace_file_changed`로 전달한다.
- `#record`는 같은 bytes에서 JSON/schema·체크섬·정규 base64·길이·원문 SHA-256·파일명·work/attempt/path를 검증한다. 목록은 각 레코드를 한 번 읽고 검증한 뒤 file 정보만 모은다.
- 공통 어댑터의 최대 두 번 읽기 시도를 사용한다. 내용이 계속 바뀌면 성공을 반환하지 않는다. 부재·변경·권한 거절·실제 I/O 실패의 원인을 섞지 않는다. list 내부의 실제 read I/O를 데이터 손상으로 바꾸던 부분은 원오류 전달로 명시적으로 수정했다.
- 하드링크는 여러 이름이 같은 파일 데이터를 가리키는 기능이다. 기존 허용 정책을 저장소 내부의 고정 콜백으로 유지하며 모델/도구 옵션으로 노출하지 않는다. 일반 파일·소유자·권한과 읽기 안정성 검사는 계속 적용한다.
- v1 파일 형식, 직렬화/원문/attempt 한도, pending 거절과 단일 파일 read 범위, 저장·동일 재요청·manifest 삭제·체크포인트, 앞서 검증한 폴더·잠금·sync 코드를 재사용했다. [텍스트 재사용 확인](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-workspace-read-io/reuse-audit.json)은 동작 시험과 구분한다.

## 실제 측정한 효율

같은 합성 파일과 반환값, JSON 검증 입력을 대조했다. 변경 전 모듈의 원본을 먼저 보관하고 import 경로 6개만 바꾼 사본으로 비교했다. 당시 NAS build manifest와 본체·공유 compiled JS42개의 해시도 확인했다.

| 따뜻한 캐시의 안정 목록 조회 | 변경 전 | 변경 후 |
| --- | ---: | ---: |
| 1MiB 원문 파일 하나: 파일 열기 / JSON.parse | 2 / 2 | 1 / 1 |
| 같은 파일의 전달된 직렬화 bytes | 2,797,008 | 1,398,504 |
| 혼합 크기 8개: 파일 열기 / JSON.parse | 16 / 16 | 8 / 8 |
| 혼합 8개의 전달된 직렬화 bytes | 4,039,588 | 2,019,794 |

개별 read의 데이터량은 같다. 안정성을 확인하는 추가 조회 비용도 있다. 혼합 목록의 file lstat는 0→8, directory lstat는 39→55다. 시간 측정에는 계측 자체와 잠금·sync가 포함되고 캐시도 따뜻하다. 이 숫자는 장치의 물리 I/O나 전체 도구·에이전트 응답 시간의 절반 감소를 의미하지 않는다. [측정 방법과 로컬 결과](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-workspace-read-io/local-results.md).

## 검증 상태

macOS/Node24 빌드1과 관련 **163/163**이 통과했다. 새 **41개**는 읽기 경합·실패19개와 레코드·한도·호환22개다. 단발 변경 후 안정, 두 번 변경 후 실패, 재시도 직전 소실, 원 EIO 및 이중 실패, exact 직렬화/원문 한도, 손상·식별자, 외부 하드링크4개와 pending 정책을 확인했다. 기존 checkpoint·담당 저장소·디렉터리/lock/sync·실제 중단 회귀도 함께 실행했다.

NAS Debian 12/x64/ext4/Node24.20.0에서 **전체 2,710/2,710**, 관련 **163/163**이 통과했다. 실패·취소·skip·todo는 모두 0이다. 빌드·코어 타입·계층125파일/위반0·계층 CLI4개·합성 fixture4시나리오22판정도 통과했다. Linux 전후 paired I/O 비교는 4개 fixture × read/list × 두 버전, 각 5표본에서 동일 입력/반환/검증 입력과 목록의 절반 감소를 확인했다. [확정 증거](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-workspace-read-verification.json) · [회수한 Linux I/O 비교](/Users/seunghanee/Documents/secumon/runtime/evidence/C01-workspace-read-linux-nas-20260907/final/linux-paired-measurement.json).

전체 실행은 2026-09-06T18:12:04.654Z에 종료됐다. 원 로그9개와 I/O JSON1개를 회수하고 현재 소스·빌드·정적자산14개를 대조했다. 2026-09-06T18:12:10.593Z에 전용 시험 프로세스0·루트0700·기본 Node18 유지를 확인한 뒤 SSH/control socket/로컬 전송 임시폴더를 정리했다. NAS 전용 Node24·시험 폴더·캐시는 보존했다. 최신 소스의 별도 macOS 전체시험은 실행하지 않았고, lint 명령은 구성되어 있지 않다.

고정 소스 `835c88d22dd3b1896b55bb68d228c06c7449faed3e0787f226801db353d69b86`, 빌드 `149aa7f3a6ad9721689aac26fe2fdd696141c4dfd35e51b9844b9c3107a0f19c`, 산출물1140개.

## 보장 범위와 다음 단계

파일 하나의 안정 읽기를 강화했다. 목록 전체를 한 시점의 원자 snapshot으로 만들지는 않았고 직접 파일 변경을 완전히 격리하는 OS sandbox도 아니다. 추가 hardlink 제한이나 자동 stale-lock 복구를 도입하지 않았다. Windows native·파일 생성/게시 경계와 실행 쓰기 보호, 지속 세션 및 C02~C10은 남아 있다. 실제 모델/API 시험 중단과 C01/전체 goal 진행 상태를 유지한다.

다음 구현은 [최초 설정의 생성·게시·중단 후 재개](/Users/seunghanee/Documents/secumon/design/chapters/C01-host-file-mutations-plan.md)를 따른다. 프로필 setup을 한 묶음으로 완성한 뒤 C02 지속 세션을 진행하며, Windows native 연결·실제 검증은 병행하는 별도 배치 인수 조건으로 유지한다.
