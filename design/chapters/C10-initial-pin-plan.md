# C10 신규 담당의 자동 최초 pin 계획

**현재 포인터 — 2026-09-08 · checkpoint388:** 지원 npm·개발 경로의 로컬 release 준비와 새 담당 자동 최초 pin 연결은 [사용법](C10-engine-preparation-usage.md)과 [확정 결과](C10-engine-preparation-result.md)를 따른다. 아래 본문은 checkpoint385~387 당시의 계획을 보존한 기록이다. 그 안의 “다음 materialization 단위”는 현재 미구현 항목을 뜻하지 않으며, 운영·플랫폼·사내 연동 등 남은 범위는 최신 결과에서 구분한다.

2026-09-08 · checkpoint387에서 설치 release의 신규 setup 단위를 구현하고 로컬 확인을 진행했다. 실제 확인 범위는 [결과](C10-initial-pin-result.md)와 [체크포인트](../../runtime/evidence/checkpoint387.json)를 따른다. **아래 npm 준비와 미실행 검증 계획까지 완료로 읽지 않는다.** 원 계획은 checkpoint385 소스 지문 `85f45154e47f3dae10ab15a7e57f741f6f69ff4cc949561b9ca30d082a7e17d9`를 읽어 작성했고, 기준선 checkpoint386은 `27e59a3707f605b3d881b8629de8f8b0266a7c63`이다. 실제 모델/API 시험 중단을 유지한다.

이번 단위는 실제 `release.json`을 가진 호출 엔진의 새 담당을 기본 자동 pin 대상으로 삼는다. `FileAgentProfileStore`가 공통 연결점이므로 설치 CLI의 init/open/chat/work가 같은 규칙을 사용한다. 임시 시험은 `engineRegistryDirectory` 호스트 옵션 또는 기존 home 격리 preload를 사용한다. manifest 없는 개발/npm 경로는 원본을 건드리지 않고 기존 동작을 유지하며, 다음 materialization 단위에서 연결한다.

실제 최초 pin hardlink 직후 중단되면 pending 원 파일이 남는다. pin 목록 전체를 느슨하게 만들지 않고 schema 3 operation에 저장된 정확한 첫 pin bytes와 귀속된 링크만 검사해 해당 pending을 목록에서 구분한다. 미게시 단일 링크 후보도 정확한 원 후보여야 한다. 다른 pending·변형된 내용·외부 링크는 거절하며 임의 삭제하지 않는다.

새 담당은 처음 선택한 검증된 엔진을 초기화 작업에 기록하고, 사용할 엔진의 pin까지 게시된 뒤에만 준비 완료로 보여준다. 기존 무핀 담당을 새 담당으로 간주하거나, `offline:true`를 대신 넣어 기존 업데이트 API를 호출하지 않는다. 이후 업데이트는 현재 C10의 명시 백업·오프라인·현재 pin 대조를 그대로 사용한다.

## 현재 재사용할 연결

| 현재 위치 | 실제 계약과 추가 지점 |
| --- | --- |
| `runtime/src/infrastructure/file-agent-profile.ts:106–132` | `inspect`는 ID·설정·setup 영수증·필수 디렉터리로 ready를 판단한다. 새 초기화 형식에는 최초 pin의 원 기록까지 확인하는 조건을 추가한다. 읽는 동안 다른 초기화가 게시할 수 있으므로 기존 재조회도 유지한다. |
| 같은 파일 `:140–193` | 준비된 담당은 먼저 반환하고, 새 setup은 `setup-operation.json` → ID → config → 디렉터리 → `setup.json` 순서다. **operation을 처음 만드는 부분과 setup 영수증 직전**이 연결점이다. |
| `agent-profile-files.ts`, `host-file-mutations.ts` | 디렉터리 객체 확인·원문 일치·덮어쓰지 않는 게시·게시 후 sync를 재사용한다. mutation scope를 모든 초기화를 직렬화하는 전역 잠금으로 간주하지 않는다. 동시성의 승자는 실제 no-replace 게시 결과다. |
| `agent-lifecycle.ts:89–128` | 기존 `pinAgentEngine`은 저장소 초기화·오프라인 유지보수·업데이트 백업을 전제로 한다. 자동 초기화에서 호출하지 않는다. `publishAgentEnginePin`의 순번·이전 기록·소유자 검사와 게시 규칙을 좁은 공통 게시 helper로 분리해 재사용할 수 있다. |
| `agent-stores.ts:31–86` | ready/버전 gate 후 호스트 ID 등록·runtime lease·저장 바인딩·DB를 연다. 이 시점에는 최초 pin이 이미 있어야 한다. 자기 runtime lease를 잡은 뒤 maintenance를 얻으려 하지 않는다. |
| `agent-engine-release.ts`, `agent-engine-registry.ts` | 실제 release 파일 지문·플랫폼·Node 검사, 설치, 설치 객체에 묶인 호스트 등록과 현재 등록 재검사를 재사용한다. 버전 문자열만으로 엔진을 선택하지 않는다. |

## 추가할 최소 기록

기존 schema 1/2를 조용히 확장하지 않고 **초기화 operation schema 3와 완료 영수증 schema 3**를 추가한다. 기존 clone 형식과 config 형식은 그대로 유지한다. 이전 엔진이 알지 못하는 초기화 기록을 legacy ready로 읽지 못하게 하기 위한 버전 변경이다.

- `setup-operation.json`의 신규 initialize 기록: 기존 `operationId`, `identity`, 저장 선택을 보존하고 `initialEngine`을 추가한다. 문서 기억 선택은 `personalMemory: null | 기존 documents 선택`으로 명시해 schema 1/2의 분기를 재사용한다.
- `initialEngine`: **정확한 첫 `EnginePin` 본문**과 검증한 호스트 엔진 등록 기록의 지문을 담는다. pin은 `sequence:1`, 같은 `agentId`, 검증된 `engineDirectory/releaseDigest/version`, `previous:null`, `backupDigest:null`이어야 한다. `createdAt`도 operation에 한 번 고정해 재시도마다 다른 pin을 만들지 않는다. 이는 원 초기 선택의 증명이며 현재 pin head를 영원히 첫 엔진으로 고정하는 설정이 아니다.
- `.secumon/engine-pins/00000001.json`: operation에 기록된 첫 pin의 정확한 본문을 기존 게시 방식으로 저장한다. 이후 순번과 hash 연결은 기존 `EnginePinSchema`/`readAgentEnginePin`을 유지한다.
- `setup.json`의 신규 완료 영수증: `schemaVersion:3`, `agentId`, `operationId`, `initialPinDigest`를 기록한다. 이 영수증은 초기화 완료를 증명한다. DB 초기화나 모델 실행 완료의 증명이 아니다.
- `EngineReleaseSchema.compatibility`에 초기화 형식 지원(`setup`)을 추가하고 새 엔진은 `[1,2,3]`을 선언한다. 기존 manifest의 누락은 파싱을 유지하되 **schema 3 담당을 지원한다고 간주하지 않는다.** check/pin/update에서 실제 setup 형식과 대상 지원을 대조한다. config 형식만 보고 구형 엔진으로 전환하는 것은 부족하다.

실제 검증 함수 이름은 구현 시 정한다. 후보는 `agent-initial-engine.ts`의 검증된 초기 엔진 캡처와 최초 pin 게시 helper다. 호스트가 준비한 설치 경로/지문을 입력받되 매 게시 전에 실제 release·등록·디렉터리 객체를 다시 확인한다. 사용자 config나 모델 도구 입력에서 실행 모듈을 읽는 기능은 추가하지 않는다.

## 신규 초기화의 완료 순서

1. 현재 release를 실제 파일로 검증하고 호스트 엔진 등록을 준비한다. 이 단계가 실패하면 담당의 setup operation을 아직 만들지 않는다.
2. 기존 `inspect`의 uninitialized 판정과 원 소유 흔적 재검사를 사용한다. 단순히 디렉터리가 존재하거나 일반 프로젝트 파일이 있다는 이유로 신규를 거절하지 않는다. 반대로 ID/config/setup/복원 표식/기존 바인딩 자료가 있으면 신규라고 주장하지 않는다.
3. 새 `operationId`·ID·초기 엔진·정확한 첫 pin 후보를 포함한 operation schema 3를 no-replace 게시한다. 반드시 저장된 승자 기록을 재조회한다. 경쟁 패자는 자기 후보 ID나 엔진으로 계속 쓰지 않는다.
4. 같은 operation이 선택한 엔진만 ID/config/필수 디렉터리 게시를 이어간다. 현재 호출 엔진이 다르면 선택된 엔진으로 명시적으로 넘기거나 `initial_engine_mismatch` 같은 명확한 오류로 중지한다. 기존 사용자 옵션·저장 선택 충돌 검사는 유지한다.
5. 기존 operation·config·ID·등록·release가 그대로임을 확인하고 첫 pin을 게시한다. 이미 있으면 **정확히 같은 원문만** 재사용한다. 게시 결과가 불명확하면 없는 것으로 추정하지 않고 다음 재개에서 실제 파일과 원 후보를 대조한다.
6. 첫 pin과 디렉터리 게시 barrier를 확인한 뒤 setup 완료 영수증 schema 3를 마지막에 게시한다. operation/완료 영수증/첫 pin의 hash·ID·순번이 모두 맞아야 ready다. 일반 open은 미완료 상태에서 lease나 DB를 열지 않는다.
7. ready 이후에만 기존 호스트 ID claim, runtime lease, 저장 바인딩·초기화를 수행한다. 저장 초기화 도중 중단돼도 첫 pin을 다시 선택하지 않고 기존 state binding recovery를 사용한다.

`initialize`뿐 아니라 최초 작업을 받으며 profile을 만드는 일반 CLI/chat/work 입구에도 같은 신규 판정이 필요하다. 설치 엔진에서 실행되는 일반 `openAgentTurnProfile`은 이 초기화 helper를 사용한다. 프로그램에서 호스트 콜백을 직접 주입하는 경우에도 검증된 설치 모듈을 호스트가 열어야 하며, 원래 npm 모듈의 실행 코드는 유지한 채 다른 복사본으로 pin만 기록하지 않는다. 콜백 객체를 자식 프로세스에 자동 직렬화하지 않는다.

## 중단·동시성·사라진 기록

| 관측 상태 | 허용할 처리 |
| --- | --- |
| operation 게시 전 중단 | 담당 선택은 아직 없다. 검증된 materialization 결과는 재사용할 수 있다. |
| operation만 있거나 ID/config 게시 도중 | 원 operation/ID/저장 선택/초기 엔진으로 이어간다. 다른 엔진·복제 작업은 승자 선택을 대체하지 못한다. |
| 첫 pin 게시 전 중단 | setup 완료 영수증이 없고 원 operation이 유효할 때만 원 pin 후보를 게시한다. 새 timestamp나 새로운 첫 pin을 만들지 않는다. |
| 첫 pin 게시 성공 뒤 응답/동기화 불명 | 실제 원문과 객체·게시 barrier를 확인해 같은 pin을 재사용한다. `agent_metadata_publish_unknown`을 정상 성공이나 미게시로 바꾸지 않는다. |
| 첫 pin 게시 후 setup 영수증 직전 중단 | pin과 operation의 정확한 대조 후 원 완료 영수증을 게시한다. 이때까지 일반 open은 불가다. |
| 완료 영수증이 있는데 첫 pin이 없거나 다름 | 복구 필요 오류로 중지한다. pin 디렉터리 전체가 없다는 이유로 무핀 legacy 담당으로 취급하거나 첫 pin을 자동 재생성하지 않는다. |
| schema 3 완료 영수증과 operation이 불일치/소실 | ready/자동 repair를 거절한다. 남은 config/ID만으로 schema 1 operation을 만들어 과거로 낮추지 않는다. |
| 첫 pin과 이후 정상 업데이트 기록이 있음 | 초기 완료 증명은 첫 pin으로, 현재 실행 엔진은 검증한 마지막 pin으로 판단한다. 정상 업데이트를 초기 엔진 불일치로 거절하지 않는다. |
| 첫 pin 이후 sequence에 구멍/다른 owner가 있음 | 기존 pin history 거절을 유지한다. 누락된 기록을 재구성하지 않는다. |
| 같은 엔진의 동시 최초 호출 | operation과 첫 pin 모두 실제 게시 승자를 재조회해 같은 ID/원문 하나로 수렴한다. 모든 호출의 성공을 요구하지 않는다. |
| 서로 다른 엔진의 동시 최초 호출 | operation이 고정한 엔진 한 개만 완료시킨다. 패자의 ready/open·DB 초기화·다른 pin 게시를 차단한다. |

기존 완료된 무핀 담당, 과거 v1/v2 초기화의 repair, clone, restore에는 신규 schema 3와 자동 pin을 덧붙이지 않는다. clone/restore의 기존 증명·ID 재등록·명시 pin/update 경로를 유지한다. 이미 관리 대상으로 기록된 최초 pin을 삭제해 무핀으로 돌아가는 동작은 지원하지 않는다. 같은 OS 계정이 모든 증명과 자료를 임의로 함께 위조하는 것까지 막는 실행 샌드박스를 새로 주장하지 않는다.

## npm 패키지에서 로컬 release 준비

현재 npm 설치는 package/dist/의존성을 갖지만 `release.json`은 없다. 검증되지 않은 개발/npm 디렉터리에 manifest를 써넣거나 package version만 pin하지 않는다. 현재 실행 중인 로컬 패키지를 **다운로드 없이** 기존 bundler/installer로 검증 가능한 설치본으로 준비하고, 그 설치본이 신규 setup을 실행하게 한다.

checkpoint387의 읽기 전용 사전 확인에서 다음 공백을 확인했다. 이 문단은 새 npm 실행 시험의 결과가 아니다.

- `package-lock.json`이 npm 산출물에 없는 것은 현 bundler의 필수 파일 실패 조건이 아니다. 실제 존재하는 허용 항목만 수집한다. 배포 대상 dist/JSON fixture/guidance/web HTML·CSS는 현재 package의 files 목록에 있다.
- 실제 고정 조건은 `agent-engine-release.ts`의 `root/node_modules/zod/package.json`과 자기 `node_modules` 트리다. 원 tgz에는 의존성이 없고, 상위 디렉터리에서 의존성을 찾는 local 설치도 이 조건을 충족하지 않는다. 자기 패키지 안에 production 의존성이 있는 사용자 소유 global 설치부터 범위를 구체화한다.
- zod 한 개의 존재만으로 ajv/MCP와 그 하위 의존성까지 자체 포함됐다고 주장하지 않는다. release를 만들 때 외부 폴더의 의존성에 기대지 않고 실행 가능한지 확인해야 한다. 현재 파일 수집의 symlink·다중 hardlink·다른 소유자 거절을 npm link/pnpm·관리자 소유 prefix를 위해 몰래 완화하지 않는다. 해당 배치는 명시 지원 범위를 따로 정한다.
- `captureInitialAgentEngine`은 manifest가 없으면 null을 반환하고 동기 `initialize`는 과거 operation을 만든다. CLI의 `launchPinnedAgent`가 현재 엔진으로 반환하기 전, 신규 담당 초기화에 해당하는 경우에만 준비·등록을 수행하고 기존 `executeSelectedAgentEngine`으로 실제 설치본을 실행하도록 연결한다. read-only status/help나 기존 무핀 담당을 자동 materialization 대상으로 삼지 않는다.
- 기존 `agent-installation.test.ts`의 npm global 설치와 저장소 기반 bundle은 각각의 시험이다. npm 설치본→bundle/install→설치 CLI에서 원 최초 초기화까지 이어가는 인수가 필요하다. 프로그램 API의 호스트 콜백을 동기 initialize 안에서 자식 프로세스로 옮길 수 있다고 가정하지 않는다.

호스트 엔진 등록표 기본값은 `~/.secumon/engines`이며 `registerAgentEngine`은 등록표와 설치 디렉터리의 포함 관계를 거절한다. 따라서 설치 자료는 별도 `~/.secumon/engine-releases/…`, 임시 후보는 별도 호스트 소유 준비 경로에 둔다. 이 경로들은 담당 DB/기억/호스트 ID 등록표와 겹치면 안 된다.

1. `bundleAgentEngine`의 입력 검사와 manifest 계산 부분을 읽기 전용 helper로 분리할 수 있다. package/lock/실행 파일/실행 의존성/자산의 **실제 entries 지문**, OS/CPU/Node 요구를 사용한다. 버전 문자열이나 npm 디렉터리 경로만으로 캐시 적중을 판단하지 않는다.
2. 이미 완성·등록된 동일 지문의 설치본이 있으면 `inspectEngineRelease`와 등록된 실제 디렉터리 객체를 다시 확인한 뒤 재사용한다. 확인되지 않은 같은 이름의 폴더는 채택하지 않는다.
3. 없으면 `bundleAgentEngine` → `installAgentEngine` → `registerAgentEngine`을 호스트가 호출한다. 복사 전후 원본 지문, 목적지 전체 지문, manifest 마지막 게시와 기존 용량 제한을 그대로 사용한다. 현재 npm/source 파일은 변경하지 않는다.
4. 설치가 완료됐으나 등록만 실패했으면 같은 설치의 실제 파일과 지문을 대조해 기존 `register`를 재시도한다. 재설치·디렉터리 교체를 하지 않는다. 등록 실패 상태에서 담당 초기화를 완료하지 않는다.
5. manifest 없는 부분 bundle/install은 유효한 release가 아니다. 원 후보를 보존한다. 기존 복사 함수는 부분 목적지 덮어쓰기/자동 복원을 제공하지 않으므로 **해당 단계의 실패를 명시하고 검증된 새 목적지에서 재시도**한다. 같은 유효 bundle의 설치 재시도는 그 원 지문을 유지한다. 이 단계는 아직 담당 operation을 게시하기 전이므로 담당 ID/초기 pin을 다시 뽑는 복구가 아니다. 자동 무한 재시도·임의 후보 삭제를 추가하지 않는다.
6. 동일 package의 동시 준비는 유효한 설치가 여러 개 생기더라도 타인의 부분 후보를 삭제하지 않는다. 최종 담당 operation이 채택할 설치 경로·등록 하나를 고정한다. 나중에 중복 설치 정리를 도입하더라도 사용 중인 pin과 별도 관리해야 한다.
7. 일반 CLI는 검증된 설치본으로 같은 인수를 넘겨 초기화를 실행한다. 현재 작업의 고정 전달 형식·실제 자식 종료 소유권을 재사용한다. 이미 release.json을 갖춘 bundle 설치는 불필요한 materialization 없이 현재 설치를 검증·등록한다.

호스트 준비 결과는 원 package 지문과 완성 release/등록을 연결하는 완료 기록으로 보관할 수 있다. 단, 파일이 있다는 사실만으로 복사 완료를 추정하는 별도의 캐시 성공 표식을 만들지 않는다. npm 패키지 관리자 실행, 네트워크, 자동 다운로드, 실제 모델 호출은 이 과정에 없다.

## 변경 후보와 작은 검증 순서

제품 변경 후보는 `agent-profile-contracts.ts`(신규 초기화/완료 형식), `file-agent-profile.ts`(read/inspect/operation 승자/완료 게시), 좁은 `agent-initial-engine.ts` helper, `agent-lifecycle-contracts.ts`와 `agent-engine-release.ts`(setup 형식 호환/읽기 전용 build 검사), `agent-lifecycle.ts` 및 PG lifecycle의 실제 setup 호환, 엔진 registry/materialization helper, 실제 CLI·일반 profile 부트스트랩이다. 기존 `operationMemory`의 schema 분기, receipt union과 허용 버전 목록, `#checkCloneTarget`의 metadata 목록은 영향을 따로 확인한다. 신규 엔진 데이터 때문에 원 clone 대상 검사 전체를 느슨하게 만들지 않는다.

첫 구현은 **이미 설치된 유효 bundle의 신규 setup→첫 pin→ready→저장 open**에 한정하고 아래 좁은 인수를 통과시킨다. 다음 구현에서 npm materialization/전역 전달을 붙인다. stable dispatch·compact 전환 시험을 다시 작성하지 않는다.

- `agent-clone-recovery.test.ts`와 `helpers/agent-clone-worker.ts`의 실제 게시 뒤 중단 패턴, `agent-setup-mutations.test.ts`와 worker의 link/sync 오류·SIGKILL 패턴을 재사용한다. operation/첫 pin/완료 영수증의 주요 경계에서 같은 ID와 원 pin만 유지하고 완료 전 open은 차단한다.
- 같은 엔진/다른 엔진의 두 프로세스 최초 호출, 초기화와 clone의 경쟁을 확인한다. 서로 다른 pin이 게시되거나 패자가 DB를 만들면 실패다.
- 완료 후 첫 pin/operation 소실·원문 변경·history 구멍은 자동 재생성 없이 거절한다. 기존 무핀/clone/restore가 변경되지 않는 사례와 정상 sequence 2 업데이트 뒤 reopen을 포함한다.
- `agent-state-binding-recovery.test.ts`의 SQLite/file-journal 최초 저장 개설 중단·원 binding 재개 시험을 재사용한다. pin 완료를 실제 DB 완료로 바꾸지 않는다.
- `agent-engine-registry.test.ts`, `agent-installation.test.ts`의 실제 설치·등록·동일 객체·파일 지문 검사를 재사용한다. npm 준비의 원본 무변경, 등록 단계만 재시도, 부분 산출물 보존, 동시 준비 뒤 한 담당 선택을 추가한다. 일반 설치 재시험 결과와 새 자동 최초 pin 결과를 구분한다.

실제 Linux/native Windows의 새 게시·재실행 경계, 실제 PostgreSQL/사내 연결·운영 설치·미확정 외부 효과·C09/C05/C06 잔여와 최종 통합은 계속 남는다. 이 계획이나 현재 로컬 시험을 그 완료 증거로 사용하지 않는다.
