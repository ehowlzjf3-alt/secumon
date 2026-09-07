use super::*;

pub(crate) struct FileLock { handle: Handle, scope: Scope }
impl FileLock {
    pub(crate) fn check(&self) -> Result<()> {
        self.scope.check()?;
        snapshot(&self.handle, false, "lock_check")?;
        self.scope.security.check(&self.handle)
    }
    pub(crate) fn close(self) -> Result<()> {
        self.check()?;
        let Self { handle, scope } = self;
        let outcome = handle.close();
        let errors = scope.close();
        outcome?;
        if !errors.is_empty() { return Err(Fault::new("lock_close_failed", "close")); }
        Ok(())
    }
}
impl Scope {
    pub(crate) fn lock_regular(&self, target: &str) -> Result<FileLock> {
        crate::request::leaf(target)?; self.check()?;
        if !self.private { return Err(unsafe_object("lock_directory")); }
        let security = Security::current()?;
        let handle = Handle::from_file(unsafe { CreateFileW(wide(&child(&self.directory.path, target)).as_ptr(),
            GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL, 0, &security.attributes(), CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_DELETE_ON_CLOSE, null_mut()) }, "open_file")?;
        snapshot(&handle, false, "lock_created")?; security.check(&handle)?;
        let scope = Scope { ancestors: self.ancestors.clone(), directory: Rc::clone(&self.directory), security,
            private: true, created: false };
        let lock = FileLock { handle, scope }; lock.check()?; Ok(lock)
    }
    fn exact_regular(&self, target: &str, expected: &[u8]) -> Result<Option<Handle>> {
        crate::request::leaf(target)?; self.check()?;
        if !self.private || expected.len() > 1024 * 1024 * 1024 { return Err(unsafe_object("remove_request")); }
        let handle = match Handle::from_file(unsafe { CreateFileW(wide(&child(&self.directory.path, target)).as_ptr(),
            GENERIC_READ | DELETE | READ_CONTROL, 0, null(), OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) }, "open_file") {
            Ok(handle) => handle, Err(fault) if missing(&fault) => return Ok(None), Err(fault) => return Err(fault),
        };
        let before = snapshot(&handle, false, "remove_metadata")?; self.security.check(&handle)?;
        if before.bytes != expected.len() as u64 { return Err(Fault::new("file_changed", "remove")); }
        let mut buffer = vec![0u8; 1024 * 1024]; let mut offset = 0;
        while offset < expected.len() {
            let wanted = buffer.len().min(expected.len() - offset); let mut count = 0;
            if unsafe { ReadFile(handle.0, buffer.as_mut_ptr(), wanted as u32, &mut count, null_mut()) } == 0 { return Err(last("remove_read")); }
            if count == 0 || buffer[..count as usize] != expected[offset..offset + count as usize] { return Err(Fault::new("file_changed", "remove")); }
            offset += count as usize;
        }
        if snapshot(&handle, false, "remove_recheck")? != before { return Err(Fault::new("file_changed", "remove")); }
        self.security.check(&handle)?; self.check()?;
        Ok(Some(handle))
    }
    pub(crate) fn move_regular(&self, source: &str, target: &str, expected: &[u8]) -> Result<bool> {
        crate::request::leaf(source)?; crate::request::leaf(target)?;
        if source.eq_ignore_ascii_case(target) { return Err(Fault::new("invalid_request", "move")); }
        let Some(handle) = self.exact_regular(source, expected)? else { return Ok(false); };
        // No replacement: preserve the old format under an operation-specific name before publishing its successor.
        rename_new(&handle, &self.directory.handle, target)?;
        handle.close()?; self.check()?; Ok(true)
    }
    pub(crate) fn remove_regular(&self, target: &str, expected: &[u8]) -> Result<bool> {
        let Some(handle) = self.exact_regular(target, expected)? else { return Ok(false); };
        let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe { SetFileInformationByHandle(handle.0, FileDispositionInfo, (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(), size_of::<FILE_DISPOSITION_INFO>() as u32) } == 0 {
            return Err(last("remove"));
        }
        handle.close()?; self.check()?; Ok(true)
    }
}
