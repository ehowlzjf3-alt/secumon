#![deny(unsafe_op_in_unsafe_fn)]

// Host adapters retain these native objects; no path or handle is accepted from model input.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

mod request;
mod directory_retirement;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod posix_retirement;
#[cfg(windows)]
mod windows;

pub(crate) const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct Fault {
    pub code: &'static str,
    pub phase: &'static str,
    pub win32: Option<u32>,
}
impl Fault {
    pub fn new(code: &'static str, phase: &'static str) -> Self {
        Self {
            code,
            phase,
            win32: None,
        }
    }
}

#[napi(object)]
pub struct SetupPublication {
    pub ok: bool,
    pub publication: String,
    pub file_flush: String,
    pub namespace_barrier: String,
    pub cleanup: String,
    pub code: Option<String>,
    pub phase: String,
    pub win32_error: Option<u32>,
    pub cleanup_win32_error: Option<u32>,
    pub close_win32_error: Option<u32>,
    pub candidate_name: Option<String>,
    pub file_identity: Option<String>,
}
impl SetupPublication {
    pub(crate) fn empty() -> Self {
        Self {
            ok: false,
            publication: "not_attempted".into(),
            file_flush: "not_attempted".into(),
            namespace_barrier: "unsupported".into(),
            cleanup: "not_needed".into(),
            code: None,
            phase: "preflight".into(),
            win32_error: None,
            cleanup_win32_error: None,
            close_win32_error: None,
            candidate_name: None,
            file_identity: None,
        }
    }
    pub(crate) fn fail(&mut self, fault: Fault) {
        self.ok = false;
        self.code = Some(fault.code.into());
        self.phase = fault.phase.into();
        self.win32_error = fault.win32;
    }
}

#[napi(object)]
pub struct SetupInspection {
    pub ok: bool,
    pub exists: bool,
    pub code: Option<String>,
    pub phase: String,
    pub win32_error: Option<u32>,
    pub bytes: Option<Buffer>,
    pub file_identity: Option<String>,
}
impl SetupInspection {
    pub(crate) fn failed(fault: Fault) -> Self {
        Self {
            ok: false,
            exists: false,
            code: Some(fault.code.into()),
            phase: fault.phase.into(),
            win32_error: fault.win32,
            bytes: None,
            file_identity: None,
        }
    }
}

#[napi(object)]
pub struct SetupCapabilities {
    pub platform: String,
    pub win32_backend_compiled: bool,
    pub runtime_dispatch_connected: bool,
    pub namespace_barrier: String,
    pub policy: String,
    pub maximum_bytes: u32,
    pub maximum_stream_bytes: u32,
    pub host_files_api_version: u32,
}

#[napi]
pub fn setup_capabilities() -> SetupCapabilities {
    SetupCapabilities {
        platform: std::env::consts::OS.into(),
        win32_backend_compiled: cfg!(windows),
        runtime_dispatch_connected: false,
        namespace_barrier: "unsupported".into(),
        policy: "process-crash-only; native validation required before deployment".into(),
        maximum_bytes: MAX_BYTES as u32,
        host_files_api_version: 4,
        maximum_stream_bytes: 1024 * 1024 * 1024,
    }
}

#[napi(object)]
pub struct DirectoryInfo {
    pub identity: String,
    pub path: String,
    pub private: bool,
    pub created: bool,
    pub change_token: String,
}

#[napi(object)]
pub struct PathInfo {
    pub identity: String,
    pub kind: String,
    pub bytes: String,
    pub change_token: String,
}

#[napi(object)]
#[derive(Default, Clone)]
pub struct FileMetrics {
    pub directory_checks: f64,
    pub file_stats: f64,
    pub file_opens: f64,
    pub file_closes: f64,
    pub data_reads: f64,
    pub data_bytes: f64,
    pub sibling_lists: f64,
    pub sibling_entries: f64,
    pub directory_syncs: f64,
}
thread_local! { static METRICS: std::cell::RefCell<FileMetrics> = std::cell::RefCell::new(FileMetrics::default()); }
#[cfg(windows)]
pub(crate) fn metrics(update: impl FnOnce(&mut FileMetrics)) { METRICS.with(|value| update(&mut value.borrow_mut())); }
#[napi]
pub fn file_metrics() -> FileMetrics { METRICS.with(|value| value.borrow().clone()) }
fn native_error(fault: Fault) -> napi::Error {
    napi::Error::new(napi::Status::GenericFailure, format!("windows_file:{}:{}:{}", fault.code, fault.phase, fault.win32.unwrap_or(0)))
}

/// Each reference owns its retained ancestor chain. Dropping the JS object releases its handles.
#[napi]
pub struct DirectoryReference {
    #[cfg(windows)]
    scope: Option<windows::Scope>,
}
#[napi]
impl DirectoryReference {
    #[napi]
    pub fn sync_regular(&self, leaf: String, expected: PathInfo) -> napi::Result<()> {
        request::leaf(&leaf).map_err(native_error)?;
        #[cfg(windows)]
        { self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "sync")))?.sync_regular(&leaf, &expected).map_err(native_error) }
        #[cfg(not(windows))]
        { let _ = expected; Err(native_error(Fault::new("unsupported_platform", "sync"))) }
    }
    #[napi]
    pub fn publish_existing(&self, leaf: String, target: &DirectoryReference, target_leaf: String, expected: PathInfo) -> napi::Result<SetupPublication> {
        request::leaf(&leaf).map_err(native_error)?; request::leaf(&target_leaf).map_err(native_error)?;
        #[cfg(windows)]
        { Ok(self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "publish")))?
            .publish_existing(&leaf, target.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "publish")))?, &target_leaf, &expected)) }
        #[cfg(not(windows))]
        { let _ = (target, expected); Err(native_error(Fault::new("unsupported_platform", "publish"))) }
    }
    #[napi]
    pub fn recoverable_candidate(&self, leaf: String, candidate: String, maximum: u32, expected: Option<PathInfo>, durability: String) -> napi::Result<WriteReference> {
        request::leaf(&leaf).map_err(native_error)?; request::leaf(&candidate).map_err(native_error)?; request::policy(&durability).map_err(native_error)?;
        #[cfg(windows)]
        { Ok(WriteReference { stream: Some(self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "publish")))?
            .recoverable_candidate(&leaf, &candidate, maximum as usize, expected).map_err(native_error)?) }) }
        #[cfg(not(windows))]
        { let _ = (maximum, expected); Err(native_error(Fault::new("unsupported_platform", "publish"))) }
    }
    #[napi]
    pub fn move_regular(&self, leaf: String, target: String, expected: Buffer) -> napi::Result<bool> {
        request::leaf(&leaf).map_err(native_error)?; request::leaf(&target).map_err(native_error)?;
        #[cfg(windows)]
        { self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "move")))?.move_regular(&leaf, &target, &expected).map_err(native_error) }
        #[cfg(not(windows))]
        { let _ = expected; Err(native_error(Fault::new("unsupported_platform", "move"))) }
    }
    #[napi]
    pub fn open_read_regular(&self, leaf: String, maximum: u32) -> napi::Result<ReadReference> {
        request::leaf(&leaf).map_err(native_error)?;
        #[cfg(windows)]
        { Ok(ReadReference { stream: Some(self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "read")))?
            .open_read_regular(&leaf, maximum as usize).map_err(native_error)?) }) }
        #[cfg(not(windows))]
        { let _ = maximum; Err(native_error(Fault::new("unsupported_platform", "read"))) }
    }
    #[napi]
    pub fn create_candidate(&self, leaf: String, maximum: u32, durability: String) -> napi::Result<WriteReference> {
        request::leaf(&leaf).map_err(native_error)?; request::policy(&durability).map_err(native_error)?;
        #[cfg(windows)]
        { Ok(WriteReference { stream: Some(self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "publish")))?
            .create_candidate(&leaf, maximum as usize).map_err(native_error)?) }) }
        #[cfg(not(windows))]
        { let _ = maximum; Err(native_error(Fault::new("unsupported_platform", "publish"))) }
    }
    #[napi]
    pub fn database(&self, leaf: String, create: bool) -> napi::Result<Option<DatabaseReference>> {
        request::leaf(&leaf).map_err(native_error)?;
        #[cfg(windows)]
        { self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "database")))?
            .database(&leaf, create).map(|guard| guard.map(|guard| DatabaseReference { guard: Some(guard) })).map_err(native_error) }
        #[cfg(not(windows))]
        { let _ = create; Err(native_error(Fault::new("unsupported_platform", "database"))) }
    }
    #[napi]
    pub fn remove_regular(&self, leaf: String, expected: Buffer) -> napi::Result<bool> {
        request::leaf(&leaf).map_err(native_error)?;
        #[cfg(windows)]
        { self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "remove")))?.remove_regular(&leaf, &expected).map_err(native_error) }
        #[cfg(not(windows))]
        { let _ = expected; Err(native_error(Fault::new("unsupported_platform", "remove"))) }
    }
    #[napi]
    pub fn lock_regular(&self, leaf: String) -> napi::Result<LockReference> {
        request::leaf(&leaf).map_err(native_error)?;
        #[cfg(windows)]
        { Ok(LockReference { guard: Some(self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "lock")))?
            .lock_regular(&leaf).map_err(native_error)?) }) }
        #[cfg(not(windows))]
        { Err(native_error(Fault::new("unsupported_platform", "lock"))) }
    }
    #[napi]
    pub fn check(&self) -> napi::Result<DirectoryInfo> {
        #[cfg(windows)]
        { self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "directory")))?.info().map_err(native_error) }
        #[cfg(not(windows))]
        { Err(native_error(Fault::new("unsupported_platform", "directory"))) }
    }
    #[napi]
    pub fn read_regular(&self, leaf: String, maximum: u32) -> napi::Result<Buffer> {
        request::leaf(&leaf).map_err(native_error)?;
        #[cfg(windows)]
        { self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "read")))?
            .read_bounded(&leaf, maximum as usize).map(|(bytes, _)| bytes.into()).map_err(native_error) }
        #[cfg(not(windows))]
        { let _ = maximum; Err(native_error(Fault::new("unsupported_platform", "read"))) }
    }
    #[napi]
    pub fn child_directory(&self, leaf: String, create: bool, exclusive: bool, durability: String) -> napi::Result<Option<DirectoryReference>> {
        request::leaf(&leaf).map_err(native_error)?;
        if create { request::policy(&durability).map_err(native_error)?; }
        if exclusive && !create { return Err(native_error(Fault::new("invalid_request", "directory"))); }
        #[cfg(windows)]
        { match self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "directory")))?.child_directory(&leaf, create, exclusive) {
            Ok(scope) => Ok(Some(DirectoryReference { scope: Some(scope) })),
            Err(fault) if !create && windows::missing(&fault) => Ok(None),
            Err(fault) => Err(native_error(fault)),
        } }
        #[cfg(not(windows))]
        { Err(native_error(Fault::new("unsupported_platform", "directory"))) }
    }
    #[napi]
    pub fn names(&self, maximum: u32) -> napi::Result<Vec<String>> {
        #[cfg(windows)]
        { self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "directory")))?.names(maximum as usize).map_err(native_error) }
        #[cfg(not(windows))]
        { let _ = maximum; Err(native_error(Fault::new("unsupported_platform", "directory"))) }
    }
    #[napi]
    pub fn inspect_child(&self, leaf: String, private: bool) -> napi::Result<Option<PathInfo>> {
        request::leaf(&leaf).map_err(native_error)?;
        #[cfg(windows)]
        { match self.scope.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "directory")))?.inspect_child(&leaf, private) {
            Ok(info) => Ok(Some(info)), Err(fault) if windows::missing(&fault) => Ok(None), Err(fault) => Err(native_error(fault)),
        } }
        #[cfg(not(windows))]
        { let _ = private; Err(native_error(Fault::new("unsupported_platform", "directory"))) }
    }
    #[napi]
    pub fn publish(&self, leaf: String, bytes: Buffer, durability: String) -> SetupPublication {
        let mut rejected = SetupPublication::empty();
        if let Err(fault) = request::policy(&durability) { rejected.fail(fault); return rejected; }
        #[cfg(windows)]
        { match self.scope.as_ref() {
            Some(scope) => windows::publish_held(scope, &leaf, &bytes.to_vec()),
            None => { rejected.fail(Fault::new("closed_reference", "publish")); rejected },
        } }
        #[cfg(not(windows))]
        { let _ = (leaf, bytes); rejected.fail(Fault::new("unsupported_platform", "publish")); rejected }
    }
    #[napi]
    pub fn close(&mut self) -> Vec<String> {
        #[cfg(windows)]
        { self.scope.take().map(|scope| scope.close()).unwrap_or_default() }
        #[cfg(not(windows))]
        { Vec::new() }
    }
}

#[napi]
pub struct ReadReference { #[cfg(windows)] stream: Option<windows::ReadStream> }
#[napi]
impl ReadReference {
    #[napi]
    pub fn info(&self) -> napi::Result<PathInfo> {
        #[cfg(windows)]
        { self.stream.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "read")))?.info().map_err(native_error) }
        #[cfg(not(windows))]
        { Err(native_error(Fault::new("unsupported_platform", "read"))) }
    }
    #[napi]
    pub fn read(&mut self, maximum: u32) -> napi::Result<Buffer> {
        #[cfg(windows)]
        { self.stream.as_mut().ok_or_else(|| native_error(Fault::new("closed_reference", "read")))?.read(maximum as usize).map(Buffer::from).map_err(native_error) }
        #[cfg(not(windows))]
        { let _ = maximum; Err(native_error(Fault::new("unsupported_platform", "read"))) }
    }
    #[napi]
    pub fn close(&mut self) -> napi::Result<()> {
        #[cfg(windows)]
        { self.stream.take().map(|stream| stream.close().map_err(native_error)).unwrap_or(Ok(())) }
        #[cfg(not(windows))]
        { Ok(()) }
    }
}
#[napi]
pub struct WriteReference { #[cfg(windows)] stream: Option<windows::WriteCandidate> }
#[napi]
impl WriteReference {
    #[napi]
    pub fn append(&mut self, bytes: Buffer) -> napi::Result<()> {
        #[cfg(windows)]
        { self.stream.as_mut().ok_or_else(|| native_error(Fault::new("closed_reference", "write")))?.append(&bytes).map_err(native_error) }
        #[cfg(not(windows))]
        { let _ = bytes; Err(native_error(Fault::new("unsupported_platform", "write"))) }
    }
    #[napi]
    pub fn prepare(&mut self) -> napi::Result<()> {
        #[cfg(windows)]
        { self.stream.as_mut().ok_or_else(|| native_error(Fault::new("closed_reference", "prepare")))?.prepare().map_err(native_error) }
        #[cfg(not(windows))]
        { Err(native_error(Fault::new("unsupported_platform", "prepare"))) }
    }
    #[napi]
    pub fn publish(&mut self) -> napi::Result<SetupPublication> {
        #[cfg(windows)]
        { Ok(self.stream.as_mut().ok_or_else(|| native_error(Fault::new("closed_reference", "publish")))?.publish()) }
        #[cfg(not(windows))]
        { Err(native_error(Fault::new("unsupported_platform", "publish"))) }
    }
    #[napi]
    pub fn close(&mut self) -> napi::Result<()> {
        #[cfg(windows)]
        { self.stream.take().map(|stream| stream.close().map_err(native_error)).unwrap_or(Ok(())) }
        #[cfg(not(windows))]
        { Ok(()) }
    }
}
#[napi]
pub struct DatabaseReference { #[cfg(windows)] guard: Option<windows::DatabaseGuard> }
#[napi]
impl DatabaseReference {
    #[napi]
    pub fn info(&self) -> napi::Result<PathInfo> {
        #[cfg(windows)]
        { self.guard.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "database")))?.info().map_err(native_error) }
        #[cfg(not(windows))]
        { Err(native_error(Fault::new("unsupported_platform", "database"))) }
    }
    #[napi]
    pub fn path(&self) -> napi::Result<String> {
        #[cfg(windows)]
        { self.guard.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "database")))?.path().map_err(native_error) }
        #[cfg(not(windows))]
        { Err(native_error(Fault::new("unsupported_platform", "database"))) }
    }
    #[napi]
    pub fn check(&self) -> napi::Result<()> {
        #[cfg(windows)]
        { self.guard.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "database")))?.check().map_err(native_error) }
        #[cfg(not(windows))]
        { Err(native_error(Fault::new("unsupported_platform", "database"))) }
    }
    #[napi]
    pub fn close(&mut self) -> napi::Result<()> {
        #[cfg(windows)]
        { self.guard.take().map(|guard| guard.close().map_err(native_error)).unwrap_or(Ok(())) }
        #[cfg(not(windows))]
        { Ok(()) }
    }
}
#[napi]
pub struct LockReference { #[cfg(windows)] guard: Option<windows::FileLock> }
#[napi]
impl LockReference {
    #[napi]
    pub fn check(&self) -> napi::Result<()> {
        #[cfg(windows)]
        { self.guard.as_ref().ok_or_else(|| native_error(Fault::new("closed_reference", "lock")))?.check().map_err(native_error) }
        #[cfg(not(windows))]
        { Err(native_error(Fault::new("unsupported_platform", "lock"))) }
    }
    #[napi]
    pub fn close(&mut self) -> napi::Result<()> {
        #[cfg(windows)]
        { self.guard.take().map(|guard| guard.close().map_err(native_error)).unwrap_or(Ok(())) }
        #[cfg(not(windows))]
        { Ok(()) }
    }
}
#[napi]
pub fn open_directory(path: String, private: bool) -> napi::Result<Option<DirectoryReference>> {
    request::Request::directory_path(&path).map_err(native_error)?;
    #[cfg(windows)]
    { match windows::Scope::open_directory(&path, private) {
        Ok(scope) => Ok(Some(DirectoryReference { scope: Some(scope) })),
        Err(fault) if windows::missing(&fault) => Ok(None),
        Err(fault) => Err(native_error(fault)),
    } }
    #[cfg(not(windows))]
    { let _ = private; Err(native_error(Fault::new("unsupported_platform", "directory"))) }
}

/// Trusted host-only prototype. This is not an agent tool or a runtime scope grant.
#[napi]
pub fn publish_setup_file(
    parent: String,
    directory_leaf: String,
    target_leaf: String,
    bytes: Buffer,
    durability: String,
) -> SetupPublication {
    let mut result = SetupPublication::empty();
    // Policy rejection precedes even path resolution or directory creation.
    if let Err(fault) = request::policy(&durability) {
        result.fail(fault);
        return result;
    }
    let request = match request::Request::new(&parent, &directory_leaf, &target_leaf, bytes.len()) {
        Ok(value) => value,
        Err(fault) => {
            result.fail(fault);
            return result;
        }
    };
    #[cfg(windows)]
    {
        return windows::publish(&request, &bytes.to_vec());
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        result.fail(Fault::new("unsupported_platform", "preflight"));
        result
    }
}

#[napi]
pub fn inspect_setup_file(
    parent: String,
    directory_leaf: String,
    target_leaf: String,
) -> SetupInspection {
    let request = match request::Request::new(&parent, &directory_leaf, &target_leaf, 0) {
        Ok(value) => value,
        Err(fault) => return SetupInspection::failed(fault),
    };
    #[cfg(windows)]
    {
        windows::inspect(&request)
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        SetupInspection::failed(Fault::new("unsupported_platform", "preflight"))
    }
}
