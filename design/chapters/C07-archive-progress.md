# C07 아카이브 연결 구현

2026-09-08. 기능 구현 단계이며 빌드·시험·외부 호출은 이 작업에서 실행하지 않았다. profile 및 공통 정책 연결은 별도 통합 작업이다.

아카이브 등록이 없으면 `openHostArchive(undefined, context)`는 아무 저장소도 열지 않고 null을 반환한다. 호스트가 등록한 공급자의 검색·원문 조회를 모델 도구로 제공하고, 공급자가 `read_register`를 지원하면서 호스트 등록에 `allowWrites: true`를 명시했을 때만 등록·정정·삭제 도구를 함께 제공한다. 공급자의 기능 지원과 호스트의 쓰기 허가는 별개다.

## 실제 구현

- [archive-contracts.ts](../../runtime/src/application/archive-contracts.ts): 원문·path·sourceVersion·revision을 담는 문서와 strict 조회/변경 계약. 외부 공급자는 `ArchiveProvider`를 구현해 호스트 factory로 주입한다. 원문 경로는 자료 출처를 표시하는 문자열이며 모델이 실행파일이나 로컬 저장 경로를 선택하는 입력이 아니다.
- [archive-service.ts](../../runtime/src/application/archive-service.ts): 공급자 메서드/설명을 등록 시 캡처하고, 호스트 신원·라벨·destination·수명 및 응답 형식을 확인한다. 관리 API는 `service.search(actor, query)`, `get(actor, id)`, `mutate(actor, command)`다. 쓰기에는 공급자 기능과 등록 허가 외에 호출 actor의 쓰기 권한도 필요하다.
- [archive-tools.ts](../../runtime/src/application/archive-tools.ts): 기본 `archive.search/get`, 명시 허가 시 `archive.register/revise/delete`. provider id를 바꾸면 도구 접두사도 바뀐다. 검색은 제목·경로·출처버전을, get은 원문을 반환한다. 결과 크기를 제한하고 자료를 `archive_reference`로 표시한다. Evidence와 개인 기억은 만들지 않는다.
- [file-archive.ts](../../runtime/src/infrastructure/file-archive.ts): C01 root의 `archive/<owner와 provider의 해시>/`에 작은 로컬 공급자를 제공한다. 기존 `hostFileMutations`와 `hostMetadataFiles`를 재사용해 private 디렉터리, 안정된 파일 읽기, 덮어쓰지 않는 게시·sync를 수행한다. owner.json과 순차 명령 파일에 변경 내용·이전 해시·체크섬을 보존한다. 명령 내용과 결과를 같은 파일에 담아 별도 영수증 쓰기 간격을 만들지 않는다.
- [host-archive.ts](../../runtime/src/presentation/host-archive.ts): `HostArchiveRegistration`, `openHostArchive`, `createLocalArchiveRegistration`을 제공한다. 반환은 `service/tools/allowedTools/allowWrites/close`다. close는 수명을 중단하고 공급자를 한 번만 닫는다. factory는 성공 반환 전 부분 자원 정리를 소유한다.

로컬 쓰기까지 명시적으로 여는 예시는 `createLocalArchiveRegistration(undefined, {allowWrites: true})`다. 인자를 생략한 로컬 등록은 모델·관리 쓰기를 허용하지 않는다. 일반 profile은 반환된 tool ID와 쓰기 허가를 호스트 정책에 반영해야 하며, 다른 도구에 대한 허가를 무분별하게 넓히면 안 된다.

기존 Knowledge 정본은 실제 업무 Evidence 또는 사용자 원문 영수증을 필수 출처로 검증한다. 외부 문서에 이를 꾸며 붙이지 않기 위해 Knowledge 스키마·저장 엔진·개인 기억 흐름은 변경하지 않았다. 새 파일 형식은 외부 원문 자료와 명령 영수증에 필요한 부분만 담으며 Knowledge의 검토·발행·의존 관계 엔진을 복제하지 않는다.

## 명령과 불확실한 결과

모델 쓰기의 commandId는 모델 인자로 받지 않고 원 workId/attemptId에서 만든다. 공급자는 동일 commandId와 같은 내용에 원 결과를 반환하고, 다른 내용은 거절해야 한다. 로컬 공급자는 이를 파일에서 검사하며 정정·삭제에는 예상 revision을 요구한다. 서비스는 응답의 commandId·대상·revision·status와 명령 전체의 canonical SHA-256 `commandDigest`를 대조한다. 중복 명령의 반환은 **그 명령의 원 영수증**이며, 이후에 바뀐 현재 문서 상태라는 뜻은 아니다.

성공 영수증을 받은 도구는 기존 EffectState의 confirmed 결과를 반환한다. 이후 취소됐다는 이유로 확인된 쓰기를 거짓 실패로 바꾸지 않는다. 예외·응답 소실·중단은 기존 실행기의 write unknown 및 effect reconciliation 경로를 사용한다. 자동 mutation 재시도나 새 효과 원장은 추가하지 않았다. 공급자 영수증이 output에 있다는 이유만으로 재시작 뒤 외부 효과를 독립 검증한 것으로 보지 않는다. 최초 구현에는 없던 영수증 조회 복구를 아래 후속 구현에서 추가했다.

삭제는 active 조회에서 제외하는 tombstone이다. 과거 명령에 담긴 원문을 물리적으로 지우지 않는다. 로컬 읽기/쓰기 상한은 명령 4096개, 파일 512 KiB, 읽는 파일 합계 64 MiB, 경합 재시도 8회다. 전체 순차 파일을 확인하므로 큰 저장소 검색 효율을 검증한 구현은 아니다. 같은 열린 공급자에서 관측한 순번보다 뒤로 돌아가는 것은 거절하지만, 닫힌 뒤 같은 UID가 마지막 파일들을 지운 rollback을 판별하는 외부 기준은 없다. POSIX 파일 primitive를 재사용하므로 native Windows는 미지원 경계를 따른다.

후속 통합 확인은 기본 off/읽기만/명시 쓰기, 현재 권한 축소, 같은 명령과 다른 내용, 예상 revision 충돌, 늦은 성공과 unknown 중단, 재접속 검색 및 공급자 close 실패에 한정한다. 현재 문서는 이 확인들이 통과했다고 주장하지 않는다.

## 영수증 조회 복구 추가

선택적 `ArchiveProvider.receipt(commandId, signal)`과 [ArchiveReconciliation](../../runtime/src/application/archive-reconciliation.ts)을 추가했다. 로컬 공급자는 기존 명령 파일에서 원 결과와 전체 명령 digest를 읽고, 복구 중 `mutate`를 호출하지 않는다. 미지원·영수증 부재는 unknown을 유지한다. 합성 입구는 `new ArchiveReconciliation({services, execution, archive: openedArchive.service, actor})`의 `current(state)`, `refresh(workId)`, `recover(workId, attemptId)`다.

원 dispatch의 업무·시도·task·계약·owner·원문 세대와 명령 영수증 digest를 고정하고 현재 호출 권한을 다시 검사한 뒤 대조한다. 같은 executor owner의 미수신 결과는 기존 receive/adopt를 재사용하되, 원 lease·취소·채택 거절을 지우지 않는다. 재접속으로 owner가 달라졌거나 기존 unknown 결과가 이미 저장됐다면 그 결과를 덮어쓰지 않고 공급자 영수증과 동일 형식의 도구 출력을 reconciliation proof artifact에 보존한다. 다른 owner의 running 시도는 원 lease가 만료된 뒤 기존 `execution.recover`의 만료 전이를 먼저 사용한다.

효과만 confirmed로 확인하고 해당 `effect:<attemptId>` 의무를 해제한다. 기존 owner·lease·실행 사용량·취소 상태를 보존하고 `adopted`를 true로 바꾸지 않는다. 따라서 새 owner에서 원 `resultArtifact`가 없었던 경우는 부재 그대로이며 정상 결과 수신이나 작업 완료로 보고하지 않는다. 기존 proof가 손상되거나 공급자 영수증을 다시 확인할 수 없으면 그 proof를 삭제하거나 새 긍정 결과로 대체하지 않고 효과를 unknown으로 돌려 의무를 다시 남긴다.

proof는 고정 provider `archive`와 실제 공급자 ID·원 dispatch digest·명령 digest·관측시각에 묶인다. 현재성 검사는 proof 원문을 읽고 공급자 영수증을 대조한 뒤 같은 원문 bytes/SHA를 다시 확인하며 마지막 state/권한을 검사한다. 이는 공급자의 저장된 명령 주장에 대한 검증이며 외부 세계의 효과를 별도 시스템에서 독립 관측한 증거는 아니다. Board 등 다른 provider의 proof는 이 클래스가 검사하지 않는다. 빌드3에서 지적된 TypeScript nullable 분기는 `fail(): never` 함수 선언으로 교정했으며 후속 통합 빌드와 상세 fault 시험 결과는 아직 이 문서의 확인값이 아니다.

Root 통합 기록: 최초 빌드의 schema union omit/EffectState 타입을 교정했다. C07-build2는 actual exit0이며 동작 시험은 아직이다. C07-registration-result.md에 전체 연결과 잔여를 기록했다.
