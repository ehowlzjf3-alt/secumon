# C01 workspace read/list I/O 비교 계측

이 계측 담당은 이 폴더의 스크립트와 합성 자료만 작성하고 로컬 macOS에서 실행했다. 제품 소스·빌드 출력은 읽기만 하며 모델·API·NAS에 접근하지 않았다. 부모 담당이 같은 worker를 Linux NAS에서 별도 실행할 수 있도록 경로를 상대화했다. NAS 실행·통과 여부는 해당 별도 결과로 판단한다.

## 기준 보존과 재실행

`baseline-file-workspaces.original.js`는 변경 전 dist 원본 bytes다. `baseline-manifest.json`에 원본과 비교용 사본의 SHA-256, 캡처 시각, import별 변환을 남겼다. `baseline-file-workspaces.mjs`는 **6개 상대 import 경로만** 이 폴더에서 접근 가능한 `../../dist/...`로 고쳤다. 실행 로직과 원본 source-map 주석은 그대로이며 `.map` 파일은 복제하지 않는다. 부모가 전달한 축약 source/build 식별자는 출처 정보이고, 실제 원본 식별은 완전한 SHA-256으로 한다.

공통 의존성은 복제하지 않는다. 최초 baseline 실행이 `baseline-dependencies.json`에 상대 JS import graph의 해시와 package-lock 해시를 기록하고, 다음 실행에서 하나라도 바뀌면 비교를 중단한다. 이 방식은 잠금 파일과 현재 설치 의존성이 일치하는 기존 환경을 전제로 하며 node_modules 전체의 무결성을 새로 증명하지 않는다. 변경 전 모듈은 새 빌드 후에도 보존한 실행용 사본을 사용한다.

worker 준비 중 새 빌드가 게시되어 변경 전 dist 전체의 의존성 해시를 미리 기록하지 못한 경우, 그 사실을 `captureTiming`에 표시한다. 직전 NAS source archive의 대응 공통 TS 파일·package/lock·tsconfig가 현재와 바이트 단위로 같은지 먼저 확인하고, 현재의 공통 JS 해시를 이후 비교 기준으로 고정한다. 이는 옛 dist 의존성 bytes를 직접 보관해 비교한 것과는 구분한다. baseline 본체의 JS bytes는 처음 보존한 그대로 사용한다.

첫 baseline 측정 후 부모가 직전 NAS의 `baseline-nas-build-manifest.json`을 전달했다. runner는 정규 직렬화한 files 목록의 digest가 직전 build pin `a198150280bc635ae6b7e4dbe75ec2c73604fcf4a2bc8735d32eff3186019eeb`와 일치하고 source pin/1131개 파일 수가 같은지 먼저 검사한다. 이어 baseline 본체 및 캡처한 공통 JS 의존성 각각이 이 manifest와 같은지 확인해 `baseline-build-provenance.json`에 기록한다. 따라서 후속 비교에서는 과거 compiled 의존성 해시도 직접 대조하며, 실행 전후 공통 의존성 및 현재 본체 해시가 바뀌면 거절한다.

runtime 디렉터리에서 Node 24로 실행한다.

```sh
./.tools/node-v24.20.0-darwin-arm64/bin/node evidence/C01-workspace-read-io/run-measurement.mjs baseline
./.tools/node-v24.20.0-darwin-arm64/bin/node evidence/C01-workspace-read-io/run-measurement.mjs after
./.tools/node-v24.20.0-darwin-arm64/bin/node evidence/C01-workspace-read-io/run-measurement.mjs compare paired-measurement.json
```

각 결과 파일은 이미 존재하면 덮어쓰지 않는다. `after`는 기존 baseline 결과와 대조한다. `compare`는 현재 공통 의존성 위에서 frozen baseline/새 dist를 각각 별도 프로세스로 다시 실행하고 순서를 번갈아 배치한다. 하나의 프로세스에는 하나의 모듈 변형·fixture·operation만 둔다.

NAS에서는 이 evidence 폴더와 고정 manifest/의존성 해시 파일을 함께 전달하고, runtime의 dist/node_modules 상대 위치를 유지한다. evidence 폴더에서 실제 Node 24 실행 파일로 `run-measurement.mjs compare linux-paired-measurement.json`을 실행하면 된다. 위 macOS Node 경로는 Linux에서 사용하지 않는다.

## 동일 입력과 관측 창

- 단일 파일은 0 bytes, 4 KiB, 기본 최대 원문 크기 1 MiB다. 혼합 목록은 0, 1, 1024, 4096, 65536, 131072, 262144, 1048576 bytes의 8개 파일이다. multi의 read는 가장 큰 파일 하나를 읽는다.
- raw bytes와 속성·ID·논리 경로는 결정적이다. fixture 생성은 항상 frozen baseline의 stage로 수행하고 **계측 밖**에 둔다. 임시 디렉터리는 이 폴더 안에만 만들고 worker 종료 전 제거한다.
- 1회 warmup과 fixture hash 관측으로 캐시가 이미 따뜻한 조건이다. cold cache·디스크 장치 성능은 측정하지 않는다. 각 조합당 5회 독립 관측 창이 있으나 동일 worker/store를 재사용한다.
- 관측 창은 public `read` 또는 `list` 진입 직전부터 Promise 완료까지다. 실제 lock 생성·검사·해제와 directory fsync 비용을 포함한다. 생성자, stage, warmup, 결과 확인, 입력 hash 계산, cleanup은 포함하지 않는다.
- 반환값은 사전에 생성한 예상 file metadata 및 raw bytes와 deep equality로 비교한다. 디스크 직렬화 원본의 파일별 hash를 전후 비교하고, 실제 JSON.parse에 전달된 문자열 hash의 집합이 예상 파일 bytes hash와 같은지 확인한다. 버전 비교는 fixture·반환값·검증 입력 집합 hash가 모두 같아야 한다. parse 중복 횟수 자체는 별도로 기록한다.

## 카운터의 의미와 한계

fs/JSON.parse 패치는 계측용 격리 worker에만 설치하고 `syncBuiltinESMExports`로 named imports에 전달한다. 함수는 원래 연산을 실행하며 준비·검증 중에는 카운트를 끈다. 마지막에 원래 함수를 복원한다.

| 관측 | 정의 |
|---|---|
| record opens | 성공한 `fs.openSync` 중 `files/<64hex>.json` 경로. directory open과 기타 open 및 실패는 별도 |
| readFileSync bytes | 실제 반환된 Buffer/string 길이. 이 함수 내부에서 패치된 readSync가 관측되면 nested 항목으로 분리 |
| direct readSync bytes | readFileSync 호출 바깥의 `fs.readSync` 반환 수 합. EOF 확인의 0 bytes 호출도 호출 수에는 포함 |
| delivered bytes | readFileSync 반환 bytes + direct readSync 반환 bytes. nested readSync를 다시 더하지 않음. 디스크 장치의 실제 전송량이나 모든 kernel syscall을 뜻하지 않음 |
| JSON.parse | 관측 창 안의 진입 횟수. 입력 문자열 참조를 잠시 유지해 창 밖에서 hash/길이를 계산하며 중복 검증 여부를 확인. Zod 내부 연산 수 자체는 계측하지 않음 |
| metadata | 실제 fs.fstatSync/lstatSync 호출을 결과의 file/directory/other 및 실패로 나눔. 계측용 추가 stat을 실행하지 않음. Node 내부 binding 호출 전체를 포착하는 OS syscall 추적은 아님 |
| elapsed | 계측 장치가 켜진 public 호출의 ms, 5개 표본 min/median/max. lock/sync, 카운터, 문자열 참조 수집 비용 포함. 비계측 성능 수치가 아님 |
| heapUsed delta | 선택적 GC를 각 관측 전 호출한 뒤 직전/직후 heapUsed 차이. 반환값·V8 임시 메모리·계측이 잡아둔 parse 문자열 포함. 최대 사용량·메모리 절감량·회수 후 잔존량으로 해석하지 않음 |

변경 후 안정 목록에서 목표는 파일당 open/직렬화 데이터/parse를 2회에서 1회로 줄이는 것이다. 추가 fstat/lstat와 directory 검사는 따로 보고한다. 중간 파일 변경과 재시도 경합은 이 안정 fixture 계측에 포함하지 않으며 제품 회귀 시험에서 검증한다. 시간이 낮게 나와도 전체 런타임·모든 도구·NAS 지연 개선으로 확대하지 않는다. 과거 NAS TAP에서 긴 file-journal 협업 항목의 원인을 이 계측이 증명하지 않는다.
