# SQLite 개인 기억을 문서로 옮기는 방법

2026-09-07 D3 구현 기준 사용 가이드다. 같은 소스의 Linux NAS 합성 검증은 전체 3,038/3,038로 종료했다. 아래 예시 명령을 실제 사용자 저장소에 실행한 것은 아니다. 실제 사용자의 저장소에 적용한 결과도 아니다. 검증 상태는 [D3 결과](C03-personal-memory-migration-result.md)에서 확인한다.

`memory-migrate`는 **기존 담당의 SQLite 개인 기억 전체를 문서 저장소로 옮기는 오프라인 관리 명령**이다. 같은 담당 ID와 기억 ID, 사용자별 구분을 유지한다. 새 담당의 저장 방식을 고르는 `init --personal-memory documents`와 용도가 다르다.

## 대상 경로와 준비

설치된 `secumon-agent`와 지원 Node 24 환경을 전제로 한다. 아래 예시는 Linux/macOS 셸용이며, `<...>`는 실제 값으로 바꿀 자리다. 그대로 실행하는 명령이 아니다.

| 값 | 의미와 실제 위치 |
| --- | --- |
| `agent_dir` | 이관할 기존 담당 폴더의 절대 경로 |
| 원본 `source` | 반드시 `$agent_dir/memory/memory.sqlite` |
| 대상 `target` | 반드시 `$agent_dir/memory/documents`; 아직 없어야 함 |
| `migration_id` | 이번 이관을 식별하는 UUID. 중단·재개에도 같은 값 유지 |
| `target_store_id` | 새 문서 저장소의 UUID. 담당 ID와 별개이며 이관 도중 변경 금지 |
| `backup_dir` | 담당 폴더와 엔진 설치 폴더 밖의 새 백업 폴더. 이들 폴더의 상위 경로도 불가 |

백업 폴더의 부모는 이미 존재하고 접근 가능해야 한다. 대상 백업 폴더 자체는 미리 만들지 않는다. 명령이 소유자 전용 폴더로 만든다. 링크 경로나 소유자가 다른 저장소를 대상으로 삼지 않는다.

```sh
agent_dir='<기존 담당 폴더의 절대 경로>'
migration_id='<이번 이관용 UUID>'
target_store_id='<새 문서 저장소용 UUID>'
backup_dir='<담당·엔진 밖의 아직 없는 백업 폴더 절대 경로>'
```

## 1. preview — 범위와 용량 확인

```sh
secumon-agent memory-migrate preview \
  --directory "$agent_dir" \
  --from sqlite --source "$agent_dir/memory/memory.sqlite" \
  --to documents --target "$agent_dir/memory/documents" \
  --operation-id "$migration_id" --target-store-id "$target_store_id" \
  --backup-directory "$backup_dir" --scope all-personal --json
```

출력의 `snapshot.snapshotDigest`와 경로, `capacity`의 기억·영수증 개수를 확인한다. `snapshotDigest`는 그때 관측한 개인 기억 묶음을 구별하는 지문이다. 아래 변수에는 **그 출력의 실제 64자리 값**을 넣는다.

```sh
snapshot_digest='<preview 출력의 snapshot.snapshotDigest>'
```

`preview`는 이관 작업 기록·문서 대상·백업을 만들지 않는다. 다만 SQLite 조회 과정에서 `memory.sqlite-wal`, `memory.sqlite-shm` 같은 **접근 조율용 보조 파일이 생길 수 있다**. CLI 도움말의 “파일을 생성하지 않습니다”를 파일시스템 변경이 전혀 없다는 뜻으로 해석하면 안 된다. 보조 파일을 수동 삭제하지 않는다.

`all-personal`은 이 담당에 속한 모든 조직·사용자 범위의 개인 기억을 뜻한다. 특정 사용자나 기억만 고르는 옵션은 없다. 업무 근거 기억은 이관 대상에서 제외한다. 지원하지 않는 원본 형식, 손상, 용량 초과는 생략하거나 잘라 옮기지 않고 거절한다.

## 2. apply — 확인한 원본을 백업하고 전환

먼저 이 담당을 사용하는 CLI/Web/상주 프로세스와 이전 엔진 프로세스를 모두 멈추고, 진행하던 외부 작업의 결과를 대조한다. 그 뒤 아래 두 확인 옵션을 사용한다. **옵션은 운영자의 확인 기록이며 프로세스를 자동으로 종료하거나 외부 작업을 검증하지 않는다.**

```sh
secumon-agent memory-migrate apply \
  --directory "$agent_dir" \
  --from sqlite --source "$agent_dir/memory/memory.sqlite" \
  --to documents --target "$agent_dir/memory/documents" \
  --operation-id "$migration_id" --target-store-id "$target_store_id" \
  --backup-directory "$backup_dir" --scope all-personal \
  --snapshot-digest "$snapshot_digest" \
  --offline-confirmed --effects-reconciled --json
```

`preview`와 같은 경로·ID·범위를 사용한다. 원본이 달라졌으면 전환을 거절한다. 이관 기록을 아직 만들지 않은 상태라면 변경된 원본으로 `preview`를 다시 확인할 수 있다. 이미 시작한 이관은 아래 `status`와 같은 ID의 `resume`으로 다룬다.

내부 순서는 초기 설정 보존 → SQLite 백업 검증 → 원본 개인 기억 사용 제한(`fence`) → 문서 초기 기록과 영수증 검증 → 문서 활성화(`activation`)다. 문서 파일이 생겼다는 사실만으로 전환 완료는 아니다. 최종 출력이 `phase: "activated"`이고 `effectivePersonalMemory.backend: "documents"`인지 확인한다.

## 3. status / resume — 상태 확인과 중단 재개

```sh
secumon-agent memory-migrate status --directory "$agent_dir" --json

secumon-agent memory-migrate status \
  --directory "$agent_dir" --operation-id "$migration_id" --json

secumon-agent memory-migrate resume \
  --directory "$agent_dir" --operation-id "$migration_id" --json
```

`status`는 작업 ID 없이도 조회할 수 있다. `resume`에는 처음의 작업 ID가 필수이며, 원본·대상·백업 경로 등은 저장된 이관 기록에서 가져온다. 따라서 `resume`에 `--source`, `--target`이나 apply용 확인 옵션을 다시 붙이지 않는다.

| `phase` | 뜻과 다음 행동 |
| --- | --- |
| `not_started` | 이관 기록 없음. 새 `preview`부터 시작할 수 있음 |
| `preparing` | 이관 기록은 있고 원본 제한 전. 담당의 일반 실행을 재개하지 말고 같은 ID로 `resume` |
| `fenced` | 원본 개인 기억 사용이 제한됨. 같은 ID로 `resume`; SQLite 자동 복귀나 취소 없음 |
| `activated` | 검증된 문서 저장소가 현재 개인 기억의 정본으로 선택됨 |

중간 종료나 오류가 나도 새 작업 ID로 우회하거나 남은 파일을 지우지 않는다. `resume`은 이미 게시한 동일 기록과 백업을 검증하여 이어간다. 안전성·손상 오류나 백업 후보 한도 초과까지 무조건 복구하는 명령은 아니다. 실패 기록과 저장소를 보존한 채 원인을 확인한다. 이미 활성화된 작업의 `resume`은 현재 상태를 반환한다.

## 전환 후 무엇이 달라지나

- `config.json`과 초기 SQLite 배정 기록은 그대로 남는다. 이는 **처음 설정**이다. 현재 사용하는 방식은 `status`의 **`effectivePersonalMemory`**로 확인한다. `secumon-agent status --directory "$agent_dir" --json`에서도 구분해서 볼 수 있다. 설정 파일을 문서 방식으로 수동 수정하지 않는다.
- 개인 기억은 `memory/documents`가 정본이다. 초기 이관 기록 뒤로 새 기억·정정·잊기 기록이 이어진다. 편집은 기존 문서 초안의 내보내기·적용 흐름을 사용하며 정본 파일을 직접 덮어쓰지 않는다.
- `memory/memory.sqlite`는 업무 근거 기억을 계속 저장하고, 이관 전 개인 기억도 보존한다. **전환 후에도 원 DB를 삭제하면 안 된다.** 문서 오류나 소실 때 SQLite로 자동 복귀하지 않는다.
- 백업은 `$backup_dir/backup.sqlite`와 검증 기록에, 초기 설정 사본은 `$agent_dir/.secumon/migration-source-profile`에 남는다. 대화·작업 상태·첨부 자료·외부 시스템 전체를 복원하는 백업은 아니다.
- 대화 원문, 세션 요약, 작업 상태와 담당 ID는 이관으로 변경하지 않는다. 기억의 최신 본문·저장된 명령 영수증·감사 기록·색인 상태를 보존하지만, 원 SQL에 없는 과거 본문을 만들지는 않는다.

## 현재 지원 한계

첫 지원 범위는 로컬 POSIX 파일시스템의 기존 C01 담당이 소유한 SQLite → 문서 이관이다. native Windows, 원격 공유 파일시스템, PostgreSQL, 공유 DB 이관, 역이관, 제한 후 취소는 지원하지 않는다. 실제 Windows 실행 검증도 완료되지 않았다.

전체 memory DB 상한은 256MiB, 백업 worker의 제한 시간은 60초, 백업 후보는 최대 4개다. 기억 하나의 최신 내용과 모든 영수증을 합친 초기 기록은 256KiB 이하여야 하며, 사용자 범위별 기록 수·총량 한도도 적용한다. 작은 DB라도 특정 기억의 영수증이 너무 많으면 `preview`에서 거절될 수 있다. 현재 개인 기억 서비스의 영수증·감사 형식 및 색인 정합성을 벗어난 자료는 자동 보정하지 않는다.

`잊기`는 현재 기억의 사용을 중지하는 동작이다. 이관 전 SQL·백업·대화 원문·과거 문서 기록의 물리적 삭제를 뜻하지 않는다. 살아 있는 SQLite main 파일만 따로 복사하거나, 이관 제한·활성화 파일을 수동 삭제하여 복구하는 방식도 이 명령의 지원 절차가 아니다.

## 근거와 후속 안내 개선

옵션은 [실제 CLI](../../runtime/src/presentation/memory-migration-cli.ts), 동작은 [이관 서비스](../../runtime/src/infrastructure/personal-memory-migration.ts)와 [현재 저장 방식 선택](../../runtime/src/infrastructure/personal-memory-migration-profile.ts)을 기준으로 작성했다. [전체 계획](C03-personal-memory-migration-plan.md) · [완료 조건 검토](C03-remaining-acceptance-review.md).

C06 후속: 현재 main help의 명령 목록에는 `memory-migrate`가 있으나 첫 `사용법` synopsis에는 빠져 있다. 이관 명령 발견성과 `preview`의 보조 파일 설명을 도움말에서 일치시킬 필요가 있다. 이 문서 작업에서는 CLI를 변경하지 않았다.
