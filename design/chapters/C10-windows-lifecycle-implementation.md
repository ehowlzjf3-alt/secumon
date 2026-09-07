# C10 Windows 설치·백업 파일 소비자 구현

2026-09-08 구현 기록이다. 이번 변경은 기존 lifecycle의 Windows 파일 입구를 ABI3 native handle 경계에 연결한다. Windows에서의 실제 설치·백업·DB 복원이나 강제 종료 시험을 통과했다는 결과 문서는 아니다. 통합 빌드와 플랫폼 검증 결과는 root의 별도 기록을 따른다.

## 구현된 경로

- [agent-lifecycle-files.ts](../../runtime/src/infrastructure/agent-lifecycle-files.ts)의 root·겹침 검사, 목록·존재 확인, 디렉터리 생성, tree capture/copy가 Windows에서는 [windows-lifecycle-files.ts](../../runtime/src/infrastructure/windows-lifecycle-files.ts)를 사용한다. POSIX 소비자는 기존 파일 접근·fsync 동작을 유지한다. 새 `copyLifecycleFile`은 PG 복원에서도 같은 복사 경계를 제공한다.
- [streams.rs](../../runtime/native/windows-files/src/windows/streams.rs)는 부모·조상 디렉터리 handle을 유지하는 읽기와 새 candidate 쓰기를 제공한다. 읽기는 매 chunk 전후의 파일 identity·크기·변경 token·ACL을 확인하고 write/delete 공유를 허용하지 않는다. 쓰기는 `append → prepare → publish`이며 `prepare` 뒤 추가 쓰기를 거절한다. `prepare`는 파일 flush와 현재성 확인을 수행하고, `publish`는 기존 파일을 교체하지 않는 rename을 사용한다.
- [agent-engine-release.ts](../../runtime/src/infrastructure/agent-engine-release.ts)는 Windows package 원문을 bounded native 읽기로 소비하고 native 목록으로 pin 이력을 읽는다. bundle/install은 원본 tree의 실제 digest를 보존한다. Windows 파일의 `executable`은 `false`로 기록한다. POSIX 실행 비트를 만들어내지 않으며 다른 플랫폼의 `executable:true` 자료를 조용히 변환하지 않는다.
- [agent-lifecycle.ts](../../runtime/src/infrastructure/agent-lifecycle.ts)의 일반 backup/restore와 [agent-postgres-backup.ts](../../runtime/src/infrastructure/agent-postgres-backup.ts)의 local 파일 복원은 같은 stream 경계를 쓴다. Windows에서는 복원 marker 원문이 예상 byte와 같음을 native `removeRegular`로 확인한 뒤 제거한다. pin의 SQLite 버전 읽기는 기존 `openHostSqliteDatabase`로 guard를 유지한다. PG import/export·외부 DB fence 자체는 기존 구현을 재사용한다.
- 큰 release/backup manifest는 기존 32MiB 한도를 유지하도록 root의 [windows-stream-files.ts](../../runtime/src/infrastructure/windows-stream-files.ts)를 사용한다. 작은 profile metadata와 저장 schema를 별도로 만들지 않는다.

## 보존하는 한도와 권한

파일 하나 1GiB, 전체 tree 4GiB, 항목 100,000개, 한 chunk 1MiB를 적용한다. native 목록은 한 디렉터리 65,536개, native 경로는 조상 64개 이내다. 자료 파일과 디렉터리는 현재 사용자 private ACL·일반 파일·단일 link 경계를 통과해야 한다. reparse/ADS/예약 이름은 native 검사에 맡기며 tree에 Windows 대소문자 또는 정규화 충돌이 있으면 거절한다. 파일 전체를 하나의 Buffer에 넣어 복사하지 않는다. JSON manifest만 기존 문서 크기 상한 안에서 전체 parse한다.

복사 전후 source의 이름·identity·원문 hash를 다시 확인한다. destination은 새 파일만 게시하며 existing target을 성공으로 덮어쓰지 않는다. PG 같은-operation 재개에서 이미 존재하는 정상 target은 현재 archive entry와 완전히 같은지 읽어 확인한 경우에만 재사용한다. 새 DB·도구 호출·모델 실행을 파일 복원 중 시작하지 않는다.

## 내구성과 오류 의미

Windows 선택은 명시적인 `process-crash` 정책이다. 파일 `FlushFileBuffers` 완료와 부모 handle 현재성 확인을 수행하지만 directory fsync 또는 전원 장애 시 namespace 내구성을 주장하지 않는다. POSIX `namespace-fsync` 정책과 성공 의미를 합치지 않는다.

candidate 이름은 기존 native와 같은 `.secumon-init-<uuid>.pending`이다. 확실히 게시되지 않은 자기 candidate는 닫을 때 제거한다. rename 결과가 불명확하면 candidate나 게시된 원문을 임의로 지우지 않고 publication 상태·원 오류를 보존한다. TypeScript 소비자는 원 작업 오류와 close 오류를 함께 전달한다. native stream의 단일 Fault 반환으로 드문 복수 ancestor close 실패의 세부 목록이 제한될 수 있으며, 일반 소비자는 부모 scope를 마지막까지 유지해 실제 마지막 close 결과를 별도로 수집한다.

## 남은 실제 검증과 운영 제한

이번 담당 작업에서는 테스트·빌드·Windows 실행·SSH·DB 연결을 수행하지 않았다. ABI3 wrapper와 다른 Windows DB/lease/journal 소비자는 각 소유자의 동시 구현이며, 통합 타입 결과나 플랫폼 실행 결과를 이 문서로 대체하지 않는다.

실제 Windows의 큰 파일 설치, ACL/reparse/동시 교체, 모든 handle close 오류, 파일 flush·rename·marker 제거 경계의 프로세스 강제 종료 시험은 남아 있다. 알 수 없는 게시 또는 프로세스 종료로 남은 native pending을 일반 lifecycle이 임의로 자동 삭제하는 복구 기능은 추가하지 않았다. 불완전 설치·백업은 최종 manifest 없이 정상 자료가 되지 않으며, 복원 중 남은 marker나 예상 외 pending은 명시적인 확인이 필요하다. 같은-operation PG 복원은 검증된 정식 target을 재사용할 수 있지만 임의 pending 청소까지 완료한 것으로 볼 수 없다.

공유 자료 및 직접 migration DB 입구 등 다른 Windows 소비자의 남은 연결은 별도 구현 범위다. C10 전체 완료·Windows native 운영 지원 완료·과거 backup 이후의 잊기/철회 자동 증명을 선언하지 않는다.
