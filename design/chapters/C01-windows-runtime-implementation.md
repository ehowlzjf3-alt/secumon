# C01 — Windows 파일 경계 runtime 연결 구현

2026-09-08. 기존 Rust Win32 구현을 재사용해 `HostMetadataFiles`와 `HostFileMutations`의 Windows 어댑터 코드를 연결했다. **해당 경계의 구현이며 전체 Windows runtime 지원 완료는 아니다.** 실제 Windows DLL 링크·로드·실행은 하지 않았고, namespace durability는 계속 미지원이다. `nativeWindows: 'implemented'`도 이 경계 코드의 존재만 나타낸다.

## 이번에 연결한 범위

- [native lib](../../runtime/native/windows-files/src/lib.rs)의 `openDirectory`는 불투명 `DirectoryReference`를 발행한다. `check/readRegular/childDirectory/publish/close`는 객체가 보유한 디렉터리와 조상 핸들을 사용한다. 자식 참조가 있으면 조상 핸들은 부모 참조를 닫아도 유지된다.
- [Win32 경계](../../runtime/native/windows-files/src/windows.rs)는 기존 현재 SID·보호 DACL·reparse 거절·로컬 NTFS volume GUID·파일 ID·단일 링크·원자적 비대체 rename 검사를 재사용한다. 현재 effective token도 다시 확인한다. 기존 setup export와 wire 결과는 유지했다.
- [WindowsMetadataFiles](../../runtime/src/infrastructure/windows-metadata-files.ts)는 같은 adapter가 발행한 참조만 받으며 파일 크기, 실제 바이트와 전후 metadata/ACL을 확인한다. `owner-writable`도 현재의 엄격한 private ACL로 제한한다. 모든 hard link는 거절하고 `allowLinkedFile`은 호출하지 않는다. 파일은 최대 4 MiB, sibling 열거는 제공하지 않는다.
- [WindowsFileMutations](../../runtime/src/infrastructure/windows-file-mutations.ts)는 호스트가 준 root와 forbidden roots를 현재 native canonical 경로로 대조하고, scope 내 참조만 게시에 사용한다. 닫은 scope는 재사용할 수 없다. 경로의 dot components, ADS, 장치명 및 reparse 경유를 허용하지 않는다.
- [호스트 metadata dispatch](../../runtime/src/infrastructure/host-metadata-files.ts)와 [mutation dispatch](../../runtime/src/infrastructure/host-file-mutations.ts)는 실제 `process.platform === 'win32'`에서만 Windows 구현을 선택한다. macOS/Linux를 Windows로 가장해 POSIX 검사를 통과시키지 않는다.

## 내구성과 리소스 수명

기본 `hostFileMutations()`는 `strict-namespace`이므로 Windows scope 생성 시 파일을 만들기 전에 `namespace_durability_unsupported`로 거절한다. 신뢰된 호스트가 `new WindowsFileMutations({ files, durability: 'process-crash' })`를 명시한 경우에만 제한된 게시 API를 사용할 수 있다. 이 정책도 실제 process-kill 보장까지 검증된 것은 아니다.

파일 `FlushFileBuffers`와 namespace barrier는 별개다. 게시 결과의 `fileSynced`는 해당 candidate의 실제 flush 결과이며 **`directorySynced`는 항상 false**다. `syncDirectory`는 성공을 흉내 내지 않고 거절한다. 기존 이름 충돌은 원문 일치를 의미하지 않으며 호출자가 현재 파일을 읽어 비교해야 한다. 애매한 rename은 `unknown`을 보존하고 final 파일을 삭제하지 않는다. 실행 비트 요청도 거절한다.

scope.close는 보유 참조를 닫고 명시 close 오류를 보존한다. metadata 전용 호스트는 구체 클래스의 `closeDirectory`를 사용할 수 있다. 공통 `HostMetadataFiles` 포트에는 close가 없으므로 기존 read-only consumer가 참조를 해제하는 시점은 GC에 의존한다. 중간 오류 경로의 기존 Rust RAII close는 오류를 반환하지 않는 부분이 남아 있다. 실제 Windows에서 핸들 수명·공유 모드·close 실패를 확인하는 인수는 미실행이다. 진단 카운터는 native 실행 스레드 단위이며 물리 디스크 I/O 측정값은 아니다.

## 바이너리와 호스트 사용

[loader](../../runtime/src/infrastructure/windows-file-addon.ts)는 기본적으로 `runtime/native/windows-files/secumon_windows_files.node`를 읽는다. 호스트가 절대 경로를 constructor에 명시할 수도 있다. 파일 경로를 환경변수나 모델 입력에서 받지 않는다. ABI `hostFilesApiVersion: 1`, Windows backend, 4 MiB 상한과 unsupported namespace 계약을 확인한다. 적합한 바이너리가 없으면 fail closed다. 이번 작업은 바이너리를 만들거나 설치하지 않았다.

기존 `setupCapabilities.runtimeDispatchConnected: false`는 독립 setup API의 호환 필드로 유지했다. native 라이브러리 로드 자체가 runtime 조립을 보증하지 않기 때문이다. 새 연결의 실제 경로는 위 TS dispatch와 `hostFilesApiVersion`이다. 구체 사용 예는 [native README](../../runtime/native/windows-files/README.md)에 있다.

## 남은 consumer 연결

| 기존 경로 | 현재 한계 |
| --- | --- |
| [agent-profile-files](../../runtime/src/infrastructure/agent-profile-files.ts) | metadata와 mutation 포트를 사용하지만 초기화는 strict scope 및 directory sync를 요구한다. Windows setup 전체를 process-crash 정책으로 자동 변경하지 않았다. 실행 파일 게시 의미도 미지원이다. |
| [document-knowledge-owner](../../runtime/src/infrastructure/document-knowledge-owner.ts) | 공통 mutation scope를 열므로 같은 strict namespace 거절을 유지한다. 기존 pending hard-link publication 정책을 Windows rename 정책으로 바꾸지 않았다. |
| [file-journal-state](../../runtime/src/infrastructure/file-journal-state.ts) | 일부 metadata만 포트를 쓴다. 일반 journal 본문·생성·linkSync·fsyncSync 등은 직접 Node 파일 연산이고 Windows 원자성/복구 계약으로 이관되지 않았다. |
| [file-artifacts](../../runtime/src/infrastructure/file-artifacts.ts) | 직접 O_NOFOLLOW/mode/rename/directory sync를 사용한다. 이 addon 연결로 artifact store까지 보호됐다고 보지 않는다. |
| 전체 profile/clone/lifecycle/local 저장소 | UID/mode, lock, 삭제·이동·namespace 게시와 애플리케이션 복구의 consumer별 연결이 남아 있다. PostgreSQL 연결 여부와 파일 저장 경계 지원은 별개다. |

기존 application DB·세션·기억·원문 포트를 교체하거나 자료를 이동하지 않았다. Windows의 공유 모드가 실제 consumer 동시 읽기/게시와 호환되는지도 아직 확인하지 않았다.

## 이번 확인

기존 소유 Windows sysroot/cache를 사용해 `cargo check --target x86_64-pc-windows-msvc --locked --offline`을 **한 번 실행했고 exit 0**이었다. [원 로그](../../runtime/native/windows-files/evidence/runtime-implementation-cargo-check.log)와 [명령·종료·소스 SHA](../../runtime/native/windows-files/evidence/runtime-implementation-cargo-check.json)를 새 파일로 보존했다. 기존 native 검증 증거는 수정하지 않았다.

이 확인은 Win32 대상 Rust 타입/컴파일 검사다. Windows SDK DLL 링크, Node addon 로드, ACL/동시성/프로세스 중단, 실제 Windows/NAS 및 전원 손실 시험은 하지 않았다. 상위 작업에서 TS 통합 build3의 실제 exit 0을 확인·보고했으며 원 빌드 기록은 그 작업이 보존한다. 새 상세 시험이나 기존 시험 반복은 이번 구현 범위에 넣지 않았다.
