# D1 Linux 검증 스크립트 초안

`C03-personal-linux-nas-20260907`의 절차를 문서형 개인 기억 D1용으로 옮겼다. 이 폴더를 작성한 담당은 스크립트 실행, SSH 접속, 자격증명 접근, 빌드 또는 시험을 하지 않았다. 아래 순서는 루트 담당의 검토와 소스 동결 뒤에만 실행한다. 아직 검증 결과나 통과 수가 아니다.

- 로컬 실행 위치: `runtime/`, 로컬 Node `v24.20.0`.
- 원격 전용 루트: `/home/shaneee/secumon-linux-test.pCJ0bd`; 원격 Node `node-v24.20.0-linux-x64/bin/node`. 시스템 기본 Node는 바꾸지 않는다.
- 루트 담당이 사전 점검 및 SSH control 디렉터리를 준비하고, 그 절대 경로를 이 폴더의 `control-directory.txt`에 기록한다. 스크립트에는 자격증명이 없다.
- 업로드는 `documents-c03-source.tar.gz`, `documents-c03-build-pin.json`, `verify-linux-documents-c03.mjs` 세 개다. 기존 runtime의 `src/scripts/fixtures/dist` 및 package/tsconfig 파일은 `before-documents-c03`에 먼저 보존한다. 후속 시도는 별도 접미사를 붙인다.
- 기존 `guidance`와 `evidence/internal-io`의 고정 시험 자산 7개는 그대로 사용하고 원격 runner에서 SHA-256을 대조한다. 의존성 lock이 다르면 자동 설치하지 않고 거절한다.

| 순서 | 파일과 인수 | 결과 |
| --- | --- | --- |
| 1 | `prepare-upload.mjs 1` | 검증한 현재 로컬 build pin, 압축본·업로드 SHA, 원격 추출 소스 digest, 이전 소스 백업 확인 |
| 2 | `start-native.mjs 1` | 현재 업로드의 attempt와 source pin을 확인한 후 원격 runner를 한 번 실행하고 observer 결과 기록 |
| 3 | `collect-attempt.mjs final` 또는 `collect-attempt.mjs attempt-1` | 끝난 원격 결과와 단계별 원로그를 새 폴더로 회수하고 SHA 기록; `final`은 passed만 수용 |
| 4 | `close-native.mjs` | final 회수 후 전용 Node/npm 프로세스 0개, root 700, 기본 Node 18을 확인하고 SSH control과 빈 제어 폴더 정리 |

실패 뒤에는 실패 시도부터 회수한다. 다음 `prepare-upload.mjs N`은 끝난 실패 결과만 원격 `evidence-documents-c03-attempt<N-1>`로 이동한다. `start-native.mjs N`도 직전 실패의 로컬 회수를 확인하며 이전 실행 메타데이터를 해당 attempt 폴더에 보존한다. 부분 업로드/백업/추출 실패는 자동으로 되돌리거나 무한 재시도하지 않으므로 루트 담당이 남은 파일과 백업을 먼저 확인한다. 성공 전 종료가 필요하면 이 정상 완료용 `close-native.mjs`를 우회하지 말고 루트 담당이 실제 프로세스와 연결을 별도로 정리하고 결과를 기록한다.

원격 runner의 7단계는 build → documents-targeted → core 타입 검사 → 계층 검사 → CLI 계층 fixture → 전체 시험 → 업무 fixture다. targeted는 빌드 직후 실제 `dist/tests`의 필수 파일 존재를 확인하고 `document-knowledge*.test.js`를 합쳐 목록을 남긴다. 문서 profile/담당 저장소/CLI·Web/복구, 기존 개인 기억 서비스·문맥·표면·SQLite 이전, 담당 profile·동시 초기화·backend·clone·setup을 포함한다. targeted 및 전체 시험 수는 실행 전 추정하지 않는다.

빌드 직후와 전체 단계 뒤에 `verifyEvaluationBuild`의 source/build pin 전체를 업로드한 로컬 pin과 비교한다. 단순 source digest 일치나 일부 표면 성공만으로 전체 검증 완료를 표시하지 않는다. 실제 모델, 사내 서비스, Windows native, 운영 배치는 이 스크립트의 검증 범위에 없다. 기존 C03 증거 폴더는 수정하지 않는다.
