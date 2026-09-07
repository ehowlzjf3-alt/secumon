//! A SQLite filename is usable only while its original main object and directory remain held.
use super::*;

pub(crate) struct DatabaseGuard {
    scope: Scope,
    main: Handle,
    identity: String,
    path: String,
    leaf: String,
    require_inheritance: bool,
}

fn inheritable(handle: &Handle) -> Result<bool> {
    let mut descriptor = null_mut(); let mut dacl = null_mut();
    let code = unsafe { GetSecurityInfo(handle.0, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        null_mut(), null_mut(), &mut dacl, null_mut(), &mut descriptor) };
    if code != ERROR_SUCCESS { return Err(Fault { code: "win32_io", phase: "database_acl", win32: Some(code) }); }
    let _allocation = LocalMemory(descriptor);
    if dacl.is_null() { return Err(unsafe_object("database_acl")); }
    let mut ace = null_mut();
    if unsafe { GetAce(dacl, 0, &mut ace) } == 0 { return Err(last("database_acl")); }
    if ace.is_null() { return Err(unsafe_object("database_acl")); }
    let flags = unsafe { (*ace.cast::<ACE_HEADER>()).AceFlags };
    Ok(flags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8 == (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8)
}

impl Scope {
    fn database_inheritance(&self) -> Result<()> {
        self.check()?;
        if !self.private { return Err(unsafe_object("database_directory")); }
        self.security.check(&self.directory.handle)?;
        if inheritable(&self.directory.handle)? { return Ok(()); }
        // SetSecurityInfo can propagate ACEs. Never use this to repair a non-private tree.
        for name in self.names(65536)? { inspect_private_child(self, &name)?; }
        let writer = Handle::from_file(unsafe { CreateFileW(wide(&self.directory.path).as_ptr(),
            WRITE_DAC | READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }, "database_acl")?;
        if snapshot(&writer, true, "database_acl")?.id != self.directory.id { return Err(Fault::new("directory_changed", "database_acl")); }
        self.security.check(&writer)?;
        let mut present = 0; let mut defaulted = 0; let mut dacl = null_mut();
        if unsafe { GetSecurityDescriptorDacl(self.security.descriptor.0, &mut present, &mut dacl, &mut defaulted) } == 0 { return Err(last("database_acl")); }
        if present == 0 || dacl.is_null() { return Err(unsafe_object("database_acl")); }
        let code = unsafe { SetSecurityInfo(writer.0, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(), null_mut(), dacl, null()) };
        if code != ERROR_SUCCESS { return Err(Fault { code: "win32_io", phase: "database_acl", win32: Some(code) }); }
        self.security.check(&writer)?;
        if !inheritable(&writer)? { return Err(unsafe_object("database_acl")); }
        self.check()?; writer.close()
    }
    pub(crate) fn database(&self, leaf: &str, create: bool) -> Result<Option<DatabaseGuard>> {
        crate::request::leaf(leaf)?;
        for suffix in ["-wal", "-shm", "-journal"] { crate::request::leaf(&format!("{leaf}{suffix}"))?; }
        self.check()?;
        if !self.private { return Err(unsafe_object("database_directory")); }
        // Main/sidecar inspection permits SQLite's legitimate RW handles, but never follows reparse points.
        let path = child(&self.directory.path, leaf);
        let lookup = || match open_main(&path) { Ok(handle) => Ok(Some(handle)), Err(fault) if missing(&fault) => Ok(None), Err(fault) => Err(fault) };
        let mut existing = lookup()?;
        let mut sidecars = false;
        for suffix in ["-wal", "-shm", "-journal"] { sidecars |= inspect_sidecar(self, &format!("{leaf}{suffix}"))?; }
        if existing.is_none() { existing = lookup()?; }
        if existing.is_none() && sidecars { return Err(Fault::new("database_owner_missing", "database_main")); }
        if existing.is_none() && !create { return Ok(None); }
        if create { self.database_inheritance()?; }
        let main = if let Some(handle) = existing { handle } else {
            let raw = unsafe { CreateFileW(wide(&path).as_ptr(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE, &self.security.attributes(), CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
            if raw == INVALID_HANDLE_VALUE {
                let fault = last("database_create");
                if !matches!(fault.win32, Some(ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS)) { return Err(fault); }
                open_main(&path)?
            } else {
                let handle = Handle::from_file(raw, "create_candidate")?;
                self.security.check(&handle)?; snapshot(&handle, false, "database_create")?;
                if unsafe { FlushFileBuffers(handle.0) } == 0 { return Err(last("database_flush")); }
                handle
            }
        };
        self.security.check(&main)?;
        let identity = snapshot(&main, false, "database_main")?.id;
        let path = final_path(&main)?;
        let actual_leaf = path.rsplit('\\').next().ok_or_else(|| unsafe_object("database_path"))?.to_string();
        crate::request::leaf(&actual_leaf)?;
        let scope = Scope { ancestors: self.ancestors.clone(), directory: Rc::clone(&self.directory), security: Security::current()?, private: true, created: false };
        let guard = DatabaseGuard { scope, main, identity, path, leaf: actual_leaf, require_inheritance: create };
        guard.check()?; Ok(Some(guard))
    }
}
fn open_main(path: &str) -> Result<Handle> {
    Handle::from_file(unsafe { CreateFileW(wide(path).as_ptr(), FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE, null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }, "open_file")
}
fn inspect_private_child(scope: &Scope, name: &str) -> Result<()> {
    let handle = Handle::from_file(unsafe { CreateFileW(wide(&child(&scope.directory.path, name)).as_ptr(),
        FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }, "inspect_child")?;
    let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe { GetFileInformationByHandleEx(handle.0, FileAttributeTagInfo, (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(), size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32) } == 0 { return Err(last("database_acl")); }
    snapshot(&handle, tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0, "database_acl")?;
    scope.security.check(&handle)?; handle.close()
}
fn inspect_sidecar(scope: &Scope, name: &str) -> Result<bool> {
    let handle = match Handle::from_file(unsafe { CreateFileW(wide(&child(&scope.directory.path, name)).as_ptr(),
        FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }, "open_file") {
        Ok(handle) => handle, Err(fault) if missing(&fault) => return Ok(false), Err(fault) => return Err(fault),
    };
    snapshot(&handle, false, "database_sidecar")?; scope.security.check(&handle)?; handle.close()?; Ok(true)
}
impl DatabaseGuard {
    pub(crate) fn info(&self) -> Result<crate::PathInfo> {
        self.check()?;
        let info = snapshot(&self.main, false, "database_info")?;
        Ok(crate::PathInfo { identity: info.id.clone(), kind: "regular".into(), bytes: info.bytes.to_string(),
            change_token: format!("{}:{}:{}:{}:{}:{}", info.id, info.bytes, info.write_time, info.change_time, info.attributes, info.links) })
    }
    pub(crate) fn path(&self) -> Result<String> { self.check()?; Ok(self.path.clone()) }
    pub(crate) fn check(&self) -> Result<()> {
        self.scope.check()?; self.scope.security.check(&self.main)?;
        if snapshot(&self.main, false, "database_main")?.id != self.identity || final_path(&self.main)? != self.path {
            return Err(Fault::new("file_changed", "database_main"));
        }
        if self.require_inheritance && !inheritable(&self.scope.directory.handle)? { return Err(unsafe_object("database_acl")); }
        for suffix in ["-wal", "-shm", "-journal"] { inspect_sidecar(&self.scope, &format!("{}{suffix}", self.leaf))?; }
        self.scope.check()
    }
    pub(crate) fn close(self) -> Result<()> {
        let main = self.main.close();
        let directory = self.scope.close();
        if let Err(error) = main { return Err(error); }
        if !directory.is_empty() { return Err(Fault::new("database_directory_close_failed", "close")); }
        Ok(())
    }
}
