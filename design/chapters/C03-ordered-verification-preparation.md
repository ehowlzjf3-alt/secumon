# C03 순차 검증 준비

2026-09-08. 기존 계획·결과와 해당 시험의 호출부를 읽어 선정한 메모다. 이 작업에서는 제품·시험을 수정하거나 빌드·시험·DB·SSH를 실행하지 않았다. 기준은 [순차 검증](C01-C10-ordered-verification.md), [개인 기억](C03-personal-memory-result.md), [문서 기억](C03-document-memory-result.md), [문서 초안](C03-document-draft-result.md), [개인 기억 이관](C03-personal-memory-migration-result.md), [checkpoint366 SQLite 복구](C03-sqlite-recovery-implementation.md)다. 과거 결과의 pass 수와 PostgreSQL/Windows 미구현 표현을 현재 소스의 판정으로 옮기지 않는다.

## 실행 순서와 기존 시험

아래 이름은 `runtime/src/tests/<이름>.test.ts`다. 실패하면 그 원인과 영향 범위만 교정·재실행하고, 매 묶음마다 이전 전체 회귀를 반복하지 않는다.

| 순서 | 파일 | 확인할 결과·현재 준비 상태 |
| --- | --- | --- |
| 1. SQLite와 개인 서비스 | `sqlite-personal-knowledge`, `personal-knowledge-service` | 개인/work·담당/사용자 격리, 원문 출처, 검색/CAS/정정/잊기, 중복 receipt와 재시작. `storageFixture`는 임시 DB를 쓰고 서비스의 `session-flow-helpers.open`은 임시 registry를 주입한다. **Root가 C02 build1의 기존 산출물로 session39727을 실행 중이라고 전달했다.** [target1 원로그](../../runtime/evidence/C03-ordered-target1.log)의 종료 결과를 기다리고 재실행하지 않는다. |
| 2. 문서 정본·현재성 | `personal-memory-revision-status`, `document-profile`, `document-knowledge-storage`, `document-knowledge-boundaries`, `document-memory-recovery-regressions` | 상태 조회의 원 receipt·권한 확인, 기본/명시 documents 선택, 같은 정본·색인·receipt, 잊기 뒤 복원 금지, 손상/링크/용량·게시 중단. 직접 임시 repository 또는 위 임시 registry helper를 사용한다. 이 묶음은 새 HOME 격리 연결 없이 준비할 수 있다. |
| 3. 실제 문맥·일반 입구 | `personal-memory-context`, `agent-document-memory`, `agent-memory-profile-concurrency`, `personal-memory-presentation`, `document-personal-memory-presentation` | 실제 packet/frame/reopen의 명시 회상·현재성, documents routing·기억과 Evidence 분리, CLI/HTTP 저장→새 대화→회상→정정/잊기. 아래 임시 registry 연결이 먼저 필요하다. |
| 4. 편집 초안 | `personal-memory-drafts`, `personal-memory-draft-flow`, `personal-memory-draft-recovery`, `personal-memory-draft-cli`, `memory-draft-web` | 편집 사본과 정본 구분, 명시 apply·중복/재개, source/기억 receipt·SIGKILL 경계. 첫 파일은 직접 임시 저장소, 나머지는 공용 fixture/worker와 CLI 격리 연결이 필요하다. |
| 5. SQLite→documents 이관 | `sqlite-personal-memory-migration`, `document-knowledge-import`, `personal-memory-backup`, `personal-memory-migration-activation-barrier`, `personal-memory-migration-flow` | 원 SQLite snapshot/receipt·fence, 문서 import, 실제 backup worker·중단 복구, activation barrier, compact된 세션/이동/clone/일반 수정의 연속성. 앞 세 파일은 임시 직접 저장소, 뒤 두 파일은 일반 profile open의 registry 연결이 필요하다. |
| 6. 명시 SQLite 복구 | 아래 별도 공백 | 기존 이관/backup이나 정상 owner 검사 통과로 checkpoint366의 prepare/apply/status를 통과 처리하지 않는다. |

작성 중 root가 추가로 알린 결과: `document-memory-recovery-regressions`, `sqlite-personal-memory-migration`, `local-memory-profile` 세 파일은 C02 build1 산출물의 session38942/[target2](../../runtime/evidence/C03-ordered-target2.log)에서 **23/23 pass로 종료·저장**했다. 이 값은 root의 종료 보고이며 이 준비 작업에서 재실행하지 않았다. `local-memory-profile`은 기존 work-memory/workspace 재개 관련 시험으로 root가 선택했다. 이 세 파일은 아래 그룹 때문에 중복 실행하지 않는다. 또한 `personal-memory-context`와 `agent-document-memory`의 open 두 곳씩은 root가 임시 registry를 주입했으며 **아직 unbuilt/unrun**이다. 아래 위치표는 원 호출 위치를 보존하되 이 두 파일의 주입 작업은 완료로 구분한다.

문서 경합·백업 시험에는 이미 실제 자식 프로세스와 SIGKILL이 들어 있다. 새 공용 시험 엔진이나 같은 경계의 중복 시험은 필요 없다. C01에서 끝낸 owner/동시 CLI 묶음도 이번 준비 때문에 다시 실행하지 않는다.

## 실제 HOME을 피하려면 필요한 최소 연결

다음은 **이번 준비에서 확인한 호출 지점 목록**이다. 위에서 root가 교정한 두 파일 외에는 수정 완료를 확인하지 않았다. `FileAgentProfileStore.initialize/inspect`만 쓰는 것은 host registry claim과 다르다. 실제 문제는 `openAgentStores`, `openAgentLocalProfile` 및 이를 여는 CLI/worker다.

| 대상 | 현재 호출 위치 |
| --- | --- |
| 실제 개인 문맥 | [personal-memory-context.test.ts:52](../../runtime/src/tests/personal-memory-context.test.ts#L52), 같은 파일 74행 reopen의 `openAgentStores` 두 곳 |
| documents 기본/이동·동시 개설 | [agent-document-memory.test.ts:18](../../runtime/src/tests/agent-document-memory.test.ts#L18)의 공용 open과 90행 이동 후 open. [agent-memory-profile-concurrency.test.ts:66](../../runtime/src/tests/agent-memory-profile-concurrency.test.ts#L66)의 66/74/95행 및 [agent-memory-profile-race-worker.ts:51](../../runtime/src/tests/helpers/agent-memory-profile-race-worker.ts#L51) |
| SQLite 기억 CLI/HTTP | [personal-memory-presentation.test.ts:50](../../runtime/src/tests/personal-memory-presentation.test.ts#L50)의 직접 open 50/70/107/131/141/148/177/197/204/238행. 19행 실제 bin 경로와 118행 자식 실행 |
| documents 기억 CLI/HTTP | [document-personal-memory-presentation.test.ts:18](../../runtime/src/tests/document-personal-memory-presentation.test.ts#L18)의 bin 경로, 27행 공용 실행과 75/78행 별도 init, 직접 open 86/107/125행 |
| 초안 공용 fixture/worker | [personal-memory-draft-flow helper:23](../../runtime/src/tests/helpers/personal-memory-draft-flow.ts#L23)의 최초 open·34행 reopen, [apply-worker:8](../../runtime/src/tests/helpers/personal-memory-draft-apply-worker.ts#L8), [draft-flow 시험:97](../../runtime/src/tests/personal-memory-draft-flow.test.ts#L97)의 97/112행 추가 profile. SIGKILL 시험은 같은 registry를 자식과 재개에 유지해야 한다. |
| 초안 CLI/HTTP | [personal-memory-draft-cli.test.ts:12](../../runtime/src/tests/personal-memory-draft-cli.test.ts#L12)의 bin/15행 실행. [memory-draft-web.test.ts:27](../../runtime/src/tests/memory-draft-web.test.ts#L27)의 최초 open·45행 reopen |
| 이관 실제 입구·activation | [migration-flow:27](../../runtime/src/tests/personal-memory-migration-flow.test.ts#L27)의 최초 open·48/102/104/141/146/182행 open/reopen/clone/거절 경로와 23행 bin 경로. [activation-barrier:32](../../runtime/src/tests/personal-memory-migration-activation-barrier.test.ts#L32)의 32/73행 open |

기존 포트를 그대로 사용하면 된다: `openAgentStores(..., undefined, {identityRegistryDirectory})`, `openAgentLocalProfile(..., options, undefined, {identityRegistryDirectory})`. 등록표는 같은 fixture의 담당/엔진 밖 임시 폴더 하나로 유지하고, 이동·clone·자식 재개도 그 경로를 전달한다. 별도 HOME 변경이나 제품의 환경변수 override는 필요 없다.

CLI는 [기존 isolated launcher](../../runtime/src/tests/helpers/agent-cli-isolated-worker.ts)와 시험 전용 `SECUMON_TEST_IDENTITY_REGISTRY`를 재사용한다. 작업 명령은 현재의 `work` prefix, 초기화는 `init`, 관리 이관은 `memory-migrate` prefix를 유지한다. C02에서 연결한 `runAgentCli → runLocalCli → openAgentLocalProfile` trusted 옵션을 재사용한다. 일반 worker는 같은 임시 경로를 직접 host 옵션으로 전달해야 하며, CLI용 환경변수만 넣는 것으로 직접 open이 바뀌지는 않는다.

## 재사용할 실행 argv

작업 디렉터리는 `/Users/seunghanee/Documents/secumon/runtime`이다. 소스 수정이 있으면 root가 최종 build를 먼저 확정하고, 아래 파일 선택과 실제 Node 경로·argv·전후 source/build 지문·종료코드·원로그를 저장한다. 로그 이름은 기존 기록을 덮어쓰지 않는 새 이름을 선택한다. `npm test`는 build와 전체 시험을 포함하므로 이 단계의 좁은 선택 명령으로 쓰지 않는다.

```sh
C03_NODE='/Users/seunghanee/Documents/secumon/runtime/.tools/node-v24.20.0-darwin-arm64/bin/node'

# 첫 묶음의 선택 기록. session39727이 진행 중이므로 이 줄을 다시 실행하지 않는다.
"$C03_NODE" --test --test-concurrency=2 --test-timeout=60000 --test-reporter=tap \
  dist/tests/sqlite-personal-knowledge.test.js dist/tests/personal-knowledge-service.test.js

# 첫 묶음 종료 후 문서 정본·현재성. recovery-regressions는 통과한 target2에 있으므로 제외한다.
"$C03_NODE" --test --test-concurrency=2 --test-timeout=60000 --test-reporter=tap \
  dist/tests/personal-memory-revision-status.test.js dist/tests/document-profile.test.js \
  dist/tests/document-knowledge-storage.test.js dist/tests/document-knowledge-boundaries.test.js

# 아래 세 묶음은 위 임시 registry 연결과 필요한 build가 끝난 뒤에만 사용한다.
"$C03_NODE" --test --test-concurrency=2 --test-timeout=60000 --test-reporter=tap \
  dist/tests/personal-memory-context.test.js dist/tests/agent-document-memory.test.js \
  dist/tests/agent-memory-profile-concurrency.test.js dist/tests/personal-memory-presentation.test.js \
  dist/tests/document-personal-memory-presentation.test.js

"$C03_NODE" --test --test-concurrency=2 --test-timeout=60000 --test-reporter=tap \
  dist/tests/personal-memory-drafts.test.js dist/tests/personal-memory-draft-flow.test.js \
  dist/tests/personal-memory-draft-recovery.test.js dist/tests/personal-memory-draft-cli.test.js dist/tests/memory-draft-web.test.js

# sqlite-personal-memory-migration은 통과한 target2에 있으므로 제외한다.
"$C03_NODE" --test --test-concurrency=2 --test-timeout=60000 --test-reporter=tap \
  dist/tests/document-knowledge-import.test.js \
  dist/tests/personal-memory-backup.test.js dist/tests/personal-memory-migration-activation-barrier.test.js \
  dist/tests/personal-memory-migration-flow.test.js
```

이 블록은 후속 선택안이다. target2는 위 root 종료 보고로 구분하고 target1의 최종 결과는 이 메모에서 확인하지 않았다. 시험 수는 source의 선언 개수로 추정하지 않고 각 실제 종료 summary로 기록한다.

## checkpoint366 prepare/apply/status의 실제 공백

현재 `src/tests`에서 `prepareAgentSqliteRecovery`, `applyAgentSqliteRecovery`, `readAgentSqliteRecovery`, `runSqliteRecoveryWorker`, 세 `sqlite-recovery-*` 명령 호출을 검색했지만 직접 시험은 없었다. [기존 owner 시험](../../runtime/src/tests/agent-database-owner.test.ts)과 [worker의 hot-rollback](../../runtime/src/tests/helpers/agent-database-owner-worker.ts)은 실제 미커밋 spill·SIGKILL·원 main/journal 보존·읽기 전용 거절을 재사용할 출발점이다. 그 시험 마지막의 직접 SQLite writable recovery는 새 관리 coordinator의 검증이 아니다.

이 공백의 인수는 [V03-R01~08](C03-sqlite-recovery-implementation.md)의 범위 안에서 유지한다. 즉 별도 임시 담당의 state/memory/channel 원 main+journal → 명시 prepare의 보존본/후보 → 같은 operation/preparedDigest apply → status의 과거 receipt와 현재 DB 구분이 필요하다. foreign/schema/문서 fence·지원하지 않는 sidecar 거절, pending의 일반 open 차단, 단계 중단·같은 ID 재개와 worker 종료 미관측도 해당 목록의 미확인으로 남긴다. 이번 준비에서 새 시험을 작성하지 않았다. Root는 별도 담당자가 정상 경로 시험을 작성 중이라고 알렸으며, 아직 저장·실행 결과는 확인하지 않았다.

기존 관리 입구의 실제 argv는 [사용법](../../runtime/examples/sqlite-recovery.md)과 같다. 후속 임시 fixture에서 isolated launcher로 `lifecycle sqlite-recovery-prepare --directory <fixture> --operation <UUID> --kind state|memory|channel --offline --json`, 같은 UUID의 `sqlite-recovery-apply --digest <preparedDigest> --offline --json`, `sqlite-recovery-status --json`를 사용한다. 모두 같은 시험 registry를 쓰고 각 prefix/공통 directory/operation 인자를 유지한다. 운영 경로나 현재 사용자 자료로 대체하지 않는다.

PostgreSQL은 현재 구현 문서의 별도 실제 DB 적합성 검증으로, native Windows는 해당 플랫폼 실행으로 남긴다. 이번 macOS 파일 선정이나 과거 NAS 통과로 둘을 통과 처리하지 않는다. 모델/API 중단도 유지한다.
