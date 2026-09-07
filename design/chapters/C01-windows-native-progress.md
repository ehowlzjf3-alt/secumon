# C01 Windows native 선행 구현 기록

2026-09-07 · 독립 선행 구현·로컬 검사 완료, 실제 Windows 검증 미완료 · 기존 TypeScript Windows 거절/배포 설정 변경 없음

소유 범위는 `runtime/native/windows-files/`와 이 문서다. 독립 Node-API addon의 프로필 파일 생성·게시·검사 경로를 구현한다. 실제 Windows 지원 완료가 아니며 다른 소비자나 실행기 권한을 연결했다는 뜻도 아니다.

환경 확인: macOS aarch64, cargo/rustc 1.93.1, 전역 Rust target은 변경 전후 모두 `aarch64-apple-darwin` 하나다. 설치된 Rust 배포 manifest에 기록된 Windows 표준 라이브러리를 소유 폴더에만 다운로드하고 SHA-256을 대조한 뒤 별도 sysroot로 사용했다. 이를 통해 실제 `x86_64-pc-windows-msvc` 대상 Cargo 검사가 가능해졌다. Windows SDK를 사용한 최종 DLL 링크나 실제 Windows 실행은 하지 않았다. 전역 Rust/Node 설정은 변경하지 않았으며 Cargo cache/빌드/다운로드는 소유 디렉터리에 있다. [환경 기록](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/evidence/environment.json).

최소 API는 `publishSetupFile(parent, directoryLeaf, targetLeaf, bytes, durability)`, `inspectSetupFile(parent, directoryLeaf, targetLeaf)`, `setupCapabilities()`다. 호스트가 이미 사용을 허용한 부모와 단일 이름을 전달하는 실험용 경계이며 agentId 해석·프로필 setup 전체·모델 도구 등록·엔진 디렉터리 권한 발급은 포함하지 않는다. [addon 설명과 실행 방법](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/README.md).

## 구현한 실제 경로

| 위치 | 내용 |
|---|---|
| [Cargo.toml](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/Cargo.toml), Cargo.lock, build.rs | 검증된 `windows-sys` 0.61.2, `napi` 3.12.2, `napi-derive` 3.6.3, `napi-build` 2.4.1, `uuid` 1.26.0 사용. Win32/Node-API ABI를 수동 재정의하지 않는다. |
| [src/lib.rs](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/src/lib.rs) | Node-API 입력과 결과. `ok`, 게시 상태, 후보 파일 flush, 이름 barrier, 정리 상태, 첫 원인·정리·close 오류를 구분한다. 컴파일된 Windows backend와 실제 runtime 연결 여부를 별도로 표시한다. |
| [src/request.rs](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/src/request.rs) | 명시적 durability 정책, 드라이브 절대경로와 leaf 검사, UNC/device/ADS/예약 이름/상위 이동 거절, 깊이·문자·4 MiB 제한. strict 이름 내구성 요구를 파일 접근 전에 거절한다. |
| [src/windows.rs](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/src/windows.rs) | Win32 생성·권한·보유 핸들·쓰기·flush·게시·정리·안정 읽기 구현. 실제 Windows syscall 경로이며 다른 OS에서 해당 코드를 성공하는 가짜 backend로 실행하지 않는다. |
| [tests/windows-addon.mjs](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/tests/windows-addon.mjs) | 실제 Windows에서 사용할 생성/재관찰/기존 파일 보존/자기 후보 정리/hardlink 거절의 smoke 시험. 다른 OS에서는 즉시 실패한다. 아직 실행하지 않았다. |

Windows 경로는 로컬 NTFS 드라이브를 volume GUID로 바꿔 이후 작업에 사용한다. 각 부모를 write/delete 공유 없이 연 상태로 유지하고 reparse point를 거절한다. drive alias가 실제 볼륨 루트 대신 하위 디렉터리를 가리키는 경우도 거절한다. 이 공유 조건이 실제 Windows의 정상 생성과 모든 목표 경합 상황에서 요구대로 작동하는지는 아직 검증하지 않았다.

새 private 디렉터리와 후보에는 현재 effective token SID만 full access를 갖는 보호된 DACL을 생성 시점에 적용한다. DACL은 계정별 접근 규칙이다. 기존 객체는 owner와 DACL을 handle에서 확인하며 권한을 덮어써 인수하지 않는다. 현재 허용 정책은 보호된 DACL·상속 flag 없는 allow ACE 하나로 의도적으로 좁다. 일반적인 사내 ACL 정책 전체를 지원하는 구현은 아니다. 생성 시 descriptor 적용과 handle 보안 조회는 각각 [CreateDirectoryW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createdirectoryw), [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)에 근거한다.

후보를 `CREATE_NEW`와 private descriptor로 열어 제한된 bytes를 쓰고 `FlushFileBuffers`를 호출한다. 후보 handle에 `SetFileInformationByHandle(FileRenameInfo)`를 적용하면서 `ReplaceIfExists=false`, `RootDirectory=보유한 부모 handle`을 전달한다. 게시 후 다시 열어 bytes와 file identity를 비교한다. 정식 이름이 존재하면 기존 내용을 덮지 않으며, 기존 파일의 의미적 동일성은 호출자가 inspect 결과로 비교해야 한다. [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info).

게시 전 실패나 확실한 이름 충돌에서는 자기 후보 handle에만 `FileDispositionInfo`를 적용하고 닫는다. 성공한 rename이나 반환만으로 결과가 불명확한 rename 뒤에는 해당 handle을 삭제 대상으로 만들지 않는다. 후자의 handle은 이미 정식 파일을 가리킬 수 있기 때문이다. 새 private 디렉터리와 고아 후보를 자동 전체 삭제하거나 인수하지 않는다. [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).

## 결과·자원 수명에서 보존하는 구분

- `publication=created` 이후 재확인 실패는 `ok=false`와 원 cause를 돌려준다. 이미 게시한 것을 `not_published`로 되돌리지 않는다.
- 불명확한 rename은 `publication=unknown`, `cleanup=retained_ambiguous`다. 호출자가 정식 파일을 확인해야 하며, 자동 재게시·삭제를 하지 않는다.
- `already_exists`는 기존 private regular 파일 검사가 성공했다는 뜻이다. 요청 bytes와 같다는 뜻이 아니다. 이 경우 `fileFlush`는 이번 호출의 후보에 대한 결과이며 기존 대상에 대한 flush 결과가 아니다.
- 검토에서 발견한 정리 오류 덮어쓰기를 수정했다. disposition 오류는 `cleanupWin32Error`, 후보 close 오류는 `closeWin32Error`로 분리한다. 명시적 close는 한 번만 호출하고 실패 뒤 Drop으로 같은 raw handle을 다시 닫지 않는다. 게시 후 검증 실패·unknown 분기도 첫 오류를 보존하면서 명시적으로 후보를 닫는다.
- 부모 handle과 일부 조기 실패 자원은 RAII로 해제한다. 실제 Windows 실패 주입으로 전체 handle 수명을 확인하지 않았으며, 부모 Drop의 close 오류를 별도 결과로 수집하는 구현도 아니다.

`strict-namespace` 요청은 생성 전 `namespace_durability_unsupported`다. `process-crash` 정책으로 성공했더라도 `namespaceBarrier=unsupported`가 남는다. Windows 파일 flush가 일반적인 부모 디렉터리 fsync와 같다고 표현하지 않는다. 파일 buffer flush와 관리자 권한을 요구하는 볼륨 flush의 범위는 [FlushFileBuffers 공식 문서](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)를 기준으로 구분했다. 실제 프로세스 종료/재개도 아직 시험하지 않았으므로 `process-crash`는 구현 대상 정책 이름이지 이 기록에서 입증한 보장이 아니다.

## 수행한 검사

아래 결과는 **Windows 대상 컴파일 검사와 macOS 실행 결과**다. Windows 실행 결과가 아니다. [최종 검증과 파일별 해시](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/evidence/verification.json).

| 검사 | 실제 결과 | 증거 |
|---|---|---|
| `cargo fmt --check` | exit 0 | [로그](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/evidence/final-format.log) |
| `cargo test --lib --locked` | 입력·정책 4개 통과, 제외 0 | [로그](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/evidence/final-unit-test.log) |
| macOS `cargo build --locked` | Node-API addon 빌드 exit 0 | [로그](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/evidence/final-macos-build.log) |
| 별도 Windows sysroot의 `cargo check --target x86_64-pc-windows-msvc --locked` | 실제 target 검사 exit 0. Windows DLL 링크·실행은 하지 않음 | [로그](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/evidence/final-windows-target-check.log) |
| Node 24.20.0의 addon 로드·사전 거절 | macOS 실제 addon을 로드해 capability/strict/미지원 OS/크기/탈출/inspect 거절 6개 확인 | [결과](/Users/seunghanee/Documents/secumon/runtime/native/windows-files/evidence/final-macos-addon-preflight.json) |

최종 소스 식별값은 `b4cc087386b89a8dcfafe55328afe8a973cd87981a58acb0be6c56f921c98a99`다. 범위는 Cargo 파일·build.rs·Rust source·독립 mjs 시험 8개이며 기존 runtime 전체의 식별값이 아니다. 초기의 macOS source-check용 feature는 실제 Windows target 검사가 가능해진 뒤 제거했다. 첫 addon 명령은 잘못된 `.tools` 위치 때문에 exit 127로 실행되지 않았고, 실제 `runtime/.tools`의 Node를 사용해 다시 확인했다. 그 실패 로그와 중간 결과는 보존하고 최종 결과와 구분했다.

## 다음 인수 조건

Windows 장비 또는 CI에서 DLL 빌드/Node 로드와 위 smoke부터 실행해야 한다. 이어 다른 일반 계정의 읽기·쓰기 차단, owner/상속 ACL 변조, junction/조상 교체, 공유 위반, 후보 write/flush/rename/close 실패, 게시 경계의 실제 process kill과 재관찰을 확인한다. 정상 경로·오류 경로에서 남는 handle과 orphan도 확인한다. 이 결과를 모으기 전에는 `nativeWindows: implemented`로 기존 런타임 거절을 해제하지 않는다.

후속 TS 연결에는 호스트가 발급한 root/engine 범위와 프로필 operation/agentId 복구 의미가 필요하다. 이 독립 addon을 범용 파일 도구로 공개하는 것으로 대신할 수 없다. C02의 세션/context 작업은 지원되는 POSIX 환경에서 진행할 수 있으며, 이 native 선행 작업의 실제 Windows 검증 대기로 차단하지 않는다.
