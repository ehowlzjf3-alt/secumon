# C01 — 호스트의 담당 ID 등록 계획

2026-09-08 · 다음 구현 준비, 제품 미착수·시험 미실행

전체 담당 폴더를 복사해 같은 `agentId`가 두 디렉터리에서 실행되는 경우를 한 호스트 등록 범위에서 차단한다. [기존 C01 계획](C01-workspace-plan.md)과 [clone 계획](C01-clone-plan.md)의 남은 실행 소유권 연결이다. 현재 [프로필 검사](../../runtime/src/infrastructure/file-agent-profile.ts)는 폴더 내부 identity/config/접수 표식만 대조하고, [runtime lease](../../runtime/src/infrastructure/agent-lifecycle-lease.ts)는 각 담당 폴더 내부에 있으므로 전체 복사본을 서로 비교하지 못한다.

## 등록 위치와 의미

기본 위치는 실행 계정의 `homedir()/.secumon/host-identities`로 한다. 시작 프로그램이 선택하며 담당 config·모델 입력·요청별 CLI 옵션으로 바꾸지 않는다. 호스트 구성/시험에는 명시 `registryDirectory`를 주입할 수 있지만 모든 일반 입구가 같은 등록 인스턴스 또는 같은 물리 경로를 사용해야 한다. 담당·엔진 디렉터리와 양방향 중첩을 거절하고 현재 OS 사용자의 private 파일 경계를 적용한다. 담당 clone/backup에는 이 등록표를 포함하지 않는다.

등록은 `agentId`별로 identity의 `createdAt`, 실제 root의 `{volume, object}`, 등록 시 canonical 경로와 이전 기록 지문을 고정한다. 경로는 진단용이며 동일성 판단은 [MetadataDirectory.identity / sameFileIdentity](../../runtime/src/infrastructure/host-metadata-files.ts)를 사용한다. rename 때 mtime/ctime이 달라질 수 있으므로 changeToken을 영구 ID로 쓰지 않는다. 삭제 뒤 파일 ID 재사용까지 완전하게 감지하는 보장은 현재 helper에 없으며, 신뢰된 호스트 관리·정상 이동 범위의 식별로 한정한다.

| 상황 | 동작 |
| --- | --- |
| 기존 미등록 담당의 첫 실행 | 기존 ready/identity 검사를 통과한 현재 객체를 최초 claim한다. 내용의 안전한 인수나 과거 DB의 새로운 소유 허가는 아니며 기존 저장소 owner 검사도 계속 수행한다. 최초 등록 이전의 복사본 중 어느 것이 원본인지는 판별할 수 없다. |
| 같은 객체 재호출·같은 volume 내 rename | 새 경로에서 현재 객체를 다시 확인해 등록 identity와 같으면 허용한다. 열린 기존 참조를 새 경로 참조인 것처럼 재사용하지 않는다. |
| 전체 copy·다른 객체의 같은 ID | 기존 경로가 없어도 자동 이동으로 간주하지 않고 거절한다. 일반 open은 등록을 덮어쓰거나 새 ID를 발급하지 않는다. |
| 명시 clone | 기존 clone의 새 ID·빈 기록 정책을 유지하고 새 ID로 별도 claim한다. |
| 다른 호스트·다른 등록표 | 전역 중복 감지는 제공하지 않는다. 동일 호스트의 별도 OS 계정도 등록표를 공유하지 않으면 별개 범위다. 등록표 삭제/교체는 호스트 관리 권한이며 자동 복구로 정당화하지 않는다. |

## 최초 claim과 연결 순서

신규 작은 infrastructure registry가 `claim(profile)`, 현재 등록 확인, 관리용 `rebind`를 담당한다. [openAgentStores](../../runtime/src/infrastructure/agent-stores.ts)의 ready 검사 다음, runtime lease와 DB bind/open **이전**에 claim을 넣는다. 파일 metadata 참조와 등록 지문을 확보하고 저장소 개설 뒤 반환 전에도 다시 대조한다. 실패 시 기존 store close 순서를 사용하고, 성공한 최초 claim을 임의 삭제하지 않는다. 프로필 inspect/status는 읽기만 수행한다.

물리 형식은 ID별 private 디렉터리의 유한 불변 기록 `00000001.json`부터 시작한다. [HostFileMutationScope.publish](../../runtime/src/infrastructure/host-file-mutations.ts)의 no-replace 게시를 최초 CAS로 사용한다. 두 프로세스가 동시에 최초 claim하면 한 기록만 게시되고, 나머지는 **실제로 게시된 기록**을 다시 읽어 같은 ID/객체이면 합류하고 다른 객체이면 거절한다. 사전 `exists` 검사나 프로세스 내부 Map을 선점 증명으로 쓰지 않는다. rebind도 이전 head 지문·다음 sequence의 no-replace 게시로 경합을 처리한다. 기록당 64KiB·ID당 1,024세대 상한을 두며 손상·순서 공백·unknown 게시·미확정 cleanup은 보존하고 거절한다. 현재 파일 helper의 읽기/동기화/close를 재사용하며 새 DB·잠금 프로토콜·native API를 만들지 않는다. POSIX namespace fsync와 Windows process-crash / `directorySynced:false`는 구분한다.

## C10 복원 후 명시 rebind

새 객체로 복원된 같은 ID는 정상 open에서 계속 거절되어야 한다. [C10 원경로 복원](../../runtime/src/infrastructure/agent-lifecycle.ts)이 원 backup digest·전체 파일 지문·담당 ID·원 canonical 경로를 검증한 결과만 별도 관리용 rebind의 근거로 받는다. PostgreSQL 결합 복원도 기존 완료 증명을 사용한다. 임의 경로/원문이나 `force` 옵션은 근거가 아니다.

rebind는 호스트가 기존 실행을 정지한 상태에서 현재 등록 head 지문, 같은 복원 operation/backup, 새 디렉터리 identity를 고정한다. 살아 있는 실행 또는 종료 여부가 불명인 기존 lease는 거절한다. 기존 객체가 다른 위치에서 계속 실행되지 않는다는 offline 확인은 호스트 책임이며 파일 검색으로 추정하지 않는다. 이전 등록은 남기고 새 세대만 게시한다. 중단 후 같은 operation·같은 새 객체는 재대조해 재사용하고, 다른 backup/객체/이전 head는 충돌로 처리한다. 등록만 바꾸고 업무를 실행하거나 과거 자료를 현재 근거로 채택하지 않는다. 원격/다른 경로의 임의 이동 기능은 추가하지 않는다.

## 가장 작은 구현·검증 범위

신규 registry와 일반 store-open 연결, 신뢰된 호스트 구성의 주입, C10 검증 완료 결과를 받는 명시 rebind 입구만 구현한다. 기존 프로필·clone·lease·파일 identity/helper를 재사용한다. 회귀는 실제 임시 registry를 두 담당 밖에 주입해 같은 객체 재호출/rename, 등록 후 전체 copy, 미등록 동시 최초 claim, clone 새 ID, 손상 기록, 복원 새 객체의 일반 open 거절과 명시 rebind/재시도를 확인한다. 기존 lifecycle/agent-store 시험을 확장하며 외부 연결 없이 수행할 수 있다.

호스트 전체 OS sandbox는 이번 범위가 아니다. 원 C01 계획의 제공된 저장 포트·경로·owner 경계를 유지하며 동일 OS 계정의 임의 셸/네이티브 코드까지 차단한다고 표시하지 않는다. 현재는 이 문서만 작성했고 제품·기존 시험·Windows ABI/소비자는 변경하거나 실행하지 않았다.
