# C01 — 호스트의 담당 ID 등록 구현

2026-09-08 · 제품 코드 작성·동결, 통합 빌드 2차 exit 0·상세 회귀 미실행

[등록 계획](C01-host-identity-registration-plan.md)에 따라 담당 폴더 밖의 호스트 등록표를 구현했다. 같은 등록표에서 이미 등록된 `agentId`와 `createdAt`을 다른 디렉터리 객체가 사용하면 일반 claim을 거절한다. 경로 문자열은 기록·진단에 쓰고, 담당 디렉터리의 동일성은 기존 파일 경계가 반환하는 volume/object로 판단한다. 같은 객체를 이름 변경한 뒤 새 경로로 여는 경우는 기존 등록을 유지할 수 있다. 이미 열린 claim의 경로가 바뀌면 그 claim의 현재성 검사는 실패하므로 새 경로에서 다시 열어야 한다.

## 구현과 연결

신규 [계약](../../runtime/src/application/agent-host-identity-contracts.ts)과 [등록 helper](../../runtime/src/infrastructure/agent-host-identities.ts)가 다음 API를 제공한다.

| API | 동작 |
| --- | --- |
| `agentHostIdentityRegistryDirectory(options?)` | 기본 또는 호스트 지정 경로를 정규화해 반환한다. 파일 조회·생성은 하지 않는다. |
| `claimAgentHostIdentity(subject, options)` | 실제 identity 파일과 root 객체를 확인하고 최초 등록 또는 기존 등록 일치를 검사한다. 반환한 claim은 `assertCurrent()`와 멱등 `close()`를 가진다. |
| `inspectAgentHostIdentity(subject, options)` | 등록표를 생성하거나 변경하지 않고 기존 head와 지문을 반환한다. 미등록이면 `null`이다. 복사·복원된 다른 root 객체도 같은 identity의 등록 지문을 조회할 수 있다. |
| `rebindAgentHostIdentity(subject, options, withVerifiedRestore)` | 검증된 복원·maintenance 범위 안에서만 다음 불변 등록을 게시한다. 기존 기록을 덮어쓰지 않는다. |

`subject`는 `{root, identity}`, `options`는 선택 `registryDirectory`와 필수 `engineDirectories`다. 기본 등록표는 실행 계정의 `~/.secumon/host-identities`이며 호스트 시작 코드에서만 바꾼다. 등록표·담당·엔진 사이의 양방향 중첩을 거절한다. 엔진 경로는 디렉터리 현재성 확인에만 사용하며 내용을 복사하지 않는다.

[일반 저장소 개설](../../runtime/src/infrastructure/agent-stores.ts)은 ready 프로필 확인 뒤, lease와 저장소 개설 전에 claim을 연결하고 반환 전 현재성을 재검사한다. 호스트 주입은 [실행 호스트](../../runtime/src/presentation/host-tools.ts)와 [일반 프로필](../../runtime/src/presentation/agent-turn-profile.ts)에 연결돼 있다. [관리 CLI](../../runtime/src/presentation/agent-lifecycle-cli.ts)의 `identity-status`는 무쓰기 inspect를 사용한다. 이 연결부와 아래 복원 어댑터는 루트 및 별도 담당이 구현했으며 이 문서에서는 저장된 호출 관계만 확인했다.

## 기록·현재성·복원

ID별 private 디렉터리에 `00000001.json`부터 최대 1,024개의 기록을 둔다. 각 기록은 64KiB 이하이며 identity, root volume/object, 등록 경로, 이전 기록의 SHA-256, 최초 claim 또는 명시 복원 사유를 담는다. 실제 게시된 원문 바이트의 지문을 head로 사용한다. 기존 [파일 변경 helper](../../runtime/src/infrastructure/host-file-mutations.ts)의 no-replace 게시가 최초 claim과 다음 sequence의 CAS를 담당한다. 같은 객체의 경쟁자는 실제 게시 결과를 읽어 합류할 수 있고 다른 객체는 거절된다. 게시 중인 `.pending`이나 손상·순서 공백·현재성 불일치는 자동 삭제·채택하지 않고 오류로 남긴다. 따라서 게시가 아직 진행 중인 경쟁 호출은 재호출이 필요할 수 있다.

claim은 실제 root·metadata·engine 참조와 `identity.json`의 파일 객체, 등록 기록의 파일 객체 및 원문 지문을 유지한다. `assertCurrent()`는 이를 다시 읽어 대조한다. 일반 open은 다른 객체를 이동으로 추정하거나 등록을 자동 덮어쓰지 않는다. 실패 cleanup도 기존 참조를 닫으며 원 오류와 종료 오류를 함께 보존한다.

rebind에는 단순 복원 DTO만 전달하지 않는다. 호출자가 검증·maintenance 권한을 유지한 callback 안에서 제공받은 `publish(proof, assertProofCurrent)`를 한 번 호출하고 완료까지 기다린다. proof는 operation ID, 원 backup 지문, 원 경로, 예상 등록 head 지문이며 실제 검증은 [C10 복원 어댑터](../../runtime/src/infrastructure/agent-host-identity-recovery.ts)가 수행한다. helper는 게시 전후 callback의 현재성을 확인하고 원 경로·예상 head·새 root 객체를 고정한다. callback 종료 뒤의 늦은 게시나 중복 publisher 호출은 거절한다. 동일 복원 operation이 이미 같은 객체에 게시됐으면 재대조해 같은 head를 반환할 수 있다. 게시 뒤 검증 오류가 나면 불변 기록은 남고 오류가 반환되므로, 일반 open의 강제 덮어쓰기로 처리하지 않고 동일 복원 증명으로 재확인해야 한다.

## 구현 범위와 검증 상태

POSIX와 Windows 모두 기존 [metadata 경계](../../runtime/src/infrastructure/host-metadata-files.ts)를 재사용한다. Windows는 native 디렉터리 참조·파일 검사를 유지하고 process-crash 내구성 결과를 명시적으로 처리한다. 이를 directory namespace 동기화 성공으로 바꾸지 않는다. 새 DB, native API, 전역 락 또는 실행 루프는 추가하지 않았다.

최초 등록 이전의 여러 동일 복사본 중 원본을 판별하거나, 다른 호스트·별도 OS 계정·다른 등록표의 중복을 탐지하지 않는다. 삭제 뒤 object ID 재사용까지 방지하는 보장과 동일 OS 계정의 임의 코드에 대한 전체 sandbox도 제공하지 않는다. clone은 기존 새 ID 정책을 유지한다. 검증된 복원 이후 새 객체의 인수는 명시 rebind 경로로만 진행한다.

이번 작업에서는 신규 계약·helper와 직접 연결 API를 정적으로 대조했다. 루트의 첫 통합 빌드(session 75234)는 exit 2였으며, 게시 결과 `selected`가 undefined일 수 있다는 TypeScript 오류 두 건이 발생했다. 루트가 기존 실패 guard를 `return fail('claim_conflict')`로 바꾸어 제어 흐름의 타입 축소를 명시했다. 이 교정 후 두 번째 통합 빌드(session 38580)는 실제 exit 0으로 종료됐다고 루트가 확인했다. 원로그와 source/build 지문은 루트의 checkpoint 365 기록에 포함한다.

상세 시험, 실제 등록표 claim·복원 실행, 동시 최초 claim·rename·복사 거절·복원 재시도 회귀와 실제 Windows 실행은 수행하지 않았다. 후속 상세 회귀는 별도 V10–17 검증 항목으로 남긴다. 코드 작성이나 타입 검사만으로 플랫폼 검증 또는 C01 전체 완료를 선언하지 않는다.
