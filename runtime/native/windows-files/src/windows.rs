//! Real Win32 implementation; source compilation elsewhere is not Windows validation.

use crate::{Fault, MAX_BYTES, SetupInspection, SetupPublication, request::Request};
use std::{
    ffi::c_void,
    mem::{offset_of, size_of},
    ptr::{null, null_mut},
    rc::Rc,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{
        SystemServices::{ACCESS_ALLOWED_ACE_TYPE, FILE_PERSISTENT_ACLS},
        Threading::*,
        WindowsProgramming::DRIVE_FIXED,
    },
};

type Result<T> = std::result::Result<T, Fault>;
mod streams;
pub(crate) use streams::{ReadStream, WriteCandidate};
mod database;
pub(crate) use database::DatabaseGuard;
mod mutations;
pub(crate) use mutations::FileLock;
mod admin;

fn last(phase: &'static str) -> Fault {
    // GetLastError must be captured before cleanup calls can replace it.
    Fault {
        code: "win32_io",
        phase,
        win32: Some(unsafe { GetLastError() }),
    }
}
fn unsafe_object(phase: &'static str) -> Fault {
    Fault::new("unsafe_object", phase)
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}
fn child(parent: &str, leaf: &str) -> String {
    format!("{}\\{}", parent.trim_end_matches('\\'), leaf)
}
pub(crate) fn missing(f: &Fault) -> bool {
    matches!(f.win32, Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND))
}

struct Handle(HANDLE, bool);
impl Handle {
    fn from_file(raw: HANDLE, phase: &'static str) -> Result<Self> {
        if raw == INVALID_HANDLE_VALUE {
            Err(last(phase))
        } else {
            let file = phase == "open_file" || phase == "create_candidate";
            if file { crate::metrics(|value| value.file_opens += 1.0); }
            Ok(Self(raw, file))
        }
    }
    fn close(mut self) -> Result<()> {
        // A failed close is not safe to retry on a raw handle value that might be
        // invalid or reused. Transfer ownership out before the single attempt.
        let raw = std::mem::replace(&mut self.0, null_mut());
        if self.1 { crate::metrics(|value| value.file_closes += 1.0); }
        if unsafe { CloseHandle(raw) } == 0 {
            return Err(last("close"));
        }
        Ok(())
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            if self.1 { crate::metrics(|value| value.file_closes += 1.0); }
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
struct LocalMemory(*mut c_void);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Snapshot {
    id: String,
    bytes: u64,
    write_time: u64,
    change_time: i64,
    attributes: u32,
    links: u32,
}
fn snapshot(handle: &Handle, directory: bool, phase: &'static str) -> Result<Snapshot> {
    if !directory { crate::metrics(|value| value.file_stats += 1.0); }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileType(handle.0) } != FILE_TYPE_DISK {
        return Err(unsafe_object(phase));
    }
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(last(phase));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(unsafe_object(phase));
    }
    let mut basic = FILE_BASIC_INFO::default();
    if unsafe { GetFileInformationByHandleEx(handle.0, FileBasicInfo, (&mut basic as *mut FILE_BASIC_INFO).cast(), size_of::<FILE_BASIC_INFO>() as u32) } == 0 {
        return Err(last(phase));
    }
    Ok(Snapshot {
        change_time: basic.ChangeTime,
        id: format!(
            "{:08x}:{:08x}{:08x}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ),
        bytes: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
        write_time: (u64::from(info.ftLastWriteTime.dwHighDateTime) << 32)
            | u64::from(info.ftLastWriteTime.dwLowDateTime),
        attributes: info.dwFileAttributes,
        links: info.nNumberOfLinks,
    })
}

fn final_path(handle: &Handle) -> Result<String> {
    let mut buffer = vec![0u16; 8192];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            handle.0,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            VOLUME_NAME_GUID,
        )
    };
    if count == 0 {
        return Err(last("resolve_handle"));
    }
    if count as usize >= buffer.len() {
        return Err(Fault::new("path_too_long", "resolve_handle"));
    }
    String::from_utf16(&buffer[..count as usize]).map_err(|_| unsafe_object("resolve_handle"))
}

struct Security {
    sid: Vec<u32>,
    descriptor: LocalMemory,
}
impl Security {
    fn current() -> Result<Self> {
        let mut raw = null_mut();
        // Respect impersonation; do not substitute the process user for a valid thread token.
        if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } == 0 {
            let fault = last("token");
            if fault.win32 != Some(ERROR_NO_TOKEN) {
                return Err(fault);
            }
            if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
                return Err(last("token"));
            }
        }
        let token = Handle(raw, false);
        let mut needed = 0u32;
        unsafe {
            GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed);
        }
        if needed == 0 || needed > 65536 {
            return Err(unsafe_object("token"));
        }
        // usize storage keeps TOKEN_USER and its embedded SID suitably aligned.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(last("token"));
        }
        let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        if unsafe { IsValidSid(user.User.Sid) } == 0 {
            return Err(unsafe_object("token"));
        }
        let length = unsafe { GetLengthSid(user.User.Sid) };
        if length == 0 || length > 256 {
            return Err(unsafe_object("token"));
        }
        let mut sid = vec![0u32; (length as usize).div_ceil(size_of::<u32>())];
        if unsafe { CopySid(length, sid.as_mut_ptr().cast(), user.User.Sid) } == 0 {
            return Err(last("token"));
        }
        let mut sid_string = null_mut();
        if unsafe { ConvertSidToStringSidW(sid.as_mut_ptr().cast(), &mut sid_string) } == 0 {
            return Err(last("token"));
        }
        let sid_text_memory = LocalMemory(sid_string.cast());
        let mut count = 0;
        while count < 256 && unsafe { *sid_string.add(count) } != 0 {
            count += 1;
        }
        if count == 256 {
            return Err(unsafe_object("token"));
        }
        let text = String::from_utf16(unsafe { std::slice::from_raw_parts(sid_string, count) })
            .map_err(|_| unsafe_object("token"))?;
        drop(sid_text_memory);
        // One effective SID only. Children inherit the same private access, including SQLite sidecars.
        let sddl = wide(&format!("O:{text}D:P(A;OICI;FA;;;{text})"));
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(last("private_descriptor"));
        }
        Ok(Self {
            sid,
            descriptor: LocalMemory(descriptor),
        })
    }
    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        }
    }
    fn check(&self, handle: &Handle) -> Result<()> {
        let mut owner = null_mut();
        let mut acl = null_mut();
        let mut descriptor = null_mut();
        let code = unsafe {
            GetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor,
            )
        };
        if code != ERROR_SUCCESS {
            return Err(Fault {
                code: "win32_io",
                phase: "acl",
                win32: Some(code),
            });
        }
        let allocation = LocalMemory(descriptor);
        if descriptor.is_null()
            || owner.is_null()
            || acl.is_null()
            || unsafe { IsValidSecurityDescriptor(descriptor) } == 0
            || unsafe { IsValidSid(owner) } == 0
            || unsafe { EqualSid(owner, self.sid.as_ptr().cast_mut().cast()) } == 0
            || unsafe { IsValidAcl(acl) } == 0
        {
            return Err(unsafe_object("acl"));
        }
        let mut control = 0u16;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 {
            return Err(last("acl"));
        }
        if unsafe { (*acl).AceCount } != 1 {
            return Err(unsafe_object("acl"));
        }
        let mut ace = null_mut();
        if unsafe { GetAce(acl, 0, &mut ace) } == 0 {
            return Err(last("acl"));
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        let sid_offset = offset_of!(ACCESS_ALLOWED_ACE, SidStart);
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
            || header.AceFlags & !((OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | INHERITED_ACE) as u8) != 0
            || usize::from(header.AceSize) < sid_offset + 8
        {
            return Err(unsafe_object("acl"));
        }
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        if allowed.Mask != FILE_ALL_ACCESS {
            return Err(unsafe_object("acl"));
        }
        let ace_sid = std::ptr::addr_of!(allowed.SidStart).cast_mut().cast();
        // Bound the SID's variable sub-authority tail before passing it to Win32.
        let sid_bytes = 8 + usize::from(unsafe { *ace.cast::<u8>().add(sid_offset + 1) }) * 4;
        if sid_offset + sid_bytes > usize::from(header.AceSize)
            || unsafe { IsValidSid(ace_sid) } == 0
            || unsafe { EqualSid(ace_sid, self.sid.as_ptr().cast_mut().cast()) } == 0
        {
            return Err(unsafe_object("acl"));
        }
        drop(allocation);
        Ok(())
    }
}

struct Directory {
    handle: Handle,
    id: String,
    path: String,
}
impl Directory {
    fn open(path: &str) -> Result<Self> {
        crate::metrics(|value| value.directory_checks += 1.0);
        // Deny both delete and write sharing while a path component is used. This can
        // reject busy directories; actual Windows sharing behavior remains a test gate.
        let handle = Handle::from_file(
            unsafe {
                CreateFileW(
                    wide(path).as_ptr(),
                    FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | READ_CONTROL,
                    FILE_SHARE_READ,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    null_mut(),
                )
            },
            "open_directory",
        )?;
        let info = snapshot(&handle, true, "directory")?;
        let path = final_path(&handle)?;
        Ok(Self {
            handle,
            id: info.id,
            path,
        })
    }
    fn check(&self) -> Result<()> {
        crate::metrics(|value| value.directory_checks += 1.0);
        let current = snapshot(&self.handle, true, "directory_recheck")?;
        if current.id != self.id || final_path(&self.handle)? != self.path {
            return Err(Fault::new("directory_changed", "directory_recheck"));
        }
        Ok(())
    }
}
pub(crate) struct Scope {
    ancestors: Vec<Rc<Directory>>,
    directory: Rc<Directory>,
    security: Security,
    private: bool,
    created: bool,
}
impl Scope {
    fn open(request: &Request, create: bool) -> Result<Self> {
        Self::open_access(request, create, true)
    }
    fn open_access(request: &Request, create: bool, private: bool) -> Result<Self> {
        let security = Security::current()?;
        if unsafe { GetDriveTypeW(wide(&request.drive).as_ptr()) } != DRIVE_FIXED {
            return Err(Fault::new("local_ntfs_required", "volume"));
        }
        let root = Directory::open(&request.drive)?;
        // Resolve the drive once into a volume GUID before mutations. Do not reuse a
        // replaceable DOS drive mapping. SUBST roots with extra components are refused.
        if !root.path.starts_with("\\\\?\\Volume{") || !root.path.ends_with("}\\") {
            return Err(Fault::new("volume_root_required", "volume"));
        }
        let mut filesystem = [0u16; 32];
        let mut flags = 0;
        if unsafe {
            GetVolumeInformationByHandleW(
                root.handle.0,
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                &mut flags,
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        } == 0
        {
            return Err(last("volume"));
        }
        let end = filesystem
            .iter()
            .position(|v| *v == 0)
            .unwrap_or(filesystem.len());
        if String::from_utf16_lossy(&filesystem[..end]) != "NTFS"
            || flags & FILE_PERSISTENT_ACLS == 0
        {
            return Err(Fault::new("local_ntfs_required", "volume"));
        }
        let mut ancestors = vec![Rc::new(root)];
        for name in &request.parents {
            let parent = ancestors.last().expect("drive root exists");
            parent.check()?;
            let next = Directory::open(&child(&parent.path, name))?;
            ancestors.push(Rc::new(next));
        }
        let parent = ancestors.last().expect("drive root exists");
        parent.check()?;
        let mut created = false;
        let directory = if request.directory.is_empty() {
            ancestors.pop().expect("drive root exists")
        } else {
            let path = child(&parent.path, &request.directory);
            if create {
                if unsafe { CreateDirectoryW(wide(&path).as_ptr(), &security.attributes()) } == 0 {
                    let fault = last("create_directory");
                    if fault.win32 != Some(ERROR_ALREADY_EXISTS) { return Err(fault); }
                } else { created = true; }
            }
            Rc::new(Directory::open(&path)?)
        };
        if private { security.check(&directory.handle)?; }
        let scope = Self { ancestors, directory, security, private, created };
        scope.check()?;
        Ok(scope)
    }
    pub(crate) fn check(&self) -> Result<()> {
        if Security::current()?.sid != self.security.sid { return Err(unsafe_object("token_changed")); }
        for parent in &self.ancestors {
            parent.check()?;
        }
        self.directory.check()?;
        if self.private { self.security.check(&self.directory.handle)?; }
        Ok(())
    }
    fn read(&self, target: &str) -> Result<(Vec<u8>, String)> {
        self.read_bounded(target, MAX_BYTES)
    }
    pub(crate) fn read_bounded(&self, target: &str, maximum: usize) -> Result<(Vec<u8>, String)> {
        crate::request::leaf(target)?;
        self.check()?;
        let handle = Handle::from_file(
            unsafe {
                CreateFileW(
                    wide(&child(&self.directory.path, target)).as_ptr(),
                    GENERIC_READ | READ_CONTROL,
                    FILE_SHARE_READ,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT,
                    null_mut(),
                )
            },
            "open_file",
        )?;
        let before = snapshot(&handle, false, "read_metadata")?;
        self.security.check(&handle)?;
        if before.bytes > maximum.min(MAX_BYTES) as u64 {
            return Err(Fault::new("file_too_large", "read"));
        }
        let mut data = vec![0u8; before.bytes as usize + 1];
        let mut total = 0;
        loop {
            let mut read = 0;
            crate::metrics(|value| value.data_reads += 1.0);
            if unsafe {
                ReadFile(
                    handle.0,
                    data[total..].as_mut_ptr(),
                    (data.len() - total) as u32,
                    &mut read,
                    null_mut(),
                )
            } == 0
            {
                return Err(last("read"));
            }
            crate::metrics(|value| value.data_bytes += f64::from(read));
            total += read as usize;
            if total > before.bytes as usize {
                return Err(Fault::new("file_changed", "read"));
            }
            if read == 0 {
                break;
            }
        }
        if total != before.bytes as usize || snapshot(&handle, false, "read_recheck")? != before {
            return Err(Fault::new("file_changed", "read_recheck"));
        }
        self.security.check(&handle)?;
        self.check()?;
        handle.close()?;
        data.truncate(total);
        Ok((data, before.id))
    }
}

fn rename_new(candidate: &Handle, parent: &Handle, target: &str) -> Result<()> {
    let name: Vec<u16> = target.encode_utf16().collect();
    let length = offset_of!(FILE_RENAME_INFO, FileName) + (name.len() + 1) * size_of::<u16>();
    // Aligned backing storage for the SDK's variable-length FILE_RENAME_INFO.
    let mut buffer = vec![0usize; length.div_ceil(size_of::<usize>())];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = parent.0;
        (*info).FileNameLength = (name.len() * size_of::<u16>()) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            name.len(),
        );
        if SetFileInformationByHandle(candidate.0, FileRenameInfo, info.cast(), length as u32) == 0
        {
            return Err(last("publish"));
        }
    }
    Ok(())
}

fn cleanup_candidate(handle: Handle, outcome: &mut SetupPublication) {
    // Only called before a rename attempt or after a definite name conflict. Never
    // set delete disposition on a successfully renamed or ambiguous file handle.
    let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    let deleted = unsafe {
        SetFileInformationByHandle(
            handle.0,
            FileDispositionInfo,
            (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if deleted == 0 {
        let fault = last("cleanup");
        outcome.cleanup = "failed".into();
        outcome.cleanup_win32_error = fault.win32;
    } else {
        outcome.cleanup = "delete_on_close".into();
    }
    if let Err(fault) = handle.close() {
        outcome.cleanup = "failed".into();
        outcome.close_win32_error = fault.win32;
    } else if deleted != 0 {
        outcome.cleanup = "removed".into();
    }
}

pub(crate) fn publish(request: &Request, bytes: &[u8]) -> SetupPublication {
    let mut outcome = SetupPublication::empty();
    let scope = match Scope::open(request, true) {
        Ok(value) => value,
        Err(fault) => {
            outcome.fail(fault);
            return outcome;
        }
    };
    publish_held(&scope, &request.target, bytes)
}

pub(crate) fn publish_held(scope: &Scope, target: &str, bytes: &[u8]) -> SetupPublication {
    let mut outcome = SetupPublication::empty();
    if !scope.private { outcome.fail(unsafe_object("publish_directory")); return outcome; }
    if let Err(fault) = crate::request::Request::new("C:\\", "_metadata", target, bytes.len()) {
        outcome.fail(fault); return outcome;
    }
    let name = format!(".secumon-init-{}.pending", uuid::Uuid::new_v4());
    let path = child(&scope.directory.path, &name);
    if let Err(fault) = scope.check() {
        outcome.fail(fault);
        return outcome;
    }
    let candidate = match Handle::from_file(
        unsafe {
            CreateFileW(
                wide(&path).as_ptr(),
                GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL,
                0,
                &scope.security.attributes(),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        },
        "create_candidate",
    ) {
        Ok(value) => value,
        Err(fault) => {
            outcome.fail(fault);
            return outcome;
        }
    };
    outcome.candidate_name = Some(name);
    outcome.publication = "not_published".into();
    let prepare = (|| -> Result<()> {
        snapshot(&candidate, false, "candidate")?;
        scope.security.check(&candidate)?;
        let mut offset = 0;
        while offset < bytes.len() {
            let mut written = 0;
            if unsafe {
                WriteFile(
                    candidate.0,
                    bytes[offset..].as_ptr(),
                    (bytes.len() - offset) as u32,
                    &mut written,
                    null_mut(),
                )
            } == 0
            {
                return Err(last("write"));
            }
            if written == 0 {
                return Err(Fault::new("zero_byte_write", "write"));
            }
            offset += written as usize;
        }
        outcome.file_flush = "attempted".into();
        if unsafe { FlushFileBuffers(candidate.0) } == 0 {
            return Err(last("file_flush"));
        }
        outcome.file_flush = "completed".into();
        let info = snapshot(&candidate, false, "candidate_recheck")?;
        if info.bytes != bytes.len() as u64 {
            return Err(Fault::new("file_changed", "candidate_recheck"));
        }
        outcome.file_identity = Some(info.id);
        scope.security.check(&candidate)?;
        scope.check()
    })();
    if let Err(fault) = prepare {
        outcome.fail(fault);
        cleanup_candidate(candidate, &mut outcome);
        return outcome;
    }
    match rename_new(&candidate, &scope.directory.handle, target) {
        Ok(()) => {
            outcome.publication = "created".into();
            outcome.cleanup = "consumed_by_rename".into();
            let verified = scope
                .check()
                .and_then(|_| scope.security.check(&candidate))
                .and_then(|_| snapshot(&candidate, false, "published_recheck"));
            if let Err(fault) = verified {
                outcome.fail(fault);
                if let Err(close) = candidate.close() {
                    outcome.close_win32_error = close.win32;
                }
                return outcome;
            }
            if let Err(fault) = candidate.close() {
                outcome.close_win32_error = fault.win32;
                outcome.fail(fault);
                return outcome;
            }
            // Reopen with the retained parent chain. Verify bytes and identity, not merely name existence.
            match scope.read(target) {
                Ok((stored, id))
                    if stored == bytes && Some(&id) == outcome.file_identity.as_ref() =>
                {
                    outcome.ok = true;
                    outcome.phase = "complete_process_crash_policy".into();
                }
                Ok(_) => outcome.fail(Fault::new("published_file_changed", "reconcile")),
                Err(fault) => outcome.fail(fault),
            }
        }
        Err(fault) if matches!(fault.win32, Some(ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS)) => {
            outcome.publication = "already_exists".into();
            cleanup_candidate(candidate, &mut outcome);
            match scope.read(target) {
                Ok((_, id)) if outcome.cleanup == "removed" => {
                    outcome.ok = true;
                    outcome.file_identity = Some(id);
                    outcome.phase = "existing_target_validated".into();
                }
                Ok(_) => outcome.fail(Fault {
                    code: "cleanup_failed",
                    phase: "cleanup",
                    win32: outcome.cleanup_win32_error.or(outcome.close_win32_error),
                }),
                Err(fault) => outcome.fail(fault),
            }
        }
        Err(fault) => {
            outcome.publication = "unknown".into();
            outcome.cleanup = "retained_ambiguous".into();
            outcome.fail(fault);
            // The caller must inspect the final name; the handle might now name the final file.
            // Closing without a delete disposition is safe in both possibilities.
            if let Err(close) = candidate.close() {
                outcome.close_win32_error = close.win32;
            }
        }
    }
    outcome
}

pub(crate) fn inspect(request: &Request) -> SetupInspection {
    let result = Scope::open(request, false).and_then(|scope| scope.read(&request.target));
    match result {
        Ok((bytes, identity)) => SetupInspection {
            ok: true,
            exists: true,
            code: None,
            phase: "inspected".into(),
            win32_error: None,
            bytes: Some(bytes.into()),
            file_identity: Some(identity),
        },
        Err(fault) if missing(&fault) => SetupInspection {
            ok: true,
            exists: false,
            code: None,
            phase: "missing".into(),
            win32_error: fault.win32,
            bytes: None,
            file_identity: None,
        },
        Err(fault) => SetupInspection::failed(fault),
    }
}

impl Scope {
    pub(crate) fn open_directory(path: &str, private: bool) -> Result<Self> {
        Self::open_access(&Request::directory_path(path)?, false, private)
    }
    pub(crate) fn info(&self) -> Result<crate::DirectoryInfo> {
        self.check()?;
        Ok(crate::DirectoryInfo { identity: self.directory.id.clone(), path: self.directory.path.clone(), private: self.private, created: self.created, change_token: self.directory_token()? })
    }
    fn directory_token(&self) -> Result<String> {
        let s = snapshot(&self.directory.handle, true, "directory_token")?;
        Ok(format!("{}:{}:{}:{}:{}", s.id, s.write_time, s.change_time, s.attributes, s.links))
    }
    pub(crate) fn inspect_child(&self, name: &str, private: bool) -> Result<crate::PathInfo> {
        crate::request::leaf(name)?; self.check()?;
        let handle = Handle::from_file(unsafe { CreateFileW(wide(&child(&self.directory.path, name)).as_ptr(),
            FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ, null(), OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }, "inspect_child")?;
        let mut attributes = FILE_ATTRIBUTE_TAG_INFO::default();
        if unsafe { GetFileInformationByHandleEx(handle.0, FileAttributeTagInfo, (&mut attributes as *mut FILE_ATTRIBUTE_TAG_INFO).cast(), size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32) } == 0 { return Err(last("inspect_child")); }
        let directory = attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        let before = snapshot(&handle, directory, "inspect_child")?;
        if private { self.security.check(&handle)?; }
        self.check()?;
        if snapshot(&handle, directory, "inspect_child_recheck")? != before { return Err(Fault::new("file_changed", "inspect_child")); }
        let info = crate::PathInfo { identity: before.id.clone(), kind: if directory { "directory" } else { "regular" }.into(),
            bytes: before.bytes.to_string(), change_token: format!("{}:{}:{}:{}:{}:{}", before.id, before.bytes, before.write_time, before.change_time, before.attributes, before.links) };
        handle.close()?; Ok(info)
    }
    pub(crate) fn names(&self, maximum: usize) -> Result<Vec<String>> {
        if maximum > 65536 { return Err(Fault::new("invalid_request", "directory_list")); }
        self.check()?; let before = self.directory_token()?;
        let mut result = Vec::new(); let mut first = true;
        // Query the retained directory itself, never reopen a validated path in Node.
        let mut buffer = vec![0usize; 65536 / size_of::<usize>()];
        let capacity = buffer.len() * size_of::<usize>();
        loop {
            buffer.fill(0);
            crate::metrics(|value| value.sibling_lists += 1.0);
            let class = if first { FileIdBothDirectoryRestartInfo } else { FileIdBothDirectoryInfo }; first = false;
            if unsafe { GetFileInformationByHandleEx(self.directory.handle.0, class, buffer.as_mut_ptr().cast(), capacity as u32) } == 0 {
                let fault = last("directory_list"); if fault.win32 == Some(ERROR_NO_MORE_FILES) { break; } return Err(fault);
            }
            let mut offset = 0usize;
            loop {
                let base = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
                if offset + size_of::<FILE_ID_BOTH_DIR_INFO>() > capacity { return Err(unsafe_object("directory_list")); }
                let item = unsafe { &*buffer.as_ptr().cast::<u8>().add(offset).cast::<FILE_ID_BOTH_DIR_INFO>() };
                let length = item.FileNameLength as usize;
                if length == 0 || length % 2 != 0 || length > 510 || offset + base + length > capacity { return Err(unsafe_object("directory_list")); }
                let name = String::from_utf16(unsafe { std::slice::from_raw_parts(std::ptr::addr_of!(item.FileName).cast::<u16>(), length / 2) }).map_err(|_| unsafe_object("directory_list"))?;
                if name != "." && name != ".." {
                    crate::request::leaf(&name)?;
                    if result.len() >= maximum { return Err(Fault::new("directory_too_large", "directory_list")); }
                    crate::metrics(|value| value.sibling_entries += 1.0); result.push(name);
                }
                let next = item.NextEntryOffset as usize;
                if next == 0 { break; }
                if next < base + length || next % std::mem::align_of::<FILE_ID_BOTH_DIR_INFO>() != 0 || next > capacity - offset { return Err(unsafe_object("directory_list")); }
                offset += next;
            }
        }
        self.check()?;
        if self.directory_token()? != before { return Err(Fault::new("directory_changed", "directory_list")); }
        result.sort();
        if result.windows(2).any(|pair| pair[0] == pair[1]) { return Err(Fault::new("directory_changed", "directory_list")); }
        Ok(result)
    }
    pub(crate) fn child_directory(&self, name: &str, create: bool, exclusive: bool) -> Result<Self> {
        crate::request::leaf(name)?;
        if exclusive && !create { return Err(Fault::new("invalid_request", "directory")); }
        self.check()?;
        let path = child(&self.directory.path, name);
        let security = Security::current()?;
        let mut created = false;
        if create {
            if unsafe { CreateDirectoryW(wide(&path).as_ptr(), &security.attributes()) } == 0 {
                let fault = last("create_directory");
                if exclusive || fault.win32 != Some(ERROR_ALREADY_EXISTS) { return Err(fault); }
            } else { created = true; }
        }
        let directory = Rc::new(Directory::open(&path)?);
        security.check(&directory.handle)?;
        let mut ancestors = self.ancestors.clone(); ancestors.push(Rc::clone(&self.directory));
        let next = Self { ancestors, directory, security, private: true, created };
        next.check()?; Ok(next)
    }
    pub(crate) fn close(self) -> Vec<String> {
        let mut errors = Vec::new();
        let mut owned = self.ancestors; owned.push(self.directory);
        for directory in owned.into_iter().rev() {
            if let Ok(directory) = Rc::try_unwrap(directory) {
                if let Err(fault) = directory.handle.close() {
                    errors.push(format!("{}:{}:{}", fault.code, fault.phase, fault.win32.unwrap_or(0)));
                }
            }
        }
        errors
    }
}
