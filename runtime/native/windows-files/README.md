# Windows native file boundary

This Node-API addon now has retained directory objects used by the runtime Windows metadata and mutation adapters. It is not a complete `FileAgentProfileStore` or a general file tool. The adapter code is connected to host dispatch; native Windows build/load and execution remain unverified. The runtime host now explicitly selects process-crash durability for opted-in profile/document consumers; strict namespace requests still reject before mutation.

The crate uses locked `windows-sys`, `napi`, `napi-derive`, `napi-build`, and `uuid` dependencies. No handwritten Win32 or Node-API ABI declarations are used.

## Interface

```js
const result = addon.publishSetupFile(
  'C:\\authorized-parent', 'private-child', 'identity.json',
  Buffer.from('{"agentId":"example"}'), 'process-crash',
);
const inspection = addon.inspectSetupFile('C:\\authorized-parent', 'private-child', 'identity.json');
```

The trusted host supplies the already authorized parent and two leaf names. These original setup exports remain available. `setupCapabilities().hostFilesApiVersion === 3` identifies the new native interface. The legacy `runtimeDispatchConnected: false` setup field is retained: loading the addon alone does not establish runtime composition. The addon does not interpret agent IDs or authorize model/tool callers; the TS mutation scope supplies root/forbidden-root checks.

`strict-namespace` returns `namespace_durability_unsupported` before resolving paths or creating directories. Only an explicit `process-crash` request can reach Win32. The result always reports `namespaceBarrier: 'unsupported'`; no directory flush is silently reported as successful. Process-crash behavior is an implementation target, not yet a verified guarantee on this checkout.

`publication` is `not_attempted`, `not_published`, `created`, `already_exists`, or `unknown`. Always inspect `ok`, `code`, `phase`, and the independent `fileFlush`/`cleanup` fields. A post-publication failure preserves `created`; it does not pretend the operation never ran. An ambiguous rename failure returns `unknown` and leaves the handle without delete disposition. `already_exists` means an existing private regular file was checked, not that its bytes match the requested bytes. The caller must compare the existing metadata and ownership semantics.

`fileFlush` describes this call's candidate; an existing target was not flushed by a conflicting call. `cleanupWin32Error` preserves a disposition failure and `closeWin32Error` separately preserves candidate-close failure. Explicit close makes one attempt and does not silently retry the raw handle from `Drop`. Ancestor handles are released with RAII; failure-path lifetime still requires native Windows tests.

## Implemented Windows path

- Accept a bounded drive-absolute parent, not UNC, device paths, streams, reserved names, or path traversal. Legacy small-file calls allow 4 MiB; ABI3 streams allow up to 1 GiB with chunks up to 1 MiB.
- Resolve the drive into a local NTFS volume GUID; hold each existing parent directory handle without write/delete sharing. Reparse points and SUBST-like non-root drive resolutions are refused. The full sharing/ancestor behavior requires real Windows race tests.
- Create the private child and candidate with a protected DACL granting only the current effective token SID full access. Reuse only objects matching this deliberately narrow policy. Writable SQLite preparation may convert an already validated, same-user private directory to equivalent inheritable private access. Read-only inspection never changes its ACL. Non-private ACLs are not repaired.
- Validate owner/DACL through `GetSecurityInfo`, regular/directory kind, reparse status, file identity, and single-link files through handles.
- Write the exclusive candidate, call `FlushFileBuffers`, then use `SetFileInformationByHandle(FileRenameInfo)` with `ReplaceIfExists=false` and the retained target directory handle.
- On a definite pre-publication failure or name conflict, remove only the held candidate using `FileDispositionInfo`. After successful or ambiguous rename, never apply delete disposition to that handle.
- Reopen the published target and compare bytes/identity. `inspectSetupFile` performs a bounded read with metadata/ACL checks before and after. New private directories are not rolled back on later failure; orphan candidates are not discovered or automatically adopted.

The private ACL permits exactly one current-user full-access allow ACE. Safe object/container inheritance and inherited flags are accepted; inherit-only and other ACE flags are rejected. Newly created private objects use a protected same-user inheritable DACL so SQLite sidecars inherit private access. This is intentionally narrower than a general enterprise ACL policy. Administrators with special privileges and unrestricted code running as the same user are outside the claimed isolation boundary.

## ABI3 storage consumers

Retained directory references now expose `openReadRegular` (info/read/close), `createCandidate` (append/prepare/publish/close), `database` (path/check/close), `removeRegular` (exact expected bytes), and `lockRegular` (exclusive delete-on-close file). Stream prepare flushes before the no-replace publication step. Publication and cleanup failures retain their known or unknown outcome. SQLite guards retain the main file without delete sharing through the actual SQLite connection; canonical paths and current sidecar checks are host concerns, not model input.

The Windows journal retains its default 64 MiB record limit. Artifact, workspace, SQLite, and lifecycle consumers are being connected to these interfaces. The implementation checkpoint and its deferred native tests are recorded in [the runtime design](../../../design/chapters/C01-windows-consumers-implementation.md). Existing ABI2 test expectations must be reviewed during that verification phase. A target cargo check does not link a Windows DLL or run these APIs.

## Build and checks

Keep cache and outputs inside this package. On macOS/Linux:

```sh
CARGO_HOME="$PWD/.cargo-home" CARGO_TARGET_DIR="$PWD/target" cargo test --lib --locked
CARGO_HOME="$PWD/.cargo-home" CARGO_TARGET_DIR="$PWD/target" cargo build --locked
```

For a macOS addon preflight test, copy the produced `target/debug/libsecumon_windows_files.dylib` to `evidence/secumon_windows_files.node`, then run the supported Node binary:

```sh
node tests/nonwindows-addon.mjs evidence/secumon_windows_files.node
```

This verifies actual Node-API loading and non-Windows/policy/input refusal only. It does not execute Win32.

On native Windows with the MSVC Rust target, Windows build tools and a compatible Node installation, build this package, copy `target/debug/secumon_windows_files.dll` to `evidence/secumon_windows_files.node`, and run:

```powershell
node tests/windows-addon.mjs evidence/secumon_windows_files.node
```

The Windows test fails immediately on another OS. Even a successful smoke result leaves the listed ACL/race/process-kill/durability cases unverified. A smoke result does not establish full runtime Windows support or permit weakening the default namespace policy.

## Retained host interface

`openDirectory(path, privateAccess)` returns a `DirectoryReference` or `null` for a missing path. Its synchronous methods are `check()`, `names(maximum)`, `inspectChild(leaf, privateAccess)`, `readRegular(leaf, maximum)`, `childDirectory(leaf, create, exclusive, durability)`, `publish(leaf, bytes, durability)` and `close()`. Directory identity and canonical volume path come from the held object. A child retains shared ancestor handles even if its parent reference is closed. Explicit `close()` returns native close errors; GC remains a fallback for unclosed references. `fileMetrics()` reports per-thread native boundary counters; directory-sync counts remain zero; native directory enumeration increments the list/entry counters.

Runtime source adapters are `src/infrastructure/windows-metadata-files.ts` and `windows-file-mutations.ts`. On Windows the trusted host must build and install a compatible addon at `native/windows-files/secumon_windows_files.node`, or explicitly pass an absolute addon path to `new WindowsMetadataFiles(path)`. This change does not generate or install that binary. No environment variable or model argument selects it; non-Windows dispatch cannot masquerade as Windows.

```ts
// Trusted host setup; source imports are not a package export promise.
const files = new WindowsMetadataFiles();
const mutations = new WindowsFileMutations({ files, durability: 'process-crash' });
const scope = mutations.openScope({
  root: 'C:\\agents\\example', forbiddenRoots: ['C:\\engine'],
});
try {
  const directory = scope.directory('C:\\agents\\example', 'private', true);
  if (!directory) throw new Error('directory_missing');
  const result = scope.publish(directory, 'identity.json', Buffer.from('{}'));
  // Inspect result.published/fileSynced; directorySynced is always false.
} finally { scope.close(); }
```

`hostFileMutations()` explicitly selects the Windows `process-crash` host policy. Profile/document consumers use `completeMetadataPublication`, which returns `directorySynced: false`. Direct construction with the default or explicit `strict-namespace` policy still refuses mutation, and raw `syncDirectory()` always rejects. POSIX keeps namespace fsync. Metadata reads accept at most 4 MiB, require the exact private ACL even for `owner-writable`, and reject every hard-linked file instead of invoking a POSIX sibling allowlist. Executable-bit publication is unsupported.

The current implementation and remaining consumer boundaries are recorded in [C01 Windows runtime implementation](../../../design/chapters/C01-windows-runtime-implementation.md). The latest profile/document connection is documented in [C01 Windows profile implementation](../../../design/chapters/C01-windows-profile-implementation.md). Historical evidence is preserved; ABI 2 has its single target compile check in `evidence/profile-implementation-cargo-check.json`. It proves target compilation, not DLL linking, Windows execution or durability.

## Remaining acceptance work

Native Windows build/load; actual ACL rejection from a second ordinary account; protected/inherited/foreign ACL cases; sharing violations; junction and concurrent replacement tests; candidate/rename/close error injection; process termination and same-operation reconciliation; handle closure under failures; ARM64 packaging if required. File and namespace power-loss durability remain separate. The TS mutation scope now checks its trusted root and forbidden roots. Full consumer migration, application recovery semantics and native acceptance remain prerequisites for deployed agent support.
