# C01 — Windows profile·document consumer 연결 구현

2026-09-08. 앞선 [Windows boundary 구현](C01-windows-runtime-implementation.md)에 이어, 정상 setup·inspect·clone과 document owner/게시 경로가 Windows의 지원 가능한 내구성 정책을 명시적으로 사용하도록 연결했다. **제품 코드 구현 단계이며 실제 Windows 실행 인수는 미실행이다.** 이 문서가 앞선 단위의 “기본 strict 거절 및 profile/doc 미연결” 현재 상태를 대체한다. 기존 증거와 당시 결과는 그대로 보존한다.

## 내구성 선택과 반환

[hostFileDurabilityPolicy](../../runtime/src/infrastructure/host-metadata-files.ts)는 실제 Windows에서 `process-crash`, Linux/macOS에서 `namespace-fsync`를 선택한다. [hostFileMutations](../../runtime/src/infrastructure/host-file-mutations.ts)는 이 호스트 선택을 Windows adapter에 전달한다. 모델·사용자 도구 인자가 내구성 정책을 변경하지 않는다.

profile의 `syncProfileDirectory`와 document의 `DocumentFiles.sync`는 `completeMetadataPublication` 결과를 반환한다. Windows에서는 현재 보유 참조를 확인하고 `{durability:'process-crash', directorySynced:false}`를 반환한다. POSIX에서는 기존 실제 directory fsync/observer를 수행하고 `directorySynced:true`를 반환한다. Windows의 파일 Flush와 비대체 rename 게시 결과는 그대로 별도 보존한다. 파일 Flush가 directory sync가 된 것처럼 표시되지 않는다.

엄격한 namespace barrier를 요구하는 원 `WindowsMetadataFiles.syncDirectory()`와 명시 `new WindowsFileMutations({durability:'strict-namespace'})`는 계속 거절한다. 따라서 이 정책을 채택하지 않은 journal/artifact 등 다른 consumer의 요구를 조용히 낮추지 않는다. process-crash는 호스트가 선택한 지원 정책이며 실제 종료·전원 손실 시험으로 증명한 보장은 아니다.

## 실제 파일 접근 경로

[native ABI 2](../../runtime/native/windows-files/src/lib.rs)에 `DirectoryReference.names(maximum)`와 `inspectChild(leaf, privateAccess)`를 추가했다. 이름 열거는 보유한 디렉터리 핸들에 `GetFileInformationByHandleEx`를 적용하며 재시작/다음 페이지를 구분한다. 구조 크기·다음 offset·UTF-16 이름 길이·총 항목 수를 제한하고 전후 directory token을 비교한다. 파일 metadata도 native 핸들에서 읽고 reparse, 파일 종류, 링크 수, 원 identity 및 private ACL을 검사한다. 본문은 기존 native `readRegular`로 읽는다. [Microsoft의 함수 계약](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex).

`FILE_BASIC_INFO.ChangeTime`을 변경 토큰에 추가했다. 반환된 토큰은 Windows metadata 관측값이며 POSIX uid/mode를 합성하지 않는다. native source가 보유한 조상/디렉터리 핸들은 기존 원 volume GUID·SID·owner/DACL 검사를 유지한다. 변경 후 Node로 본문을 다시 열어 native 검증을 대신하는 경로는 추가하지 않았다.

## 연결한 consumer

- [agent-profile-files](../../runtime/src/infrastructure/agent-profile-files.ts): Windows read는 Node lstat를 선행 근거로 사용하지 않고 native missing/ACL/read 결과를 처리한다. scope가 없는 metadata 참조는 finally에서 명시적으로 닫는다. 공통 helper의 POSIX stat·hard-link 허용 조건과 fsync는 유지한다.
- [file-agent-profile](../../runtime/src/infrastructure/file-agent-profile.ts): Windows root/engine의 canonical 경계, 존재 확인, metadata 이름 열거, clone pending 검사를 [Windows profile helper](../../runtime/src/infrastructure/windows-profile-files.ts)로 연결했다. initialize/repair/inspect/clone의 기존 원문·receipt·operation 순서는 유지한다. PostgreSQL 선택/이전 판정은 이 변경의 대상이 아니다.
- [agent-clone-files](../../runtime/src/infrastructure/agent-clone-files.ts): 기존 세 public 함수에만 Windows 분기를 추가했다. [Windows clone helper](../../runtime/src/infrastructure/windows-clone-files.ts)는 native private ACL을 충족하는 일반 JSON/MD 등 regular file을 해시·크기·전후 token과 대조하고, 실제 바이트를 게시한다. 항목 512, 파일 4 MiB, 총 32 MiB, 깊이 16과 별도 orphan allowance를 유지한다. 실행 비트는 추론하지 않으며 executable=true인 manifest를 명시적으로 거절한다. 모든 보유 참조는 종료 때 닫는다.
- [document-knowledge-owner](../../runtime/src/infrastructure/document-knowledge-owner.ts): native 이름 목록·metadata token·원문 읽기를 사용하고 `durability`를 노출한다. owner/format/import manifest 검증을 그대로 사용하며 close 시 scope를 닫는다. [일반 document 저장](../../runtime/src/infrastructure/document-knowledge.ts)과 [import](../../runtime/src/infrastructure/document-knowledge-import.ts)의 barrier 호출도 `DocumentFiles.sync`로 연결했다. 원 descriptor, record, receipt, witness 및 CAS의 저장 형식을 바꾸지 않았다.

private는 기존 native의 보호 DACL + 현재 effective SID 단일 allow ACE라는 좁은 정책이다. 기존 파일의 ACL을 chmod처럼 자동 재작성하지 않는다. 일반 사용자 폴더의 inherited/다중 ACE ACL이 이 정책을 충족하지 않으면 거절하며, 모든 hard link 및 reparse도 거절한다. clone의 “일반 파일” 지원은 파일 형식에 관한 것으로 임의 ACL을 허용한다는 의미가 아니다. 공개된 일반 root에 비공개 파일을 안전하다고 간주하지 않는다.

## 확인과 남은 경계

이번 새 native source에 대해 기존 로컬 sysroot/cache로 `cargo check --target x86_64-pc-windows-msvc --locked --offline`을 한 번 실행했고 exit 0이었다. [원 로그](../../runtime/native/windows-files/evidence/profile-implementation-cargo-check.log)와 [명령·SHA·종료 기록](../../runtime/native/windows-files/evidence/profile-implementation-cargo-check.json)을 새 파일로 보존했다. TS 통합 빌드 결과는 상위 작업에서 기록한다. 새 시험·실제 Windows·외부 연결은 실행하지 않았다.

바이너리는 hostFilesApiVersion 2를 제공해야 하며 이전 ABI 1 DLL은 loader가 거절한다. 이번에 Windows DLL을 링크하거나 설치하지 않았다. 전체 profile 실행에는 실제 Windows DLL/Node 로드, ACL·공유 핸들 동작, 동시 초기화·중단 재개 인수가 남아 있다. file-journal 일반 record I/O, artifact store, workspace, 전체 lifecycle/backup/restore까지 Windows로 이관한 것은 아니다. 네임스페이스·전원 손실 durability도 미지원이다.
