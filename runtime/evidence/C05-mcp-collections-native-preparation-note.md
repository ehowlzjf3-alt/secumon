# C05 collection 단위: 최종 소스 이후 NAS 준비 재사용 메모

상태: 읽기 검토만 수행했다. 이 메모 외 파일 생성·수정, helper 복제, 빌드·시험·SSH·전송·native 실행은 하지 않았다. 일반 CLI/HTTP 인수 통합 뒤의 최종 source/build 및 신규·관련 전체 선택 결과가 준비되어야 새 native attempt를 만들 수 있다. 현재 `new2`의 교정 3파일 통과는 최종 신규 전체 인수의 대체 증거가 아니다.

## 그대로 재사용할 구조와 변경할 이름

아래 원본은 모두 [완료된 offline helper 디렉터리](C05-mcp-offline-linux-nas-20260907/README.md)에 있다. 원본·이전 실행 출력은 보존하고, 다음 준비 때만 새 `C05-mcp-collections-linux-nas-20260907/` 디렉터리로 필요한 helper를 변형한다. 날짜는 최종 운영자가 확정하되 모든 참조에 일관되게 사용한다.

| 실제 재사용 원본 | 유지할 역할 / collection 전환 지점 |
| --- | --- |
| `C05-mcp-offline-linux-nas-20260907/select-local.mjs` | **첫 native 실행용** 로컬 성공 alias 선택기. 증거 prefix·선택 목록·출력 디렉터리 변경. 이전 native 실패를 요구하지 않는다. |
| `C05-mcp-offline-linux-nas-20260907/configure.mjs` | root/SSH host/기존 private control 검증. 새 config 이름과 아래 offline predecessor의 경로·scope·해시로 변경. |
| `C05-mcp-offline-linux-nas-20260907/mcp-offline-c05-common.mjs` | pin/alias/argv/TAP/관측 가능한 전용 프로세스 검증. 이름은 `mcp-collections-c05-common.mjs`; 내부 config import와 predecessor 상수도 함께 변경. |
| `C05-mcp-offline-linux-nas-20260907/preflight.mjs` | 현재 root/Node/프로세스 및 실제 원격 predecessor 결과 검증. 새 common을 사용. |
| `C05-mcp-offline-linux-nas-20260907/prepare-upload.mjs` | 실제 통과 목록과 alias, archive allowlist, 7개 upload SHA, lock 불변, 이전 checkout 백업 유지. 아래 모든 원격 이름을 함께 변경. |
| `C05-mcp-offline-linux-nas-20260907/start-native.mjs` | 새 `verify-linux-mcp-collections-c05.mjs`를 한 번 시작하고 실제 SSH 자식 종료를 기록. 이전 attempt 종료/회수 gate 유지. |
| `C05-mcp-offline-linux-nas-20260907/verify-linux-mcp-offline-c05.mjs` | 8단계·유한 process-group 회수·처음/마지막 build pin 유지. 단계는 `new-mcp-collections-tests`, scope는 제안 `native_linux_mcp_collections_general_resume`. |
| `C05-mcp-offline-linux-nas-20260907/collect-attempt.mjs` | `attempt-N` 또는 `final` 원문 회수. 새 원격 결과 디렉터리와 단계 allowlist로 변경. |
| `C05-mcp-offline-linux-nas-20260907/close-native.mjs` | 성공 결과/pin 확인 → 전용 프로세스 감사 → SSH master 종료/socket·control directory 제거 → metadata 기록 유지. |
| `C05-mcp-offline-linux-nas-20260907/finalize-evidence.mjs` | 실제 8단계·로컬 종료·9개 회수 SHA·cleanup·현재 pin을 모두 검증한 뒤 새 proof만 `wx` 게시. 경로/scope/선택 목록/인수 설명만 이번 단위에 맞춘다. |

새 이름 묶음 제안은 로컬 `C05-mcp-collections-*`, 원격 `mcp-collections-c05-*`, 결과 `evidence-mcp-collections-c05`, 백업 `before-mcp-collections-c05-attemptN`이다. `new-mcp-collections-tests`는 runner/collector/finalizer 모두에서 일치해야 한다. 최종 scope 제안은 `mcp_collections_general_resume`, chapter/goal 완료는 계속 false다.

[기존 재시도 selector](C05-mcp-offline-linux-nas-20260907/select-local-attempt.mjs)는 첫 실행에 복사할 필요가 없다. 이는 2~9 attempt만 허용하며, **같은 단위**의 직전 실패 결과·회수 SHA와 초기 selector 해시를 요구한다. 새 collection 단위를 offline의 attempt3으로 취급하거나 이전 실패 경로/하드코딩된 selector SHA를 그대로 가져오면 안 된다.

## 선행 증거와 실행 인자

현재 읽은 실제 predecessor는 [offline verification](C05-mcp-offline-linux-nas-20260907/verification.json)이다. `status=verified_supported_local_posix_partial_chapter`, `scope=mcp_offline_general_resume`, native passed이며 proof SHA는 `28cdec0cdcaa8d7e308e8341258218a6b85e31d5053f50cf914e5e6edd7f38b9`다. [원 native result](C05-mcp-offline-linux-nas-20260907/final/result.json) SHA는 `a64d5f74827c2db5ae3ecb103ce1863663d4de148f189129e0ac75b10a3607c3`; 원격 predecessor 인자는 `evidence-mcp-offline-c05/result.json`이다. configure/common/finalizer의 기존 custody 경로·scope·해시 세트를 모두 이 값으로 바꿔야 한다. 그 proof의 3601/3601과 1758 compiled files는 **이전 단위 값**이며 새 실행 기대값으로 쓰지 않는다.

실행 디렉터리는 `runtime`, 로컬 Node는 `.tools/node-v24.20.0-darwin-arm64/bin/node`다. 아래는 향후 새 helper의 인자 계약이며 이 메모에서 실행하지 않았다.

- `select-local.mjs <stage-selection.json> <terminal-input.json>`: 선택은 정확히 `{build:"buildN",new:"newN",related:"relatedN",core:"coreN",architecture:"architectureN"}`. 종료 입력은 `{executions:[{stage,sessionId,exitCode}],synchronous?:[{stage,exitCode}],observedAt?:string,source?:string}`이고 선택된 5개 stage가 각각 한 번 존재해야 한다. new/related는 실제 세션 ID 필수다. 임의 메타필드는 strict schema에서 거절된다.
- `configure.mjs <NAS_ROOT> <SSH_CONFIG_HOST> <OBSERVED_DEFAULT_NODE> <FRESH_CONTROL_DIRECTORY> evidence-mcp-offline-c05/result.json evidence/C05-mcp-offline-linux-nas-20260907/verification.json [별도 역사 JSON...]`: 알려진 root `/home/shaneee/secumon-linux-test.pCJ0bd`와 private Node24는 재관측한다. system Node `v18.20.4`도 이전 관측일 뿐 새 인자에는 실제 확인값을 넣는다. 기존 control은 재사용하지 않고, 운영자가 이미 개설한 same-UID 0700 디렉터리의 `control` socket만 등록한다. 비밀번호/키/credential 파일을 찾거나 작성하지 않는다.
- `preflight.mjs` → `prepare-upload.mjs 1 <local-new-result.json> <local-related-result.json>` → `start-native.mjs 1` 순서다. 설정·pin·alias·전송물은 실제 최종 소스/선택 성공 뒤 생성한다.
- 실제 native 종료 뒤 성공이면 `collect-attempt.mjs final` → `close-native.mjs` → `finalize-evidence.mjs`. 실패이면 먼저 `collect-attempt.mjs attempt-1`로 원 결과/생성된 로그를 보존한다. `close-native.mjs`는 성공용 gate이므로 실패 실행을 성공으로 바꿔 통과시키지 않는다. 실패 후 정리·다음 실행은 별도 운영 판단이다.

## 이번 선택에서 놓치면 안 되는 차이

현재 [collection local runner](C05-mcp-collections-run.mjs)는 기존 offline runner와 같은 per-run observation 형태를 이미 사용한다. 새 runner를 중복 작성할 필요가 없다. 그러나 [new2 원 observation](C05-mcp-collections-new2.json)의 argv는 교정 3파일만 포함하며 `--test-timeout=60000`이 없다. [related1 명령 기록](C05-mcp-collections-related1-command.json)에도 그 옵션이 없다. 기존 selector/common은 이 옵션을 필수로 검증하므로 이 결과를 그대로 최종 alias로 만들 수 없다. 관측한 옵션을 나중에 JSON에 덧붙이거나 검증기를 느슨하게 하지 않는다.

일반 입구 인수 통합 후 최종 선택 실행에 `--test --test-concurrency=2 --test-timeout=60000`을 명시하면 기존 selector를 그대로 재사용할 수 있다. `--test-reporter=tap`은 명시 권장이나 기존 selector는 spec 최종 요약도 허용하므로 reporter만을 위한 재시험은 필요 없다. 실제 최종 요약 tests/pass/fail/cancelled/skipped/todo와 duration을 읽고, 41·110·기존 145/847 등의 수치를 하드코딩하지 않는다.

최종 선택 파일은 아직 생성되지 않았다. 다음 두 JSON을 실제 최종 실행 argv와 정확히 같게 만들고 서로 겹치지 않게 한다.

- `evidence/C05-mcp-collections-new-files.json`: 현재 새 6파일 `dist/tests/{host-collection-profile,read-complete-resume,mcp-stored-read-collections,mcp-collection-host-tools,read-connection-control,read-resume-options}.test.js`, 변경된 `dist/tests/read-collection-context.test.js`, 그리고 실제 통합 후 `dist/tests/mcp-collection-entry.test.js`를 포함하는 후보. `tool-availability-runtime.test.js`처럼 별도 변경/검증된 기존 파일의 배치는 최종 root 선택에서 확정한다. 새 entry fixture/worker 자체는 `.test.js` 선택기가 아니라 build pin에 포함되는 소스다.
- `evidence/C05-mcp-collections-related-files.json`: [35파일 선택 제안의 `files`](C05-mcp-collections-related-selection-note.json)와 [실제 related1 명령의 34파일](C05-mcp-collections-related1-command.json)을 시작점으로 삼는다. 차이는 별도 통과로 제외한 `tool-availability-runtime.test.js`다. 최종 새 목록에 들어간 파일은 관련에서 제외하고, 추가 entry 변경에 필요한 회귀만 근거를 남겨 더한다. 이전 offline 847개 전체 묶음은 자동 복사하지 않는다.

[일반 입구 인수 계획](C05-mcp-collections-generic-entry-acceptance-plan.md)과 [entry staging manifest](C05-mcp-collections-entry-acceptance-staging/manifest.json)는 통합·검증 대상이며 이 메모에서는 실행 증거로 쓰지 않았다. 새 finalizer의 인수 설명은 그 최종 실제 결과를 읽은 뒤 확정한다. 이전 plain-read CLI2/HTTP4를 이번 collection 인수로 이름만 바꾸거나, 아직 확인하지 않은 page/wait 범위까지 완료로 올리지 않는다.

## pin·업로드·종료 검증에서 유지할 경계

[`evaluationCodePin`/`verifyEvaluationBuild`](../src/infrastructure/local-evaluation.ts)는 `src/scripts/fixtures` 및 package/lock/두 tsconfig를 원 source로 해시하고, manifest를 제외한 전체 dist의 `.js/.js.map/.d.ts` 기대 목록과 지문을 검증한다. 반환 `fileCount`는 **compiled 파일 수**다. 같은 source여도 entry helper 추가 뒤에는 source/build pin이 달라진다. 현재 중간 build4/new2 성공을 그 뒤 소스에 소급하지 않는다.

로컬 selector는 final current pin과 실제 stage source before/after 및 test build before/after를 대조하고, 종료 원문/세션 관측과 선택 파일 SHA를 묶는다. prepare-upload는 그 alias와 선택 argv를 다시 확인하고 source archive 작성 전후 pin을 대조한다. 원격은 추출한 source digest, build 직후 pin, 전체 단계 후 pin을 대조한다. finalizer는 현재 로컬 pin, 원격/로컬 결과와 원로그 SHA, 선택 목록, 최종 dist의 모든 `.test.js`가 full에 포함됨을 다시 확인한다. evidence helper와 이 메모는 source pin 범위 밖이므로 새 helper provenance에 원본/변형 SHA·정적 검사 결과를 따로 기록한다.

업로드는 새 prefix의 source archive/runner/common/config/validation-inputs/targeted-files/build-pin **7개**만이며, tar 내부 allowlist는 `src`, `scripts`, `fixtures`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.core.json`이다. 기존 lock과 다르면 자동 npm 설치 없이 거절한다. 원격 기존 checkout/dist는 새 attempt 백업으로 이동하며 이전 증거는 덮어쓰지 않는다. 기존 원격 `architecture-cli-check.mjs`도 계속 필요하다.

remote runner가 SHA로 검증하는 기존 별도 7개 asset도 그대로 필요하다: `evidence/internal-io/`의 `v024-original-metrics.json`, `v024-instrumented-metrics.json`, `v024-snapshot-manifest.json`, `v024-instrumented-manifest.json`, `instrumented-file-artifacts.js`, 그리고 `guidance/catalog.json`, `guidance/evidence-review.md`. 이는 source archive에 없어 기존 원본/해시 검증을 제거하면 안 된다.

8단계는 build → new → related → core → architecture → architecture CLI fixtures → full → fixtures다. full 1200초, 전체 1800초, new/related 각각 300초, 기타 180초, 개별 test 60초를 유지한다. TERM 5초 → 필요 시 KILL → 관측 5초 및 log flush 5초 후에도 실패를 유한하게 기록하며, timeout 뒤 exit0은 성공이 아니다. 남은 overall 한도는 각 단계 한도를 줄일 수 있다. raw log 회수는 현재 파일당 32MiB `maxBuffer`이며, 초과 시 원로그를 보존하고 명시 실패로 다뤄야 한다.

성공 최종화에는 원 결과+8로그의 9개 SHA, 실제 observer exit0, 전후 동일 source/build, 관측 가능한 전용 root 프로세스0, 직접 소유 group 부재, SSH/socket/control 디렉터리 종료가 모두 필요하다. 감사는 모든 comm 이름을 대상으로 하지만 same-UID `/proc/exe,cwd` 접근 불가 peer는 별도 unresolved이며 전 시스템 프로세스0을 증명하지 않는다. 독립 process group으로 옮긴 후손·전원 장애 내구성·실제 사내/API/모델 품질·native Windows·PostgreSQL·전체 C05/goal 완료도 이 결과로 주장하지 않는다.

읽기 기준: 위 경로의 실제 현재 helper/source/JSON을 확인했다. 이전 preparation provenance의 당시 `scriptsExecuted:false` 문구는 역사이며 최종 proof의 실행 사실을 덮지 않는다. 새 helper 생성/실행 단계에서도 기존 실패와 correction 기록, staging, predecessor proof를 그대로 남긴다.
