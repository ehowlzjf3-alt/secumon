# C10 복원 회복 패키지 적용 사용법

최종 정리: 추출한 시험 fixture의 마지막 빈 줄만 제거하고 build4를 생성했다. 2,487개 컴파일 파일의 전체 지문이 시험한 build3과 정확히 같아 시험을 반복하지 않았다. 실행한60개 시험은 build3 기록이며 최종 소스·동일 바이너리 대조는 checkpoint392-final-source.json에 구분해 저장했다.

2026-09-08 · checkpoint392. 준비 패키지를 원 담당에 적용하고 원본 보존·복원·신원 재등록을 연결했다. 최종 build3의 대상14개·회귀43개와 실제 SIGKILL3개, 고유60개를 로컬에서 확인했다. 실제 외부 시스템·다른 OS·설치 binary 검증과 구분한다. [결과와 한계](C10-restore-recovery-apply-result.md).

이 명령은 선택한 전체 백업으로 담당 자료를 교체한다. 현재 담당 디렉터리를 별도 위치에 보존하며 두 이력을 자동 병합하지 않는다. 생성 시각으로 “더 최신이니 옳다”고 판단하지 않는다. 선택 백업과 현재 자료의 차이를 [준비 단계](C10-restore-recovery-usage.md)에서 확인한 뒤 적용한다.

## 적용 조건과 명령

담당 실행기, 구형 엔진과 직접 DB 접근을 중지한 상태에서 실행한다. `--offline`은 이 조건을 명시하며 다른 프로그램을 자동으로 종료하는 옵션은 아니다. 같은 호스트 신원 등록 경로를 사용하고 준비 패키지의 원문과 지문을 유지해야 한다.

플랫폼에 맞는 네이티브 디렉터리 이동 모듈이 해당 엔진의 `native/windows-files/secumon_windows_files.node`에 있어야 한다. 경로 이름은 기존 패키지 배치를 따르며 macOS/Linux에서도 호스트에 맞게 빌드한 바이너리를 사용한다. 로더는 코드 다운로드·자동 컴파일을 하지 않는다. 호환 모듈이 없으면 담당에 적용 표식을 쓰기 전에 거절한다. 빌드·배치 방법은 [네이티브 모듈 문서](../../runtime/native/windows-files/README.md)를 따른다.

먼저 준비 패키지를 검사한다.

```sh
secumon-agent lifecycle restore-recovery-status --source "<준비 패키지 절대경로>" --json
```

출력의 `digest`가 이번 적용에 사용할 준비 SHA256이다. `selectedBackupDigest`와 다르다. 원본 보존 위치와 적용 대상은 검증한 준비 명세에서 결정하므로 적용 명령에서 임의의 대상 경로를 다시 받지 않는다.

```sh
secumon-agent lifecycle restore-recovery-apply --source "<준비 패키지 절대경로>" --digest "<준비 패키지 SHA256>" --offline --json
```

실행은 준비 패키지와 현재 원자료·신원을 대조하고 현재 담당을 같은 부모의 새 경로로 보존 이동한다. 목적지를 덮어쓰지 않는 네이티브 이동을 사용한 뒤 원경로에 선택 백업을 복원하고 신원을 재등록한다. 기존 대조 영수증을 새 복원의 실행 허가로 복사하지 않는다.

| 결과 필드 | 의미 |
| --- | --- |
| `operationId` | 준비에서 이어받은 적용 작업 UUID |
| `agentId`, `root` | 같은 담당의 ID와 복원된 원경로 |
| `retiredDirectory` | 실제 원 담당 디렉터리를 보존한 경로 |
| `operationDirectory` | 적용 intent·부분 복원 기록·완료 영수증의 위치 |
| `restorationId` | 이번에 실제 복원한 디렉터리의 고유 번호. 적용 작업 UUID와 다름 |
| `identityHeadDigest` | 신원 재등록 뒤 현재 등록 이력의 지문 |
| `stage: "restored"` | 선택 백업 복원과 신원 재등록이 끝났다는 적용 결과 |
| `reconciliationRequired: true` | 새 복원의 외부 기록 대조를 별도로 수행해야 한다는 뜻 |

적용은 도구 입력을 재전송하거나 메시지를 보내지 않는다. 원 업무·목표 완료나 자원 정산을 만들어내는 호출도 아니다.

## 보존되는 경로

```text
<담당의 부모>/
  <원 담당 이름>/                         선택 백업에서 복원한 담당
  .secumon-retired-<operationId>/         이동해 보존한 이전 담당
  .secumon-partial-<operationId>-<nonce>/ 일부 복원 중단 시 보존하는 경로

<준비 패키지>/                           준비 원문과 명세 유지
<준비 패키지>.apply/                    별도 적용 기록과 관리 lease
```

보존 폴더에는 원 담당의 실제 디렉터리 객체와 자료가 남는다. 적용 중 표식도 남아 일반 실행을 막는다. 준비 패키지의 `preserved/` 복사본과 실제 이동한 원 담당은 서로 다른 보존물이다. `.apply/`의 기록을 준비 패키지 안으로 옮기면 원 패키지의 전체 파일 검사가 달라지므로 구조를 임의로 바꾸지 않는다.

모든 경로는 소유자가 관리하는 비공개 위치여야 한다. 담당·준비 패키지·보존 경로·호스트 등록표·엔진이 겹치면 거절한다. 이미 있는 관계없는 보존 폴더나 적용 폴더를 현재 작업으로 자동 채택하거나 덮어쓰지 않는다.

## 상태 조회와 같은 적용 재시도

```sh
secumon-agent lifecycle restore-recovery-apply-status --source "<준비 패키지 절대경로>" --json
```

| `stage` | 읽는 방법 |
| --- | --- |
| `not_started` | 해당 패키지의 적용 폴더가 없다. |
| `incomplete` | 적용 폴더는 있지만 원 intent가 없다. 자동으로 완성된 적용으로 채택하지 않는다. |
| `applying` | 원 intent가 있으며 완료 영수증은 아직 없다. |
| `restored` | 복원·신원 재등록을 마친 적용 영수증이 있다. |

이 상태는 저장된 진행 이력이다. `currentStateVerified: false`는 현재 담당 원문이나 외부 시스템을 지금 검증한 결과가 아니라는 뜻이다. 완료 영수증이 있다고 해서 지금 외부 대조까지 완료됐다는 뜻은 아니다.

중단됐다면 같은 패키지·준비 지문으로 `restore-recovery-apply`를 다시 호출한다. 이미 보존 이동한 원 객체, 복원 완료 표식과 동일한 rebind를 확인해 완료 단계를 반복하지 않는다. 완료 재호출은 현재 root 객체와 신원 head가 원 완료 영수증에 맞는지 확인하며 자료를 다시 교체하지 않는다.

POSIX에서 파일 복사 일부가 끝난 뒤 중단되면 원 pending의 nonce를 확인해 부분 디렉터리를 별도로 보존하고 비어 있는 원경로에 새 복원을 시작한다. 새 복원에는 새 번호가 붙는다. 복원이 이미 완료됐다면 그 번호를 유지한다. Windows 경로는 기존 원 pending·백업의 정확한 재개 기능을 사용하지만 native Windows runtime 검증은 남아 있다.

기록된 작업의 재개에서는 확인 가능한 죽은 로컬 소유 lease를 정리한다. 살아 있는 소유자나 다른 호스트의 lease를 빼앗지 않는다. intent가 없거나, 부분 root의 원 nonce가 없거나, 원자료·신원·패키지가 달라 복원 근거를 재구성할 수 없으면 보존한 채 거절한다. 표식을 삭제하거나 무관한 폴더를 현재 복원이라고 채택해 진행하지 않는다. 가장 초기 intent·복원 표식 이전 중단의 추가 회복은 후속 범위다.

## 새 외부 대조와 업무 재개

적용 뒤 일반 실행은 새 외부 대조를 요구한다. 등록된 호스트의 읽기 전용 소스로 [복원 대조 사용법](C10-restore-reconciliation-usage.md)을 따른다.

```sh
secumon-agent lifecycle restore-status --directory "<복원된 담당 절대경로>" --json
node "<대조 소스를 등록한 호스트 시작 프로그램>.mjs" lifecycle restore-reconcile --directory "<복원된 담당 절대경로>" --offline --json
```

원 시도와 외부 실행·송신·위임·자원 기록이 이번 복원본과 일치해야 한다. `unresolved`라면 미확인 원자료와 차단을 유지한다. `reconciled`를 확인한 뒤 원 업무를 기존 일반 입구에서 재개한다. 이후 실행은 현재 권한·근거·완료 기준을 기존 런타임에서 다시 검사한다.

적용 영수증의 `reconciliationRequired: true`는 적용 당시의 후속 요구를 담은 역사 필드다. 대조가 나중에 완료돼도 적용 영수증을 수정하지 않으며 현재 대조 상태는 `restore-status`로 구분해 읽는다.

현재 검증은 macOS의 실제 네이티브 이동·부모 디렉터리 fsync, 프로세스 SIGKILL 재개, 로컬 파일 효과와 합성 모델의 흐름이다. 실제 Linux/native Windows·PostgreSQL·정전·실제 LLM·사내 서비스·설치 binary 검증은 아니다. 이력 병합과 없어진 원자료의 추정 복구도 제공하지 않는다. [최종 결과와 미실행 범위](C10-restore-recovery-apply-result.md).
